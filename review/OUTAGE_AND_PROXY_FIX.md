# Pakakumi downtime and local Nginx — 12 October 2026

The `ERR_ERL_UNEXPECTED_X_FORWARDED_FOR` log indicates that Nginx supplies forwarded client headers while Express is configured for direct access. This can group users into the proxy's rate-limit bucket. It is separate from the game provider's maintenance and from an SQL migration. See the [rate-limit error reference](https://express-rate-limit.mintlify.app/reference/error-codes#err-erl-unexpected-x-forwarded-for) and [Express proxy documentation](https://expressjs.com/en/guide/behind-proxies/).

## Changes

- Trust loopback proxies by default, with explicit address/CIDR configuration and backwards compatibility for hop counts. Do not enable unrestricted `trust proxy: true` or disable validation. Address configuration takes precedence over old hop settings.
- Reject upstream HTTP errors and incomplete round history. Independently check source progress every 30 seconds; an animated maintenance page or frozen history cannot keep collection healthy indefinitely. Bound DOM reads at 15 seconds and flag stale history after five minutes without a captured round.
- Retry indefinitely with 10/20/40/60-second backoff. The one-minute cap limits missed history after the provider returns. Close failed browser instances and clear timers on stop. Late responses after stop cannot capture new records.
- Keep durable observations and collection/analysis checkpoints. No records or round counters advance just because hours passed. Resume newer visible history chronologically and mark missing continuity if the old checkpoint has left the visible window. Values already logged as `[GAP]` with null derived metrics are unknown continuity, not a proxy error; they must not be rewritten as zero. A captured 3000x reset restores the applicable derived counters.
- `/health` reports source readiness (503 during maintenance); `/live` reports process liveness (200 while responding). Authentication, saved history, strategies, backtests and session-stop operations remain available during a source outage. New bot starts and balance checks receive a retryable 503 until collection is healthy.
- Display the source outage, last captured round and retry time in the frontend. Current signals are explicitly based on the last captured history; starting new bot sessions and balance checks is disabled during a known pause, while stopping remains possible.

## Same-VPS deployment

Set in the server environment:

```dotenv
TRUST_PROXY_ADDRESSES=loopback
HOST=127.0.0.1
```

The first setting overrides an existing `TRUST_PROXY_HOPS=0`. Keep the Nginx upstream pointed at `127.0.0.1:8000` if changing the bind address. Integrate the following headers into the existing TLS virtual host; do not replace working certificates or domain configuration.

```nginx
# In the http context, once:
map $http_upgrade $connection_upgrade {
    default upgrade;
    '' close;
}

# Within the existing server block:
location / {
    proxy_pass http://127.0.0.1:8000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
}
```

After deploying the code, build and restart the PM2 process with its updated environment:

```sh
npm run build
pm2 restart pakakumi-server --update-env
```

Validate Nginx configuration with `nginx -t` before reloading it if headers changed. During provider maintenance, verify `/live` responds 200 and `/health` responds 503 with a future retry time or a source-checking/waiting state. Do not use collection readiness failures as a reason to repeatedly restart PM2. Deploy the updated frontend with its real HTTPS/WSS build-time configuration.

## Validation and limits

Passed: server build and all **71 server regression tests**; frontend production build, lint and **14 unit tests**; all **19 production browser tests**, including both new outage/recovery cases and the existing responsive and accessibility scans. No new migration is required for this follow-up.

Tests use mocked browser responses, virtual time, synthetic API data and local loopback servers. They cover a 48-hour HTTP 503 outage, bounded continued retries, browser cleanup, unchanged history on restoration, subsequent capture without duplicate replay, busy DOM without round progress, hung DOM reads, stop/retry cancellation, late-response safety, per-client Nginx rate limits, spoofed remote forwarding, and provider-dependent operation guards. Production browser tests verify the pause banner, historical access, blocked new operations, preserved stop controls and recovery.

No live server configuration, production data or actual provider operations are changed by testing. History that the provider no longer exposes cannot be reconstructed. Last-round timestamps are capture/save times; provider event timestamps are not available in the DOM feed. `outageSince` records when this process observed the problem and resets after an application restart; the persisted last-round timestamp still shows data age.
