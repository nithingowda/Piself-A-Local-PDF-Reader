# PiShelf — User Manual

PiShelf is a self-hosted magazine, newspaper and book library for Raspberry Pi and other Docker hosts. It displays PDF covers and offers a browser reader with WebP page images.

## 1. Features at a glance

| Feature | How to use it |
| --- | --- |
| PDF and EPUB library | Browse PDF magazines/newspapers and PDF/EPUB books |
| Three source folders | Keep magazines, newspapers and books in separate host directories |
| Categories | Organize PDFs in subfolders |
| Search, sorting, collections and filters | Use the library toolbar and sidebar |
| Reading progress | PiShelf remembers the page you last read |
| Bookmarks and favourites | Use the reader bookmark button or magazine options |
| WebP page images | Pages render on demand and are cached for faster rereading |
| Progressive loading | Lower-resolution page preview is upgraded to a sharper WebP |
| Page thumbnails | In the reader, choose **Pages** to jump through groups of 60 pages |
| Reader modes | Continuous scroll or single page, plus zoom, rotation and fullscreen |
| Touch controls | Pinch zoom on iPhone/iPad; double-tap to toggle reader controls |
| Cache controls | Settings shows WebP cache usage and allows clearing generated images |
| Trash and backup | Recover deleted issues and export/restore reading metadata |

PDF and EPUB files remain in your configured folders. PiShelf stores metadata and WebP cache separately in its Docker data volume.

### Books and EPUB

To add books, configure `BOOK_DIR=/path/to/Books` in `.env` and restart PiShelf with `docker compose up -d --build`. PDF and DRM-free EPUB books appear under the **Books** source. EPUB books have adjustable font size, chapters, reading themes and shared last-read positions. EPUB requires internet access to load EPUB.js and JSZip from jsDelivr on first use.

## 2. Raspberry Pi requirements

- Raspberry Pi OS 64-bit, Docker Engine and Docker Compose plugin.
- An accessible PDF folder on the Pi (local disk, USB SSD or mounted NAS).
- A browser such as Safari on iPhone/iPad, or a desktop browser.

Check Docker:

```sh
docker --version
docker compose version
```

## 3. Configure your PDF folder path — important

**You must tell PiShelf where your existing PDF files are located.** Edit the `.env` file in the same directory as `compose.yaml`:

```sh
cp .env.example .env  # first installation only; do NOT overwrite an existing .env
nano .env
```

Example for a local SSD:

```dotenv
PISHELF_UID=1000
PISHELF_GID=1000
PISHELF_PORT=8098
MAGAZINE_DIR=/media/pi/SSD/Magazines
NEWSPAPER_DIR=/media/pi/SSD/Newspapers
```

**Replace both example paths with the real absolute paths on your Raspberry Pi.** These are **host paths**, not paths inside Docker. Do not put `/magazines` as the host value unless that directory truly exists on your Pi.

For example, if your PDFs are on a mounted NAS:

```dotenv
MAGAZINE_DIR=/mnt/NAS/Magazines
NEWSPAPER_DIR=/mnt/NAS/Newspapers
```

If you use only magazines, still configure an accessible directory for newspapers (it may be empty). Do not point both source variables at the same directory.

Verify paths and access **before starting Docker**:

```sh
ls -lah /media/pi/SSD/Magazines
ls -lah /media/pi/SSD/Newspapers
id -u
id -g
```

Set `PISHELF_UID` and `PISHELF_GID` to the output of `id -u` and `id -g`. The container needs read access to PDF files and write access for Trash operations. For a NAS, ensure it is mounted **before** PiShelf starts.

### Start or update

From the folder containing `compose.yaml`:

```sh
docker compose up -d --build --remove-orphans
docker compose ps
docker compose logs --tail=100
```

Open `http://YOUR_PI_IP:8098` in Safari, replacing `YOUR_PI_IP` with the Pi's actual IP address. If you changed `PISHELF_PORT`, use that port.

**Upgrading?** Keep your existing `.env`, source folders and Docker volume. Do not run `docker compose down -v` because `-v` deletes volumes containing saved PiShelf state.

## 4. Add PDFs and refresh

Place `.pdf` files inside the configured host folders. Subfolders become categories:

```text
/media/pi/SSD/Magazines/
├── Technology/
│   └── Maker Journal.pdf
└── Business/
    └── Business Monthly.pdf
```

Reload the webpage to scan for new magazines. You can also click the library refresh button or choose **Settings → Rescan PDF folder**. The old automatic 15-second scan setting has been removed.

