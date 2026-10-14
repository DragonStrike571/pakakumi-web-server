# Cross-project reliability review — 14 October 2026

Reviewed the database-connected local bot, fully local player, frontend live-data lifecycle and their integration with the updated crash page and collector. Confirmed issues below are fixed locally. Nothing has been pushed or deployed. Use [COMBINED_UPDATE_STEPS.md](COMBINED_UPDATE_STEPS.md) to deploy this review with the two preceding updates.

## Findings and fixes

| Priority | Area and failure | Result after the fix |
| --- | --- | --- |
| High | Local worker stopped `starting` sessions while login was still creating a page | Starting sessions survive monitoring; a 60-second startup deadline cleans up a hung login. |
| High | Browser recovery repeated the orphan cleanup, failing newly claimed jobs; old disconnect handlers could stop replacement sessions | Orphan cleanup runs once per worker; browser/session identity guards isolate old callbacks. |
| High | A pooled session advisory lock can lose ownership under transaction pooling; repeatedly acquiring it also accumulates lock references | One dedicated direct/Session-pooler connection acquires once. Supabase shared-pooler lock traffic uses port 5432; incompatible explicit transaction endpoints are refused. Loss of ownership stops the worker. |
| High | Stop during browser/context startup could allow a late session to resume, or duplicate starts could race | Both players reserve startup, check cancellation after asynchronous creation and close late resources. The fully local manager waits for the prior browser to close before starting another. |
| High | Database failure while stopping could retain a dead session indefinitely or release capacity before its terminal state was repairable | Browser cleanup always signals the manager. A bounded repair slot retries the same terminal snapshot and remains reserved until saved; monitoring survives browser loss. |
| High | Stop/access revocation could arrive after the strategy decision but before the UI click; late state writes could restore stopped heartbeats | A compact authorization check runs immediately before submitting a worker bet. State writes require an active session; start cannot overwrite a cancelled database status. |
| High | Another browser using the same Pakakumi account could produce a matching own-account acceptance broadcast | Confirmation also requires a successful acknowledgement of this page's native Bet request, plus a new accepted own round/amount. The observer forwards existing UI calls; it sends no independent betting requests. |
| High | Provider page reload/crash could remove the event observer while leaving a session active | Reload, page loss, disconnect and stale events stop execution. Disposal clears the owned listeners/timer and restores the native emitter. Installation and page reads have deadlines. |
| High | Fully local profit stages could fund minimum stakes beyond half the previous phase's net profit | Stakes round down to fit the allocation. If it cannot fund the minimum stakes, the base cycle resumes. Phase messages use the configured settings. |
| Medium | A final multiplier could reset the worker strategy as a win despite a recorded zero payout | The execution core accepts the recorded outcome. Actual payout controls live results; partial/unexpected payouts stop for review. Zero-rounded algorithm stakes are rejected. |
| Medium | Frontend reconciliation IDs accumulated throughout a healthy, long-lived socket | IDs are collected only during the REST seed and cleared when the refresh completes. Existing feed, deduplication and opportunity buffers remain bounded. |
| Medium | Fully local dashboard requests overlapped, stale GETs could replace a mutation, and repeated actions/errors had poor feedback | Polling is serialized, time-limited and paused when hidden. Mutation locking, abort/version checks, caught errors and running-account labels prevent stale/duplicate actions. |
| Medium | A malicious external page could submit simple requests to the loopback player | Host and Origin are checked; POST requires JSON. The server stays on loopback and disallows framing. |
| Medium | Worker sessions/browser contexts and database writes could grow without a useful capacity limit | Default capacity is four, with oldest-first bounded claims and pending-job expiry. Query pool maximum is two; persisted logs contain the newest 100 entries. |
| Medium | Independent visible player counters were lost with unavailable financial totals, or startup placeholders could be treated as valid counts | New labels are read independently. Only valid, consistent counts attach to the newest observed round; older recovery rows and inconsistent counters stay unavailable. Financial totals stay unavailable for the partial player list. |

