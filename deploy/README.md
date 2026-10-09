# Production deployment: comicsol.com

Two independent surfaces:
- `comicsol.com` — public, *static landing only*, deployed via Cloudflare Pages.
- `studio.comicsol.com` — private single-creator application, VPS + Cloudflare Tunnel + Cloudflare Access.

## 1. Prerequisites

Prepare Ubuntu 24.04 with Python 3.11+ (Ubuntu 24.04 ships 3.12), Git, enough
storage for PNG/PDF files, and SSH. Add 2FA to GitHub and Cloudflare accounts.
Restrict SSH to your IP, use SSH keys, and do not open port 8766.
Don't upload tokens or the environment file to Git.

## 2. VPS setup

Run on the VPS as a sudo-capable operator:

```bash
sudo apt update
sudo apt install -y git python3 python3-venv
sudo useradd --system --home-dir /var/lib/comicsol-studio --shell /usr/sbin/nologin comicsol
sudo mkdir -p /opt /var/lib/comicsol-studio /etc/comicsol-studio
sudo chown comicsol:comicsol /var/lib/comicsol-studio
sudo chmod 700 /var/lib/comicsol-studio /etc/comicsol-studio
sudo git clone https://github.com/wenn-id/comicsol-studio.git /opt/comicsol-studio
cd /opt/comicsol-studio
sudo git checkout main
sudo python3 -m venv .venv
sudo .venv/bin/python -m pip install --upgrade pip
sudo .venv/bin/python -m pip install .
```

After the production PR is merged, pull `main` to get `deploy/`.
Create `/etc/comicsol-studio/environment` (mode 600, root-owned) with:

```dotenv
COMICSOL_STUDIO_PUBLIC_ORIGIN=https://studio.comicsol.com
# Optional, keep provider secrets on the VPS only:
# OPENAI_API_KEY=...
# ANTHROPIC_API_KEY=...
```

Install the unit and start Studio:

```bash
sudo chown root:root /etc/comicsol-studio/environment
sudo chmod 600 /etc/comicsol-studio/environment
sudo cp /opt/comicsol-studio/deploy/comicsol-studio.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now comicsol-studio
curl -fsS http://127.0.0.1:8766/healthz
sudo systemctl status comicsol-studio
```

Expect `{"status":"ok"}`. Keep `/var/lib/comicsol-studio` on persistent disk.
Back up the complete data root while the service is stopped, or use a
SQLite-consistent snapshot plus the files. Restore-test regularly.

## 3. Cloudflare Tunnel and Access

In the Cloudflare Zero Trust dashboard, create a remotely-managed Tunnel
and follow Cloudflare's displayed `cloudflared` installation command on
the VPS. Do **not** paste or commit the tunnel token.

Create a public hostname route:
- Hostname: `studio.comicsol.com`
- Type: `HTTP`
- Service URL: `http://localhost:8766`

**Before publishing the hostname**, protect the application using
Cloudflare Access > Applications > Add application > Self-hosted.
Set application domain to `studio.comicsol.com`, configure an allow policy
for the one intended creator's identity, and require an identity provider/OTP.
Test the policy in an incognito browser; an unauthenticated visitor must not
be able to read `/api/projects` or `/api/session`.

For additional production hardening, authenticate and verify Access JWTs
at the Studio origin, or use a tunnel with an Access-enforcing origin,
before adding other creators or sensitive projects. This version remains
a **single-creator** product, not a multi-tenant SaaS.

## 4. Cloudflare Pages landing

Create Workers & Pages > Create > Pages > Connect to Git, select this repo.
Use:
- Production branch: `main`
- Build command: `python3 deploy/build_landing.py --out public_site`
- Build output directory: `public_site`
- Root directory: repository root

If the Pages builder's Python version is incompatible, no dependencies are
required for this script beyond Python 3.11.
In Pages > Custom domains, attach `comicsol.com` and optionally
`www.comicsol.com`. Verify existing DNS records for email before changing
anything. Cloudflare will configure necessary Pages DNS records.

The public build deliberately excludes `/studio/`, `/api/` and the
demo recording. All landing CTAs point at `https://studio.comicsol.com/studio/`.

## 5. Verify

- `https://comicsol.com` shows landing and book.
- Open Studio points to `https://studio.comicsol.com/studio/`.
- Unauthenticated Studio requests are blocked at Cloudflare Access.
- Authenticated Studio session receives Secure CSRF cookie; create, reload,
  review, and PDF export all work.
- VPS: `curl -fsS http://127.0.0.1:8766/healthz` reports healthy.
- Cloudflare SSL/TLS is configured; never turn off browser HTTPS.
- Backups and a restore test have been completed.

## 6. Upgrades

```bash
sudo systemctl stop comicsol-studio
cd /opt/comicsol-studio
sudo git pull --ff-only origin main
sudo .venv/bin/python -m pip install .
sudo systemctl start comicsol-studio
sudo systemctl status comicsol-studio
```

Validate the change on staging before upgrading production. Ensure the old
data root is backed up; rolling back code may not support changed schema.
