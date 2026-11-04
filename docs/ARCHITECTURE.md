# How Vidverse is built

Plain JavaScript (ES modules), Node.js 22 or newer, Express 5, PostgreSQL, ffmpeg. No front-end framework and no build step: the server renders HTML, and a few small scripts in `public/js` add the player, the upload progress bar and the other interactive parts. Pages work without them wherever that makes sense.

```
 browser ──HTTPS──▶ reverse proxy (you provide: TLS, HTTP/2, compression)
                        │
                        ▼
              ┌─────────────────────┐        ┌───────────────────┐
              │  web process        │        │  worker process   │  (optional: WORKER=separate)
              │  Express app        │        │  same code, no    │
              │  src/server.js      │        │  HTTP listener    │
              └───┬─────────┬───────┘        └────────┬──────────┘
                  │         │                         │
                  ▼         ▼                         ▼
           PostgreSQL    DATA_DIR on disk        ffmpeg / ffprobe
     (everything that   (uploads, HLS files,    (transcoding, thumbnails)
      must not be lost)  thumbnails, avatars)
```

With the default `WORKER=inprocess` the web process also runs the job queue, so one process is enough to try it. In production, run `src/worker.js` separately (`WORKER=separate`) so a long transcode never competes with page requests.

## Folders

| Folder | What lives there |
|---|---|
| `src/config.js` | Reads and checks every environment variable; `preflight()` lists what must be fixed before production. |
| `src/context.js`, `src/register.js` | Builds the shared `ctx` (database, logger, clock, mailer, rate limiter) and wires the services onto it. Tests build the same `ctx` with a fake clock. |
| `src/db/` | `index.js` wraps either the `pg` driver (production) or PGlite (an in-memory Postgres used for development and fast tests) behind one interface. `migrate.js` applies `migrations/*.sql` once each. |
| `src/services/` | All business rules, with no HTTP in them: accounts, auth, sessions, videos, pipeline, transcoder, analytics, feed, search, comments, engagement, moderation, notifications, monetization, payments, revenue, content (help and legal pages, the assistant), jobs, maintenance, audit, mailer. |
| `src/web/routes/` | HTTP only: read the request, call a service, pick a page. |
| `src/web/views/` | HTML as tagged template literals. The `html` tag escapes everything inserted into it unless it is marked as already safe. |
| `src/web/middleware/` | Security headers and CSP nonce, session and CSRF context, errors. |
| `src/lib/` | Small pure helpers: crypto, TOTP, money, ranking, rate limiter, validation, password policy. |
| `public/` | CSS, scripts, icons. The hls.js player library and the fonts are served from `node_modules`. |
| `content/` | Help articles and legal pages in Markdown. `{{#flag}}` blocks show or hide text depending on what is actually switched on (ads, payments, assistant). |
| `tests/`, `e2e/` | Automated tests (see `TESTING.md`). |

## A request from start to finish

1. Request log line (id, method, path, status, time; never the query string or any body).
2. `securityHeaders`: a fresh CSP nonce and the fixed headers (see `SECURITY.md`).
3. Static files (CSS, JS, fonts, the player library).
4. `/robots.txt`, `/sitemap.xml`, `/ads.txt`, `/api/health`.
5. Media files (`/media/...`). These run before the session step so public files cost no session lookup. A video that is not public checks the session cookie itself (private: owner and staff only; unlisted: anyone holding the link), and anything the viewer may not see answers 404, never 403, so private ids cannot be probed.
6. `requestContext`: reads the session cookie, loads the member, sets the CSRF token cookie.
7. Body parsers, then CSRF protection for anything that changes data.
8. The terms gate: a signed-in member who has not accepted the current terms version is sent to accept them.
9. The route, which calls services and renders a page with `res.page(...)`.
10. `notFoundHandler`, then `errorHandler` (a plain page for people, a short JSON body for the API, never a stack trace).

## Data

PostgreSQL holds everything that must not be lost. One migration (`001_init.sql`) creates the tables:

- **People:** `users`, `sessions`, `email_tokens`, `audit_log`.
- **Videos:** `videos`, `video_view_days` (one row per viewer per video per day; the source of watch time), `video_votes`, `comments`, `subscriptions`, `watch_history`, `user_watch_days`, `watch_later`, `notifications`.
- **Operations:** `jobs` (a durable queue; workers take jobs with `FOR UPDATE SKIP LOCKED`), `reports`, `contact_messages`.
- **Money:** `payments`, `webhook_events`, `ledger_entries`, `payout_profiles`, `payouts`, `revenue_batches`, `revenue_allocations`.

