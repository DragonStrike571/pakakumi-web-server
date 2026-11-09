# Site integration verification — 3 November 2026

Compared all four projects with the three supplied HTML captures and the current public [crash page](https://pakakumi.com/crash) and [login page](https://pakakumi.com/login). The supplied captures match the integrated layout. One additional signed-out-state safeguard was needed and is now implemented locally.

## What was verified

| Source/integration | Result |
| --- | --- |
| Supplied signed-in crash capture | The collector reads all 40 multipliers from the history strip. Amount, Auto Cashout (X) and the exact Bet button each match once. The partially displayed player table is excluded from financial totals. |
| Supplied signed-out crash capture | The same history and amount/cashout fields are present, but Login/Or Register replaces Bet. This state must not be treated as a ready player. |
| Supplied login capture | Labelled Phone number and Password inputs match. The phone field already supplies +254. The nested Login button matches within the form. Generated IDs/classes are not required by production selectors. |
| Live public pages | The event bridge installed and observed a fresh 1.00x round with 40 history entries and no observer failure. The current public login fields/button also matched. No login form was submitted. |
| Current public application modules | Still use POST `/auth/login`, GET `/accounts/me`, the Crash event prefix 150, native amount/autoCashout/idx/currency submissions, accepted own plays, round IDs and recorded cashout events. Available balance sums positive wallets for the selected currency. These agree with the integration. |
| Current [public configuration](https://api.pakakumi.com/config) | Currency KES, minimum Crash stake 10 and maximum 5,000. The players continue checking the configuration loaded by the page. |

Public events were checked without authentication. Production player startup additionally requires the signed-in Bet control; that precondition is covered by intercepted fixtures. The event bridge itself is unchanged. Private acceptance and payout behavior are covered with intercepted fixtures rather than a real bet.

## Project coverage

- **Web-server:** collector uses the current history reader. Balance checks use the current labelled login form and observe the provider's wallet response. Backend authentication for our own platform remains separate from Pakakumi account login.
- **Database-connected local bot:** uses the same provider login/page adapter and history reader as the server. Its execution still requires confirmed acceptance and matching settlement.
- **Fully local player:** uses the identical provider login/page adapter. No shared database or web-server is required.
- **Web frontend:** uses our platform's authentication/API and queues player sessions through the server. It does not scrape Pakakumi or contain a separate provider-login selector implementation. Its existing account/balance/start flows reach the updated server and worker integration.

## Additional fix

Amount and cashout inputs alone were insufficient evidence that a player remained logged in after navigating to Crash. Both players now reject the current Login/Or Register state at startup and require a visible signed-in Bet control. If that control disappears later, observation fails and the owning session stops before filling/submitting another bet. No automatic re-login or retry of an uncertain wager was added.

The synchronized contract fixtures now reflect the supplied login's nested labels/inputs, +254 prefix and nested Login text. A separate header Login button verifies form scoping. Added regressions cover signed-out startup, later loss of Bet controls and successful HTTP login responses that still require phone verification. Fixture credentials are synthetic; no captured account values were copied into the repository.

## Validation and release

- Server production build and **23 focused browser tests** passed: 16 shared login/page contracts and seven collector DOM tests.
- Database-connected local bot type check and all **32 tests** passed.
- Fully local player type check and all **27 tests** passed.
- Frontend all **14 unit tests** passed; no frontend implementation change was required in this follow-up.
- Shared adapter and contract-test copies remain identical across the three browser integrations.

The new checks add no dependencies, migrations, database reads, provider polling or changes to collected-data retention. Use [COMBINED_UPDATE_STEPS.md](COMBINED_UPDATE_STEPS.md) to upload/deploy the updates. This follow-up remains local; production deployment has not been verified. Existing installed/deployed copies do not update themselves.

No real account was logged into and no bet, Telegram message or Supabase write was performed. A static signed-in capture establishes layout, not successful live authentication or settlement. Those private account operations remain the live-verification boundary.
