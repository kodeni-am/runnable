# Runnable

Runnable is a self-hosted web application for managing server directories and hosting them via Caddy, Nginx, or Apache. It supports custom domains, static file hosting, internal routing, and GitHub integration for auto-deployment. 

## Setting up GitHub OAuth

To allow users to log in with their GitHub account or to connect repositories to projects (for automatic deployments or pulling code), you need to set up a GitHub OAuth application.

### Step 1: Create the OAuth App in GitHub
1. Go to your GitHub account settings.
2. Scroll to the bottom of the left sidebar and click on **Developer settings**.
3. In the left sidebar, click on **OAuth Apps**, then click **New OAuth App**.
4. Fill in the application details:
   - **Application name**: e.g., "Runnable Deployment Manager"
   - **Homepage URL**: Your application's public URL, e.g., `https://runnable.dev` or `http://localhost:5175` for local development.
   - **Authorization callback URL**: `http://localhost:3001/api/auth/github/callback` (or your production URL ending in `/api/auth/github/callback`).
5. Click **Register application**.

### Step 2: Configure Environment Variables
1. Once the app is created, you will be taken to its settings page.
2. Copy the **Client ID** and paste it into your `.env` file as `GITHUB_CLIENT_ID`.
3. Click **Generate a new client secret**.
4. Copy the new **Client Secret** and paste it into your `.env` file as `GITHUB_CLIENT_SECRET`.
5. Ensure that `GITHUB_CALLBACK_URL` in your `.env` file matches the callback URL you specified in GitHub exactly.

Example `.env` configuration:
```env
GITHUB_CLIENT_ID=your_client_id_here
GITHUB_CLIENT_SECRET=your_client_secret_here
GITHUB_CALLBACK_URL=http://localhost:3001/api/auth/github/callback
```

### Step 3: Restart the Server
Once your `.env` variables are configured, stop and restart the Runnable backend server so that the Passport.js GitHub OAuth strategy registers the new credentials. Users will now be able to log in with GitHub and connect repositories!

---

## Setting up Google OAuth

To allow users to log in with their Google account, you need to create a Google OAuth 2.0 application in the Google Cloud Console.

