# Storage and bandwidth review

13 October 2026. Supabase PostgreSQL Free plan; same-VPS Nginx; frontend and server changes are local and have not been deployed. Read-only size/log-settings queries were run against the workspace's configured Supabase connection. No application records or schema were changed. The user reports 3% of 5 GB uncached egress used, no cached egress, 6% of 500 MB database space used after recently clearing data, and approximately 30 MB/day of Supabase Logs Ingest against a 1 GB allowance. Billing-cycle time remaining is unknown.

## Findings and changes

| Area | Result |
| --- | --- |
| Original engine optimizations | Round cache remains bounded at approximately 10,000–11,000 entries; only ID/bust/time are loaded. Pending signals/system/daily statistics use memory caches. Analysis snapshots still overwrite one row every five rounds. Resolved signal history older than 30 days is pruned every 500 rounds. |
| Daily statistics reliability regression | The earlier transaction wrapper flushed every round, bypassing the old ten-round batching and repeatedly sending the complete target array. Daily counters now remain durable with the checkpoint, but SQL sends only appended/resolved/trimmed target deltas. The existing recent-target limit of 50 is also applied on prediction insertion. Rollback restores the persisted-target baseline together with other caches. |
| Normal round saves | Removed the existence SELECT before each INSERT. `ON CONFLICT(id) DO NOTHING` retains retry safety; only actual retries fetch the existing row. INSERT returns ID and database-generated updated time, and the complete broadcast record is reconstructed from the saved input. This cuts Supabase response data without changing the frontend contract. |
| WebSocket authorization | Cookies are verified once per socket. Every update and heartbeat still queries current session/access, selecting only expiry, role and access status, with matching verified session ID/token/user ID. Expiry, logout, suspension and token rotation still revoke the socket; no authorization TTL cache was added. |
| Bot status | Database SELECT includes only fields shown in the response. Stored logs and encrypted credentials no longer travel from Supabase to the server on this polling endpoint. Active sessions retain five-second polling; an idle bot page polls every 30 seconds. |
| Frontend REST reconciliation | Removed healthy-stream minute polls and the duplicate mount/open seed. The initial snapshot loads on socket open; a three-second fallback handles a failed initial connection. Visible disconnected tabs poll every minute. Reconnection loads the latest saved rounds, total and analysis. |
| Background tabs | Visibility changes close the consumer socket, abort snapshot requests and stop REST polling. Returning to the tab reconnects and reconciles saved data. A manually paused stream stays paused until resumed. |
| Collection health | Shared SWR key uses a 15-second deduplication window and explicitly avoids hidden/offline polling. `/health` itself uses in-memory scraper/inbox state. |
| Gap analysis/backtests | Existing single aggregated gap query/cache/concurrency cap and bounded worker responses remain. Gap charts still refresh at their existing interval while visible. Backtests fetch needed round columns; CPU-heavy browser tools run locally. |
| Storage retention | Raw rounds remain indefinitely. Daily history, payment records, completed bot sessions, opportunities and Telegram delivery records accumulate. The inbox is bounded at 10,000 pending captures and lives on VPS disk, not in Supabase Storage. No new DB tables/indexes or migrations were added by this follow-up. |

## What the measurements establish

The regression fixture changes one outcome and appends two targets while keeping the latest 50 entries. The old array is **4,093 bytes**, versus **303 bytes of SQL parameters** and **99 bytes of SQL expression** for the delta. This is a representative parameter-payload saving, not a production usage measurement. Sending smaller writes reduces VPS outbound traffic; Supabase egress measures data sent *out of Supabase*, so the response projections and fewer reads are the changes directly targeting its egress allowance. PostgreSQL can still rewrite JSONB storage internally; delta SQL does not promise equivalent reductions in disk/WAL volume.

Browser clock tests verify one initial `/rounds` and `/analysis/current` request, no additional requests across two healthy minutes, reconciliation after a synthetic restart, and no snapshot/health polling during three hidden minutes. This replaces repeated 100-row REST reads while keeping the live stream as the source of updates. Live users still generate per-message authorization reads; those were reduced to three output fields to preserve immediate revocation checks.

## Quotas and ongoing growth

Official Supabase documentation currently lists **500 MB database space per Free project** and **5 GB uncached egress per organization per billing cycle**, plus a separate **5 GB cached allowance**. Cached allowance does not cover PostgreSQL/pooler responses. Uploaded-file Storage quotas are separate from database storage. Other projects in the organization can contribute to the same egress allowance.

Reported egress leaves approximately **4.85 GB** this cycle. Reported database usage leaves approximately **470 MB**. These readings do not establish a full-cycle/growth forecast. The workspace Supabase connection measured **29.10 MB across all databases in the cluster**, matching the reported 6% approximately. The app's current database accounts for **13.99 MB**, including a **0.23 MB rounds table** with indexes and **443 captures in the preceding 24 hours**. Supabase's database-size report uses the cluster total, not just the current database. The project's dashboard remains the quota authority; the VPS connection was not independently compared.

Because the database was recently cleared, today's 6% reading includes starting/allocated storage, not necessarily a 30 MB/day growth rate. Compare normal collection days. Raw data retention continues growing, so optimization alone cannot guarantee an unlimited collection period under the fixed cap. Tables, indexes, allocated/dead row space and Supabase's own databases/schemas all matter.

