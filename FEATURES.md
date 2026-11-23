# Library and reader guide

## Covers that stay cached

The first time a cover is visible, your browser renders the PDF's first page and uploads a small JPEG to `/data/covers` in the existing `piself` volume. Other devices and later visits reuse that image without opening the PDF for a cover. A changed file size or modification time generates a new cache key. The cache is capped at 256 MiB; oldest images are removed when it fills. Covers can be regenerated and are not part of a reading backup.

The catalogue displays 60 issues at a time; use **Show more issues** for the next batch. Search and filters apply to the entire catalogue. Cover generation pauses while reading. Manual refresh immediately rescans; repeated requests share a short server-side scan cache.

## Publications, dates, tags and search

`Astronomy, vol. 54.07 (July 2026).pdf` and `Astronomy, vol. 54.09 (September 2026).pdf` are recognised as the **Astronomy** publication, with **July 2026** and **September 2026** issue labels. Click **Astronomy** below a cover to browse its issues. Common full month names and ISO dates are recognised; use the editor to correct other filename styles.

Search matches all entered words across filename, publication, issue date, category and tags. Filter magazines and newspapers independently, select a publication or tag, or click a tag below a cover. **Clear filters** returns to the full library. Issue-date sorting places dated issues first.

## Categories and filenames

Choose **New category**, select Magazines or Newspapers, and enter a folder name. Use `Science/Astronomy` for nested folders. Empty categories are listed too.

Open an issue's **••• → Edit filename, category & tags** to:

- Rename the actual PDF, retaining the `.pdf` extension.
- Move it into a category within the same source.
- Set its publication name and issue date (`YYYY-MM` or `YYYY-MM-DD`).
- Add comma-separated tags.

PiShelf carries reading progress, favourites and bookmarks to the new filename. It refuses to overwrite an existing PDF. The configured container user needs write access to the source and destination folders. Changes made directly outside PiShelf do not migrate reading records. When using a Nextcloud-managed folder, filesystem changes may also require a Nextcloud file rescan.

## Focused reading and themes

Opening a PDF hides the top and bottom reader bars. Tap the PDF page once to reveal or hide them; **Hide controls** also returns to the full reading area. There is no floating Controls button. On desktop, double-click the page or press **C**. A keyboard/screen-reader control remains available. The reader retains page bookmarks, bookmark jumping, continuous/single-page modes, zoom, rotation, and fullscreen where supported.

**Settings → Website theme** offers Light, Dark, AMOLED (pure black), and Follow device. **Reading theme** separately controls Light, Warm paper, Dark surroundings, AMOLED surroundings, or Night (dimmer, warmer PDF pages). Night changes the appearance of PDF content; other modes leave page colours unchanged. Preferences persist per browser and are included in downloaded reading backups.

The library, editing forms, settings, and reader controls adapt to phone and tablet screens. On mobile, use touch scrolling and double-tap zoom; browser-native fullscreen availability varies.

## Backup and restore in Settings

**Download reading backup** exports a JSON file containing:

- Reading positions, favourites, completion flags and bookmarks.
- Publication names, issue dates and tags.
- Category paths and this browser's appearance/reader preferences.

**Restore reading backup** is available from the library. It validates the file before importing, merges records by issue ID, and replaces matching records after confirmation. PDFs are not moved or overwritten by restore. The original relative filenames and source names must match for restored reading records to attach to issues. Maximum import size: 5 MiB.

This is a reading-state backup, not a PDF archive. Back up both source folders and the Docker volume separately to preserve PDFs and recoverable Trash records. The existing full-volume backup instructions remain in [DOCKER.md](DOCKER.md).

## Separate Docker paths

The stack still uses one container, port **8098**, and the **piself** data volume. Configure source folders in `.env`:

```dotenv
MAGAZINE_DIR=/mnt/Nithin-Nas/nextcloud/data/nithingowda/files/Magazines
NEWSPAPER_DIR=/mnt/Nithin-Nas/nextcloud/data/nithingowda/files/NewsPapers
PISHELF_PORT=8098
```

Or use a separate Docker path file:

