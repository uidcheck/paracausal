# PARACAUSAL

**PARACAUSAL** is a self-hosted creative archive and media management platform for music, videos, gallery work and projects, built with Node.js, Express, EJS, SQLite and a dark retro-inspired interface.

It is designed for individuals, artists, collectors and small creators who want a private or public-facing space to organise and publish their work without relying on third-party platforms.

## Features

- Public pages for Home, Music, Videos, Gallery and Projects
- Modular homepage builder with intro settings, featured content and ordered editorial sections
- Draft, unlisted, published and scheduled visibility states across core public content
- Preview links for music, videos, gallery items and projects via preview tokens
- Admin login with session-based authentication, CSRF protection, login rate limiting and strict same-site session cookies
- Optional TOTP two-factor authentication for the admin account with recovery codes
- Lightweight self-hosted analytics for public page views, top pages, top projects, top videos and recent traffic summaries
- Admin backup export for the active SQLite database and uploads with an official restore CLI
- Custom editable slugs for music, videos, gallery items and projects with cleaner public URLs
- Normalised tags for music, videos, gallery items and projects with public tag browsing and tag-aware search
- Drag-and-drop sorting for music, videos, gallery items, projects and homepage sections where supported
- Upload and manage:
  - music tracks and cover art
  - videos and thumbnails
  - gallery images
  - projects, hero images, documents and timeline updates
- WAV music uploads are automatically converted to MP3 for faster web playback
- Playlist systems for music and videos
- Persistent footer music player with waveform visualisation, queue memory and an up-next queue panel
- Richer project pages with metadata, connected content and pinned update entries
- Automatic cleanup of uploaded files when content is deleted
- Orphaned upload cleanup utility
- Responsive dark archive-style interface

## Screenshots

PARACAUSAL combines a dark retro-inspired interface with a self-hosted media and project archive workflow.

### Home

![PARACAUSAL home page](./screenshots/home.png)

### Music Library

![PARACAUSAL music page](./screenshots/music.png)

### Video Archive

![PARACAUSAL videos page](./screenshots/videos.png)

### Gallery

![PARACAUSAL gallery page](./screenshots/gallery.png)

### Projects and Updates

![PARACAUSAL projects page](./screenshots/projects.png)

### Admin Dashboard

![PARACAUSAL admin dashboard](./screenshots/admin-dashboard.png)

## Tech Stack

- Node.js
- Express
- EJS
- SQLite for both app data and session storage
- multer
- bcrypt
- express-session with persistent SQLite session store
- WaveSurfer.js

## Docker Setup

PARACAUSAL can be run directly from the published Docker image.

### Create or choose a folder for the deployment

Linux/macOS:

```bash
mkdir paracausal && cd paracausal
```

Windows CMD:

```cmd
mkdir paracausal
cd paracausal
```

### Create a `.env` file

Create a local `.env` file with at least:

```env
SESSION_SECRET=replace-this-with-a-long-random-secret
TRUST_PROXY=1
```

