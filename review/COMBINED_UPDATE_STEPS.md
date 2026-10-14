# Deploy the three latest updates together

Use this guide for the scraper layout fix, the page/rules update and the other-project reliability review. It replaces the separate deployment instructions for those updates. The fixes are currently on this computer; they have not been deployed. The Git projects must be committed and pushed before your VPS can download them with `git pull`.

Paste each command separately and press **Enter**. If a command reports an error, stop at that command and keep the message. Do not continue with a failed build.

## 0. Upload the updated Git projects from this computer

If these changes have already been committed and pushed, skip this section. Otherwise, open your terminal **on this Windows computer**, and run these separately for the server:

```powershell
cd C:\Truth\Pakakumi\pakakumi-web-server
```

```text
git add .env.example README.md src review
```

```text
git commit -m "Update Pakakumi page integration and session reliability"
```

```text
git push
```

Then upload the frontend changes:

```powershell
cd C:\Truth\Pakakumi\pakakumi-web-client
```

```text
git add README.md app/analysis/page.tsx hooks/use-websocket.tsx review
```

```text
git commit -m "Bound live stream memory and clarify analysis assumptions"
```

```text
git push
```

These projects already track their Git remotes. The commands select source and review files; they do not select your real `.env` or `.env.local`. If Git reports a login, identity or push error, keep that message and stop. Do not use a force push. The two local-player folders are updated separately in section 4.

## 1. Stop the players

If a player is running, use its dashboard's **Stop** button first. Check its last bet on Pakakumi if there was an interrupted or uncertain result. The collector will resume automatically after outages; the players stop for review when exposure is uncertain.

If you normally run a player with `npm start`, **Ctrl + C** in that player's terminal stops it. If you normally run it through PM2, run `pm2 list`, then `pm2 stop` followed by that player's existing name. Keep one database-connected local worker. Use separate sessions/accounts only as allowed by the provider; running both player projects against the same account can interfere with results.

## 2. Update the web-server on the VPS

Open the same VPS terminal you normally use.

```bash
cd /var/www/pakakumi-web-server
```

```bash
git pull
```

```bash
nano .env
```

Find these settings and replace their values with the following. Add a setting at the bottom if it is missing:

```text
PAKAKUMI_URL=https://pakakumi.com/crash
TRUST_PROXY_ADDRESSES=loopback
```

`loopback` matches your Nginx-on-the-same-VPS setup. Keep your other settings, especially `DATABASE_URL`, `ENCRYPTION_KEY`, Telegram tokens and `COLLECTION_DATA_DIR`. Keep the same collection-data folder so saved checkpoints and pending rounds survive the restart.

Save with **Ctrl + O**, press **Enter**, then exit with **Ctrl + X**.

```bash
npm ci
```

```bash
npm run build
```

These three updates add no database migrations. If the earlier reliability release's migrations `0007` and `0008` have not yet been deployed, keep your current database backup and also run the following before restarting. Already applied migrations are skipped:

```bash
npm run db:migrate
```

If it reports an **untracked** database, stop there. Do not use `db:push`, delete tables or reset the database.

Show the existing programs:

```bash
pm2 list
```

Your supplied logs use both `pakakumi` and `pakakumi-server`. Use the **one existing server name shown in your list**. For `pakakumi`:

```bash
pm2 restart pakakumi --update-env --kill-timeout 20000
```

```bash
pm2 logs pakakumi --lines 30
```

For `pakakumi-server`, replace `pakakumi` in those two commands. Restart only the server's existing entry; you do not need `pm2 start all` or a second collector. **Ctrl + C** leaves the log display while the server keeps running.

When Pakakumi is operating, look for **Scraper started and listening for rounds** and fresh **Saved round** messages. During maintenance, **Collection will retry** is expected and the web process should stay online. The old `table.css-1a87jyo tbody` timeout should disappear. Financial values may remain `null` / `[GAP]` because the new source page shows an incomplete player list; multipliers are still collected. The visible online/playing counters can be saved for newly observed rounds.

If startup specifically reports a **missing browser executable**, run the following in the server folder, then repeat its restart command:

