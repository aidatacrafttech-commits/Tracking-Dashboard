# Production runbook: the dashboard on AWS (`application-monitor`)

How the live Adhyaapak AI Dashboard (API Cost Monitor) was set up on its own EC2 instance on
2026-11-21, how to run it day to day, how to finish the last step (the domain), and how to
rebuild it from nothing. It also lists every problem hit on the way and its fix.

This file holds **no secrets**. It says where they are kept and how to change them.

Related documents:
- [`DEPLOYMENT.md`](DEPLOYMENT.md): the deploy kit (`deploy/manage.sh`, systemd, backups, rollback).
- [`APP_COURSES.md`](APP_COURSES.md), [`APP_USERS.md`](APP_USERS.md), [`PLACEMENT_DRIVES.md`](PLACEMENT_DRIVES.md), [`VOUCHERS.md`](VOUCHERS.md): the screens that use the AdhyaapakAI admin API.

---

## Contents

1. [What runs where](#1-what-runs-where)
2. [Current state (2026-11-21)](#2-current-state-2026-11-21)
3. [How it was built, step by step](#3-how-it-was-built-step-by-step)
4. [Day-to-day operations](#4-day-to-day-operations)
5. [The dashboard owner token: find it, change it](#5-the-dashboard-owner-token-find-it-change-it)
6. [Next step: the domain `monitor.adhyaapak.ai` with HTTPS](#6-next-step-the-domain-monitoradhyaapakai-with-https)
7. [Rebuild from scratch (checklist)](#7-rebuild-from-scratch-checklist)
8. [Troubleshooting: problems already met](#8-troubleshooting-problems-already-met)
9. [Security notes and open follow-ups](#9-security-notes-and-open-follow-ups)
10. [Appendix: files created on the server](#10-appendix-files-created-on-the-server)

---

## 1. What runs where

```
                        ┌──────────────── EC2 "application-monitor" (Ubuntu 24.04, ap-south-1) ────────────────┐
 Your browser           │                                                                                      │
   │  now: SSH tunnel   │   nginx 127.0.0.1:8300 ──┬── /api/admin/, /api/vouchers/, /api/academics/ ──────────────┼──▶ https://api.adhyaapak.ai
   │  later: HTTPS 443  │   (later also :443)      │   (AdhyaapakAI backend, live database)                       │      (the app's backend)
   └───────────────────▶│                          └── everything else ──▶ dashboard 127.0.0.1:8100 (uvicorn)     │
                        │                                                   │  SQLite /var/lib/api-cost-monitor  │
                        │                                                   ├──▶ OpenAI / Deepgram / ElevenLabs   │
                        │                                                   ├──▶ AWS Cost Explorer, EC2, CloudWatch (instance role)
                        │                                                   └──▶ smtp.gmail.com:587 (alert emails)
                        │                                                                                      │
                        │   acm-autodeploy.timer (every 5 min) ◀── git fetch ── GitHub main (read-only deploy key)
                        └──────────────────────────────────────────────────────────────────────────────────────┘
 Browser uploads (App videos, card banners) go straight to S3 (tuitionkart-data-bucket) with links the app's backend signs.
```

- The dashboard (FastAPI + built React UI) listens only on `127.0.0.1:8100`. It is never open to the internet directly.
- nginx is the only entry. It sends the AdhyaapakAI screens' calls (`/api/admin/…`, `/api/vouchers/…`, `/api/academics/…`) to the **live** AdhyaapakAI backend. The browser adds the admin secret (`x-admin-secret`) itself; the dashboard server never stores it.
- **Every save on Voucher Management, Course Management, Placement Drives or App Users changes the live app.**

## 2. Current state (2026-11-21)

### AWS resources

| Item | Value |
|---|---|
| Instance | `application-monitor`, `i-045d76ede9835e0ba`, `t3.small`, ap-south-1 (Mumbai), Ubuntu 24.04 LTS, 20 GB gp3 |
| Public IP | Elastic IP `16.4.31.142` (stays the same across stop/start) |
| SSH key pair | `application-monitor` (`.pem` kept by the owner; never commit it) |
| Security group | `application-monitor-sg`: SSH 22 from the admin's IPv4 `/32` only; HTTP 80 and HTTPS 443 from `0.0.0.0/0`; no 8100 |
| IAM policy | `application-monitor-readonly` (= [`aws-monitoring-iam-policy.json`](aws-monitoring-iam-policy.json): read-only cost, credits, EC2, CloudWatch, STS) |
| IAM role | `application-monitor-role` (trusts `ec2.amazonaws.com`), attached to the instance |
| S3 bucket CORS | `tuitionkart-data-bucket`, rule `api-tracking-dashboard-course-uploads`: POST/GET from `http://localhost:5173`, `http://127.0.0.1:5173`, `http://localhost:8200`, `https://monitor.adhyaapak.ai` |

### On the server

| Item | Value |
|---|---|
| Dashboard service | `api-cost-monitor.service` (user `apimon`, `127.0.0.1:8100`, starts at boot) |
| Health timer | `api-cost-monitor-healthcheck.timer` (every 5 min) |
| Auto-deploy | `acm-autodeploy.timer` → `acm-autodeploy.service` (every 5 min, pulls GitHub `main`) |
| nginx | site `api-cost-monitor-local.conf` on `127.0.0.1:8300` (for the SSH tunnel) |
| Config | `/etc/api-cost-monitor/monitor.env` (root only, mode 600) |
| Email alerts | on (`EMAIL_DELIVERY_ENABLED=true`, Gmail SMTP 587 STARTTLS) |
| AWS monitoring | on, via the instance role (no AWS keys on disk) |
| Release live | auto-deployed from commit `4bbd31f` |

### Status of the plan

| Step | What | Status |
|---|---|---|
| — | Instance, IP, security group, packages, install, first deploy | Done |
| — | nginx forwards to the AdhyaapakAI admin API | Done |
| 2 | S3 bucket CORS | Done |
| 3 | Auto-deploy from GitHub `main` | Done (first auto-deploy: `4bbd31f`) |
| 4 | IAM role → AWS costs in the dashboard | Done (credits balance: `permission_denied`, see §9) |
| 5 | Email alerts | Done (test email received) |
| 1 | Domain `monitor.adhyaapak.ai` with HTTPS | **Pending**: needs the DNS record (§6) |

---

## 3. How it was built, step by step

### 3.1 Launch the instance (AWS console → EC2 → Launch instance)

| Field | Value |
|---|---|
| Name | `application-monitor` |
| AMI | **Ubuntu Server 24.04 LTS (HVM), SSD**, 64-bit x86 (has Python 3.12) |
| Type | `t3.small` (2 vCPU, 2 GB) |
| Key pair | new, RSA, `.pem`, name `application-monitor` |
| Network | auto-assign public IP on; new security group `application-monitor-sg` |
| Inbound | SSH 22 from your IP; HTTP 80 and HTTPS 443 from anywhere |
| Storage | 20 GiB gp3 |

Then **EC2 → Elastic IPs → Allocate → Associate** with the instance (leave "allow reassociation" off).

> **Pitfall:** "My IP" in the SSH rule can pick your browser's **IPv6** range (e.g. `2401:4900::/32`). The instance has IPv4 only, so SSH times out. Delete that rule and add SSH with your **IPv4** `/32` (find it with `curl https://checkip.amazonaws.com`). AWS does not let you change an IPv6 rule into IPv4; delete and re-add.

### 3.2 SSH from Windows

```powershell
ssh -i "D:\path\to\application-monitor.pem" ubuntu@16.4.31.142
```

> **Pitfall:** Windows OpenSSH refuses a key file others can read ("UNPROTECTED PRIVATE KEY FILE"). Fix the file's permissions once:
> ```powershell
> $key = "D:\path\to\application-monitor.pem"
> icacls $key /inheritance:r /grant:r "${env:USERNAME}:(R)"
> icacls $key /remove "NT AUTHORITY\Authenticated Users" "BUILTIN\Users" "Everyone"
> ```
> If the drive is exFAT/FAT (no permissions), copy the key to `%USERPROFILE%\.ssh\` and fix it there.

### 3.3 Inspect, then install packages

The inventory (read-only) showed Ubuntu 24.04.5, 2 vCPU, 1.9 GB RAM, no swap, Python 3.12.3 without `venv`, no nginx/certbot, and outbound HTTPS working to every provider, `api.adhyaapak.ai`, PyPI and GitHub.

```bash
sudo apt-get update
sudo apt-get install -y python3.12-venv nginx certbot sqlite3
# 1 GB swap (pip installs can run out of 2 GB RAM)
sudo fallocate -l 1G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

### 3.4 Build a release (on a dev PC) and install it

```powershell
cd "C:\Users\ay479\Desktop\API Tracking Dashboard"
cd frontend; npm run build; cd ..            # frontend/.env must have VITE_ADHYAAPAK_API_BASE=/api
backend\venv\Scripts\python -m pytest -q backend\tests
backend\venv\Scripts\python deploy\build_release.py   # -> release\api-cost-monitor-<version>.tar.gz (+ .sha256)
scp -i KEY release\api-cost-monitor-<version>.tar.gz* ubuntu@16.4.31.142:/tmp/
```

On the server:

```bash
cd /tmp && sha256sum -c api-cost-monitor-<version>.tar.gz.sha256
mkdir -p /tmp/acm && tar -xzf /tmp/api-cost-monitor-<version>.tar.gz -C /tmp/acm --strip-components=1
sudo /tmp/acm/deploy/manage.sh setup-host      # user apimon, dirs, /etc/api-cost-monitor/monitor.env, systemd units
```

### 3.5 Write `monitor.env`

`/etc/api-cost-monitor/monitor.env` starts as a copy of [`deploy/monitor.env.example`](../deploy/monitor.env.example). What was set:

| Key(s) | Value |
|---|---|
| `DASHBOARD_OWNER_TOKEN` | a **new** random token (see §5), not the local one |
| `DASHBOARD_VIEWER_TOKEN` | empty (no viewer) |
| `ALLOWED_HOSTS` | `monitor.adhyaapak.ai,127.0.0.1,localhost` |
| `DASHBOARD_URL` | `https://monitor.adhyaapak.ai` (the link in alert emails) |
| `OPENAI_ADMIN_KEY`, `DEEPGRAM_API_KEY`, `DEEPGRAM_PROJECT_ID`, `ELEVENLABS_API_KEY` | from the local `backend/.env` |
| `SMTP_*`, `ALERT_RECIPIENTS` | Gmail (587, `starttls`, an App Password) |
| `EMAIL_DELIVERY_ENABLED` | `false` at first; `true` after a test email worked (§3.10) |
| `AWS_MONITORING_ENABLED` | `false` at first; `true` after the role was attached (§3.9) |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `AWS_PROFILE` | **commented out** (see the pitfall) |
| `COURSE_ASSETS_BUCKET`, `COURSE_ASSETS_REGION` | `tuitionkart-data-bucket`, `ap-south-1` (only for the page's CSP) |
| Polling, currencies, timezone, voucher limit | same as local |

`APP_ENV=production`, `DATABASE_URL` and `BACKUP_DIR` come from the systemd unit, not this file.

> **Pitfall 1: Windows line endings.** A file written on Windows has `\r` at the end of every line, and systemd keeps it as part of each value (`AWS_PROFILE="\r"`, keys with a trailing `\r`). Edit the file **on the server** with `sudo nano`. If it ever came from Windows: `sudo sed -i 's/\r$//' /etc/api-cost-monitor/monitor.env`.
>
> **Pitfall 2: empty AWS lines.** systemd exports every line as an environment variable, empty ones too. An empty `AWS_PROFILE=` makes boto3 look for a profile named "" (`ProfileNotFound`), and the instance role is never used. Keep the four AWS credential lines **commented out** on the server. (Locally the `.env` is only read, not exported, so it does not happen there.)

Then deploy:

```bash
sudo /tmp/acm/deploy/manage.sh deploy /tmp/api-cost-monitor-<version>.tar.gz
sudo /opt/api-cost-monitor/current/deploy/manage.sh status
```

The deploy migrates the database, starts the service, waits for readiness and runs the smoke test (11 checks); on failure it rolls back by itself.

### 3.6 nginx: forward the AdhyaapakAI screens (local-only site for the tunnel)

The UI calls `/api/admin/…`, `/api/vouchers/…` and `/api/academics/…` on its own origin; nginx forwards them to `https://api.adhyaapak.ai` and sends everything else to the dashboard. The rules live in two snippets so the HTTPS site (§6) reuses them. A local-only site on `127.0.0.1:8300` serves them through the SSH tunnel until the domain exists. Full contents: §10.

```bash
sudo ln -sf ../sites-available/api-cost-monitor-local.conf /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

> **Pitfall: "Request origin is not allowed" at sign-in.** The app checks that the browser's `Origin` matches the `Host` it receives. nginx's `$host` drops the port (`localhost` vs `localhost:8200`). The snippet uses `proxy_set_header Host $http_host;`.

### 3.7 S3 bucket CORS (browser uploads)

S3 → `tuitionkart-data-bucket` → Permissions → CORS. The existing dashboard rule gets the new origins (keep any other rules):

```json
[
  {
    "ID": "api-tracking-dashboard-course-uploads",
    "AllowedHeaders": ["*"],
    "AllowedMethods": ["POST", "GET"],
    "AllowedOrigins": ["http://localhost:5173", "http://127.0.0.1:5173", "http://localhost:8200", "https://monitor.adhyaapak.ai"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3000
  }
]
```

Check (no keys needed; 200 = allowed, 403 = not):

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X OPTIONS https://tuitionkart-data-bucket.s3.ap-south-1.amazonaws.com/ \
  -H "Origin: https://monitor.adhyaapak.ai" -H "Access-Control-Request-Method: POST" -H "Access-Control-Request-Headers: content-type"
```

### 3.8 Auto-deploy from GitHub `main` (pull-based)

Chosen over GitHub Actions so that **no port is opened** (SSH stays limited to the admin's IP) and **no secret goes into GitHub**.

1. **Node 22** (Vite needs ≥ 20.19 / 22.12; Ubuntu ships 18), from nodejs.org with its checksum verified, into `/opt/node`.
2. **Build user** `acmbuild` (no shell, no sudo), home `/var/lib/acm-build`.
3. **Read-only deploy key**: `ssh-keygen -t ed25519` for `acmbuild`. The public key was added in GitHub → repo `Tracking-Dashboard` → Settings → Deploy keys → "application-monitor autodeploy", **write access off**. GitHub's host key was checked against GitHub's published fingerprint `SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU`.
4. **Script** `/usr/local/sbin/acm-autodeploy` + **timer** `acm-autodeploy.timer` (§10). For each new commit on `main`, as `acmbuild`: `npm ci` → frontend tests → frontend build → backend tests → `build_release.py`; then as root: the release's own `manage.sh deploy`. If anything fails, nothing is deployed, the commit is marked failed and is not retried; the next commit is.

> **Pitfall: frontend tests that pass on a PC fail on the server.**
> - Dates/times format by the system locale. The server's default is `C`/US (`Nov 3, 2026, 02:05 PM GMT+5:30` instead of `2:05 pm IST`). The script runs the tests with `LANG=en_IN.UTF-8`, like the dev PCs.
> - The slower 2-vCPU server exposed a race in one test (session expiry). Fixed in the repo (commit `4bbd31f`). The script also gives slow-machine timeouts `--retry=2`; a test that always fails still blocks the deploy.

### 3.9 IAM role for AWS costs

1. IAM → Policies → Create policy → JSON = [`aws-monitoring-iam-policy.json`](aws-monitoring-iam-policy.json) → name `application-monitor-readonly`. Every service must show only "Limited: Read/List".
2. IAM → Roles → Create role → AWS service → **EC2** (the plain "EC2" use case) → attach that policy → name `application-monitor-role`.
3. EC2 → instance → Actions → Security → **Modify IAM role** → `application-monitor-role`.
4. Check on the server (IMDSv2): the role name must come back.
   ```bash
   TOK=$(curl -s -X PUT -H "X-aws-ec2-metadata-token-ttl-seconds: 60" http://169.254.169.254/latest/api/token)
   curl -s -H "X-aws-ec2-metadata-token: $TOK" http://169.254.169.254/latest/meta-data/iam/security-credentials/
   ```
5. `AWS_MONITORING_ENABLED=true` in `monitor.env` (credential lines commented out), then `sudo systemctl restart api-cost-monitor`. The log shows `poll finished … provider: aws`.

Cost Explorer must be enabled once in Billing; it bills USD 0.01 per request (about USD 3.60/month at the 6-hour interval).

### 3.10 Email alerts

1. Check SMTP is reachable: `echo QUIT | openssl s_client -starttls smtp -connect smtp.gmail.com:587 -brief`.
2. Dashboard → **Thresholds** → "Send a test email to" → Send (works even while delivery is off).
3. When it arrives: `EMAIL_DELIVERY_ENABLED=true`, restart the service.

Alerts are sent only for providers that have a threshold set on the Thresholds page.

---

## 4. Day-to-day operations

### Open the dashboard (until the domain is live)

```powershell
ssh -i "D:\path\to\application-monitor.pem" -N -L 8200:127.0.0.1:8300 ubuntu@16.4.31.142
```

Keep that window open and browse **http://localhost:8200**. Port 8200 avoids a clash with a local dashboard on 8100. Sign in with the owner token (§5). The AdhyaapakAI screens then ask for the app's admin secret.

### Browse files (VS Code)

Install **Remote - SSH**, add to `C:\Users\<you>\.ssh\config`:

```
Host application-monitor
    HostName 16.4.31.142
    User ubuntu
    IdentityFile "D:\path\to\application-monitor.pem"
```

Then F1 → "Remote-SSH: Connect to Host" → `application-monitor`. Root-only files need `sudo` in the terminal.

### Where things are

| What | Path |
|---|---|
| Config (the server's ".env") | `/etc/api-cost-monitor/monitor.env` (root, 600) |
| Running code | `/opt/api-cost-monitor/current/` → `releases/<version>` (last 5 kept) |
| Database and backups | `/var/lib/api-cost-monitor/monitor.db`, `/var/lib/api-cost-monitor/backups/` (daily, 14 kept) |
| nginx | `/etc/nginx/sites-available/api-cost-monitor-*.conf`, `/etc/nginx/snippets/api-cost-monitor-*.conf` |
| Auto-deploy | `/usr/local/sbin/acm-autodeploy`; clone `/var/lib/acm-build/src`; state `/var/lib/acm-build/state/{deployed,failed}` |

### Everyday commands (on the server)

```bash
sudo /opt/api-cost-monitor/current/deploy/manage.sh status                          # service, release, readiness, backups
sudo journalctl --namespace=api-cost-monitor -u api-cost-monitor -n 100 --no-pager  # dashboard logs (JSON, no secrets)
sudo journalctl -u acm-autodeploy -n 40 --no-pager -o cat | grep '\[autodeploy\]'    # auto-deploy history
sudo cat /var/lib/acm-build/state/deployed                                           # commit that is live
systemctl list-timers acm-autodeploy.timer api-cost-monitor-healthcheck.timer        # next runs
```

### Change a setting

```bash
sudo nano /etc/api-cost-monitor/monitor.env      # edit ON the server (never upload a Windows copy)
sudo systemctl restart api-cost-monitor          # ~3 s downtime
```

### Ship code changes

Push to GitHub `main`. Within 5 minutes the server picks it up; after the tests and the build (about 4–5 minutes) it is live. Check with the commands above: the last line should read `DEPLOYED <commit> "<subject>"`, or `FAILED at <step>`. On failure, nothing changed, the old release keeps running, and the reason is in the log. Push a fix; a failed commit is never retried.

From a PC, in one line:

```powershell
ssh -i KEY ubuntu@16.4.31.142 "echo deployed: `$(sudo cat /var/lib/acm-build/state/deployed); sudo journalctl -u acm-autodeploy -n 40 --no-pager -o cat | grep '\[autodeploy\]' | tail -6"
```

### Deploy by hand / retry a failed commit

```bash
sudo rm -f /var/lib/acm-build/state/failed      # allow the same commit again
sudo systemctl start acm-autodeploy.service     # runs now (blocks until done)
```

Pause auto-deploy: `sudo systemctl stop acm-autodeploy.timer`. Resume: `sudo systemctl start acm-autodeploy.timer`.

### Roll back, back up, restore

```bash
sudo /opt/api-cost-monitor/current/deploy/manage.sh rollback          # previous release
sudo /opt/api-cost-monitor/current/deploy/manage.sh backup            # verified backup now
sudo /opt/api-cost-monitor/current/deploy/manage.sh restore /var/lib/api-cost-monitor/backups/<file>.db
```

A rollback stays until the next new commit on `main` is deployed. If the bad commit is still the newest one, push a fix (or revert) first.

### Local development is unchanged

`start.bat` on a PC still runs the dashboard locally (8100 + 5173) with `backend/.env`. Local and live have **separate** databases and tokens. Local AWS monitoring stays off (no instance role on a PC). The local `frontend/.env` decides which AdhyaapakAI backend the local UI uses (`ADHYAAPAK_BACKEND_URL`); when it points to `https://api.adhyaapak.ai`, local saves also change the live app.

---

## 5. The dashboard owner token: find it, change it

The owner token is the password for the dashboard's sign-in page (full access). The viewer token, if set, gives read-only access. Both live only in `monitor.env` on the server. The server one is **different** from the one in a local `backend/.env`.

### Find the current token

```bash
sudo grep '^DASHBOARD_OWNER_TOKEN=' /etc/api-cost-monitor/monitor.env | cut -d= -f2-
```

Copy it into a password manager. Don't paste it into chats, tickets or docs.

### Change it (for example after it was shared, or a person leaves)

```bash
# 1. a new random token (shown once in your terminal)
python3 -c "import secrets; print(secrets.token_urlsafe(48))"
# 2. put it in the config (replace NEW_TOKEN with what step 1 printed)
sudo sed -i 's|^DASHBOARD_OWNER_TOKEN=.*|DASHBOARD_OWNER_TOKEN=NEW_TOKEN|' /etc/api-cost-monitor/monitor.env
# 3. apply it
sudo systemctl restart api-cost-monitor
```

Or edit the line with `sudo nano /etc/api-cost-monitor/monitor.env`. Rules:
- at least 32 characters (the deploy refuses shorter ones);
- the viewer token must differ from the owner token;
- no spaces, quotes or `#`.

**Every session signed in with the old token is signed out.** Sign in again with the new one.

### Viewer (read-only) token

Same steps with `DASHBOARD_VIEWER_TOKEN=`. Leave it empty to turn viewer access off.

---

## 6. Next step: the domain `monitor.adhyaapak.ai` with HTTPS

`ALLOWED_HOSTS`, `DASHBOARD_URL` and the S3 CORS already include the domain. What remains:

1. **DNS** (wherever `adhyaapak.ai` is managed): `A` record, name `monitor`, value `16.4.31.142`, TTL 300. On Cloudflare set it to **DNS only** (grey cloud), at least until the certificate exists. Check: `nslookup monitor.adhyaapak.ai` → `16.4.31.142`.
2. **Port-80 site** (for the certificate), `/etc/nginx/sites-available/api-cost-monitor-public.conf`:
   ```nginx
   limit_req_zone $binary_remote_addr zone=acm_login:1m rate=10r/m;

   server {
       listen 80;
       listen [::]:80;
       server_name monitor.adhyaapak.ai;
       location ^~ /.well-known/acme-challenge/ { root /var/www/letsencrypt; default_type text/plain; }
       location / { return 301 https://$host$request_uri; }
   }
   ```
   ```bash
   sudo mkdir -p /var/www/letsencrypt
   sudo ln -sf ../sites-available/api-cost-monitor-public.conf /etc/nginx/sites-enabled/
   sudo nginx -t && sudo systemctl reload nginx
   sudo certbot certonly --webroot -w /var/www/letsencrypt -d monitor.adhyaapak.ai \
        --deploy-hook "systemctl reload nginx"          # renewals reload nginx too
   ```
3. **Add the HTTPS server** to the same file, then `sudo nginx -t && sudo systemctl reload nginx`:
   ```nginx
   server {
       listen 443 ssl http2;
       listen [::]:443 ssl http2;
       server_name monitor.adhyaapak.ai;

       ssl_certificate     /etc/letsencrypt/live/monitor.adhyaapak.ai/fullchain.pem;
       ssl_certificate_key /etc/letsencrypt/live/monitor.adhyaapak.ai/privkey.pem;
       ssl_protocols TLSv1.2 TLSv1.3;
       ssl_session_cache shared:acm_ssl:5m;
       ssl_session_tickets off;
       add_header Strict-Transport-Security "max-age=31536000" always;
       server_tokens off;

       access_log /var/log/nginx/api-cost-monitor.access.log;
       error_log  /var/log/nginx/api-cost-monitor.error.log warn;

       location = /api/v1/auth/login {
           limit_req zone=acm_login burst=5 nodelay;
           limit_req_status 429;
           proxy_http_version 1.1;
           proxy_set_header Host $http_host;
           proxy_set_header X-Forwarded-For $remote_addr;
           proxy_set_header X-Forwarded-Proto $scheme;
           proxy_pass http://127.0.0.1:8100;
       }
       include /etc/nginx/snippets/api-cost-monitor-locations.conf;
   }
   ```
4. **Verify** from a PC: open https://monitor.adhyaapak.ai, sign in, open Course Management with the admin secret. Then run `python deploy/smoke_test.py --base-url https://monitor.adhyaapak.ai --login` (token from `SMOKE_TOKEN` or prompted).
5. Optional: remove `http://localhost:8200` from the S3 CORS, and the tunnel site (`sudo rm /etc/nginx/sites-enabled/api-cost-monitor-local.conf && sudo systemctl reload nginx`) once the tunnel is no longer used.

Certificates renew automatically (`certbot.timer`). Check with `sudo certbot renew --dry-run`.

---

## 7. Rebuild from scratch (checklist)

Use this if the instance is lost or a second one is needed. Each line points to the section with the commands.

1. Launch the instance, Elastic IP, security group with IPv4 SSH (§3.1); fix key permissions (§3.2).
2. Packages and swap (§3.3).
3. Build a release on a PC and run `setup-host` (§3.4).
4. Write `monitor.env` on the server with `nano`: new owner token; AWS credential lines commented out; email and AWS off at first (§3.5, §5).
5. `manage.sh deploy` (§3.5).
6. nginx snippets and the local site (§3.6, §10).
7. Node 22, `acmbuild`, deploy key (add the **new** public key in GitHub; delete the old one), script and timer (§3.8, §10). Set the state so the current commit counts as deployed, or let the first run redeploy it.
8. IAM role (§3.9), email test (§3.10).
9. Domain (§6). If the Elastic IP changed, update the DNS record.
10. Restore data if needed: copy a `monitor-*.db` backup and run `manage.sh restore` (§4).

Before shutting an instance down for good: copy `/var/lib/api-cost-monitor/backups/` off it and **release the Elastic IP** (an unattached Elastic IP is billed).

---

## 8. Troubleshooting: problems already met

| Symptom | Cause | Fix |
|---|---|---|
| `ssh: connect … port 22: Connection timed out` | SSH rule allows a different IP (often the IPv6 range picked by "My IP"), or your internet IP changed | Security group: SSH from your current **IPv4** `/32` (§3.1) |
| `UNPROTECTED PRIVATE KEY FILE` / `bad permissions` (Windows) | The `.pem` is readable by other users | `icacls` commands in §3.2 |
| Course Management etc. show `Request failed (404)` | The browser reached the dashboard directly (tunnel to 8100), not nginx | Tunnel to **8300**: `-L 8200:127.0.0.1:8300` (§4) |
| Sign-in says `Request origin is not allowed` | nginx sent `Host` without the port | `proxy_set_header Host $http_host;` (§3.6) |
| Admin screens: `403` with the right secret | Wrong admin secret, or the AdhyaapakAI backend lacks `ADMIN_SECRET` | Check the app backend's `.env` |
| App videos / banner upload fails in the browser | The S3 bucket CORS lacks the dashboard's origin | §3.7 |
| Log: `aws adapter could not be created … ProfileNotFound` | Empty `AWS_PROFILE=` (or a trailing `\r`) in `monitor.env` | Comment out the AWS credential lines; strip `\r` (§3.5) |
| AWS poll: `balance: permission_denied` | Credits API refused (no credits, or a member account of an AWS Organization) | See §9; costs and resources still work |
| Provider keys rejected right after setup | `monitor.env` came from Windows (`\r` in every value) | `sudo sed -i 's/\r$//' /etc/api-cost-monitor/monitor.env`, restart |
| Auto-deploy `FAILED at frontend tests`, though tests pass on a PC | Server locale (US formats) or a slow-machine race | The script uses `LANG=en_IN.UTF-8` and `--retry=2`; fix real races in the test |
| Auto-deploy does nothing after a push | The commit is marked failed, or the timer is stopped | `cat /var/lib/acm-build/state/failed`; `systemctl list-timers acm-autodeploy.timer` (§4) |
| `git ls-remote` fails for `acmbuild` | Deploy key missing in GitHub, or the repo was renamed | Re-add the public key; `REPO_URL` in the script uses `Tracking-Dashboard` |
| `/api/v1/ready` 503 | Database, disk or migrations problem | `manage.sh status`, journal; `manage.sh rollback` if it began with a deploy |

---

## 9. Security notes and open follow-ups

- **Secrets live only in** `/etc/api-cost-monitor/monitor.env` (server) and the local `backend/.env` (PC). Never in git, docs, tickets or chats. The release builder refuses `.env` files, databases and key-like text.
- **Rotate the keys that were exposed** while setting this up (they were pasted into a chat on 2026-11-21): the MongoDB password, the old `COURSE_ASSETS_*` AWS access key (deactivate it in IAM if nothing uses it), the AdhyaapakAI admin secret, the OpenAI admin key, the Deepgram and ElevenLabs keys, the Gmail App Password, and the old local owner token. After rotating, update `monitor.env` on the server (§4) and the local `.env`.
- **SSH** is open to one admin IPv4 only, key login only. Keep the `.pem` private.
- **Anyone who can push to `main` deploys to production.** Turn on branch protection in GitHub (pull requests and reviews before merge).
- The deploy key is **read-only** and lives only on the server. To revoke it, delete it in GitHub → Settings → Deploy keys.
- The admin secret for the AdhyaapakAI screens is typed into the browser tab and kept in that tab only. The dashboard server never stores it.

**Open follow-ups**
1. Finish the domain (§6).
2. Repo fix: in `deploy/monitor.env.example` and `docs/DEPLOYMENT.md`, comment out the empty `AWS_ACCESS_KEY_ID/SECRET/SESSION_TOKEN/PROFILE` lines and explain why (the systemd pitfall in §3.5), so a new server doesn't hit `ProfileNotFound`.
3. Repo fix: make the frontend tests independent of the system locale (set `en-IN` in the test setup), so `LANG` in the server script is no longer needed.
4. AWS credits `permission_denied`: check whether the account has credits or belongs to an Organization.
5. Optional: show the deployed commit in the dashboard's sidebar.
6. Optional: a CloudWatch alarm on the instance status check, so an outage is noticed while nobody is looking.

---

## 10. Appendix: files created on the server

### `/etc/nginx/snippets/api-cost-monitor-adhyaapak.conf`

```nginx
# Forward to the AdhyaapakAI backend's admin API (the browser sends x-admin-secret).
proxy_pass https://api.adhyaapak.ai;
proxy_ssl_server_name on;
proxy_ssl_name api.adhyaapak.ai;
proxy_http_version 1.1;
proxy_set_header Host              api.adhyaapak.ai;
proxy_set_header X-Forwarded-For   $remote_addr;
proxy_set_header X-Forwarded-Proto $scheme;
proxy_set_header Connection        "";
proxy_set_header Cookie            "";   # never pass the dashboard's session cookie on
proxy_connect_timeout 10s;
proxy_read_timeout    120s;
```

### `/etc/nginx/snippets/api-cost-monitor-locations.conf`

```nginx
client_max_body_size 64k;
proxy_http_version 1.1;
proxy_set_header Host              $http_host;   # with the port: the app checks Origin against it
proxy_set_header X-Forwarded-For   $remote_addr;
proxy_set_header X-Forwarded-Proto $scheme;
proxy_set_header Connection        "";
proxy_connect_timeout 5s;
proxy_read_timeout    60s;

location ^~ /api/admin/     { client_max_body_size 4m; include /etc/nginx/snippets/api-cost-monitor-adhyaapak.conf; }
location ^~ /api/vouchers/  { client_max_body_size 1m; include /etc/nginx/snippets/api-cost-monitor-adhyaapak.conf; }
location ^~ /api/academics/ { include /etc/nginx/snippets/api-cost-monitor-adhyaapak.conf; }

location = /api/v1/placement-drives/parse-pdf { client_max_body_size 11m; proxy_pass http://127.0.0.1:8100; }
location = /api/v1/placement-drives/xlsx      { client_max_body_size 33m; proxy_pass http://127.0.0.1:8100; }
location = /api/v1/events {
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 360s;
    proxy_pass http://127.0.0.1:8100;
}
location / { proxy_pass http://127.0.0.1:8100; }
```

### `/etc/nginx/sites-available/api-cost-monitor-local.conf` (tunnel only)

```nginx
server {
    listen 127.0.0.1:8300;
    server_name localhost;
    server_tokens off;
    access_log /var/log/nginx/api-cost-monitor-local.access.log;
    error_log  /var/log/nginx/api-cost-monitor-local.error.log warn;
    include /etc/nginx/snippets/api-cost-monitor-locations.conf;
}
```

### `/etc/systemd/system/acm-autodeploy.service` and `.timer`

```ini
[Unit]
Description=API Cost Monitor: deploy the latest commit of GitHub main (build + tests first)
Wants=network-online.target
After=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/acm-autodeploy
Nice=10
TimeoutStartSec=45min
```

```ini
[Unit]
Description=Check GitHub main for a new API Cost Monitor commit every 5 minutes

[Timer]
OnBootSec=3min
OnUnitActiveSec=5min
RandomizedDelaySec=30s
Persistent=true

[Install]
WantedBy=timers.target
```

Enable: `sudo systemctl daemon-reload && sudo systemctl enable --now acm-autodeploy.timer`.

### `/usr/local/sbin/acm-autodeploy` (root:root 0755)

```bash
#!/usr/bin/env bash
# Keep the API Cost Monitor on the latest commit of GitHub's main branch (pull-based).
set -euo pipefail
umask 022

REPO_URL="git@github.com:aidatacrafttech-commits/Tracking-Dashboard.git"
BRANCH="main"
HOME_DIR=/var/lib/acm-build
SRC="$HOME_DIR/src"
VENV="$HOME_DIR/test-venv"
STATE="$HOME_DIR/state"
LOCK=/run/acm-autodeploy.lock
B="sudo -u acmbuild -H env PATH=/opt/node/bin:/usr/local/bin:/usr/bin:/bin HOME=$HOME_DIR"

log() { echo "[autodeploy] $*"; }

exec 9>"$LOCK"
flock -n 9 || { log "another run is in progress"; exit 0; }

$B mkdir -p "$STATE"
if [[ ! -d "$SRC/.git" ]]; then
  log "cloning $REPO_URL"
  $B git clone --quiet --branch "$BRANCH" "$REPO_URL" "$SRC"
fi
$B git -C "$SRC" fetch --quiet origin "$BRANCH"
sha=$($B git -C "$SRC" rev-parse "origin/$BRANCH")
deployed=$(cat "$STATE/deployed" 2>/dev/null || true)
failed=$(cat "$STATE/failed" 2>/dev/null || true)
if [[ "$sha" == "$deployed" ]]; then exit 0; fi
if [[ "$sha" == "$failed" ]]; then exit 0; fi

short=${sha:0:8}
subject=$($B git -C "$SRC" log -1 --format=%s "$sha")
log "new commit on $BRANCH: $short \"$subject\" (deployed: ${deployed:0:8})"

fail() { echo "$sha" | $B tee "$STATE/failed" >/dev/null; log "FAILED at $1 for $short - not deployed (the current release keeps running)"; exit 1; }

$B git -C "$SRC" checkout --quiet --force --detach "$sha" || fail "checkout"
$B git -C "$SRC" clean -qfdx -e frontend/node_modules || fail "clean"

log "frontend: npm ci"
$B bash -c "cd '$SRC/frontend' && npm ci --no-audit --no-fund --loglevel=error" || fail "npm ci"
log "frontend: tests (locale en_IN like the dev machines; slow-machine timeouts get 2 retries)"
$B bash -c "cd '$SRC/frontend' && LANG=en_IN.UTF-8 npx vitest run --reporter=dot --retry=2" || fail "frontend tests"
log "frontend: build"
$B bash -c "cd '$SRC/frontend' && VITE_ADHYAAPAK_API_BASE=/api npm run build --silent" || fail "frontend build"

log "backend: test environment"
[[ -x "$VENV/bin/python" ]] || $B python3.12 -m venv "$VENV" || fail "venv"
$B "$VENV/bin/python" -m pip install --quiet --disable-pip-version-check \
    -r "$SRC/backend/requirements.lock" pytest==9.1.1 httpx || fail "pip install"
log "backend: tests"
$B bash -c "cd '$SRC/backend' && '$VENV/bin/python' -m pytest -q -p no:cacheprovider" || fail "backend tests"

log "building the release"
$B bash -c "cd '$SRC' && rm -rf release && '$VENV/bin/python' deploy/build_release.py" || fail "build_release"
tarball=$(ls -1 "$SRC"/release/api-cost-monitor-*.tar.gz | head -1)
[[ -f "$tarball" ]] || fail "release tarball"

work=$(mktemp -d /var/tmp/acm-release.XXXXXX)
trap 'rm -rf "$work"' EXIT
cp "$tarball" "$work/release.tar.gz"
mkdir "$work/x"
tar -xzf "$work/release.tar.gz" -C "$work/x" --strip-components=1 --no-same-owner
log "deploying $(cat "$work/x/VERSION") (commit $short)"
if "$work/x/deploy/manage.sh" deploy "$work/release.tar.gz"; then
  echo "$sha" | $B tee "$STATE/deployed" >/dev/null
  $B rm -f "$STATE/failed"
  log "DEPLOYED $short \"$subject\""
else
  fail "deploy (manage.sh rolled back)"
fi
```

If you copy this script from Windows, strip the line endings on the server: `sudo sed -i 's/\r$//' /usr/local/sbin/acm-autodeploy`.
