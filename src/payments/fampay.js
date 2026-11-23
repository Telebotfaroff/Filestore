import { ImapFlow } from 'imapflow';
import QRCode from 'qrcode';
import { encryptBotToken, decryptBotToken } from '../security/token-encryption.js';
import { markPaymentMethodTest } from './repository.js';
import {
  createPaymentSession,
  recordProviderEvent,
  markProviderEvent,
  recordVerifiedPayment,
} from './verification-repository.js';
import { applyVerifiedPayment } from './fulfillment-repository.js';
import { notifyCreatorSale } from '../wallet/notifications.js';
import { formatMoney } from '../utils/validation.js';

const METHOD = 'fampay';
const CURRENCY = 'INR';
const FAMPAY_EXPIRY_MS = 15 * 60 * 1000;
const AMOUNT_ALLOCATION_LOCK_ID = 74290211;
const MAX_EMAIL_AGE_MS = 20 * 60 * 1000;

export function normalizeGmailAddress(email) {
  const clean = String(email ?? '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(clean)) {
    throw new Error('Enter a valid Gmail address (e.g. yourname@gmail.com).');
  }
  return clean;
}

export function normalizeAppPassword(password) {
  const clean = String(password ?? '').replace(/\s+/g, '').trim();
  if (clean.length < 8 || clean.length > 64) {
    throw new Error('Gmail App Password must be 8–64 characters (spaces are removed automatically).');
  }
  return clean;
}

export function normalizeUpiId(upiId) {
  const clean = String(upiId ?? '').trim().toLowerCase();
  if (!/^[a-z0-9._-]{2,64}@[a-z0-9.-]{2,32}$/.test(clean)) {
    throw new Error('Enter a valid UPI ID (e.g. yourname@fam or mobile@fam).');
  }
  return clean;
}

export function normalizeMerchantName(name) {
  const clean = String(name ?? '').trim().replace(/[^\w .&-]/g, '').slice(0, 48).trim();
  return clean || 'FileStore';
}

export function maskEmail(email) {
  if (!email) return 'not set';
  const [user, domain] = String(email).split('@');
  if (!domain) return '***';
  const visible = user.slice(0, Math.min(3, user.length));
  return `${visible}***@${domain}`;
}

function decryptFamPaySecret(ciphertext, tokenEncryptionKey) {
  if (!ciphertext || !tokenEncryptionKey) return null;
  try {
    const raw = decryptBotToken(ciphertext, tokenEncryptionKey);
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && parsed.gmailAppPassword) {
        return String(parsed.gmailAppPassword);
      }
    } catch {}
    return raw ? String(raw) : null;
  } catch {
    return null;
  }
}

export async function loadFamPayConfig(pool, tokenEncryptionKey) {
  const { rows } = await pool.query(
    'SELECT is_enabled, public_config, secret_ciphertext, setup_status, last_test_status, last_test_error FROM payment_methods WHERE method = $1 LIMIT 1',
    [METHOD],
  );
  const row = rows[0] ?? {};
  const pub = row.public_config && typeof row.public_config === 'object' ? row.public_config : {};
  const gmailAppPassword = decryptFamPaySecret(row.secret_ciphertext, tokenEncryptionKey);
  const gmailEmail = pub.gmailEmail ? String(pub.gmailEmail) : null;
  const upiId = pub.upiId ? String(pub.upiId) : null;
  const merchantName = pub.merchantName ? String(pub.merchantName) : 'FileStore';
  return {
    isEnabled: Boolean(row.is_enabled),
    setupStatus: row.setup_status ?? 'not_configured',
    lastTestStatus: row.last_test_status ?? 'unknown',
    lastTestError: row.last_test_error ?? null,
    gmailEmail,
    upiId,
    merchantName,
    hasAppPassword: Boolean(row.secret_ciphertext),
    gmailAppPassword,
    isConfigured: Boolean(gmailEmail && upiId && row.secret_ciphertext),
  };
}