Use Supabase's Usage page as the quota authority. `SUPABASE_USAGE.sql` is a read-only dashboard query giving total PostgreSQL size, the largest public tables including indexes, daily captures and an approximate indexed round-table growth rate. Its growth estimate uses PostgreSQL statistics and can be inaccurate after bulk loads or on small/fresh datasets; maintenance days can understate the normal capture rate. Measure normal days before deciding an archive schedule. No raw rounds or financial/user records were deleted.

## Validation

Server build and all **73 tests** passed, followed by **11 relevant database/delta regressions** after shrinking INSERT results. Tests cover retry deduplication and unchanged counters on failed inserts; daily SQL transformations, fallback replacement and rollback; analysis replay after restart; and socket suspension, expiry, token rotation and logout. Usage SQL executed on synthetic embedded PostgreSQL data and read live size statistics from the configured Supabase connection. Tests did not contact production services; live metadata checks did not modify data. No game, Telegram or payment service was contacted.

Frontend lint/build, **14 unit tests**, and all **21 production browser tests** passed, including final desktop/mobile/accessibility, reconnect, visibility, pause/resume and outage checks.

## Supabase log ingestion

At the reported 30 MB/day, a 30-day cycle would consume approximately **900 MB** and a 31-day cycle **930 MB**. This leaves little room for traffic/error spikes or usage from other projects. It is a projection at the stated daily rate, not a measured full-cycle forecast.

Read-only inspection found these effective settings: `log_connections=off`, `log_disconnections=off`, `log_duration=off`, `log_min_duration_statement=-1`, `log_min_duration_sample=-1`, `pgaudit.log=none`, `log_statement=ddl`, `log_min_messages=warning`, `auto_explain.log_min_duration=10000`, `log_temp_files=-1`, and autovacuum logs limited to operations over ten minutes. No `cron.job` table was installed. The common query/connection logging causes are therefore already quiet on this configured connection. Existing DDL, errors, lock-wait and very slow-query diagnostics remain enabled. No remote logging settings were changed.

The user's subsequent sample reports **358 PgBouncer entries, 130 PostgREST entries and 49 PostgreSQL entries**. PgBouncer accounts for about two thirds of these entry counts; counts do not establish bytes ingested. Supplied messages then showed successful local `pgbouncer` login/close pairs (`::1`, age zero, milliseconds apart), plus `supabase_storage_admin` connections and TLS setup. These are internal service connections in the supplied sample, rather than scraper errors; the specific local task is inferred to be monitoring/administrative activity and needs provider confirmation. Supabase documents `supabase_storage_admin` as its Storage middleware role. These examples do not prove that every entry or the entire 30 MB/day has the same origin.

PostgreSQL `log_connections` does not control PgBouncer's own logging. The existing app uses a shared pool (maximum ten clients, 30-second idle timeout), rather than creating a pool for each request. No app connection/configuration change was made to treat provider-local connections. No supported managed-PgBouncer verbosity control was located in the documentation inspected. A ready-to-paste [support request](SUPABASE_LOG_SUPPORT.md) asks for supported suppression/sampling of successful internal connections while retaining pooler errors; no message has been sent.

Supabase also ingests gateway/Auth/Realtime/Storage/platform logs. VPS PM2 output does not automatically count as Supabase Logs Ingest. The codebase contains no Supabase log-forwarding integration. Filtering the Logs view or deleting app data does not undo ingestion already metered.

The inspected web client, server and local bot do not use Supabase's Data API: the server/local bot use PostgreSQL through Drizzle/pg, and the client uses the Express API/Better Auth. For a project dedicated to these apps, disabling the unused Data API is supported through the dashboard and preserves their database connection path. Its effect on internal log volume is unmeasured; it is not presented as a proven fix for the supplied Storage/PgBouncer messages. The beginner guide includes the reversible browser setting and provider support draft.

The audit does not claim that the 1 GB log allowance has been secured. The [official Logs Ingest page](https://supabase.com/docs/guides/platform/manage-your-usage/logs-ingest) lists the 1 GB Free allowance and, as checked today, a billing grace period through the start of 2027. Free-plan overages are not listed as paid overage charges; continued quota compliance still matters. See [Supabase service roles](https://supabase.com/docs/guides/database/postgres/roles), [PgBouncer logging settings](https://www.pgbouncer.org/config), and [Supabase's supported Data API toggle](https://supabase.com/blog/hardening-supabase).

## Beginner deployment instructions

Follow [SIMPLE_UPDATE_GUIDE.md](SIMPLE_UPDATE_GUIDE.md). It uses the user's existing `cd`, `git pull`, `nano`, build and PM2 workflow, explains installation/migration steps, includes exact nano save/exit keys, and describes what should appear in the logs. Settings and actions are not automatically applied to the VPS. The server's outage/proxy follow-up remains part of the same uncommitted changes.

Sources checked 13 October 2026: [Supabase database size](https://supabase.com/docs/guides/platform/database-size), [Supabase egress and usage](https://supabase.com/docs/guides/platform/manage-your-usage/egress), [PostgreSQL JSON operators/functions](https://www.postgresql.org/docs/current/functions-json.html), [PM2 process management](https://pm2.keymetrics.io/docs/usage/process-management/) and [graceful shutdown](https://pm2.keymetrics.io/docs/usage/signals-clean-restart/).