Shutdown paths have a 15-second deadline, continue cleanup after an individual failure and report failure rather than exiting successfully after incomplete cleanup. Login passwords are cleared from session-owned copies after login/stop; invalid worker connection strings produce a sanitized message.

## Storage, bandwidth and long-running operation

Queue polling changes from every two seconds to every 30 seconds when idle, and every 10 seconds when sessions are present. Idle queue reads alone decrease from roughly 30 to two per minute. Status queries are batched; heartbeats are batched at most every 30 seconds. The dedicated ownership connection uses a small check every 30 seconds. Immediate submission authorization adds one small database read per attempted bet, deliberately keeping revocation protection close to the UI action.

The worker now uses at most two ordinary query connections plus one ownership connection. Its longer idle timeout avoids repeatedly reconnecting a quiet application pool. Smaller persisted log snapshots reduce repeated JSON updates. No per-round account-balance requests were added. The frontend retains WebSocket updates without healthy-stream REST polling; the fully local player needs no Supabase traffic.

The earlier compact round INSERTs, analysis deltas, checkpoint replay, bounded API results and graceful source recovery remain intact. Metric-dependent rules skip unavailable values; missing financial data does not reset a known rounds-since-3000 counter. All three page adapters and contract tests are identical; the local worker's source history reader matches the collector's reader.

[Supabase's connection guidance](https://supabase.com/docs/guides/database/connecting-to-postgres) distinguishes Session and Transaction endpoints. [PgBouncer's feature table](https://www.pgbouncer.org/features.html) explicitly excludes session advisory locks in Transaction mode. Custom non-Supabase transaction poolers must also supply a direct/Session endpoint through `WORKER_DATABASE_URL`; the code cannot infer arbitrary proxy configurations from a hostname.

Raw-round storage still grows indefinitely. These changes cannot guarantee permanent free-tier operation or reduce Supabase's internally generated PgBouncer logs. The supplied internal monitoring/Storage-service log samples are separate from application query volume. Keep measuring daily Database Size, egress and Log Ingestion. No retention policy or data deletion was introduced.

## Verification

| Project | Verification |
| --- | --- |
| Web-server | Production TypeScript build; 93 regression tests. After the final collector counter sanity change, the build and all seven real-browser source tests passed again. |
| Database-connected local bot | Type check/build; 29 tests covering lifecycle, startup timeout, late cancellation, bounded terminal repair, ownership, recorded outcomes and intercepted page contracts. After the final shutdown/URL sanitation changes, the build and six ownership/session tests passed again. |
| Fully local player | Type check; 24 tests covering payouts, allocation boundaries, concurrent/cancelled starts, request guards, page contracts and the dashboard browser test. |
| Frontend | Lint, production build and 14 unit tests; four focused browser regressions for 1,200 live updates/reconnect, hidden-tab traffic, route/socket continuity, desktop/mobile layouts and accessibility. |
| Public source | Read-only final adapter installation, 40 history entries and a fresh 1.34x round. The page showed 0 online versus 191 playing during this probe; those inconsistent counters are treated as unavailable. No account login, bet, database write or Telegram send. |

Windows sandbox restrictions blocked loopback HTTP/WebSocket networking and Next's filesystem canonicalization on the first run. Those checks passed when rerun with the required local permissions. Builds used isolated test HTTPS/WSS endpoints and browser tests intercepted the APIs; actual environment files were preserved.

Private account login, native real-money acknowledgement, payout behavior, provider interruption/refund decisions and target deployment network access remain operational verification boundaries. Intercepted fixtures exercise these contracts but do not prove a live monetary transaction. The source's incomplete player display still cannot establish full financial totals. Current public rules and the unverified house-edge assumption are documented in [PAGE_AND_RULES_REVIEW.md](PAGE_AND_RULES_REVIEW.md).
