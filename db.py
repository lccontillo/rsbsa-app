"""SQLite database layer for the RSBSA Certification Manager."""
import datetime
import json
import os
import sqlite3

from werkzeug.security import generate_password_hash

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
INSTANCE_DIR = os.path.join(BASE_DIR, "instance")
DB_PATH = os.path.join(INSTANCE_DIR, "rsbsa.db")
FILINGS_DIR = os.path.join(BASE_DIR, "filings")
TEMPLATES_DIR = os.path.join(INSTANCE_DIR, "templates")
ID_CARDS_DIR = os.path.join(INSTANCE_DIR, "id_cards")
PHOTOS_DIR = os.path.join(INSTANCE_DIR, "photos")
SAMPLE_TEMPLATE_PATH = os.path.join(TEMPLATES_DIR, "sample_rsbsa_certification.docx")

for _d in (INSTANCE_DIR, FILINGS_DIR, TEMPLATES_DIR, ID_CARDS_DIR, PHOTOS_DIR):
    os.makedirs(_d, exist_ok=True)

# Placeholders that the system fills in automatically (never shown to farmers).
from docgen import SYSTEM_PLACEHOLDER_KEYS as SYSTEM_KEYS  # noqa: E402

SCHEMA = """
CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS barangays (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL UNIQUE,
    active     INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    full_name     TEXT NOT NULL,
    role          TEXT NOT NULL CHECK (role IN ('admin', 'secretary')),
    barangay_id   INTEGER REFERENCES barangays (id),
    active        INTEGER NOT NULL DEFAULT 1,
    created_at    TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS templates (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    filename    TEXT NOT NULL,
    fields_json TEXT NOT NULL,
    uploaded_by INTEGER REFERENCES users (id),
    active      INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS requests (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    ref_no       TEXT NOT NULL UNIQUE,
    template_id  INTEGER NOT NULL REFERENCES templates (id),
    barangay_id  INTEGER NOT NULL REFERENCES barangays (id),
    data_json    TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'approved', 'rejected')),
    submitted_at TEXT NOT NULL,
    guest_ip     TEXT,
    notes        TEXT,
    reviewed_by  INTEGER REFERENCES users (id),
    reviewed_at  TEXT
);
CREATE TABLE IF NOT EXISTS certificates (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    cert_no      TEXT NOT NULL UNIQUE,
    request_id   INTEGER NOT NULL REFERENCES requests (id),
    template_id  INTEGER NOT NULL REFERENCES templates (id),
    barangay_id  INTEGER NOT NULL REFERENCES barangays (id),
    farmer_name  TEXT,
    docx_path    TEXT,
    pdf_path     TEXT,
    generated_by INTEGER NOT NULL REFERENCES users (id),
    generated_at TEXT NOT NULL,
    pdf_file_created_at TEXT,
    pdf_purged_at TEXT,
    data_json    TEXT
);
CREATE TABLE IF NOT EXISTS audit_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    ts          TEXT NOT NULL,
    actor       TEXT NOT NULL,
    actor_role  TEXT NOT NULL,
    action      TEXT NOT NULL,
    detail      TEXT,
    barangay_id INTEGER
);
CREATE TABLE IF NOT EXISTS seq (
    key   TEXT PRIMARY KEY,
    value INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS farmers (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    rsbsa_key    TEXT NOT NULL UNIQUE,
    rsbsa_number TEXT,
    name         TEXT NOT NULL,
    civil_status TEXT,
    address      TEXT,
    data_json    TEXT NOT NULL DEFAULT '{}',
    barangay_id  INTEGER REFERENCES barangays (id),
    first_seen   TEXT NOT NULL,
    last_seen    TEXT NOT NULL,
    verification_status TEXT NOT NULL DEFAULT 'new',
    verified_by  INTEGER,
    verified_at  TEXT,
    photo_path   TEXT,
    birthdate    TEXT,
    contact_number TEXT,
    emergency_contact TEXT,
    blood_type   TEXT
);
CREATE TABLE IF NOT EXISTS request_farmers (
    request_id INTEGER NOT NULL REFERENCES requests (id),
    farmer_id  INTEGER NOT NULL REFERENCES farmers (id),
    PRIMARY KEY (request_id, farmer_id)
);
CREATE TABLE IF NOT EXISTS farmer_ids (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    farmer_id    INTEGER NOT NULL REFERENCES farmers (id),
    control_no   TEXT NOT NULL UNIQUE,
    issued_at    TEXT NOT NULL,
    valid_until  TEXT,
    reprint_count INTEGER NOT NULL DEFAULT 0,
    status       TEXT NOT NULL DEFAULT 'active',
    created_by   INTEGER
);
"""