You can also use the full example from the [Environment Variables](#environment-variables) section below.

### Create `docker-compose.yml`

```yaml
services:
  paracausal:
    image: ghcr.io/uidcheck/paracausal:latest
    container_name: paracausal
    restart: unless-stopped
    ports:
      - "3000:3000"
    env_file:
      - .env
    environment:
      NODE_ENV: production
      PORT: 3000
      DB_PATH: /app/data/paracausal.db
    volumes:
      - ./data:/app/data
      - ./uploads:/app/uploads
```

### Pull and start the container

Docker Compose will create the local `data/` and `uploads/` folders automatically on first start if they do not already exist.

```bash
docker compose up -d
```

### Update to the latest image

```bash
docker compose pull
docker compose up -d
```

### Open the site

```text
http://localhost:3000
```

### View logs

```bash
docker compose logs -f
```

### Stop the container

```bash
docker compose down
```

## Run From Source

If you want to run PARACAUSAL from source instead of Docker:

1. Clone or download the repository.
2. Change into the project folder.
3. Copy `.env.example` to `.env`.
4. Set a strong random value for `SESSION_SECRET` in `.env`.

Clone the repository:

```bash
git clone https://github.com/uidcheck/paracausal.git
cd paracausal
```

Install dependencies:

```bash
npm install
```

Start the application:

```bash
npm start
```

On first startup, the app will automatically:

- create the SQLite database file if it does not exist
- initialise all required tables and indexes
- expose a one-time setup page at `/setup` when no admin account exists

Open the site in your browser:

```text
http://localhost:3000
```

On a fresh install with no admin account, open `/setup` and create the initial admin username and password.

If `INITIAL_ADMIN_USERNAME` and `INITIAL_ADMIN_PASSWORD` are both set when the app starts, PARACAUSAL creates that first admin automatically and skips the web setup flow.

After setup is complete, sign in at `/login`.

Existing installs that already have an admin account keep the current login flow and do not show `/setup`.

## Environment Variables

Create a local `.env` file based on `.env.example`.

Example:

```env
PORT=3000
SESSION_SECRET=replace-this-with-a-long-random-secret
TRUST_PROXY=1
# Optional: override admin login rate limiting (defaults: 15 minutes, 5 failed attempts)
# LOGIN_RATE_LIMIT_WINDOW_MINUTES=15
# LOGIN_RATE_LIMIT_MAX_ATTEMPTS=5
# Optional: bootstrap the first admin account on startup when no admin exists
# INITIAL_ADMIN_USERNAME=yourname
# INITIAL_ADMIN_PASSWORD=replace-this-with-a-strong-password
# Optional: override SQLite file path (default: database/paracausal.db)
# DB_PATH=database/paracausal.db
# Optional: override the session cookie name (default: paracausal.sid)
# SESSION_COOKIE_NAME=paracausal.sid
```

Bootstrap behavior:

- if both `INITIAL_ADMIN_USERNAME` and `INITIAL_ADMIN_PASSWORD` are set and no admin exists, the app creates that first admin on startup
- if only one of those variables is set, the app logs a warning and falls back to the web setup flow
- if neither variable is set, the app falls back to the web setup flow
- if an admin already exists, the env vars are ignored

The app no longer creates `admin / password` automatically on a brand-new install.

Admin login attempts are rate limited per client IP. By default, PARACAUSAL allows up to 5 failed login attempts within 15 minutes and temporarily blocks additional attempts for the rest of that window.

## Tags

Admins can assign comma-separated tags to music tracks, videos, gallery items and projects.

Tags are stored in normalized tables so matching stays case-insensitive and duplicate assignments do not accumulate.

Public archive pages show tag pills where available. Clicking a tag opens `/tags/:tag`, which lists published matching items across the supported content types.

Public search also matches tag names in addition to the existing title and description fields.

## Backup and Restore

PARACAUSAL includes a small backup workflow for single-admin deployments.

Each backup ZIP includes:

- a consistent snapshot of the active SQLite database
- the `uploads/` directory contents needed for music, videos, gallery items, projects and documents
- a `manifest.json` file with backup metadata such as timestamp, app version and configured database path

### Create a backup from the admin area

After logging in as admin:

1. Open the admin dashboard
2. Go to the **Maintenance** section
3. Open **Backup and Restore**
4. Click **Create Backup**

PARACAUSAL generates a timestamped ZIP download such as `paracausal-backup-20260312-153000.zip`.

### Restore a backup

Restore is handled by the official CLI so the overwrite step stays explicit.

Before restoring:

- stop the PARACAUSAL app or container
- keep a copy of the backup ZIP somewhere safe
- understand that the restore overwrites the current database and uploads directory

Local source install:

```bash
node restore-backup.js path/to/paracausal-backup-YYYYMMDD-HHMMSS.zip --yes
```

Docker Compose install:

1. Stop the container:

```bash
docker compose stop paracausal
```

2. Run the restore command inside the same project folder as `docker-compose.yml` so it targets the same `data/` and `uploads/` bind mounts:

```bash
node restore-backup.js path/to/paracausal-backup-YYYYMMDD-HHMMSS.zip --yes
```

3. Start the container again:

```bash
docker compose start paracausal
```

The restore command writes the backup database to the configured `DB_PATH` and restores the archive contents into `uploads/`.

## Changing the Admin Password

After logging in as admin:

1. Open the admin dashboard
2. Go to the **Account** section
3. Click **Change Password**
4. Enter:
   - your current password
   - your new password
   - confirmation of the new password

Password rules:

- minimum length: 8 characters
- current password must be correct
- new password and confirmation must match

After a successful password change, the new password takes effect immediately.

## Changing the Admin Username

After logging in as admin:

1. Open the admin dashboard
2. Go to the **Account** section
3. Click **Change Username**
4. Enter:
  - your current password
  - your new username
  - confirmation of the new username

Username rules:

- new username is trimmed before saving
- minimum length: 3 characters
- maximum length: 50 characters
- new username and confirmation must match
- new username must be different from the current username

After a successful username change, the current session stays valid and future logins must use the new username.

## Optional Two-Factor Authentication

PARACAUSAL supports optional TOTP two-factor authentication for the admin account.

After logging in as admin:

1. Open the admin dashboard
2. Go to the **Account** section
3. Click **Two-Factor Authentication**
4. Scan the QR code with a standard authenticator app or enter the setup key manually
5. Enter your current password and a valid authenticator code to enable 2FA

Once enabled, login becomes a two-step flow:

1. Enter the correct username and password
2. Enter a current authenticator code or one of the generated recovery codes

Recovery codes are shown once when 2FA is enabled. Store them somewhere private. Each recovery code works one time.

To disable 2FA from the admin area, enter your current password and a current authenticator code or recovery code.

If you lose both the authenticator device and the recovery codes, you can clear 2FA directly in the database.

Local or Docker shell command:

```bash
node -e "const sqlite3=require('sqlite3').verbose(); const db=new sqlite3.Database(process.env.DB_PATH || 'database/paracausal.db'); db.run('UPDATE admins SET two_factor_secret = NULL, two_factor_enabled = 0, two_factor_recovery_codes = NULL', function(err){ if(err){ console.error(err); process.exit(1);} console.log('Two-factor authentication cleared for the admin account.'); db.close(); });"
```

Stop the app or container before doing a manual reset.

## Homepage Customisation

PARACAUSAL includes a focused homepage settings page for small single-admin customisation without turning the site into a full CMS.

After logging in as admin:

1. Open the admin dashboard
2. Go to the **Homepage** section
3. Click **Homepage Settings**
4. Adjust the homepage heading, tagline or intro text
5. Optionally choose a featured project, track or video from published content
6. Toggle the Music, Videos, Gallery and Projects homepage sections on or off

Homepage links remain managed separately through **Homepage Links**.

Defaults and fallbacks:

- Leaving the heading blank keeps the default `Creative Archive` title
- Clearing the intro text falls back to the default archive intro copy
- Featured items only render when the selected item is still published
- If a selected featured item is deleted or later moved back to draft, the homepage skips it safely until you pick another one
- Section toggles only affect the homepage and do not unpublish or delete any content

## Analytics

PARACAUSAL includes a lightweight self-hosted analytics page for the single-admin deployment model.

After logging in as admin:

1. Open the admin dashboard
2. Go to the **Maintenance** section
3. Click **Analytics**

The analytics page shows:

- total recorded public views
- views in the last 24 hours
- views in the last 7 days
- top pages
- top projects
- top videos
- top referrers by hostname when available
- a recent 7-day daily view summary

What is tracked:

- successful public page views only
- request path
- normalized page type such as home, music, gallery, search, project detail or video detail
- project slug, video slug or gallery slug when applicable
- timestamp
- referrer hostname when one is available

## Public URLs

Projects, videos and gallery items use shareable slug-based public URLs.

- Projects use `/projects/:slug`
- Videos use `/videos/:slug`
- Gallery items use `/gallery/:slug`

When a video already has an older numeric detail URL, PARACAUSAL redirects it to the canonical slug URL automatically.

Slug fields are editable in the admin forms for videos, gallery items and projects. Leaving the field blank generates a unique slug from the title.

What is not tracked:

- admin routes
- login, logout or setup pages
- failed detail-page requests and 404s
- raw IP addresses
- third-party analytics cookies or external tracking services

Deduplication and privacy:

- analytics counts use a short 30-minute in-memory dedupe window per visitor fingerprint and path
- the fingerprint is derived in memory from request metadata and is not stored in the database
- detailed analytics rows are pruned on startup after 90 days by default
- you can override retention with `ANALYTICS_RETENTION_DAYS`

## Draft and Published Content

Music tracks, videos, gallery items and projects can now be saved as `draft` or `published` from the admin area.

- New and existing content defaults to `published` unless you change it
- Draft items stay visible in admin management screens
- Draft items are excluded from public listings, search and direct public detail routes
- Projects keep their existing freeform project status field and also include a separate publication status

## Recovering Admin Access

If you forget the admin password, you can reset it directly inside the Docker container without losing any site content.

This only updates the admin password in the database. It does not delete music, videos, gallery items, projects, uploads, playlists or any other stored data.

### Open a shell inside the running container

```bash
docker compose exec paracausal sh
```

### Run the password reset command

Replace `NewPassword123` with the password you want to set:

```bash
node -e "const bcrypt=require('bcrypt'); const sqlite3=require('sqlite3').verbose(); bcrypt.hash('NewPassword123',10).then(hash=>{ const db=new sqlite3.Database('/app/data/paracausal.db'); db.get('SELECT id, username FROM admins ORDER BY id LIMIT 1', (readErr, admin)=>{ if(readErr || !admin){ console.error(readErr || new Error('No admin account found')); process.exit(1);} db.run('UPDATE admins SET password = ? WHERE id = ?', [hash, admin.id], function(err){ if(err){ console.error(err); process.exit(1);} console.log('Admin password reset successfully for username: ' + admin.username); db.close(); }); }); });"
```

### Log in again

Use:

```text
Username: the admin username you created during setup
Password: the new password you just set
```

### Notes

- This does not reset or remove any site content
- It only updates the `admins.password` field in the SQLite database
- If your password contains special shell characters, use a simpler temporary password first, then change it from the admin panel after logging in

## Admin Usage

- On a fresh install, complete `/setup` first unless you used `INITIAL_ADMIN_*`
- Go to `/login`
- Sign in with the admin account
- Use the **Homepage** section to adjust intro copy, homepage visibility and featured picks
- Use **Maintenance → Analytics** to review lightweight local traffic summaries for public pages
- Use the publication status control on music, video, gallery and project forms to keep unfinished work private until it is ready
- Drag items by their handle on the main content lists to save a new display order for admin and public pages
- Use the **Account** section to enable or disable optional two-factor authentication
- Use **Maintenance → Backup and Restore** to download a full site backup before major changes or upgrades
- Use the **Account** section to change the admin username or password
- Use the dashboard to manage music, videos, gallery items, projects and playlists

## Upload Storage

Uploaded files are stored under `uploads/`:

- `uploads/music/` — music playback files and cover images. WAV/WAVE uploads are converted to MP3 automatically and the converted MP3 is stored for playback
- `uploads/videos/` — video files and thumbnails
- `uploads/images/` — gallery images
- `uploads/projects/` — project hero images
- `uploads/documents/` — project documents and update attachments

Make sure these folders are writable in your deployment environment.

## Database

The app uses SQLite for both application data and session storage.

Default local database file:

```text
database/paracausal.db
```

You can override the database file path with `DB_PATH`. Example Docker path:

```text
/app/data/paracausal.db
```

## Upgrade Note

Older databases are updated on startup to add publication status columns for music, videos, gallery items and projects. Existing rows are treated as published after that upgrade step.

### Session storage

Sessions are stored in the `sessions` table within the same SQLite database. This ensures:

- sessions persist across app restarts
- expired sessions are automatically cleaned up every 15 minutes
- production-safe session handling without `MemoryStore` warnings
- sessions work correctly in Docker and other containerised deployments

## Session and CSRF Hardening

- `SESSION_SECRET` is required when `NODE_ENV=production`
- In local development, if `SESSION_SECRET` is not set, the app uses a temporary fallback secret and logs a warning
- Session cookies default to `paracausal.sid`, are `httpOnly` with `sameSite=strict` and use automatic secure handling in production
- `TRUST_PROXY=1` is recommended when running behind HTTPS via a reverse proxy so secure cookies are detected correctly
- Admin login rate limiting blocks repeated failed attempts per client IP and clears the failure window after a successful login
- Optional TOTP 2FA adds a second login step after the password check when the admin enables it
- State-changing auth and admin forms are protected by CSRF tokens

If you want to tune the admin login limiter, set `LOGIN_RATE_LIMIT_WINDOW_MINUTES` and `LOGIN_RATE_LIMIT_MAX_ATTEMPTS`. When those variables are not set, PARACAUSAL uses the default 15 minute window and 5 failed attempts.

If you deploy behind a reverse proxy such as Nginx, Caddy or a load balancer, set:

```env
NODE_ENV=production
SESSION_SECRET=replace-this-with-a-long-random-secret
TRUST_PROXY=1
```

With `TRUST_PROXY` configured correctly, the login limiter uses the effective client IP in proxied deployments.

Database files should not be committed to Git. Keep live database files outside version control.

## Docker Data Notes

When running with Docker Compose:

- SQLite database data is stored in `./data`
- Docker sets `DB_PATH=/app/data/paracausal.db` and mounts `./data:/app/data`
- Uploaded files are stored in `./uploads`
- Docker Compose creates `./data` and `./uploads` automatically on first start if they do not exist
- Recreating the container does not remove your content as long as those folders are preserved
- You can set `INITIAL_ADMIN_USERNAME` and `INITIAL_ADMIN_PASSWORD` in `.env` to bootstrap the first admin account automatically

On first access:

1. Open `http://localhost:3000`
2. If you did not set `INITIAL_ADMIN_*`, go to `/setup` and create the initial admin account
3. Go to `/login` if you are not signed in already
4. Use the admin panel under **Account → Change Password** whenever you need to rotate the password

## Maintenance

To scan for orphaned uploaded files without deleting anything:

```bash
node cleanup-orphaned-files.js --dry-run
```

To remove orphaned uploaded files:

```bash
node cleanup-orphaned-files.js
```

Use the dry run first.

To restore an official backup ZIP:

```bash
node restore-backup.js path/to/paracausal-backup-YYYYMMDD-HHMMSS.zip --yes
```

Stop PARACAUSAL first because the restore overwrites the current database and uploads directory.

## Usage

PARACAUSAL is intended as a self-hosted creative archive and publishing platform. It can be used as-is for personal deployments, adapted for private media libraries or extended into a more customised portfolio or archival system.

## Production Notes

- Use a strong session secret in production
- Use HTTPS and a reverse proxy in production
- Ensure upload and data directories are backed up
- Set `INITIAL_ADMIN_*` for automated deployments or complete `/setup` before exposing the app

## Design Goals

This project is intentionally designed with a dark, minimal retro archive feel, combining self-hosted control with a curated presentation layer for media and project work.