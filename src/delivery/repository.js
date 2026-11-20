export async function createSingleDeliveryJob(pool, requesterTelegramId, fileId, requestedBy = requesterTelegramId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const job = await client.query(
      'INSERT INTO delivery_jobs (job_type, requester_telegram_id, requested_by) VALUES ($1, $2, $3) RETURNING id',
      ['single', requesterTelegramId, requestedBy],
    );
    await client.query(
      'INSERT INTO delivery_items (job_id, file_id, position) VALUES ($1, $2, 0)',
      [job.rows[0].id, fileId],
    );
    await client.query('COMMIT');
    return job.rows[0].id;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function claimNextDeliveryJob(pool, workerIdentity) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const jobResult = await client.query(
      `SELECT id, requester_telegram_id FROM delivery_jobs
       WHERE status = 'pending' ORDER BY created_at ASC
       LIMIT 1 FOR UPDATE SKIP LOCKED`,
    );
    if (!jobResult.rowCount) {
      await client.query('COMMIT');
      return null;
    }
    const job = jobResult.rows[0];
    await client.query(
      `UPDATE delivery_jobs SET status = 'processing', locked_by = $2,
       locked_until = NOW() + INTERVAL '90 seconds', attempt_count = attempt_count + 1,
       updated_at = NOW() WHERE id = $1`,
      [job.id, workerIdentity],
    );
    const itemResult = await client.query(
      `SELECT id, file_id FROM delivery_items WHERE job_id = $1 AND status = 'pending'
       ORDER BY position ASC LIMIT 1 FOR UPDATE`,
      [job.id],
    );
    if (!itemResult.rowCount) {
      await client.query("UPDATE delivery_jobs SET status = 'failed', last_error = 'No pending delivery items', locked_by = NULL, locked_until = NULL WHERE id = $1", [job.id]);
      await client.query('COMMIT');
      return null;
    }
    const item = itemResult.rows[0];
    await client.query("UPDATE delivery_items SET status = 'processing', updated_at = NOW() WHERE id = $1", [item.id]);
    const attempt = await client.query(
      `INSERT INTO delivery_attempts (delivery_item_id, delivery_bot_identity, status)
       VALUES ($1, $2, 'started') RETURNING id`,
      [item.id, workerIdentity],
    );
    await client.query('COMMIT');
    return { jobId: job.id, requesterTelegramId: job.requester_telegram_id, itemId: item.id, fileId: item.file_id, attemptId: attempt.rows[0].id, workerIdentity };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}


export async function renewDeliveryLease(pool, jobId, workerIdentity) {
  const result = await pool.query(
    `UPDATE delivery_jobs SET locked_until = NOW() + INTERVAL '90 seconds', updated_at = NOW()
     WHERE id = $1 AND status = 'processing' AND locked_by = $2 AND locked_until > NOW()
     RETURNING id`,
    [jobId, workerIdentity],
  );
  return result.rowCount === 1;
}

export async function getDeliverySource(pool, fileId) {
  const result = await pool.query(
    `SELECT f.file_code, f.file_name, f.telegram_file_id, sm.telegram_message_id,
       sc.telegram_chat_id AS storage_chat_id, sc.title AS storage_title
     FROM files f
     JOIN storage_messages sm ON sm.file_id = f.id AND sm.is_primary = TRUE
     JOIN storage_channels sc ON sc.id = sm.storage_channel_id
     WHERE f.id = $1 AND f.status = 'active' AND sc.is_enabled = TRUE
     LIMIT 1`,
    [fileId],
  );
  return result.rows[0] ?? null;
}

