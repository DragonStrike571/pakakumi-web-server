# Web server codebase review

**Historical review:** the findings below describe the code before the subsequent fixes. See [FIX_VALIDATION.md](FIX_VALIDATION.md) for implementation, regression coverage and deployment requirements.

Reviewed on 12 October 2026 (Africa/Nairobi). Scope: `pakakumi-web-server`, HEAD `03761bc`, including the current uncommitted reliability fixes. Reviewed all 47 production TypeScript files under `src` and `scripts`, the seven SQL migrations, configuration, authentication, HTTP routes, WebSocket handling, collection, analytics, backtesting, Telegram, payments, encryption, and dependency metadata.

**Result: 21 actionable findings: one P0, ten P1, and ten P2.** The highest priority is the writable authorization fields. The collection pipeline also still has paths that lose rounds without crashing. Application code was not changed during this review; the report and offline reproduction scripts are new review artifacts.

P0 means an immediate security blocker; P1 means a significant security, collection, billing, or availability problem; P2 means a narrower correctness or reliability issue. Findings below describe the present working tree, rather than repeating the WebSocket exception and Telegram command exception handling already fixed in this chat.

## Findings

### R01 — P0: Clients can assign themselves admin and paid access

Location: [auth.ts](C:/Truth/Pakakumi/pakakumi-web-server/src/lib/auth.ts:25).

`role` and `accessStatus` are registered as Better Auth additional fields without `input: false`. Both signup and authenticated `/api/auth/update-user` input therefore accept `role: "admin"` and `accessStatus: "active"`. The HTTP access middleware and WebSocket verifier trust those values, so a client can bypass the intended admin, subscription, pending, and suspension gates. Ownership checks on individual records still apply; this is an authorization-gate bypass, not evidence of unrestricted access to other users' credentials.

Evidence: the installed library's `parseUserInput(auth.options, ..., "create")` and `"update"` both returned the supplied admin/active values in the offline probe. Better Auth documents additional-field input as enabled by default and explicitly recommends disabling it for server-owned roles. [Better Auth schema documentation](https://better-auth.com/docs/concepts/database#extending-core-schema).

Fix: make both fields server-owned with `input: false`, validate the allowed values on trusted administrative writes, add signup/update authorization tests, and check existing privileged accounts before relying on those claims again.

### R02 — P1: A failed database save permanently suppresses that round

Locations: [scraper.ts](C:/Truth/Pakakumi/pakakumi-web-server/src/services/scraper.ts:446), [index.ts](C:/Truth/Pakakumi/pakakumi-web-server/src/index.ts:155).

`checkForChanges()` adds a bust ID to `previousBustIDs` before emitting the event. Persistence then happens asynchronously. If `processRound()` fails, the listener logs the error and returns, but the scraper already treats the round as successfully handled and never emits it again. A temporary database failure can therefore create a permanent collection gap while the scraper continues reporting that it is running.

Evidence: two scrapes of the same still-visible round produced only one persistence attempt in the offline fixture.

Fix: acknowledge a round only after a durable save, retain failed rounds in a bounded retry queue, and make persistence idempotent using a stable source identity. Choose that identity carefully: a window of multipliers can repeat and is not automatically a globally unique game ID.

### R03 — P1: A fresh process discards recoverable history after downtime

Locations: [scraper.ts](C:/Truth/Pakakumi/pakakumi-web-server/src/services/scraper.ts:105), [scraper.ts](C:/Truth/Pakakumi/pakakumi-web-server/src/services/scraper.ts:351).

In-process browser restarts retain the seen-ID set, but PM2/process restarts recreate it empty. `initialScrape()` then marks up to 40 visible rounds as seen without emitting any. The latest persisted `lastBustId` is loaded by `RoundService` but never passed to the scraper to identify the unsaved portion of that history. A restart can lose rounds that are still recoverable from the game page.

Evidence: a fresh scraper with 40 visible rounds emitted zero rounds across its initial scrape and subsequent change check.

Fix: initialize collection from a durable checkpoint, replay newer visible history chronologically, and distinguish a new installation from a restart. Preserve unknown financial metrics when only bust history can be recovered.

### R04 — P1: Idle PostgreSQL connection errors can still stop the entire process

Location: [db/index.ts](C:/Truth/Pakakumi/pakakumi-web-server/src/db/index.ts:6).