_REQUEST_EXTRA_COLUMNS = (
    ("dup_flag", "TEXT"),
    ("farmers_synced", "INTEGER NOT NULL DEFAULT 0"),
)

# New-farmer verification: every profile created after this feature is
# tagged 'new' until an admin verifies it. Records that already existed
# when the column was added are grandfathered as 'verified'.
_FARMER_EXTRA_COLUMNS = (
    ("verification_status", "TEXT NOT NULL DEFAULT 'new'"),
    ("verified_by", "INTEGER"),
    ("verified_at", "TEXT"),
)

# Farmer's ID Card Maker: details printed on the ID, saved on the farmer
# profile so reprints are one click. photo_path is relative to instance/.
_FARMER_ID_COLUMNS = (
    ("photo_path", "TEXT"),
    ("birthdate", "TEXT"),
    ("contact_number", "TEXT"),
    ("emergency_contact", "TEXT"),
    ("blood_type", "TEXT"),
    ("affiliated_fca", "TEXT"),
)

_FARMER_REMARKS_COLUMNS = (
    ("remarks", "TEXT NOT NULL DEFAULT 'Active'"),
    ("pending_remarks", "TEXT"),
    ("pending_remarks_by", "INTEGER"),
    ("pending_remarks_at", "TEXT"),
    ("gender", "TEXT"),
)

_USER_EXTRA_COLUMNS = (
    ("must_change_password", "INTEGER NOT NULL DEFAULT 0"),
    ("last_active_at", "TEXT"),
)

_FARMER_ID_EXTRA_COLUMNS = (
    ("is_printed", "INTEGER NOT NULL DEFAULT 0"),
    ("printed_at", "TEXT"),
)

# PDF-retention bookkeeping. Database records are NEVER deleted; only the
# PDF file is removed 30 days after pdf_file_created_at. Regenerating a PDF
# refreshes pdf_file_created_at (a fresh 30 days) without touching the
# original generated_at issuance record.
_CERT_EXTRA_COLUMNS = (
    ("pdf_file_created_at", "TEXT"),
    ("pdf_purged_at", "TEXT"),
    ("data_json", "TEXT"),
)


def connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, timeout=15)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    return conn


