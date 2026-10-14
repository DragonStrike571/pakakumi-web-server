# Web server fixes and validation

14 October cross-project follow-up: the server build and 93 tests passed; the local bot passed 29 tests, the fully local player 24, and the frontend 14 unit tests plus four focused browser checks. See [LONG_TERM_REVIEW.md](LONG_TERM_REVIEW.md) for the final follow-up checks and boundaries, and [COMBINED_UPDATE_STEPS.md](COMBINED_UPDATE_STEPS.md) for deploying the three latest updates together. Earlier sections retain the results at those earlier checkpoints.

Scraper layout follow-up: build and all **79 tests** passed after supporting the current `pakakumi.com/crash` history strip and preserving Playwright's disconnect listeners during cleanup. Six real-browser regressions validate structural detection, old layout compatibility, DOM replacement, malformed-history rejection, fresh capture and HTTP-503 cleanup/retry. A public live check captured a fresh **1.33x** round using an in-memory observation-only handler and stopped cleanly; it made no database writes, Telegram sends or betting actions. See [SCRAPER_LAYOUT_FIX.md](SCRAPER_LAYOUT_FIX.md) and [SCRAPER_UPDATE_STEPS.md](SCRAPER_UPDATE_STEPS.md). Changes remain local.

13 October storage/bandwidth follow-up: server build and **73 tests** passed; **11 focused database/delta tests** passed after minimizing round INSERT responses. Normal saves avoid the preliminary SELECT, bot status excludes unused logs/credentials, and live session checks fetch only three authorization fields. Daily targets use small transactional SQL deltas while retaining checkpoint/replay safety. No additional migration or raw-round deletion. See [FREE_TIER_REVIEW.md](FREE_TIER_REVIEW.md), [SIMPLE_UPDATE_GUIDE.md](SIMPLE_UPDATE_GUIDE.md), and the read-only [Supabase usage query](SUPABASE_USAGE.sql).

12 October 2026. Addresses all 21 findings in CODEBASE_REVIEW.md, plus the original WebSocket shutdown and Telegram exception failures. Changes are local; the live PM2 process and production database have not been modified.

| Finding | Implemented fix | Regression coverage |
| --- | --- | --- |
| R01 | Server-owned role/access fields; read-only existing account audit command | Actual Better Auth signup/update input parser |
| R02 | Durable disk inbox before cursor advancement; retry with an ingestion UUID; save state changes only after success | Database outage/restart, failed capture retry, duplicate insert, failed insert state |
| R03 | Resume visible history after durable/database checkpoint in chronological order | Cold restart, missing checkpoint and explicit gap |
| R04 | Idle pool error listener, bounded database operations | Actual pool error event stays contained |
| R05 | Serialized analysis in one transaction; restore caches on rollback; persisted replay checkpoint | Concurrent hit resolution, transaction rollback/retry, process replay |
| R06 | Lock entitlement row before extending expiry | Concurrent distinct renewals add both days, duplicate reference adds none |
| R07 | Transactional invite outbox, retry/backoff, active user's /status rejoin; unban before invite | Failed delivery retry, rejoin job, existing-install invite backfill |
| R08 | Keyset pagination and completed-removal marker | 45 expired users, admin/error skipping, second sweep does not remove again |
| R09 | Atomic DOM snapshot; validate complete finite player/financial rows; preserve null metrics | Empty financial table never becomes complete zero metrics |
| R10 | Fresh bootstrap, preserved historical migration hashes, repaired legacy ID conversions, additive 0007/0008 | Real PostgreSQL via PGlite: fresh, serial, UUID foreign keys, existing latest installation, unsafe untracked schema refusal |
| R11 | Unlimited recovery with capped backoff; health 503 during recovery/capture/save failures | Recovery continues after failure ten; health code inspected |
| R12 | History excludes the current event and future saved rows; ingestion ID deduplication | Cold analysis count, recovery burst and replay |
| R13 | All support/start state writes invalidate the actual session cache and update context | Actual middleware, setter and next-update open/close transition |
| R14 | Verified success can fulfill locally expired/failed orders; recent reconciliation; truthful callback result | Late success, wrong currency, missing order, duplicate reference |
| R15 | Daily statistics persist with analysis transaction; shutdown drains inbox/analysis and flushes snapshot | Short-run daily counters, drain and committed replay checkpoint |
| R16 | Recheck current session/access before every update/heartbeat; expiry timer; fail closed on auth errors | Logout, suspension, idle expiry and auth failure |
| R17 | Shared launch reservation, four context slots, bounded waiting queue, dead-browser eviction and cancellation; shutdown integration | Parallel launches, capacity, cancelled waiter, context failure and replacement |
| R18 | A 15-second process exit deadline starts before any cleanup; each cleanup error is contained | Hung first resource and successful shutdown timer cleanup |
| R19 | Two worker threads, eight queued jobs, timeout/cancellation; request disconnect cancellation | Identical backtest results while timers run, timeout, cancellation and capacity reuse |
| R20 | Expiry rechecks under the same row lock as renewal; invite delivery repairs an interrupted ban | Renewal after stale batch selection is preserved |
| R21 | Escape user names/text and admin replies, close HTML tags during truncation, truthful support acknowledgement | Literal markup, long message entities/tags and failed support delivery |

