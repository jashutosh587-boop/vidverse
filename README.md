# Vidverse

A video-sharing website in plain JavaScript, built as a **working, tested foundation** rather than a finished product: people upload and stream videos, subscribe, comment and search; creators can earn from viewer tips; the owner can earn from Google AdSense; there is a help centre with an assistant, legal pages, moderation, and a security design you can read.

Version 0.1.1 (what changed: [`CHANGELOG.md`](CHANGELOG.md)). **Read [`docs/STATUS.md`](docs/STATUS.md) before anything else.** It lists, feature by feature, what has been tested, what has not, what needs accounts only you can open, and what does not exist.

## What it is, and what it is not

- It **is** a small YouTube-shaped site: upload, adaptive streaming (HLS), search, channels, likes, comments, subscriptions, history, watch later, notifications, a creator Studio with analytics, an admin console, a help centre and an assistant.
- It **is** careful with money: integer paise, an append-only ledger, signed payment webhooks, holds, manual payouts, and tests that fire simultaneous requests at a real PostgreSQL server.
- It is **not** "more advanced than YouTube". It has none of YouTube's scale, live streaming, Shorts, captions or machine-learning recommendations.
- It does **not** use click-bait or compulsion tricks to get attention. Misleading titles are demoted in the ranking, and members get tools to limit their own time. See [`docs/MONETIZATION.md`](docs/MONETIZATION.md).
- It will **not make money by itself**. Ads and tips pay nothing without viewers, and delivering video costs money for every viewer. `npm run economics` shows the arithmetic.
- Creators cannot be paid a share of AdSense income. Google's rules forbid passing it on without written permission. Creators earn from tips, their own support links and revenue-share batches you fund from other money.

## Try it in five minutes (no accounts, no database to install)

You need Node.js 22.12 or newer and `ffmpeg`.

```
npm install
npm run demo          # then open http://127.0.0.1:3000
```

The demo starts the site with throwaway data: three creator channels with a few generated test-pattern videos, and a viewer account (the password is printed when it starts). Nothing is saved when you stop it. Payments run in a practice mode that never moves money.

For a development copy that keeps its data in `./data`:

```
cp .env.example .env     # for development you can delete almost everything in it
NODE_ENV=development npm run dev
```

## Putting it online

For one rented Ubuntu 24.04 server there is an installer (`deploy/install.sh`) that sets up the database, video processing, HTTPS, nightly backups and a closed-beta password, plus a `vidverse` command for everyday jobs (status, logs, backup, restore, test email, make an administrator). The steps, costs, and what was and was not tested are in [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md). It has not been run on a real server yet.

## Commands

| Command | What it does |
|---|---|
| `npm run demo` | Throwaway demo site with sample videos |
| `npm run dev` / `npm start` | Run the site (reloads on change / production) |
| `npm run worker` | Run only the video-processing worker (`WORKER=separate`) |
| `npm run migrate` | Apply database migrations and exit |
| `npm run make-admin -- you@example.com` | Make a confirmed member an administrator |
| `npm run mail-test -- you@example.com` | Send one test email with the site's mail settings and explain a failure |
| `npm run economics -- --views 100000` | Back-of-envelope cost and break-even model (placeholder prices) |
| `npm test` | Unit and HTTP tests on an embedded database |
| `TEST_DATABASE_URL=postgres://… npm run test:postgres` | The same tests on a real PostgreSQL server, plus simultaneous-request tests |
| `npx playwright install chromium`, then `npm run e2e` | Browser tests in real Chrome |
| `npm run lint` / `npm run check` | Lint / lint and tests |
| `npm run break-it -- --list` | Remove defences on purpose to prove the tests notice |

## Where to read next

| Document | For |
|---|---|
| [`docs/STATUS.md`](docs/STATUS.md) | What is real, what is untested, what needs accounts, what is missing |
| [`docs/MONETIZATION.md`](docs/MONETIZATION.md) | How money works: AdSense, tips, payouts, revenue sharing; the rules that shaped it |
| [`docs/SECURITY.md`](docs/SECURITY.md) | What is protected and how, and what is not covered |
| [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) | Putting it on a server with the installer; backups and restoring; troubleshooting; scaling; the checklist before going public |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | How it is built |
| [`docs/TESTING.md`](docs/TESTING.md) | What the tests do and do not prove |
| [`.env.example`](.env.example) | Every setting, explained |

## Before you launch

1. Have a lawyer review the legal pages in `content/legal/`. They are templates.
2. Take advice before turning on live tips (Indian payment-aggregator rules). Payments are off by default.
3. Apply for AdSense on your own domain, and set up a consent message for visitors in the EEA, UK and Switzerland if you serve them.
4. Decide who handles reports, takedowns and the grievance mailbox, and how quickly.
5. Start as a closed beta (the installer's default), and work through "Before you open the site to the public" in [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) before turning the password off.

## Licence

No licence file is included. Choose one before you publish the code. The dependencies carry their own licences; they were not audited for compatibility.
