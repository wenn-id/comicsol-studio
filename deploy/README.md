# Production deployment: comicsol.com

Two independent surfaces:
- `comicsol.com` — public, *static landing only*, deployed via Cloudflare Pages.
- `studio.comicsol.com` — single-creator application, VPS + Cloudflare Tunnel + Studio password login.

## 1. Prerequisites

Prepare an Ubuntu host with working APT, Git, curl, enough storage for PNG/PDF,
and SSH. Ubuntu 26.04 ships Python 3.14, while the project's CI tests use 3.11.
Install isolated Python 3.11 via uv into /opt/comicsol-python; do not replace
the system interpreter. Add 2FA to GitHub and Cloudflare accounts. Restrict SSH
to your IP, use SSH keys, and do not open port 8766.
Don't upload tokens or the environment file to Git.

## 2. VPS setup

Run on the VPS as the SSH user with sudo privileges.
Keep the Python runtime in /opt, readable by the restricted service user:

```bash
sudo apt update
sudo apt install -y git curl ca-certificates
curl -LsSf https://astral.sh/uv/install.sh | sh
export PATH="$HOME/.local/bin:$PATH"
sudo install -d -o "$USER" -g "$USER" -m 755 /opt/comicsol-python
UV_PYTHON_INSTALL_DIR=/opt/comicsol-python uv python install 3.11

sudo useradd --system --home-dir /var/lib/comicsol-studio --shell /usr/sbin/nologin comicsol
sudo install -d -o comicsol -g comicsol -m 700 /var/lib/comicsol-studio
sudo install -d -m 700 /etc/comicsol-studio
sudo git clone https://github.com/wenn-id/comicsol-studio.git /opt/comicsol-studio
sudo chown -R "$USER":"$USER" /opt/comicsol-studio
cd /opt/comicsol-studio
UV_PYTHON_INSTALL_DIR=/opt/comicsol-python uv venv --python 3.11 .venv
uv pip install --python .venv/bin/python .
.venv/bin/python --version
```

Use the reviewed deployment revision. The service account writes to /var/lib/comicsol-studio,
not to the source checkout or the Python runtime.

Create `/etc/comicsol-studio/environment` (mode 600, root-owned) with:

```dotenv
COMICSOL_STUDIO_PUBLIC_ORIGIN=https://studio.comicsol.com
# Optional, keep provider secrets on the VPS only:
# OPENAI_API_KEY=...
# ANTHROPIC_API_KEY=...
```

Install the unit and start Studio:

```bash
# Set the username and password interactively as the service user.
# Passwords are hidden, must have at least 12 characters, and are stored only as salted hashes.
sudo -u comicsol /opt/comicsol-studio/.venv/bin/python -m comicsol_studio \
  --data-root /var/lib/comicsol-studio --set-login

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

## 3. Cloudflare Tunnel

In the Cloudflare Zero Trust dashboard, create a remotely-managed Tunnel
and follow Cloudflare's displayed `cloudflared` installation command on
the VPS. Do **not** paste or commit the tunnel token.

Create a public hostname route:
- Hostname: `studio.comicsol.com`
- Type: `HTTP`
- Service URL: `http://localhost:8766`

Cloudflare Access is not required. Studio itself redirects visitors from `/studio/`
to `/login` and returns HTTP 401 for unauthenticated API requests. If migrating an
existing tunnel with an Access application, remove that Access application after
verifying the Studio login through the new tunnel. Keep other Access applications intact.

Test in an incognito browser: `/studio/` must show the username/password form;
`/api/projects` and `/api/session` must return HTTP 401. Sign in, create a project,
then sign out and verify the API is blocked again. Session cookies are Secure,
HttpOnly and SameSite=Strict; sign-in attempts are limited to ten per five minutes
across the workspace. Sessions persist across restarts and expire after seven days.
Studio will refuse to start with a public origin until credentials are configured.
This version remains a **single-creator** product, not a multi-tenant SaaS.

To change or recover the password, run the same `--set-login` command over SSH.
It revokes every old session immediately. Include `login.sqlite3` in data-root
backups and reset the password after a restore to invalidate restored sessions.

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
- Unauthenticated Studio pages redirect to `/login`; API and file requests return 401.
- The username/password login and Sign out both work without Cloudflare Access.
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
