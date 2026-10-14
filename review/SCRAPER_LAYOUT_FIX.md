# Crash history layout fix

The reported startup timeout was waiting for `table.css-1a87jyo tbody`. Read-only inspection of the public game confirmed that `play.pakakumi.com` redirects to `https://pakakumi.com/crash`. The current game renders forty newest-first crash values as direct span children of a history strip, with no old history table.

The collector now identifies a complete numeric history strip by its structure instead of a generated CSS class. It retains support for the legacy history table and single-column history tables, rejects malformed/partial/conflicting displays, and excludes player tables and numeric form inputs. Startup waits for usable history, not merely an element. The MutationObserver handles text changes and replacement of history; each independent source probe reattaches it if the whole wrapper was replaced. Existing checkpoint, chronological recovery, retry and data-gap behavior remains.

A second recovery defect was found during real-browser testing: `removeAllListeners("disconnected")` deleted Playwright's own listener that resolves `browser.close()`. Startup failures could then hang in cleanup before scheduling the next retry. Cleanup now keeps those listeners; the existing identity check ignores callbacks from a detached browser. The real-browser maintenance regression verifies completed close and a scheduled retry.

The new player table has `User / Bet KES / @ / Win` columns and may show only part of the players. Its Win column is not treated as the former net-profit column. Round multipliers are collected; unverified player/financial metrics remain null, with `metricsComplete=false`. Reserve funds stay unknown until a valid reset under the existing rules. No fabricated zero totals or new database schema are introduced.

## Validation

The final server build and all **79 regression tests** passed.

Six real-browser regressions cover the new layout with changed CSS classes, text/element/wrapper mutation, old financial-layout compatibility, rejection of unrelated/incomplete data, one captured next round, and actual browser cleanup after HTTP 503. Existing durable-inbox and 48-hour outage regressions are retained.

The compiled collector was also run against the public live page with a temporary in-memory capture handler: it read 31 recoverable history windows, then captured a fresh **1.33x** round through the observer, remained healthy and stopped cleanly. This smoke check did not write to Supabase, send Telegram messages, log in, or place bets. Public DOM diagnostic files were removed after inspection.

Follow [SCRAPER_UPDATE_STEPS.md](SCRAPER_UPDATE_STEPS.md) for just this fix, or [SIMPLE_UPDATE_GUIDE.md](SIMPLE_UPDATE_GUIDE.md) for the broader update. Set `PAKAKUMI_URL=https://pakakumi.com/crash` in the existing `.env`; the old URL is still followed when supplied, but the direct URL avoids the redirect. The example and default now use the direct route. Build and restart the existing PM2 process after the source is published. This fix is local and has not been deployed or pushed by Codex.

No frontend deployment or database migration is required for this follow-up. The previous proxy and reliability settings remain in effect. Tests on Windows use installed Chrome by default; Linux uses Playwright Chromium. `PLAYWRIGHT_TEST_CHANNEL` can select another installed test browser. Install Chromium with the project's Playwright CLI when its package version changes.
