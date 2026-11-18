# Docker volume setup

PiShelf stores its SQLite database in the external Docker volume `piself`, mounted at `/data`. PDFs remain in the host directory configured by `MAGAZINE_DIR`. The default URL is `http://YOUR_PI_IP:8098`; the app still listens on port 8080 inside the container.

## First installation or Dockhand redeployment

Run on the Docker host from the repository folder:

```sh
docker compose build
docker volume create piself
docker run --rm --user 0 --entrypoint sh -v piself:/data pishelf:local \
  -c 'chown 1000:1000 /data && chmod 700 /data'
docker compose up -d
docker compose logs --tail=30 pishelf
```

Replace `1000:1000` with your configured `PISHELF_UID:PISHELF_GID` if different. Set `PISHELF_PORT=8098` in an existing `.env` or Dockhand environment, since an existing setting overrides Compose's default. In Dockhand, update the stack from GitHub and redeploy after preparing the volume on the same Docker host.

The volume is external: create it before deploying. It survives stack removal. Each independent PiShelf installation should use its own volume.

## Migrate an existing data folder

A new volume starts with empty reading history. To retain progress, favourites, bookmarks, and Trash records:

1. Stop the existing PiShelf container in Dockhand, or run `docker compose stop pishelf` from its current project.
2. Back up the old data folder and magazine folder, including hidden files.
3. Build the updated image and create the volume using the commands above, but do not start the app yet.
4. Replace `/absolute/path/to/old/data` below with the old host folder mounted at `/data`. Copy into an empty volume:

```sh
docker run --rm --user 0 --entrypoint sh \
  --mount type=bind,src=/absolute/path/to/old/data,dst=/old,readonly \
  -v piself:/data pishelf:local \
  -c 'test -z "$(ls -A /data)" && cp -a /old/. /data/ && chown -R 1000:1000 /data && chmod u+rwx /data'
```

Use the configured UID/GID instead of `1000:1000`. If the volume already contains files, the command stops without copying; inspect and back up that volume before deciding which database to keep. Retain the original data folder until migration is verified.

5. Set `PISHELF_PORT=8098` and redeploy with `docker compose up -d`. Check reading history and `docker compose logs --tail=30 pishelf`.

## Back up the volume

Stop PiShelf, then stream a backup into a local file:

```sh
docker compose stop pishelf
docker run --rm --user 0 --entrypoint tar \
  -v piself:/data:ro pishelf:local -C /data -czf - . > piself-data-backup.tar.gz
docker compose start pishelf
```

Use a new backup filename each time to preserve earlier backups. Also back up the magazine folder, including `.pishelf-trash`, and your `.env`.

## Database permission errors

For `sqlite3.OperationalError: unable to open database file`, stop PiShelf and repair ownership on this dedicated volume:

```sh
docker compose stop pishelf
docker run --rm --user 0 --entrypoint sh -v piself:/data pishelf:local \
  -c 'chown -R 1000:1000 /data && chmod u+rwx /data && find /data -maxdepth 1 -type f -name "progress.sqlite3*" -exec chmod u+rw {} +'
docker compose up -d
docker compose logs --tail=30 pishelf
```

Match the ownership to the configured UID/GID. Check available disk space if the error persists.
