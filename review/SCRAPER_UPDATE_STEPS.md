# Update the history collector

**Use [COMBINED_UPDATE_STEPS.md](COMBINED_UPDATE_STEPS.md) for the current deployment.** It includes this collector fix and both subsequent updates. The instructions below describe this earlier checkpoint.

These changes are currently local. They must be committed and pushed before your VPS can receive them with `git pull`.

On the VPS, paste one command at a time and press Enter. Stop if a command reports an error, and paste that error here.

```bash
cd /var/www/pakakumi-web-server
```

```bash
git pull
```

Open your settings:

```bash
nano .env
```

Find the `PAKAKUMI_URL` line and change it to this. If it is missing, add it:

```text
PAKAKUMI_URL=https://pakakumi.com/crash
```

Save with **Ctrl + O**, then **Enter**. Exit with **Ctrl + X**. Keep the other settings.

Build the updated code:

```bash
npm run build
```

Your supplied logs call the program `pakakumi`, so restart that program:

```bash
pm2 restart pakakumi --update-env --kill-timeout 20000
```

Read its messages:

```bash
pm2 logs pakakumi --lines 30
```

Look for **Scraper started and listening for rounds**, followed by **Saved round** messages. **Ctrl + C** exits the log view without stopping collection.

If PM2 says `pakakumi` was not found, run `pm2 list`; use the name in that list instead. An installation named `pakakumi-server` uses that name in the restart/log commands.

The collector fix adds no dependencies or database schema changes. The subsequent page-integration follow-up also updates frontend analysis wording and both local players; follow `review/PAGE_UPDATE_STEPS.md` for those projects. If the browser executable is reported missing after an earlier package update, run `npx playwright install chromium`, then the restart command again.

Captured multipliers should resume. The new site shows a different/partial player table, so its unverified financial values remain null. That is separate from the history-selector failure. During actual provider maintenance the collector continues retrying, with checkpoints retained.
