# Status of Vidverse 0.1.1: what works, what is untested, what needs your accounts, what is not built

This is the page to believe if any other page sounds more confident. Every feature is in exactly one of four states.

| Label | Meaning |
|---|---|
| **Tested** | Automated tests ran against it and passed. `TESTING.md` says which layer (unit and HTTP, real PostgreSQL, real Chrome, break-it checks). |
| **Built, untested** | The code exists. Nothing has run it for real. A rehearsal in a test sandbox is described in the notes where there was one; it does not count as real. |
| **Needs your accounts** | The code exists and is tested against a stand-in for the outside service. It cannot do its real job until you hold an account, key or approval that nobody can give you in advance. |
| **Not built** | Does not exist. |

"Tested" is never a promise about real money, real ads or real traffic. Nothing here has met a real stranger.

## Accounts and security

| Feature | State | Notes |
|---|---|---|
| Sign-up with email confirmation, 18+ confirmation, terms acceptance | Tested | |
| Sign-in, lockout with growing delay, password reset | Tested | Same reply for unknown address and wrong password |
| Two-step verification (authenticator app) and recovery codes | Tested | Real codes in the browser test |
| Session list, sign out one or all others | Tested | |
| Download my data, delete my account | Tested | Deletion is refused while money is owed |
| CSRF protection, Content-Security-Policy, security headers, no framing | Tested | Including a real page on another origin trying to frame and to post |
| Encryption of payout details | Tested | AES-256-GCM, bound to the member |
| Rate limiting | Tested | Per process only, in memory |
| Sending real email through SMTP | Needs your accounts | Tests use an in-memory mailbox. The SMTP path (TLS, login) has been run against a local stand-in mail server, never a real provider. `npm run mail-test` / `vidverse mail-test` sends one message and explains a failure |
| Outside security review | Not built | Nobody but this project has attacked it |

## Videos and watching

| Feature | State | Notes |
|---|---|---|
| Upload, file checks, size, duration, daily and storage limits | Tested | Streams to disk |
| Processing into adaptive HLS (up to 1080p) and thumbnails, custom cover | Tested | Real ffmpeg |
| Playback with quality, speed, keyboard keys, resume | Tested | Chrome only. Safari's own HLS path and old browsers are not tried |
| Public, unlisted and private videos | Tested | Private ids answer 404 |
| Home, trending, subscriptions feed, search with suggestions | Tested | Search is Postgres full-text plus trigram |
| Likes, comments, subscriptions, watch later, history, liked videos, notifications | Tested | |
| Channel pages, profile, support links | Tested | |
| Honest view counting and watch time | Tested | Including simultaneous reports on real PostgreSQL |
| Ranking that rewards videos people finish | Tested | Unit-tested maths and a browser look at Trending; whether it ranks *well* on real content is unknown |
| Studio: upload, edit, delete, analytics | Tested | |
| Media on local disk | Tested | One machine only |
| Object storage, CDN | Not built | Needed for more than one server and for cheap delivery |
| Live streaming, Shorts, playlists, captions, scheduled publishing, community posts, downloads, apps, 4K | Not built | Listed for members on the "Features that are not available yet" help page |
| Personalised recommendation by machine learning | Not built | Ranking is rules and statistics you can read |

## Safety and moderation

| Feature | State | Notes |
|---|---|---|
| Report video, comment or channel; moderator queue; remove or restore; suspend or restore people | Tested | |
| Audit log of staff actions | Tested | |
| Grievance and copyright/takedown pages and contact form | Tested | The text is a template |
| Appeals | Built, untested as a process | By message through the contact page; no separate workflow |
| Automatic detection of illegal or copyrighted uploads | Not built | **A real risk for a video site.** People must review reports quickly. Take advice on your legal duties |

## Money