```sh
cp compose.paths.example.yaml compose.override.yaml
# Edit the two source paths in compose.override.yaml.
docker compose up -d --build --remove-orphans
```

Standard Docker Compose automatically reads `compose.override.yaml`. If using Dockhand, include that override in the stack configuration or configure the two environment variables; do not assume Dockhand automatically imports another file. Create both host directories first and give the configured UID/GID the required read/write access. Keep sources separate, not nested inside one another.

For native Python startup:

```sh
python3 server.py --library /path/to/Magazines --newspapers /path/to/NewsPapers --data /path/to/state
```

Before upgrading, back up your source folders and data volume. Never use `docker compose down -v` for this upgrade; it removes the reading-state volume.

## Gestures and remembered reader settings

With **Settings → Swipe pages and pinch to zoom** enabled:

- Swipe left for the next page and right for the previous page when at fit width or smaller. A vertical scroll remains ordinary scrolling.
- Tap once for the reader bars. Double-tap to zoom in or return to page fit. It remains available even when swipe/pinch gestures are disabled. Desktop users can double-click or press **C**.
- Pinch with two fingers to zoom the PDF from 0.5× to 3×. The page previews the scale while pinching and renders once at the new resolution when the gesture ends. Zoom is saved for the issue.
- At larger zoom levels, horizontal dragging pans the page instead of changing pages. Two-finger pinches zoom the PDF itself.

Page, zoom, rotation and continuous/single-page mode are saved for each issue. Opening it again restores those settings. Browser zoom outside the reader remains available. The reader has no Open PDF link and no saving-success banner; failed saves still show a brief error so reading changes are not silently lost.

## Reading collections

Use **New collection** in the sidebar to create a shelf such as Read later or Weekend. Open an issue's **••• → Edit filename, category & tags** and check its Reading collections. An issue can belong to several collections without moving its file. Click a collection to filter the library.

Rename or remove a collection in **Settings → Collections**. Removing a collection does not delete PDFs or reading progress. Membership follows a PDF renamed through PiShelf. Collections and memberships are included in reading backups; backups from earlier versions without collections remain supported. Restoring a collection replaces the memberships for that matching collection ID, and conflicting names must be resolved before import.

## Upload in Settings

Choose a source and category under **Settings → Upload PDFs**, select files and click **Upload selected PDFs**. Files are uploaded sequentially, with a progress indicator and Cancel button, directly into the mounted storage folder. Each PDF can be up to **512 MiB**. The server streams to a hidden temporary file in 256 KiB chunks; the complete PDF is never buffered in Python memory. Incomplete or cancelled uploads remove their temporary files. A destination filename is never overwritten.

Uploads require write permission on the target storage folder. Reverse proxies can impose their own smaller upload size or timeout limits. The upload validates the filename, size and PDF header; a PDF may still be corrupt internally. As with other external filesystem changes to a Nextcloud-managed folder, Nextcloud may require a file rescan.

## Permanent deletion

**••• → Delete permanently from storage…** deletes the actual PDF from its magazine or newspaper folder after explicit confirmation. It also removes its reading record, metadata, collection memberships and generated server cover where possible. It cannot be undone by restoring a reading backup, since that backup contains no PDFs.

**Move to Trash…** is a separate recoverable action. In **Settings → Trash**, either restore the PDF or choose **Delete permanently** to remove the stored trash file and free its space. Shared files, filesystem snapshots, NAS recycle bins and backups may retain their own copies outside PiShelf.

## Lower overhead

- Cached shelves do not load PDF.js or start a PDF worker until a PDF needs rendering.
- Cover generation reuses one worker per batch and releases it when finished.
- Unchanged reading state is not saved repeatedly; saving no longer invalidates the library scan cache.
- Categories share the library scan, and scroll tracking uses a binary search over page positions.
- Only nearby canvases and pages currently visible on screen are retained, with a maximum of three million pixels each. Actual PDF worker and browser memory still depends on the document.
- The stylesheet has been consolidated rather than layering duplicate theme rules.

This reduces unnecessary work, but is not a hardware-specific CPU or memory benchmark.
