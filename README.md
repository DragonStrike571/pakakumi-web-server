# Pakakumi Web Server

Express API, Better Auth, PostgreSQL/Drizzle persistence, round scraper, analytics, Telegram and Paystack services, and authenticated WebSockets.

Copy `.env.example` to `.env`, install packages and Chromium, then migrate before starting:

```text
npm install
npx playwright install chromium
npm run db:migrate
npm run dev
```

Verification: `npm run build`, `npm test`, `npm run db:check`, `npm run db:inspect`, and `npm audit`.

Production must use exact HTTPS origins in `CORS_ORIGINS`. Optional Telegram and Paystack services remain disabled when their secrets are absent. The server creates bot jobs but does not execute bets; run `pakakumi-local-bot` on the authorized local network.

WebSocket connections require an allowed `Origin` and an authenticated admin or active/premium account. Missing origins or unauthorized accounts receive HTTP 401, disallowed origins receive 403, and authentication service failures receive 503 without shutting down the collector. `npm test` includes WebSocket handshake regression tests.

Captured rounds enter a disk-backed inbox before the scraper advances its checkpoint. Database and analysis failures retry with the same ingestion UUID; committed analysis checkpoints prevent a replay from counting a round twice. Set `COLLECTION_DATA_DIR` to a persistent, writable directory outside release folders (for example `/var/lib/pakakumi`). Keep this directory across deployments. Run one collector instance with this inbox. The queue stops accepting captures at 10,000 pending rounds and reports degraded health instead of silently discarding data. On restart, the scraper recovers newer visible history chronologically from its durable checkpoint or latest database round. History outside the provider's visible window cannot be reconstructed; missing continuity is marked explicitly and incomplete financial values stay null. Analysis updates, statistics and its checkpoint commit together; dirty caches and pending tasks are drained during shutdown with a global 15-second deadline.

WebSocket sessions are checked against current authorization before every update and heartbeat, and sockets close at session expiry. Send failures affect the individual socket. `/health` returns HTTP 503 while collection is recovering or capture/save failures are outstanding. The process-wide unhandled rejection/exception handlers still restart the server when an unexpected error escapes those boundaries; the preceding error and stack trace identify that failure.

Telegram command errors are handled by `bot.catch` without rerunning the command through the session database fallback. Analyzer identity lookup is safe while the bot initializes. Message queue and expiry timer callbacks contain rejected promises, and the queue resumes after an escaped worker failure. Telegram polling retries ordinary connection failures internally; a rejected `bot.start()` is logged separately and does not stop the scraper. Invalid tokens or another polling instance must be corrected in the deployment.

Payments extend the user's locked entitlement row, including verified success after a local timeout. Polling reconciles recent pending/expired/failed orders for seven days; an explicitly verified callback can fulfill an older order. Invite and expiry notifications use a database outbox with retries. `/status` queues a fresh invite for active subscribers. Notification delivery is at least once: a crash after Telegram accepted a message but before the database acknowledgement can repeat that message. Expiry processing paginates all users, rechecks under the same lock used by renewal, preserves admins, and records completed removals. Database sessions use UTC so scheduled jobs work regardless of the server's local timezone.

Backtests run in at most two worker threads, with eight waiting jobs and a 20-second deadline. Balance checks share a browser with four contexts, at most ten waiting requests, and close cancelled/timed-out contexts.

`npm run db:migrate` bootstraps an empty database and applies additive migrations to tracked installations. Historical migration files stay unchanged; the runner repairs the serial-to-UUID and UUID-to-text execution steps for older tracked schemas while preserving their journal hashes and foreign keys. An existing untracked schema is refused; inspect it and run the existing `db:baseline -- --dry-run` workflow before establishing a baseline. This patch adds migrations `0007` and `0008`, which must be applied before restarting the updated app. `npm run db:audit-access` provides a read-only list of existing privileged/access-enabled accounts to verify against trusted records: closing client-writable fields does not establish whether old grants were legitimate.

When running behind a reverse proxy that sets `X-Forwarded-For`, set `TRUST_PROXY_HOPS` to the exact number of trusted proxy hops (`1` for a single Nginx proxy). Leave it `0` for direct connections. This resolves `ERR_ERL_UNEXPECTED_X_FORWARDED_FOR` and lets rate limits identify clients correctly.

For deployment, back up the database, stop the old collector gracefully (PM2 `kill_timeout` should exceed 15 seconds), deploy the source and lockfile, run `npm ci`, `npm run db:migrate`, `npm run build`, and `npm run db:audit-access`, then restart the PM2 process with `pm2 restart pakakumi-server --update-env` (substitute the actual process name from `pm2 list`). Confirm `/health` returns 200 and rounds resume. PM2 must run the updated source or `dist/src/index.js`; rebuilding is necessary when it runs `dist`.
