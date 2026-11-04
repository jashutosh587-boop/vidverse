# How Vidverse was tested, and what that does and does not prove

"Tested" in `STATUS.md` means one of the layers below ran against the feature and passed. It never means a real payment, a real ad or a real stranger. The last section lists what has not been exercised.

| Layer | What it is | Count at packaging | Run it with |
|---|---|---|---|
| Unit and HTTP tests | The real app (routes, SQL, templates, services, real ffmpeg) on an embedded Postgres, driven by real HTTP requests and a fake clock. Since 0.1.1 this includes 12 installer and helper tests (`tests/deploy.test.js`, below) | 376 tests (the 0.1.0 package had 360; since then 12 installer tests and 4 mail-test tests) | `npm test` |
| The same suite on a real PostgreSQL server, plus tests that fire simultaneous requests | PostgreSQL 16.15 through the `pg` driver used in production | 377 tests at 0.1.0 (360, plus 17 that need a real server), also with the computer's clock moved. **Not re-run for 0.1.1**: the application code is unchanged (see "What changed in 0.1.1") | `TEST_DATABASE_URL=postgres://… npm run test:postgres` |
| Browser tests | Real Chrome (Playwright): a desktop journey, a phone, and the ad slots | 44 tests (24 desktop, 10 phone, 10 ads). **Not re-run for 0.1.1**, for the same reason | `npx playwright install chromium` once, then `npx playwright test` |
| Accessibility scans | axe-core inside the browser tests, light and dark, every kind of page | part of the above | same |
| Lint | ESLint, no warnings allowed | – | `npm run lint` |
| Break it on purpose | Remove one defence at a time and check a test fails | 27 breakages: 24 always caught, 1 sometimes, 2 survive on purpose (0.1.0 results; the code they break is unchanged) | `npm run break-it -- --list` |
| Installer rehearsal and restore drill | By hand, in a test sandbox: the installer on a clean copy of Ubuntu 24.04, then a backup and restore drill | See "Installer and restore: what was run". The scripts that drove them depend on the sandbox and are not part of the project | – |

`npm run check` runs lint and the unit tests.

## Unit and HTTP tests

`tests/*.test.js`, using Node's built-in test runner (no framework). Each file starts the actual application on a free port with its own database and a clock the test can move, then talks to it over HTTP with a small client that keeps cookies and handles CSRF tokens like a browser does. Only the edges are fake:

- email goes to memory (the tests read the sign-up and reset messages from there);
- payments use either the practice provider or a stand-in for Razorpay's HTTP API with real HMAC signatures;
- the help assistant's model call goes to a stand-in for Anthropic's API;
- ffmpeg is real, and small sample videos are generated at test time.

They cover sign-up, sign-in, lockout, two-step codes, sessions, settings, export and deletion; upload, processing, visibility and media access; watching, counting, ranking, comments, likes, subscriptions, history; moderation and the admin console; the help centre and legal pages; ads; tips, webhooks, ledger, holds, payouts, refunds, revenue sharing, statements; the hourly clean-up job and every rule that compares a stored time with now; configuration and the production start-up checks.

## Real PostgreSQL, and races

The default test database is PGlite, PostgreSQL 18 compiled to WebAssembly. It is quick and needs nothing installed, but it has **one connection**: it runs statements one after another and can never show a race. Production uses the `pg` driver with a pool of connections. So the whole suite can also be run against a real server:

```
TEST_DATABASE_URL=postgres://postgres:secret@127.0.0.1:5432/postgres npm run test:postgres
```

Use a throwaway server. Each test app creates a database named `vv_test_<pid>_<random>` there and drops it when it closes; the user needs the right to create databases.

`tests/concurrency.test.js` runs only in that mode (otherwise it is reported as skipped, with the reason). It fires bursts of identical requests at the same moment and checks the books afterwards, not the replies:

- a burst of first watch reports from one viewer is one viewing, for an anonymous viewer and a signed-in one, while different viewers at once are all counted;
- a burst of payout requests makes one request and takes the money once (and the losers are told a request is already open);
- paying and declining the same payout at the same instant: exactly one decision, and the ledger agrees with it;
- cancelling one payout many times at once returns the money once;
- the same payment notification delivered many times at once, and under many different event ids, credits once with no delivery failing;
- many sign-ups with one email, or one handle, at once make one account and no error page;
- many subscribe clicks leave one subscription;
- several workers claiming jobs at once get a job each, and a worker is not made to wait for a job another worker is busy with;
- the platform and creator ledgers still add up to everything paid in.

**This found a real bug** that all the other tests, on both databases, had missed: eight simultaneous *first* watch reports from one viewer were each credited in full (the lock that should have made them take turns had no row to lock yet), so one viewer could multiply a video's watch time and, on short videos, its view count. It is fixed with a per-viewer lock, and the test fails again if the fix is removed.