Validation passed: `npm run build`; all **59 tests** in `npm test` (file concurrency limited to two); `npm run db:check`; both compiled production-mode worker tests; and `npm audit --omit=dev` with **zero vulnerabilities**. Patched production transitive versions include proxy-addr 2.0.8, ip-address 10.7.4 and qs 6.16.0. Historical migration files 0000–0006 are unchanged. Tests use synthetic data, PGlite, mocked browser/Telegram/Paystack calls and local loopback WebSockets; they do not send messages, take payments, access the live game, or query the production database. PGlite validates PostgreSQL SQL and transactional behavior in one embedded connection; live multi-connection load and deployment settings still need operational verification.

Deploy with the steps in README.md. Apply migrations before restarting. Preserve COLLECTION_DATA_DIR and run one collector instance. Verify existing access-enabled accounts against trusted grants using `npm run db:audit-access`; legitimate users are not automatically downgraded. Data already lost outside visible game history cannot be reconstructed. Telegram outbox messages use at-least-once delivery, so a crash after send and before acknowledgement can repeat a message.

The old `*-probe.mjs` files preserve pre-fix reproduction evidence and are not current pass/fail tests. Use `npm test` for the corrected behavior.

Outage/proxy follow-up (12 October 2026): server build and **71 regression tests** passed, including a virtual 48-hour outage, one-minute retry cap, stale and hung source history, checkpoint retention, stop safety, local Nginx per-client limits and provider-operation guards. Frontend build/lint, **14 unit tests** and **19 production browser tests** passed. See `review/OUTAGE_AND_PROXY_FIX.md` for operation and same-VPS deployment instructions. This follow-up adds no migration.

Frontend integration follow-up (12 October 2026): the final server build and **63 regression tests** passed after adding the cached `/analysis/gaps` endpoint with a two-query concurrency limit, zero-valued custom backtest risk overrides, the zero-rounded algorithm guard, and resolving-round counts for signal outcomes. Gap tests cover empty/fresh histories, latest-milestone scoping, retained occurrence numbering and capacity recovery. See the frontend's `review/CODEBASE_REVIEW.md` and `review/FIX_VALIDATION.md` for client flows and coordinated deployment steps.

Page integration follow-up (14 October 2026): server build and **89 regression tests** passed; local-bot type check and **14 tests**; fully-local-player type check and **13 tests**; frontend lint, production build and the existing navigation/accessibility browser check passed. The final adapter observed a fresh 6.42x public round and uniquely located the current login fields without signing in or betting. See `review/PAGE_AND_RULES_REVIEW.md` for current rules, financial-data limitations and the distinction between fixture validation and live account verification; deploy using `review/PAGE_UPDATE_STEPS.md`.
