# Update the page integrations

**Use [COMBINED_UPDATE_STEPS.md](COMBINED_UPDATE_STEPS.md) for the current deployment.** It combines this update, the preceding collector fix and the later cross-project reliability changes. The instructions below describe this earlier checkpoint.

These changes are on this computer. Your VPS can receive them with `git pull` only after they have been committed and pushed to your repository. The two local-player folders currently have no Git repository, so `git pull` cannot update those folders.

## 1. Web-server on the VPS

Use your usual VPS terminal. Paste one command at a time, press Enter, and stop if it reports an error.

```bash
cd /var/www/pakakumi-web-server
```

```bash
git pull
```

```bash
nano .env
```

Find `PAKAKUMI_URL` and change it to the line below. Add it if missing. Keep your other settings, including `TRUST_PROXY_ADDRESSES=loopback` for your same-VPS Nginx setup.

```text
PAKAKUMI_URL=https://pakakumi.com/crash
```

Save with **Ctrl + O**, press **Enter**, then exit with **Ctrl + X**.

```bash
npm run build
```

Your latest supplied logs name the server `pakakumi`:

```bash
pm2 restart pakakumi --update-env --kill-timeout 20000
```

```bash
pm2 logs pakakumi --lines 30
```

If PM2 says that name was not found, run `pm2 list` and substitute its existing server name (for example `pakakumi-server`) in those last two commands. **Ctrl + C** exits the log display without stopping the server.

This follow-up adds no dependencies, database migrations or extra Supabase polling. Existing browser installations remain valid. If Playwright explicitly reports a missing browser executable, run `npx playwright install chromium` in this server folder, then repeat its restart command.

## 2. Frontend

Use the frontend's existing hosting update process. The frontend change clarifies the model labels on the Analysis page and needs no new environment settings.

If you normally deploy it from a terminal, open its actual folder using your usual `cd` command. Then run these separately:

```bash
git pull
```

```bash
npm run build
```

If PM2 hosts your frontend, run `pm2 list` and restart **its** existing program name. If a Git-connected host builds it for you, use that host's normal deployment. The frontend's deployed folder and PM2 name have not been verified, so this guide does not invent them.

## 3. Local bot or fully local player

Stop a running player before replacing its files. On this computer, the updated folders are:

- `C:\Truth\Pakakumi\pakakumi-local-bot`
- `C:\Truth\Pakakumi\pakakumi-fully-local-player`

If you run the player on this computer, its updated files are already present. Open that player's folder with your usual `cd` command. For example:

```powershell
cd C:\Truth\Pakakumi\pakakumi-local-bot
```

Check the updated code:

```text
npm run check
```

Then start it using your usual method. If you normally start it directly:

```text
npm start
```

Use the fully-local-player folder instead if that is the player you use. If a player runs on another computer, transfer the updated project's source files and package.json there first, keeping that computer's existing `.env` settings. These two folders are not Git checkouts. Do not start an extra copy beside an existing worker.

The local bot now matches server records using the new history reader. Both players require confirmed acceptance and settlement; after an ambiguous bet or lost connection, check the last bet on Pakakumi before restarting. A stop for review protects the local bankroll calculation from assuming a result.