| Feature | State | Notes |
|---|---|---|
| AdSense slots on watch pages, with all the rules (never for the owner or staff, paused while a report is open, labelled, removed when empty) | Needs your accounts | Tested with a stand-in for Google's script. Real ads need an approved AdSense account |
| `ads.txt`, non-personalised ads by default | Tested | Personalised ads need two settings and your own consent message; see `MONETIZATION.md` |
| Consent banner for the EEA, UK and Switzerland | Not built | Use Google's consent message or another certified tool. The site no longer implies it has one |
| Tips through Razorpay payment links and a signed webhook | Needs your accounts | Tested with a stand-in that signs messages the way Razorpay does. Never run against real Razorpay. Take legal advice first (payment aggregation) |
| Practice payment mode | Tested | Refused in production |
| Ledger, 7-day hold, balances, statements as CSV | Tested | Integer paise, append-only, constraints against double booking |
| Payout details, 24-hour cool-off, payout requests, manual approval and payment, reveal with password and audit | Tested | Payments to creators are made by you by hand |
| Admin refund of a tip | Tested | |
| Refunds made inside Razorpay's dashboard | Not built | The site is not told; reconcile by hand |
| Revenue-share batches from money you already received | Tested | |
| Sharing AdSense earnings with creators | Not built (on purpose) | Google's rules forbid it without written permission. The engine refuses unless the poster states that permission exists |
| Automatic payouts to creators | Not built | |
| GST, TDS, invoices | Not built | |

## Help, legal and honesty

| Feature | State | Notes |
|---|---|---|
| Help centre (27 articles) with search | Tested | |
| Help assistant that quotes the best-matching article | Tested | Works with no key |
| Help assistant that uses an AI model | Needs your accounts | Tested with a stand-in for Anthropic's API. Never run against the real API; the default model name is `claude-haiku-5-5` |
| Terms, privacy, cookies and ads, creator terms, community guidelines, copyright, grievance pages | Built, untested as law | Templates that fill in your details. Rendering is tested; being correct for you is for a lawyer |
| Healthy-watching features: autoplay switch, "still watching?" after three in a row, time-watched page, optional daily limit and reminder, no marketing email | Tested | |

## Operations

| Feature | State | Notes |
|---|---|---|
| Refuses to start in production when unsafe | Tested | |
| Web process plus separate worker, durable job queue, hourly housekeeping | Tested | Also on real PostgreSQL with simultaneous workers |
| PostgreSQL 16 | Tested | Whole suite passes on 16.15 and on PGlite |
| Server installer for Ubuntu 24.04 (`deploy/install.sh`): database, Node.js, ffmpeg, Caddy with automatic HTTPS, web and worker services, closed-beta password, update with automatic backup | Built, untested on a real server | Run end to end on a clean copy of Ubuntu 24.04 in a test sandbox, with stand-ins for systemd, DNS and the certificate authority: first install, update, 23 refusal cases, sign-up, upload, processing and playback through HTTPS. Never run on a real rented server. `TESTING.md` has the list |
| `vidverse` helper command, nightly backup, `vidverse restore` | Built, untested on a real server | A restore drill in the same sandbox: 48 of 48 checks (database, videos and keys identical to the backup; old site works; undo works; 16 bad restores refused). The drill found and fixed two faults |
| `Dockerfile`, `docker-compose.yml` | Built, untested | No Docker where this was built. The installer route above is the prepared one |
| Health endpoint | Tested | |
| Metrics, alerts, tracing | Not built | Logs and a health endpoint only |
| Load test, soak test | Not built | |
| More than one web server | Not built | Local-disk media and per-process rate limits |

## What was asked for, and what was done instead

| You asked for | What you got |
|---|---|
| A YouTube-like site in JavaScript | A small, honest, tested foundation: upload, process, stream, search, subscribe, comment, moderate. Not "more advanced than YouTube": it has none of YouTube's scale, live streaming, Shorts, captions or machine-learning recommendations |
| Users publish and earn money | Creators earn from viewer **tips**, from **their own support links**, and from **revenue-share batches** you fund from money other than AdSense |
| I also earn from Google AdSense | Built, ready for your approved account. Creators do **not** get a share of AdSense income, because Google forbids it unless it agrees in writing |
| An assistant that helps users | Built. Searches the help articles; can use an AI model if you give it a key |
| Terms and conditions | Seven legal pages as templates. They must be reviewed by a lawyer before launch |
| High security, data secure | Strong controls, tested. No outside review. See `SECURITY.md` for what is not covered |
| User-friendly interface | Keyboard and screen-reader friendly by automated checks, works on a phone, light and dark themes. No usability test with real people |
| Click-bait to earn more | **Not built.** Misleading titles and thumbnails are *demoted*: the ranking squares the share of a video that people actually watch. This is also what advertisers and Google's policies reward |
| Make users "addicted" and come always | **Not built.** People come back because the site is useful: a subscriptions feed, continue watching, watch later, opt-in notifications. Compulsion tricks (endless autoplay, streak guilt, fake urgency) are deliberately absent, and there are limits and reminders members can switch on |