```bash
npx playwright install chromium
```

## 3. Update the frontend

Use the frontend's normal hosting process after the server update. No new frontend environment settings are needed. Keep its real HTTPS API URL and WSS WebSocket URL.

If you normally use a terminal, use your usual `cd` command to open the frontend's actual folder, then run these separately:

```bash
git pull
```

```bash
npm ci
```

```bash
npm run build
```

If PM2 hosts it, restart its existing frontend program name shown by `pm2 list`. If your hosting service deploys from Git, use that service's normal deployment button/process. Its hosting location and program name have not been confirmed here, so there is no guessed restart command.

Open the dashboard and History page. Check that fresh rounds appear, pause/resume works, and refreshing the page restores saved data. Analysis now labels the house-edge assumption and model thresholds more clearly.

## 4. Update the player you use

On this computer, both player folders already contain the updates. They currently have **no Git repository**. If you run one elsewhere, transfer that project's updated `src` folder, `package.json`, `package-lock.json` and, for the fully local player, `public` folder. Keep the destination's existing `.env`; do not replace it with example settings.

For the database-connected local bot, open its folder:

```powershell
cd C:\Truth\Pakakumi\pakakumi-local-bot
```

```text
npm ci
```

```text
npm run check
```

If you normally run it directly:

```text
npm start
```

If you normally use PM2 for it, restart that existing worker instead. Do not also run `npm start` beside it. Four simultaneous sessions is the default limit; queued requests wait for capacity and expire after five minutes. Worker pickup can take about **30 seconds when idle**. Stop/access checks occur at most about every **10 seconds**, with another authorization check before submitting a bet. Network delays can extend those times.

The worker's ownership lock now needs a persistent PostgreSQL connection. If `DATABASE_URL` is Supabase's shared transaction-pooler URL on port `6543`, the worker automatically uses that same host on port `5432` for its lock; ordinary queries keep the existing URL. Normally you need to change nothing. Supabase documents [Session and Transaction connection options](https://supabase.com/docs/guides/database/connecting-to-postgres).

If startup reports that the lock connection cannot reach port `5432`, open Supabase → your project → **Connect** → **Session pooler**. In the local bot's existing `.env`, add `WORKER_DATABASE_URL=` followed by that project's complete Session-pooler connection string, including your password. Use port `5432`. Keep it private, save the file and restart the existing worker. Do not change the web-server's database URL. On the VPS use `nano .env`; on Windows use your usual text editor. A transaction-pooler URL cannot safely hold this lock: [PgBouncer's compatibility table](https://www.pgbouncer.org/features.html) excludes session advisory locks in Transaction mode.

For the **fully local player**, use this folder instead:

```powershell
cd C:\Truth\Pakakumi\pakakumi-fully-local-player
```

Run `npm ci`, `npm run check`, then your usual `npm start`. Open [the local dashboard](http://127.0.0.1:8787). It needs no Supabase settings. Accounts are held in memory, so re-add them after restarting the app. The page identifies the running account and shows errors from failed actions. When hidden, it pauses polling.

If either player reports that acceptance or settlement could not be confirmed, check the last bet on Pakakumi before restarting. Do not treat the round's final multiplier as proof that your requested cashout was paid.

## 5. Check the free allowances in Supabase

Open your organization → **Usage** → this project and the current billing cycle. Compare Database Size, Total Egress and Log Ingestion over several normal days after deployment.

The changes reduce worker queue polling, batch status/heartbeat checks, limit stored session logs to the newest 100 entries and cap browser sessions. They do not add per-round balance requests or another Supabase service. The lock holds one persistent connection alongside a pool of at most two query connections.

Collected raw rounds still accumulate over time. The supplied PgBouncer samples were mostly internal Supabase connections; reducing application traffic cannot guarantee a reduction in those provider-generated logs. Your reported 30 MB/day is about 900–930 MB/month against your stated 1 GB allowance. Keep comparing usage; an archive/retention decision will eventually be needed for a permanently growing dataset. No collected data was deleted by these fixes.
