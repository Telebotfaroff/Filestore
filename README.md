# Filestore — Node.js + Telegraf + MongoDB Atlas

A **single-bot** Telegram file store. Files are copied to a private Telegram storage channel; MongoDB Atlas stores metadata and secure link records. Clone bots are intentionally out of scope.

## Features implemented

- Permanent single-file and multi-file batch links
- Admin `/post` wizard: thumbnail → title → one or more videos → free or Telegram Stars price → configured channel
- Admin `/auto` shortcut: send one Telegram media group with one thumbnail photo, one or more videos, and the title as a caption; then choose pricing and destination channel
- Admin `/channels` manager to add/remove posting channels (the bot must be a channel administrator)
- Channel posts use the thumbnail, title, and an inline button linking to a free or paid video post
- Password-protected links using salted scrypt hashes
- Admin-managed force subscription with an enable/disable toggle and multiple required channels; users must join every configured channel before using the bot
- Optional auto-delete for new uploads, with a persisted expiry worker
- Optional shortener verification using one-time sessions and signed server-to-server callbacks
- Telegram Stars premium purchase (configurable price and duration); premium bypasses shortener verification
- Admin-only link creation: only `OWNER_ID` and optional `ADMIN_IDS` can upload files or create batch links; everyone else can open shared links
- Owner tools: stats, ban/unban, broadcast, and auto-delete configuration
- MongoDB indexes for token uniqueness, payment deduplication, and expiry processing
- Health endpoint for persistent hosting
- No Redis, no local file storage, and no secrets committed to Git

## Admin website (Stages 1–2)

The admin dashboard is served by the same Express service as the bot at `/admin`; it does not use a separate database or a second bot.

### Sign-in setup

