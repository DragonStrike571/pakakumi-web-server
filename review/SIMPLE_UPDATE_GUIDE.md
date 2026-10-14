# Your update steps

**For the three latest updates together, use [COMBINED_UPDATE_STEPS.md](COMBINED_UPDATE_STEPS.md).** Keep this guide's Supabase usage/log instructions as supporting information; its deployment section describes an earlier checkpoint.

This guide uses the commands you already use. The changes must first be committed and pushed to your Git repository; `git pull` cannot download changes that exist only on this computer.

## Update the server

Use the same VPS terminal where you normally run PM2. Paste **one line at a time**, then press Enter. If a command reports an error, stop there and paste that error into this chat.

1. Open the server folder:

   ```bash
   cd /var/www/pakakumi-web-server
   ```

2. Download the changes:

   ```bash
   git pull
   ```

3. Open your existing settings:

   ```bash
   nano .env
   ```

   Find `TRUST_PROXY_ADDRESSES`. Change its value to `loopback`. If that setting is missing, add this line at the bottom:

   ```text
   TRUST_PROXY_ADDRESSES=loopback
   ```

   For the new Pakakumi crash-page layout, also find `PAKAKUMI_URL` and set it to:

   ```text
   PAKAKUMI_URL=https://pakakumi.com/crash
   ```

   If the line is missing, add it at the bottom. The collector fix itself requires no new database migration. The subsequent page-integration follow-up also changes frontend analysis labels and both local players; see `review/PAGE_UPDATE_STEPS.md`.

   Keep your database URL, passwords, tokens and existing `COLLECTION_DATA_DIR` value. If you still have `TRUST_PROXY_HOPS=0`, the new line above takes precedence; you do not need to work out what that older setting means.

   Save: **Ctrl + O**, then **Enter**. Exit: **Ctrl + X**.

4. Install the versions specified by the updated project:

   ```bash
   npm ci
   ```

   Ensure the scraper's browser matches the installed package version:

   ```bash
   npx playwright install chromium
   ```

5. Build:

   ```bash
   npm run build
   ```

6. The earlier reliability fixes added database migrations `0007` and `0008`. If they are already installed, the migration command safely skips them. Keep a current database backup before applying them. Run:

   ```bash
   npm run db:migrate
   ```

   This bandwidth update adds no further migrations. If this command says the database is **untracked**, stop and paste the message here. Do not try `db:push` or delete any tables.

7. Show your PM2 programs:

   ```bash
   pm2 list
   ```

   Your latest logs call the server `pakakumi-server`. If that is its name in the list, restart it:

   ```bash
   pm2 restart pakakumi-server --update-env --kill-timeout 20000
   ```

   If the list instead shows `pakakumi`, use:

   ```bash
   pm2 restart pakakumi --update-env --kill-timeout 20000
   ```

   Use the **one line matching the name in your list**. `--update-env` loads the edited settings; `--kill-timeout 20000` allows 20 seconds for the old process to save and stop. Restarting an existing program also starts it if it was stopped; you do not need a separate `pm2 start all`.

8. Check its messages (substitute `pakakumi` if that was the name):

   ```bash
   pm2 logs pakakumi-server --lines 30
   ```

   Look for `Scraper started and listening for rounds` and new `Saved round` messages when Pakakumi is operating. The old `locator('table.css-1a87jyo tbody')` timeout should no longer appear after deploying this fix. `[GAP]` and null financial values can appear with the new, incomplete player display; the captured multipliers are still saved. If Pakakumi is under maintenance, `Collection will retry` is expected. The web process should remain online. **Ctrl + C** exits the log view; it does not stop the server.

Your existing PM2 entry must launch `dist/src/index.js` or the project's normal `npm start`. If it launches another file, paste the entry details before changing it. Keep one collector instance.

## Update the frontend

Deploy the server first. Publish the frontend using your existing hosting workflow; this update adds no new frontend environment settings.

If you normally update it in a terminal, open its actual project folder with your usual `cd` command, then run `git pull`, `npm ci`, and `npm run build`, one line at a time. Keep the real `NEXT_PUBLIC_API_URL` and `NEXT_PUBLIC_WS_URL` values already used by your deployment. Restart only its existing PM2 program if the frontend is hosted through PM2. For a Git-connected frontend host, use that host's normal deployment instead.

## Check the free allowance without a terminal

