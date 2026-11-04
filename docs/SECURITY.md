# Security

This page says what the site does to protect people and their data, where each protection is tested, and, just as important, what it does **not** cover. No software can promise "unhackable", and nobody outside this project has attacked this one. Treat the controls below as a solid starting point that still needs a review by a security professional before you hold other people's money or data.

## What is protected, and how

| Risk | What the site does | Tested by |
|---|---|---|
| Someone guesses or steals a password | Passwords are hashed with **scrypt** (N=2^17, r=8, p=1, about 128 MiB of memory per guess), a unique salt each, and the parameters are stored with the hash so they can be raised later. At least 10 characters, a blocklist of the most common passwords, and no part of the email or handle. Sign-in says the same thing for an unknown address and a wrong password, and takes the same time. | `auth.test.js`, `lib.test.js` |
| Guessing passwords at speed | After 5 failed attempts an account is locked for a growing delay (up to an hour). Sign-in, sign-up, password reset, second-step and contact-form attempts are also rate-limited per visitor (by network address). | `auth.test.js` |
| A stolen password alone is not enough | Optional **two-step verification** (TOTP, RFC 6238) with one-time recovery codes. A code can be used once (replay-proof, even when two requests race), recovery codes are stored only as hashes and removed when used, and the secret is encrypted at rest. Sign-in is rejected if the code was already used. | `auth.test.js`; real codes in the browser tests |
| A stolen session | Sessions are random 256-bit tokens kept in the database **only as a hash**, so a leaked database does not hand out live sessions. They end after 14 days idle or 60 days in all, can be listed and revoked from Settings, and every other session is signed out when the password changes. Only a short prefix of the network address is stored. | `auth.test.js`, `settings.test.js` |
| Cookies read or sent where they should not be | `__Host-` cookies (always `Secure`, `Path=/`, no `Domain`), `HttpOnly`, `SameSite=Lax`. | `web.test.js` |
| Another site makes your browser act as you (CSRF) | Every change needs a token **and** the request must come from this site (`Origin` and `Sec-Fetch-Site` are checked). | `web.test.js`, `auth.test.js`; broken on purpose in `TESTING.md` |
| Script injection (XSS) | Pages are built with a template tag that escapes everything by default. A **Content-Security-Policy** allows scripts only with a fresh random nonce, no inline styles, no third-party hosts, no framing, no `<base>`, no plugins. Violations are reported to `/api/csp-report` (size-limited, query strings and secrets stripped). The browser tests fail on any CSP violation in the console. | `lib.test.js`, `web.test.js`, browser tests |
| Clickjacking | `X-Frame-Options: DENY` and `frame-ancestors 'none'`. Checked from a page on another origin that tries to frame the site. | browser tests |
| Other browser hardening | `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Cross-Origin-Opener-Policy` and `Cross-Origin-Resource-Policy: same-origin`, a restrictive `Permissions-Policy`, and HSTS when the site runs on HTTPS. | `web.test.js` |
| Malicious uploads | The file type is decided from the file's first bytes, not its name or declared type; size, duration, daily and storage limits apply; ffmpeg runs without a shell, with a network-less protocol whitelist, a forced container format, a timeout and capped output. Images are sniffed the same way. | `videos.test.js` |
| Reading someone's private video | Media is served only after a visibility check. Anything you may not see answers **404**, never 403, so private ids cannot be probed. Private-video thumbnails and candidate frames are owner-and-staff only. | `videos.test.js`, `web.test.js` |
| Changing someone else's data | Every Studio action checks ownership on the server. | `videos.test.js` |
| Stolen payout details | Encrypted with **AES-256-GCM**, bound to the member's id (a copy pasted into another member's record will not decrypt), keys held in the environment (a key ring, so keys can be rotated), shown back only as a short hint. Staff can reveal them only with two-step verification on and by typing their password again; every reveal is in the audit log. | `money-payouts.test.js` |
| Fake payment messages | Only a webhook with a valid **HMAC signature** (constant-time comparison) can credit money, the amount and currency must match, each event id is processed once, and the credit is locked and de-duplicated in the database. | `money-webhook.test.js`, `concurrency.test.js` |
| Cashing out after an account takeover | After payout details are added or changed, payouts wait 24 hours and the owner is emailed. Payouts are paid by hand, and a staff member can never approve, pay or decline their own request. | `money-payouts.test.js` |
| Abuse of watch time and views | The server credits watch time from the clock, not from what the player claims; counting and the payout engine are separate. | `engagement.test.js`, `concurrency.test.js` |
| Spreadsheet formula injection | Statement downloads neutralise cells that begin with `=`, `+`, `-` or `@`. | `money-lib.test.js` |
| Secrets in logs | Request logs hold an id, the method, the path (no query string), the status and the time, never a body or a cookie. Any logged field whose name looks secret (password, token, cookie, secret, signature, key, details and similar) is replaced with `[redacted]`, errors are logged as a name and message only (stack traces are added to the log of a failed request only when the site is not running in production), and long values are cut short. The app does not put email addresses in log fields (the text of an error from a mail server could still contain one). | `lib.test.js` |
| Weak production setup | The site **refuses to start** in production with the development secret, with the practice payment mode, over plain HTTP, without a database URL, or with the legal details missing. | `lib.test.js` |
| A weakness in the website taking over the server (when installed with `deploy/install.sh`) | The site and the video worker run as an unprivileged `vidverse` user with systemd restrictions (no new privileges, read-only system folders, writes only to the data folder, private temporary folder). The site listens on `127.0.0.1` only; Caddy faces the internet and handles HTTPS. The database accepts local connections only, with a random password. The settings file is readable only by root and the site's user. Secrets are generated fresh on the server. | `tests/deploy.test.js` checks that these settings are what the installer writes and the service files say; the systemd restrictions were checked for syntax only, never enforced by a real systemd |

