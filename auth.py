"""PiShelf authentication: PBKDF2 passwords, expiring server-side sessions and roles.

Run: python auth.py create-admin /data/progress.sqlite3
Passwords are never accepted as CLI arguments or stored in plaintext.
"""
import getpass
import hashlib
import hmac
import os
import re
import secrets
import sqlite3
import sys
import time
from http.cookies import SimpleCookie

ITERATIONS = 600_000
SESSION_SECONDS = 30 * 24 * 3600
MAX_SESSIONS = 5
USERNAME = re.compile(r"^[a-zA-Z0-9_.-]{3,40}$")


def initialize(db):
    db.execute("""CREATE TABLE IF NOT EXISTS auth_users (
        id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE,
        salt BLOB NOT NULL, password_hash BLOB NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('admin','reader')),
        enabled INTEGER NOT NULL DEFAULT 1)""")
    db.execute("""CREATE TABLE IF NOT EXISTS auth_sessions (
        token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL,
        csrf TEXT NOT NULL, expires REAL NOT NULL,
        FOREIGN KEY(user_id) REFERENCES auth_users(id))""")
    columns={row[1] for row in db.execute("PRAGMA table_info(auth_sessions)")}
    for name,definition in (("created","REAL"),("user_agent","TEXT"),("session_id","TEXT")):
        if name not in columns:
            db.execute(f"ALTER TABLE auth_sessions ADD COLUMN {name} {definition}")
    for (digest,) in db.execute("SELECT token_hash FROM auth_sessions WHERE session_id IS NULL").fetchall():
        db.execute("UPDATE auth_sessions SET session_id=? WHERE token_hash=?",(secrets.token_urlsafe(18),digest))



def password_hash(password, salt):
    return hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, ITERATIONS)


def validate_password(password):
    if not isinstance(password, str) or not 12 <= len(password) <= 256:
        raise ValueError("Password must be 12–256 characters.")


def create_user(db, username, password, role):
    if not isinstance(username, str) or not USERNAME.fullmatch(username):
        raise ValueError("Username must be 3–40 letters, numbers, dots, dashes or underscores.")
    if role not in ("admin", "reader"):
        raise ValueError("Invalid role.")
    validate_password(password)
    salt = secrets.token_bytes(24)
    db.execute("INSERT INTO auth_users(username,salt,password_hash,role) VALUES (?,?,?,?)",
               (username, salt, password_hash(password, salt), role))
    if role == "admin" and db.execute("SELECT 1 FROM sqlite_master WHERE name='progress'").fetchone():
        if "user_id" in {row[1] for row in db.execute("PRAGMA table_info(progress)")}:
            db.execute("UPDATE progress SET user_id=(SELECT id FROM auth_users WHERE username=?) WHERE user_id=0", (username,))



def authenticate(db, username, password):
    if not isinstance(username, str) or not isinstance(password, str):
        return None
    row = db.execute("SELECT id,salt,password_hash,role,enabled FROM auth_users WHERE username=?",
                     (username,)).fetchone()
    # Match the cost of a real password check for unknown usernames.
    if not row:
        password_hash(password[:256], b"\x00"*24)
        return None
    if len(password) > 256 or not hmac.compare_digest(password_hash(password, row[1]), row[2]) or not row[4]:
        return None
    return {"id": row[0], "username": username, "role": row[3]}


def new_session(db, user_id, user_agent=''):
    token = secrets.token_urlsafe(48)
    csrf = secrets.token_urlsafe(32)
    db.execute("BEGIN IMMEDIATE") if not db.in_transaction else None
    db.execute("DELETE FROM auth_sessions WHERE expires<?", (time.time(),))
    db.execute("""DELETE FROM auth_sessions WHERE user_id=? AND token_hash IN (
        SELECT token_hash FROM auth_sessions WHERE user_id=?
        ORDER BY COALESCE(created,expires-43200) DESC, expires DESC, token_hash
        LIMIT -1 OFFSET ?)""",(user_id,user_id,MAX_SESSIONS-1))
    db.execute("INSERT INTO auth_sessions(token_hash,user_id,csrf,expires,created,user_agent,session_id) VALUES (?,?,?,?,?,?,?)",
               (hashlib.sha256(token.encode()).hexdigest(), user_id, csrf, time.time()+SESSION_SECONDS,time.time(),user_agent[:512],secrets.token_urlsafe(18)))
    return token, csrf


def session(db, headers):
    cookie = SimpleCookie()
    try:
        cookie.load(headers.get("Cookie", ""))
        token = cookie["pishelf_session"].value
    except (KeyError, ValueError):
        return None
    digest = hashlib.sha256(token.encode()).hexdigest()
    row = db.execute("""SELECT u.id,u.username,u.role,s.csrf,s.expires
        FROM auth_sessions s JOIN auth_users u ON u.id=s.user_id
        WHERE s.token_hash=? AND u.enabled=1""", (digest,)).fetchone()
    if not row or row[4] <= time.time():
        return None
    return {"id": row[0], "username": row[1], "role": row[2], "csrf": row[3], "token_hash": digest}


def revoke_user(db, user_id):
    db.execute("DELETE FROM auth_sessions WHERE user_id=?", (user_id,))


def main():
    if len(sys.argv) != 3 or sys.argv[1] != "create-admin":
        raise SystemExit("Usage: python auth.py create-admin /data/progress.sqlite3")
    username = input("Admin username: ").strip()
    password = getpass.getpass("Admin password (12+ characters): ")
    confirm = getpass.getpass("Confirm password: ")
    if password != confirm:
        raise SystemExit("Passwords do not match.")
    with sqlite3.connect(sys.argv[2]) as db:
        initialize(db)
        if db.execute("SELECT 1 FROM auth_users WHERE role='admin'").fetchone():
            raise SystemExit("Admin already exists. Manage users in the admin panel.")
        create_user(db, username, password, "admin")
    print("Admin account created. Restart PiShelf if it is running.")


if __name__ == "__main__":
    main()
