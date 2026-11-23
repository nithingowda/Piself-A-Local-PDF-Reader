# PiShelf security guide

PiShelf is a personal PDF library for a **trusted home network**. It does **not** provide accounts or login authentication. Anyone who can reach its HTTP port can view PDFs and potentially upload, rename, trash or delete them. Do not publish its port on the public internet.

## Recommended deployment

1. Restrict PiShelf to your trusted LAN using router and host firewall rules. Do not configure internet port forwarding.
2. For remote access, use Tailscale or another private VPN. Limit access to the PiShelf port in your VPN access rules.
3. If exposing PiShelf through a reverse proxy, require authentication and HTTPS at the proxy before forwarding any request. Authentication must cover **all** routes, including PDF and API endpoints.
4. Use a dedicated unprivileged user with only the necessary PDF folder permissions. Keep Docker and the server patched.
5. Back up original PDFs and the persistent `piself` Docker volume. Avoid `docker compose down -v` during upgrades.

## Application protections

- Library paths reject traversal and symlinks; mutation requests have origin checks.
- Upload size and content-type are bounded. PDF header validation is a lightweight check, not a malware scanner.
- WebP conversion caps PDF source size, page dimensions and rasterized pixel count to limit accidental or malicious memory exhaustion.
- Responses include browser security headers. PDF.js workers may be loaded from the local application or a blob URL.
- The cache-clear endpoint rejects unexpected request bodies.
- Detailed conversion exceptions are logged on the server rather than exposed in HTTP responses.
- A GitHub Actions workflow runs security regression checks and `pip-audit` on pull requests, pushes and weekly.

## Important limitations

**This hardening does not add login authentication**, rate limiting, anti-malware scanning, or a comprehensive PDF parser sandbox. The server still processes user-provided PDFs with third-party libraries. Resource limits mitigate, but do not eliminate, denial-of-service risks.

Python dependencies are currently specified as version ranges; CI audits the resolved dependencies. Review updates carefully, pin a tested lockfile for reproducible production deployments, and rebuild images when security patches are available.

## Report a vulnerability

Please do not publish exploit details or private documents in public issues. Contact the repository owner privately through GitHub's security reporting features if available.
