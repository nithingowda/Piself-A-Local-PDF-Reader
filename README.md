# ▥ PiShelf

PiShelf is a self-hosted reading room for PDF magazines, newspapers and DRM-free EPUB books. Point it at folders on your server or mounted NAS, then open your shelf from a phone, tablet or desktop browser.

## What you can do

- **Organise your shelf.** Browse by cover, search titles and tags, filter by publication or category, and group issues into collections. Continue reading opens your recent publications.
- **Read PDFs.** Choose continuous scrolling, single pages or a two-page magazine spread with a page curl. Pinch to zoom or double-tap a detail. Double-tap again for automatic fit.
- **Read EPUB books.** Navigate chapters, adjust text size and switch reading themes.
- **Listen and annotate.** Queue selected PDF passages for read-aloud, bookmark pages, and save notes or highlights.
- **Manage a shared library.** Administrators manage accounts, uploads and Trash. Reading progress and favourites are shared across devices. Original publications stay in their source folders.

## Install with Docker Compose

You need a server with Git, Docker Engine and the Compose plugin, plus three folders for your publications. Mounted network folders work too.

1. Clone the project and create its settings file.

   ```sh
   git clone https://github.com/nithingowda/Piself-A-Local-PDF-Reader.git
   cd Piself-A-Local-PDF-Reader
   cp .env.example .env
   ```

2. Edit `.env` to use **existing absolute paths on your server**. Set the UID and GID to a non-root account that can read those folders and write uploads. Run `id` as that account to see its IDs.

   ```dotenv
   MAGAZINE_DIR=/mnt/Nithin-Nas/nextcloud/data/nithingowda/files/Magazines
   NEWSPAPER_DIR=/mnt/Nithin-Nas/nextcloud/data/nithingowda/files/NewsPapers
   BOOK_DIR=/mnt/Nithin-Nas/nextcloud/data/nithingowda/files/Books
   PISHELF_UID=1000
   PISHELF_GID=1000
   PISHELF_PORT=8098
   ```

   Mount the NAS before starting PiShelf. Docker binds these directories to `/magazines`, `/newspapers` and `/books` when it creates the container. In PiShelf Settings, use those container paths. After changing `.env`, run the command below again to apply the new mounts.

3. Start PiShelf on its project bridge network.

   ```sh
   docker compose up -d --build
   ```

4. Open `http://SERVER_IP:8098` on your private network and create the first administrator account. Leave the setup form’s folder fields blank to use the Compose mounts. Put EPUB files in the books folder.

PiShelf keeps its database and generated covers in the Docker volume `piself`. Back up that volume and your publication folders. The browser loads reader libraries from a CDN, and online read-aloud requires internet access.

[Reader guide](USER_MANUAL.md) · [Docker and storage](DOCKER.md) · [Accounts](AUTHENTICATION.md) · [Security](SECURITY.md)