The shared `pg.Pool` has no `error` listener. An idle connection can fail outside any request or round-save promise; its error event becomes an uncaught exception and reaches the process-wide shutdown handler. Catching `processRound()` or route promises does not contain that event.

Evidence: the actual exported pool has zero error listeners, and a synthetic pool error throws. The driver documents idle backend/network failures and removal of the affected connection. [node-postgres pool error documentation](https://node-postgres.com/apis/pool#error).

Fix: register a contextual pool error handler, allow the driver to remove/recreate the failed connection, and distinguish transient connection errors from conditions that require restarting a service.

### R05 — P1: Concurrent analysis calls count one signal hit more than once

Locations: [index.ts](C:/Truth/Pakakumi/pakakumi-web-server/src/index.ts:171), [analysis/engine.ts](C:/Truth/Pakakumi/pakakumi-web-server/src/services/analysis/engine.ts:527).

Round persistence is serialized, but analysis is launched without awaiting completion. During recovery bursts or slow database work, two engine calls can both read the same pending signal before either removes it. Both increment shared hit counters and record the outcome. Shared caches, dirty flags, and signal creation also cross asynchronous boundaries without an engine-level queue or transactional claim.

Evidence: two concurrent legitimate hit rounds against one pending signal produced two hits and 200% reported accuracy in the actual engine with delayed, isolated DB fixtures.

Fix: serialize the stateful engine in round order, use a single initialization promise, and make signal resolution an atomic claim. Keep slow Telegram delivery outside that serialized state update.

### R06 — P1: Concurrent payments for one user lose purchased subscription time

Location: [paystack.ts](C:/Truth/Pakakumi/pakakumi-web-server/src/services/paystack/paystack.ts:148).

The conditional payment update protects against fulfilling the same reference twice. It does not protect two different successful references for the same subscriber. Both transactions can read the same `expiryTimestamp`, compute a new date from that old value, and overwrite each other. Both payments end up successful, while only one duration is credited.

Evidence: an offline fixture exercising the actual handler with two interleaved one-day purchases credited one day and marked both payments successful. This reproduces the read/modify/write interleaving; it is not a live PostgreSQL concurrency test.

Fix: lock the subscriber row before reading its expiry, or extend expiry with an atomic SQL expression inside the transaction. Retain the existing per-reference idempotency guard.

### R07 — P1: Failed Telegram invite delivery is never retried after payment

Locations: [paystack.ts](C:/Truth/Pakakumi/pakakumi-web-server/src/services/paystack/paystack.ts:139), [paystack.ts](C:/Truth/Pakakumi/pakakumi-web-server/src/services/paystack/paystack.ts:195).

Payment and entitlement success are committed before invite generation/delivery. A Telegram error is only logged. Subsequent fulfillment calls return immediately because the payment is already successful, and the poller only scans pending payments. A paying user can therefore never receive their access link through the automatic flow after one delivery failure. The status command does not provide a replacement invite.

Evidence: two fulfillment attempts after a synthetic invite failure resulted in one invite attempt and a successful payment record.

Fix: persist invite/notification delivery as a separate retryable job or outbox record, and provide an authenticated way for the entitled subscriber to request a replacement link. Do not reapply subscription time while retrying delivery.

### R08 — P1: Expiry batches can repeatedly select the same users and starve others

Location: [expiry.ts](C:/Truth/Pakakumi/pakakumi-web-server/src/services/telegram/expiry.ts:42).

The hourly job selects at most 20 expired users. Successfully removed users, users already outside the channel, and skipped admins remain eligible for exactly the same query: no processing marker is written, no pagination cursor advances, and the job does not drain the remaining batches. A stable result set can therefore contain the same first 20 users every hour, while later expired subscribers retain channel membership. Previously handled users can also receive repeated expiry notices.

Evidence: static inspection of the selection and every completion/skip path; successful ban/unban operations only invalidate the RAM session cache and do not change the selection predicate.

Fix: page through all expired candidates per cycle or track completed revocation explicitly. Preserve the admin guard and ensure failed removals remain retryable without blocking later candidates.

### R09 — P1: Missing player/financial rows are saved as complete zero-valued metrics

Locations: [scraper.ts](C:/Truth/Pakakumi/pakakumi-web-server/src/services/scraper.ts:404), [scraper.ts](C:/Truth/Pakakumi/pakakumi-web-server/src/services/scraper.ts:456).

An empty amount/profit selection reduces to zero, and `metricsComplete` depends solely on the round being the newest history item. There is no completeness or finite-number check. During partial DOM hydration, table replacement, or selector mismatch, a round can claim complete metrics with players present but zero amount played/won/lost. Reserve calculations then use fabricated zero values instead of marking the financial continuity unknown. Invalid amount/count strings can similarly introduce non-finite values.

Evidence: a page fixture with seven playing users and no amount/profit rows produced `metricsComplete: true` and `totalAmountPlayed: 0`.

Fix: validate a consistent snapshot and expected row/count relationships; distinguish legitimate zero from unavailable data, retry incomplete hydration briefly, and persist unknown metrics explicitly when recovery cannot supply them.

### R10 — P1: The migration chain cannot bootstrap the documented clean database

Locations: [0000 migration](C:/Truth/Pakakumi/pakakumi-web-server/drizzle/0000_sticky_kabuki.sql:2), [0001 migration](C:/Truth/Pakakumi/pakakumi-web-server/drizzle/0001_lazy_king_bedlam.sql:87), [0002 migration](C:/Truth/Pakakumi/pakakumi-web-server/drizzle/0002_steep_rumiko_fujikawa.sql:1).

The first migration creates `users.id` as `serial`/integer. The next changes it to UUID without an explicit conversion and without first removing the integer default. PostgreSQL has no automatic integer-to-UUID assignment cast. The subsequent UUID-to-text migration also changes referenced/referencing columns while their foreign keys still exist. The current `drizzle-kit check` success validates migration metadata, not execution of this SQL against a fresh database.

Evidence: static SQL/type analysis; a disposable PostgreSQL migration run was not performed. PostgreSQL requires explicit conversion when no assignment cast exists and compatible handling of defaults. [PostgreSQL ALTER TABLE documentation](https://www.postgresql.org/docs/current/sql-altertable.html).

Fix: provide and test a valid clean-install path and a separate safe upgrade path for existing databases, including foreign-key handling. Do not casually rewrite migration files already recorded in a deployed journal.

### R11 — P1: Recovery gives up permanently while the API stays alive

Location: [scraper.ts](C:/Truth/Pakakumi/pakakumi-web-server/src/services/scraper.ts:166).

After ten unsuccessful restarts, the scraper sets `desiredRunning` to false and schedules no further attempts. The HTTP process remains alive, so PM2's process supervision does not restart collection. A sufficiently long game/browser/network outage therefore requires manual intervention even after the underlying problem clears. `/health` reports degraded JSON with HTTP 200, which a status-code-only monitor will regard as healthy.

Fix: continue bounded-backoff recovery, or explicitly hand this failure to a supervisor with an actionable unhealthy response. Track the age of the last successfully persisted round, not only browser/DOM activity.

### R12 — P2: The first analyzed saved round is appended twice to history

Location: [analysis/engine.ts](C:/Truth/Pakakumi/pakakumi-web-server/src/services/analysis/engine.ts:481).

The engine initially loads the latest persisted rounds after `processRound()` has saved the triggering round, then unconditionally appends that same `newRound`. The cache therefore duplicates the first round after every process start, which changes distances, counts, and custom analysis results. Recovered bursts can also load later persisted records before earlier events are appended.

Evidence: a database fixture containing the triggering round once resulted in `roundsAnalyzed: 2`.

Fix: carry source IDs through analysis and initialize at the event's checkpoint, deduplicating any triggering record already present in the loaded history.

### R13 — P2: Opening/closing Telegram support leaves the session cache stale

Locations: [commands.ts](C:/Truth/Pakakumi/pakakumi-web-server/src/services/telegram/handlers/commands.ts:395), [messages.ts](C:/Truth/Pakakumi/pakakumi-web-server/src/services/telegram/handlers/messages.ts:87), [session-state.ts](C:/Truth/Pakakumi/pakakumi-web-server/src/services/telegram/session-state.ts:27).

State-changing handlers write the database and current `ctx.dbState` but do not update/invalidate the cache populated before those handlers run. The next message can therefore use the previous state for five minutes. After opening support, the user's actual support message may be ignored; after closing, ordinary messages can continue becoming tickets. The `/start` reset has the same problem.

Evidence: the actual support callback wrote `support` to the fixture database, but the immediately following message received cached `command` state.

Fix: centralize state writes together with cache invalidation/update and call that operation from open, close, and start handlers.

### R14 — P2: A verified late successful payment is ignored if locally marked failed

Location: [paystack.ts](C:/Truth/Pakakumi/pakakumi-web-server/src/services/paystack/paystack.ts:117).

The poller marks abandoned transactions failed after its grace period. Fulfillment subsequently rejects every non-pending record even if verification now proves a successful, adequately paid transaction. The callback can still display a success message because it checks Paystack's status rather than whether access was actually granted. A user completing an old payment link can pay without receiving an extension.

Evidence: the actual handler ignored a verified successful transaction whose local record was `failed`, leaving its expiry unchanged.

Fix: distinguish local expiry/abandonment from authoritative payment failure, reconcile later verified success idempotently, and return a fulfillment result the callback can display accurately.

### R15 — P2: Graceful shutdown loses dirty analysis statistics

Locations: [analysis/engine.ts](C:/Truth/Pakakumi/pakakumi-web-server/src/services/analysis/engine.ts:813), [index.ts](C:/Truth/Pakakumi/pakakumi-web-server/src/index.ts:306).

Daily statistics are intentionally buffered and flushed every ten analysis rounds. Shutdown never flushes those buffers or waits for outstanding analysis work before ending the pool. Even a routine graceful restart can therefore discard dirty prediction/hit/miss data. History and aggregate statistics can disagree after restart. Abrupt crashes also lose buffered changes by design.

Fix: expose a bounded analysis-drain/flush operation and invoke it before ending the database pool; use durable events or reconstruct aggregates if crash durability is required.

### R16 — P2: WebSocket authorization remains valid indefinitely after the handshake

Location: [ws/server.ts](C:/Truth/Pakakumi/pakakumi-web-server/src/ws/server.ts:69).

Session and role/access checks run only during verification. After connection, heartbeat processing checks responsiveness, and broadcasts check socket state. Session expiry, logout/revocation, or account suspension does not close an already connected client, which can continue receiving protected rounds and analysis.

Fix: associate each connection with its session expiry and user identity, close it at expiry, and revalidate or explicitly disconnect on access changes.

### R17 — P2: The balance browser pool exceeds its limit and retains disconnected browsers

Location: [balance-pool.ts](C:/Truth/Pakakumi/pakakumi-web-server/src/services/balance-pool.ts:22).

Concurrent first requests all observe an empty browser list before awaiting their launches, so `MAX_BROWSERS = 2` does not reserve or constrain in-flight launches. There is also no cap on active contexts, no eviction of disconnected browsers, and no integration of `balancePool.shutdown()` into server shutdown. After a browser dies, future requests can keep selecting that dead instance.

Evidence: four simultaneous requests launched four fixture browsers despite the configured maximum of two.

Fix: serialize/reserve launches, enforce a context concurrency limit, evict disconnected instances, and close the pool during shutdown.

### R18 — P2: The shutdown timeout is not a timeout for the whole shutdown

Location: [index.ts](C:/Truth/Pakakumi/pakakumi-web-server/src/index.ts:288).

The ten-second timeout races only HTTP closure, after awaiting WebSocket closure, scraper stop, and Telegram stop. `pool.end()` is awaited after that race as well. A hung browser close, Telegram stop request, or DB drain can therefore leave the process stuck indefinitely after printing the shutdown messages. The intended process exit and PM2 restart may never happen until an external kill timeout intervenes.

Fix: start a single hard deadline when shutdown begins, bound each cleanup stage, drain collection/analysis in order, and ensure the process can exit when the deadline expires.

### R19 — P2: Backtests block the same event loop that drives collection

Locations: [backtests route](C:/Truth/Pakakumi/pakakumi-web-server/src/routes/backtests.ts:98), [backtest engine](C:/Truth/Pakakumi/pakakumi-web-server/src/services/backtest/engine.ts:204).

The route invokes synchronous simulation over up to 250,000 rounds and up to 100 rules with 20 conditions each. It shares the collector's event loop. Large requests delay scrape callbacks, database completions, WebSocket heartbeats, and Telegram processing; per-IP request counts do not bound the computational cost or total concurrent callers.

Evidence: a schema-valid 94,242-byte request configuration blocked the event loop for 847 ms over only 50,000 fixture rounds on this workspace. The permitted maximum is five times that dataset size; the measurement is machine-specific, not a production latency estimate.

Fix: execute backtests in bounded worker threads/jobs, impose a computational budget, and support cancellation/timeout independently of the HTTP request.

### R20 — P2: Subscription renewal can race with an expiry kick

Location: [expiry.ts](C:/Truth/Pakakumi/pakakumi-web-server/src/services/telegram/expiry.ts:91).

The job decides eligibility from an earlier batch snapshot, then performs queued membership lookups and removals. A successful payment can renew a user during that delay. The kicker never rereads expiry before removal and can remove a now-active paid subscriber.

Fix: coordinate renewal and revocation with a per-user lifecycle/version check and reconcile membership when renewal wins a race. A recheck narrows the window; synchronization or compensating delivery is needed to close it reliably.

### R21 — P2: Unescaped support text can break Telegram delivery

Location: [messages.ts](C:/Truth/Pakakumi/pakakumi-web-server/src/services/telegram/handlers/messages.ts:119).

Support text, display names, and administrator replies are interpolated into HTML messages without escaping. Length truncation is not sanitization and can also cut markup. Ordinary text containing `<`, `>` or `&` can make Telegram reject the forwarded message; users are still told their ticket was sent because forwarding errors are swallowed. User-supplied tags/links can also alter the displayed message.

Fix: escape dynamic content before building HTML, truncate content before wrapping it in tags, or use plain text/entities for forwarded support messages. Telegram specifies escaping these characters in HTML mode. [Telegram formatting documentation](https://core.telegram.org/bots/api#html-style).

## Dependency audit

`npm audit --omit=dev --json` returned a nonzero exit code and three affected production packages on the review date:

| Installed package | Dependency path | Highest reported severity |
| --- | --- | --- |
| `proxy-addr@2.0.7` | `express@5.2.1` | Critical |
| `ip-address@10.2.0` | `express-rate-limit@8.5.2` | High |
| `qs@6.15.2` | Express/body-parser | Moderate |

The critical proxy advisory requires a problematic trust-subnet configuration. This server currently configures a numeric trusted-hop count, so that advisory is **not proof of an exploitable proxy bypass in this application's present configuration**. Upgrade the affected dependency chain and recheck the deployed proxy configuration. The advisory identifies `proxy-addr@2.0.8` as patched. [Upstream advisory](https://github.com/advisories/GHSA-jqcg-44mw-7w3h).

No packages were upgraded during this review. Development-only dependencies were not included in this audit command.

## Validation and limits

- The current application build passes (`npm run build`).
- Migration metadata checks pass (`npm run db:check`); this does not validate executing the historical migrations.
- All 29 existing automated tests passed on this working tree during this chat. The suite covers backtesting and the recent WebSocket, background-task, and Telegram reliability fixes, but does not establish end-to-end database, payment, restart, or authorization correctness.
- Three offline probe scripts passed. They use actual application/library functions with synthetic page, database, API, and timing fixtures. Network calls are disabled, real database methods are blocked, Chromium launches are replaced, and no Telegram messages or financial transactions were sent.
- Review did not run the production server, production database schema inspection, live Paystack transactions, live Telegram calls, or a disposable PostgreSQL migration test. Existing migration application and runtime deployment/proxy settings therefore remain unverified.
- Ownership filtering and parameterized Drizzle queries are generally present on tenant-scoped endpoints, and stored credentials use authenticated AES-256-GCM encryption. These observations do not offset the authorization-field issue above.

Reproduction commands, run from the web-server directory:

```text
node --import tsx review/codebase-probes.mjs
node --import tsx review/payment-probes.mjs
node --import tsx review/backtest-probe.mjs
```

The probes intentionally assert current faulty behavior. After fixes, update them into regression tests that assert the corrected behavior.

## Recommended implementation order

1. Make authorization claims server-owned (R01), contain pool errors (R04), and establish acknowledged/idempotent collection with checkpoint recovery and valid metrics (R02, R03, R09).
2. Serialize analysis and correct history initialization (R05, R12); ensure recovery remains supervised and shutdown drains within a deadline (R11, R15, R18).
3. Make subscription updates atomic, delivery retryable, and expiry processing complete and coordinated with renewal (R06, R07, R08, R14, R20).
4. Correct the clean-install/upgrade migration path (R10), session cache state writes (R13), WebSocket revocation (R16), browser resource management (R17), backtest execution isolation (R19), and Telegram HTML encoding (R21).