export async function finishDelivery(pool, claim, deliveredMessageId, workerIdentity) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ownership = await client.query(
      `SELECT id FROM delivery_jobs WHERE id = $1 AND status = 'processing'
       AND locked_by = $2 AND locked_until > NOW() FOR UPDATE`,
      [claim.jobId, workerIdentity],
    );
    if (!ownership.rowCount) throw new Error('Delivery lease lost; refusing to finalize');
    await client.query("UPDATE delivery_attempts SET status = 'delivered', telegram_message_id = $2, finished_at = NOW() WHERE id = $1", [claim.attemptId, deliveredMessageId]);
    await client.query("UPDATE delivery_items SET status = 'delivered', delivered_to = $2, telegram_message_id = $3, delivered_at = NOW(), updated_at = NOW() WHERE id = $1", [claim.itemId, claim.requesterTelegramId, deliveredMessageId]);
    const setting = await client.query("SELECT setting_value FROM delivery_settings WHERE setting_key = 'auto_delete_minutes'");
    const autoDeleteMinutes = Number(setting.rows[0]?.setting_value ?? 0);
    if (Number.isInteger(autoDeleteMinutes) && autoDeleteMinutes > 0 && autoDeleteMinutes <= 10080) {
      await client.query(
        "INSERT INTO scheduled_message_deletions (delivery_bot_identity, chat_id, message_id, delete_at) VALUES ($1, $2, $3, NOW() + ($4 * INTERVAL '1 minute')) ON CONFLICT (delivery_bot_identity, chat_id, message_id) DO NOTHING",
        [workerIdentity, claim.requesterTelegramId, deliveredMessageId, autoDeleteMinutes],
      );
    }
    await client.query("UPDATE delivery_jobs SET status = CASE WHEN EXISTS (SELECT 1 FROM delivery_items WHERE job_id = $1 AND status = 'pending') THEN 'pending' ELSE 'completed' END, locked_by = NULL, locked_until = NULL, completed_at = CASE WHEN EXISTS (SELECT 1 FROM delivery_items WHERE job_id = $1 AND status = 'pending') THEN NULL ELSE NOW() END, updated_at = NOW() WHERE id = $1", [claim.jobId]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function failDelivery(pool, claim, status, errorCode, errorDescription) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ownership = await client.query(
      `SELECT id FROM delivery_jobs WHERE id = $1 AND status = 'processing'
       AND locked_by = $2 AND locked_until > NOW() FOR UPDATE`,
      [claim.jobId, claim.workerIdentity],
    );
    if (!ownership.rowCount) throw new Error('Delivery lease lost; refusing to mark failure');
    await client.query('UPDATE delivery_attempts SET status = $2, error_code = $3, error_description = $4, finished_at = NOW() WHERE id = $1', [claim.attemptId, status, errorCode, errorDescription?.slice(0, 500) ?? null]);
    await client.query('UPDATE delivery_items SET status = $2, last_error = $3, updated_at = NOW() WHERE id = $1', [claim.itemId, status, errorDescription?.slice(0, 500) ?? null]);
    await client.query('UPDATE delivery_jobs SET status = $2, last_error = $3, locked_by = NULL, locked_until = NULL, updated_at = NOW() WHERE id = $1', [claim.jobId, status, errorDescription?.slice(0, 500) ?? null]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function recoverExpiredDeliveryJobs(pool) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE delivery_attempts da SET status = 'uncertain', finished_at = NOW(),
       error_description = COALESCE(error_description, 'Worker lease expired during send')
       FROM delivery_items di JOIN delivery_jobs dj ON dj.id = di.job_id
       WHERE da.delivery_item_id = di.id AND da.status = 'started'
         AND di.status = 'processing' AND dj.status = 'processing' AND dj.locked_until < NOW()`,
    );
    await client.query(
      `UPDATE delivery_items di SET status = 'uncertain', last_error = 'Worker lease expired; send outcome uncertain', updated_at = NOW()
       FROM delivery_jobs dj WHERE dj.id = di.job_id AND dj.status = 'processing'
         AND dj.locked_until < NOW() AND di.status = 'processing'
         AND EXISTS (SELECT 1 FROM delivery_attempts da WHERE da.delivery_item_id = di.id AND da.status = 'uncertain')`,
    );
    await client.query(
      `UPDATE delivery_items di SET status = 'pending', updated_at = NOW()
       FROM delivery_jobs dj WHERE dj.id = di.job_id AND dj.status = 'processing'
         AND dj.locked_until < NOW() AND di.status = 'processing'
         AND NOT EXISTS (SELECT 1 FROM delivery_attempts da WHERE da.delivery_item_id = di.id AND da.status = 'uncertain')`,
    );
    await client.query(
      `UPDATE delivery_jobs dj SET status = 'uncertain', locked_by = NULL, locked_until = NULL,
       updated_at = NOW() WHERE dj.status = 'processing' AND dj.locked_until < NOW()
       AND EXISTS (SELECT 1 FROM delivery_items di WHERE di.job_id = dj.id AND di.status = 'uncertain')`,
    );
    await client.query(
      `UPDATE delivery_jobs dj SET status = 'pending', locked_by = NULL, locked_until = NULL,
       updated_at = NOW() WHERE dj.status = 'processing' AND dj.locked_until < NOW()
       AND NOT EXISTS (SELECT 1 FROM delivery_items di WHERE di.job_id = dj.id AND di.status = 'uncertain')`,
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function getRecentDeliveryJobs(pool, limit = 10) {
  const safeLimit = Math.max(1, Math.min(25, Number.isInteger(limit) ? limit : 10));
  const result = await pool.query(
    `SELECT dj.id, dj.job_type, dj.status, dj.requester_telegram_id, dj.attempt_count,
       dj.last_error, dj.created_at,
       COUNT(di.id)::int AS item_count,
       COUNT(di.id) FILTER (WHERE di.status = 'delivered')::int AS delivered_count,
       COUNT(di.id) FILTER (WHERE di.status = 'failed')::int AS failed_count,
       COUNT(di.id) FILTER (WHERE di.status = 'uncertain')::int AS uncertain_count
     FROM delivery_jobs dj LEFT JOIN delivery_items di ON di.job_id = dj.id
     GROUP BY dj.id ORDER BY dj.created_at DESC LIMIT $1`,
    [safeLimit],
  );
  return result.rows;
}

export async function getDeliveryStats(pool) {
  const result = await pool.query(
    `SELECT
      COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
      COUNT(*) FILTER (WHERE status = 'processing')::int AS processing,
      COUNT(*) FILTER (WHERE status = 'completed')::int AS completed,
      COUNT(*) FILTER (WHERE status = 'failed')::int AS failed,
      COUNT(*) FILTER (WHERE status = 'uncertain')::int AS uncertain
     FROM delivery_jobs`,
  );
  return result.rows[0];
}

export async function retryFailedDeliveryJob(pool, jobId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const jobResult = await client.query(
      "SELECT id, status FROM delivery_jobs WHERE id = $1 FOR UPDATE",
      [jobId],
    );
    if (!jobResult.rowCount || jobResult.rows[0].status !== 'failed') {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'not_retryable' };
    }
    const countsResult = await client.query(
      `SELECT
        COUNT(*) FILTER (WHERE status = 'failed')::int AS failed,
        COUNT(*) FILTER (WHERE status = 'uncertain')::int AS uncertain,
        COUNT(*) FILTER (WHERE status = 'processing')::int AS processing
       FROM delivery_items WHERE job_id = $1`,
      [jobId],
    );
    const counts = countsResult.rows[0];
    if (counts.uncertain > 0 || counts.processing > 0) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'unsafe_state' };
    }
    if (counts.failed < 1) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'no_failed_items' };
    }
    await client.query(
      `UPDATE delivery_items SET status = 'pending', last_error = NULL, updated_at = NOW()
       WHERE job_id = $1 AND status = 'failed'`,
      [jobId],
    );
    await client.query(
      `UPDATE delivery_jobs SET status = 'pending', last_error = NULL, locked_by = NULL,
       locked_until = NULL, completed_at = NULL, updated_at = NOW() WHERE id = $1 AND status = 'failed'`,
      [jobId],
    );
    await client.query('COMMIT');
    return { ok: true, retriedItems: counts.failed };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function createBatchDeliveryJob(pool, requesterTelegramId, fileIds, requestedBy = requesterTelegramId) {
  if (!Array.isArray(fileIds) || !fileIds.length || fileIds.length > 100) throw new Error('Batch delivery requires 1–100 files.');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const job = await client.query(
      'INSERT INTO delivery_jobs (job_type, requester_telegram_id, requested_by) VALUES ($1, $2, $3) RETURNING id',
      ['batch', requesterTelegramId, requestedBy],
    );
    for (let i = 0; i < fileIds.length; i++) {
      await client.query('INSERT INTO delivery_items (job_id, file_id, position) VALUES ($1, $2, $3)', [job.rows[0].id, fileIds[i], i + 1]);
    }
    await client.query('COMMIT');
    return job.rows[0].id;
  } catch (error) { try { await client.query('ROLLBACK'); } catch {} throw error; }
  finally { client.release(); }
}
