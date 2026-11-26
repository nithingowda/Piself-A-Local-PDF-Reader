"""Background OCR for uploaded PDFs. Jobs survive a PiShelf restart."""
import logging
import os
import sqlite3
import stat
import subprocess
import tempfile
import threading
from pathlib import Path


def fingerprint(info):
    return f"{info.st_dev}:{info.st_ino}:{info.st_size}:{info.st_mtime_ns}"


def initialize(db):
    db.execute("""CREATE TABLE IF NOT EXISTS upload_ocr (
        id TEXT PRIMARY KEY, source TEXT NOT NULL, path TEXT NOT NULL,
        fingerprint TEXT NOT NULL, status TEXT NOT NULL)""")


def enqueue(db, key, source, relative, path):
    db.execute("INSERT OR REPLACE INTO upload_ocr VALUES (?,?,?,?,?)",
               (key, source, relative, fingerprint(path.stat()), "pending"))


def recognize(path, staging):
    import fitz

    with fitz.open(path) as pdf:
        if pdf.needs_pass or pdf.get_sigflags() > 0:
            return "protected"
        missing = [i for i, page in enumerate(pdf) if not page.get_text().strip()]
        if not missing:
            return "ready"

    subprocess.run(["ocrmypdf", "--skip-text", "--jobs", "1", "--output-type", "pdf",
                    "--optimize", "0", "-l", "kan+eng", str(path), str(staging)],
                   check=True, timeout=7200, stdout=subprocess.DEVNULL,
                   env={**os.environ, "OMP_THREAD_LIMIT": "1"})
    with fitz.open(staging) as result:
        with fitz.open(path) as original:
            if result.page_count != original.page_count:
                raise ValueError("OCR changed page count")
        if not any(result[i].get_text().strip() for i in missing):
            return "no_text"
    return "converted"


def process(server, checked_path, job):
    key, source, relative, expected = job
    root = server.roots.get(source)

    def current():
        if root is None or server.roots.get(source) != root:
            return None
        path = checked_path(root, relative)
        return path if path.is_file() and fingerprint(path.stat()) == expected else None

    status = "failed"
    updated = expected
    try:
        path = current()
        if path is None:
            status = "stale"
        else:
            with tempfile.TemporaryDirectory(prefix=".pishelf-ocr-", dir=path.parent) as folder:
                output = Path(folder) / "searchable.pdf"
                status = recognize(path, output)
                if status == "converted":
                    with server.mutation_lock:
                        if current() is None:
                            status = "stale"
                        else:
                            output.chmod(stat.S_IMODE(path.stat().st_mode))
                            updated = fingerprint(output.stat())
                            output.replace(path)
                            status = "ready"
    except Exception:
        logging.exception("OCR could not finish for %s", relative)
        status = "failed"
    with sqlite3.connect(server.state_db) as db:
        if status == "stale":
            db.execute("DELETE FROM upload_ocr WHERE id=? AND fingerprint=?", (key, expected))
        else:
            db.execute("UPDATE upload_ocr SET status=?, fingerprint=? WHERE id=? AND fingerprint=?",
                       (status, updated, key, expected))
    server.scan_time = float("-inf")


def start(server, checked_path):
    # A single worker bounds CPU use and drains the persistent queue in upload order.
    with server.ocr_lock:
        if server.ocr_worker and server.ocr_worker.is_alive():
            return

        def drain():
            while True:
                with server.ocr_lock:
                    with sqlite3.connect(server.state_db) as db:
                        job = db.execute("SELECT id,source,path,fingerprint FROM upload_ocr "
                                         "WHERE status='pending' ORDER BY rowid LIMIT 1").fetchone()
                    if job is None:
                        server.ocr_worker = None
                        return
                process(server, checked_path, job)

        server.ocr_worker = threading.Thread(target=drain, name="pishelf-ocr", daemon=True)
        server.ocr_worker.start()