1. Open [@BotFather](https://t.me/BotFather) and use `/setdomain` for your bot.
2. Set the domain to the HTTPS hostname where Filestore is deployed (for example, your Render service hostname or custom domain; do not include a path).
3. Make sure `OWNER_ID` is your numeric Telegram user ID. Add any additional admin Telegram IDs to `ADMIN_IDS`, separated by commas.
4. Deploy the app and open `https://YOUR_HOST/admin`.
5. Sign in using the Telegram account whose ID is configured as an admin.

Telegram's signed login data is verified on the server. The dashboard issues an opaque, HttpOnly, SameSite=Strict session cookie; only a hash of the session token is stored in MongoDB. Sessions expire after 12 hours. The browser never receives the bot token or MongoDB credentials.

### Implemented features

- Responsive dashboard with dark and light themes.
- Telegram Login Widget authentication restricted to `OWNER_ID` and `ADMIN_IDS`.
- Session expiry and MongoDB TTL cleanup.
- Overview counts for users, files, batches, posts, active premium users, bans, processed Stars payments, and total Stars.
- Recent users and recent successful payments.
- The existing bot commands, webhook-free polling, storage channel and shortener callback remain in the same service.

### Rollout stages

- **Stage 1:** secure login and overview.
- **Stage 2:** searchable user management, owner-only ban/unban, paginated file/batch/post browsing, and soft-revocation of share links.
- **Stage 3:** payment history, premium tools, promo/referral support where compatible with the existing schema, and settings management.
- **Stage 4:** audit events, activity logs, health monitoring, recovery tools and final security/test pass.

Do not put `BOT_TOKEN`, `MONGODB_URI`, or any session secret in frontend code or a public repository. Configure all production variables through the hosting dashboard. The Telegram Login Widget requires the deployed domain to be configured in BotFather before login can work.

## Telegram setup

1. Create one bot with [@BotFather](https://t.me/BotFather).
2. Create a private storage channel and add the bot as an administrator with permission to post and delete messages.
3. Set the channel ID (usually starts with `-100`) in `DB_CHANNEL_ID`.
4. Set your numeric Telegram user ID in `OWNER_ID`. This account is always an admin.
5. Optionally set `ADMIN_IDS` to a comma-separated list of additional numeric Telegram user IDs. Only these admins can create file links or batch links; other users can only open links shared with them.
6. In the bot's private chat, run `/fsub` to enable force subscription and add multiple required channels. The bot must be an administrator in each channel. Add any channel using its `@username` or numeric channel ID. The bot automatically generates and stores a join invite link; make sure it has permission to invite users in each channel.

## MongoDB Atlas

Create a cluster and database user at [MongoDB Atlas](https://www.mongodb.com/atlas). Set `MONGODB_URI` and `MONGODB_DB_NAME` in environment variables. Keep credentials out of Git. Configure network access for your hosting provider.

## Run

```bash
npm install
cp .env.example .env
# Fill in .env
npm run check
npm test
npm start
```

Requires Node.js 20.11 or newer.

## Force subscription

Use `/fsub` or **Admin panel → Force subscription** to enable or disable the gate, add required channels, and remove channels. When enabled, users must be members of **every** configured channel. The bot checks membership when users interact with it and offers join links plus a recheck button. The bot must be an administrator in every required channel with permission to invite users, so it can generate invite links and Telegram permits membership checks. Existing `FORCE_SUB_CHANNEL` and `FORCE_SUB_URL` environment variables remain supported as a legacy initial configuration; admin-managed settings are saved in MongoDB.

## User commands

- `/start` — start the bot or open a single-file/batch link
- `/help` — list commands
- `/batch` — begin collecting files for a batch
- `/done` — create the batch link
- `/cancel` — cancel batch creation
- `/setpassword PASSWORD` — protect the next single-file link or current batch link
- `/clearpassword` — clear a pending password
- `/premium` — purchase the configured premium plan using Telegram Stars
- `/post` — create a thumbnail/title/video post and publish it to a configured channel as free or Stars-paid
- `/auto` — create a post from a single media group containing one thumbnail photo and one or more videos; put the title in the album caption
- `/channels` — add or remove channels where the bot can publish posts

## Channel posts and paid video access

Admins can use `/post` for the guided thumbnail/title/video flow, or `/auto` to send one Telegram media group containing exactly one thumbnail photo and one or more videos. Add the post title as the album caption (preferably on the thumbnail). The bot saves the videos and then asks for Free or Paid and the destination channel. Paid posts ask for a Telegram Stars amount (for example, `5`). The bot stores every video in the private storage channel and publishes one thumbnail/title post with a single button linking to the bot. Opening the link delivers all videos in that post; for paid posts, users pay once to unlock the complete set. Successful payments are recorded and access is granted per user. Use `/channels` to manage the channels available in the posting menu. The bot must be an administrator in every configured posting channel and in `DB_CHANNEL_ID`.

## Owner commands

- `/stats` — usage and payment statistics
- `/ban USER_ID` and `/unban USER_ID`
- `/broadcast MESSAGE`
- `/autodelete SECONDS` — configure expiry for new uploads; `0` disables expiry for new uploads

Auto-delete removes expired file messages from the storage channel and deletes their metadata. Existing expiry timestamps are not changed when the setting changes.

## Link security

- Deep-link tokens use cryptographic randomness; only SHA-256 token hashes are stored.
- Passwords are salted and hashed using scrypt; plain passwords are not saved.
- Password entry expires after 10 minutes and is limited to five attempts per link-opening session.
- Telegram Stars payment charge IDs are unique-indexed to prevent duplicate payment processing.

## Optional shortener verification

Set both `SHORTENER_URL_TEMPLATE` and `SHORTENER_CALLBACK_SECRET` to enable the gate. The HTTPS template must contain `{url}` (encoded destination) and `{click_id}` (unique session ID), for example:

```text
https://shortener.example/...?url={url}&click_id={click_id}
```

The provider must support a **server-to-server signed callback** to:

```text
GET https://YOUR_HOST/shortener/callback?session=CLICK_ID&signature=HMAC_SHA256
```

The signature must be HMAC-SHA256 using `SHORTENER_CALLBACK_SECRET` over the exact string `<session>:completed`. A valid, unexpired session can be credited only once. Successful verification lasts six hours. The bot intentionally does not treat a user clicking “I completed” as proof.

**Important:** a URL-shortening API that only creates links is not sufficient for completion verification. Confirm that your chosen provider can send the required signed postback, or implement its documented signature format in a provider-specific adapter. Do not enable the gate until the provider callback is configured and tested.

## Telegram Stars

By default, `STARS_PRICE=100` and `STARS_DAYS=30`. Change these environment variables to adjust the plan. Test purchases in a suitable Telegram test environment before launch. The current premium benefit is bypassing configured shortener verification.

## Deployment

Use a persistent Node.js service on Render, Koyeb, Voroa, or another compatible host:

- Install/build: `npm install`
- Start: `npm start`
- Health check: `/health`

Configure every required variable from `.env.example` in the host dashboard. Never commit `.env`, bot tokens, MongoDB credentials, or shortener secrets.

## Current limitations

- Single bot only; no clone-bot or multi-bot manager.
- Shortener verification requires a provider that supports the documented signed callback contract; it is not automatically compatible with every shortener.
- Auto-delete is checked approximately every minute, so deletion is not instantaneous.
- Premium currently only bypasses configured shortener verification; it does not yet provide additional download limits or an admin dashboard.
