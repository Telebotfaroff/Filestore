# FileStore — Telegram FileStore Bot Platform & Web Control Panel

A full-stack **Node.js (v22+) + PostgreSQL** Telegram FileStore platform featuring a Main Bot, multi-worker Delivery Bots (including creator-owned cloned bots), Paid Links & Batches, Creator VIP Plans, Wallets & UPI Payouts, Configurable Platform Fees, Referrals, Broadcasts, URL Shorteners, Force-Sub Gates, and a Web Control Panel.

---

## Runtime Requirements

- **Node.js**: `>= 22.0.0`
- **Database**: PostgreSQL (migrations run automatically on startup)
- **Process Type**: **Always-on long-running Node.js service** (required for Telegram bot polling and background workers)
- **Single Instance Rule**: Run **only 1 instance** per bot token. Running two copies with the same `MAIN_BOT_TOKEN` or `DELIVERY_BOT_TOKEN` causes Telegram `409 Conflict` errors.

> **Do not use serverless-only hosts** (Vercel, Netlify, Cloudflare Pages). They shut down idle functions and cannot keep Telegram polling bots or background workers running 24/7.

---

## Where to Host for Free

Because FileStore needs both an **always-on Node.js server** and a **PostgreSQL database**, the best free approach is to pair a **free Node.js host** with a **free managed PostgreSQL database** (or run both on an Always Free Linux VM).

### 1. Best Free App Hosts (Node.js + Web Control Panel)

| Provider | Free Tier Specs | Sleeps? | Credit Card? | Best For |
| --- | --- | --- | --- | --- |
| **Oracle Cloud Always Free** | Up to 4 ARM OCPUs + 24 GB RAM (or 2 AMD Micro VMs) | **Never** (24/7) | Yes (verification only) | Best true 24/7 production setup with zero limits |
| **Koyeb (Free Hobby)** | 1 Web Service, 512 MB RAM, 0.1 vCPU, HTTPS included | Minimal / Always-on with health checks | Yes (verification) | Easiest GitHub push-to-deploy PaaS |
| **Render (Free Web Service)** | 512 MB RAM, 0.1 vCPU, auto HTTPS from GitHub | Spins down after 15 min of no HTTP traffic* | No | Fastest no-card setup for testing & small bots |
| **Google Cloud Always Free (`e2-micro`)** | 1 `e2-micro` VM (us-west1 / us-central1 / us-east1), 30 GB disk | **Never** (24/7) | Yes (verification only) | Reliable always-on small VPS |