def init_db() -> None:
    conn = connect()
    conn.executescript(SCHEMA)
    barangay_cols = {r["name"] for r in
                     conn.execute("PRAGMA table_info(barangays)")}
    if "active" not in barangay_cols:
        conn.execute("ALTER TABLE barangays ADD COLUMN active "
                     "INTEGER NOT NULL DEFAULT 1")
    existing = {r["name"] for r in conn.execute("PRAGMA table_info(requests)")}
    for col, decl in _REQUEST_EXTRA_COLUMNS:
        if col not in existing:
            conn.execute(f"ALTER TABLE requests ADD COLUMN {col} {decl}")
    cert_info = {r["name"]: r
                 for r in conn.execute("PRAGMA table_info(certificates)")}
    for col, decl in _CERT_EXTRA_COLUMNS:
        if col not in cert_info:
            conn.execute(f"ALTER TABLE certificates ADD COLUMN {col} {decl}")
    cert_info = {r["name"]: r
                 for r in conn.execute("PRAGMA table_info(certificates)")}
    # Older databases declared docx_path NOT NULL. Certificates are now
    # PDF-only (the DOCX is a temporary rendering intermediate), so rebuild
    # the table with a nullable docx_path and clear stored DOCX paths.
    # No rows are deleted — only the obsolete DOCX path values are nulled.
    if cert_info.get("docx_path") and cert_info["docx_path"]["notnull"]:
        conn.execute(
            "CREATE TABLE certificates_new ("
            "id INTEGER PRIMARY KEY AUTOINCREMENT, "
            "cert_no TEXT NOT NULL UNIQUE, "
            "request_id INTEGER NOT NULL REFERENCES requests (id), "
            "template_id INTEGER NOT NULL REFERENCES templates (id), "
            "barangay_id INTEGER NOT NULL REFERENCES barangays (id), "
            "farmer_name TEXT, docx_path TEXT, pdf_path TEXT, "
            "generated_by INTEGER NOT NULL REFERENCES users (id), "
            "generated_at TEXT NOT NULL, pdf_file_created_at TEXT, "
            "pdf_purged_at TEXT, data_json TEXT)")
        conn.execute(
            "INSERT INTO certificates_new (id, cert_no, request_id, "
            "template_id, barangay_id, farmer_name, docx_path, pdf_path, "
            "generated_by, generated_at, pdf_file_created_at, pdf_purged_at, "
            "data_json) "
            "SELECT id, cert_no, request_id, template_id, barangay_id, "
            "farmer_name, NULL, pdf_path, generated_by, generated_at, "
            "COALESCE(pdf_file_created_at, generated_at), pdf_purged_at, "
            "data_json "
            "FROM certificates")
        conn.execute("DROP TABLE certificates")
        conn.execute("ALTER TABLE certificates_new RENAME TO certificates")
    conn.execute(
        "UPDATE certificates SET pdf_file_created_at = generated_at "
        "WHERE pdf_file_created_at IS NULL")
    farmer_cols = {r["name"] for r in conn.execute("PRAGMA table_info(farmers)")}
    _had_vstatus = "verification_status" in farmer_cols
    for col, decl in _FARMER_EXTRA_COLUMNS:
        if col not in farmer_cols:
            conn.execute(f"ALTER TABLE farmers ADD COLUMN {col} {decl}")
    for col, decl in _FARMER_ID_COLUMNS:
        if col not in farmer_cols:
            conn.execute(f"ALTER TABLE farmers ADD COLUMN {col} {decl}")
    for col, decl in _FARMER_REMARKS_COLUMNS:
        if col not in farmer_cols:
            conn.execute(f"ALTER TABLE farmers ADD COLUMN {col} {decl}")
    user_cols = {r["name"] for r in conn.execute("PRAGMA table_info(users)")}
    for col, decl in _USER_EXTRA_COLUMNS:
        if col not in user_cols:
            conn.execute(f"ALTER TABLE users ADD COLUMN {col} {decl}")
    fid_cols = {r["name"] for r in conn.execute("PRAGMA table_info(farmer_ids)")}
    for col, decl in _FARMER_ID_EXTRA_COLUMNS:
        if col not in fid_cols:
            conn.execute(f"ALTER TABLE farmer_ids ADD COLUMN {col} {decl}")
    conn.execute(
        "CREATE TABLE IF NOT EXISTS messages ("
        "id INTEGER PRIMARY KEY AUTOINCREMENT, "
        "sender_id INTEGER NOT NULL REFERENCES users (id), "
        "recipient_id INTEGER REFERENCES users (id), "
        "message TEXT NOT NULL, "
        "sent_at TEXT NOT NULL, "
        "read_at TEXT, "
        "is_broadcast INTEGER NOT NULL DEFAULT 0)"
    )
    if not _had_vstatus:
        # Pre-existing masterlist records count as already checked.
        conn.execute(
            "UPDATE farmers SET verification_status = 'verified' "
            "WHERE verification_status = 'new'")
    # Standardize municipality/province coverage to Alcala, Cagayan if still
    # holding the legacy Dagupan/Pangasinan defaults.
    muni_row = conn.execute(
        "SELECT value FROM settings WHERE key = 'municipality'").fetchone()
    if muni_row is None or "dagupan" in (muni_row["value"] or "").lower():
        set_setting(conn, "municipality", "Alcala")
    prov_row = conn.execute(
        "SELECT value FROM settings WHERE key = 'province'").fetchone()
    if prov_row is None or "pangasinan" in (prov_row["value"] or "").lower():
        set_setting(conn, "province", "Cagayan")
    conn.commit()
    conn.close()