1. Open [Supabase](https://supabase.com/dashboard) in your browser.
2. Open your organization, then **Usage**. Select this project and the current billing cycle.
3. Check **Database Size**, **Total Egress** and **Cached Egress**. Supabase's database queries use the uncached allowance; the separate cached allowance cannot be added to it.
4. You reported **3% of egress used** (about **150 MB**, leaving **4.85 GB** this cycle) and **6% of database space used** (about **30 MB**, leaving **470 MB**). Both are currently below the Free limits. A read-only check of the configured Supabase cluster measured about **29 MB**, matching your storage reading approximately. Neither reading predicts next month's use.
5. To see what uses storage: open your project, choose **SQL Editor**, create a new query, paste the contents of `review/SUPABASE_USAGE.sql`, then click **Run**. This only reads usage information. Share its results here if you want the storage headroom calculated.

Supabase currently includes [500 MB of database space](https://supabase.com/docs/guides/platform/database-size) per Free project and [5 GB of uncached egress plus a separate 5 GB cached allowance](https://supabase.com/docs/guides/platform/manage-your-usage/egress) per organization/billing cycle. The 1 GB allowance for uploaded Storage files is separate from PostgreSQL database space. PostgreSQL tables and indexes both consume database space.

Raw rounds are retained indefinitely because they are your collected dataset. At a steady capture rate, that storage grows. Your database was recently cleared, so today's 6% includes starting/allocated space; it does not by itself prove a 6% daily increase. For example, an **illustrative** 1 MB/day increase adds about 30 MB/month. Compare normal days to find the actual increase. When space becomes tight, agree an archive plan before moving or deleting anything. This update does not delete collected rounds, payments or user records.

Optional comparison: record Database Size and this cycle's egress now, then compare after a few normal days. In Supabase's egress breakdown, also check **Shared Pooler Egress** if your connection uses the pooler. Usage already consumed is not refunded by deploying an optimization.

## Check log ingestion using the browser

Your stated **30 MB/day** would total about **900 MB in 30 days**, or **930 MB in 31 days**, against the **1 GB** allowance. It is close enough that busy days could exceed it.

The database settings checked here already avoid logging every connection and every ordinary query. Changing PM2's displayed messages would not reduce Supabase's own ingestion. Your supplied PgBouncer messages show successful internal Supabase connections: the local `pgbouncer` account and the Storage service account. They do not show scraper failures.

1. Open your Supabase project.
2. Open **Logs** (or **Logs Explorer**).
3. Select a short time range, such as **the last hour**.
4. Use the **Log Type** filter to inspect **Postgres**, **API gateway**, **Auth**, and **Realtime**. Look for the same message repeating often.
5. Your sample shows PgBouncer has the most entries: **358**, compared with **130 PostgREST** and **49 Postgres**. Entry counts alone do not show which type uses the most bytes. Save that sample and the messages you supplied for the support request below.

You do not need to change PostgreSQL logging settings: the common noisy ones are already off. PgBouncer has its own settings, managed by Supabase. Open Supabase's **Help/Support** page and paste the text from `review/SUPABASE_LOG_SUPPORT.md`; select this project and attach your example rows if requested. It asks them to reduce the successful internal connection messages while preserving errors. This request has not been sent for you.

For a Supabase project used **only by this Pakakumi setup**, you can also disable its unused Data API in the browser:

1. Open the project → **Integrations → Data API → Settings**. Older dashboard layouts put it under **Project Settings → API**.
2. Find **Enable Data API** and switch it **off**, then save/confirm the displayed change.
3. Open Pakakumi, sign in, and check saved history and fresh rounds. These apps use their own Express API and PostgreSQL connection, so the inspected code does not need Supabase's generated REST API. If another app shares this project and uses Supabase REST/SDK calls, leave the setting on.
4. You can switch the same setting back **on** to reverse it. Keep the database URL and PM2 settings unchanged.

[Supabase documents this toggle](https://supabase.com/blog/hardening-supabase). Its impact on your internal logs is unknown until usage is compared; it will not necessarily stop Storage service or local monitoring connections. No remote settings were changed during this audit.

The [official quota page](https://supabase.com/docs/guides/platform/manage-your-usage/logs-ingest) lists the 1 GB allowance and currently says billing has a grace period through the start of 2027. Viewing a smaller time range avoids scanning unnecessary logs under the separate Logs Query allowance. Compare the daily ingest rate after deploying the code and any provider-supported changes before assuming the allowance is protected.
