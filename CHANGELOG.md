# Changelog

## 0.1.1 (4 November 2026): a way to put it on a server

The website's own code is unchanged from 0.1.0 (the two packages were compared file by file). This version adds what is needed to run it on a rented server, and tests for those parts.

**Added**

- `deploy/install.sh`: one command that sets up a fresh Ubuntu 24.04 server: PostgreSQL, ffmpeg, Caddy with automatic HTTPS, Node.js, an unprivileged `vidverse` user, fresh secret keys, the website and the video worker as services, and a nightly backup. It checks your settings and the server first and stops, saying what to fix, before it changes anything. It can be run again to update: it keeps your settings, backs up first and switches versions in one step.
- A closed-beta password in front of the whole site (on by default; `vidverse gate off` to open the site).
- The `vidverse` command for everyday jobs: `status`, `logs`, `make-admin`, `mail-test`, `backup`, `restore`, `gate`.
- `vidverse restore`: puts a backup back (database, videos and the two secret keys), after checking the backup and asking for confirmation, and after backing up what is there so it can be undone.
- `npm run mail-test -- you@example.com`: sends one test email with the site's mail settings and says what to change if it fails.
- `tests/deploy.test.js` (12 tests) and four more tests for the mail command.
- `CHANGELOG.md`.

**Changed**

- `docs/DEPLOYMENT.md` rewritten around the installer: steps, costs, email, updating, backups and restoring, troubleshooting, and a checklist for going public. `STATUS.md`, `TESTING.md`, `SECURITY.md` and the README say what was and was not tested.
- `.env.example` now lists `HOST` (the site already read it).

**Fixed while rehearsing the new parts** (none of these were in 0.1.0)

- Restoring the oldest backup of a full set could delete it while the safety backup was being made.
- Services started by a restore inherited the backup lock, so no later backup could run.

**Not done**

- Nothing here has run on a real server, a real certificate, a real mail provider or a real systemd. See `docs/TESTING.md`.
- The Docker files are still unbuilt and untested.

## 0.1.0

First package: the site itself (upload, adaptive streaming, search, channels, comments, tips and payouts, AdSense slots, help centre and assistant, legal templates, moderation and admin), with its tests.
