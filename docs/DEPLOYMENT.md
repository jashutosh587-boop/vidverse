# Putting Vidverse on the internet

Read [`STATUS.md`](STATUS.md) first. This page has two routes:

1. **One rented server and an installer** (the route this project prepared and tested). About an hour of your time, plus the waiting.
2. **Anything else** (your own Linux setup, Docker, a hosting service). Described at the end. It was not prepared or tested.

**What has and has not been tested.** The installer was run on a clean copy of Ubuntu 24.04 in a test sandbox, with real PostgreSQL, ffmpeg, Caddy and Node.js, and the whole site then used over HTTPS: sign-up emails, an upload, processing, playback. Three things were stand-ins there: systemd (the sandbox has none), DNS, and the certificate authority. It has **never run on a real rented server**. Expect to fix a small thing the first time, and expect the installer to stop with a plain message rather than do something half-way. The full list is in [`TESTING.md`](TESTING.md#what-has-not-been-exercised).

**Recommended: start as a closed beta.** The installer puts the whole site behind one shared password until you say otherwise. Invite a few friends, upload real videos, let it run for two weeks, then decide. Nothing about this project earns money until people come, and a server costs money from the first day (see "What it costs").

## What you need

| Thing | Notes |
|---|---|
| A server running **Ubuntu 24.04 LTS** | 2 vCPU and 4 GB of memory is comfortable; 2 GB works for a trial; under 1 GB is refused. At least 40 GB of disk (the installer refuses under 3 GB free and warns under 10). A new, empty server: the installer takes over ports 80 and 443. Intel/AMD is what was tested; ARM is untested. |
| A domain name you control | You add one DNS record to it. Without a domain there is no HTTPS, and the site refuses to run in production without HTTPS. |
| A mail account that can send through SMTP | Sign-up confirmation and password reset need real email (Brevo, Mailgun, Amazon SES, or your domain's mail host). See "Email" below: many server hosts block the usual mail ports. |
| A computer with `ssh` and `scp` | Windows 10/11, macOS and Linux all have them in a terminal. |
| An hour or two | The installer itself took under two minutes on the test sandbox; a real server's first run is longer because it downloads packages. |
| Later: a lawyer, and (for ads) Google's approval | The legal pages are templates. See "Before you open the site to the public". |

## What it costs

Prices change, so look at the provider's page before you buy. When I looked on **4 November 2026**:

| Provider | Plan | Price then | Notes |
|---|---|---|---|
| DigitalOcean | Basic, 2 vCPU / 2 GiB | $18 / month | A 2 vCPU / 4 GiB plan was $24 / month. A Bangalore region exists. Provider backups cost extra (about 20–30% of the server price). |
| Hetzner | CPX22, 2 vCPU / 4 GB / 80 GB | €19.99 / month without VAT in the EU; €26.99 in Singapore | Singapore includes 1 TB of traffic. Hetzner blocks outgoing mail ports 25 and 465 on new accounts (587 is open). |

Any provider that offers Ubuntu 24.04 works; these are only two I read. Add the domain (a yearly fee), the mail service (several have a small free tier: check the current limits) and tax. Budget about **$20–30 a month** to run one server, whether or not anyone visits. Delivering video to many viewers costs more as traffic grows: `npm run economics -- --views 100000` shows the arithmetic with placeholder prices.

## Step by step

### 1. Rent the server

Choose Ubuntu 24.04 LTS, 2 vCPU / 4 GB, and the region nearest your viewers. Add your SSH key if the provider offers it. Write down the server's **public IP address**. If the provider has a firewall in its dashboard, allow ports **22, 80 and 443** (80 and 443 are how the certificate is issued).

### 2. Point your domain at it

At your domain's DNS settings, add an **A record**: name `videos` (or whatever you want), value = the server's IP. The address people will type is then `videos.yourdomain.in`. If you use Cloudflare, set the record to **"DNS only"** (grey cloud): its free plan is not meant for serving video.

Wait a few minutes. The installer checks that the name points at the server and stops with an explanation if it does not.

### 3. Get your mail settings

Create a sending account with your mail service and find its **SMTP** details: host, port, user name, password. Put them into one line:

```
smtp://USERNAME:PASSWORD@smtp.yourprovider.com:587
```

Port 465 goes with `smtps://`. If the password has symbols such as `@ # / :`, write them as `%40 %23 %2F %3A`.

### 4. Put the project on the server

From your own computer (replace the address):

```
scp vidverse-v0.1.1.zip root@203.0.113.10:
ssh root@203.0.113.10
apt-get update && apt-get install -y unzip
unzip vidverse-v0.1.1.zip
cd vidverse
```

If your provider gives you a normal user instead of `root`, put `sudo` in front of the installer commands below.

### 5. Fill in the settings

```
cp deploy/setup.conf.example ~/vidverse-setup.conf
nano ~/vidverse-setup.conf
```

Change the eight lines under "required": your domain, your name or company and postal address (shown on the public legal pages), contact email, the grievance officer's name and email (India's IT Rules expect a named person who answers within the time limits), and the mail settings. Everything else has a sensible default. One `KEY=value` per line, no quotes, no spaces around the `=`. The installer stops, naming the line, if something is missing, still has the example text, or is misspelled; it changes nothing on the server until the settings pass.

### 6. Run the installer

```
./deploy/install.sh ~/vidverse-setup.conf
```

It installs PostgreSQL, ffmpeg, Caddy and Node.js, creates an unprivileged `vidverse` user and a database, generates the site's secret keys, installs the website, the video worker and a nightly backup as services, gets the HTTPS certificate, puts the closed-beta password in front of the site, starts everything, checks that it answers, and sends a test email to your contact address.

Part-way through, when it sets up the web server, it prints a **beta password** (user name `beta`). **Copy it when you see it**; it is shown once. (Or choose your own beforehand with `BETA_PASSWORD=` in the settings file.) If you lose it, set a new one: `sudo vidverse gate on NEWPASSWORD`.

It is safe to run again if something stopped it. It never overwrites the settings file in `/etc/vidverse/`, and it never touches the database contents.

### 7. Check it works

1. Did the test email arrive (look in spam too)? If not: `sudo vidverse mail-test you@yourmail.com` prints the likely reason and what to change. Fix `SMTP_URL` and `MAIL_FROM` in `/etc/vidverse/vidverse.env`, then `sudo systemctl restart vidverse-web vidverse-worker`.
2. Open `https://videos.yourdomain.in`, type the beta user name and password, sign up with your own email address and click the link in the confirmation email.
3. Make yourself the administrator: `sudo vidverse make-admin you@yourmail.com`.
4. In the site, open Settings > Security and turn on **two-step verification**. The pages that move money stay closed to administrators until it is on.
5. Upload a short video and watch it process and play, on your phone and on a laptop.
6. `sudo vidverse status` shows whether everything is running, the free disk space and the last backup.

### 8. Copy the settings and the backups off the server

This is the step people skip and regret. Nightly backups are written to `/var/backups/vidverse` **on the same disk**: they protect you from mistakes, not from losing the server. And `/etc/vidverse/vidverse.env` holds `ENCRYPTION_KEYS`: without it, stored payout details can never be read again, even from a perfect database backup.

- Keep a copy of `/etc/vidverse/vidverse.env` in a password manager.
- Copy the backup folder somewhere else regularly. From your own computer, for example: `rsync -a root@203.0.113.10:/var/backups/vidverse/ ~/vidverse-backups/`. Or use your provider's server snapshots as well.

### 9. Invite your testers

Give them the address and the beta password. While the password is on, nobody else can see the site or sign up, and search engines and Google's AdSense reviewers cannot see it either.

The password is checked by the web server, which is deliberately slow at it: each **wrong** attempt costs about 1.3 seconds of processor time on a small server. That is fine for a handful of invited people; it is not meant to face public traffic. Tests on the sandbox showed the right password stays fast (4 to 30 ms per request in the sandbox tests, once accepted).

## Everyday commands

Run these on the server (put `sudo` in front if you are not `root`).

| Command | What it does |
|---|---|
| `vidverse status` | Website, worker, web server, database, free disk, beta password on or off, newest backup |
| `vidverse logs [web\|worker\|caddy]` | Show the log and keep following it (Ctrl-C to stop) |
| `vidverse make-admin EMAIL` | Make someone an administrator (they must have signed up and confirmed the email) |
| `vidverse mail-test EMAIL` | Send one test email with the site's mail settings and explain a failure |
| `vidverse backup` | Make a backup now |
| `vidverse restore FOLDER` | Put a backup back (see "Backups and restoring") |
| `vidverse gate on [PASSWORD]` / `vidverse gate off` | Closed-beta password on or off |

The site's settings are in `/etc/vidverse/vidverse.env`. After changing them: `sudo systemctl restart vidverse-web vidverse-worker`. Every setting is explained in [`.env.example`](../.env.example). The site refuses to start with an unsafe or missing value and says which one.

## Updating

Copy the new project folder to the server and, from inside it, run the installer **without** a settings file:

```
./deploy/install.sh
```

It keeps every setting, **makes a backup first** (and stops if the backup fails), installs the new code beside the old, switches over, restarts, and keeps the last three versions in `/opt/vidverse/releases`. The site is down for a few seconds. Database changes made by a new version only move forward. If the new version does not start, the installer prints what to do; to go back to the previous code it gives the exact command, and if the old code cannot read the data, restore the backup it took.

## Backups and restoring

**What is backed up.** Every night at 22:00 UTC (03:30 in India, give or take 20 minutes) and whenever you run `vidverse backup`: the database, all uploaded videos and pictures, and a copy of the settings file. The newest seven are kept, in `/var/backups/vidverse/<date-time>/`. A night with no new uploads uses almost no extra space, because unchanged videos are shared between backups. A backup only counts once it carries a `COMPLETE` marker; an interrupted one is ignored and removed.

**Restoring on a new server** (the server was lost, or you are moving):

1. Do steps 1 to 6 above on the new server, with the same settings file. (If the domain stays the same, change its A record to the new server's address first.) You get a working, empty site.
2. Copy one backup folder (for example `20261104-220000`) from your off-server copy onto the new server. From your own computer: `rsync -a ~/vidverse-backups/20261104-220000 root@NEW-SERVER-IP:/root/`
3. On the new server run: `vidverse restore /root/20261104-220000`. It asks you to type `RESTORE`.

The restore replaces the database and the videos with the backup's, and puts back the backup's two secret keys (`SESSION_SECRET` and `ENCRYPTION_KEYS`) so that stored payout details can be read again. Every other setting stays as the new server's installer wrote it. Before it changes anything it backs up what is on the server and prints how to undo the restore.

**Restoring in place** (a bad update, a deleted video): the same command with a folder from `/var/backups/vidverse`. The site is offline while it runs.

**What was tested.** A drill on the sandbox: back up a working site; turn it into a "brand-new server" with an empty database, no videos, new secret keys and one new account; try 16 broken or unconfirmed restores (each refused, nothing changed); restore; check that the database, videos and keys are exactly the backup's and that the old site works over HTTPS (the old account signs in, the video plays, the new account is gone); undo it from the safety backup; and restore the oldest backup of a full set. The drill found two real faults, both fixed: restoring the oldest backup could delete it while taking the safety backup, and restarted services held the backup lock. **Practise it yourself once, on a spare server, before you rely on it.** Restore a backup made by the same or a newer version of Vidverse than the one you restore into; older code reading a newer database was not tried.

## Email

Mail is the part most likely to cost you an afternoon:

- **Port blocks.** Many server hosts block outgoing mail ports 25 and 465 on new accounts to fight spam; 587 and 2525 are usually open. Hetzner says so in its documentation; DigitalOcean's community pages show it happens there too. If `vidverse mail-test` says it cannot connect, try port 587 or 2525 with `smtp://`.
- **Spam folders.** Set up SPF, DKIM and DMARC for your sending domain as your mail service explains, or sign-up emails will land in spam.
- `MAIL_FROM` should be an address on a domain your mail service has verified.

## If something goes wrong

| What you see | What to do |
|---|---|
| Installer: "does not resolve" or "points to X but this server is Y" | The A record is missing or wrong, or has not spread yet. Fix it, wait a few minutes, run the installer again. |
| Installer finishes but says HTTPS "did not answer from here yet" | The certificate authority must reach the server on ports 80 and 443: check the provider's firewall. Look at `sudo vidverse logs caddy`. |
| Installer: something else is listening on port 80 or 443 | Stop it (`sudo systemctl disable --now nginx apache2`) and run again. |
| Test email does not arrive | `sudo vidverse mail-test you@yourmail.com`. It tells apart wrong user or password, a rejected sender, an unknown host name, a certificate or port mismatch, and a blocked connection. |
| The website will not start | `sudo vidverse logs web`. The site names the setting it dislikes. Fix `/etc/vidverse/vidverse.env`, then `sudo systemctl restart vidverse-web vidverse-worker`. |
| A video stays "processing" | `sudo vidverse logs worker`. Check free disk with `vidverse status`. A video interrupted by a restart is retried by itself about 30 seconds later (three tries); if the worker was killed outright it is picked up again after 30 minutes. |
| You forgot the beta password | `sudo vidverse gate on NEWPASSWORD` |
| Disk is full | `vidverse status`. Old backups are in `/var/backups/vidverse` (copy them off first). Or move to a bigger server. |

## Before you open the site to the public

Turn the beta password off only when all of these are true:

- [ ] A lawyer has reviewed the legal pages, and you have set `LEGAL_REVIEWED=true` and `ALLOW_UNREVIEWED_LEGAL=false` in the settings file (until then the legal pages show a "draft" notice by design)
- [ ] A named person reads the grievance and takedown mailboxes **every day**, and knows how to remove content. Anyone can upload; nothing scans uploads for illegal or copyrighted material.
- [ ] Administrators have two-step verification on
- [ ] You have restored a backup on a spare server and it worked
- [ ] The limits in the settings file suit what you can afford to store and serve (the installer starts with 30 minutes and 1 GiB per video, 5 GiB per creator, 5 uploads a day)
- [ ] Payments stay `off` until you have advice on payment-aggregator rules ([`MONETIZATION.md`](MONETIZATION.md))
- [ ] AdSense is switched on only after Google approves the site, which needs the site to be public. If you serve visitors in the EEA, UK or Switzerland, set up a consent message first.
- [ ] A test upload plays on a phone and on a laptop, in at least Chrome and Safari (only Chrome was tested)

Then: `sudo vidverse gate off`.

## Keeping it healthy

- **Logs** are one JSON object per line (`vidverse logs`). **Health:** `GET /api/health` answers `{"status":"ok"}`; point an uptime monitor at it (it stays reachable even behind the beta password).
- **Housekeeping** (expired sessions and tokens, old counters, abandoned drafts) runs hourly by itself.
- **Server updates:** Ubuntu normally installs security updates by itself. Once a month log in, run `sudo apt update && sudo apt upgrade`, and reboot if it says so. Rebooting was not tested: the services are set to start at boot, so the site should come back by itself. Check `vidverse status` afterwards.
- **Dependencies:** run `npm audit` and `npm run check` when you update the project.

## What was not tested

- A real server. A real certificate from the certificate authority. A real mail provider. A real systemd (the sandbox stood in for it, starting the same commands as the same user and settings; the unit files were only checked for syntax). A reboot. A real `nodejs.org` download (its logic was tested against a local copy of the release folder, including a tampered file). ARM servers.
- The beta-password prompt in a person's own browser (a scripted browser and plain requests passed).
- Any load. Scaling (below).

## Scaling honestly

The shape is one web process, one worker, one database and one disk on one machine. That is enough to find out whether anyone wants this. Beyond it:

- **Delivery is the cost.** Streaming video costs far more than everything else. With the placeholder prices in `npm run economics`, 100,000 views a month of 4 minutes each needs about 4.5 TB of delivery and costs about ₹72 per 1,000 views to run, which advertising has to beat just to break even.
- **Second web server.** Not supported yet: media is on local disk and rate limits are per process. You would need object storage plus a CDN (the storage layer in `src/services/storage.js` is the place to change) and a shared rate-limit store.
- **Heartbeats.** The player reports progress every few seconds and each report is a database write. Fine for thousands of viewers, wrong for millions.
- **No load test has been run.** Do one before you promote the site.

## Other ways to host (not prepared, not tested)

The installer supports Ubuntu 24.04 only. If you need something else:

**Your own Linux, by hand.** You need Node.js 22.12 or newer, ffmpeg and ffprobe, PostgreSQL 16 or newer (the first migration creates the `pg_trgm` extension; a normal database owner can do this on 13+), a reverse proxy that does HTTPS and passes `X-Forwarded-For` and `X-Forwarded-Proto` (Caddy: `your.domain { reverse_proxy 127.0.0.1:3000 }`), and an SMTP service. Install with `npm ci --omit=dev`, write a settings file from `.env.example` (`NODE_ENV=production`, `BASE_URL`, `TRUST_PROXY=1`, `SESSION_SECRET`, `ENCRYPTION_KEYS`, `DATABASE_URL`, `SMTP_URL`, `MAIL_FROM`, the `OPERATOR_*` and `GRIEVANCE_*` details, `DATA_DIR`), and start `npm start`. The site checks everything on start and refuses to run, with a list, if something is missing or unsafe; it applies database migrations itself. For video processing in its own process set `WORKER=separate` and run `npm run worker` with the same `DATA_DIR`. Allow large uploads through the proxy (`PUT /api/studio/videos/*/source`, up to `MAX_UPLOAD_BYTES`) without buffering them. Then follow "Before you open the site to the public". Read `deploy/install.sh` and the files beside it: they are the tested version of these steps.

**Docker and hosting services (Render, Railway and similar).** `Dockerfile` and `docker-compose.yml` exist but **have never been built or run**: nowhere that this project was built had Docker. From reading them, not running them, expect these snags:

- The image is Debian with ffmpeg 5.1; the tests ran with ffmpeg 6.1.1.
- The image runs as the `node` user, while some platforms mount disks owned by root.
- Most hosting services give one disk per service, so the web process and a separate worker cannot share the videos folder. Run one service with `WORKER=inprocess`.
- In a container, stopping the worker does not stop an ffmpeg it started, so an interrupted video can wait 30 minutes before it is retried.
- Render's plain Node.js environment has no ffmpeg; use the Docker image there.
- Port 3000 is bound to the machine's loopback in `docker-compose.yml`; you still need HTTPS in front.

Treat that route as a project of its own: build it, read the errors, and expect to adjust.
