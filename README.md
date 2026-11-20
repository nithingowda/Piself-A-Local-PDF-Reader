# PiShelf

**Your magazines, newspapers and books. Your Raspberry Pi.**

PiShelf turns PDF magazines, PDF newspapers and PDF/EPUB books into a personal reading website. Browse covers, organise issues by category, and pick up where you left off—from a browser on your phone, tablet, or computer.

Built for self-hosting on your home network, with local storage and a lightweight Python server.

## Reader speed and memory management

PiShelf uses WebP previews and sharper images on demand. The reader cancels stale high-resolution upgrades when you navigate away, change layout, or close the reader. Thumbnail requests are restricted to thumbnails near the visible scroll area to reduce Safari memory and network usage. Pinch-zoom geometry and the PDF.js fallback are unchanged.

**Performance checks:** Try a large magazine on iPhone Safari, swipe through pages, open/close the thumbnail browser, zoom in and out, and return to the library. If the reader becomes slow, see [troubleshooting](USER_MANUAL.md#7-troubleshooting).

## User manual and troubleshooting

**[Read the PiShelf user manual](USER_MANUAL.md)** for features, setup, Docker commands, **where to configure your existing PDF folder path**, adding magazines and newspapers, reading controls, iPhone Safari tips, backups, and troubleshooting an empty library.

## Library and reading upgrade

See [the library and reader guide](FEATURES.md) for persistent covers, reading collections, gestures, PDF uploads, permanent deletion, publication/month grouping, tags, category creation, renaming, focused reading, AMOLED/night themes, backups, and separate source paths.

## Login, user roles and admin panel

**Login is required** to access the library and PDFs. Admins can manage users and files; reader accounts can browse PDFs and save reading progress, but cannot manage files or users. On first launch, PiShelf **automatically opens a first-time administrator setup page**. Choose an admin username and password in your browser—no Docker command needed. Complete setup immediately on a trusted LAN before exposing the app to other users.

See [Authentication and administrator guide](AUTHENTICATION.md) for first-time setup, role permissions, account management, password security, and HTTPS reverse-proxy configuration. **There is no default password.**

## Features

- **A visual library** — PDF covers, search, category folders, favourites, and sorting.
- **Automatic discovery** — add PDFs to your folder and they appear in your library.
- **Continue reading** — saved page positions shared across your devices.
- **Flexible reading** — continuous scrolling or single-page mode, zoom, rotation, fullscreen, and page bookmarks.
- **Personal preferences** — light, warm-paper, and dark-surroundings themes, cover sizes, and rendering quality.
- **Library management** — mark issues as finished, clear reading progress, download PDFs, or move magazines to recoverable Trash.
- **Docker packaging** — Compose configuration, persistent storage, automatic restart, and a health check.
- **Local operation** — no cloud account or internet connection needed for everyday reading after installation.

> **Deployment status:** local application checks have passed. The Docker image build and performance on Raspberry Pi hardware have not yet been verified.

## Contents

- [Quick start with Docker](#quick-start-with-docker)
- [Add your magazines](#add-your-magazines)
- [Read and manage your library](#read-and-manage-your-library)
- [Settings](#settings)
- [Storage and backups](#storage-and-backups)
- [Updates and maintenance](#updates-and-maintenance)
- [Troubleshooting](#troubleshooting)
- [Run without Docker](#run-without-docker)
- [Network access and limitations](#network-access-and-limitations)

## Books and EPUB support

PiShelf includes a third **Books** source alongside Magazines and Newspapers. Books can contain **PDF** (read through PiShelf's existing WebP viewer) and **DRM-free EPUB** (read through a dedicated reflowable EPUB.js viewer).

Set `BOOK_DIR` in `.env` to a writable folder on your Raspberry Pi, USB disk or NAS. For example:

```dotenv
BOOK_DIR=/mnt/Nithin-Nas/nextcloud/data/nithingowda/files/Books
```

Create the host folder before starting Docker and make sure the configured `PISHELF_UID` can read/write it. PiShelf scans subfolders as book categories. EPUB upload is limited to 100 MiB per file; PDFs retain the 512 MiB limit. Import existing files simply by copying them into the Books folder.

In the browser, select **Books** from Sources. EPUB books support chapter navigation, reflowable text, font-size adjustment, day/sepia/night/AMOLED modes and shared CFI resume positions. A book's EPUB cover uses a lightweight title design instead of PDF image rasterization.

EPUB.js and JSZip are loaded on demand from jsDelivr, so the browser needs CDN access when first opening an EPUB; PDF and WebP features remain unchanged. For security, use trusted DRM-free EPUB files, and keep PiShelf behind LAN/Tailscale or HTTPS access controls.

## Quick start with Docker

### 1. Prepare your Raspberry Pi

The intended setup is **64-bit Raspberry Pi OS with Docker Engine and the Docker Compose plugin**. Use a current browser with JavaScript enabled.

The included Dockerfile uses the official `python:3.12-slim-bookworm` image. Build the image on your Pi so Docker selects the appropriate native architecture. PDF pages render in the viewing browser; large scanned issues can therefore be more demanding on an older Pi used as both server and reader.

Install Docker using the official instructions if it is not already available:

- [Docker Engine on Debian / Raspberry Pi OS 64-bit](https://docs.docker.com/engine/install/debian/)
- [Docker Compose plugin](https://docs.docker.com/compose/install/linux/)

Check the installation:

```sh
docker --version
docker compose version
```

### 2. Extract and configure PiShelf

Extract the download, then open a terminal in the `pi-magazine-reader` folder containing `compose.yaml`.

Create the storage folders before starting the container:

```sh
cp .env.example .env
```

If upgrading, keep your existing `.env` instead of replacing it.

Find your account's user and group IDs:

```sh
id -u
id -g
```

Edit `.env` and set `PISHELF_UID` and `PISHELF_GID` to those values:

```dotenv
PISHELF_UID=1000
PISHELF_GID=1000
PISHELF_PORT=8098
MAGAZINE_DIR=/mnt/Nithin-Nas/nextcloud/data/nithingowda/files/Magazines
NEWSPAPER_DIR=/mnt/Nithin-Nas/nextcloud/data/nithingowda/files/NewsPapers
BOOK_DIR=/media/pi/SSD/Books
```

| Variable | Purpose | Default |
| --- | --- | --- |
| `PISHELF_UID` | User ID used by the container | `1000` |
| `PISHELF_GID` | Group ID used by the container | `1000` |
| `PISHELF_PORT` | Host port mapped to container port 8080 | `8098` |
| `MAGAZINE_DIR` | Host magazine folder | See `.env.example` |
| `NEWSPAPER_DIR` | Host newspaper folder | See `.env.example` |
| `BOOK_DIR` | Host PDF/EPUB book folder | `./books` |

The configured user must be able to read and write the magazine folder and the `piself` Docker volume. PDF write access is needed to move files into Trash and restore them. Use appropriate ownership and permissions rather than making folders writable by everyone.

**Already have a PDF collection?** Point `MAGAZINE_DIR` at its absolute path:

```dotenv
MAGAZINE_DIR=/media/pi/SSD/Magazines
```

Create all configured source directories and mount external storage before starting PiShelf. Docker stores reading state in the named volume `piself`, mounted at `/data`. `DATA_DIR` is no longer used by Compose.

### 3. Create the data volume and start PiShelf

Compose creates the `piself` volume. A single container prepares its ownership using `PISHELF_UID` and `PISHELF_GID`, then drops root privileges and starts the app.

```sh
docker compose up -d --build --remove-orphans
docker compose ps
```

The first build needs internet access to download the base image. PiShelf serves its reader assets locally after that.

If upgrading from a bind-mounted data folder, migrate existing reading state before starting; see [Docker volume setup](DOCKER.md). In Dockhand, refresh the stack from GitHub and redeploy; the permission setup step runs before the app. Set `PISHELF_PORT=8098` in any existing `.env` or Dockhand environment; an existing value overrides the default.

### 4. Open your library

Find your Pi's local IP address:

```sh
hostname -I
```

In a browser on the same network, enter `http://YOUR_PI_IP:8098`, replacing `YOUR_PI_IP` with that address. If you changed `PISHELF_PORT`, use the new port.

If the Pi's hostname is `raspberrypi` and your network supports `.local` names, you can also use [raspberrypi.local:8098](http://raspberrypi.local:8098).

## Add your magazines

Copy PDF files into your configured magazine folder. Subfolders become categories:

```text
magazines/
├── Business/
│   └── Business Monthly - November.pdf
├── Technology/
│   └── Maker Journal - Issue 12.pdf
├── Travel/
│   └── Weekend Explorer.pdf
└── Newspapers/
    └── Daily News.pdf
```

PiShelf uses:

| PDF information | Displayed as |
| --- | --- |
| First page | Cover thumbnail |
| Filename without `.pdf` | Issue title |
| Subfolder path | Category |
| File modification time | “Newest first” order |

The library scans for new PDFs when the webpage reloads. You can also use the library refresh button or **Rescan PDF folder** in Settings. There is no periodic checking interval.

For large files, finish copying before giving the file its `.pdf` extension. This prevents incomplete uploads or copies from appearing as broken issues.

If you downloaded the sample bundle, it includes 12 original demo magazines. You can remove them through the same magazine options used for your own files.

## Read and manage your library

### Reading

Click a cover to open an issue. If you have read it before, PiShelf returns to the saved page.

The reader toolbar provides:

- Previous/next page and direct page-number entry.
- Continuous scrolling, single-page mode, or a **Two-page book** spread (cover alone, then pages 2–3, 4–5, etc.).
- Zoom in, zoom out, and fit width.
- Clockwise page rotation and fullscreen.
- Page bookmarks and a bookmark jump menu.
- Swipe page navigation, mobile pinch zoom, and double-tap to show or hide controls; reading settings remembered per issue.
- In Two-page book mode, use the side page-turn buttons, keyboard arrows, or swipe to turn a whole spread. A subtle turning transition is disabled if Reduce Motion is enabled.

Reading position is saved at the **page level**, not the exact scroll position within a page. Nearby pages render on demand, and distant page images are released to reduce memory use.

| Shortcut | Action |
| --- | --- |
| `←` / `→` | Previous / next page |
| `B` | Add or remove a bookmark on the current page |
| `Esc` | Return to the library when no dialog or fullscreen view is active |

### Magazine options

Use the **•••** button beside an issue's title to:

- Continue reading or open from the beginning.
- Download the original PDF.
- Mark the issue as finished.
- Clear its reading progress.
- Move it to recoverable Trash, or permanently delete the PDF from storage after confirmation.

Opening from the beginning does not clear an existing “finished” flag. Use **Clear reading progress** when you want to reset an issue to Unread.

### Clear reading progress

Clear an individual issue through its **•••** menu, or return to the library and choose **Settings → Clear all reading progress**.

This resets page positions and finished status. It **keeps your PDFs, favourites, and bookmarks**. Because the library has one shared reading profile, clearing progress affects everyone using it.

### Delete and restore

**Move to Trash** moves a PDF into the hidden `.pishelf-trash` directory inside its source folder. **Delete permanently from storage** removes the actual PDF after confirmation and cannot be undone.

To restore it:

1. Open **Settings**.
2. Find the issue under **Trash**.
3. Select **Restore**.

The file returns to its original folder with its reading record retained. PiShelf refuses to overwrite a file already at that location; move or rename the conflicting file first.

Trashed files still use disk space. Use **Delete permanently** in Settings → Trash to remove a trashed PDF from storage. Keep the data folder: it contains the original filenames and paths needed for restoration.

## Settings

| Setting | Options |
| --- | --- |
| Reading theme | Light, warm paper, dark surroundings |
| Default reading mode | Continuous scroll, single page |
| Rendering quality | Economy, balanced, sharp |
| Cover size | Compact, comfortable |
| Library refresh | 15 seconds, 30 seconds, 1 minute, manual |
| Page navigation | Smooth scrolling on or off |

Appearance and reader preferences are saved **per browser**. Reading positions, favourites, bookmarks, and finished status are saved **on the Pi** and shared across devices.

Themes change the interface and reading background, not the colours printed in the PDF. Choose **Economy** quality if large scanned magazines feel slow or use too much memory.

## Storage and backups

PiShelf keeps content outside the container so it survives rebuilds and container replacement.

| Location | Contents |
| --- | --- |
| `MAGAZINE_DIR` | Your PDF collection and category folders |
| `MAGAZINE_DIR/.pishelf-trash/` | Recoverable deleted PDFs |
| `piself` volume: `/data/progress.sqlite3` | Reading progress, favourites, bookmarks, and Trash records |
| `.env` | Your Docker folder, port, and user configuration |

Back up **the magazine folder and the `piself` volume**, including hidden files, and keep a copy of `.env`. See [Docker volume setup](DOCKER.md) for a volume backup command.

For a consistent file-level backup, stop PiShelf before copying its files:

```sh
docker compose stop
```

Copy your magazine folder and back up the `piself` volume to your backup destination, then restart:

```sh
docker compose start
```

File paths identify issues. Renaming or changing categories through PiShelf preserves reading records; moving or renaming PDFs outside the app creates a new reading record. Reading positions stored only in a browser by the earliest Folio version are not imported.

## Updates and maintenance

Run these commands from the app folder:

| Task | Command |
| --- | --- |
| Start or rebuild | `docker compose up -d --build --remove-orphans` |
| Check container status | `docker compose ps` |
| Follow recent logs | `docker compose logs --tail=100 -f` |
| Restart | `docker compose restart` |
| Stop without removing the container | `docker compose stop` |
| Stop and remove the container | `docker compose down` |

`docker compose down` does not remove your bind-mounted magazine folder or the `piself` volume (unless you use `down -v`).

To update:

1. Back up your collection and data.
2. Replace application files with the new version.
3. Preserve your `.env`, magazine folder, and `piself` volume.
4. Run `docker compose up -d --build --remove-orphans`.

The supplied configuration uses a non-root process, a read-only application filesystem, persistent writable storage mounts, automatic restart, bounded logs, and an HTTP health check. A separate database server is not required.

## Troubleshooting

| Problem | What to check |
| --- | --- |
| The website will not open | Run `docker compose ps`, inspect logs, and confirm the Pi's IP and configured port. The viewing device must be able to reach the Pi. |
| Port 8098 is already in use | Set a different `PISHELF_PORT` in `.env`, then run `docker compose up -d`. |
| The library is empty | Check `MAGAZINE_DIR`, confirm the drive is mounted, and make sure files end in `.pdf`. Hidden directories are excluded. |
| New files are missing | Return to the library and press refresh. Check the refresh setting and wait for file copying to finish. |
| Progress will not save | Check ownership of the `piself` volume and available disk space; see [Docker volume setup](DOCKER.md). Look for a failed-save message in the reader. |
| Delete or restore fails | Check write access to the magazine folder. A restore also fails if another file occupies the original path. |
| The container reports permission errors | Match `PISHELF_UID` / `PISHELF_GID` to the account that can access the magazine folder. Ensure the `piself` volume has the same UID/GID. |
| Scrolling is slow | Select Economy quality, reduce zoom, or use single-page mode. Large image-heavy PDFs need more browser resources. |
| A PDF looks wrong or will not render | Download the PDF from its issue menu and try a native PDF reader. The file may be damaged or use fonts or image formats that need native viewer support. |
| Another device changes my reading position | PiShelf currently uses one shared household reading profile. Separate user accounts are not implemented. |

## Run without Docker

PiShelf also runs directly with **Python 3.9 or later**. No third-party Python packages are required.

From the app folder:

```sh
python3 server.py
```

To use custom folders:

```sh
python3 server.py --library /path/to/magazines --data /path/to/pishelf-data
```

| Argument | Default | Purpose |
| --- | --- | --- |
| `--host` | `0.0.0.0` | Listening address |
| `--port` | `8080` | HTTP port |
| `--library` | `magazines/` beside the app | PDF collection |
| `--data` | `data/` beside the app | Reading state and Trash records |

Use `--host 127.0.0.1` if the app should be reachable only from the same computer.

For native startup at boot, adapt `folio.service.example`. Its legacy filename is retained for upgrades. Set the correct user and paths, create the storage directories, and allow both through `ReadWritePaths`. Docker installations do not need this service.

## Network access and limitations

PiShelf is intended for a **trusted home network**. It currently has no login system. Anyone who can reach its port can read magazines, change shared reading progress, and move files to Trash.

Do not expose it directly through internet port forwarding. Use a private VPN if you need access away from home.

Other current limits:

- **Book formats:** PDF and DRM-free EPUB are supported. CBZ, CBR, MOBI, AZW and DRM-protected EPUB are not supported.
- **One shared profile:** no separate accounts or reading histories.
- **Folder-based organisation:** no automatic subject or language detection.
- **Canvas reader:** download the PDF from its issue menu and use a native reader for text selection, in-document search, printing, or native accessibility support.
- **Browser-dependent performance:** complex or scanned PDFs may load slowly on older devices.
- **Password-protected PDFs:** passwords are handled by the browser and are not stored by PiShelf.

## Validation and acknowledgements

Local checks cover Python and JavaScript syntax, reading-state persistence, reset actions, bookmarks, Trash and restore, restore conflicts, path restrictions, and PDF byte-range responses. Browser checks have exercised PDF rendering and continuous-reader navigation with sample files. These checks do not establish performance on every device or PDF.

The Docker build and Raspberry Pi hardware deployment still need verification on the target device.

PDF rendering uses [Mozilla PDF.js](https://mozilla.github.io/pdf.js/). The bundled version is **4.10.38**, distributed under the Apache 2.0 licence; see `static/vendor/LICENSE`.

The optional sample collection contains original demo PDFs for exploring PiShelf.