## What each member can do to their own data

Download everything the site holds about them, delete their account (refused while money or an open payout is outstanding, so nobody loses money by clicking), see and revoke sessions, change password, turn two-step verification on or off, set a daily watching limit. These are in Settings and are tested.

## What is not covered

Be clear-eyed about these before launch:

- **No outside review.** No penetration test or code audit by a third party has been done. The project's own "break it on purpose" checks (see `TESTING.md`) are evidence that the tests notice some failures. They are not a substitute.
- **No scanning of uploads for illegal or copyrighted content.** There is a report button, moderator tools and a takedown process. People review. You must have people (or a service) who can act quickly, and you must read the legal pages with a lawyer.
- **No protection against floods.** The rate limiter is in memory and per process, and nothing here stops a large denial-of-service attack. Put the site behind a CDN or a provider that does.
- **No web application firewall, no intrusion detection, no automatic alerts.** There is a log and a health endpoint. Add monitoring.
- **Email is the recovery path.** Someone who controls a member's email can reset their password. Two-step verification is the defence; encourage creators to turn it on.
- **Your own server.** Operating-system updates, Node updates, firewall, backups, who can reach the database and where the secrets live are yours to look after. See `DEPLOYMENT.md`. The installer does not harden SSH or change the firewall (it only opens ports 80 and 443 if `ufw` is already on): use SSH keys, turn off password logins, and keep the server updated.
- **The closed-beta password.** It is one shared password checked by the web server, not per-person accounts. It keeps strangers and search engines out of a private trial; it is not a defence against someone who wants in. Each wrong attempt costs about 1.3 seconds of processor time on a small server, so a person hammering the prompt can slow the site. Turn it off when you go public (`vidverse gate off`) and rely on the site's own protections above.
- **Backups on the same disk.** The nightly backups sit on the server's own disk and include the settings file with every secret. They are readable by root only, but they are lost with the server and exposed with it. Copy them somewhere else, and protect that copy as you would the keys themselves.
- **Supply chain.** The lockfile pins every dependency. `npm audit --omit=dev` (the packages that run on your server) reported nothing when the project was packaged, after `zod` was upgraded to version 4 because of a new high-severity advisory. `npm audit` still reports 5 moderate findings inside ESLint's own dependencies; they concern the linter on a developer's machine, not the site. New problems are found in libraries every week, so run `npm audit` and update regularly.
- **Browsers.** Browser tests ran in Chrome only.
- **Insiders.** An administrator can do a lot. The controls are two-step verification for staff actions on money, an audit log that cannot be edited from the site, and the rule that nobody can act on their own payout. They reduce risk; they do not remove it.

## Operator checklist before going live

1. Set `SESSION_SECRET` and `ENCRYPTION_KEYS` to long random values (see `.env.example`) and keep them out of the repository. **Back up `ENCRYPTION_KEYS`**: without them stored payout details cannot be read.
2. Run the site only behind HTTPS. Set `TRUST_PROXY` to the number of proxies in front of it.
3. Use a database that is not reachable from the internet, with its own user and a strong password. Take backups and test restoring one.
4. Turn on two-step verification for every administrator, and keep the number of administrators small.
5. Have a lawyer review the legal pages and set `LEGAL_REVIEWED=true`.
6. Decide who answers reports and the grievance email, and how fast.
7. Publish a way for researchers to tell you about a vulnerability (an email address on your contact page is enough), and read what arrives.
8. Run `npm audit` and `npm run check` after every update.
9. Do not turn on live tips until you have taken advice (see `MONETIZATION.md`).
