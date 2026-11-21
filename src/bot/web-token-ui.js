import {
  getAccessTokenMetadata,
  issueOrRegenerateAccessToken,
  revokeAccessToken,
} from '../web/token-repository.js';
import { escapeHtml, renderView, safeAnswer } from './telegram-utils.js';

function resolveWebPanelUrl(config) {
  const raw = String(config?.appUrl ?? process.env.APP_URL ?? '').trim();
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
      return parsed.toString().replace(/\/$/, '');
    }
  } catch {}
  return null;
}

function formatIsoDate(value) {
  if (!value) return 'Never';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return 'Unknown';
  return d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

export function registerWebTokenUi(bot, config, logger, pool, hooks = {}) {
  async function showTokenPanel(ctx, edit = false) {
    try {
      const userId = Number(ctx.from.id);
      const panelUrl = resolveWebPanelUrl(config);
      const existing = await getAccessTokenMetadata(pool, userId);

      // First visit: auto-generate a fresh unique token immediately
      if (!existing) {
        const issued = await issueOrRegenerateAccessToken(pool, userId, ctx.from);
        return renderFreshToken(ctx, issued, panelUrl, edit, false);
      }

      const lines = [
        '🌐 <b>Web Control Panel Access</b>',
        '━━━━━━━━━━━━━━━━━━',
        '',
        '🔑 <b>Status:</b> 🟢 Active Token Issued',
        `🪪 <b>Token Prefix:</b> <code>${escapeHtml(existing.token_prefix)}••••••••</code>`,
        `🔄 <b>Last Generated:</b> ${escapeHtml(formatIsoDate(existing.rotated_at))}`,
        `🕒 <b>Last Used:</b> ${escapeHtml(formatIsoDate(existing.last_used_at))}`,
      ];
      if (panelUrl) {
        lines.push('', `🔗 <b>Web Panel:</b> ${escapeHtml(panelUrl)}`);
      }
      lines.push(
        '',
        '🔒 <i>For security, your full token is only shown once when generated. Need a new copy or want to lock out old sessions? Tap <b>Regenerate Token</b> below.</i>',
      );

      const rows = [];
      if (panelUrl && panelUrl.startsWith('https://')) {
        rows.push([{ text: '🌐 Open Web Control Panel', url: panelUrl }]);
      }
      rows.push([
        { text: '🔄 Regenerate Token', callback_data: 'cc:webtok_regen_ask' },
        { text: '🗑 Revoke Token', callback_data: 'cc:webtok_revoke_ask' },
      ]);
      rows.push([{ text: '🎛 Main Menu', callback_data: 'cc:home' }]);

      return renderView(ctx, lines.join('\n'), { inline_keyboard: rows }, edit, true, { parse_mode: 'HTML' });
    } catch (error) {
      logger?.error?.({ error: error.message }, 'Web token panel failed');
      return renderView(ctx, '❌ Could not load Web Panel token right now. Please try again.', {
        inline_keyboard: [[{ text: '🎛 Main Menu', callback_data: 'cc:home' }]],
      }, edit, true);
    }
  }

  async function renderFreshToken(ctx, issued, panelUrl, edit, rotated) {
    const lines = [
      rotated ? '🔄 <b>New Web Panel Token Generated</b>' : '🌐 <b>Your Web Control Panel Token</b>',
      '━━━━━━━━━━━━━━━━━━',
      '',
      '🔑 <b>Unique Access Token</b> <i>(tap to reveal &amp; copy):</i>',
      `<tg-spoiler><code>${escapeHtml(issued.token)}</code></tg-spoiler>`,
    ];
    if (panelUrl) {
      lines.push('', `🔗 <b>Web Panel URL:</b> ${escapeHtml(panelUrl)}`);
    }
    lines.push(
      '',
      '📋 <b>How to use:</b>',
      '1. Open the FileStore Web Control Panel.',
      '2. Paste your unique token when prompted — no password or signup needed.',
      rotated
        ? '3. Your previous token has been immediately invalidated.'
        : '3. Keep this token private; you can regenerate or revoke it here anytime.',
    );

    const rows = [];
    if (panelUrl && panelUrl.startsWith('https://')) {
      rows.push([{ text: '🌐 Open Web Control Panel', url: panelUrl }]);
    }
    rows.push([
      { text: '🔄 Regenerate Token', callback_data: 'cc:webtok_regen_ask' },
      { text: '🗑 Revoke Token', callback_data: 'cc:webtok_revoke_ask' },
    ]);
    rows.push([{ text: '🎛 Main Menu', callback_data: 'cc:home' }]);

    return renderView(ctx, lines.join('\n'), { inline_keyboard: rows }, edit, true, { parse_mode: 'HTML' });
  }

  bot.command(['token', 'web', 'panel'], async (ctx) => {
    hooks.clearOtherSessions?.(ctx.from.id);
    await showTokenPanel(ctx, false);
  });

  bot.action('cc:webtok', async (ctx) => {
    hooks.clearOtherSessions?.(ctx.from.id);
    await safeAnswer(ctx);
    await showTokenPanel(ctx, true);
  });

  bot.action('cc:webtok_regen_ask', async (ctx) => {
    await safeAnswer(ctx);
    await renderView(
      ctx,
      [
        '🔄 <b>Regenerate Web Panel Token?</b>',
        '━━━━━━━━━━━━━━━━━━',
        '',
        'Generating a new token will <b>immediately invalidate</b> your old token across all browser sessions.',
        '',
        'Do you want to issue a brand-new unique token?',
      ].join('\n'),
      {
        inline_keyboard: [
          [
            { text: '✅ Yes, Generate New Token', callback_data: 'cc:webtok_regen_go' },
            { text: '✖ Cancel', callback_data: 'cc:webtok' },
          ],
        ],
      },
      true,
      true,
      { parse_mode: 'HTML' },
    );
  });

  bot.action('cc:webtok_regen_go', async (ctx) => {
    await safeAnswer(ctx, '🔑 Generating new token...');
    try {
      const issued = await issueOrRegenerateAccessToken(pool, Number(ctx.from.id), ctx.from);
      const panelUrl = resolveWebPanelUrl(config);
      await renderFreshToken(ctx, issued, panelUrl, true, true);
    } catch (error) {
      logger?.error?.({ error: error.message }, 'Web token regeneration failed');
      await renderView(ctx, '❌ Could not regenerate token: ' + escapeHtml(error.message), {
        inline_keyboard: [[{ text: '← Back', callback_data: 'cc:webtok' }]],
      }, true, true, { parse_mode: 'HTML' });
    }
  });

  bot.action('cc:webtok_revoke_ask', async (ctx) => {
    await safeAnswer(ctx);
    await renderView(
      ctx,
      [
        '🗑 <b>Revoke Web Panel Token?</b>',
        '━━━━━━━━━━━━━━━━━━',
        '',
        'This will immediately disable web panel access until you generate a new token via /token.',
      ].join('\n'),
      {
        inline_keyboard: [
          [
            { text: '🗑 Yes, Revoke Now', callback_data: 'cc:webtok_revoke_go' },
            { text: '✖ Cancel', callback_data: 'cc:webtok' },
          ],
        ],
      },
      true,
      true,
      { parse_mode: 'HTML' },
    );
  });

  bot.action('cc:webtok_revoke_go', async (ctx) => {
    await safeAnswer(ctx, '🗑 Token revoked.');
    try {
      await revokeAccessToken(pool, Number(ctx.from.id));
      await renderView(
        ctx,
        [
          '✅ <b>Web Panel Token Revoked</b>',
          '━━━━━━━━━━━━━━━━━━',
          '',
          'Your previous token is no longer valid.',
          'Tap below or run /token whenever you want to generate a fresh one.',
        ].join('\n'),
        {
          inline_keyboard: [
            [{ text: '🔑 Generate New Token', callback_data: 'cc:webtok_regen_go' }],
            [{ text: '🎛 Main Menu', callback_data: 'cc:home' }],
          ],
        },
        true,
        true,
        { parse_mode: 'HTML' },
      );
    } catch (error) {
      logger?.error?.({ error: error.message }, 'Web token revoke failed');
      await renderView(ctx, '❌ Could not revoke token: ' + escapeHtml(error.message), {
        inline_keyboard: [[{ text: '← Back', callback_data: 'cc:webtok' }]],
      }, true, true, { parse_mode: 'HTML' });
    }
  });

  return { showTokenPanel };
}
