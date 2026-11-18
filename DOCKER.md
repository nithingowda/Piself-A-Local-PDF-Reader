# Docker volume setup

PiShelf stores its SQLite database in the Docker volume `piself`, mounted at `/data`. PDFs remain in the host directory configured by `MAGAZINE_DIR`. The default URL is `http://YOUR_PI_IP:8098`; the app still listens on port 8080 inside the container.

## First installation or Dockhand redeployment

Run on the Docker host from the repository folder:

```sh
docker compose build
docker compose up -d
docker compose logs --tail=30 pishelf
```

The `pishelf-init` service prepares volume ownership using your configured `PISHELF_UID` and `PISHELF_GID`, then exits successfully. Compose waits for it before starting the non-root app. Set `PISHELF_PORT=8098` in an existing `.env` or Dockhand environment, since an existing setting overrides Compose's default. In Dockhand, update the stack from GitHub and redeploy to run the permission setup step and start the app.

Compose creates the named volume automatically and can reuse an existing `piself` volume. It survives ordinary `docker compose down`; `docker compose down -v` deletes it. Each independent PiShelf installation should use its own volume.

## Migrate an existing data folder

A new volume starts with empty reading history. To retain progress, favourites, bookmarks, and Trash records:

1. Stop the existing PiShelf container in Dockhand, or run `docker compose stop pishelf` from its current project.
2. Back up the old data folder and magazine folder, including hidden files.
3. Run `docker compose build` and `docker volume create piself`, but do not start the app yet.
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

For `sqlite3.OperationalError: unable to open database file`, update to this Compose configuration and recreate the services so the initializer runs again:

```sh
docker compose down
docker compose up -d --build
docker compose logs --tail=50 pishelf-init pishelf
```

Do not add `-v` to `down`: that removes the data volume. Successful exit of `pishelf-init` is expected. It adjusts the data directory and SQLite files without deleting reading state. It does not change permissions on your PDF collection.

If the initializer fails, inspect its logs and available disk space. Confirm the deployed stack mounts `piself:/data` and that `PISHELF_UID` and `PISHELF_GID` are valid numeric IDs. The initializer requires ownership-changing capabilities on the Docker host.
