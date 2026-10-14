# Current page and rules check — 14 October 2026

The earlier redirect/history fix covered the collector. This follow-up also updates login, balance checks, the database-connected local bot and the fully local player. Changes are local and have not been deployed.

## Verified page integration

| Integration | Current implementation |
| --- | --- |
| Collection | Reads the new newest-first multiplier strip, tolerates generated CSS changes, retains the legacy reader and retries during outages. |
| Login | Uses `https://pakakumi.com/login` and labelled phone/password fields. Normalizes the already-prefixed +254 phone input, scopes the login button to its form, and requires a successful provider login response and navigation. Password-bearing Playwright errors are replaced with a safe message. |
| Balance | Observes the wallet response the page requests after login. Real zero balances are valid. The result matches available playable KES funds, including bonus/free-bet wallets; it is not necessarily the amount eligible for withdrawal. |
| Player controls | Finds Amount, Auto Cashout and Bet by labels/accessible names. The old multiplier element is gone; the chart is a canvas. Players observe the page's existing game event interface for round phases, acceptance and recorded cashouts. They send bets only through the page's Bet button. |
| Real results | Matches accepted bets to provider round IDs. Derives gross payout from the recorded cashout, then subtracts the stake for net P/L. An unexpected cashout records the actual result and stops for review. Missing confirmation, disconnection, a forced termination without a recorded cashout, or five minutes without game updates stops execution. Historical snapshots do not trigger bets. |
| Analysis | Removes claims that delays correct themselves or predict an imminent hit. Labels confidence as a heuristic and the 1% house edge as an unverified model assumption. |

The player adapter imports the application module already loaded by the official page and subscribes to its existing events. It creates no additional WebSocket or database connection and makes no extra configuration/wallet polling requests. Future provider interface changes must fail closed. The independently deployed projects contain identical adapter and contract-test copies; keep these copies synchronized.

**Collection limitation:** the new player table displays only part of the participants and its Win column is gross return. It is not sufficient for complete round financial totals. The collector continues saving multipliers while leaving unverified financial fields null. The 3000x counter/reset convention in our analysis is an internal model, not proof that Pakakumi resets its funds at that point. Backtests remain simulations from recorded busts; they cannot reproduce forced cashouts, voids, account restrictions or every actual settlement.

## Current published rules and limits

Checked the live public page, the configuration it loads, and the official terms. There is no saved earlier terms snapshot here, so this confirms current information rather than when a rule changed.

- **Stakes:** live [configuration](https://api.pakakumi.com/config) specifies Crash minimum **KES 10** and maximum **KES 5,000**. Runtime players observe this configuration and reject values outside it. Telegram's minimum was corrected from 5 to 10. Blog/page marketing quotes different minima; the [official minimum-stake guide](https://blog.pakakumi.com/articles/crash-game-minimum-deposit-stake.html) says to check the app.
- **Multipliers:** the [Crash page](https://pakakumi.com/crash) advertises **3000x**, while its current cashout input permits **1.01–9999x**. That input range alone does not prove the game's actual maximum changed. Players retain a conservative **3000x** target limit pending authoritative clarification.
- **Payout cap:** [terms §7.4](https://pakakumi.com/terms-of-service) limit combined payouts to **KES 1,000,000 per round**, and permit early cashouts. A requested target does not establish the amount actually paid.
- **Withdrawals:** terms §3.4.4 require total wagers at least equal to deposited funds before withdrawal; verification can also be required. The available balance is not a withdrawal guarantee.
- **Disruptions:** terms §§4.5, 8 and 11 address refunds, cancellations and malfunctioning games. The player's bankroll must not assume how an unresolved interrupted bet was settled. §5.2 makes provider server records authoritative.
- **Account use:** terms require an adult user, one account and recreational use. They do not expressly address external bots; authorization for external automation remains unconfirmed.
- **Odds:** the [official probability guide](https://blog.pakakumi.com/articles/crash-game-fundamentals-odds-probability.html) describes independent rounds. It includes a generic 97% RTP/3% edge example, but does not provide a verified technical Crash specification. No authoritative current 1% Crash edge was established in this check. The existing 1% calculation remains an explicitly labelled assumption.

No support message was sent, no account was registered or logged into, and no real bet was placed. Public layout/events were checked live; authentication, acceptance, payouts and failure handling were checked with intercepted browser fixtures. Real account flows still need operational verification before claiming live monetary behavior is proven.

For deployment, use `PAGE_UPDATE_STEPS.md`.

## Validation

- Web-server: production TypeScript build and all **89 regression tests** passed.
- Database-connected local bot: type check and **14 tests** passed.
- Fully local player: type check and **13 tests** passed, including payout-driven bankroll updates.
- Frontend: lint and production build passed. The existing browser check for mobile navigation and accessibility across the main pages also passed against the production build.
- Live read-only check: the final adapter observed a fresh **6.42x** public round, loaded limits **10/5000**, and uniquely located the current phone, password and login button. No authentication or betting action was attempted.

The local frontend `.env.local` points to HTTP development endpoints. Its production guard correctly refused that configuration; the build and browser check used isolated `https://api.pakakumi.test` / `wss://api.pakakumi.test/ws` endpoints with intercepted APIs. Deployment must keep its real HTTPS/WSS endpoints. No local environment settings or production services were changed.