For large PDFs, copy to a temporary filename first and rename to `.pdf` only after copying finishes.

## 5. Read magazines

Open a magazine cover. PiShelf resumes at the last saved page, if available.

- **Pages:** open the thumbnail navigator; move between 60-page ranges and choose a page.
- **Page number / arrows:** jump to a page or go backward/forward. In Book mode, arrows and swipes turn a two-page spread; entering a page number opens the spread containing that page.
- **Continuous / Single page / Two-page book:** choose the PDF reading layout.
  Single Page and Two-page Book both change pages immediately without paper-turn animation. Two-page mode still preloads nearby WebP pages and navigates a complete spread per step. Book mode shows cover page 1 alone and pairs pages 2–3, 4–5, etc.; select it on a tablet/desktop for comfortable side-by-side reading, or opt in on a phone.
- **Fit page / zoom / rotate:** adjust how pages display.
- **Pinch:** zoom with two fingers on iPhone/iPad; the separate EPUB reader and existing WebP reader remain unchanged.
- **Bookmark:** save a page for later.
- **Library:** return to the library; the browser Back button also returns to the library.

PiShelf initially shows a smaller WebP page preview and upgrades it to a sharper image when needed. It releases distant images to help mobile Safari memory usage.

### Numbered paragraph Read Aloud

Normal **🔊 Read** works as before. While it is speaking, tap **¶ 1–7** in the floating voice player to open an optional paragraph picker. Tap any paragraph on the PDF/WebP page or EPUB to mark it **1, 2, 3…** in the order you choose; the selected paragraphs are highlighted and numbered. The list shows each paragraph's text, with **↑ / ↓** to change order and **✕** to remove it. You may add selections from different PDF pages. Selecting them does not interrupt the ongoing automatic reading.

Choose **▶ Play selected** to switch playback to **only** the numbered paragraphs in your chosen order. PiShelf retains the existing Edge Neural TTS voice, speed, and buffering. **Clear** deletes the selections. Return to normal **🔊 Read** to use automatic reading again. The queue is temporary and clears when you leave the document.

PDF paragraph selection uses the original embedded PDF text even though the page displays a WebP image. Image-only/scanned text cannot be selected without a PDF text layer; some complex layouts may group adjacent lines as one paragraph.

## 6. Settings, cache and data

Settings lets you change themes, reading mode, quality and cover density, manage collections, export/restore reading metadata, rescan the library and clear the WebP cache.

**Clear WebP cache** removes generated page images only. It does not delete PDFs. Images are regenerated as you read.

The Docker `piself` volume stores reading progress and application state. Back up this volume and your original PDF folders separately. A reading-backup JSON file does **not** include the PDFs.

## 7. Troubleshooting

### No magazines appear

1. Reload the page (the library scans on reload).
2. Confirm `MAGAZINE_DIR` and `NEWSPAPER_DIR` in your existing `.env` point to real host directories.
3. Run `ls -lah /your/real/pdf/folder` on the Pi; check the NAS/SSD mount and file permissions.
4. Run `docker compose ps` and `docker compose logs --tail=100`.
5. If you recently changed `.env`, run `docker compose up -d --build --remove-orphans` to recreate the container with the new mounts.
6. Try a fresh browser reload; if the page remains empty, inspect Safari's JavaScript console or report the error.

A completely blank library UI may also indicate a browser JavaScript startup error; check the console before moving or deleting PDF files.

### Reader is slow or Safari reloads

Use the balanced quality setting, close other memory-heavy Safari tabs, and avoid repeatedly zooming many scanned pages to maximum resolution. The WebP cache improves subsequent reads. Clearing it can temporarily make reading slower because images must be regenerated.

### PDF conversion fails

Check that the PDF opens normally, the Pi has free disk space and the Docker logs contain no conversion errors. The reader retains a PDF.js fallback for WebP conversion failures.

### NAS PDF folder looks empty

Check the NAS is mounted on the host **before** Docker starts. A directory may exist on the Pi even when the NAS mount has failed.

## 8. Safety and maintenance

PiShelf is designed for a trusted home network and has no built-in user login. Do not forward its port directly to the internet; use a private VPN for remote access. Keep original PDFs and the `piself` data volume backed up.

For developers, see `static/app.js` for the code navigation map and lifecycle invariants. Run source regression tests before merging UI changes. Test pinch zoom, browser Back, long PDFs, mixed page sizes, thumbnails and library reload on an actual iPhone/iPad.
