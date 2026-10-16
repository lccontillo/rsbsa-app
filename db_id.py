"""Separate SQLite database for the Farmer's ID Card Generator.

This database is intentionally independent from the certification
database (``instance/rsbsa.db``). The ID Card Generator keeps its own
person records here; they are populated by:

* CSV uploads using the fields needed to generate the ID (RSBSA Number,
  Farmer Name, Gender, Civil Status, Address, Birthdate, Contact Number,
  and Contact Person in Case of Emergency), and
* copying selected farmers from the certification Farmer Masterlist.

Any ID detail left blank in the CSV, and the photo (which cannot be
embedded in a CSV), are encoded/uploaded per person inside the ID Card
Generator and stored here too. Issued cards are
registered in ``id_cards`` with FID-YYYY-#### control numbers.
"""
import os
import sqlite3

import db

ID_DB_PATH = os.path.join(db.INSTANCE_DIR, "id_generator.db")

SCHEMA = """
CREATE TABLE IF NOT EXISTS id_persons (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    rsbsa_key        TEXT NOT NULL UNIQUE,
    rsbsa_number     TEXT NOT NULL,
    name             TEXT NOT NULL,
    gender           TEXT,
    civil_status     TEXT,
    address          TEXT,
    birthdate        TEXT,
    contact_number   TEXT,
    emergency_contact TEXT,
    affiliated_fca   TEXT,
    photo_path       TEXT,
    source           TEXT NOT NULL DEFAULT 'csv',
    source_farmer_id INTEGER,
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS fca_list (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS id_cards (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    person_id     INTEGER NOT NULL UNIQUE REFERENCES id_persons (id),
    control_no    TEXT NOT NULL UNIQUE,
    issued_at     TEXT NOT NULL,
    valid_until   TEXT,
    reprint_count INTEGER NOT NULL DEFAULT 0,
    status        TEXT NOT NULL DEFAULT 'active',
    created_by    INTEGER
);
CREATE TABLE IF NOT EXISTS seq (
    key   TEXT PRIMARY KEY,
    value INTEGER NOT NULL
);
"""


def connect() -> sqlite3.Connection:
    conn = sqlite3.connect(ID_DB_PATH, timeout=15)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    return conn


def init_db() -> None:
    conn = connect()
    try:
        conn.executescript(SCHEMA)
        columns = {row[1] for row in
                   conn.execute("PRAGMA table_info(id_persons)")}
        if "gender" not in columns:
            conn.execute("ALTER TABLE id_persons ADD COLUMN gender TEXT")
        if "affiliated_fca" not in columns:
            conn.execute(
                "ALTER TABLE id_persons ADD COLUMN affiliated_fca TEXT")
        if "barangay" not in columns:
            conn.execute("ALTER TABLE id_persons ADD COLUMN barangay TEXT")
        if "remarks" not in columns:
            conn.execute("ALTER TABLE id_persons ADD COLUMN remarks TEXT NOT NULL DEFAULT 'Active'")
        card_cols = {row[1] for row in
                     conn.execute("PRAGMA table_info(id_cards)")}
        if "is_printed" not in card_cols:
            conn.execute("ALTER TABLE id_cards ADD COLUMN is_printed INTEGER NOT NULL DEFAULT 0")
        if "printed_at" not in card_cols:
            conn.execute("ALTER TABLE id_cards ADD COLUMN printed_at TEXT")
        conn.commit()
    finally:
        conn.close()


def normalize_fca(value) -> str:
    """Standardize an Affiliated FCA name to single-spaced UPPERCASE."""
    return " ".join(str(value or "").strip().upper().split())


def remember_fca(conn, value) -> str:
    """Normalize an FCA name and remember it in ``fca_list`` if non-empty."""
    name = normalize_fca(value)
    if name:
        conn.execute(
            "INSERT OR IGNORE INTO fca_list (name, created_at) VALUES (?, ?)",
            (name, db.now_iso()),
        )
    return name


def list_fcas(conn) -> list:
    """Return all remembered FCA entries with member counts."""
    for row in conn.execute(
        "SELECT DISTINCT affiliated_fca FROM id_persons "
        "WHERE affiliated_fca IS NOT NULL AND TRIM(affiliated_fca) <> ''"
    ).fetchall():
        remember_fca(conn, row[0])
    rows = conn.execute(
        "SELECT f.id, f.name, f.created_at, "
        "(SELECT COUNT(*) FROM id_persons p WHERE p.affiliated_fca = f.name) "
        "AS members "
        "FROM fca_list f ORDER BY f.name ASC"
    ).fetchall()
    return [dict(r) for r in rows]


def normalize_gender(value):
    """Normalize common Gender/Sex values for the ID database."""
    text = str(value or "").strip().upper()
    return {
        "M": "MALE",
        "MAN": "MALE",
        "LALAKI": "MALE",
        "F": "FEMALE",
        "WOMAN": "FEMALE",
        "BABAE": "FEMALE",
    }.get(text, text)


def normalize_civil_status(value):
    """Normalize common Civil Status values to the standard dropdown set."""
    text = str(value or "").strip().upper()
    return {
        "WIDOW": "WIDOWED",
        "WIDOWER": "WIDOWED",
        "LEGALLY SEPARATED": "SEPARATED",
        "SEPARATE": "SEPARATED",
    }.get(text, text)


def rsbsa_key(rsbsa_number) -> str:
    return f"RSBSA::{(rsbsa_number or '').strip().upper()}"


def find_person_by_rsbsa(conn, rsbsa_number):
    return conn.execute(
        "SELECT * FROM id_persons WHERE rsbsa_key = ?",
        (rsbsa_key(rsbsa_number),)).fetchone()


def next_fid(conn, floor: int = 0) -> str:
    """Next FID-YYYY-#### in this database, never below ``floor``.

    ``floor`` lets the caller account for control numbers already used by
    the legacy masterlist registry in the main database, so control
    numbers stay unique across both registries.
    """
    import datetime as _dt
    year = _dt.datetime.now().strftime("%Y")
    key = f"fid:{year}"
    row = conn.execute("SELECT value FROM seq WHERE key = ?",
                       (key,)).fetchone()
    if row is None:
        conn.execute("INSERT INTO seq (key, value) VALUES (?, ?)",
                     (key, floor))
        current = floor
    else:
        current = max(row["value"], floor)
    new_val = current + 1
    conn.execute("INSERT INTO seq (key, value) VALUES (?, ?) "
                 "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                 (key, new_val))
    return f"FID-{year}-{new_val:04d}"
