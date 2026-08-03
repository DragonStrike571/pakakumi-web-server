# Pakakumi Web Server

Express API, Better Auth, PostgreSQL/Drizzle persistence, round scraper, analytics, Telegram and Paystack services, and authenticated WebSockets.

Copy `.env.example` to `.env`, install packages and Chromium, then migrate before starting:

```text
npm install
npx playwright install chromium
npm run db:migrate
npm run dev
```

Verification: `npm run build`, `npm test`, `npm run db:check`, `npm run db:inspect`, and `npm audit`.

Production must use exact HTTPS origins in `CORS_ORIGINS`. Optional Telegram and Paystack services remain disabled when their secrets are absent. The server creates bot jobs but does not execute bets; run `pakakumi-local-bot` on the authorized local network.