export async function saveFamPayConfig(pool, config, updates, adminId) {
  const current = await loadFamPayConfig(pool, config.tokenEncryptionKey);
  const gmailEmail = updates.gmailEmail !== undefined
    ? normalizeGmailAddress(updates.gmailEmail)
    : current.gmailEmail;
  const upiId = updates.upiId !== undefined
    ? normalizeUpiId(updates.upiId)
    : current.upiId;
  const merchantName = updates.merchantName !== undefined
    ? normalizeMerchantName(updates.merchantName)
    : current.merchantName;
  const gmailAppPassword = updates.gmailAppPassword !== undefined
    ? normalizeAppPassword(updates.gmailAppPassword)
    : current.gmailAppPassword;

  if (updates.gmailAppPassword !== undefined && !config.tokenEncryptionKey) {
    throw new Error('TOKEN_ENCRYPTION_KEY is required to encrypt the Gmail App Password.');
  }

  let ciphertext = null;
  if (gmailAppPassword) {
    ciphertext = encryptBotToken(JSON.stringify({ gmailAppPassword }), config.tokenEncryptionKey);
  } else {
    const existingRow = await pool.query('SELECT secret_ciphertext FROM payment_methods WHERE method = $1', [METHOD]);
    ciphertext = existingRow.rows[0]?.secret_ciphertext ?? null;
  }

  const publicConfig = {
    ...(gmailEmail ? { gmailEmail } : {}),
    ...(upiId ? { upiId } : {}),
    merchantName,
  };
  const isComplete = Boolean(gmailEmail && upiId && ciphertext);
  const setupStatus = isComplete ? 'configured' : 'not_configured';

  await pool.query(
    `UPDATE payment_methods
     SET public_config = $2::jsonb,
         secret_ciphertext = $3,
         setup_status = $4,
         last_test_status = 'unknown',
         last_test_error = NULL,
         updated_by = $5,
         updated_at = NOW()
     WHERE method = $1`,
    [METHOD, JSON.stringify(publicConfig), ciphertext, setupStatus, adminId ?? null],
  );

  return loadFamPayConfig(pool, config.tokenEncryptionKey);
}

export async function enableFamPay(pool, config, adminId) {
  const current = await loadFamPayConfig(pool, config.tokenEncryptionKey);
  if (!current.gmailEmail) throw new Error('Set Gmail address first.');
  if (!current.hasAppPassword || !current.gmailAppPassword) throw new Error('Set Gmail App Password first.');
  if (!current.upiId) throw new Error('Set FamPay UPI ID first.');

  await pool.query(
    `UPDATE payment_methods
     SET is_enabled = TRUE, setup_status = 'configured', updated_by = $2, updated_at = NOW()
     WHERE method = $1`,
    [METHOD, adminId ?? null],
  );
  return loadFamPayConfig(pool, config.tokenEncryptionKey);
}

function createDefaultImapClient(gmailEmail, gmailAppPassword) {
  return new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: {
      user: gmailEmail,
      pass: gmailAppPassword,
    },
    logger: false,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 20_000,
  });
}