def normalize_name(name: str) -> str:
    """Uppercase alphanumerics only — used for identity comparisons."""
    return "".join(ch for ch in (name or "").upper() if ch.isalnum())


def farmer_key(rsbsa_number, name, barangay_id) -> str:
    num = (rsbsa_number or "").strip().upper()
    if num:
        return f"RSBSA::{num}"
    return f"NAME::{barangay_id}::{normalize_name(name)}"


def find_farmer_by_rsbsa(conn: sqlite3.Connection, rsbsa_number):
    num = (rsbsa_number or "").strip().upper()
    if not num:
        return None
    return conn.execute(
        "SELECT * FROM farmers WHERE rsbsa_key = ?", (f"RSBSA::{num}",)
    ).fetchone()


def upsert_farmer(conn: sqlite3.Connection, *, rsbsa_number, name,
                  data: dict, barangay_id):
    """Insert or refresh a farmer profile. Returns (farmer_id, created)."""
    key = farmer_key(rsbsa_number, name, barangay_id)
    now = now_iso()
    num = (rsbsa_number or "").strip() or None
    cs = str(data.get("CIVIL_STATUS", "")).strip()
    addr = str(data.get("ADDRESS", "")).strip()
    gender = str(data.get("GENDER", "")).strip()
    bdate = str(data.get("BIRTHDATE", "")).strip()
    row = conn.execute("SELECT id FROM farmers WHERE rsbsa_key = ?",
                       (key,)).fetchone()
    if row:
        conn.execute(
            "UPDATE farmers SET name = ?, "
            "rsbsa_number = COALESCE(?, rsbsa_number), "
            "civil_status = COALESCE(NULLIF(?, ''), civil_status), "
            "address = COALESCE(NULLIF(?, ''), address), "
            "gender = COALESCE(NULLIF(?, ''), gender), "
            "birthdate = COALESCE(NULLIF(?, ''), birthdate), "
            "data_json = ?, last_seen = ? WHERE id = ?",
            (name, num, cs, addr, gender, bdate, json.dumps(data), now, row["id"]),
        )
        return row["id"], False
    cur = conn.execute(
        "INSERT INTO farmers (rsbsa_key, rsbsa_number, name, civil_status, "
        "address, gender, birthdate, data_json, barangay_id, first_seen, last_seen, "
        "verification_status) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new')",
        (key, num, name, cs or None, addr or None, gender or None, bdate or None,
         json.dumps(data), barangay_id, now, now),
    )
    return cur.lastrowid, True


def now_iso() -> str:
    """Current time in Asia/Manila (UTC+08:00), ISO-8601."""
    tz = datetime.timezone(datetime.timedelta(hours=8))
    return datetime.datetime.now(tz).isoformat(timespec="seconds")


def next_seq(conn: sqlite3.Connection, key: str) -> int:
    row = conn.execute("SELECT value FROM seq WHERE key = ?", (key,)).fetchone()
    if row is None:
        conn.execute("INSERT INTO seq (key, value) VALUES (?, 1)", (key,))
        return 1
    new_val = row["value"] + 1
    conn.execute("UPDATE seq SET value = ? WHERE key = ?", (new_val, key))
    return new_val


