# KaamWala server

Backend for the KaamWala worker app's Telegram auto-approval flow.
Worker submits a listing -> it is PENDING -> the bot sends it DIRECTLY to
the admin's Telegram -> the admin writes `approve <id>` -> the listing
becomes live for all customers (`GET /listings` returns APPROVED only).

Node.js only, NO external dependencies — only built-ins (`http`, `fs`,
`path`, global `fetch`). Nothing to `npm install`.

## Files

- `server.js` — HTTP API + Telegram long-polling loop + JSON disk store.
- `render.yaml` — Render Web Service definition (free tier).
- `data/` — created on start. Holds `listings.json`, `admin.json`,
  `state.json`. Do not commit real worker phone numbers here.

## Endpoints

- `GET /health` — `{ ok, total, pending, approved, rejected, adminConfigured }`
- `POST /submit` — JSON body: `{ name, kaam, saal, area, phone }`.
  Validates all fields are present and `phone` is digits only (10-15 digits).
  Creates a PENDING listing and returns `{ ok, id, status }`. If the admin
  chat is known, the bot message is sent to the admin immediately.
- `GET /listings` — APPROVED listings only (what customers see).
- `GET /pending` — PENDING listings (admin/app admin view).

## Telegram behaviour

- Long-polls `getUpdates` (30s timeout) in a loop. It never crashes on a
  bad update or a network error; it logs and retries.
- `/start` from any chat: if no admin chat is set yet, that chat becomes
  the admin and is persisted to `data/admin.json`, and the bot replies
  "KaamWala admin connected. Pending listings yahan aayengi."
  If an admin is already set, a different chat is NOT made admin.
- Admin messages (only from the admin chat are acted on):
  - `approve KW-1001` -> listing APPROVED, confirmation sent to admin.
  - `reject KW-1001` -> listing REJECTED, confirmation sent to admin.
  - `approve` / `reject` as a reply to a pending listing message -> same
    effect, using the ID found in the replied-to message.
  - Anything else from the admin -> ignored, never crashes.
- If the admin chat is unknown when a listing is submitted, the listing
  stays PENDING and the server logs (without the phone number) that the
  admin chat is unknown. Send `/start` to the bot to connect the admin.

## Deploy on Render (dashboard)

Render is already empty (old service deleted) and the project is ready.

1. Put this `server/` folder in a GitHub repo (or use Render's
   "New Web Service" and connect the repo). Render reads `render.yaml`
   automatically for a Blueprint, or create the service manually with:
   Runtime Node, Build Command `echo ok`, Start Command `node server.js`.
2. In the Render dashboard, open the service -> Environment, and set:
   - `BOT_TOKEN` — paste the token BotFather gave for the KaamWala bot.
     Paste it ONLY in the Render dashboard. Never put it in chat, code,
     or this repo.
   - `ADMIN_CHAT_ID` — optional. Leave it unset and just send `/start`
     to the bot from the admin's Telegram; the server learns and saves it.
     Or set it explicitly if the chat ID is already known.
3. Deploy. The service URL will be something like
   `https://kaamwala-server.onrender.com`. Check `GET /health` there.
4. The app integration is NOT done yet (separate later build): the app
   must gain INTERNET permission and call `POST /submit` on this server
   instead of only saving locally, and `GET /listings` for the live list.

## Local test (no real token)

```sh
node --check server.js
BOT_TOKEN=TEST_DUMMY PORT=3000 node server.js &
curl http://localhost:3000/health
curl -X POST http://localhost:3000/submit \
  -H 'Content-Type: application/json' \
  -d '{"name":"Test Worker","kaam":"Plumber","saal":5,"area":"Kharar","phone":"9999999999"}'
curl http://localhost:3000/listings   # empty before approval
curl http://localhost:3000/pending   # shows the fake PENDING listing
```

With a dummy token, Telegram polling logs failures and retries — that is
expected and harmless. Never test with the real token locally in a log.

## Known limitations (first version, stated plainly)

- Disk store is ephemeral on Render free: redeploys / restarts can lose
  `data/listings.json` unless a persistent disk is attached later.
  A database (e.g. Render Postgres) is the proper next step if listings
  must survive redeploys.
- `GET /pending` has NO authentication yet. Anyone who knows the server
  URL can read pending listings. Add a simple admin key check before
  publishing the URL widely.
- Render free sleeps after inactivity (about 15 minutes idle); the first
  request after sleep takes 30-60 seconds to wake the service, and
  Telegram polling pauses while it sleeps. A paid instance or an
  external pinger removes this, but neither is set up here.
- App integration is not done: the current app build (v1.6-final) is
  still local-only with no INTERNET permission, so it does not call this
  server yet.
- Phone numbers in the store are the workers' real numbers submitted via
  the app — that is the intended customer-facing directory (customers
  call them). Example numbers in docs/tests are fake (9999999999) and
  must never be replaced with real numbers in code or docs.
