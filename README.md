# Filestore — Node.js + Telegraf + MongoDB Atlas

A Telegram file-store bot that saves incoming Telegram messages to a private storage channel and creates permanent deep links for retrieving them.

## Included in the initial implementation

- Node.js 20+, ES modules, Telegraf 4
- MongoDB Atlas for users, file metadata, batch links, bans, and settings
- Private Telegram storage channel for the actual media
- Permanent single-file links and multi-file batch links
- Force-subscription gate (optional)
- Owner commands for stats, user bans, and broadcast
- Health endpoint for Render/Koyeb/Voroa-style persistent web services
- No Redis, no local file storage, and no database secrets committed to Git

## 1. Create Telegram resources

1. Create a bot with [@BotFather](https://t.me/BotFather) and copy its token.
2. Create a **private Telegram channel** for file storage.
3. Add the bot as an administrator of that channel with permission to post messages.
4. Get the channel ID (usually starts with `-100`).
5. Get your numeric Telegram user ID for `OWNER_ID`.

## 2. Configure MongoDB Atlas

1. Create a free/appropriate cluster at [MongoDB Atlas](https://www.mongodb.com/atlas).
2. Create a database user and allow network access from your hosting provider. Avoid using `0.0.0.0/0` unless you understand the exposure.
3. Copy the driver connection string and set `MONGODB_URI`.
4. Keep credentials in hosting environment variables, never in Git.

## 3. Run locally

```bash
npm install
cp .env.example .env
# Fill in .env
npm start
```

On Android, edit files in your preferred IDE and deploy from GitHub; the bot itself should run as a persistent cloud worker.

## Commands

- `/start` — start the bot or retrieve a file/batch from a deep link
- `/help` — show user commands
- `/batch` — begin creating a batch link; send/forward messages, then use `/done`
- `/cancel` — cancel batch creation
- `/stats` — owner-only usage statistics
- `/ban USER_ID` — owner-only ban
- `/unban USER_ID` — owner-only unban
- `/broadcast MESSAGE` — owner-only text broadcast

## Link format

- Single item: `https://t.me/<bot_username>?start=F_<random_token>`
- Batch: `https://t.me/<bot_username>?start=B_<random_token>`

Tokens are generated with cryptographic randomness. The database stores a SHA-256 hash of each token rather than the raw token.

## Deployment

Deploy as a **persistent Node.js web service/worker**. Set the environment variables from `.env.example`, use `npm install` for build/install and `npm start` for start command. The Express health endpoint responds at `/health`.

## Important notes

- The bot must be an admin in the storage channel.
- A bot can only retrieve messages it can access. Keep the storage channel private and don't delete stored posts while their links are active.
- This is the first implementation milestone. Shortener-provider verification, Telegram Stars, password-protected links, clone-bot management, richer admin settings, and scheduled deletion should be added as separate tested modules rather than represented as complete before they work.
