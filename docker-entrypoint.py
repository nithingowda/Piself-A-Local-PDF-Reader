"""Prepare PiShelf storage, drop privileges, then replace this process with the app."""
import os
from pathlib import Path
import stat
import sys


def prepare_data(directory, uid, gid):
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    covers = directory / "covers"
    if covers.is_symlink():
        raise ValueError("Cover cache cannot be a symlink.")
    paths = [directory, *directory.glob("progress.sqlite3*")]
    if covers.exists():
        paths.extend([covers, *covers.glob("*.jpg")])
    for path in paths:
        # Refuse symlinks so permission changes stay within the data volume.
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        try:
            info = os.fstat(fd)
            if path in (directory, covers):
                if not stat.S_ISDIR(info.st_mode):
                    raise ValueError("The data path must be a directory.")
                access = 0o700
            else:
                if not stat.S_ISREG(info.st_mode):
                    raise ValueError("SQLite storage must contain regular files.")
                access = 0o600
            os.fchown(fd, uid, gid)
            os.fchmod(fd, stat.S_IMODE(info.st_mode) | access)
        finally:
            os.close(fd)


def main():
    if len(sys.argv) < 2:
        raise ValueError("No application command was provided.")
    if os.geteuid() == 0:
        uid = int(os.environ.get("PISHELF_UID", "1000"))
        gid = int(os.environ.get("PISHELF_GID", "1000"))
        if uid <= 0 or gid <= 0:
            raise ValueError("PISHELF_UID and PISHELF_GID must be positive non-root IDs.")
        prepare_data("/data", uid, gid)
        os.setgroups([])
        os.setgid(gid)
        os.setuid(uid)
    os.execvp(sys.argv[1], sys.argv[1:])


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError) as error:
        print(f"PiShelf startup failed: {error}", file=sys.stderr, flush=True)
        sys.exit(1)