def make_ref_no(conn: sqlite3.Connection) -> str:
    year = datetime.datetime.now().strftime("%Y")
    return f"REQ-{year}-{next_seq(conn, f'req:{year}'):05d}"


def make_cert_no(conn: sqlite3.Connection, prefix: str) -> str:
    year = datetime.datetime.now().strftime("%Y")
    return f"{prefix}-{year}-{next_seq(conn, f'cert:{year}'):04d}"


def make_farmer_id_no(conn: sqlite3.Connection) -> str:
    """Farmer's ID control number, e.g. FID-2026-0001."""
    year = datetime.datetime.now().strftime("%Y")
    return f"FID-{year}-{next_seq(conn, f'fid:{year}'):04d}"


def get_setting(conn: sqlite3.Connection, key: str, default: str = "") -> str:
    row = conn.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
    return row["value"] if row else default


def set_setting(conn: sqlite3.Connection, key: str, value: str) -> None:
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (key, value),
    )


def log_audit(conn: sqlite3.Connection, actor: str, actor_role: str,
              action: str, detail: str = "", barangay_id=None) -> None:
    conn.execute(
        "INSERT INTO audit_log (ts, actor, actor_role, action, detail, barangay_id) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        (now_iso(), actor, actor_role, action, detail, barangay_id),
    )


def entries_of(data_json: str) -> list:
    """Parse a request's stored data into a list of certificate entries.

    Supports the multi-entry format {"entries": [...]}, the per-entry-type
    format {"entries": [{"template_id": n, "data": {...}}]}, the legacy flat
    single-entry dict, and returns [] when nothing can be parsed.
    """
    try:
        data = json.loads(data_json)
    except (TypeError, ValueError):
        return []
    if isinstance(data, dict) and isinstance(data.get("entries"), list):
        out = []
        for e in data["entries"]:
            if isinstance(e, dict) and isinstance(e.get("data"), dict):
                out.append(e["data"])
            elif isinstance(e, dict):
                out.append(e)
            else:
                out.append({})
        return out or [{}]
    if isinstance(data, dict):
        return [data]
    return []


def entry_templates_of(data_json: str, default_template_id=None) -> list:
    """Template id per entry, aligned with entries_of().

    Entries stored before per-entry certification types existed have no
    template_id and fall back to the request-level default.
    """
    try:
        data = json.loads(data_json)
    except (TypeError, ValueError):
        return []
    if isinstance(data, dict) and isinstance(data.get("entries"), list):
        out = []
        for e in data["entries"]:
            tid = e.get("template_id") if isinstance(e, dict) else None
            out.append(tid or default_template_id)
        return out
    return [default_template_id]


def has_admin(conn: sqlite3.Connection) -> bool:
    return conn.execute(
        "SELECT 1 FROM users WHERE role = 'admin' LIMIT 1"
    ).fetchone() is not None


def create_admin(conn: sqlite3.Connection, username: str, password: str,
                 full_name: str, municipality: str = "", province: str = "",
                 barangay_names=None) -> int:
    cur = conn.execute(
        "INSERT INTO users (username, password_hash, full_name, role, created_at) "
        "VALUES (?, ?, ?, 'admin', ?)",
        (username.strip(), generate_password_hash(password),
         full_name.strip(), now_iso()),
    )
    admin_id = cur.lastrowid
    set_setting(conn, "municipality", (municipality or "Alcala").strip())
    set_setting(conn, "province", (province or "Cagayan").strip())
    if barangay_names:
        for name in barangay_names:
            name = name.strip()
            if name:
                try:
                    conn.execute(
                        "INSERT INTO barangays (name, created_at) VALUES (?, ?)",
                        (name.title(), now_iso()),
                    )
                except sqlite3.IntegrityError:
                    pass
    return admin_id