### Step 1: Create a Google Cloud Project
1. Go to the [Google Cloud Console](https://console.cloud.google.com/).
2. Click the project dropdown at the top of the page and select **New Project**.
3. Give your project a name (e.g., "Runnable") and click **Create**.
4. Make sure the new project is selected in the project dropdown.

### Step 2: Configure the OAuth Consent Screen
1. In the left sidebar, navigate to **APIs & Services → OAuth consent screen**.
2. Select **External** as the user type (unless you have a Google Workspace org and want to restrict to internal users), then click **Create**.
3. Fill in the required fields:
   - **App name**: e.g., "Runnable"
   - **User support email**: your email address
   - **Developer contact information**: your email address
4. Click **Save and Continue**.
5. On the **Scopes** page, click **Add or Remove Scopes** and add:
   - `email`
   - `profile`
   - `openid`
6. Click **Save and Continue** through the remaining steps.

### Step 3: Create OAuth 2.0 Credentials
1. In the left sidebar, navigate to **APIs & Services → Credentials**.
2. Click **+ Create Credentials → OAuth client ID**.
3. Select **Web application** as the application type.
4. Give it a name (e.g., "Runnable Web Client").
5. Under **Authorized JavaScript origins**, add:
   - `http://localhost:5175` (for local development)
   - `https://yourdomain.com` (for production)
6. Under **Authorized redirect URIs**, add:
   - `http://localhost:3001/api/auth/google/callback` (for local development)
   - `https://api.yourdomain.com/api/auth/google/callback` (for production)
7. Click **Create**.

### Step 4: Configure Environment Variables
1. After creating the credentials, a dialog will show your **Client ID** and **Client Secret**.
2. Copy these values into your `.env` file:

```env
GOOGLE_CLIENT_ID=your_google_client_id_here
GOOGLE_CLIENT_SECRET=your_google_client_secret_here
GOOGLE_CALLBACK_URL=http://localhost:3001/api/auth/google/callback
```

For production, update `GOOGLE_CALLBACK_URL` to match your domain:
```env
GOOGLE_CALLBACK_URL=https://api.yourdomain.com/api/auth/google/callback
```

### Step 5: Restart the Server
Stop and restart the Runnable backend server so that the Passport.js Google OAuth strategy registers the new credentials. Users will now see a **Google** login button on the Login and Register pages.

> **Note**: If you are in development/testing mode and haven't published your OAuth consent screen, only test users you explicitly add in the Google Cloud Console will be able to log in. To add test users, go to **APIs & Services → OAuth consent screen → Test users**.

---

## Server Deployment (Ubuntu)

Runnable includes a one-command setup script that installs and configures everything on a fresh Ubuntu server.

### Prerequisites

- A fresh **Ubuntu 22.04 or 24.04 LTS** server
- A domain name with DNS access
- Root (sudo) access

### Quick Start

```bash
# Clone the repository
git clone https://github.com/your-org/runnable.git
cd runnable

# Make the script executable and run it
chmod +x setup.sh
sudo ./setup.sh --domain yourdomain.com --email admin@yourdomain.com
```

Or install directly from a Git repo:

```bash
sudo ./setup.sh \
  --domain yourdomain.com \
  --email admin@yourdomain.com \
  --repo https://github.com/your-org/runnable.git \
  --branch main
```

### What the Script Installs

| Component      | Details                                       |
|----------------|-----------------------------------------------|
| Node.js        | v20 LTS                                       |
| Docker         | Latest + BuildKit daemon                      |
| PostgreSQL     | v16, creates `runnable` database and user     |
| Caddy          | Reverse proxy with automatic HTTPS            |
| Railpack       | Universal app builder for user projects       |
| Systemd        | Auto-restart service for the Runnable server  |

### DNS Configuration

Before running the script (or immediately after), point these DNS records to your server's IP address:

| Record | Name                  | Type |
|--------|-----------------------|------|
| @      | `yourdomain.com`      | A    |
| api    | `api.yourdomain.com`  | A    |
| *      | `*.yourdomain.com`    | A    |

> The wildcard record is required so that each deployed project gets its own subdomain automatically.

### Post-Install Steps

1. **Save your credentials** — the admin password is randomly generated and displayed only once at the end of the script.

2. **Configure GitHub OAuth** — follow the [GitHub OAuth](#setting-up-github-oauth) section above, then update the `.env`:
   ```bash
   sudo nano /opt/runnable/.env
   # Fill in GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET
   sudo systemctl restart runnable
   ```

3. **Configure Google OAuth** (optional) — follow the [Google OAuth](#setting-up-google-oauth) section above, then update the `.env`:
   ```bash
   sudo nano /opt/runnable/.env
   # Fill in GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET
   sudo systemctl restart runnable
   ```

4. **Access the dashboard** — open `https://yourdomain.com` in your browser and log in with the admin credentials shown after setup.

### Management Commands

```bash
# View live logs
journalctl -u runnable -f

# Restart the server
sudo systemctl restart runnable

# Stop / Start
sudo systemctl stop runnable
sudo systemctl start runnable

# Check status
sudo systemctl status runnable

# Edit environment variables
sudo nano /opt/runnable/.env
sudo systemctl restart runnable

# Update to latest code
cd /opt/runnable
git pull
npm install
npm run build
sudo systemctl restart runnable
```

`update.sh` performs the same steps as `deploy.sh` but is driven by the portal's
self-update button, records progress to `$STATE_DIR/update-state.json`, and
rolls back to the previous commit if the new revision fails to build or fails
to come back healthy. Run it by hand only with `--dry-run`, and point
`STATE_DIR` at a scratch directory when you do — `--dry-run` still refuses to
touch the real state file or log, but a scratch directory keeps a hand test
from being confused with the portal's own run. The portal launches the real
thing in its own systemd unit. See
`docs/migration-compatibility.md` for the constraint this places on migrations.

### Script Options

| Flag       | Description                              | Default     |
|------------|------------------------------------------|-------------|
| `--domain` | Base domain for Runnable **(required)**  | —           |
| `--email`  | Admin email address **(required)**       | —           |
| `--repo`   | Git repository URL to clone from         | Current dir |
| `--branch` | Git branch to use                        | `main`      |

### Wildcard Custom Domains

An admin can add a wildcard domain such as `*.example.com` to a project. Unlike regular domains, Caddy cannot issue its certificate automatically, so you supply one (for example a Cloudflare Origin certificate) as files on the server:

- Certificate: `/etc/caddy/certs/<apex>.origin.pem`
- Key: `/etc/caddy/certs/<apex>.origin.key`
- Owner `root:caddy`, mode `0640`

```bash
sudo install -d -m 0750 -o root -g caddy /etc/caddy/certs
sudo install -m 0640 -o root -g caddy origin.pem /etc/caddy/certs/example.com.origin.pem
sudo install -m 0640 -o root -g caddy origin.key /etc/caddy/certs/example.com.origin.key
```

Issue the certificate for the wildcard name only (`*.example.com`), not the apex. Caddy does not request a Let's Encrypt certificate for any name a loaded certificate covers, so leaving the apex out keeps its automatic certificate. Every other host the wildcard covers (one label deep, for example `www.example.com`) is then served the supplied certificate. With a Cloudflare Origin certificate, browsers trust it only behind the Cloudflare proxy, so keep those hosts proxied (orange cloud, SSL mode Full (strict)).

Then add the domain in the project's Domains tab, filling in the certificate and key paths. Ownership is verified with a TXT record at the apex: `_runnable-verify.<apex>` with the project ID as its value. The wildcard gets its own Caddy site block using `tls <cert> <key>`.

Because a certificate Caddy cannot load fails the reload for every site, Runnable checks the files on every config write and skips the wildcard block with a warning in the server log unless all of these hold:

- both files parse as PEM: a certificate (a chain is fine, leaf first) and an unencrypted private key;
- the key matches the certificate;
- the certificate has not expired;
- the certificate covers a host directly under the apex (`x.<apex>`), so a wildcard-only certificate passes;
- the `caddy` user can read both files and traverse every parent directory, judged from the file mode bits and the user's groups in `/etc/passwd` and `/etc/group` (skipped on hosts without a `caddy` user).

After adding the domain, it is still worth running `sudo caddy validate --config /etc/caddy/Caddyfile`.

A user cannot add an exact domain that another project's wildcard covers (for example `anna.example.com` under `*.example.com`), and a wildcard cannot be added while another project owns an exact domain it covers. Both requests fail with a message naming the conflict.

**Rolling back:** remove all wildcard domains before rolling Runnable back to a release without wildcard support. Older releases reject `*.` names when they rebuild the Caddy config, so starting, deploying or reloading that project would fail.

## Private NPM Registries

A project can install from a private npm registry: set the registry URL, an
optional scope, and an auth token in the project's settings. The token is
encrypted at rest and written to a temporary `.npmrc` that is deleted at the
end of each build. Note for operators: because the build copies the project
directory into the image it builds, the token also ends up in Docker's build
cache and image layers for that build, and persists there until you prune
them (e.g. `docker buildx prune`) or rotate the token.

### Rotating JWT_SECRET

`JWT_SECRET` also derives the key that encrypts stored private-registry npm
tokens. Rotating it invalidates every session (expected) **and** makes stored
registry tokens undecryptable — affected projects fail their next build with
"Stored npm registry token could not be decrypted" until the token is re-entered
in project settings.