## Honest limits to know before launch

1. **Money rules.** Holding viewers' tips for creators and paying them later may count as payment aggregation under Reserve Bank of India rules. Keep `PAYMENTS_PROVIDER=off` until a lawyer or chartered accountant, and Razorpay, have told you how to do it legally.
2. **Traffic.** AdSense and tips pay nothing without viewers, and video delivery costs money per viewer. `npm run economics` shows the arithmetic with placeholder prices.
3. **Legal pages are templates.** Not legal advice; not reviewed.
4. **Content risk.** Anyone can upload. Without automatic scanning, you need people who can act quickly on reports.
5. **Single machine.** Fine to start; see `DEPLOYMENT.md` for what changes at scale.
6. **Tested in one browser.** Chrome.
7. **No real external service was contacted** while building this: not Razorpay, not Google, not a real mail provider (a local stand-in mail server was used), not Anthropic, not a real hosting provider or certificate authority.
8. **Never run on a real server.** The installer and the restore command are rehearsed, not proven. Start as a closed beta with a few people you know, and keep copies of your settings file and backups away from the server.

## What testing found and fixed

- **Real PostgreSQL (simultaneous requests):** a burst of first watch reports from one viewer was credited once per report. Fixed with a per-viewer lock.
- **Browser tests:** a closed mobile menu that could still be tabbed to; an icon-only Upload link with no name on phones; tap targets too small on touch screens; headings out of order and duplicate page regions; a dark-theme red button with too little contrast; a status banner shown twice; and a server error logged for every refused media file (the media routes ran before the page renderer existed).
- **The server's log after a browser run:** a player that gave up on a video segment (a viewer skipping ahead or closing the tab) was logged as a failed request with status 500. It is not a fault, so it is no longer logged as one, and a test now covers it.
- **Running the tests on other dates:** new videos, subscriptions and notifications were stamped by the database's clock but compared with the application's, so a test passed when written and failed later the same day, and the hourly clean-up rules had no tests at all. Fixed, with tests for each rule; the whole suite then passed with the computer's clock set to five different dates.
- **Careful reading of sources:** an early draft shared AdSense income with creators. Google's rules do not allow that, so the design changed. The wording about EEA consent over-promised; ads are now non-personalised unless the owner states a consent message is on.
- **Documentation checked against the code:** sentences that promised more than the code does were corrected (which sessions end when a password changes, what is logged and when stack traces appear, how rate limits are counted).
- **Dependency audit:** on the day of packaging it flagged `zod` (high severity: memory exhaustion when validating large arrays, which this code does not do). It was upgraded to version 4 anyway and every test layer was re-run. The packages that run in production report no known problems; ESLint's own dependencies (development only) report 5 moderate ones.
- **Break-it checks:** 27 defences were removed one at a time. 24 were noticed every time, 1 (a race on real PostgreSQL) is noticed in some runs, and 2 survive on purpose because two layers protect the same rule (explained in `TESTING.md`). They also showed one test that was too weak, which was replaced by a deterministic one.
- **Lint:** 15 findings (unused code) early on, fixed; none now.
- **Installer rehearsal (0.1.1):** a settings value with a `#` in it (an address like "Flat #4") was cut off by the site's settings reader, so the installer now quotes values and a test reads them back with the site's own parser; a check written for "grep -q" failed under `pipefail` (a closed pipe), so output is captured first; the `HOST` setting the site reads was missing from `.env.example`, found by a test that compares what the installer writes with what is documented; a worker restarted during a video upload stops ffmpeg with it, so the video is recorded as failed and retried about 30 seconds later (documented, and shown to recover by itself).
- **Restore drill (0.1.1):** restoring the oldest of a full set of backups deleted it while the safety backup was being made (the keep-seven clean-up), after the database had already been dropped; restarted services inherited the backup lock and blocked every later backup. Both fixed, and each now has a test that fails if it comes back.