Search uses Postgres full-text search plus trigram similarity (`pg_trgm`), so there is no separate search server.

**Time.** Any time the application later compares with "now" (session expiry, the payout hold, the daily upload limit, clean-up) is written by the application's own clock (`ctx.clock`), not by the database's `now()`. In production the two agree; in tests the clock is moved by hand, and a row stamped by the database would then disagree with it. Columns that merely default to `now()` (for example `audit_log.created_at` or `ledger_entries.created_at`) are only shown or sorted, never compared. See "Clocks and dates" in `TESTING.md`.

The files themselves (uploads, HLS segments, thumbnails) are on disk under `DATA_DIR`. See "What this design cannot do yet".

## Video pipeline

1. A creator creates a draft in Studio and uploads the file with one streaming `PUT`. The server checks the first bytes of the file (not the name or the declared type), the size and the daily and storage quotas.
2. A `transcode` job is queued. The worker probes the file with ffprobe and checks the duration limit.
3. ffmpeg makes adaptive HLS (H.264 and AAC) at up to 1080p, 720p, 480p, 360p and 240p (profile `standard`) or a single 360p (profile `fast`), plus thumbnails.
4. The video becomes `ready`. The watch page plays it with hls.js (or the browser's own HLS support), and the creator is notified.

ffmpeg runs on strangers' files, so: the container is chosen from the file's bytes and forced with `-f`; `-protocol_whitelist file` means it cannot reach the network; arguments go in as an array (no shell); every run has a timeout and capped output.

## Counting views honestly

The player sends a heartbeat every few seconds while playing. The server does not trust the number the player reports. The credit for one report is limited by the time since the previous report, a per-report cap, and the total time since the first report of that viewing. A view counts after 30 seconds of credited watching (or half of a shorter video), once per viewer per day, at most three full watches per day. The owner and known crawlers are never counted. Reports from one viewer take turns (a database lock per viewer, video and day), so a burst of simultaneous reports cannot each be credited in full.

The viewer is identified for counting by a keyed hash that changes every day, so the site can count unique viewers but cannot follow a person from one day to the next.

## Ranking

`src/lib/ranking.js`. A video's score is roughly:

```
log10(views + 10) × (average share watched)² × (like ratio)^0.5 × freshness^0.7 × exploration × affinity
```

The average share watched is squared, on purpose: a title or thumbnail that gets clicks and then loses the viewer within seconds is demoted, and one that delivers what it promised rises. A video with little data is judged against a prior (0.4, worth 15 viewings) so a few viewings do not decide its fate, and new videos get a short exploration boost. "Affinity" favours channels a signed-in member already watches. The Trending page explains this in plain words.

## Money

See `MONETIZATION.md` for what the money rules are and why. In code:

- Amounts are whole paise (integers) everywhere. There is no floating-point money.
- `ledger_entries` is append-only. A balance is always the sum of entries, never a stored number someone can overwrite. A database constraint stops the same payment or payout being booked twice.
- A tip becomes money only when a webhook with a valid signature says so. The webhook is processed in one transaction that records the event id first (so retries do nothing), locks the payment row, checks the amount, and writes the ledger entries.
- A payout request takes a lock on the member's row, checks there is no open request and that the balance covers it, and writes the request and its ledger entry together. A partial unique index is a second layer of the same rule.
- Payout details are encrypted with AES-256-GCM, bound to the member (so one member's ciphertext cannot be pasted into another's record), and shown back only as a short hint.

## The assistant and help

`content/help/*.md` are the help articles. The assistant first finds the passages of those articles that best match a question. Without an `ANTHROPIC_API_KEY` it answers by quoting the best article. With a key, it asks the model to answer using only those passages, and falls back to the article if the model is unavailable or exceeds its daily call limit. It is not told anything about the member, and the model is never asked to decide anything about money or accounts.

## What this design cannot do yet

These are consequences of choices made to get a small, checkable foundation:

- **One machine for media.** Uploads and HLS files are on local disk. To run several web servers you need a shared volume, or the storage layer (`src/services/storage.js`) replaced with object storage plus a CDN. This is not built.
- **Per-process rate limits.** The limiter lives in memory, so with several web processes each has its own counters.
- **No streaming CDN, no DRM, no live streaming, no captions upload, no playlists, no community posts.**
- **Heartbeats are individual database writes.** Fine for a small site; at large scale they should be batched or moved to a queue.
- **No automated scanning of uploads** for illegal or copyrighted material. There is a report flow, moderator tools and a takedown process; people do the checking. See `STATUS.md`.
