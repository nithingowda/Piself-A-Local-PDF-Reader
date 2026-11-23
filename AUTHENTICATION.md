# PiShelf accounts and administrator guide

PiShelf requires a login for all PDFs, WebP images, the library and API endpoints. There are two roles:

| Role | Permissions |
| --- | --- |
| **Administrator** | Read PDFs, manage library, upload/delete PDFs, save shared reading state, create/disable/delete users, reset user passwords |
| **Reader** | Read PDFs, browse the library, and save reading progress, bookmarks and favourites. File and user management are denied by the server |

**Important:** Reading progress remains **shared across accounts**, not private per-user. All signed-in users can update the same magazine's last-read page and bookmarks; the latest saved value is used. Existing progress is retained.

## First-time setup / migration

**No Docker command is required to create the first administrator.** On a fresh install, PiShelf automatically displays its browser setup page.

1. Keep PiShelf on your **trusted private LAN**, not exposed to the internet. Back up the `piself` Docker volume when upgrading an existing installation.
2. Start PiShelf with your existing PDF folder paths:
   ```sh
   docker compose up -d --build --remove-orphans
   ```
3. Open `http://SERVER_IP:8098`. When no users exist, PiShelf automatically redirects to **First-time Setup**.
4. Enter an administrator username, a unique password of at least 12 characters, and confirm the password.
5. Click **Create administrator**, then sign in at the login page.
6. Use **Manage users** or `/admin.html` to add normal readers or other administrators.

**Security note:** The first administrator can be created only once, from a private-network client. Whoever completes first-time setup becomes the administrator. **Do this immediately before allowing other people onto the PiShelf network.** Do not expose PiShelf via an internet-facing reverse proxy before setup; proxies can mask the original client address.

After any user account exists, browser setup is permanently disabled for that database. A fresh database or deleted Docker data volume is considered a new installation.

## Optional emergency bootstrap

The original terminal bootstrap command remains available for an empty database if the browser setup page cannot be reached:

```sh
docker compose exec --user 1000:1000 -it pishelf python auth.py create-admin /data/progress.sqlite3
```

Adjust UID:GID to match your `.env` if different. **This command is not part of normal installation.**

## Manage users

From the admin panel, create an account with username, password and role. You can disable/enable users, reset their passwords, and delete accounts. Disabling or resetting an account revokes its existing sessions. An admin cannot delete or disable their own account, and the last enabled admin is protected.

Users can choose **Change password** from the reader controls. Changing a password revokes all that user's sessions and requires signing in again.

## Security details

- Passwords use salted PBKDF2-HMAC-SHA256 with 600,000 iterations.
- Sessions use random bearer tokens stored as SHA-256 hashes in SQLite, with a 12-hour expiry.
- Session cookies use `HttpOnly`, `SameSite=Strict`, and a path restriction.
- Mutating requests require a session-specific `X-PiShelf-CSRF` token.
- Login attempts are limited to 8 failures per source IP in 15 minutes (in-memory; resets on restart).
- No API key or default admin password is bundled.

**HTTPS:** When using an HTTPS reverse proxy, configure `PISHELF_COOKIE_SECURE=1` in the Compose environment so browsers transmit session cookies only over HTTPS. Do not enable this for plain HTTP access because browsers will then refuse to send the cookie. Restrict direct access to the HTTP backend; the proxy must require HTTPS.

**Network:** Authentication does not make it safe to expose PiShelf directly to the internet. Prefer LAN/Tailscale access. Password login on plain HTTP is not encrypted in transit; use HTTPS whenever traffic leaves a trusted private network.

**Limitations:** No MFA/TOTP, SSO, email-based password recovery, or durable cross-restart brute-force tracking yet. A single process maintains login attempt limits. For higher-security deployments, put PiShelf behind an authenticated HTTPS reverse proxy and consider MFA there.

## Upgrade troubleshooting

- **Locked out?** Check the container logs and ensure the first admin was created. Existing admin passwords cannot be recovered from hashes.
- **401 Login required:** Sign in again. Sessions expire after 12 hours.
- **403 Administrator permission required:** A reader account tried to change data; ask an admin for the required access.
- **403 Invalid security token:** Reload the page and sign in again.
- **Cookies missing:** Verify HTTPS proxy and `PISHELF_COOKIE_SECURE` configuration match.
