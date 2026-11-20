# PiShelf accounts and administrator guide

PiShelf requires a login for all PDFs, WebP images, the library and API endpoints. There are two roles:

| Role | Permissions |
| --- | --- |
| **Administrator** | Read PDFs, manage library, upload/delete PDFs, save shared reading state, create/disable/delete users, reset user passwords |
| **Reader** | Read PDFs and browse library only. All POST operations, including saving reading progress, are denied by the server |

**Important:** Reading progress remains shared rather than per-user. Reader accounts cannot update it. Existing progress is retained.

## First-time setup / migration

**Back up your `piself` Docker volume before upgrading.** Existing PDFs and library metadata are not deleted.

1. Deploy the new version with your existing `.env` and PDF folder paths:
   ```sh
   docker compose up -d --build --remove-orphans
   ```
2. Create the first administrator **on the Raspberry Pi**, not through a public registration page:
   ```sh
   docker compose exec --user 1000:1000 -it pishelf python auth.py create-admin /data/progress.sqlite3
   ```
   Replace `1000:1000` with the `PISHELF_UID:PISHELF_GID` configured in your `.env` file, if different. Enter an admin username and a unique password of at least 12 characters. Password input is hidden. Only the first administrator can be created with this command.
3. Open `http://YOUR_PI_IP:8098/login.html` and sign in.
4. Click **Manage users** (administrator only), or open `/admin.html`.

If you restart before creating an admin, the library will show the login screen and remain locked until you run the command. There is no default password or public self-registration.

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