*\*Tip for Render Free: Set up a free HTTP monitor (such as [UptimeRobot](https://uptimerobot.com/) or [cron-job.org](https://cron-job.org/)) to ping `https://<your-app-url>/health` every 5–10 minutes to reduce idle spin-downs. Keep in mind Render Free has a monthly free-hours cap (750 hours/month — enough for 1 service 24/7).*

### 2. Best Free PostgreSQL Databases

Use an external free PostgreSQL database instead of ephemeral container storage (and avoid Render's free PostgreSQL, which expires after 30 days):

| Provider | Free Tier Storage | Expires? | Notes |
| --- | --- | --- | --- |
| **[Neon](https://neon.tech/)** | 0.5 GB PostgreSQL | Never | Best pairing with Koyeb/Render; instant SSL `DATABASE_URL` |
| **[Supabase](https://supabase.com/)** | 500 MB PostgreSQL | Never (pauses only after 7 days of zero activity) | Stays awake automatically while your bot is online; use the **Direct** or **Session Pooler** URI |
| **[Aiven](https://aiven.io/)** | 1 GB PostgreSQL | Never | Dedicated always-on free PostgreSQL service |

---

## Environment Variables

Copy `.env.example` to `.env` for local development, or add these variables in your hosting provider's dashboard:

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `MAIN_BOT_TOKEN` | **Yes** | — | Main Bot token from `@BotFather` |
| `DATABASE_URL` | **Yes** | — | PostgreSQL connection string (`postgresql://user:pass@host:5432/db?sslmode=require`) |
| `ADMIN_IDS` | **Yes** | — | Comma-separated numeric Telegram User IDs of platform owners (e.g. `123456789`) |
| `DELIVERY_BOT_TOKEN` | Optional | `""` | Default Delivery Bot token from `@BotFather` (additional delivery bots can be added from the panel) |
| `TOKEN_ENCRYPTION_KEY` | Recommended | Auto-generated in DB | 64-character hex string (32 bytes) used to encrypt stored delivery bot tokens. Generate with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `FILESTORE_PORT` | Optional | `3000` | HTTP port for the Web Control Panel & `/health` endpoint. **Set this to match your host's exposed port** (e.g. `8000` on Koyeb or `10000` on Render) |
| `APP_URL` | Optional | `""` | Public HTTPS URL of your Web Control Panel (e.g. `https://your-app.koyeb.app`) |
| `NODE_ENV` | Optional | `development` | Set to `production` when deployed |
| `LOG_LEVEL` | Optional | `info` | `fatal`, `error`, `warn`, `info`, `debug`, `trace`, or `silent` |

---

## Quick Deployment Guides

### Option A: Free PaaS — Koyeb or Render + Neon PostgreSQL (Recommended for Beginners)

1. **Create a Free PostgreSQL Database on [Neon](https://neon.tech/)**:
   - Create a new project and copy the PostgreSQL connection string (`postgresql://...?sslmode=require`).
2. **Push this repository to GitHub** (private or public).
3. **Create a Web Service on Koyeb or Render**:
   - Connect your GitHub repository.
   - **Runtime**: Node.js `22` (detected automatically via `package.json` `engines.node`).
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Instance Count**: `1` (do not enable horizontal autoscaling).
   - **Health Check Path**: `/health`
4. **Configure Environment Variables** in the host dashboard:
   - `NODE_ENV=production`
   - `MAIN_BOT_TOKEN=<your_main_bot_token>`
   - `DELIVERY_BOT_TOKEN=<your_delivery_bot_token>`
   - `ADMIN_IDS=<your_telegram_numeric_id>`
   - `DATABASE_URL=<your_neon_postgresql_url>`
   - `TOKEN_ENCRYPTION_KEY=<64_char_hex_key>`
   - `FILESTORE_PORT=8000` (on Koyeb) or `FILESTORE_PORT=10000` (on Render) — match the port configured in your host's service settings.
   - `APP_URL=https://<your-deployed-domain>`
5. **Deploy & Verify**:
   - Database migrations run automatically on first startup.
   - Visit `https://<your-deployed-domain>/health` and verify:
     ```json
     {
       "status": "ok",
       "database": "connected",
       "telegram": "connected",
       "delivery": "connected"
     }
     ```
   - Open `https://<your-deployed-domain>` in your browser and sign in with `/token` from your Main Bot.

---

### Option B: True 24/7 Free VPS — Oracle Cloud Always Free / Google Cloud `e2-micro`

1. **Provision an Ubuntu 22.04 / 24.04 VM** and open ports `80` and `443` in the firewall/security list.
2. **Install Node.js 22 & PM2**:
   ```bash
   curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
   sudo apt-get install -y nodejs git
   sudo npm install -g pm2
   ```
3. **Clone & Configure the App**:
   ```bash
   git clone <your-repo-url> filestore
   cd filestore
   npm install --omit=dev
   cp .env.example .env
   nano .env
   ```
   Fill in `MAIN_BOT_TOKEN`, `DELIVERY_BOT_TOKEN`, `ADMIN_IDS`, `DATABASE_URL` (either a local PostgreSQL instance or free Neon DB), `TOKEN_ENCRYPTION_KEY`, `NODE_ENV=production`, and `FILESTORE_PORT=3000`.
4. **Start 24/7 with PM2**:
   ```bash
   pm2 start src/index.js --name filestore
   pm2 save
   pm2 startup
   ```
5. **Add Free Automatic HTTPS with Caddy** (optional, for the Web Control Panel):
   ```bash
   sudo apt install -y caddy
   ```
   In `/etc/caddy/Caddyfile`:
   ```caddy
   yourdomain.com {
       reverse_proxy 127.0.0.1:3000
   }
   ```
   Then reload Caddy (`sudo systemctl reload caddy`).

---

## Local Development

```bash
# 1. Install dependencies
npm install

# 2. Configure environment variables
cp .env.example .env

# 3. Run in development mode (auto-runs DB migrations on startup)
npm run dev
```

### Useful Scripts

| Command | Description |
| --- | --- |
| `npm start` | Start the production server, Telegram bots, and background workers |
| `npm run dev` | Start with Node `--watch` auto-reload |
| `npm run migrate` | Manually run pending PostgreSQL migrations |
| `npm test` | Run the full automated test suite |
| `npm run check` | Validate JavaScript syntax across `src/` |

---

## Health Check & Troubleshooting

- **Health Endpoint**: `GET /health` returns live connection status for PostgreSQL, the Main Bot, and Delivery Bots.
- **`409 Conflict` from Telegram**: Another instance is still polling with the same bot token. Stop any local dev session or old deployment before starting the new host.
- **Database falls back to `mocked`**: Check that `DATABASE_URL` includes `?sslmode=require` (required by Neon, Supabase, and Aiven) and that the database is reachable from your host.
- **Web Panel port mismatch on PaaS**: Make sure `FILESTORE_PORT` matches the HTTP port expected by your hosting platform (for example `8000` on Koyeb or `10000` on Render).