## Clocks and dates

The application reads the time from one clock it is given, and the tests move that clock by hand ("eight days later"). That is only sound if every time the application compares with that clock was also stamped by it. At first this was not true: new videos, subscriptions and notifications were stamped by the database's own `now()`. A test of the daily upload limit passed when it was written and failed a few hours later, once real time had moved past the time of day the test pretended it was. The same mix-up would have made the notification clean-up, the "new subscribers" figure and the deletion of abandoned uploads depend on the date the tests happened to run. Those rows are now stamped by the application's clock, and `tests/maintenance.test.js` (the hourly clean-up job and each rule that compares a stored time with now) fails on any date if that is ever undone.

To check that nothing else depends on today's date, the whole embedded-database suite was run with the computer's clock moved, using `faketime` (Linux: `apt install faketime`), to five dates: the real one, 2027-03-15 23:50, 2026-01-10 02:00, 2026-11-04 09:55 and 2026-11-05 10:30. All five runs passed. To repeat one: `faketime '2027-03-15 23:50:00' npm test`. This matters for the tests only; in production the application's clock is the real clock.

## Browser tests

`e2e/`, with Playwright in real Chrome. A script (`e2e/server.mjs`) starts the real application with practice payments and a quick transcoding profile; the tests then behave like people:

- **Desktop journey** (24 tests, run in order as one story). A stranger sees a working empty front page and a theme switch that sticks, and is turned away from Studio. A creator signs up, confirms the email, signs in, uploads a real video, waits for processing and picks a cover. A viewer finds it and plays it (adaptive stream, quality list, speed, keyboard keys); watching long enough counts as a view and a few seconds does not; it resumes where the viewer stopped and appears under "Continue watching". Like, subscribe, watch later and comment; search suggestions; the channel page and the subscriptions feed; a tip in practice mode, with the money shown as held; the help assistant; signing out; two-step verification with real one-time codes and each recovery code used once; hostile names shown as text; the page policy and cookies in a real browser; another website that can neither act for a member nor put the site in a frame; keyboard use; the admin pages (the ones that can move money wait for two-step verification) and everyday members shut out of them; two accessibility scans. Last comes autoplay: a video played to its end moves on to "Up next", "Play now" skips the wait, the third in a row stops to ask "Still watching?", "Keep watching" and "Cancel" behave, and switching autoplay off is remembered. **Any console error, failed request or Content-Security-Policy violation fails the test that caused it.**
- **Accessibility**: axe-core scans every kind of page, signed out and signed in, light and dark (98 page-and-theme combinations), with WCAG 2.2 rules for A and AA plus best practices.
- **Phone** (Pixel 7 emulation, 10 tests): nothing sticks out sideways, the menu is operable and hidden items cannot be tabbed to, tap targets are large enough (24 px minimum everywhere, 40 px or more for buttons and fields), 200% text still fits, sign-up and watching work on a touch screen.
- **Ads** (10 tests, with a stand-in for Google's script served from a second local server): slots appear only where the rules say, never for the owner or staff, a report pauses them, empty slots vanish with their label, the looser ad-page policy still blocks an injected inline script, and the strict policy applies everywhere else.

Browser tests found bugs the other layers did not: a closed mobile menu that could still be tabbed to, icon-only links with no name, tap targets that were too small, headings in the wrong order, duplicate landmarks, a dark-theme button with too little contrast, a banner shown twice, and an error log line for every refused media file. Reading the server's log after a browser run found one more: a player that gave up on a video segment (a viewer skipping ahead, or closing the tab) was logged as a failed request with status 500. It is not a fault on our side, so it is no longer logged as one, and a test now opens a real socket, abandons a 32 MiB download half way and checks that nothing is logged.

## Break it on purpose

A passing test only tells you something if it would fail when the code is wrong. `scripts/break-it.json` lists changes that remove one defence (stop checking the CSRF token, stop escaping HTML, remove a row lock, accept an unsigned webhook…). `npm run break-it -- <name>` makes the change, runs the tests that should notice, reports, and restores the files byte for byte.

Result at packaging. "Caught" means at least one test failed when the defence was removed:

| Change | Database | Result |
|---|---|---|
| CSRF: token no longer checked | embedded | caught |
| CSRF: `Origin` and `Sec-Fetch-Site` no longer checked | embedded | caught |
| Studio: ownership check removed | embedded | caught |
| Templates: HTML no longer escaped | embedded | caught |
| Money: tips available at once (holding period removed) | embedded | caught |
| Payouts: application check for "one open request" removed | embedded | caught |
| Payouts: that check **and** the database index removed | embedded | caught |
| Payouts: row lock removed | embedded | **survives** (see below) |
| Moderation: a report can be decided twice | embedded | caught |
| Views: cumulative cap on reported watch time removed | embedded | caught |
| Payments: webhook accepted without checking its signature | embedded | caught |
| Ads: shown to the video's owner and to staff | embedded | caught |
| Logging: secret-looking fields no longer hidden | embedded | caught |
| Views: per-viewer lock removed | real Postgres | caught |
| Payouts: row lock removed | real Postgres | money stays safe; confusing message to the loser in about 3 runs of 5 |
| Payouts: unique index removed | real Postgres | **survives** (see below) |
| Payouts: row lock **and** unique index removed | real Postgres | caught |
| Webhook: lock on the payment row removed | real Postgres | caught |
| Payouts: a decline no longer checks the request is still open | real Postgres | caught |
| Job queue: `SKIP LOCKED` removed | real Postgres | caught |
| Sign-up: "already taken" from the database not handled | real Postgres | caught |
| Clocks: new videos stamped with the real clock instead of the application's | embedded | caught |
| Clocks: new notifications stamped the same wrong way | embedded | caught |
| Clocks: new subscriptions stamped the same wrong way | embedded | caught |
| Housekeeping: notifications removed after 9 days instead of 90 | embedded | caught |
| Housekeeping: an unfinished upload deleted at once instead of after a day | embedded | caught |
| Job queue: a job still being worked on is treated as dead after a millisecond | embedded | caught |

That is 27 breakages. 24 were noticed every time we tried, 1 is a race that is noticed in some runs (the payout row lock on real Postgres), and 2 survive on purpose.

The two survivors are the point of defence in depth, not a gap: payouts are protected twice (a row lock **and** a partial unique index), so removing either one alone changes nothing about the money, while removing both is caught. The embedded database cannot show the lock at all because it has one connection.

Breaking things also improved the tests. A burst of simultaneous job claims did **not** notice that `SKIP LOCKED` was gone (the statements are too quick to overlap), so a deterministic test now holds one job's row lock on a second connection and checks that a worker moves on to the next job instead of waiting.

## What changed in 0.1.1

Only deployment: the `deploy/` folder (installer, `vidverse` helper command, backup script, service files, Caddy template), `scripts/mail-test.js`, `tests/deploy.test.js`, four more tests in `tests/scripts.test.js`, a comment and the `HOST` setting in `.env.example`, and documentation. The website's own code (`src/`, `public/`, `content/`, the migration, the browser tests) is byte for byte what the 0.1.0 package shipped: the two packages were compared file by file. That is why the real-PostgreSQL, browser and break-it results above were not repeated.

## Installer and helper tests (automated)

`tests/deploy.test.js` (12 tests, run by `npm test` wherever `bash` exists, otherwise skipped with the reason). They install nothing. They check that:

- the installer, the helper and the backup script are valid bash;
- 24 awkward settings values (spaces, `#`, quotes of every kind, `$`, backslashes, non-Latin text) written the way the installer writes them are read back **by the site's own settings parser** exactly as typed, and a value that cannot be stored safely is refused;
- the settings-file reader keeps what is typed, never executes the file, and refuses a misspelled name or spaces around `=`, naming the line;
- the example settings file uses only settings the installer knows and switches on every required one;
- **the settings file the installer would write passes the site's own production start-up checks** (the ones that make the site refuse to start), listens on `127.0.0.1` only, uses the separate worker, keeps payments off and the legal pages marked unreviewed;
- every setting the installer writes is documented in `.env.example` (this found the missing `HOST`);
- the service files use the user, folders and commands the installer sets up, and the Caddy file proxies to the site and imports the password file the helper writes;
- the restore command copies the two secret keys exactly (only the exact key, no temporary file left, the right permissions), does every check before its first change, and keeps the two faults from the restore drill (below) fixed.

To see whether these tests would notice a mistake, 23 deliberate breakages were made in throw-away copies of the project (the site listening on every address, the wrong port, a value quoted wrongly, the wrong user in a service file, the safety backup's clean-up switched back on, and so on). All 23 were noticed, each by the test that is meant to guard it. (Two earlier attempts at a breakage were not real tests of anything: one broke the script's syntax, one changed nothing that mattered. They were replaced, and a first draft of the key-copy test missed a breakage until its example was reordered. These are the kinds of weakness this exercise exists to find.) What these tests cannot catch: whether the service files work under a real systemd, and the data-folder safety check in `vidverse restore` (only the sandbox drill exercises that one).

## Installer and restore: what was run (by hand)

Setting: a test sandbox with a clean Ubuntu 24.04 (the supported system), real PostgreSQL 16.15, ffmpeg 6.1.1, Caddy 2.6.2 and Node.js 22. Stand-ins, because the sandbox has none of them: **systemd** (a small program started and stopped the same commands, as the same user, in the same folder and with the same settings as the service files say; the service files themselves were checked with `systemd-analyze verify`, which is clean, but never started by systemd), **DNS** (a hosts-file entry), **the certificate authority** (Caddy's own local one), and **the mail provider** (a local mail server with TLS and login).

- **First install:** exit 0 in 1 minute 50 seconds, website and worker answering. The settings file it wrote passes the site's production checks; an operator address with a `#` in it appears on the legal pages exactly as typed.
- **23 refusals**, each of which must stop before changing anything and say what to fix: no settings file, an unreadable one, a required value empty, example text left in (name, domain, sender), a misspelled setting, `https://` or capitals in the domain, a bad email address, a bad mail URL, a bad number, a bad on/off value, a too-short beta password, a line without `=`, all three kinds of quote in one value, not running as root, Debian, Ubuntu 22.04, running from the wrong folder, a domain that does not exist yet, and a domain that points to another machine. All 23 stopped with the intended message.
- **Used over HTTPS through the beta password** (8 of 8 checks): no password and a wrong password are refused and the health check is open; HSTS, the content-security policy and `__Host-` cookies survive the proxy; the legal pages show the operator's details and the draft notice; the sign-up email arrives over TLS with links to the right address; confirm, sign in, upload; the worker service processes the video; the playlist, a segment and a range request are served; and 200 requests with the password stay quick (4 to 30 ms each in different runs). A scripted Chromium then played the video through the password prompt.
- **Worker restarted during processing:** recovers by itself (the video is recorded as failed and retried about 30 seconds later).
- **Update:** 17 seconds; settings kept; a backup first; the new code installed beside the old and switched in one step. A deliberately broken new version produced the message that tells the operator how to fix a setting or go back.
- **Node.js download** (against a local copy of nodejs.org's release folder, because the sandbox cannot reach the real one): a good download installs; a tampered one is refused with nothing installed; a release list with no build for the processor, an unreachable server, a version that is too old, and a copy the site's user cannot run are each refused.
- **DNS check:** accepts a name that points here; refuses one that points elsewhere; warns about a wrong IPv6 record; can be skipped.
- **Helper commands:** status, logs, make-admin, mail-test, backup, and the beta password on and off.
- **Static checks:** shellcheck 0.11 is clean on all three scripts.
- **Restore drill:** back up a working site; turn it into a "brand-new server" (empty database, no videos, new secret keys, one new account); try 16 bad or unconfirmed restores (a missing, unfinished, damaged or incomplete backup, a missing or empty key, two folders, an unknown option, no confirmation, a wrong answer at the prompt, a data folder the site's user does not own): all refused, nothing changed; restore for real; check that the database (every table's row count and a hash of its rows, apart from the job queue, which the restarted worker touches), the videos (a hash of every file) and the two keys are exactly the backup's, that every other setting stayed, that the files belong to the site's user, and that the old site works over HTTPS (the old account signs in, the video plays, the new account is gone); undo with the safety backup and check the "brand-new server" is back; restore the oldest backup of a full set; make a backup straight afterwards. 48 of 48 checks. It found two faults, now fixed and guarded by tests: with seven backups already kept, restoring the oldest deleted it while the safety backup was being made, after the database was dropped (the site was left stopped, with a safety backup and instructions); and the restarted services inherited the backup lock, so no later backup could run.

## What has not been exercised

Be careful to read this list before relying on any claim above:

- **No real external service.** Never contacted: Razorpay, Google AdSense and its ad script, a real mail provider (a local stand-in mail server with TLS and login was used), Anthropic's API, a CDN, a hosting provider, a certificate authority, nodejs.org. Each has a stand-in in the tests (with real signatures for Razorpay), and a stand-in only proves the code does what we expected the service to do.
- **Other browsers and real devices.** Chrome only (Chromium 153 via Playwright, with H.264 playback). Firefox, Safari (which plays HLS natively through a different code path), real phones and old devices have not been tried.
- **Load and size.** No load test. No 2 GiB upload, no 3-hour video, no thousands of simultaneous viewers.
- **People.** No human accessibility review with a screen reader, no usability test, no outside security review or penetration test.
- **Deployment.** The installer and the restore command have **never run on a real server**: not with a real systemd (the service files were only syntax-checked, and a stand-in started the same commands), not through a reboot, not with a real certificate, a real DNS record or a real mail provider, not on an ARM server, and not with the real nodejs.org download (its logic ran against a local copy). The beta-password prompt was exercised by a scripted browser and by plain requests, not in a person's own browser. Restoring a backup into an older version of the code was not tried. The `Dockerfile` and `docker-compose.yml` have never been built. There is no migration upgrade test (there is only one migration).
- **Money in the real world.** No reconciliation against a payment provider's statement; no tax calculation; no legal review.