function decodeQuotedPrintable(input) {
  const unfolded = String(input ?? '').replace(/=\r?\n/g, '');
  const bytes = [];
  for (let i = 0; i < unfolded.length; i++) {
    if (unfolded[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(unfolded.slice(i + 1, i + 3))) {
      bytes.push(parseInt(unfolded.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      const charBuf = Buffer.from(unfolded[i], 'utf8');
      for (const b of charBuf) bytes.push(b);
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

function stripHtmlTags(html) {
  return String(html ?? '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#8377;|&\#x20b9;/gi, '₹')
    .replace(/\s+/g, ' ')
    .trim();
}

export function decodeMimeText(rawSource) {
  const raw = Buffer.isBuffer(rawSource) ? rawSource.toString('utf8') : String(rawSource ?? '');
  if (!raw) return '';
  const headerSplit = raw.search(/\r?\n\r?\n/);
  if (headerSplit === -1) return raw;

  const headers = raw.slice(0, headerSplit);
  const body = raw.slice(headerSplit).replace(/^\r?\n\r?\n/, '');
  const boundaryMatch = headers.match(/boundary="?([^"\r\n;]+)"?/i);

  if (boundaryMatch) {
    const boundary = boundaryMatch[1];
    const parts = body.split('--' + boundary).slice(1);
    const decodedParts = [];
    for (const part of parts) {
      if (part.startsWith('--')) continue;
      const pSplit = part.search(/\r?\n\r?\n/);
      if (pSplit === -1) continue;
      const pHeaders = part.slice(0, pSplit);
      const pBody = part.slice(pSplit).replace(/^\r?\n\r?\n/, '');
      if (/multipart\//i.test(pHeaders)) {
        decodedParts.push(decodeMimeText(part.trim()));
        continue;
      }
      let decoded = pBody;
      if (/content-transfer-encoding:\s*base64/i.test(pHeaders)) {
        decoded = Buffer.from(pBody.replace(/\s+/g, ''), 'base64').toString('utf8');
      } else if (/content-transfer-encoding:\s*quoted-printable/i.test(pHeaders)) {
        decoded = decodeQuotedPrintable(pBody);
      }
      if (/text\/html/i.test(pHeaders)) {
        decoded = stripHtmlTags(decoded);
      }
      decodedParts.push(decoded);
    }
    return decodedParts.join('\n').replace(/\s+/g, ' ').trim();
  }

  let text = body;
  if (/content-transfer-encoding:\s*base64/i.test(headers)) {
    text = Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8');
  } else if (/content-transfer-encoding:\s*quoted-printable/i.test(headers)) {
    text = decodeQuotedPrintable(body);
  }
  if (/text\/html/i.test(headers)) {
    text = stripHtmlTags(text);
  }
  return text.replace(/\s+/g, ' ').trim();
}

export function parseFamPayEmail({ from = '', subject = '', text = '', rawSource = '', date = null, messageId = null, uid = null }) {
  const bodyText = text || decodeMimeText(rawSource);
  const combined = `${subject}\n${bodyText}`.replace(/\s+/g, ' ').trim();
  const fromStr = String(from ?? '').toLowerCase();

  const looksLikeFamPayOrUpi = /fampay|famapp|upi|received|credited/i.test(`${fromStr} ${combined}`);
  if (!looksLikeFamPayOrUpi) return null;

  const isCredit = /\b(received|credited|paid you|sent you|payment received|money received)\b/i.test(combined);
  const isDebitOnly = /\b(debited|you paid|you sent|sent to|paid to)\b/i.test(combined) && !isCredit;
  if (!isCredit || isDebitOnly) return null;

  const amountMatch = combined.match(/(?:₹|Rs\.?|INR)\s*([\d,]+(?:\.\d{1,2})?)/i)
    ?? combined.match(/([\d,]+(?:\.\d{1,2})?)\s*(?:₹|Rs\.?|INR)/i);
  if (!amountMatch) return null;

  const numericAmount = Number(amountMatch[1].replace(/,/g, ''));
  const amountMinor = Math.round(numericAmount * 100);
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) return null;

  const utrMatch = combined.match(/(?:UTR|UPI\s*Ref(?:erence)?|Ref(?:\s*No\.?)?|Txn(?:\s*ID)?|Transaction\s*ID)\D{0,20}(\d{12})\b/i)
    ?? combined.match(/\b(\d{12})\b/);
  const utr = utrMatch ? utrMatch[1] : null;
  const refMatch = combined.match(/\b(FS\d{1,16})\b/i);
  const txnRef = refMatch ? refMatch[1].toUpperCase() : null;

  const parsedDate = date ? new Date(date) : new Date();
  const eventId = (utr ? `utr:${utr}` : null) || (messageId ? `msg:${String(messageId).slice(0, 200)}` : `uid:${uid}`);

  return {
    amountMinor,
    utr,
    txnRef,
    subject: String(subject ?? '').slice(0, 200),
    from: String(from ?? '').slice(0, 120),
    date: Number.isFinite(parsedDate.getTime()) ? parsedDate : new Date(),
    eventId,
  };
}

export async function testFamPayImapConnection(pool, config, imapClientFactory = createDefaultImapClient) {
  const cfg = await loadFamPayConfig(pool, config.tokenEncryptionKey);
  if (!cfg.gmailEmail) throw new Error('Gmail address is not configured.');
  if (!cfg.gmailAppPassword) throw new Error('Gmail App Password is not configured.');
  if (!cfg.upiId) throw new Error('FamPay UPI ID is not configured.');

  const client = imapClientFactory(cfg.gmailEmail, cfg.gmailAppPassword);
  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    let exists = 0;
    try {
      exists = Number(client.mailbox?.exists ?? 0);
    } finally {
      lock.release();
    }
    await client.logout().catch(() => {});
    await markPaymentMethodTest(pool, METHOD, 'ok');
    return { ok: true, gmailEmail: cfg.gmailEmail, upiId: cfg.upiId, inboxMessages: exists };
  } catch (error) {
    await client.close?.();
    const msg = String(error?.message ?? 'IMAP connection failed');
    await markPaymentMethodTest(pool, METHOD, 'failed', msg).catch(() => {});
    throw new Error(`Gmail IMAP login failed: ${msg}`);
  }
}

export async function fetchRecentFamPayEmails(gmailEmail, gmailAppPassword, sinceDate, imapClientFactory = createDefaultImapClient) {
  const client = imapClientFactory(gmailEmail, gmailAppPassword);
  const parsed = [];
  await client.connect();
  try {
    const lock = await client.getMailboxLock('INBOX');
    try {
      const searchSince = new Date((sinceDate ? new Date(sinceDate).getTime() : Date.now()) - 24 * 60 * 60 * 1000);
      const uids = await client.search({ since: searchSince }, { uid: true });
      const recentUids = Array.isArray(uids) ? uids.slice(-40) : [];
      if (!recentUids.length) return [];

      for await (const msg of client.fetch(recentUids, { uid: true, envelope: true, internalDate: true, source: true }, { uid: true })) {
        const fromList = msg.envelope?.from ?? [];
        const from = fromList.map((entry) => `${entry.name ?? ''} <${entry.address ?? ''}>`).join(', ');
        const subject = msg.envelope?.subject ?? '';
        const date = msg.internalDate ?? msg.envelope?.date ?? new Date();
        const messageId = msg.envelope?.messageId ?? null;
        const emailPayment = parseFamPayEmail({
          from,
          subject,
          rawSource: msg.source,
          date,
          messageId,
          uid: msg.uid,
        });
        if (emailPayment) parsed.push(emailPayment);
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => client.close?.());
  }
  return parsed;
}

export function buildUpiPaymentUri({ upiId, merchantName = 'FileStore', amountMinor, txnNote, txnRef }) {
  const amountDecimal = (Number(amountMinor) / 100).toFixed(2);
  const params = new URLSearchParams({
    pn: merchantName,
    am: amountDecimal,
    cu: CURRENCY,
    tn: txnNote,
    tr: txnRef,
  });
  return `upi://pay?pa=${upiId}&${params.toString()}`;
}

export async function generateUpiQrBuffer(upiUri) {
  return QRCode.toBuffer(upiUri, {
    type: 'png',
    width: 512,
    margin: 2,
    errorCorrectionLevel: 'M',
  });
}

export async function generateUpiQrDataUrl(upiUri) {
  return QRCode.toDataURL(upiUri, {
    width: 380,
    margin: 2,
    errorCorrectionLevel: 'M',
  });
}

async function findReusableFamPaySession(pool, { userId, purpose, target }) {
  const { rows } = await pool.query(
    `SELECT id, user_telegram_id, method, purpose, plan_id, file_id, batch_link_id, paid_link_id,
            expected_amount_minor, currency, status, expires_at, provider_checkout_url, metadata, created_at
     FROM payment_sessions
     WHERE user_telegram_id = $1
       AND method = $2
       AND purpose = $3
       AND status = 'pending'
       AND expires_at > NOW() + INTERVAL '2 minutes'
       AND ($4::bigint IS NULL OR plan_id = $4)
       AND ($5::bigint IS NULL OR file_id = $5)
       AND ($6::bigint IS NULL OR paid_link_id = $6)
       AND ($7::bigint IS NULL OR batch_link_id = $7)
     ORDER BY created_at DESC LIMIT 1`,
    [userId, METHOD, purpose, target.planId ?? null, target.fileId ?? null, target.paidLinkId ?? null, target.batchLinkId ?? null],
  );
  return rows[0] ?? null;
}

export async function createFamPayCheckout(pool, config, { userId, purpose, target, baseAmountMinor, currency = CURRENCY, label = 'Premium Access', deliveryBotId = null }) {
  const fpConfig = await loadFamPayConfig(pool, config.tokenEncryptionKey);
  if (!fpConfig.isEnabled || !fpConfig.isConfigured) {
    throw new Error('FamPay UPI checkout is currently unavailable.');
  }
  if (String(currency).toUpperCase() !== CURRENCY) {
    throw new Error('FamPay UPI only supports INR plans.');
  }
  const baseMinor = Number(baseAmountMinor);
  if (!Number.isSafeInteger(baseMinor) || baseMinor <= 0) {
    throw new Error('FamPay UPI checkout requires a plan price greater than ₹0.00.');
  }

  const existing = await findReusableFamPaySession(pool, { userId, purpose, target });
  const sameBaseAmount = existing?.metadata?.baseAmountMinor === undefined || Number(existing.metadata.baseAmountMinor) === baseMinor;
  if (existing && sameBaseAmount && existing.provider_checkout_url && (!existing.metadata?.upiId || existing.metadata.upiId === fpConfig.upiId)) {
    const qrBuffer = await generateUpiQrBuffer(existing.provider_checkout_url);
    return {
      session: existing,
      upiUri: existing.provider_checkout_url,
      qrBuffer,
      amountMinor: Number(existing.expected_amount_minor),
      amountDisplay: formatMoney(existing.expected_amount_minor, CURRENCY),
      upiId: fpConfig.upiId,
      txnRef: existing.metadata?.txnRef ?? `FS${existing.id}`,
      reused: true,
    };
  }

  const client = await pool.connect();
  let session;
  let offset = 1;
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [AMOUNT_ALLOCATION_LOCK_ID]);

    const activeAmounts = await client.query(
      `SELECT expected_amount_minor FROM payment_sessions
       WHERE method = $1 AND status = 'pending' AND expires_at > NOW()
         AND expected_amount_minor BETWEEN $2 AND $3`,
      [METHOD, baseMinor, baseMinor + 99],
    );
    const used = new Set(activeAmounts.rows.map((r) => Number(r.expected_amount_minor)));

    let chosenMinor = null;
    for (let candidateOffset = 1; candidateOffset <= 99; candidateOffset++) {
      if (!used.has(baseMinor + candidateOffset)) {
        chosenMinor = baseMinor + candidateOffset;
        offset = candidateOffset;
        break;
      }
    }
    if (chosenMinor === null) {
      throw new Error('Too many pending UPI checkouts for this amount right now. Please try again in a minute.');
    }

    const expiresAt = new Date(Date.now() + FAMPAY_EXPIRY_MS);
    const inserted = await client.query(
      `INSERT INTO payment_sessions (user_telegram_id, method, purpose, plan_id, file_id, batch_link_id, paid_link_id, expected_amount_minor, currency, expires_at, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
       RETURNING id, user_telegram_id, method, purpose, plan_id, file_id, batch_link_id, paid_link_id, expected_amount_minor, currency, status, expires_at, created_at`,
      [
        userId,
        METHOD,
        purpose,
        target.planId ?? null,
        target.fileId ?? null,
        target.batchLinkId ?? null,
        target.paidLinkId ?? null,
        chosenMinor,
        CURRENCY,
        expiresAt,
        JSON.stringify({ baseAmountMinor: baseMinor, paiseOffset: offset, label: String(label).slice(0, 120), deliveryBotId }),
      ],
    );
    session = inserted.rows[0];
    const txnRef = `FS${session.id}`;
    const upiUri = buildUpiPaymentUri({
      upiId: fpConfig.upiId,
      merchantName: fpConfig.merchantName,
      amountMinor: chosenMinor,
      txnNote: `${String(label).slice(0, 32)} ${txnRef}`,
      txnRef,
    });
    const metadata = {
      baseAmountMinor: baseMinor,
      paiseOffset: offset,
      upiId: fpConfig.upiId,
      txnRef,
      label: String(label).slice(0, 120),
      deliveryBotId,
    };
    await client.query(
      `UPDATE payment_sessions SET provider_checkout_url = $2, provider_session_id = $3, metadata = $4::jsonb WHERE id = $1`,
      [session.id, upiUri, txnRef, JSON.stringify(metadata)],
    );
    session.provider_checkout_url = upiUri;
    session.metadata = metadata;
    await client.query('COMMIT');
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    throw error;
  } finally {
    client.release();
  }

  const qrBuffer = await generateUpiQrBuffer(session.provider_checkout_url);
  return {
    session,
    upiUri: session.provider_checkout_url,
    qrBuffer,
    amountMinor: Number(session.expected_amount_minor),
    amountDisplay: formatMoney(session.expected_amount_minor, CURRENCY),
    upiId: fpConfig.upiId,
    txnRef: session.metadata.txnRef,
    reused: false,
  };
}

export async function cancelFamPaySession(pool, sessionId, userId) {
  const { rows } = await pool.query(
    `UPDATE payment_sessions
     SET status = 'failed', updated_at = NOW(),
         metadata = COALESCE(metadata, '{}'::jsonb) || '{"cancelledByUser": true}'::jsonb
     WHERE id = $1 AND user_telegram_id = $2 AND method = $3 AND status = 'pending'
     RETURNING id`,
    [sessionId, userId, METHOD],
  );
  return rows.length > 0;
}

async function isEmailReceiptAlreadyUsed(pool, receipt) {
  const checks = [];
  const params = [METHOD, receipt.eventId];
  checks.push('(method = $1 AND external_transaction_id = $2)');
  if (receipt.utr) {
    params.push(receipt.utr);
    checks.push(`utr = $${params.length}`);
    checks.push(`(method = $1 AND external_transaction_id = $${params.length})`);
  }
  const { rowCount } = await pool.query(
    `SELECT 1 FROM payment_transactions WHERE ${checks.join(' OR ')} LIMIT 1`,
    params,
  );
  return rowCount > 0;
}

function receiptMatchesSession(receipt, session, submittedUtr = null) {
  if (Number(receipt.amountMinor) !== Number(session.expected_amount_minor)) return false;

  const emailMs = new Date(receipt.date).getTime();
  const createdMs = new Date(session.created_at).getTime();
  if (!Number.isFinite(emailMs)) return false;
  if (emailMs < createdMs - 120_000) return false;
  if (Date.now() - emailMs > MAX_EMAIL_AGE_MS) return false;

  if (submittedUtr) {
    if (!receipt.utr || receipt.utr !== submittedUtr) return false;
  } else if (receipt.txnRef && session.metadata?.txnRef && receipt.txnRef !== session.metadata.txnRef) {
    return false;
  }
  return true;
}

async function settleMatchedFamPaySession(pool, session, receipt, config = null) {
  const eventReceipt = await recordProviderEvent(pool, {
    method: METHOD,
    eventId: receipt.eventId,
    eventType: 'gmail_imap_alert',
    payload: {
      utr: receipt.utr,
      amountMinor: receipt.amountMinor,
      subject: receipt.subject,
      from: receipt.from,
      date: receipt.date.toISOString(),
    },
  });
  const externalTransactionId = receipt.utr || receipt.eventId;
  try {
    const verified = await recordVerifiedPayment(pool, {
      method: METHOD,
      sessionId: session.id,
      externalTransactionId,
      utr: receipt.utr ?? null,
      userId: session.user_telegram_id,
      purpose: session.purpose,
      planId: session.plan_id ?? null,
      fileId: session.file_id ?? null,
      paidLinkId: session.paid_link_id ?? null,
      batchLinkId: session.batch_link_id ?? null,
      amountMinor: Number(session.expected_amount_minor),
      currency: session.currency,
    });
    const fulfilled = await applyVerifiedPayment(pool, verified.transaction.id, { adminIds: config?.adminIds ?? [] });
    await markProviderEvent(pool, eventReceipt.event.id, 'processed', verified.transaction.id);
    if (fulfilled?.creatorCredit && config?.notifyTelegram) {
      await notifyCreatorSale(config.notifyTelegram, fulfilled.creatorCredit).catch(() => {});
    }
    return { verified: true, transactionId: verified.transaction.id, utr: receipt.utr, fulfilled, session };
  } catch (error) {
    await markProviderEvent(pool, eventReceipt.event.id, 'failed', null, error.message).catch(() => {});
    throw error;
  }
}

export async function verifyFamPaySession(pool, config, sessionId, { userId = null, submittedUtr = null, imapClientFactory = createDefaultImapClient } = {}) {
  const sessionRes = await pool.query(
    `SELECT id, user_telegram_id, method, purpose, plan_id, file_id, batch_link_id, paid_link_id,
            expected_amount_minor, currency, status, expires_at, metadata, created_at
     FROM payment_sessions WHERE id = $1 LIMIT 1`,
    [sessionId],
  );
  const session = sessionRes.rows[0];
  if (!session || session.method !== METHOD) {
    throw new Error('Checkout session not found.');
  }
  if (userId !== null && String(session.user_telegram_id) !== String(userId)) {
    throw new Error('This checkout session does not belong to you.');
  }
  if (session.status === 'applied') {
    return { status: 'already_applied', session };
  }
  if (session.status === 'verified') {
    const txRes = await pool.query('SELECT id FROM payment_transactions WHERE session_id = $1 LIMIT 1', [session.id]);
    if (txRes.rowCount) {
      const fulfilled = await applyVerifiedPayment(pool, txRes.rows[0].id, { adminIds: config?.adminIds ?? [] });
      if (fulfilled?.creatorCredit && config?.notifyTelegram) {
        await notifyCreatorSale(config.notifyTelegram, fulfilled.creatorCredit).catch(() => {});
      }
      return { status: 'verified', session, fulfilled, transactionId: txRes.rows[0].id };
    }
  }
  if (session.status !== 'pending' || new Date(session.expires_at) <= new Date()) {
    return { status: 'expired', session };
  }

  let cleanUtr = null;
  if (submittedUtr !== null && submittedUtr !== undefined) {
    cleanUtr = String(submittedUtr).trim();
    if (!/^\d{12}$/.test(cleanUtr)) {
      throw new Error('UTR must be a valid 12-digit number.');
    }
  }

  const fpConfig = await loadFamPayConfig(pool, config.tokenEncryptionKey);
  if (!fpConfig.isEnabled || !fpConfig.gmailEmail || !fpConfig.gmailAppPassword) {
    throw new Error('FamPay verification is currently disabled.');
  }

  const emails = await fetchRecentFamPayEmails(fpConfig.gmailEmail, fpConfig.gmailAppPassword, session.created_at, imapClientFactory);
  for (const receipt of emails) {
    if (!receiptMatchesSession(receipt, session, cleanUtr)) continue;
    if (await isEmailReceiptAlreadyUsed(pool, receipt)) continue;
    const settled = await settleMatchedFamPaySession(pool, session, receipt, config);
    return { status: 'verified', ...settled };
  }

  return { status: 'pending', session };
}

const FAMPAY_SCAN_LOCK_ID = 74290212;

export async function scanPendingFamPaySessions(pool, config, logger, imapClientFactory = createDefaultImapClient) {
  const { rows: sessions } = await pool.query(
    `SELECT id, user_telegram_id, method, purpose, plan_id, file_id, batch_link_id, paid_link_id,
            expected_amount_minor, currency, status, expires_at, metadata, created_at
     FROM payment_sessions
     WHERE method = $1 AND status = 'pending' AND expires_at > NOW()
     ORDER BY created_at ASC LIMIT 25`,
    [METHOD],
  );
  if (!sessions.length) return [];

  const fpConfig = await loadFamPayConfig(pool, config.tokenEncryptionKey);
  if (!fpConfig.isEnabled || !fpConfig.gmailEmail || !fpConfig.gmailAppPassword) return [];

  let lockClient = null;
  let locked = false;
  if (typeof pool.connect === 'function') {
    try {
      lockClient = await pool.connect();
      const lockRes = await lockClient.query('SELECT pg_try_advisory_lock($1) AS acquired', [FAMPAY_SCAN_LOCK_ID]);
      locked = lockRes.rows?.[0]?.acquired !== false;
      if (!locked) {
        return [];
      }
    } catch {
      // Allow scan to proceed in mock/test environments
    }
  }

  try {
    const earliestCreated = sessions[0].created_at;
    const emails = await fetchRecentFamPayEmails(fpConfig.gmailEmail, fpConfig.gmailAppPassword, earliestCreated, imapClientFactory);
    if (!emails.length) return [];

    const settledResults = [];
    for (const session of sessions) {
      for (const receipt of emails) {
        if (!receiptMatchesSession(receipt, session)) continue;
        if (await isEmailReceiptAlreadyUsed(pool, receipt)) continue;
        try {
          const settled = await settleMatchedFamPaySession(pool, session, receipt, config);
          settledResults.push(settled);
          break;
        } catch (error) {
          logger?.warn({ sessionId: session.id, error: error.message }, 'FamPay background verification failed for session');
        }
      }
    }
    return settledResults;
  } finally {
    if (lockClient) {
      if (locked) {
        await lockClient.query('SELECT pg_advisory_unlock($1)', [FAMPAY_SCAN_LOCK_ID]).catch(() => {});
      }
      lockClient.release();
    }
  }
}
