"""RSBSA Certification Manager — Flask application.

Flow:
  * Farmer (guest) selects a barangay, fills the template-driven form, submits a request.
  * Secretary (login) reviews requests for their own barangay, then approves
    ("admits") and issues the certificate, or rejects it with notes.
  * Every action is written to an audit log; issued certificates are filed
    on disk as PDF only (the DOCX is a temporary rendering intermediate and
    is never retained) and listed in the searchable archive. PDF files are
    automatically deleted after 30 days; database records, reports and the
    audit trail are retained permanently.
"""
import datetime
import io
import json
import os
import re
import secrets
import shutil
import sqlite3
import tempfile
import threading
import time
import zipfile
from functools import wraps

from flask import (Flask, Response, g, jsonify, request, send_file, session,
                   send_from_directory)
from werkzeug.security import check_password_hash, generate_password_hash

import db
import db_id
import docgen

try:
    import idgen
except Exception:  # qrcode / Pillow not installed
    idgen = None

from flask_sock import Sock

app = Flask(__name__, static_folder="static", static_url_path="/static")
sock = Sock(app)

# Persistent session secret so restarts keep people logged in.
_secret_file = os.path.join(db.INSTANCE_DIR, "secret_key")
if not os.path.exists(_secret_file):
    with open(_secret_file, "wb") as f:
        f.write(secrets.token_bytes(32))
with open(_secret_file, "rb") as f:
    app.secret_key = f.read()

# Upload cap. Individual endpoints validate their own files; the cap is
# generous because admin backup-restore uploads can be large.
app.config["MAX_CONTENT_LENGTH"] = 250 * 1024 * 1024

MAX_CERTS_PER_REQUEST = 10  # how many certificates one farmer request may cover


# --------------------------------------------------------------------------- #
# Database / auth plumbing
# --------------------------------------------------------------------------- #
@app.before_request
def _open_db():
    g.db = db.connect()


@app.teardown_request
def _close_db(exc):
    conn = g.pop("db", None)
    if conn is not None:
        conn.close()


@app.before_request
def _load_user():
    g.user = None
    uid = session.get("user_id")
    if uid:
        row = g.db.execute(
            "SELECT u.*, b.name AS barangay_name FROM users u "
            "LEFT JOIN barangays b ON b.id = u.barangay_id "
            "WHERE u.id = ? AND u.active = 1",
            (uid,),
        ).fetchone()
        if row:
            g.user = row
            try:
                g.db.execute("UPDATE users SET last_active_at = ? WHERE id = ?",
                             (db.now_iso(), uid))
                g.db.commit()
            except Exception:
                pass


def login_required(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        if g.user is None:
            return jsonify(error="Authentication required."), 401
        return fn(*args, **kwargs)
    return wrapper


def admin_required(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        if g.user is None:
            return jsonify(error="Authentication required."), 401
        if g.user["role"] != "admin":
            return jsonify(error="Administrator access required."), 403
        return fn(*args, **kwargs)
    return wrapper


def _err(msg, code=400):
    return jsonify(error=msg), code


def _audit(action, detail="", barangay_id=None, actor=None, role=None):
    """Write an audit entry using the current user (or supplied override)."""
    if actor is None:
        actor = g.user["username"] if g.user else "guest"
    if role is None:
        role = g.user["role"] if g.user else "farmer-guest"
    db.log_audit(g.db, actor, role, action, detail, barangay_id)


def _me_payload():
    if g.user is None:
        return None
    keys = g.user.keys() if hasattr(g.user, "keys") else []
    return {
        "id": g.user["id"],
        "username": g.user["username"],
        "full_name": g.user["full_name"],
        "role": g.user["role"],
        "barangay": g.user["barangay_name"],
        "barangay_id": g.user["barangay_id"],
        "must_change_password": bool(g.user["must_change_password"]) if "must_change_password" in keys else False,
    }


def _load_template(tid):
    return g.db.execute("SELECT * FROM templates WHERE id = ?", (tid,)).fetchone()


def _fields_of(tpl):
    return json.loads(tpl["fields_json"])


def _farmer_fields(tpl):
    """Questions shown to farmers: non-system fields, in template order."""
    return [
        f for f in _fields_of(tpl)
        if not f.get("system") and f.get("key") not in docgen.SYSTEM_PLACEHOLDER_KEYS
    ]


def _normalize_civil_status(value):
    """Normalize Civil Status to the standard ALL-CAPS dropdown values."""
    return db_id.normalize_civil_status(value)


def _farmer_name_keys(fields):
    """Field keys that carry the Farmer's Name in a template."""
    exact = [f["key"] for f in fields
             if f["key"].upper() in ("FARMER_NAME", "FULL_NAME", "NAME")]
    if exact:
        return set(exact)
    return {f["key"] for f in fields if "NAME" in f["key"].upper()}


def _is_rsbsa_field_key(key: str) -> bool:
    ku = (key or "").upper()
    return "RSBSA" in ku and ("NUM" in ku or ku.endswith("NO") or ku == "RSBSA")


def _is_valid_farm_area(val: str) -> bool:
    """Farm Area (Ha) must be a non-negative numerical value (e.g. 0.2526)."""
    s = str(val or "").strip()
    if not re.match(r"^\d+(?:\.\d+)?$", s):
        return False
    try:
        return float(s) >= 0
    except ValueError:
        return False


def _validate_entry_data(tpl, raw, tag="", mode="template",
                         default_parcel_location=""):
    """Validate + normalize ONE certificate entry against a template.

    Standardizes every text/textarea value to UPPERCASE so that all issued
    certificates follow one format. Returns (cleaned, errors).

    Validation modes:
      * ``guest``    -- farmer/guest submissions: only the Farmer's Name is
                        required (Barangay is required at request level);
                        every other input is optional.
      * ``strict``   -- secretary/staff processing: every farmer input must
                        be filled before corrections are saved or a
                        certificate is issued.
      * ``template`` -- the template's own required flags (legacy default).
    """
    raw = dict(raw or {})
    if default_parcel_location and not str(raw.get("PARCEL_LOCATION", "")).strip():
        raw["PARCEL_LOCATION"] = str(default_parcel_location).strip().upper()
    fields = _farmer_fields(tpl)
    name_keys = _farmer_name_keys(fields)
    cleaned, errors = {}, []
    for f in fields:
        key = f["key"]
        ku = key.upper()
        label = "Farm Area (Ha)" if ku == "FARM_AREA" else f["label"]
        val = str(raw.get(key, "")).strip()
        if mode == "strict" and not val:
            errors.append(f"{tag}{label} is required.")
        elif mode == "guest" and key in name_keys and not val:
            errors.append(f"{tag}{label} is required.")
        elif mode not in ("guest", "strict") and f.get("required") and not val:
            errors.append(f"{tag}{label} is required.")
        if ku == "FARM_AREA" and val:
            if not _is_valid_farm_area(val):
                errors.append(
                    f"{tag}Farm Area (Ha) must be a numerical value (e.g. 0.2526)."
                )
        elif f.get("type") == "number" and val and not _is_rsbsa_field_key(key):
            try:
                float(val)
            except ValueError:
                errors.append(f"{tag}{label} must be a number.")
        if val and (f.get("type") in ("text", "textarea") or _is_rsbsa_field_key(key)):
            val = val.upper()          # standardize to caps (including alphanumeric RSBSA)
        if val and ku == "CIVIL_STATUS":
            val = _normalize_civil_status(val)
        elif val and ku in ("GENDER", "SEX", "KASARIAN"):
            val = db_id.normalize_gender(val)
        if val:
            cleaned[key] = val
    # Parcel fields are collected for every entry even if an older template
    # does not define them yet. Staff must also fill these in strict mode.
    field_keys = {f["key"] for f in fields}
    for key, label in (("PARCEL_LOCATION", "Parcel Location"),
                       ("FARM_AREA", "Farm Area (Ha)")):
        val = str(raw.get(key, "")).strip()
        if key == "FARM_AREA" and val and key not in field_keys:
            if not _is_valid_farm_area(val):
                errors.append(
                    f"{tag}Farm Area (Ha) must be a numerical value (e.g. 0.2526)."
                )
        if val and key not in cleaned:
            cleaned[key] = val if key == "FARM_AREA" else val.upper()
        elif mode == "strict" and key not in field_keys and not val:
            errors.append(f"{tag}{label} is required.")
    return cleaned, errors


def _validate_entries(tpl, raw_entries, mode="template",
                      default_parcel_location=""):
    """Validate a list of entries that all share one template."""
    if not isinstance(raw_entries, list) or not raw_entries:
        return None, ["No certificate details were provided."]
    if len(raw_entries) > MAX_CERTS_PER_REQUEST:
        return None, [f"A maximum of {MAX_CERTS_PER_REQUEST} certificates "
                      f"may be requested at once."]
    multi = len(raw_entries) > 1
    cleaned_list, errors = [], []
    for idx, raw in enumerate(raw_entries):
        cleaned, errs = _validate_entry_data(
            tpl, raw, f"Entry {idx + 1}: " if multi else "", mode=mode,
            default_parcel_location=default_parcel_location)
        cleaned_list.append(cleaned)
        errors += errs
    if errors:
        return None, errors
    return cleaned_list, []


def _validate_mixed_entries(raw_entries, default_template_id=None,
                            template_ids=None, mode="template",
                            default_parcel_location=""):
    """Validate entries where EACH entry chooses its own certification type.

    Accepts [{"template_id": n, "data": {...}}] and legacy flat dicts (which
    fall back to default_template_id). When template_ids is given (secretary
    rectification), those types are kept and cannot be changed.
    Returns (wrapped_entries, template_ids, errors) where wrapped entries
    are stored as {"template_id": n, "data": {...}}.
    """
    if not isinstance(raw_entries, list) or not raw_entries:
        return None, None, ["No certificate details were provided."]
    if len(raw_entries) > MAX_CERTS_PER_REQUEST:
        return None, None, [f"A maximum of {MAX_CERTS_PER_REQUEST} "
                            f"certificates may be requested at once."]
    multi = len(raw_entries) > 1
    wrapped, tpl_ids, errors = [], [], []
    for idx, raw in enumerate(raw_entries):
        raw = raw or {}
        data_raw = raw.get("data") if isinstance(raw.get("data"), dict) else raw
        if template_ids is not None:
            tid = (template_ids[idx] if idx < len(template_ids)
                   else default_template_id)
        else:
            tid = raw.get("template_id") or default_template_id
        try:
            tid = int(tid)
        except (TypeError, ValueError):
            tid = None
        tpl = _load_template(tid) if tid else None
        if tpl is None or not tpl["active"]:
            errors.append(f"Entry {idx + 1}: Please choose a valid "
                          f"certification type.")
            wrapped.append({"template_id": tid, "data": {}})
            tpl_ids.append(tid)
            continue
        cleaned, errs = _validate_entry_data(
            tpl, data_raw, f"Entry {idx + 1}: " if multi else "", mode=mode,
            default_parcel_location=default_parcel_location)
        errors += errs
        wrapped.append({"template_id": tpl["id"], "data": cleaned})
        tpl_ids.append(tpl["id"])
    if errors:
        return None, None, errors
    return wrapped, tpl_ids, []


def _farmer_name_of(fields, data):
    for key in ("FARMER_NAME", "FULL_NAME", "NAME"):
        if data.get(key):
            return data[key]
    for f in fields:
        if not f.get("system") and "NAME" in f["key"] and data.get(f["key"]):
            return data[f["key"]]
    return ""


def _safe_file_token(value, fallback="NA") -> str:
    text = re.sub(r'[\\/:*?"<>|\r\n\t]+', "", str(value or "").strip())
    text = re.sub(r"\s+", "_", text)
    return text or fallback


def _rsbsa_of_entry(data: dict) -> str:
    if not isinstance(data, dict):
        return ""
    for k in ("RSBSA_NUMBER", "RSBSA_NO", "RSBSA"):
        if data.get(k):
            return str(data[k]).strip()
    for k, v in data.items():
        if "RSBSA" in str(k).upper() and v:
            return str(v).strip()
    return ""


def _cert_pdf_filename(farmer_name, rsbsa_number, entry_no=1) -> str:
    """Format: Name_RSBSANumber_EntryNumber.pdf"""
    name_part = _safe_file_token(farmer_name, "FARMER")
    rsbsa_part = _safe_file_token(rsbsa_number, "NO-RSBSA")
    return f"{name_part}_{rsbsa_part}_{int(entry_no or 1)}.pdf"


def _cert_download_filename(cert_row) -> str:
    try:
        data = json.loads(cert_row["data_json"] or "{}")
    except Exception:
        data = {}
    sibling_ids = [r["id"] for r in g.db.execute(
        "SELECT id FROM certificates WHERE request_id = ? ORDER BY id",
        (cert_row["request_id"],)).fetchall()]
    try:
        idx = sibling_ids.index(cert_row["id"])
    except ValueError:
        idx = 0
    if not data:
        req = g.db.execute("SELECT data_json FROM requests WHERE id = ?",
                           (cert_row["request_id"],)).fetchone()
        if req:
            entries = db.entries_of(req["data_json"])
            if idx < len(entries):
                data = entries[idx]
    entry_no = data.get("_ENTRY_NO") or (idx + 1)
    farmer_name = (cert_row["farmer_name"]
                   or data.get("FARMER_NAME")
                   or data.get("FULL_NAME")
                   or data.get("NAME")
                   or "FARMER")
    rsbsa_val = _rsbsa_of_entry(data)
    return _cert_pdf_filename(farmer_name, rsbsa_val, entry_no)


# --------------------------------------------------------------------------- #
# PDF retention: files expire after 30 days; records are never deleted
# --------------------------------------------------------------------------- #
PDF_RETENTION_DAYS = 30
_retention_lock = threading.Lock()
_retention_thread = None


def _parse_iso(value):
    if not value:
        return None
    try:
        dt = datetime.datetime.fromisoformat(str(value))
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=datetime.timezone(
            datetime.timedelta(hours=8)))
    return dt


def _pdf_expires_at(basis):
    parsed = _parse_iso(basis)
    if parsed is None:
        return None
    expires = parsed + datetime.timedelta(days=PDF_RETENTION_DAYS)
    return expires.isoformat(timespec="seconds")


def _cert_pdf_state(row):
    """(basis_iso, expires_iso, available) for a certificates row."""
    basis = row["pdf_file_created_at"] or row["generated_at"]
    available = bool(
        row["pdf_path"] and not row["pdf_purged_at"] and
        os.path.exists(os.path.join(db.BASE_DIR, row["pdf_path"])))
    return basis, _pdf_expires_at(basis), available


def purge_expired_pdfs():
    """Delete expired certificate PDF files (and any stray DOCX copies).

    Runs on startup and then daily. Only FILES are removed: certificate
    rows, request/farmer records, reports data and audit entries are never
    deleted. Every file removal is itself written to the audit trail.
    Returns the number of PDFs purged.
    """
    if not _retention_lock.acquire(blocking=False):
        return 0
    try:
        conn = db.connect()
        try:
            now_dt = datetime.datetime.now(datetime.timezone(
                datetime.timedelta(hours=8)))
            now = db.now_iso()
            rows = conn.execute("SELECT * FROM certificates").fetchall()
            cert_by_no = {r["cert_no"]: r for r in rows}

            # PDF-only filing: sweep any DOCX copies left in the filings
            # folders (templates in instance/templates are NOT touched).
            docx_removed = 0
            for root, _dirs, files in os.walk(db.FILINGS_DIR):
                for name in files:
                    if not name.lower().endswith(".docx"):
                        continue
                    try:
                        os.remove(os.path.join(root, name))
                        docx_removed += 1
                    except OSError:
                        continue
                    cert = cert_by_no.get(os.path.splitext(name)[0])
                    if cert is not None:
                        db.log_audit(
                            conn, "system", "system",
                            "certificate.docx_remove",
                            f"{cert['cert_no']} DOCX copy removed — "
                            "PDF-only retention (database record retained)",
                            cert["barangay_id"])
            if docx_removed:
                conn.execute(
                    "UPDATE certificates SET docx_path = NULL "
                    "WHERE docx_path IS NOT NULL")

            purged = 0
            for r in rows:
                if not r["pdf_path"] or r["pdf_purged_at"]:
                    continue
                basis, _expires, _avail = _cert_pdf_state(r)
                basis_dt = _parse_iso(basis)
                if basis_dt is None:
                    continue
                if now_dt < basis_dt + datetime.timedelta(
                        days=PDF_RETENTION_DAYS):
                    continue
                path = os.path.join(db.BASE_DIR, r["pdf_path"])
                try:
                    if os.path.exists(path):
                        os.remove(path)
                except OSError:
                    pass
                conn.execute(
                    "UPDATE certificates SET pdf_path = NULL, "
                    "pdf_purged_at = ? WHERE id = ?", (now, r["id"]))
                db.log_audit(
                    conn, "system", "system", "certificate.pdf_purge",
                    f"{r['cert_no']} PDF auto-deleted after "
                    f"{PDF_RETENTION_DAYS}-day retention (PDF created "
                    f"{basis}); certificate, audit and report records "
                    "retained — no database record deleted",
                    r["barangay_id"])
                purged += 1
            conn.commit()
            if docx_removed or purged:
                print(f"[retention] removed {docx_removed} DOCX file(s); "
                      f"purged {purged} expired PDF file(s) "
                      "(database records retained)")
            return purged
        finally:
            conn.close()
    finally:
        _retention_lock.release()


def _retention_worker():
    while True:
        time.sleep(24 * 60 * 60)
        try:
            purge_expired_pdfs()
        except Exception as exc:  # noqa: BLE001
            print(f"[retention] purge failed: {exc}")


def start_retention_scheduler():
    global _retention_thread
    if _retention_thread is not None and _retention_thread.is_alive():
        return _retention_thread
    _retention_thread = threading.Thread(
        target=_retention_worker, name="pdf-retention", daemon=True)
    _retention_thread.start()
    return _retention_thread


# --------------------------------------------------------------------------- #
# Static front-end
# --------------------------------------------------------------------------- #
@app.get("/")
def index():
    return send_from_directory(app.static_folder, "index.html")


@app.get("/sw.js")
def service_worker():
    """Service worker must be served from the root to control the app."""
    resp = send_from_directory(app.static_folder, "sw.js")
    resp.headers["Service-Worker-Allowed"] = "/"
    resp.headers["Cache-Control"] = "no-cache"
    return resp


# --------------------------------------------------------------------------- #
# First-run setup
# --------------------------------------------------------------------------- #
@app.get("/api/setup/status")
def setup_status():
    return jsonify(needs_setup=not db.has_admin(g.db))


@app.post("/api/setup")
def setup():
    if db.has_admin(g.db):
        return _err("Setup has already been completed.", 409)
    body = request.get_json(silent=True) or {}
    username = (body.get("username") or "").strip()
    password = body.get("password") or ""
    full_name = (body.get("full_name") or "").strip()
    if not username or not password or not full_name:
        return _err("Username, password and full name are required.")
    if len(password) < 6:
        return _err("Password must be at least 6 characters.")
    barangays = body.get("barangays") or []
    if isinstance(barangays, str):
        barangays = [x for x in barangays.split("\n") if x.strip()]
    admin_id = db.create_admin(
        g.db, username, password, full_name,
        municipality=body.get("municipality", ""),
        province=body.get("province", ""),
        barangay_names=barangays,
    )
    g.db.execute("INSERT OR IGNORE INTO settings (key, value) VALUES ('cert_prefix', 'RSBSA')")
    g.db.commit()
    _seed_sample_template(actor_id=admin_id)
    session.clear()
    session["user_id"] = admin_id
    g.user = g.db.execute(
        "SELECT u.*, NULL AS barangay_name FROM users u WHERE u.id = ?", (admin_id,)
    ).fetchone()
    _audit("setup.complete", "Initial administrator account created")
    g.db.commit()
    return jsonify(ok=True)


def _seed_sample_template(actor_id=None):
    """Create the built-in sample template if none exist yet."""
    count = g.db.execute("SELECT COUNT(*) AS c FROM templates").fetchone()["c"]
    if count:
        return
    docgen.ensure_sample_template(db.SAMPLE_TEMPLATE_PATH)
    fields = docgen.build_fields_config(db.SAMPLE_TEMPLATE_PATH)
    g.db.execute(
        "INSERT INTO templates (name, filename, fields_json, uploaded_by, created_at) "
        "VALUES (?, ?, ?, ?, ?)",
        ("RSBSA Certification (Sample)",
         os.path.basename(db.SAMPLE_TEMPLATE_PATH),
         json.dumps(fields), actor_id, db.now_iso()),
    )
    g.db.commit()


# --------------------------------------------------------------------------- #
# Auth
# --------------------------------------------------------------------------- #
@app.post("/api/auth/login")
def login():
    body = request.get_json(silent=True) or {}
    username = (body.get("username") or "").strip()
    password = body.get("password") or ""
    user = g.db.execute(
        "SELECT * FROM users WHERE LOWER(username) = LOWER(?)", (username,)
    ).fetchone()
    if user is None or not user["active"] or not check_password_hash(
        user["password_hash"], password
    ):
        _audit("login.failed", f"Failed login attempt for '{username}'",
               actor=username or "unknown", role="anonymous")
        g.db.commit()
        return _err("Invalid username or password.", 401)
    session.clear()
    session["user_id"] = user["id"]
    g.user = g.db.execute(
        "SELECT u.*, b.name AS barangay_name FROM users u "
        "LEFT JOIN barangays b ON b.id = u.barangay_id WHERE u.id = ?",
        (user["id"],),
    ).fetchone()
    _audit("login", f"{user['full_name']} signed in",
           barangay_id=user["barangay_id"])
    g.db.commit()
    return jsonify(me=_me_payload())


@app.post("/api/auth/logout")
def logout():
    if g.user is not None:
        _audit("logout", f"{g.user['full_name']} signed out",
               barangay_id=g.user["barangay_id"])
        g.db.commit()
    session.clear()
    return jsonify(ok=True)


@app.get("/api/auth/me")
def auth_me():
    return jsonify(me=_me_payload(), needs_setup=not db.has_admin(g.db))


@app.post("/api/auth/change-password")
@login_required
def change_password():
    body = request.get_json(silent=True) or {}
    curr = (body.get("current_password") or "").strip()
    new_pwd = (body.get("new_password") or "").strip()
    if not new_pwd or len(new_pwd) < 6:
        return _err("New password must be at least 6 characters.")
    user = g.db.execute("SELECT * FROM users WHERE id = ?", (g.user["id"],)).fetchone()
    if user is None:
        return _err("User not found.", 404)
    must_change = bool(user["must_change_password"]) if "must_change_password" in user.keys() else False
    if not must_change or curr:
        if not check_password_hash(user["password_hash"], curr):
            return _err("Incorrect current password.", 400)
    g.db.execute("UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?",
                 (generate_password_hash(new_pwd), g.user["id"]))
    _audit("auth.change_password", f"{g.user['full_name']} changed their password")
    g.db.commit()
    return jsonify(ok=True)


@app.post("/api/heartbeat")
@login_required
def heartbeat():
    now = db.now_iso()
    try:
        g.db.execute("UPDATE users SET last_active_at = ? WHERE id = ?",
                     (now, g.user["id"]))
        g.db.commit()
    except Exception:
        pass
    unread_cnt = g.db.execute(
        "SELECT COUNT(*) FROM messages "
        "WHERE (recipient_id = ? OR (is_broadcast = 1 AND sender_id != ?)) "
        "AND read_at IS NULL",
        (g.user["id"], g.user["id"])
    ).fetchone()[0]
    return jsonify(ok=True, unread_messages=unread_cnt)


@app.get("/api/admin/active-secretaries")
@admin_required
def get_active_secretaries():
    rows = g.db.execute(
        "SELECT u.id, u.username, u.full_name, u.role, u.barangay_id, u.last_active_at, "
        "b.name AS barangay_name "
        "FROM users u "
        "LEFT JOIN barangays b ON b.id = u.barangay_id "
        "WHERE u.role = 'secretary' AND u.active = 1 "
        "ORDER BY u.full_name ASC"
    ).fetchall()
    now_dt = datetime.datetime.fromisoformat(db.now_iso())
    result = []
    for r in rows:
        is_online = False
        last_str = r["last_active_at"]
        if last_str:
            try:
                la_dt = datetime.datetime.fromisoformat(last_str)
                if (now_dt - la_dt).total_seconds() < 300:  # 5 minutes
                    is_online = True
            except Exception:
                pass
        result.append({
            "id": r["id"],
            "username": r["username"],
            "full_name": r["full_name"],
            "barangay": r["barangay_name"] or "—",
            "barangay_id": r["barangay_id"],
            "last_active_at": last_str,
            "is_online": is_online,
        })
    return jsonify(secretaries=result)


@app.get("/api/messages")
@login_required
def get_messages():
    partner_id = request.args.get("partner_id")
    group = request.args.get("group")
    broadcast_only = request.args.get("broadcast_only") == "1"
    direct_only = request.args.get("direct_only") == "1"

    if group == "1" or broadcast_only:
        rows = g.db.execute(
            "SELECT m.*, u.full_name AS sender_name, u.role AS sender_role "
            "FROM messages m "
            "JOIN users u ON u.id = m.sender_id "
            "WHERE m.is_broadcast = 1 "
            "ORDER BY m.id ASC LIMIT 200"
        ).fetchall()
        return jsonify(messages=[dict(r) for r in rows])

    if g.user["role"] == "secretary":
        admin_user = g.db.execute("SELECT id FROM users WHERE role = 'admin' LIMIT 1").fetchone()
        admin_id = admin_user["id"] if admin_user else None
        if direct_only:
            where_clause = "((m.sender_id = ? AND m.recipient_id = ?) OR (m.sender_id = ? AND m.recipient_id = ?)) AND m.is_broadcast = 0"
        else:
            where_clause = "(((m.sender_id = ? AND m.recipient_id = ?) OR (m.sender_id = ? AND m.recipient_id = ?)) OR m.is_broadcast = 1)"
        rows = g.db.execute(
            f"SELECT m.*, u.full_name AS sender_name, u.role AS sender_role "
            f"FROM messages m "
            f"JOIN users u ON u.id = m.sender_id "
            f"WHERE {where_clause} "
            f"ORDER BY m.id ASC LIMIT 200",
            (g.user["id"], admin_id, admin_id, g.user["id"])
        ).fetchall()
        return jsonify(messages=[dict(r) for r in rows], partner_id=admin_id)
    else:
        if partner_id:
            rows = g.db.execute(
                "SELECT m.*, u.full_name AS sender_name, u.role AS sender_role "
                "FROM messages m "
                "JOIN users u ON u.id = m.sender_id "
                "WHERE ((m.sender_id = ? AND m.recipient_id = ?) "
                "    OR (m.sender_id = ? AND m.recipient_id = ?)) "
                "  AND m.is_broadcast = 0 "
                "ORDER BY m.id ASC LIMIT 200",
                (g.user["id"], partner_id, partner_id, g.user["id"])
            ).fetchall()
            return jsonify(messages=[dict(r) for r in rows], partner_id=int(partner_id))
        else:
            secs = g.db.execute(
                "SELECT u.id, u.username, u.full_name, u.last_active_at, b.name AS barangay_name, "
                "(SELECT COUNT(*) FROM messages m WHERE m.sender_id = u.id AND m.recipient_id = ? AND m.read_at IS NULL) AS unread, "
                "(SELECT m.message FROM messages m WHERE (m.sender_id = u.id AND m.recipient_id = ?) OR (m.sender_id = ? AND m.recipient_id = u.id) ORDER BY m.id DESC LIMIT 1) AS last_message, "
                "(SELECT m.sent_at FROM messages m WHERE (m.sender_id = u.id AND m.recipient_id = ?) OR (m.sender_id = ? AND m.recipient_id = u.id) ORDER BY m.id DESC LIMIT 1) AS last_sent_at "
                "FROM users u "
                "LEFT JOIN barangays b ON b.id = u.barangay_id "
                "WHERE u.role = 'secretary' AND u.active = 1 "
                "ORDER BY unread DESC, last_sent_at DESC, u.full_name ASC",
                (g.user["id"], g.user["id"], g.user["id"], g.user["id"], g.user["id"])
            ).fetchall()
            broadcast_unread = g.db.execute(
                "SELECT COUNT(*) FROM messages WHERE is_broadcast = 1 AND sender_id != ? AND read_at IS NULL",
                (g.user["id"],)
            ).fetchone()[0]
            now_dt = datetime.datetime.fromisoformat(db.now_iso())
            threads = []
            for s in secs:
                d = dict(s)
                is_online = False
                if d.get("last_active_at"):
                    try:
                        la_dt = datetime.datetime.fromisoformat(d["last_active_at"])
                        if (now_dt - la_dt).total_seconds() < 300:
                            is_online = True
                    except Exception:
                        pass
                d["is_online"] = is_online
                threads.append(d)
            return jsonify(threads=threads, broadcast_unread=broadcast_unread)


@app.post("/api/messages")
@login_required
def send_message():
    body = request.get_json(silent=True) or {}
    msg = (body.get("message") or body.get("content") or "").strip()
    if not msg:
        return _err("Message cannot be empty.")
    is_broadcast = bool(body.get("is_broadcast", False))
    now = db.now_iso()
    if is_broadcast:
        if g.user["role"] != "admin":
            return _err("Only administrators can send group/broadcast messages.", 403)
        cur = g.db.execute(
            "INSERT INTO messages (sender_id, recipient_id, message, sent_at, is_broadcast) "
            "VALUES (?, NULL, ?, ?, 1)",
            (g.user["id"], msg, now)
        )
        mid = cur.lastrowid
        g.db.commit()
        _ws_broadcast({
            "type": "new_message",
            "message": {
                "id": mid,
                "sender_id": g.user["id"],
                "sender_name": g.user["full_name"],
                "sender_role": g.user["role"],
                "recipient_id": None,
                "message": msg,
                "sent_at": now,
                "is_broadcast": 1
            }
        })
        return jsonify(ok=True, id=mid, sent_at=now, is_broadcast=True)

    if g.user["role"] == "secretary":
        admin_user = g.db.execute("SELECT id FROM users WHERE role = 'admin' LIMIT 1").fetchone()
        if not admin_user:
            return _err("Administrator account not found.", 404)
        recipient_id = admin_user["id"]
    else:
        recipient_id = body.get("recipient_id")
        if not recipient_id:
            return _err("Recipient is required.")
        try:
            recipient_id = int(recipient_id)
        except (TypeError, ValueError):
            return _err("Invalid recipient.")
    cur = g.db.execute(
        "INSERT INTO messages (sender_id, recipient_id, message, sent_at, is_broadcast) "
        "VALUES (?, ?, ?, ?, 0)",
        (g.user["id"], recipient_id, msg, now)
    )
    mid = cur.lastrowid
    g.db.commit()
    _ws_broadcast({
        "type": "new_message",
        "message": {
            "id": mid,
            "sender_id": g.user["id"],
            "sender_name": g.user["full_name"],
            "sender_role": g.user["role"],
            "recipient_id": recipient_id,
            "message": msg,
            "sent_at": now,
            "is_broadcast": 0
        }
    }, target_user_ids={g.user["id"], recipient_id})
    return jsonify(ok=True, id=mid, sent_at=now, recipient_id=recipient_id)


@app.delete("/api/messages/<int:mid>")
@admin_required
def delete_message(mid):
    msg = g.db.execute("SELECT * FROM messages WHERE id = ?", (mid,)).fetchone()
    if msg is None:
        return _err("Message or announcement not found.", 404)
    g.db.execute("DELETE FROM messages WHERE id = ?", (mid,))
    _audit("announcement.delete", f"Admin deleted announcement #{mid}: '{msg['message'][:60]}'")
    g.db.commit()
    _ws_broadcast({
        "type": "delete_message",
        "message_id": mid
    })
    return jsonify(ok=True, id=mid)


@app.post("/api/messages/mark-read")
@login_required
def mark_messages_read():
    body = request.get_json(silent=True) or {}
    message_ids = body.get("message_ids")
    partner_id = body.get("partner_id")
    is_broadcast = bool(body.get("is_broadcast", False))
    now = db.now_iso()
    uid = g.user["id"]

    if isinstance(message_ids, list) and message_ids:
        for mid in message_ids:
            try:
                mid_int = int(mid)
                g.db.execute(
                    "INSERT OR IGNORE INTO message_reads (message_id, user_id, read_at) VALUES (?, ?, ?)",
                    (mid_int, uid, now)
                )
                # Also set legacy read_at if direct recipient
                g.db.execute(
                    "UPDATE messages SET read_at = ? WHERE id = ? AND recipient_id = ? AND read_at IS NULL",
                    (now, mid_int, uid)
                )
            except (ValueError, TypeError):
                pass
    elif is_broadcast:
        # Mark all broadcast announcements as read for this user
        bc_rows = g.db.execute("SELECT id FROM messages WHERE is_broadcast = 1 AND sender_id != ?", (uid,)).fetchall()
        for r in bc_rows:
            g.db.execute(
                "INSERT OR IGNORE INTO message_reads (message_id, user_id, read_at) VALUES (?, ?, ?)",
                (r["id"], uid, now)
            )
    elif partner_id:
        partner_msgs = g.db.execute(
            "SELECT id FROM messages WHERE sender_id = ? AND recipient_id = ?",
            (partner_id, uid)
        ).fetchall()
        for r in partner_msgs:
            g.db.execute(
                "INSERT OR IGNORE INTO message_reads (message_id, user_id, read_at) VALUES (?, ?, ?)",
                (r["id"], uid, now)
            )
        g.db.execute(
            "UPDATE messages SET read_at = ? WHERE sender_id = ? AND recipient_id = ? AND read_at IS NULL",
            (now, partner_id, uid)
        )
    else:
        # Mark all messages addressed to or broadcast to this user
        all_msgs = g.db.execute(
            "SELECT id FROM messages WHERE (recipient_id = ? OR (is_broadcast = 1 AND sender_id != ?))",
            (uid, uid)
        ).fetchall()
        for r in all_msgs:
            g.db.execute(
                "INSERT OR IGNORE INTO message_reads (message_id, user_id, read_at) VALUES (?, ?, ?)",
                (r["id"], uid, now)
            )
        g.db.execute(
            "UPDATE messages SET read_at = ? WHERE recipient_id = ? AND read_at IS NULL",
            (now, uid)
        )

    g.db.commit()
    _ws_broadcast({
        "type": "messages_read",
        "user_id": uid,
        "partner_id": partner_id
    }, target_user_ids=({uid, int(partner_id)} if partner_id else None))
    return jsonify(ok=True)


@app.get("/api/messages/unread-count")
@login_required
def unread_messages_count():
    uid = g.user["id"]
    # Direct messages sent to user that have not been read (checked via message_reads or read_at)
    direct_unread = g.db.execute(
        "SELECT COUNT(*) FROM messages m "
        "LEFT JOIN message_reads mr ON mr.message_id = m.id AND mr.user_id = ? "
        "WHERE m.recipient_id = ? AND m.is_broadcast = 0 "
        "AND mr.read_at IS NULL AND m.read_at IS NULL",
        (uid, uid)
    ).fetchone()[0]

    # Broadcast announcements sent by someone else that this user has not read yet
    broadcast_unread = g.db.execute(
        "SELECT COUNT(*) FROM messages m "
        "LEFT JOIN message_reads mr ON mr.message_id = m.id AND mr.user_id = ? "
        "WHERE m.is_broadcast = 1 AND m.sender_id != ? "
        "AND mr.read_at IS NULL",
        (uid, uid)
    ).fetchone()[0]

    cnt = direct_unread + broadcast_unread
    return jsonify(unread=cnt, direct_unread=direct_unread, broadcast_unread=broadcast_unread)


# --------------------------------------------------------------------------- #
# WebSocket Chat & Presence Hub
# --------------------------------------------------------------------------- #
_ws_clients_lock = threading.Lock()
# map ws -> user_dict {id, username, full_name, role, barangay_name, barangay_id}
_ws_clients = {}

def _ws_broadcast(payload_dict, target_user_ids=None):
    """Safely send a JSON message to connected WebSocket clients."""
    data = json.dumps(payload_dict)
    with _ws_clients_lock:
        clients_snapshot = list(_ws_clients.items())
    for ws, u in clients_snapshot:
        if target_user_ids is not None and u["id"] not in target_user_ids:
            continue
        try:
            ws.send(data)
        except Exception:
            pass

def _ws_get_online_user_ids():
    with _ws_clients_lock:
        return sorted(list({u["id"] for u in _ws_clients.values()}))

def _ws_broadcast_presence():
    online_ids = _ws_get_online_user_ids()
    _ws_broadcast({
        "type": "presence",
        "online_user_ids": online_ids,
        "timestamp": db.now_iso()
    })

@sock.route("/ws/chat")
def ws_chat_socket(ws):
    uid = session.get("user_id")
    if not uid:
        try:
            ws.send(json.dumps({"type": "error", "message": "Unauthorized"}))
            ws.close()
        except Exception:
            pass
        return

    conn = db.connect()
    try:
        user_row = conn.execute(
            "SELECT u.id, u.username, u.full_name, u.role, u.barangay_id, b.name AS barangay_name "
            "FROM users u LEFT JOIN barangays b ON b.id = u.barangay_id "
            "WHERE u.id = ? AND u.active = 1", (uid,)
        ).fetchone()
    finally:
        conn.close()

    if not user_row:
        try:
            ws.close()
        except Exception:
            pass
        return

    u_info = {
        "id": user_row["id"],
        "username": user_row["username"],
        "full_name": user_row["full_name"],
        "role": user_row["role"],
        "barangay_id": user_row["barangay_id"],
        "barangay_name": user_row["barangay_name"] or "",
    }

    with _ws_clients_lock:
        _ws_clients[ws] = u_info

    # Send initial connected message with current presence
    try:
        ws.send(json.dumps({
            "type": "connected",
            "me": u_info,
            "online_user_ids": _ws_get_online_user_ids(),
            "timestamp": db.now_iso()
        }))
    except Exception:
        pass

    _ws_broadcast_presence()

    try:
        while True:
            raw = ws.receive()
            if raw is None:
                break
            try:
                pkt = json.loads(raw)
            except Exception:
                continue

            ptype = pkt.get("type")
            if ptype == "ping":
                try:
                    ws.send(json.dumps({"type": "pong", "timestamp": db.now_iso()}))
                except Exception:
                    pass
            elif ptype == "typing":
                # Forward typing status to relevant peer
                target_id = pkt.get("recipient_id")
                is_bc = bool(pkt.get("is_broadcast", False))
                targets = None
                if not is_bc and target_id:
                    targets = {int(target_id)}
                _ws_broadcast({
                    "type": "typing",
                    "sender_id": u_info["id"],
                    "sender_name": u_info["full_name"],
                    "is_broadcast": is_bc,
                    "recipient_id": target_id
                }, target_user_ids=targets)
            elif ptype == "get_presence":
                try:
                    ws.send(json.dumps({
                        "type": "presence",
                        "online_user_ids": _ws_get_online_user_ids(),
                        "timestamp": db.now_iso()
                    }))
                except Exception:
                    pass
    except Exception:
        pass
    finally:
        with _ws_clients_lock:
            _ws_clients.pop(ws, None)
        _ws_broadcast_presence()



# --------------------------------------------------------------------------- #
# Public: barangays, templates, submission, tracking
# --------------------------------------------------------------------------- #
@app.get("/api/barangays")
def list_barangays_public():
    rows = g.db.execute(
        "SELECT id, name FROM barangays WHERE active = 1 ORDER BY name"
    ).fetchall()
    return jsonify([dict(r) for r in rows])


@app.get("/api/public/templates")
def list_templates_public():
    _seed_sample_template()
    rows = g.db.execute(
        "SELECT id, name FROM templates WHERE active = 1 ORDER BY name"
    ).fetchall()
    return jsonify([dict(r) for r in rows])


@app.get("/api/public/templates/<int:tid>/fields")
def template_fields_public(tid):
    tpl = _load_template(tid)
    if tpl is None or not tpl["active"]:
        return _err("Template not found.", 404)
    return jsonify(name=tpl["name"], fields=_farmer_fields(tpl))


@app.post("/api/requests")
def create_request():
    body = request.get_json(silent=True) or {}
    barangay_id = body.get("barangay_id")
    if not barangay_id:
        return _err("Barangay is required.")
    bgy = g.db.execute("SELECT * FROM barangays WHERE id = ? AND active = 1",
                       (barangay_id,)).fetchone()
    if bgy is None:
        return _err("Unknown barangay.")

    # The certification type is chosen PER ENTRY:
    # {"entries": [{"template_id": n, "data": {...}}]}. Legacy payloads with
    # a request-level template_id and flat entry dicts still work.
    raw = body.get("entries")
    if raw is None and isinstance(body.get("data"), dict):
        raw = [body.get("data")]
    validation_mode = ("strict" if g.user and g.user["role"] in
                       ("secretary", "admin") else "guest")
    wrapped, tpl_ids, errors = _validate_mixed_entries(
        raw, body.get("template_id"), mode=validation_mode,
        default_parcel_location=bgy["name"])
    if errors:
        return _err(" ".join(errors))
    entries = [w["data"] for w in wrapped]

    ref_no = db.make_ref_no(g.db)
    cur = g.db.execute(
        "INSERT INTO requests (ref_no, template_id, barangay_id, data_json, "
        "submitted_at, guest_ip) VALUES (?, ?, ?, ?, ?, ?)",
        (ref_no, tpl_ids[0], barangay_id,
         json.dumps({"entries": wrapped}),
         db.now_iso(), request.remote_addr),
    )
    req_id = cur.lastrowid

    # ---- farmer masterlist: build/refresh profiles & detect duplicates ----
    dup_hits, linked = [], set()
    for _eidx, entry in enumerate(entries):
        all_fields = _fields_of(_load_template(tpl_ids[_eidx]))
        rsbsa_key = next(
            (f["key"] for f in all_fields
             if "RSBSA" in f["key"].upper() and
             ("NUM" in f["key"].upper() or f["key"].upper().endswith("NO"))),
            "RSBSA_NUMBER")
        rsbsa = str(entry.get(rsbsa_key, "")).strip()
        name_key = next((k for k in ("FARMER_NAME", "FULL_NAME", "NAME")
                         if entry.get(k)), None)
        if not name_key:
            name_key = next((f["key"] for f in all_fields
                             if not f.get("system") and "NAME" in f["key"]), None)
        name = str(entry.get(name_key, "")).strip() if name_key else ""
        if rsbsa:
            existing = db.find_farmer_by_rsbsa(g.db, rsbsa)
            if (existing and
                    db.normalize_name(existing["name"]) != db.normalize_name(name)):
                dup_hits.append({
                    "rsbsa": rsbsa,
                    "existing_name": existing["name"],
                    "submitted_name": name,
                })
        if name:
            fid, _ = db.upsert_farmer(g.db, rsbsa_number=rsbsa, name=name,
                                      data=entry, barangay_id=barangay_id)
            linked.add(fid)
    if dup_hits:
        g.db.execute("UPDATE requests SET dup_flag = ? WHERE id = ?",
                     (json.dumps(dup_hits), req_id))
    for fid in linked:
        g.db.execute(
            "INSERT OR IGNORE INTO request_farmers (request_id, farmer_id) "
            "VALUES (?, ?)", (req_id, fid))
    g.db.execute("UPDATE requests SET farmers_synced = 1 WHERE id = ?",
                 (req_id,))

    _type_names = []
    for _tid in tpl_ids:
        _t = _load_template(_tid)
        if _t and _t["name"] not in _type_names:
            _type_names.append(_t["name"])
    _audit("request.submit",
           f"{ref_no} submitted for {bgy['name']} ({'; '.join(_type_names)}) — "
           f"{len(entries)} certificate(s)"
           + (f" — {len(dup_hits)} possible duplicate RSBSA number(s)"
              if dup_hits else ""),
           barangay_id=barangay_id)
    g.db.commit()
    return jsonify(ref_no=ref_no, status="pending",
                   count=len(entries), dup_hits=dup_hits), 201


@app.get("/api/requests/track/<ref_no>")
def track_request(ref_no):
    row = g.db.execute(
        "SELECT r.*, b.name AS barangay, t.name AS template "
        "FROM requests r "
        "JOIN barangays b ON b.id = r.barangay_id "
        "JOIN templates t ON t.id = r.template_id "
        "WHERE r.ref_no = ?",
        (ref_no.strip().upper(),),
    ).fetchone()
    if row is None:
        return _err("Reference number not found.", 404)
    cert_nos = [c["cert_no"] for c in g.db.execute(
        "SELECT cert_no FROM certificates WHERE request_id = ? "
        "ORDER BY id", (row["id"],)).fetchall()]
    _tnames = []
    for _tid in db.entry_templates_of(row["data_json"], row["template_id"]):
        _t = _load_template(_tid)
        if _t and _t["name"] not in _tnames:
            _tnames.append(_t["name"])
    template_label = (_tnames[0] if len(_tnames) == 1
                      else f"Mixed certification types ({len(_tnames)})")
    return jsonify(
        ref_no=row["ref_no"],
        status=row["status"],
        submitted_at=row["submitted_at"],
        reviewed_at=row["reviewed_at"],
        notes=row["notes"],
        barangay=row["barangay"],
        template=template_label,
        entry_count=len(db.entries_of(row["data_json"])),
        cert_nos=cert_nos,
    )


# --------------------------------------------------------------------------- #
# Secretary work: queue, review, approve/reject
# --------------------------------------------------------------------------- #
def _scope_barangay_id():
    """Barangay the current user is limited to (None = all, admin only)."""
    if g.user["role"] == "admin":
        return None
    return g.user["barangay_id"]


@app.get("/api/stats")
@login_required
def stats():
    bgy = _scope_barangay_id()
    if bgy is None:
        pending = g.db.execute(
            "SELECT COUNT(*) c FROM requests WHERE status='pending'").fetchone()["c"]
        total = g.db.execute(
            "SELECT COUNT(*) c FROM certificates").fetchone()["c"]
        rejected = g.db.execute(
            "SELECT COUNT(*) c FROM requests WHERE status='rejected'").fetchone()["c"]
        barangays = g.db.execute(
            "SELECT COUNT(*) c FROM barangays WHERE active = 1").fetchone()["c"]
        secretaries = g.db.execute(
            "SELECT COUNT(*) c FROM users WHERE role='secretary' AND active=1").fetchone()["c"]
        return jsonify(pending=pending, certificates=total, rejected=rejected,
                       barangays=barangays, secretaries=secretaries,
                       barangay=None)
    pending = g.db.execute(
        "SELECT COUNT(*) c FROM requests WHERE status='pending' AND barangay_id=?",
        (bgy,)).fetchone()["c"]
    total = g.db.execute(
        "SELECT COUNT(*) c FROM certificates WHERE barangay_id=?",
        (bgy,)).fetchone()["c"]
    rejected = g.db.execute(
        "SELECT COUNT(*) c FROM requests WHERE status='rejected' AND barangay_id=?",
        (bgy,)).fetchone()["c"]
    return jsonify(pending=pending, certificates=total, rejected=rejected,
                   barangay=g.user["barangay_name"])


@app.get("/api/requests/pending")
@login_required
def pending_requests():
    bgy = _scope_barangay_id()
    sql = (
        "SELECT r.id, r.ref_no, r.submitted_at, r.status, b.name AS barangay, "
        "t.name AS template, r.data_json "
        "FROM requests r JOIN barangays b ON b.id = r.barangay_id "
        "JOIN templates t ON t.id = r.template_id "
        "WHERE r.status = 'pending'"
    )
    args = []
    if bgy is not None:
        sql += " AND r.barangay_id = ?"
        args.append(bgy)
    sql += " ORDER BY r.submitted_at ASC"
    rows = g.db.execute(sql, args).fetchall()
    out = []
    for r in rows:
        entries = db.entries_of(r["data_json"])
        first = entries[0] if entries else {}
        subject = first.get("FARMER_NAME") or next(
            (v for k, v in first.items() if "NAME" in k), "—")
        if len(entries) > 1:
            subject = f"{subject} +{len(entries) - 1} more"
        _etids = db.entry_templates_of(r["data_json"])
        out.append({
            "id": r["id"], "ref_no": r["ref_no"],
            "submitted_at": r["submitted_at"], "barangay": r["barangay"],
            "template": ("Mixed types" if len(set(_etids)) > 1
                         else r["template"]),
            "count": len(entries),
            "subject": subject,
        })
    return jsonify(out)


@app.get("/api/requests/<int:rid>")
@login_required
def request_detail(rid):
    row = g.db.execute(
        "SELECT r.*, b.name AS barangay, t.name AS template, "
        "t.fields_json, u.full_name AS reviewer "
        "FROM requests r "
        "JOIN barangays b ON b.id = r.barangay_id "
        "JOIN templates t ON t.id = r.template_id "
        "LEFT JOIN users u ON u.id = r.reviewed_by "
        "WHERE r.id = ?",
        (rid,),
    ).fetchone()
    if row is None:
        return _err("Request not found.", 404)
    if _scope_barangay_id() is not None and row["barangay_id"] != _scope_barangay_id():
        return _err("This request belongs to another barangay.", 403)
    entries = db.entries_of(row["data_json"])
    if row["barangay"]:
        bgy_caps = str(row["barangay"]).strip().upper()
        for _entry in entries:
            if isinstance(_entry, dict) and not str(_entry.get("PARCEL_LOCATION", "")).strip():
                _entry["PARCEL_LOCATION"] = bgy_caps
    new_farmers = [dict(r) for r in g.db.execute(
        "SELECT f.name, f.rsbsa_number FROM request_farmers rf "
        "JOIN farmers f ON f.id = rf.farmer_id "
        "WHERE rf.request_id = ? AND f.verification_status = 'new'",
        (rid,)).fetchall()]
    tpl_ids = db.entry_templates_of(row["data_json"], row["template_id"])
    entry_templates = []
    for _tid in tpl_ids:
        _t = _load_template(_tid)
        entry_templates.append({
            "id": _tid,
            "name": _t["name"] if _t else row["template"],
            "fields": (json.loads(_t["fields_json"]) if _t
                       else json.loads(row["fields_json"])),
        })
    _tnames = []
    for _et in entry_templates:
        if _et["name"] not in _tnames:
            _tnames.append(_et["name"])
    return jsonify(
        id=row["id"], ref_no=row["ref_no"], status=row["status"],
        submitted_at=row["submitted_at"], reviewed_at=row["reviewed_at"],
        notes=row["notes"], reviewer=row["reviewer"],
        barangay=row["barangay"], barangay_id=row["barangay_id"],
        template=row["template"], template_id=row["template_id"],
        template_label=(_tnames[0] if len(_tnames) == 1
                        else f"Mixed certification types ({len(_tnames)})"),
        data=entries[0] if entries else {},
        entries=entries,
        new_farmers=new_farmers,
        entry_templates=entry_templates,
        dup=json.loads(row["dup_flag"]) if row["dup_flag"] else [],
        fields=json.loads(row["fields_json"]),
    )


@app.post("/api/requests/<int:rid>/correct")
@login_required
def correct_request(rid):
    """Secretaries rectify farmer-typed values before issuing.

    Every change is persisted and written to the audit trail.
    """
    req = g.db.execute("SELECT * FROM requests WHERE id = ?", (rid,)).fetchone()
    if req is None:
        return _err("Request not found.", 404)
    if _scope_barangay_id() is not None and req["barangay_id"] != _scope_barangay_id():
        return _err("You may only process requests from your own barangay.", 403)
    if req["status"] != "pending":
        return _err(f"Request is already {req['status']}.", 409)
    body = request.get_json(silent=True) or {}
    # Rectification keeps each entry's original certification type.
    bgy_row = g.db.execute("SELECT name FROM barangays WHERE id = ?",
                           (req["barangay_id"],)).fetchone()
    bgy_default = bgy_row["name"] if bgy_row else ""
    orig_tpl_ids = db.entry_templates_of(req["data_json"], req["template_id"])
    wrapped, _ctids, errors = _validate_mixed_entries(
        body.get("entries"), req["template_id"], template_ids=orig_tpl_ids,
        mode="strict", default_parcel_location=bgy_default)
    if errors:
        return _err(" ".join(errors))
    entries = [w["data"] for w in wrapped]

    original = db.entries_of(req["data_json"])
    changes = []
    for i in range(max(len(original), len(entries))):
        old = original[i] if i < len(original) else {}
        new = entries[i] if i < len(entries) else {}
        for key in sorted(set(old) | set(new)):
            ov, nv = str(old.get(key, "")), str(new.get(key, ""))
            if ov != nv:
                changes.append(
                    f"Entry {i + 1} {key}: '{ov or '—'}' → '{nv or '—'}'")
    if not changes:
        return jsonify(ok=True, changes=0)

    g.db.execute("UPDATE requests SET data_json = ? WHERE id = ?",
                 (json.dumps({"entries": wrapped}), rid))
    _audit("request.correct",
           f"{req['ref_no']} rectified by {g.user['full_name']} — "
           + "; ".join(changes)[:600],
           barangay_id=req["barangay_id"])
    g.db.commit()
    return jsonify(ok=True, changes=len(changes))


@app.post("/api/requests/<int:rid>/approve")
@login_required
def approve_request(rid):
    req = g.db.execute("SELECT * FROM requests WHERE id = ?", (rid,)).fetchone()
    if req is None:
        return _err("Request not found.", 404)
    if _scope_barangay_id() is not None and req["barangay_id"] != _scope_barangay_id():
        return _err("You may only process requests from your own barangay.", 403)
    if req["status"] != "pending":
        return _err(f"Request is already {req['status']}.", 409)

    bgy = g.db.execute("SELECT * FROM barangays WHERE id = ?",
                       (req["barangay_id"],)).fetchone()
    bgy_default = bgy["name"] if bgy else ""
    _stored_entries = db.entries_of(req["data_json"])
    _stored_tpl_ids = db.entry_templates_of(req["data_json"],
                                            req["template_id"])
    _wrapped, _checked_tpl_ids, _validation_errors = _validate_mixed_entries(
        [{"template_id": (_stored_tpl_ids[i] if i < len(_stored_tpl_ids)
                          else req["template_id"]), "data": entry}
         for i, entry in enumerate(_stored_entries)],
        req["template_id"], mode="strict",
        default_parcel_location=bgy_default)
    if _validation_errors:
        return _err("Complete all information before issuing: "
                    + " ".join(_validation_errors))

    settings = {r["key"]: r["value"] for r in
                g.db.execute("SELECT key, value FROM settings")}

    entries = [w["data"] for w in _wrapped]
    entry_tpl_ids = db.entry_templates_of(req["data_json"], req["template_id"])
    today = db.now_iso()[:10]
    year_dir = os.path.join(db.FILINGS_DIR, today[:4])
    os.makedirs(year_dir, exist_ok=True)

    # ---- generate every certificate first; only then touch the database ----
    generated = []
    try:
        for _eidx, entry in enumerate(entries):
            etpl = _load_template(
                entry_tpl_ids[_eidx] if _eidx < len(entry_tpl_ids)
                else req["template_id"])
            if etpl is None:
                raise RuntimeError("Original template is missing.")
            fields = _fields_of(etpl)
            tpl_path = os.path.join(db.TEMPLATES_DIR, etpl["filename"])
            if not os.path.exists(tpl_path):
                raise RuntimeError("Template file is missing on disk.")
            cert_no = db.make_cert_no(
                g.db, settings.get("cert_prefix", "RSBSA") or "RSBSA")
            mapping = dict(entry)
            for f in fields:                 # dates -> long format
                if f.get("type") == "date" and mapping.get(f["key"]):
                    mapping[f["key"]] = docgen.format_long_date(mapping[f["key"]])
            mapping.update({
                "BARANGAY": bgy["name"],
                "MUNICIPALITY": settings.get("municipality", ""),
                "PROVINCE": settings.get("province", ""),
                "DATE_ISSUED": docgen.format_long_date(today),
                "GENERATED_TIMESTAMP": docgen.format_timestamp(db.now_iso()),
                "OR_NUMBER": docgen.OR_BLANK,   # left blank for the Treasurer
                "CERT_NO": cert_no,
                "SECRETARY_NAME": g.user["full_name"],
            })
            for f in fields:                 # never leave raw {{...}} behind
                mapping.setdefault(f["key"], "")
            if not mapping.get("PARCEL_LOCATION"):
                mapping["PARCEL_LOCATION"] = "—"

            farmer_name = _farmer_name_of(fields, entry)
            rsbsa_val = _rsbsa_of_entry(entry)
            entry_no = _eidx + 1
            desired_pdf_name = _cert_pdf_filename(farmer_name, rsbsa_val, entry_no)
            # PDF-only filing: the DOCX is only a temporary rendering
            # intermediate in a temp folder and is deleted automatically
            # as soon as the PDF has been produced. It is never saved.
            with tempfile.TemporaryDirectory(prefix="rsbsa_cert_") as tmp_dir:
                tmp_docx = os.path.join(tmp_dir, f"{cert_no}.docx")
                docgen.fill_docx(tpl_path, tmp_docx, mapping)
                raw_pdf_path = docgen.docx_to_pdf(tmp_docx, year_dir)
                target_pdf_path = os.path.join(year_dir, desired_pdf_name)
                if os.path.exists(target_pdf_path) and os.path.abspath(target_pdf_path) != os.path.abspath(raw_pdf_path):
                    stem = os.path.splitext(desired_pdf_name)[0]
                    target_pdf_path = os.path.join(year_dir, f"{stem}_{cert_no}.pdf")
                if os.path.abspath(raw_pdf_path) != os.path.abspath(target_pdf_path):
                    os.replace(raw_pdf_path, target_pdf_path)
                pdf_path = target_pdf_path
            entry_store = dict(entry)
            entry_store["_ENTRY_NO"] = entry_no
            generated.append({
                "cert_no": cert_no,
                "template_id": etpl["id"],
                "farmer_name": farmer_name,
                "pdf_path": pdf_path,
                "download_name": desired_pdf_name,
                "data": entry_store,
            })
    except Exception as exc:                 # noqa: BLE001
        for item in generated:               # remove partial PDF output
            path = item.get("pdf_path")
            if path and os.path.exists(path):
                try:
                    os.remove(path)
                except OSError:
                    pass
        return _err(f"Certificate generation failed: {exc}", 500)

    # ---- all files generated: persist atomically ----
    certs = []
    for item in generated:
        issued_at = db.now_iso()
        cur = g.db.execute(
            "INSERT INTO certificates (cert_no, request_id, template_id, "
            "barangay_id, farmer_name, docx_path, pdf_path, generated_by, "
            "generated_at, pdf_file_created_at, data_json) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (item["cert_no"], rid, item["template_id"], req["barangay_id"],
             item["farmer_name"], None,
             os.path.relpath(item["pdf_path"], db.BASE_DIR)
             if item["pdf_path"] else None,
             g.user["id"], issued_at, issued_at,
             json.dumps(item.get("data") or {})),
        )
        certs.append({"id": cur.lastrowid, "cert_no": item["cert_no"],
                      "farmer_name": item["farmer_name"],
                      "request_ref": req["ref_no"],
                      "has_pdf": bool(item["pdf_path"])})
        _audit("certificate.issue",
               f"{item['cert_no']} issued to "
               f"{item['farmer_name'] or '—'} for request {req['ref_no']}",
               barangay_id=req["barangay_id"])

    g.db.execute(
        "UPDATE requests SET status='approved', reviewed_by=?, reviewed_at=?, "
        "notes=COALESCE(?, notes) WHERE id=?",
        (g.user["id"], db.now_iso(),
         (request.get_json(silent=True) or {}).get("notes"), rid),
    )
    g.db.commit()
    return jsonify(ok=True, certs=certs)


@app.post("/api/requests/<int:rid>/reject")
@login_required
def reject_request(rid):
    req = g.db.execute("SELECT * FROM requests WHERE id = ?", (rid,)).fetchone()
    if req is None:
        return _err("Request not found.", 404)
    if _scope_barangay_id() is not None and req["barangay_id"] != _scope_barangay_id():
        return _err("You may only process requests from your own barangay.", 403)
    if req["status"] != "pending":
        return _err(f"Request is already {req['status']}.", 409)
    body = request.get_json(silent=True) or {}
    notes = (body.get("notes") or "").strip() or "Rejected by secretary."
    g.db.execute(
        "UPDATE requests SET status='rejected', reviewed_by=?, reviewed_at=?, "
        "notes=? WHERE id=?",
        (g.user["id"], db.now_iso(), notes, rid),
    )
    _audit("request.reject", f"{req['ref_no']} rejected — {notes}",
           barangay_id=req["barangay_id"])
    g.db.commit()
    return jsonify(ok=True)


# --------------------------------------------------------------------------- #
# Archive (filing system) + downloads
# --------------------------------------------------------------------------- #
@app.get("/api/certificates")
@login_required
def list_certificates():
    bgy = _scope_barangay_id()
    q = (request.args.get("q") or "").strip()
    date_from = request.args.get("from") or ""
    date_to = request.args.get("to") or ""
    tpl_id = request.args.get("template_id") or ""
    sql = (
        "SELECT c.id, c.cert_no, c.farmer_name, c.generated_at, c.pdf_path, "
        "c.pdf_file_created_at, c.pdf_purged_at, c.template_id, c.data_json, "
        "r.ref_no, b.name AS barangay, t.name AS template, u.full_name AS generator "
        "FROM certificates c "
        "JOIN requests r ON r.id = c.request_id "
        "JOIN barangays b ON b.id = c.barangay_id "
        "JOIN templates t ON t.id = c.template_id "
        "JOIN users u ON u.id = c.generated_by WHERE 1=1"
    )
    args = []
    if bgy is not None:
        sql += " AND c.barangay_id = ?"
        args.append(bgy)
    if tpl_id:
        sql += " AND c.template_id = ?"
        args.append(tpl_id)
    if q:
        sql += " AND (c.cert_no LIKE ? OR c.farmer_name LIKE ? OR r.ref_no LIKE ?)"
        like = f"%{q}%"
        args += [like, like, like]
    if date_from:
        sql += " AND substr(c.generated_at,1,10) >= ?"
        args.append(date_from)
    if date_to:
        sql += " AND substr(c.generated_at,1,10) <= ?"
        args.append(date_to)
    sql += " ORDER BY c.generated_at DESC LIMIT 500"
    rows = g.db.execute(sql, args).fetchall()
    out = []
    for r in rows:
        item = dict(r)
        _basis, expires, available = _cert_pdf_state(r)
        item["pdf_expires_at"] = expires
        item["pdf_available"] = available
        try:
            item["data"] = json.loads(r["data_json"] or "{}")
        except Exception:
            item["data"] = {}
        out.append(item)
    return jsonify(out)


def _regenerate_certificate_pdf(cert, regen_time=None):
    """Rebuild a certificate PDF from its permanently stored data.

    Updates the issue date to the regeneration date.
    The intermediate DOCX lives only in a temp folder and is deleted immediately.
    """
    tpl = _load_template(cert["template_id"])
    if tpl is None:
        raise RuntimeError("Original template record is missing.")
    tpl_path = os.path.join(db.TEMPLATES_DIR, tpl["filename"])
    if not os.path.exists(tpl_path):
        raise RuntimeError("Template file is missing on disk.")
    req = g.db.execute("SELECT * FROM requests WHERE id = ?",
                       (cert["request_id"],)).fetchone()
    if req is None:
        raise RuntimeError("Original request record is missing.")
    bgy = g.db.execute("SELECT * FROM barangays WHERE id = ?",
                       (cert["barangay_id"],)).fetchone()
    generator = g.db.execute("SELECT full_name FROM users WHERE id = ?",
                             (cert["generated_by"],)).fetchone()
    settings = {r["key"]: r["value"] for r in
                g.db.execute("SELECT key, value FROM settings")}
    sibling_ids = [r["id"] for r in g.db.execute(
        "SELECT id FROM certificates WHERE request_id = ? ORDER BY id",
        (cert["request_id"],)).fetchall()]
    try:
        idx = sibling_ids.index(cert["id"])
    except ValueError:
        idx = 0
    entries = db.entries_of(req["data_json"])
    entry = entries[idx] if idx < len(entries) else {}
    fields = _fields_of(tpl)
    generated_at = regen_time or cert["generated_at"]
    mapping = dict(entry)
    for f in fields:
        if f.get("type") == "date" and mapping.get(f["key"]):
            mapping[f["key"]] = docgen.format_long_date(mapping[f["key"]])
    mapping.update({
        "BARANGAY": bgy["name"] if bgy else "",
        "MUNICIPALITY": settings.get("municipality", ""),
        "PROVINCE": settings.get("province", ""),
        "DATE_ISSUED": docgen.format_long_date(generated_at[:10]),
        "GENERATED_TIMESTAMP": docgen.format_timestamp(generated_at),
        "OR_NUMBER": docgen.OR_BLANK,
        "CERT_NO": cert["cert_no"],
        "SECRETARY_NAME": (generator["full_name"] if generator
                           else g.user["full_name"]),
    })
    for f in fields:
        mapping.setdefault(f["key"], "")
    if not mapping.get("PARCEL_LOCATION"):
        mapping["PARCEL_LOCATION"] = "—"
    year_dir = os.path.join(db.FILINGS_DIR, generated_at[:4])
    os.makedirs(year_dir, exist_ok=True)
    desired_pdf_name = _cert_pdf_filename(
        cert["farmer_name"] or _farmer_name_of(fields, entry),
        _rsbsa_of_entry(entry), idx + 1)
    with tempfile.TemporaryDirectory(prefix="rsbsa_cert_") as tmp_dir:
        tmp_docx = os.path.join(tmp_dir, f"{cert['cert_no']}.docx")
        docgen.fill_docx(tpl_path, tmp_docx, mapping)
        raw_pdf_path = docgen.docx_to_pdf(tmp_docx, year_dir)
        target_pdf_path = os.path.join(year_dir, desired_pdf_name)
        if os.path.exists(target_pdf_path) and os.path.abspath(target_pdf_path) != os.path.abspath(raw_pdf_path):
            stem = os.path.splitext(desired_pdf_name)[0]
            target_pdf_path = os.path.join(year_dir, f"{stem}_{cert['cert_no']}.pdf")
        if os.path.abspath(raw_pdf_path) != os.path.abspath(target_pdf_path):
            os.replace(raw_pdf_path, target_pdf_path)
        return target_pdf_path


@app.post("/api/certificates/<int:cid>/regenerate")
@login_required
def regenerate_certificate(cid):
    """Create a fresh PDF copy after the retained copy was purged.

    The issue date is updated to the date of regeneration.
    """
    row = g.db.execute(
        "SELECT c.*, r.ref_no FROM certificates c "
        "JOIN requests r ON r.id = c.request_id WHERE c.id = ?", (cid,)
    ).fetchone()
    if row is None:
        return _err("Certificate not found.", 404)
    if _scope_barangay_id() is not None and row["barangay_id"] != _scope_barangay_id():
        return _err("This certificate belongs to another barangay.", 403)
    _basis, expires, available = _cert_pdf_state(row)
    if available:
        return jsonify(ok=True, already_available=True,
                       cert_no=row["cert_no"], pdf_expires_at=expires)
    now = db.now_iso()
    try:
        pdf_path = _regenerate_certificate_pdf(row, regen_time=now)
    except Exception as exc:  # noqa: BLE001
        return _err(f"PDF regeneration failed: {exc}", 500)
    g.db.execute(
        "UPDATE certificates SET generated_at = ?, pdf_path = ?, pdf_file_created_at = ?, "
        "pdf_purged_at = NULL WHERE id = ?",
        (now, os.path.relpath(pdf_path, db.BASE_DIR), now, cid))
    new_expires = _pdf_expires_at(now)
    _audit("certificate.pdf_regenerate",
           f"{row['cert_no']} PDF regenerated after retention purge — issue date updated to {now[:10]}; "
           f"fresh {PDF_RETENTION_DAYS}-day retention until {(new_expires or '')[:10]}",
           barangay_id=row["barangay_id"])
    g.db.commit()
    return jsonify(ok=True, cert_no=row["cert_no"],
                   regenerated_at=now, pdf_expires_at=new_expires)


@app.get("/api/certificates/<int:cid>/preview")
@login_required
def preview_certificate(cid):
    row = g.db.execute(
        "SELECT c.*, r.ref_no FROM certificates c "
        "JOIN requests r ON r.id = c.request_id WHERE c.id = ?", (cid,)
    ).fetchone()
    if row is None:
        return _err("Certificate not found.", 404)
    if _scope_barangay_id() is not None and row["barangay_id"] != _scope_barangay_id():
        return _err("This certificate belongs to another barangay.", 403)
    _basis, _expires, available = _cert_pdf_state(row)
    if not available:
        return _err("PDF file is not available (purged).", 410)
    return send_file(os.path.join(db.BASE_DIR, row["pdf_path"]),
                     as_attachment=False, mimetype="application/pdf")


@app.get("/api/certificates/<int:cid>/download/<fmt>")
@login_required
def download_certificate(cid, fmt):
    row = g.db.execute(
        "SELECT c.*, r.ref_no FROM certificates c "
        "JOIN requests r ON r.id = c.request_id WHERE c.id = ?", (cid,)
    ).fetchone()
    if row is None:
        return _err("Certificate not found.", 404)
    if _scope_barangay_id() is not None and row["barangay_id"] != _scope_barangay_id():
        return _err("This certificate belongs to another barangay.", 403)
    if fmt == "docx":
        return _err("DOCX copies are not retained — certificates are "
                    "filed as PDF only. Please download the PDF copy.", 410)
    if fmt != "pdf":
        return _err("Unsupported format.", 400)
    _basis, _expires, available = _cert_pdf_state(row)
    if not available:
        return _err(
            "This certificate's PDF file was deleted after the "
            f"{PDF_RETENTION_DAYS}-day retention period. The certificate "
            "record is permanently retained — use Regenerate PDF to "
            "create a fresh copy.", 410)
    _audit("certificate.download",
           f"{row['cert_no']} (PDF) downloaded",
           barangay_id=row["barangay_id"])
    g.db.commit()
    return send_file(os.path.join(db.BASE_DIR, row["pdf_path"]),
                     as_attachment=True,
                     download_name=_cert_download_filename(row))


# --------------------------------------------------------------------------- #
# Archive export (Excel / CSV)
# --------------------------------------------------------------------------- #
_EXPORT_HEADERS = ["Certificate No.", "Farmer Name", "Barangay",
                   "Certification Type", "Request Reference",
                   "Date Issued", "Issued By"]


def _archive_rows():
    """Certificate archive rows honouring the caller's scope + filters."""
    bgy = _scope_barangay_id()
    q = (request.args.get("q") or "").strip()
    date_from = request.args.get("from") or ""
    date_to = request.args.get("to") or ""
    sql = (
        "SELECT c.cert_no, c.farmer_name, c.generated_at, "
        "r.ref_no, b.name AS barangay, t.name AS template, "
        "u.full_name AS generator "
        "FROM certificates c "
        "JOIN requests r ON r.id = c.request_id "
        "JOIN barangays b ON b.id = c.barangay_id "
        "JOIN templates t ON t.id = c.template_id "
        "JOIN users u ON u.id = c.generated_by WHERE 1=1"
    )
    args = []
    if bgy is not None:
        sql += " AND c.barangay_id = ?"
        args.append(bgy)
    if q:
        sql += " AND (c.cert_no LIKE ? OR c.farmer_name LIKE ? OR r.ref_no LIKE ?)"
        like = f"%{q}%"
        args += [like, like, like]
    if date_from:
        sql += " AND substr(c.generated_at,1,10) >= ?"
        args.append(date_from)
    if date_to:
        sql += " AND substr(c.generated_at,1,10) <= ?"
        args.append(date_to)
    sql += " ORDER BY c.generated_at DESC LIMIT 5000"
    return [dict(r) for r in g.db.execute(sql, args).fetchall()]


def _export_values(row):
    return [row["cert_no"], row["farmer_name"] or "", row["barangay"],
            row["template"], row["ref_no"], row["generated_at"],
            row["generator"]]


@app.get("/api/certificates/export/<fmt>")
@login_required
def export_certificates(fmt):
    if fmt not in ("xlsx", "csv"):
        return _err("Unsupported export format.", 400)
    import csv as _csv
    import io as _io

    rows = _archive_rows()
    stamp = db.now_iso()[:10]
    if fmt == "csv":
        buf = _io.StringIO()
        writer = _csv.writer(buf)
        writer.writerow(_EXPORT_HEADERS)
        for row in rows:
            writer.writerow(_export_values(row))
        bio = _io.BytesIO(buf.getvalue().encode("utf-8-sig"))  # Excel-friendly
        _audit("archive.export", f"{len(rows)} records exported as CSV")
        g.db.commit()
        return send_file(bio, mimetype="text/csv", as_attachment=True,
                         download_name=f"rsbsa_archive_{stamp}.csv")
    from openpyxl import Workbook
    from openpyxl.styles import Font, PatternFill

    wb = Workbook()
    ws = wb.active
    ws.title = "Certificates"
    ws.append(_EXPORT_HEADERS)
    fill = PatternFill("solid", fgColor="0F4C81")
    for cell in ws[1]:
        cell.font = Font(bold=True, color="FFFFFF")
        cell.fill = fill
    for row in rows:
        ws.append(_export_values(row))
    for i, w in enumerate([18, 26, 16, 28, 18, 24, 22], start=1):
        ws.column_dimensions[chr(64 + i)].width = w
    ws.freeze_panes = "A2"
    out = _io.BytesIO()
    wb.save(out)
    out.seek(0)
    _audit("archive.export", f"{len(rows)} records exported as Excel")
    g.db.commit()
    return send_file(out, as_attachment=True,
                     download_name=f"rsbsa_archive_{stamp}.xlsx")


_DATA_EXPORT_PREFERRED = ["FARMER_NAME", "CIVIL_STATUS", "ADDRESS",
                          "RSBSA_NUMBER", "PARCEL_LOCATION", "FARM_AREA",
                          "PURPOSE", "CROP_COMMODITY", "CERT_TYPE"]


@app.get("/api/certificates/export-data")
@login_required
def export_certificate_data():
    """CSV of every issued certificate WITH the information entered.

    One row per certificate: archive metadata first, then every field the
    farmer entered (columns = union across the exported certificates, in
    a stable order). Honours barangay scope and the archive filters.
    """
    import csv as _csv
    import io as _io

    bgy = _scope_barangay_id()
    q = (request.args.get("q") or "").strip()
    date_from = request.args.get("from") or ""
    date_to = request.args.get("to") or ""
    sql = (
        "SELECT c.cert_no, c.farmer_name, c.generated_at, c.data_json, "
        "r.ref_no, b.name AS barangay, t.name AS template, "
        "t.fields_json, u.full_name AS generator "
        "FROM certificates c "
        "JOIN requests r ON r.id = c.request_id "
        "JOIN barangays b ON b.id = c.barangay_id "
        "JOIN templates t ON t.id = c.template_id "
        "JOIN users u ON u.id = c.generated_by WHERE 1=1")
    args = []
    if bgy is not None:
        sql += " AND c.barangay_id = ?"
        args.append(bgy)
    if q:
        sql += (" AND (c.cert_no LIKE ? OR c.farmer_name LIKE ? "
                "OR r.ref_no LIKE ?)")
        like = f"%{q}%"
        args += [like, like, like]
    if date_from:
        sql += " AND substr(c.generated_at,1,10) >= ?"
        args.append(date_from)
    if date_to:
        sql += " AND substr(c.generated_at,1,10) <= ?"
        args.append(date_to)
    sql += " ORDER BY c.generated_at DESC LIMIT 5000"
    rows = [dict(r) for r in g.db.execute(sql, args).fetchall()]

    labels = {}
    for row in rows:
        try:
            for f in json.loads(row["fields_json"] or "[]"):
                labels.setdefault(f["key"], f["label"])
        except ValueError:
            pass
    datas, ordered_keys = [], []
    for row in rows:
        try:
            data = json.loads(row["data_json"] or "{}")
        except ValueError:
            data = {}
        if not isinstance(data, dict):
            data = {}
        datas.append(data)
        for k in data:
            if k not in ordered_keys:
                ordered_keys.append(k)
    field_keys = [k for k in _DATA_EXPORT_PREFERRED if k in ordered_keys]
    field_keys += [k for k in ordered_keys if k not in field_keys]

    def _label(key):
        lab = labels.get(key) or docgen._label_for(key)
        # Distinguish entered-information columns from the metadata ones.
        return lab + " (Entered)" if lab in _EXPORT_HEADERS else lab

    headers = _EXPORT_HEADERS + [_label(k) for k in field_keys]
    buf = _io.StringIO()
    writer = _csv.writer(buf)
    writer.writerow(headers)
    for row, data in zip(rows, datas):
        writer.writerow(_export_values(row) +
                        [data.get(k, "") for k in field_keys])
    bio = _io.BytesIO(buf.getvalue().encode("utf-8-sig"))
    stamp = db.now_iso()[:10]
    _audit("certificate.data_export",
           f"{len(rows)} issued-certificate data record(s) exported "
           f"as CSV ({len(field_keys)} information fields)",
           barangay_id=bgy)
    g.db.commit()
    return send_file(bio, mimetype="text/csv", as_attachment=True,
                     download_name=f"rsbsa_issued_data_{stamp}.csv")


# --------------------------------------------------------------------------- #
# Farmer masterlist
# --------------------------------------------------------------------------- #
@app.get("/api/farmers")
@login_required
def list_farmers():
    bgy = _scope_barangay_id()
    if bgy is None and request.args.get("barangay_id"):
        try:
            bgy = int(request.args.get("barangay_id"))
        except ValueError:
            pass
    q = (request.args.get("q") or "").strip()
    remarks = (request.args.get("remarks") or "").strip()
    sql = (
        "SELECT f.*, b.name AS barangay, "
        "(SELECT fi.control_no FROM farmer_ids fi "
        " WHERE fi.farmer_id = f.id ORDER BY fi.id DESC LIMIT 1) "
        "AS id_control_no, "
        "(SELECT fi.valid_until FROM farmer_ids fi "
        " WHERE fi.farmer_id = f.id ORDER BY fi.id DESC LIMIT 1) "
        "AS id_valid_until, "
        "(SELECT fi.reprint_count FROM farmer_ids fi "
        " WHERE fi.farmer_id = f.id ORDER BY fi.id DESC LIMIT 1) "
        "AS id_reprints, "
        "(SELECT COUNT(*) FROM request_farmers rf "
        " WHERE rf.farmer_id = f.id) AS requests, "
        "(SELECT r.ref_no FROM request_farmers rf "
        " JOIN requests r ON r.id = rf.request_id "
        " WHERE rf.farmer_id = f.id ORDER BY r.id DESC LIMIT 1) AS last_ref "
        "FROM farmers f LEFT JOIN barangays b ON b.id = f.barangay_id "
        "WHERE 1=1"
    )
    args = []
    if bgy is not None:
        sql += " AND f.barangay_id = ?"
        args.append(bgy)
    if q:
        sql += " AND (f.name LIKE ? OR f.rsbsa_number LIKE ?)"
        args += [f"%{q}%", f"%{q}%"]
    if remarks and remarks.lower() != "all":
        sql += " AND f.remarks = ?"
        args.append(remarks)
    status = (request.args.get("status") or "").strip()
    if status in ("new", "verified"):
        sql += " AND f.verification_status = ?"
        args.append(status)
    sql += " ORDER BY f.last_seen DESC LIMIT 500"
    rows = [dict(r) for r in g.db.execute(sql, args).fetchall()]
    _overlay_id_generator_status(rows)
    id_status = (request.args.get("id_status") or "").strip().lower()
    if id_status in ("generated", "1"):
        rows = [r for r in rows if r.get("id_control_no")]
    elif id_status in ("not_generated", "not_yet_generated", "not yet generated", "0"):
        rows = [r for r in rows if not r.get("id_control_no")]
    return jsonify(rows)


@app.get("/api/farmers/stats")
@login_required
def farmer_stats():
    """Counts for the masterlist verification tabs (scope-respecting)."""
    bgy = _scope_barangay_id()
    where = "WHERE barangay_id = ?" if bgy is not None else ""
    args = (bgy,) if bgy is not None else ()
    row = g.db.execute(
        "SELECT COUNT(*) AS total, "
        "SUM(CASE WHEN verification_status = 'new' THEN 1 ELSE 0 END) AS new, "
        "SUM(CASE WHEN verification_status = 'verified' THEN 1 ELSE 0 END) "
        "AS verified FROM farmers " + where, args).fetchone()
    return jsonify(total=row["total"] or 0, new=row["new"] or 0,
                   verified=row["verified"] or 0)


@app.get("/api/farmers/lookup")
def farmer_lookup():
    """Prefill helper for the guest submission form (always audited)."""
    rsbsa = (request.args.get("rsbsa") or "").strip()
    if not rsbsa:
        return _err("RSBSA number is required.")
    f = db.find_farmer_by_rsbsa(g.db, rsbsa)
    if f is None:
        _audit("farmer.lookup",
               f"Pre-fill lookup for RSBSA {rsbsa} - no match; "
               "Farmer Data Entry opened",
               actor=g.user["username"] if g.user else "guest",
               role=g.user["role"] if g.user else "farmer-guest")
        g.db.commit()
        return jsonify(found=False)
    _audit("farmer.lookup",
           f"Pre-fill lookup for RSBSA {rsbsa} - matched '{f['name']}'",
           barangay_id=f["barangay_id"],
           actor=g.user["username"] if g.user else "guest",
           role=g.user["role"] if g.user else "farmer-guest")
    g.db.commit()
    return jsonify(found=True, name=f["name"],
                   rsbsa_number=f["rsbsa_number"],
                   verification_status=(
                       f["verification_status"]
                       if "verification_status" in f.keys() else "verified"),
                   data=json.loads(f["data_json"]))


@app.post("/api/farmers")
def create_farmer():
    """Farmer Data Entry: encode a farmer directly into the masterlist.

    Used when an RSBSA lookup finds no match (farmer submission flow) and
    by staff on the Farmer Masterlist page -- instead of uploading a CSV
    file to seed the database. Guests register under the barangay they
    selected; secretaries are always scoped to their own barangay; admins
    may encode for any barangay. If the RSBSA number already exists under
    a different name, the entry is refused (duplicate protection).
    """
    body = request.get_json(silent=True) or {}
    data_in = body.get("data") if isinstance(body.get("data"), dict) else body

    def _val(*keys):
        for k in keys:
            v = data_in.get(k)
            if v:
                return str(v).strip()
        return ""

    rsbsa = _val("RSBSA_NUMBER", "rsbsa_number", "rsbsa").upper()
    name = _val("FARMER_NAME", "FULL_NAME", "NAME", "name").upper()
    if not name:
        return _err("Farmer name is required.")
    if g.user is not None and g.user["role"] == "secretary":
        _missing = []
        if not rsbsa:
            _missing.append("RSBSA Number")
        if not _val("CIVIL_STATUS", "civil_status"):
            _missing.append("Civil Status")
        if not _val("ADDRESS", "address"):
            _missing.append("Address")
        if _missing:
            return _err("Secretary entries must be complete — please fill "
                        "in: " + ", ".join(_missing) + ".")
    elif g.user is not None and not rsbsa:
        return _err("RSBSA number is required.")

    if g.user is not None and g.user["role"] == "secretary":
        barangay_id = g.user["barangay_id"]
    else:
        barangay_id = body.get("barangay_id") or data_in.get("barangay_id")
    if not barangay_id:
        return _err("Barangay is required. Please select your barangay first.")
    try:
        barangay_id = int(barangay_id)
    except (TypeError, ValueError):
        return _err("Invalid barangay.")
    bgy = g.db.execute("SELECT * FROM barangays WHERE id = ?",
                       (barangay_id,)).fetchone()
    if bgy is None:
        return _err("Unknown barangay.")

    existing = db.find_farmer_by_rsbsa(g.db, rsbsa)
    if (existing is not None and
            db.normalize_name(existing["name"]) != db.normalize_name(name)):
        return _err(
            f"RSBSA number {rsbsa} is already registered to "
            f"{existing['name']}. Please verify the number or use the "
            "existing farmer record.", 409)

    data = {}
    for src, dst in (
            ("FARMER_NAME", "FARMER_NAME"), ("name", "FARMER_NAME"),
            ("CIVIL_STATUS", "CIVIL_STATUS"), ("civil_status", "CIVIL_STATUS"),
            ("ADDRESS", "ADDRESS"), ("address", "ADDRESS"),
            ("GENDER", "GENDER"), ("gender", "GENDER"),
            ("BIRTHDATE", "BIRTHDATE"), ("birthdate", "BIRTHDATE"),
            ("FARM_AREA", "FARM_AREA"), ("farm_area", "FARM_AREA"),
            ("PARCEL_LOCATION", "PARCEL_LOCATION"),
            ("parcel_location", "PARCEL_LOCATION"),
            ("PURPOSE", "PURPOSE"), ("purpose", "PURPOSE")):
        if data_in.get(src):
            data[dst] = str(data_in[src]).strip().upper()
    if data.get("CIVIL_STATUS"):
        data["CIVIL_STATUS"] = _normalize_civil_status(data["CIVIL_STATUS"])
    if data.get("GENDER"):
        data["GENDER"] = db_id.normalize_gender(data["GENDER"])
    data["RSBSA_NUMBER"] = rsbsa
    data["FARMER_NAME"] = name

    fid, created = db.upsert_farmer(
        g.db, rsbsa_number=rsbsa, name=name, data=data,
        barangay_id=barangay_id)
    _audit("farmer.create",
           f"Farmer Data Entry: '{name}' (RSBSA {rsbsa}) "
           f"{'encoded into' if created else 'updated in'} the masterlist "
           f"for {bgy['name']} — no CSV upload used"
           + (" — tagged NEW for admin verification" if created else ""),
           barangay_id=barangay_id)
    g.db.commit()
    return jsonify(ok=True, id=fid, created=created, name=name,
                   rsbsa_number=rsbsa, barangay=bgy["name"], data=data,
                   verification_status="new" if created else "verified"),         (201 if created else 200)


@app.get("/api/farmers/<int:fid>")
@login_required
def farmer_detail(fid):
    f = g.db.execute(
        "SELECT f.*, b.name AS barangay FROM farmers f "
        "LEFT JOIN barangays b ON b.id = f.barangay_id WHERE f.id = ?",
        (fid,)).fetchone()
    if f is None:
        return _err("Farmer not found.", 404)
    if (_scope_barangay_id() is not None and
            f["barangay_id"] != _scope_barangay_id()):
        return _err("This farmer belongs to another barangay.", 403)
    idrow = g.db.execute(
        "SELECT * FROM farmer_ids WHERE farmer_id = ? ORDER BY id DESC "
        "LIMIT 1", (fid,)).fetchone()
    _gen_person, _gen_card = _id_person_for_farmer(f)
    if _gen_card is not None:
        idrow = _gen_card  # ID Card Generator registry takes precedence
    reqs = g.db.execute(
        "SELECT r.id, r.ref_no, r.status, r.submitted_at, r.reviewed_at, "
        "t.name AS template, "
        "(SELECT GROUP_CONCAT(c.cert_no, ', ') FROM certificates c "
        " WHERE c.request_id = r.id) AS cert_nos "
        "FROM request_farmers rf JOIN requests r ON r.id = rf.request_id "
        "JOIN templates t ON t.id = r.template_id "
        "WHERE rf.farmer_id = ? ORDER BY r.id DESC", (fid,)).fetchall()
    f_dict = dict(f)
    photo_rel = f_dict.get("photo_path")
    if not photo_rel or not os.path.exists(os.path.join(db.INSTANCE_DIR, photo_rel)):
        if _gen_person and _gen_person.get("photo_path"):
            gen_rel = _gen_person["photo_path"]
            if os.path.exists(os.path.join(db.INSTANCE_DIR, gen_rel)):
                photo_rel = gen_rel
    has_photo = bool(photo_rel)
    return jsonify(
        id=f["id"], name=f["name"], rsbsa_number=f["rsbsa_number"],
        civil_status=f["civil_status"], address=f["address"],
        barangay=f["barangay"], first_seen=f["first_seen"],
        last_seen=f["last_seen"],
        verification_status=(
            f["verification_status"]
            if "verification_status" in f.keys() else "verified"),
        verified_at=(f["verified_at"] if "verified_at" in f.keys() else None),
        remarks=f_dict.get("remarks") or "Active",
        pending_remarks=f_dict.get("pending_remarks"),
        pending_remarks_by=f_dict.get("pending_remarks_by"),
        pending_remarks_at=f_dict.get("pending_remarks_at"),
        birthdate=f["birthdate"], contact_number=f["contact_number"],
        emergency_contact=f["emergency_contact"],
        blood_type=f["blood_type"], has_photo=has_photo,
        photo_url=f"/api/farmers/{fid}/photo" if has_photo else None,
        id_card=(dict(idrow) if idrow else None),
        data=json.loads(f["data_json"]),
        requests=[dict(r) for r in reqs],
    )


@app.put("/api/farmers/<int:fid>")
@admin_required
def update_farmer(fid):
    """Admin edits a farmer record in the masterlist (any record,
    especially NEW ones awaiting verification). Audited with diffs."""
    f = g.db.execute("SELECT * FROM farmers WHERE id = ?", (fid,)).fetchone()
    if f is None:
        return _err("Farmer not found.", 404)
    body = request.get_json(silent=True) or {}
    name = str(body.get("name") or "").strip().upper()
    if not name:
        return _err("Farmer name is required.")
    rsbsa = str(body.get("rsbsa_number") or "").strip().upper()
    civil = _normalize_civil_status(body.get("civil_status"))
    address = str(body.get("address") or "").strip().upper()
    birthdate = str(body.get("birthdate") or "").strip()
    if birthdate:
        for fmt in ("%Y-%m-%d", "%m/%d/%Y", "%m-%d-%Y", "%d/%m/%Y", "%d-%m-%Y"):
            try:
                birthdate = datetime.datetime.strptime(birthdate[:10], fmt).date().isoformat()
                break
            except ValueError:
                pass
    contact = str(body.get("contact_number") or "").strip()
    emergency = str(body.get("emergency_contact") or "").strip().upper()
    blood = str(body.get("blood_type") or "").strip().upper()
    fca_raw = body.get("affiliated_fca", f["affiliated_fca"] if "affiliated_fca" in f.keys() else "")
    affiliated_fca = db_id.normalize_fca(fca_raw)
    if affiliated_fca:
        _idc = _id_conn()
        try:
            db_id.remember_fca(_idc, affiliated_fca)
            _idc.commit()
        finally:
            _idc.close()
    barangay_id = body.get("barangay_id") or f["barangay_id"]
    try:
        barangay_id = int(barangay_id)
    except (TypeError, ValueError):
        return _err("Invalid barangay.")
    bgy = g.db.execute("SELECT * FROM barangays WHERE id = ?",
                       (barangay_id,)).fetchone()
    if bgy is None:
        return _err("Unknown barangay.")
    if rsbsa:
        other = db.find_farmer_by_rsbsa(g.db, rsbsa)
        if other is not None and other["id"] != fid:
            return _err(
                f"RSBSA number {rsbsa} is already registered to "
                f"{other['name']}.", 409)
    data = json.loads(f["data_json"] or "{}")
    remarks = body.get("remarks") or f["remarks"] or "Active"
    gender = db_id.normalize_gender(body.get("gender") or f["gender"] or "")
    data.update({"FARMER_NAME": name, "RSBSA_NUMBER": rsbsa,
                 "CIVIL_STATUS": civil, "ADDRESS": address})
    if gender:
        data["GENDER"] = gender
    changes = []
    for label, old, new in (
            ("Name", f["name"], name),
            ("RSBSA Number", f["rsbsa_number"] or "", rsbsa),
            ("Remarks", f["remarks"] or "Active", remarks),
            ("Gender", f["gender"] or "", gender),
            ("Civil Status", f["civil_status"] or "", civil),
            ("Address", f["address"] or "", address),
            ("Birthdate", f["birthdate"] or "", birthdate),
            ("Contact Number", f["contact_number"] or "", contact),
            ("Emergency Contact", f["emergency_contact"] or "", emergency),
            ("Blood Type", f["blood_type"] or "", blood),
            ("Barangay", str(f["barangay_id"] or ""), str(barangay_id))):
        if str(old) != str(new):
            changes.append(f"{label}: '{old or '—'}' → '{new or '—'}'")
    try:
        g.db.execute(
            "UPDATE farmers SET rsbsa_key = ?, rsbsa_number = ?, name = ?, "
            "civil_status = ?, address = ?, barangay_id = ?, data_json = ?, "
            "birthdate = ?, contact_number = ?, emergency_contact = ?, "
            "blood_type = ?, affiliated_fca = ?, remarks = ?, gender = ?, "
            "pending_remarks = NULL, pending_remarks_by = NULL, pending_remarks_at = NULL, "
            "last_seen = ? WHERE id = ?",
            (db.farmer_key(rsbsa, name, barangay_id), rsbsa or None, name,
             civil or None, address or None, barangay_id,
             json.dumps(data), birthdate or None, contact or None,
             emergency or None, blood or None, affiliated_fca or None,
             remarks, gender or None,
             db.now_iso(), fid))
    except Exception:  # UNIQUE rsbsa_key clash
        g.db.rollback()
        return _err("Another farmer record already uses this RSBSA number "
                    "or name in that barangay.", 409)
    _audit("farmer.update",
           f"Farmer record #{fid} ('{name}') edited by admin"
           + (" — " + "; ".join(changes) if changes else " — no changes"),
           barangay_id=barangay_id)
    g.db.commit()
    return jsonify(ok=True, id=fid, name=name, rsbsa_number=rsbsa,
                   changes=len(changes))


@app.post("/api/farmers/<int:fid>/remarks")
@login_required
def update_farmer_remarks(fid):
    body = request.get_json(silent=True) or {}
    remarks = (body.get("remarks") or "").strip()
    valid_remarks = ("Active", "Deceased", "No Farm", "OFW",
                     "Working in other Province", "Severely Sick", "Bedridden")
    if remarks not in valid_remarks:
        return _err(f"Invalid remarks choice. Must be one of: {', '.join(valid_remarks)}")
    f = g.db.execute("SELECT * FROM farmers WHERE id = ?", (fid,)).fetchone()
    if f is None:
        return _err("Farmer not found.", 404)
    if _scope_barangay_id() is not None and f["barangay_id"] != _scope_barangay_id():
        return _err("This farmer belongs to another barangay.", 403)
    now = db.now_iso()
    if g.user["role"] == "admin":
        g.db.execute(
            "UPDATE farmers SET remarks = ?, pending_remarks = NULL, "
            "pending_remarks_by = NULL, pending_remarks_at = NULL WHERE id = ?",
            (remarks, fid)
        )
        _audit("farmer.remarks_update",
               f"Admin changed remarks for '{f['name']}' to '{remarks}'",
               barangay_id=f["barangay_id"])
        g.db.commit()
        return jsonify(ok=True, remarks=remarks, pending=False)
    else:
        # Secretary: must be confirmed and approved first by admin
        g.db.execute(
            "UPDATE farmers SET pending_remarks = ?, pending_remarks_by = ?, "
            "pending_remarks_at = ? WHERE id = ?",
            (remarks, g.user["id"], now, fid)
        )
        _audit("farmer.remarks_request",
               f"Secretary {g.user['full_name']} requested remarks change for '{f['name']}' to '{remarks}' (pending admin approval)",
               barangay_id=f["barangay_id"])
        g.db.commit()
        return jsonify(ok=True, pending_remarks=remarks, pending=True)


@app.post("/api/farmers/<int:fid>/remarks/approve")
@admin_required
def approve_farmer_remarks(fid):
    f = g.db.execute("SELECT * FROM farmers WHERE id = ?", (fid,)).fetchone()
    if f is None or not f["pending_remarks"]:
        return _err("No pending remarks change found for this farmer.", 404)
    new_rem = f["pending_remarks"]
    g.db.execute(
        "UPDATE farmers SET remarks = ?, pending_remarks = NULL, "
        "pending_remarks_by = NULL, pending_remarks_at = NULL WHERE id = ?",
        (new_rem, fid)
    )
    _audit("farmer.remarks_approved",
           f"Admin approved remarks change for '{f['name']}' to '{new_rem}'",
           barangay_id=f["barangay_id"])
    g.db.commit()
    return jsonify(ok=True, remarks=new_rem)


@app.post("/api/farmers/<int:fid>/remarks/reject")
@admin_required
def reject_farmer_remarks(fid):
    f = g.db.execute("SELECT * FROM farmers WHERE id = ?", (fid,)).fetchone()
    if f is None or not f["pending_remarks"]:
        return _err("No pending remarks change found for this farmer.", 404)
    rejected_rem = f["pending_remarks"]
    g.db.execute(
        "UPDATE farmers SET pending_remarks = NULL, "
        "pending_remarks_by = NULL, pending_remarks_at = NULL WHERE id = ?",
        (fid,)
    )
    _audit("farmer.remarks_rejected",
           f"Admin rejected remarks change request for '{f['name']}' ('{rejected_rem}')",
           barangay_id=f["barangay_id"])
    g.db.commit()
    return jsonify(ok=True)


@app.post("/api/farmers/<int:fid>/verify")
@admin_required
def verify_farmer(fid):
    """Admin marks a NEW farmer record as verified/checked."""
    f = g.db.execute("SELECT * FROM farmers WHERE id = ?", (fid,)).fetchone()
    if f is None:
        return _err("Farmer not found.", 404)
    if f["verification_status"] == "verified":
        return jsonify(ok=True, already=True)
    g.db.execute(
        "UPDATE farmers SET verification_status = 'verified', "
        "verified_by = ?, verified_at = ? WHERE id = ?",
        (g.user["id"], db.now_iso(), fid))
    _audit("farmer.verify",
           f"Farmer '{f['name']}' (RSBSA {f['rsbsa_number'] or '—'}) "
           f"verified by admin {g.user['full_name']}",
           barangay_id=f["barangay_id"])
    g.db.commit()
    return jsonify(ok=True)


@app.delete("/api/farmers/<int:fid>")
@admin_required
def delete_farmer(fid):
    """Admin deletes a farmer record from the database (new or verified)."""
    f = g.db.execute("SELECT * FROM farmers WHERE id = ?", (fid,)).fetchone()
    if f is None:
        return _err("Farmer not found.", 404)
    # Admin is allowed to delete verified records as explicitly instructed
    g.db.execute("DELETE FROM request_farmers WHERE farmer_id = ?", (fid,))
    g.db.execute("DELETE FROM farmer_ids WHERE farmer_id = ?", (fid,))
    g.db.execute("DELETE FROM farmers WHERE id = ?", (fid,))
    _audit("farmer.delete",
           f"Farmer record deleted by admin: '{f['name']}' "
           f"(RSBSA {f['rsbsa_number'] or '—'}, status: {f['verification_status']})",
           barangay_id=f["barangay_id"])
    g.db.commit()
    return jsonify(ok=True)


@app.get("/api/farmers/export-csv")
@login_required
def export_farmers_csv():
    import csv as _csv
    bgy = _scope_barangay_id()
    if bgy is None and request.args.get("barangay_id"):
        try:
            bgy = int(request.args.get("barangay_id"))
        except ValueError:
            pass
    q = (request.args.get("q") or "").strip()
    status = (request.args.get("status") or "").strip()
    remarks = (request.args.get("remarks") or "").strip()
    sql = (
        "SELECT f.*, b.name AS barangay FROM farmers f "
        "LEFT JOIN barangays b ON b.id = f.barangay_id WHERE 1=1"
    )
    args = []
    if bgy is not None:
        sql += " AND f.barangay_id = ?"
        args.append(bgy)
    if q:
        sql += " AND (f.name LIKE ? OR f.rsbsa_number LIKE ?)"
        args += [f"%{q}%", f"%{q}%"]
    if status in ("new", "verified"):
        sql += " AND f.verification_status = ?"
        args.append(status)
    if remarks and remarks.lower() != "all":
        sql += " AND f.remarks = ?"
        args.append(remarks)
    sql += " ORDER BY f.name ASC LIMIT 10000"
    rows = [dict(r) for r in g.db.execute(sql, args).fetchall()]
    _overlay_id_generator_status(rows)
    id_status = (request.args.get("id_status") or "").strip().lower()
    if id_status in ("generated", "1"):
        rows = [r for r in rows if r.get("id_control_no")]
    elif id_status in ("not_generated", "not_yet_generated", "not yet generated", "0"):
        rows = [r for r in rows if not r.get("id_control_no")]
    buf = io.StringIO()
    writer = _csv.writer(buf)
    writer.writerow(["RSBSA Number", "Farmer Name", "Remarks", "Pending Remarks",
                     "Verification Status", "Barangay", "Address", "Gender",
                     "Civil Status", "Birthdate", "First Seen", "Last Seen"])
    for r in rows:
        writer.writerow([
            r["rsbsa_number"] or "",
            r["name"] or "",
            r["remarks"] or "Active",
            r["pending_remarks"] or "",
            r["verification_status"] or "new",
            r["barangay"] or "",
            r["address"] or "",
            r["gender"] or "",
            r["civil_status"] or "",
            r["birthdate"] or "",
            r["first_seen"] or "",
            r["last_seen"] or "",
        ])
    stamp = db.now_iso()[:10]
    _audit("farmers.export_csv", f"Exported {len(rows)} farmer records to CSV")
    g.db.commit()
    return send_file(io.BytesIO(buf.getvalue().encode("utf-8-sig")),
                     mimetype="text/csv", as_attachment=True,
                     download_name=f"farmer_masterlist_{stamp}.csv")


@app.post("/api/farmers/sync-from-id-db")
@admin_required
def sync_farmers_from_id_db():
    """Copy/sync all farmers from ID Generator database into Masterlist.

    Does not allow duplicates by detecting RSBSA number, tags all added as verified.
    """
    conn_id = _id_conn()
    try:
        persons = conn_id.execute("SELECT * FROM id_persons").fetchall()
    finally:
        conn_id.close()

    existing_keys = {
        r["rsbsa_key"] for r in
        g.db.execute("SELECT rsbsa_key FROM farmers WHERE rsbsa_number IS NOT NULL AND rsbsa_number != ''").fetchall()
    }
    bgys = {r["name"].strip().upper(): r["id"] for r in g.db.execute("SELECT id, name FROM barangays").fetchall()}
    added, skipped = 0, 0
    now = db.now_iso()

    for p in persons:
        num = (p["rsbsa_number"] or "").strip().upper()
        if not num:
            skipped += 1
            continue
        key = db_id.rsbsa_key(num)
        if key in existing_keys:
            skipped += 1
            continue

        b_id = None
        addr = (p["address"] or "").upper()
        if p["barangay"]:
            b_id = bgys.get(p["barangay"].strip().upper())
        if not b_id and addr:
            for b_name, b_idx in bgys.items():
                if b_name in addr:
                    b_id = b_idx
                    break

        data_dict = {
            "FARMER_NAME": p["name"],
            "RSBSA_NUMBER": num,
            "CIVIL_STATUS": p["civil_status"] or "",
            "ADDRESS": p["address"] or "",
        }
        if p["gender"]:
            data_dict["GENDER"] = p["gender"]
        if p["birthdate"]:
            data_dict["BIRTHDATE"] = p["birthdate"]

        g.db.execute(
            "INSERT INTO farmers (rsbsa_key, rsbsa_number, name, civil_status, "
            "address, data_json, barangay_id, first_seen, last_seen, "
            "verification_status, verified_by, verified_at, photo_path, "
            "birthdate, contact_number, emergency_contact, blood_type, "
            "affiliated_fca, remarks, gender) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'verified', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (key, num, p["name"], p["civil_status"], p["address"],
             json.dumps(data_dict), b_id, now, now, g.user["id"], now,
             p["photo_path"], p["birthdate"], p["contact_number"],
             p["emergency_contact"], "", p["affiliated_fca"],
             p["remarks"] or "Active", p["gender"])
        )
        existing_keys.add(key)
        added += 1

    _audit("farmer.sync_from_id_db",
           f"Synced {added} farmer(s) from ID database into Farmer Masterlist; {skipped} duplicate/empty skipped")
    g.db.commit()
    return jsonify(ok=True, added=added, skipped=skipped)




# --------------------------------------------------------------------------- #
# Farmer's ID Card Maker (admin only; secretaries see the status only)
# --------------------------------------------------------------------------- #
def _fmt_long_date(iso):
    """'1980-01-05' -> 'Jan 5, 1980' (handles dates, date-times, and common formats; non-date text passes through)."""
    if not iso:
        return ""
    s = str(iso).strip()
    if not s:
        return ""
    # Try common formats
    for fmt in ("%Y-%m-%d", "%Y/%m/%d", "%m/%d/%Y", "%m-%d-%Y", "%d/%m/%Y", "%d-%m-%Y"):
        try:
            d = datetime.datetime.strptime(s[:10], fmt)
            return d.strftime("%b ") + str(d.day) + d.strftime(", %Y")
        except ValueError:
            pass
    try:
        # Fallback ISO parser
        d = datetime.date.fromisoformat(s[:10])
        return d.strftime("%b ") + str(d.day) + d.strftime(", %Y")
    except Exception:
        return s


def _org_line():
    settings = {r["key"]: r["value"] for r in
                g.db.execute("SELECT key, value FROM settings")}
    muni = (settings.get("municipality") or "Alcala").strip()
    prov = (settings.get("province") or "Cagayan").strip()
    if "dagupan" in muni.lower():
        muni = "Alcala"
    if "pangasinan" in prov.lower():
        prov = "Cagayan"
    return ", ".join(p for p in (muni, prov) if p) or "Alcala, Cagayan"


def _farmer_for_id(fid):
    return g.db.execute(
        "SELECT f.*, b.name AS barangay FROM farmers f "
        "LEFT JOIN barangays b ON b.id = f.barangay_id WHERE f.id = ?",
        (fid,)).fetchone()


def _latest_id_row(fid):
    return g.db.execute(
        "SELECT * FROM farmer_ids WHERE farmer_id = ? ORDER BY id DESC "
        "LIMIT 1", (fid,)).fetchone()


def _render_id_files(f, row):
    """(Re)generate the front/back PNGs + two-page PDF of an ID record."""
    photo = None
    if f["photo_path"]:
        p = os.path.join(db.INSTANCE_DIR, f["photo_path"])
        if os.path.exists(p):
            from PIL import Image
            photo = Image.open(p)
    fkeys = f.keys() if hasattr(f, "keys") else []
    gender = f["gender"] if "gender" in fkeys and f["gender"] else ""
    if not gender:
        try:
            d = json.loads(f["data_json"] or "{}")
            gender = d.get("GENDER") or d.get("SEX") or d.get("KASARIAN") or ""
        except Exception:
            pass
    bdate = f["birthdate"] if "birthdate" in fkeys and f["birthdate"] else ""
    if not bdate:
        try:
            d = json.loads(f["data_json"] or "{}")
            bdate = d.get("BIRTHDATE") or d.get("BIRTHDAY") or d.get("DATE_OF_BIRTH") or d.get("DOB") or ""
        except Exception:
            pass
    payload = {
        "name": f["name"], "rsbsa_number": f["rsbsa_number"] or "",
        "civil_status": f["civil_status"] or "",
        "address": f["address"] or "", "barangay": f["barangay"] or "",
        "gender": db_id.normalize_gender(gender) if gender else "",
        "birthdate": _fmt_long_date(bdate),
        "blood_type": f["blood_type"] or "",
        "emergency_contact": f["emergency_contact"] or "",
        "affiliated_fca": (f["affiliated_fca"] if "affiliated_fca" in fkeys else "") or "",
    }
    org = _org_line()
    front = idgen.render_front(payload, row["control_no"],
                               _fmt_long_date(row["valid_until"]), photo, org)
    back = idgen.render_back(payload, row["control_no"],
                             _fmt_long_date(row["issued_at"]),
                             _fmt_long_date(row["valid_until"]), org)
    base = row["control_no"]
    front.save(os.path.join(db.ID_CARDS_DIR, base + "_FRONT.png"),
               dpi=(idgen.DPI, idgen.DPI))
    back.save(os.path.join(db.ID_CARDS_DIR, base + "_BACK.png"),
              dpi=(idgen.DPI, idgen.DPI))
    with open(os.path.join(db.ID_CARDS_DIR, base + ".pdf"), "wb") as fh:
        fh.write(idgen.card_pdf(front, back))


@app.post("/api/farmers/<int:fid>/photo")
@admin_required
def upload_farmer_photo(fid):
    """Upload the farmer's ID photo (saved to the farmer profile)."""
    f = _farmer_for_id(fid)
    if f is None:
        return _err("Farmer not found.", 404)
    up = request.files.get("photo")
    if up is None or not up.filename:
        return _err("No photo file received.")
    ext = os.path.splitext(up.filename)[1].lower() or ".png"
    if ext not in (".jpg", ".jpeg", ".png", ".webp"):
        return _err("Photo must be a JPG, PNG, or WEBP image.")
    save_ext = ".png" if ext == ".webp" else ext
    rel = f"photos/farmer_{fid}{save_ext}"
    dest = os.path.join(db.INSTANCE_DIR, rel)
    up.save(dest)
    try:
        from PIL import Image
        with Image.open(dest) as im:
            rgb = im.convert("RGB")
        if ext == ".webp":
            rgb.save(dest, format="PNG")
    except Exception:
        if os.path.exists(dest):
            os.remove(dest)
        return _err("That file is not a readable image.")
    if f["photo_path"] and f["photo_path"] != rel:
        old_p = os.path.join(db.INSTANCE_DIR, f["photo_path"])
        if os.path.exists(old_p):
            os.remove(old_p)
    g.db.execute("UPDATE farmers SET photo_path = ? WHERE id = ?", (rel, fid))
    _audit("farmer.photo_upload",
           f"ID photo uploaded for farmer '{f['name']}' "
           f"(RSBSA {f['rsbsa_number'] or '—'})",
           barangay_id=f["barangay_id"])
    g.db.commit()
    if os.path.exists(db_id.ID_DB_PATH):
        try:
            conn_id = db_id.connect()
            try:
                p = conn_id.execute(
                    "SELECT id FROM id_persons WHERE source_farmer_id = ? OR "
                    "rsbsa_key = ?",
                    (fid, db_id.rsbsa_key(f["rsbsa_number"] or ""))).fetchone()
                if p:
                    conn_id.execute(
                        "UPDATE id_persons SET photo_path = ?, updated_at = ? "
                        "WHERE id = ?", (rel, db.now_iso(), p["id"]))
                    conn_id.commit()
            finally:
                conn_id.close()
        except Exception:
            pass
    return jsonify(ok=True, photo_url=f"/api/farmers/{fid}/photo")


@app.get("/api/farmers/<int:fid>/photo")
@login_required
def get_farmer_photo(fid):
    f = _farmer_for_id(fid)
    if f is None:
        return _err("Farmer not found.", 404)
    scope = _scope_barangay_id()
    if scope is not None and f["barangay_id"] != scope:
        return _err("This farmer belongs to another barangay.", 403)
    f_dict = dict(f)
    photo_rel = f_dict.get("photo_path")
    if not photo_rel or not os.path.exists(os.path.join(db.INSTANCE_DIR, photo_rel)):
        gen_p, _ = _id_person_for_farmer(f)
        if gen_p and gen_p.get("photo_path"):
            gen_rel = gen_p["photo_path"]
            if os.path.exists(os.path.join(db.INSTANCE_DIR, gen_rel)):
                photo_rel = gen_rel
    if not photo_rel:
        return _err("No photo uploaded yet.", 404)
    path = os.path.join(db.INSTANCE_DIR, photo_rel)
    if not os.path.exists(path):
        return _err("Photo file is missing.", 404)
    return send_file(path)


@app.post("/api/farmers/<int:fid>/id-card")
@admin_required
def issue_farmer_id(fid):
    """Issue (or reprint) the farmer's back-to-back Farmer's ID card.

    First generation creates the registry record with the next control
    number FID-YYYY-####; later generations are reprints that keep the
    same control number and validity, and simply bump the counter.
    """
    if idgen is None:
        return _err("The ID card maker is unavailable on this server "
                    "(missing qrcode/Pillow packages).", 503)
    f = _farmer_for_id(fid)
    if f is None:
        return _err("Farmer not found.", 404)
    if not f["rsbsa_number"]:
        return _err("This farmer has no RSBSA number yet — the QR code on "
                    "the ID needs one. Edit the record first.", 400)
    body = request.get_json(silent=True) or {}
    row = _latest_id_row(fid)
    if row is not None:
        g.db.execute(
            "UPDATE farmer_ids SET reprint_count = reprint_count + 1 "
            "WHERE id = ?", (row["id"],))
        g.db.commit()
        row = _latest_id_row(fid)
        _audit("farmer_id.reprint",
               f"Farmer's ID reprinted for '{f['name']}' "
               f"(RSBSA {f['rsbsa_number']}) — control no. "
               f"{row['control_no']}, reprint #{row['reprint_count']}",
               barangay_id=f["barangay_id"])
        g.db.commit()
    else:
        try:
            years = int(body.get("valid_years") or 3)
        except (TypeError, ValueError):
            years = 3
        years = max(1, min(years, 10))
        today = db.now_iso()[:10]
        issued = datetime.date.fromisoformat(today)
        try:
            valid = issued.replace(year=issued.year + years)
        except ValueError:  # Feb 29
            valid = issued.replace(year=issued.year + years, month=2, day=28)
        _idc = _id_conn()
        try:
            _sync_main_fid_seq(_idc)
        finally:
            _idc.close()
        g.db.commit()
        control = db.make_farmer_id_no(g.db)
        g.db.execute(
            "INSERT INTO farmer_ids (farmer_id, control_no, issued_at, "
            "valid_until, reprint_count, status, created_by) "
            "VALUES (?, ?, ?, ?, 0, 'active', ?)",
            (fid, control, today, valid.isoformat(), g.user["id"]))
        _audit("farmer_id.issue",
               f"Farmer's ID issued to '{f['name']}' "
               f"(RSBSA {f['rsbsa_number']}) — control no. {control}, "
               f"valid until {valid.isoformat()}",
               barangay_id=f["barangay_id"])
        g.db.commit()
        row = _latest_id_row(fid)
    f = _farmer_for_id(fid)
    try:
        _render_id_files(f, row)
    except Exception as exc:  # rendering failure must not lose the record
        return _err(f"ID record saved ({row['control_no']}) but rendering "
                    f"failed: {exc}", 500)
    return jsonify(
        ok=True, control_no=row["control_no"],
        issued_at=_fmt_long_date(row["issued_at"]),
        valid_until=_fmt_long_date(row["valid_until"]),
        reprints=row["reprint_count"],
        front_url=f"/api/farmers/{fid}/id-card/front",
        back_url=f"/api/farmers/{fid}/id-card/back",
        pdf_url=f"/api/farmers/{fid}/id-card/pdf")


@app.get("/api/farmers/<int:fid>/id-card/<kind>")
@admin_required
def download_farmer_id(fid, kind):
    row = _latest_id_row(fid)
    if row is None:
        return _err("No ID card has been issued for this farmer yet.", 404)
    names = {"front": row["control_no"] + "_FRONT.png",
             "back": row["control_no"] + "_BACK.png",
             "pdf": row["control_no"] + ".pdf"}
    if kind not in names:
        return _err("Unknown ID card file.", 404)
    path = os.path.join(db.ID_CARDS_DIR, names[kind])
    if not os.path.exists(path):
        return _err("ID card file is missing — generate the ID again.", 404)
    f = _farmer_for_id(fid)
    name_part = _safe_file_token(f["name"] if f else "FARMER", "FARMER")
    rsbsa_part = _safe_file_token(
        f["rsbsa_number"] if f else row["control_no"], "NO-RSBSA")
    suffix = {"front": "FRONT.png", "back": "BACK.png", "pdf": "ID.pdf"}[kind]
    return send_file(path, as_attachment=True,
                     download_name=f"{name_part}_{rsbsa_part}_{suffix}")



# --------------------------------------------------------------------------- #
# ID Card Generator — SEPARATE database (instance/id_generator.db)
#
# The generator keeps its own person records, independent from the
# certification Farmer Masterlist. Records arrive by (a) CSV upload with
# the ID-generation fields RSBSA Number / Farmer Name / Gender / Civil
# Status / Address / Birthdate / contacts (append-only: duplicate RSBSA
# Numbers are skipped and reported), or (b) copying selected farmers from
# the masterlist. Any blank ID detail and the photo are encoded per person
# in the generator. Admin only. Control numbers stay unique across this
# registry and the legacy masterlist registry.
# --------------------------------------------------------------------------- #
def _id_conn():
    db_id.init_db()
    return db_id.connect()


def _overlay_id_generator_status(rows):
    """Show ID-Generator card status on masterlist rows (by RSBSA)."""
    if not os.path.exists(db_id.ID_DB_PATH):
        return
    try:
        conn = db_id.connect()
        try:
            cards = {r["rsbsa_key"]: dict(r) for r in conn.execute(
                "SELECT p.rsbsa_key, p.id AS person_id, p.photo_path, c.control_no, "
                "c.valid_until, c.reprint_count FROM id_persons p "
                "LEFT JOIN id_cards c ON c.person_id = p.id").fetchall()}
        finally:
            conn.close()
    except Exception:
        return
    for r in rows:
        info = cards.get(db_id.rsbsa_key(r.get("rsbsa_number") or ""))
        if info:
            r["id_generator_person_id"] = info.get("person_id")
            if not r.get("photo_path") and info.get("photo_path"):
                r["photo_path"] = info["photo_path"]
            if info.get("control_no"):
                r["id_control_no"] = info["control_no"]
                r["id_valid_until"] = info["valid_until"]
                r["id_reprints"] = info["reprint_count"]


def _id_person_for_farmer(f):
    """(person, card) in the ID-Generator DB for a masterlist farmer."""
    if not os.path.exists(db_id.ID_DB_PATH):
        return None, None
    try:
        conn = db_id.connect()
        try:
            person = conn.execute(
                "SELECT * FROM id_persons WHERE source_farmer_id = ? OR "
                "rsbsa_key = ?", (f["id"], db_id.rsbsa_key(
                    f["rsbsa_number"] or ""))).fetchone()
            if person is None:
                return None, None
            card = conn.execute(
                "SELECT * FROM id_cards WHERE person_id = ?",
                (person["id"],)).fetchone()
            return (dict(person),
                    dict(card) if card is not None else None)
        finally:
            conn.close()
    except Exception:
        return None, None


def _fid_floor(conn_id):
    """Highest FID suffix already used this year in either registry."""
    year = datetime.datetime.now().strftime("%Y")
    prefix = f"FID-{year}-"
    floor = 0
    for tbl_conn, sql in (
            (g.db, "SELECT control_no FROM farmer_ids"),
            (conn_id, "SELECT control_no FROM id_cards")):
        try:
            for r in tbl_conn.execute(sql).fetchall():
                no = r["control_no"] or ""
                if no.startswith(prefix):
                    try:
                        floor = max(floor, int(no[len(prefix):]))
                    except ValueError:
                        pass
        except Exception:
            pass
    return floor


def _sync_main_fid_seq(conn_id):
    """Keep the legacy masterlist FID sequence ahead of both registries."""
    year = datetime.datetime.now().strftime("%Y")
    floor = _fid_floor(conn_id)
    row = g.db.execute("SELECT value FROM seq WHERE key = ?",
                       (f"fid:{year}",)).fetchone()
    if row is None:
        g.db.execute("INSERT INTO seq (key, value) VALUES (?, ?)",
                     (f"fid:{year}", floor))
    elif row["value"] < floor:
        g.db.execute("UPDATE seq SET value = ? WHERE key = ?",
                     (floor, f"fid:{year}"))


def _id_person_payload(p, card=None):
    pkeys = p.keys() if hasattr(p, "keys") else p
    ckeys = card.keys() if card and hasattr(card, "keys") else (card or {})
    return {
        "id": p["id"], "rsbsa_number": p["rsbsa_number"],
        "name": p["name"], "gender": p["gender"],
        "civil_status": p["civil_status"],
        "address": p["address"], "birthdate": p["birthdate"],
        "barangay": (p["barangay"] if "barangay" in pkeys else "") or "",
        "remarks": (p["remarks"] if "remarks" in pkeys else "Active") or "Active",
        "contact_number": p["contact_number"],
        "emergency_contact": p["emergency_contact"],
        "affiliated_fca": (p["affiliated_fca"] if "affiliated_fca" in pkeys else None),
        "has_photo": bool(p["photo_path"]), "source": p["source"],
        "created_at": p["created_at"], "updated_at": p["updated_at"],
        "id_control_no": card["control_no"] if card else None,
        "id_issued_at": card["issued_at"] if card else None,
        "id_valid_until": card["valid_until"] if card else None,
        "id_reprints": card["reprint_count"] if card else 0,
        "is_printed": bool(card["is_printed"]) if card and "is_printed" in ckeys else False,
        "printed_at": (card["printed_at"] if card and "printed_at" in ckeys else None),
    }


def _render_id_person_files(person, card):
    photo = None
    if person["photo_path"]:
        pth = os.path.join(db.INSTANCE_DIR, person["photo_path"])
        if os.path.exists(pth):
            from PIL import Image
            photo = Image.open(pth)
    pkeys = person.keys() if hasattr(person, "keys") else person
    gender = person["gender"] or ""
    bdate = person["birthdate"] or ""
    if not gender or not bdate:
        try:
            sf = None
            if person.get("source_farmer_id"):
                sf = g.db.execute("SELECT id, gender, birthdate, barangay_id, data_json FROM farmers WHERE id = ?",
                                  (person["source_farmer_id"],)).fetchone()
            if sf is None and person.get("rsbsa_number"):
                rkey = db_id.rsbsa_key(person["rsbsa_number"])
                sf = g.db.execute("SELECT id, gender, birthdate, barangay_id, data_json FROM farmers WHERE rsbsa_key = ?",
                                  (rkey,)).fetchone()
            if sf:
                if not gender:
                    gender = sf["gender"] or ""
                    if not gender:
                        try:
                            gender = json.loads(sf["data_json"] or "{}").get("GENDER") or ""
                        except Exception:
                            pass
                if not bdate:
                    bdate = sf["birthdate"] or ""
                    if not bdate:
                        try:
                            d = json.loads(sf["data_json"] or "{}")
                            bdate = d.get("BIRTHDATE") or d.get("BIRTHDAY") or d.get("DATE_OF_BIRTH") or ""
                        except Exception:
                            pass
                # If we retrieved gender or birthdate, keep id_persons up to date
                norm_gen = db_id.normalize_gender(gender) if gender else None
                if norm_gen or bdate:
                    conn = _id_conn()
                    try:
                        conn.execute("UPDATE id_persons SET gender = COALESCE(?, gender), "
                                     "birthdate = COALESCE(?, birthdate), "
                                     "source_farmer_id = COALESCE(?, source_farmer_id) WHERE id = ?",
                                     (norm_gen, bdate or None, sf["id"], person["id"]))
                        conn.commit()
                    finally:
                        conn.close()
        except Exception:
            pass
    bgy_val = (person["barangay"] if "barangay" in pkeys else "") or ""
    if not bgy_val:
        if sf and sf["barangay_id"]:
            brow = g.db.execute("SELECT name FROM barangays WHERE id = ?", (sf["barangay_id"],)).fetchone()
            if brow:
                bgy_val = brow["name"]
        if not bgy_val and person["address"]:
            for bname in [r["name"] for r in g.db.execute("SELECT name FROM barangays").fetchall()]:
                if bname.upper() in person["address"].upper():
                    bgy_val = bname
                    break
    payload = {
        "name": person["name"], "rsbsa_number": person["rsbsa_number"] or "",
        "civil_status": person["civil_status"] or "",
        "address": person["address"] or "",
        "barangay": bgy_val,
        "gender": db_id.normalize_gender(gender) if gender else "",
        "birthdate": _fmt_long_date(bdate),
        "blood_type": "",
        "emergency_contact": person["emergency_contact"] or "",
        "affiliated_fca": (person["affiliated_fca"] if "affiliated_fca" in pkeys else "") or "",
    }
    org = _org_line()
    front = idgen.render_front(payload, card["control_no"],
                               _fmt_long_date(card["valid_until"]), photo, org)
    back = idgen.render_back(payload, card["control_no"],
                             _fmt_long_date(card["issued_at"]),
                             _fmt_long_date(card["valid_until"]), org)
    base = card["control_no"]
    front.save(os.path.join(db.ID_CARDS_DIR, base + "_FRONT.png"),
               dpi=(idgen.DPI, idgen.DPI))
    back.save(os.path.join(db.ID_CARDS_DIR, base + "_BACK.png"),
              dpi=(idgen.DPI, idgen.DPI))
    with open(os.path.join(db.ID_CARDS_DIR, base + ".pdf"), "wb") as fh:
        fh.write(idgen.card_pdf(front, back))


@app.get("/api/id-generator/template.csv")
@admin_required
def idgen_template_csv():
    buf = io.StringIO()
    buf.write("RSBSA Number,Farmer Name,Gender,Civil Status,Address,"
              "Birthdate,Contact Number,"
              "Contact Person in Case of Emergency,Affiliated FCA\r\n")
    buf.write("02-015-02-014-EFMN47,JUAN DELA CRUZ,MALE,MARRIED,"
              "PUROK 1 JURISDICCION ALCALA CAGAYAN,1990-01-15,0917 123 4567,"
              "MARIA DELA CRUZ - 0917 123 4567,ALCALA FARMERS COOPERATIVE\r\n")
    return send_file(io.BytesIO(buf.getvalue().encode("utf-8-sig")),
                     mimetype="text/csv", as_attachment=True,
                     download_name="id_database_template.csv")


@app.get("/api/fcas")
@login_required
def list_fcas_api():
    conn = _id_conn()
    try:
        rows = db_id.list_fcas(conn)
        conn.commit()
        return jsonify(fcas=rows, names=[r["name"] for r in rows])
    finally:
        conn.close()


@app.get("/api/admin/fcas")
@admin_required
def admin_list_fcas():
    conn = _id_conn()
    try:
        rows = db_id.list_fcas(conn)
        conn.commit()
        return jsonify(rows)
    finally:
        conn.close()


@app.post("/api/admin/fcas")
@admin_required
def admin_add_fca():
    body = request.get_json(silent=True) or {}
    name = db_id.normalize_fca(body.get("name"))
    if not name:
        return _err("FCA name is required.")
    conn = _id_conn()
    try:
        if conn.execute("SELECT 1 FROM fca_list WHERE name = ?", (name,)).fetchone():
            return _err(f"FCA '{name}' is already in the list.", 409)
        cur = conn.execute(
            "INSERT INTO fca_list (name, created_at) VALUES (?, ?)",
            (name, db.now_iso()))
        conn.commit()
        fid = cur.lastrowid
    finally:
        conn.close()
    _audit("fca.create", f"Affiliated FCA '{name}' added")
    g.db.commit()
    return jsonify(ok=True, id=fid, name=name), 201


@app.put("/api/admin/fcas/<int:fid>")
@admin_required
def admin_update_fca(fid):
    body = request.get_json(silent=True) or {}
    new_name = db_id.normalize_fca(body.get("name"))
    if not new_name:
        return _err("FCA name is required.")
    conn = _id_conn()
    try:
        row = conn.execute("SELECT * FROM fca_list WHERE id = ?", (fid,)).fetchone()
        if row is None:
            return _err("FCA not found.", 404)
        old_name = row["name"]
        clash = conn.execute(
            "SELECT id FROM fca_list WHERE name = ? AND id <> ?",
            (new_name, fid)).fetchone()
        if clash:
            return _err(f"Another FCA entry is already named '{new_name}'.", 409)
        conn.execute("UPDATE fca_list SET name = ? WHERE id = ?", (new_name, fid))
        conn.execute(
            "UPDATE id_persons SET affiliated_fca = ?, updated_at = ? "
            "WHERE affiliated_fca = ?",
            (new_name, db.now_iso(), old_name))
        conn.commit()
    finally:
        conn.close()
    g.db.execute(
        "UPDATE farmers SET affiliated_fca = ? WHERE affiliated_fca = ?",
        (new_name, old_name))
    _audit("fca.update", f"Affiliated FCA renamed: '{old_name}' → '{new_name}'")
    g.db.commit()
    return jsonify(ok=True, id=fid, name=new_name)


@app.delete("/api/admin/fcas/<int:fid>")
@admin_required
def admin_delete_fca(fid):
    conn = _id_conn()
    try:
        row = conn.execute("SELECT * FROM fca_list WHERE id = ?", (fid,)).fetchone()
        if row is None:
            return _err("FCA not found.", 404)
        name = row["name"]
        conn.execute("DELETE FROM fca_list WHERE id = ?", (fid,))
        conn.commit()
    finally:
        conn.close()
    _audit("fca.delete", f"Affiliated FCA '{name}' removed from saved list")
    g.db.commit()
    return jsonify(ok=True)


def _sync_missing_id_barangays(conn):
    """Backfill missing barangay in id_persons from Masterlist farmers table or address."""
    try:
        missing = conn.execute(
            "SELECT id, rsbsa_key, rsbsa_number, address, source_farmer_id FROM id_persons "
            "WHERE barangay IS NULL OR TRIM(barangay) = ''"
        ).fetchall()
        if not missing:
            return

        bgy_rows = g.db.execute("SELECT id, name FROM barangays").fetchall()
        bgy_by_id = {r["id"]: r["name"].strip() for r in bgy_rows}
        bgy_names = [r["name"].strip() for r in bgy_rows]

        updates = []
        for p in missing:
            bname = None
            if p["source_farmer_id"]:
                frow = g.db.execute("SELECT barangay_id FROM farmers WHERE id = ?", (p["source_farmer_id"],)).fetchone()
                if frow and frow["barangay_id"] and frow["barangay_id"] in bgy_by_id:
                    bname = bgy_by_id[frow["barangay_id"]]

            if not bname and (p["rsbsa_key"] or p["rsbsa_number"]):
                key = p["rsbsa_key"] or db_id.rsbsa_key(p["rsbsa_number"])
                frow = g.db.execute("SELECT barangay_id FROM farmers WHERE rsbsa_key = ? OR rsbsa_number = ?",
                                    (key, p["rsbsa_number"])).fetchone()
                if frow and frow["barangay_id"] and frow["barangay_id"] in bgy_by_id:
                    bname = bgy_by_id[frow["barangay_id"]]

            if not bname and p["address"]:
                addr_upper = p["address"].upper()
                for bn in bgy_names:
                    if bn.upper() in addr_upper:
                        bname = bn
                        break

            if bname:
                updates.append((bname, p["id"]))

        if updates:
            conn.executemany("UPDATE id_persons SET barangay = ? WHERE id = ?", updates)
            conn.commit()
    except Exception:
        pass


@app.get("/api/id-generator/persons")
@admin_required
def idgen_persons():
    q = (request.args.get("q") or "").strip()
    bgy = (request.args.get("barangay") or "").strip()
    rem = (request.args.get("remarks") or "").strip()
    printed = request.args.get("printed")
    id_status = (request.args.get("id_status") or "").strip().lower()
    page = request.args.get("page", type=int) or 1
    limit = request.args.get("limit")

    conn = _id_conn()
    try:
        _sync_missing_id_barangays(conn)
        where = ["1=1"]
        params = []
        if q:
            where.append("(LOWER(p.name) LIKE ? OR LOWER(p.rsbsa_number) LIKE ? OR LOWER(COALESCE(p.gender, '')) LIKE ? OR LOWER(COALESCE(p.affiliated_fca, '')) LIKE ?)")
            like_q = f"%{q.lower()}%"
            params.extend([like_q, like_q, like_q, like_q])
        if bgy:
            where.append("(LOWER(COALESCE(p.barangay, '')) LIKE ? OR LOWER(COALESCE(p.address, '')) LIKE ?)")
            like_bgy = f"%{bgy.lower()}%"
            params.extend([like_bgy, like_bgy])
        if rem:
            where.append("COALESCE(p.remarks, 'Active') = ?")
            params.append(rem)
        if id_status in ("generated", "1"):
            where.append("c.control_no IS NOT NULL")
        elif id_status in ("not_generated", "not yet generated", "not_yet_generated", "0"):
            where.append("c.control_no IS NULL")
        if printed == "1":
            where.append("c.is_printed = 1")
        elif printed == "0":
            where.append("(c.control_no IS NOT NULL AND (c.is_printed = 0 OR c.is_printed IS NULL))")

        where_clause = " AND ".join(where)
        count_sql = f"SELECT COUNT(*) AS n FROM id_persons p LEFT JOIN id_cards c ON c.person_id = p.id WHERE {where_clause}"
        filtered_count = conn.execute(count_sql, params).fetchone()["n"]

        sql = f"""
            SELECT p.*, c.control_no, c.issued_at AS card_issued,
                   c.valid_until AS card_valid, c.reprint_count, c.is_printed, c.printed_at
            FROM id_persons p
            LEFT JOIN id_cards c ON c.person_id = p.id
            WHERE {where_clause}
            ORDER BY p.name ASC
        """
        exec_params = list(params)
        limit_val = None
        if limit and limit != "all":
            try:
                limit_val = int(limit)
                offset_val = (page - 1) * limit_val
                sql += " LIMIT ? OFFSET ?"
                exec_params.extend([limit_val, offset_val])
            except ValueError:
                pass

        rows = conn.execute(sql, exec_params).fetchall()
        out = []
        for p in rows:
            card = None
            if p["control_no"]:
                card = {
                    "control_no": p["control_no"],
                    "issued_at": p["card_issued"],
                    "valid_until": p["card_valid"],
                    "reprint_count": p["reprint_count"],
                    "is_printed": p["is_printed"],
                    "printed_at": p["printed_at"],
                }
            out.append(_id_person_payload(p, card))

        total_all = conn.execute("SELECT COUNT(*) AS n FROM id_persons").fetchone()["n"]
        issued = conn.execute("SELECT COUNT(*) AS n FROM id_cards").fetchone()["n"]
        return jsonify(
            persons=out,
            total=filtered_count,
            total_all=total_all,
            issued=issued,
            page=page,
            limit=limit_val if limit_val else len(out),
            total_pages=max(1, (filtered_count + (limit_val or 1) - 1) // (limit_val or 1)) if limit_val else 1,
        )
    finally:
        conn.close()


@app.get("/api/id-generator/persons/<int:pid>")
@admin_required
def idgen_person(pid):
    conn = _id_conn()
    try:
        p = conn.execute("SELECT * FROM id_persons WHERE id = ?",
                         (pid,)).fetchone()
        if p is None:
            return _err("ID record not found.", 404)
        if not (p["barangay"] if "barangay" in p.keys() else ""):
            _sync_missing_id_barangays(conn)
            p = conn.execute("SELECT * FROM id_persons WHERE id = ?",
                             (pid,)).fetchone()
        card = conn.execute("SELECT * FROM id_cards WHERE person_id = ?",
                            (pid,)).fetchone()
        return jsonify(_id_person_payload(p, dict(card) if card else None))
    finally:
        conn.close()


@app.put("/api/id-generator/persons/<int:pid>")
@admin_required
def idgen_person_update(pid):
    body = request.get_json(silent=True) or {}
    conn = _id_conn()
    try:
        p = conn.execute("SELECT * FROM id_persons WHERE id = ?",
                         (pid,)).fetchone()
        if p is None:
            return _err("ID record not found.", 404)
        name = (body.get("name") or "").strip().upper() if "name" in body else p["name"]
        if not name:
            return _err("Farmer name is required.")
        rsbsa_number = (body.get("rsbsa_number") or "").strip().upper() if "rsbsa_number" in body else p["rsbsa_number"]
        if not rsbsa_number:
            return _err("RSBSA number is required.")
        new_key = db_id.rsbsa_key(rsbsa_number)
        if new_key != p["rsbsa_key"]:
            conflict = conn.execute("SELECT id FROM id_persons WHERE rsbsa_key = ? AND id != ?", (new_key, pid)).fetchone()
            if conflict:
                return _err(f"Another person with RSBSA {rsbsa_number} already exists in the ID database.", 409)

        birthdate = (body.get("birthdate") or "").strip()
        if birthdate:
            parsed_bdate = None
            for fmt in ("%Y-%m-%d", "%m/%d/%Y", "%m-%d-%Y", "%d/%m/%Y", "%d-%m-%Y"):
                try:
                    parsed_bdate = datetime.datetime.strptime(birthdate[:10], fmt).date()
                    break
                except ValueError:
                    pass
            if parsed_bdate is None:
                return _err("Birthdate must be a valid date in MM/DD/YYYY format.")
            birthdate = parsed_bdate.isoformat()
        gender = db_id.normalize_gender(body.get("gender")) if "gender" in body else p["gender"]
        fca = db_id.remember_fca(
            conn, body.get("affiliated_fca")
            if "affiliated_fca" in body else p["affiliated_fca"])
        barangay = (body.get("barangay") or "").strip() if "barangay" in body else (p["barangay"] if "barangay" in p.keys() else "")
        remarks = (body.get("remarks") or "").strip() if "remarks" in body else (p["remarks"] if "remarks" in p.keys() and p["remarks"] else "Active")
        if not remarks:
            remarks = (p["remarks"] if "remarks" in p.keys() and p["remarks"] else "Active")
        conn.execute(
            "UPDATE id_persons SET name = ?, rsbsa_key = ?, rsbsa_number = ?, gender = ?, civil_status = ?, "
            "address = ?, birthdate = ?, contact_number = ?, "
            "emergency_contact = ?, affiliated_fca = ?, barangay = ?, remarks = ?, updated_at = ? "
            "WHERE id = ?",
            (name, new_key, rsbsa_number,
             gender or None,
             db_id.normalize_civil_status(body.get("civil_status")) if "civil_status" in body else p["civil_status"],
             (body.get("address") or "").strip().upper() if "address" in body else p["address"],
             birthdate or None if "birthdate" in body else p["birthdate"],
             (body.get("contact_number") or "").strip() if "contact_number" in body else p["contact_number"],
             (body.get("emergency_contact") or "").strip().upper() if "emergency_contact" in body else p["emergency_contact"],
             fca or None,
             barangay or None,
             remarks,
             db.now_iso(), pid))
        conn.commit()

        if "barangay" in body:
            b_id = None
            if barangay:
                b_row = g.db.execute("SELECT id FROM barangays WHERE UPPER(TRIM(name)) = UPPER(TRIM(?))", (barangay,)).fetchone()
                if b_row:
                    b_id = b_row["id"]
            if p["source_farmer_id"]:
                g.db.execute("UPDATE farmers SET barangay_id = ? WHERE id = ?", (b_id, p["source_farmer_id"]))
            g.db.execute("UPDATE farmers SET barangay_id = ? WHERE rsbsa_key = ? OR rsbsa_number = ?", (b_id, new_key, rsbsa_number))
            g.db.commit()

        if "rsbsa_number" in body:
            if p["source_farmer_id"]:
                g.db.execute("UPDATE farmers SET rsbsa_number = ?, rsbsa_key = ? WHERE id = ?", (rsbsa_number, new_key, p["source_farmer_id"]))
            g.db.commit()

        p = conn.execute("SELECT * FROM id_persons WHERE id = ?",
                         (pid,)).fetchone()
        card = conn.execute("SELECT * FROM id_cards WHERE person_id = ?",
                            (pid,)).fetchone()
        _audit("id_db.update",
               f"ID Generator record updated for '{p['name']}' "
               f"(RSBSA {p['rsbsa_number']})")
        g.db.commit()
        return jsonify(_id_person_payload(p, dict(card) if card else None))
    finally:
        conn.close()


@app.post("/api/id-generator/persons/<int:pid>/photo")
@admin_required
def idgen_person_photo_upload(pid):
    conn = _id_conn()
    try:
        p = conn.execute("SELECT * FROM id_persons WHERE id = ?",
                         (pid,)).fetchone()
        if p is None:
            return _err("ID record not found.", 404)
        up = request.files.get("photo")
        if up is None or not up.filename:
            return _err("No photo file received.")
        ext = os.path.splitext(up.filename)[1].lower() or ".png"
        if ext not in (".jpg", ".jpeg", ".png", ".webp"):
            return _err("Photo must be a JPG, PNG, or WEBP image.")
        save_ext = ".png" if ext == ".webp" else ext
        rel = f"photos/id_person_{pid}{save_ext}"
        dest = os.path.join(db.INSTANCE_DIR, rel)
        up.save(dest)
        try:
            from PIL import Image
            with Image.open(dest) as im:
                rgb = im.convert("RGB")
            if ext == ".webp":
                rgb.save(dest, format="PNG")
        except Exception:
            if os.path.exists(dest):
                os.remove(dest)
            return _err("That file is not a readable image.")
        if p["photo_path"] and p["photo_path"] != rel \
                and p["photo_path"].startswith("photos/id_person_"):
            old = os.path.join(db.INSTANCE_DIR, p["photo_path"])
            if os.path.exists(old):
                os.remove(old)
        conn.execute("UPDATE id_persons SET photo_path = ?, updated_at = ? "
                     "WHERE id = ?", (rel, db.now_iso(), pid))
        conn.commit()
        if p["source_farmer_id"] or p["rsbsa_number"]:
            try:
                g.db.execute(
                    "UPDATE farmers SET photo_path = ? WHERE id = ? OR "
                    "(rsbsa_number = ? AND rsbsa_number != '')",
                    (rel, p["source_farmer_id"] or -1, p["rsbsa_number"]))
                g.db.commit()
            except Exception:
                pass
        _audit("id_db.photo_upload",
               f"ID photo uploaded for '{p['name']}' "
               f"(RSBSA {p['rsbsa_number']}) in the ID Generator database")
        g.db.commit()
        return jsonify(ok=True, photo_path=rel)
    finally:
        conn.close()


@app.get("/api/id-generator/persons/<int:pid>/photo")
@admin_required
def idgen_person_photo(pid):
    conn = _id_conn()
    try:
        p = conn.execute("SELECT * FROM id_persons WHERE id = ?",
                         (pid,)).fetchone()
        if p is None or not p["photo_path"]:
            return _err("No photo uploaded yet.", 404)
        path = os.path.join(db.INSTANCE_DIR, p["photo_path"])
        if not os.path.exists(path):
            return _err("Photo file is missing.", 404)
        return send_file(path)
    finally:
        conn.close()


@app.post("/api/id-generator/import-csv")
@admin_required
def idgen_import_csv():
    import csv as _csv
    up = request.files.get("file")
    if up is None or not up.filename:
        return _err("Choose a CSV file to upload.")
    if not up.filename.lower().endswith(".csv"):
        return _err("Please upload a .csv file.")
    raw = up.read()
    if len(raw) > 20 * 1024 * 1024:
        return _err("CSV file is too large (max 20 MB).")
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        return _err("CSV must be UTF-8 encoded (save it as CSV UTF-8).")
    reader = _csv.DictReader(io.StringIO(text))
    if not reader.fieldnames:
        return _err("The CSV has no header row.")

    def _norm(h):
        return "".join(ch for ch in (h or "").lower() if ch.isalnum())

    aliases = {
        "rsbsa_number": {"rsbsanumber", "rsbsano", "rsbsa", "rsbsaid"},
        "name": {"farmername", "name", "fullname", "farmer"},
        "gender": {"gender", "sex", "kasarian"},
        "civil_status": {"civilstatus", "civil"},
        "address": {"address", "homeaddress", "farmeraddress",
                    "residentialaddress"},
        "barangay": {"barangay", "brgy", "bgy"},
        "remarks": {"remarks", "status", "farmerstatus", "remark"},
        "birthdate": {"birthdate", "dateofbirth", "dob", "birthday"},
        "contact_number": {"contactnumber", "contact", "contactno",
                           "mobilenumber", "mobile", "phonenumber",
                           "cellphonenumber"},
        "emergency_contact": {"emergencycontact",
                              "emergencycontactperson",
                              "contactpersonincaseofemergency",
                              "contactpersoninemergency",
                              "incaseofemergency"},
        "affiliated_fca": {"affiliatedfca", "fca", "fcaname",
                           "farmerscooperative", "association",
                           "farmerassociation"},
    }
    required = ("rsbsa_number", "name")
    colmap = {}
    for fn in reader.fieldnames:
        n = _norm(fn)
        for key, names in aliases.items():
            if n in names and key not in colmap:
                colmap[key] = fn
    missing = [k for k in required if k not in colmap]
    if missing:
        return _err("CSV must include RSBSA Number and Farmer Name. "
                    "Download the template CSV for the full ID fields: "
                    "Gender, Civil Status, Address, Barangay, Remarks, Birthdate, Contact "
                    "Number, and Contact Person in Case of Emergency.")
    def _csv_value(row, key):
        col = colmap.get(key)
        return (row.get(col) or "").strip() if col else ""

    bgy_rows = g.db.execute("SELECT id, name FROM barangays").fetchall()
    bgy_lookup = {r["name"].strip().upper(): r["id"] for r in bgy_rows}

    conn = _id_conn()
    try:
        existing = {r["rsbsa_key"] for r in
                    conn.execute("SELECT rsbsa_key FROM id_persons")}
        added, duplicates, invalid = [], [], []
        seen_file = set()
        for i, row in enumerate(reader, start=2):
            if len(added) + len(duplicates) + len(invalid) > 10000:
                return _err("Too many rows (max 10,000 per upload).")
            rsbsa = (row.get(colmap["rsbsa_number"]) or "").strip().upper()
            name = (row.get(colmap["name"]) or "").strip().upper()
            if not rsbsa or not name:
                invalid.append({"row": i, "reason":
                                "Missing RSBSA Number or Farmer Name"})
                continue
            key = db_id.rsbsa_key(rsbsa)
            if key in existing or key in seen_file:
                duplicates.append({"row": i, "rsbsa": rsbsa, "name": name})
                continue
            gender = db_id.normalize_gender(_csv_value(row, "gender"))
            civil_status = db_id.normalize_civil_status(
                _csv_value(row, "civil_status"))
            address = _csv_value(row, "address").upper()
            barangay = _csv_value(row, "barangay").strip().upper()
            remarks = _csv_value(row, "remarks").strip() or "Active"
            if not barangay and address:
                for bname in bgy_lookup:
                    if bname in address:
                        barangay = bname
                        break
            birthdate_raw = _csv_value(row, "birthdate")
            birthdate = None
            if birthdate_raw:
                parsed_date = None
                for fmt in ("%Y-%m-%d", "%m/%d/%Y", "%m-%d-%Y", "%d/%m/%Y", "%d-%m-%Y"):
                    try:
                        parsed_date = datetime.datetime.strptime(
                            birthdate_raw, fmt).date()
                        break
                    except ValueError:
                        pass
                if parsed_date is None:
                    invalid.append({
                        "row": i,
                        "reason": "Invalid Birthdate "
                                  f"'{birthdate_raw}' (use YYYY-MM-DD)"})
                    continue
                birthdate = parsed_date.isoformat()
            contact_number = _csv_value(row, "contact_number")
            emergency_contact = _csv_value(row, "emergency_contact").upper()
            affiliated_fca = db_id.remember_fca(
                conn, _csv_value(row, "affiliated_fca"))
            now = db.now_iso()
            conn.execute(
                "INSERT INTO id_persons (rsbsa_key, rsbsa_number, name, "
                "gender, civil_status, address, birthdate, contact_number, "
                "emergency_contact, affiliated_fca, barangay, remarks, source, created_at, updated_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'csv', ?, ?)",
                (key, rsbsa, name, gender or None, civil_status,
                 address, birthdate, contact_number, emergency_contact,
                 affiliated_fca or None, barangay or None, remarks, now, now))
            seen_file.add(key)
            added.append({"row": i, "rsbsa": rsbsa, "name": name})

            # Also sync into Farmer Masterlist with status 'verified' and detect duplicate
            bgy_id = bgy_lookup.get(barangay) if barangay else None
            existing_f = g.db.execute("SELECT id FROM farmers WHERE rsbsa_key = ?", (key,)).fetchone()
            if existing_f:
                g.db.execute(
                    "UPDATE farmers SET verification_status = 'verified', "
                    "remarks = COALESCE(?, remarks), "
                    "gender = COALESCE(?, gender), "
                    "birthdate = COALESCE(?, birthdate), "
                    "barangay_id = COALESCE(?, barangay_id), "
                    "last_seen = ? WHERE id = ?",
                    (remarks, gender or None, birthdate or None, bgy_id, now, existing_f["id"]))
            else:
                g.db.execute(
                    "INSERT INTO farmers (rsbsa_key, rsbsa_number, name, gender, civil_status, "
                    "address, birthdate, contact_number, emergency_contact, affiliated_fca, "
                    "barangay_id, remarks, verification_status, first_seen, last_seen) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'verified', ?, ?)",
                    (key, rsbsa, name, gender or None, civil_status,
                     address, birthdate, contact_number, emergency_contact,
                     affiliated_fca or None, bgy_id, remarks, now, now))
        conn.commit()
    finally:
        conn.close()
    _audit("databases.csv_import",
           f"Databases CSV upload '{up.filename}': {len(added)} added to both ID Generator and Masterlist (verified), "
           f"{len(duplicates)} duplicate(s) skipped, "
           f"{len(invalid)} invalid row(s) skipped")
    g.db.commit()
    return jsonify(ok=True, added=len(added), duplicates=len(duplicates),
                   invalid=len(invalid),
                   duplicate_rows=duplicates[:50], invalid_rows=invalid[:50])


@app.get("/api/id-generator/masterlist-candidates")
@admin_required
def idgen_candidates():
    q = (request.args.get("q") or "").strip()
    conn = _id_conn()
    try:
        keys = {r["rsbsa_key"]: r["id"] for r in conn.execute(
            "SELECT rsbsa_key, id FROM id_persons").fetchall()}
    finally:
        conn.close()
    sql = "SELECT f.id, f.name, f.rsbsa_number, f.gender, f.data_json FROM farmers f"
    args = []
    if q:
        sql += " WHERE f.name LIKE ? OR f.rsbsa_number LIKE ?"
        args += [f"%{q}%", f"%{q}%"]
    sql += " ORDER BY f.name LIMIT 300"
    out = []
    for f in g.db.execute(sql, args).fetchall():
        pid = keys.get(db_id.rsbsa_key(f["rsbsa_number"] or ""))
        gen = f["gender"] or ""
        if not gen:
            try:
                gen = json.loads(f["data_json"] or "{}").get("GENDER") or ""
            except Exception:
                pass
        out.append({"farmer_id": f["id"], "name": f["name"],
                    "rsbsa_number": f["rsbsa_number"],
                    "gender": db_id.normalize_gender(gen) if gen else None,
                    "in_id_db": pid is not None, "id_person_id": pid})
    return jsonify(out)


@app.post("/api/id-generator/copy-masterlist")
@admin_required
def idgen_copy_masterlist():
    body = request.get_json(silent=True) or {}
    ids = body.get("farmer_ids") or []
    try:
        ids = [int(x) for x in ids][:500]
    except (TypeError, ValueError):
        return _err("Invalid farmer selection.")
    if not ids:
        return _err("Select at least one farmer to copy.")
    conn = _id_conn()
    added, skipped = [], []
    try:
        for fid in ids:
            f_row = g.db.execute(
                "SELECT f.* FROM farmers f WHERE f.id = ?",
                (fid,)).fetchone()
            if f_row is None:
                skipped.append({"farmer_id": fid, "reason": "Not found"})
                continue
            f = dict(f_row)
            rsbsa = (f.get("rsbsa_number") or "").strip().upper()
            if not rsbsa:
                skipped.append({"farmer_id": fid, "name": f.get("name"),
                                "reason": "No RSBSA Number"})
                continue
            if db_id.find_person_by_rsbsa(conn, rsbsa) is not None:
                skipped.append({"farmer_id": fid, "name": f.get("name"),
                                "rsbsa": rsbsa, "reason": "Already in ID database"})
                continue
            now = db.now_iso()
            gen_val = f.get("gender") or ""
            bdate_val = f.get("birthdate") or ""
            if not gen_val or not bdate_val:
                try:
                    d = json.loads(f.get("data_json") or "{}")
                    if not gen_val:
                        gen_val = d.get("GENDER") or d.get("SEX") or d.get("KASARIAN") or ""
                    if not bdate_val:
                        bdate_val = d.get("BIRTHDATE") or d.get("BIRTHDAY") or d.get("DATE_OF_BIRTH") or d.get("DOB") or ""
                except Exception:
                    pass
            norm_gen = db_id.normalize_gender(gen_val) if gen_val else None
            # Lookup barangay name
            bgy_name = None
            if f.get("barangay_id"):
                brow = g.db.execute("SELECT name FROM barangays WHERE id = ?", (f["barangay_id"],)).fetchone()
                if brow:
                    bgy_name = brow["name"]
            fca_val = db_id.remember_fca(
                conn, f.get("affiliated_fca") or "")
            cur = conn.execute(
                "INSERT INTO id_persons (rsbsa_key, rsbsa_number, name, "
                "gender, civil_status, address, birthdate, contact_number, "
                "emergency_contact, affiliated_fca, barangay, photo_path, source, "
                "source_farmer_id, created_at, updated_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'masterlist', ?, ?, ?)",
                (db_id.rsbsa_key(rsbsa), rsbsa, f.get("name"), norm_gen,
                 db_id.normalize_civil_status(f.get("civil_status")),
                 f.get("address"), bdate_val or None,
                 f.get("contact_number"), f.get("emergency_contact"),
                 fca_val or None, bgy_name, None, fid, now, now))
            pid = cur.lastrowid
            if f.get("photo_path"):
                src = os.path.join(db.INSTANCE_DIR, f["photo_path"])
                if os.path.exists(src):
                    ext = os.path.splitext(src)[1].lower() or ".jpg"
                    rel = f"photos/id_person_{pid}{ext}"
                    try:
                        shutil.copyfile(src, os.path.join(db.INSTANCE_DIR, rel))
                        conn.execute("UPDATE id_persons SET photo_path = ? "
                                     "WHERE id = ?", (rel, pid))
                    except Exception:
                        pass
            added.append({"farmer_id": fid, "id_person_id": pid,
                          "name": f.get("name"), "rsbsa": rsbsa})
        conn.commit()
    finally:
        conn.close()
    _audit("id_db.copy_masterlist",
           f"Copied {len(added)} farmer(s) from the masterlist into the "
           f"ID Generator database; {len(skipped)} skipped")
    g.db.commit()
    return jsonify(ok=True, added=added, skipped=skipped,
                   added_count=len(added), skipped_count=len(skipped))


@app.post("/api/id-generator/persons/<int:pid>/id-card")
@admin_required
def idgen_issue_card(pid):
    if idgen is None:
        return _err("The ID card maker is unavailable on this server "
                    "(missing qrcode/Pillow packages).", 503)
    body = request.get_json(silent=True) or {}
    conn = _id_conn()
    try:
        p = conn.execute("SELECT * FROM id_persons WHERE id = ?",
                         (pid,)).fetchone()
        if p is None:
            return _err("ID record not found.", 404)
        card = conn.execute("SELECT * FROM id_cards WHERE person_id = ?",
                            (pid,)).fetchone()
        if card is not None:
            conn.execute("UPDATE id_cards SET reprint_count = reprint_count + 1 "
                         "WHERE id = ?", (card["id"],))
            conn.commit()
            card = conn.execute("SELECT * FROM id_cards WHERE id = ?",
                                (card["id"],)).fetchone()
            action = "id_card.reprint"
        else:
            try:
                years = int(body.get("valid_years") or 3)
            except (TypeError, ValueError):
                years = 3
            years = max(1, min(years, 10))
            today = db.now_iso()[:10]
            issued = datetime.date.fromisoformat(today)
            try:
                valid = issued.replace(year=issued.year + years)
            except ValueError:
                valid = issued.replace(year=issued.year + years, month=2, day=28)
            control = db_id.next_fid(conn, _fid_floor(conn))
            cur = conn.execute(
                "INSERT INTO id_cards (person_id, control_no, issued_at, "
                "valid_until, reprint_count, status, created_by) "
                "VALUES (?, ?, ?, ?, 0, 'active', ?)",
                (pid, control, today, valid.isoformat(), g.user["id"]))
            conn.commit()
            card = conn.execute("SELECT * FROM id_cards WHERE id = ?",
                                (cur.lastrowid,)).fetchone()
            action = "id_card.issue"
        p = conn.execute("SELECT * FROM id_persons WHERE id = ?",
                         (pid,)).fetchone()
        try:
            _render_id_person_files(dict(p), dict(card))
        except Exception as exc:
            return _err(f"ID record saved ({card['control_no']}) but "
                        f"rendering failed: {exc}", 500)
        _audit(action,
               f"Farmer's ID {'reprinted' if action.endswith('reprint') else 'issued'} "
               f"for '{p['name']}' (RSBSA {p['rsbsa_number']}) from the ID "
               f"Generator database — control no. {card['control_no']}, "
               f"reprint #{card['reprint_count']}")
        g.db.commit()
        return jsonify(
            ok=True, control_no=card["control_no"],
            issued_at=_fmt_long_date(card["issued_at"]),
            valid_until=_fmt_long_date(card["valid_until"]),
            reprints=card["reprint_count"],
            front_url=f"/api/id-generator/persons/{pid}/id-card/front",
            back_url=f"/api/id-generator/persons/{pid}/id-card/back",
            pdf_url=f"/api/id-generator/persons/{pid}/id-card/pdf")
    finally:
        conn.close()


@app.get("/api/id-generator/persons/<int:pid>/id-card/<kind>")
@admin_required
def idgen_download_card(pid, kind):
    conn = _id_conn()
    try:
        p = conn.execute("SELECT * FROM id_persons WHERE id = ?",
                         (pid,)).fetchone()
        card = conn.execute("SELECT * FROM id_cards WHERE person_id = ?",
                            (pid,)).fetchone()
        if card is None:
            return _err("No ID card has been generated for this record yet.", 404)
        names = {"front": card["control_no"] + "_FRONT.png",
                 "back": card["control_no"] + "_BACK.png",
                 "pdf": card["control_no"] + ".pdf"}
        if kind not in names:
            return _err("Unknown ID card file.", 404)
        path = os.path.join(db.ID_CARDS_DIR, names[kind])
        if not os.path.exists(path):
            return _err("ID card file is missing — generate the ID again.", 404)
        name_part = _safe_file_token(p["name"] if p else "FARMER", "FARMER")
        rsbsa_part = _safe_file_token(
            p["rsbsa_number"] if p else card["control_no"], "NO-RSBSA")
        suffix = {"front": "FRONT.png", "back": "BACK.png", "pdf": "ID.pdf"}[kind]
        return send_file(path, as_attachment=True,
                         download_name=f"{name_part}_{rsbsa_part}_{suffix}")
    finally:
        conn.close()


@app.post("/api/id-generator/cards/<int:pid>/tag-printed")
@admin_required
def idgen_tag_printed(pid):
    body = request.get_json(silent=True) or {}
    is_printed = bool(body.get("is_printed", True))
    conn = _id_conn()
    try:
        card = conn.execute("SELECT * FROM id_cards WHERE person_id = ?", (pid,)).fetchone()
        if card is None:
            return _err("No ID card found for this person.", 404)
        now = db.now_iso() if is_printed else None
        conn.execute("UPDATE id_cards SET is_printed = ?, printed_at = ? WHERE person_id = ?",
                     (1 if is_printed else 0, now, pid))
        conn.commit()
        _audit("id_card.tag_printed",
               f"ID card {card['control_no']} tagged as {'printed' if is_printed else 'unprinted'}")
        g.db.commit()
        return jsonify(ok=True, is_printed=is_printed, printed_at=now)
    finally:
        conn.close()


@app.post("/api/id-generator/batch-print")
@admin_required
def idgen_batch_print():
    if idgen is None:
        return _err("The ID card maker is unavailable on this server.", 503)
    body = request.get_json(silent=True) or {}
    pids = body.get("person_ids")
    conn = _id_conn()
    try:
        sql = ("SELECT p.*, c.id AS card_id, c.control_no, c.issued_at, c.valid_until, "
               "c.reprint_count, c.is_printed FROM id_persons p "
               "JOIN id_cards c ON c.person_id = p.id ")
        args = []
        if pids and isinstance(pids, list):
            placeholders = ",".join("?" for _ in pids)
            sql += f"WHERE p.id IN ({placeholders}) "
            args.extend(pids)
        else:
            unprinted_count = conn.execute("SELECT COUNT(*) AS n FROM id_cards WHERE is_printed = 0").fetchone()["n"]
            if unprinted_count > 0:
                sql += "WHERE c.is_printed = 0 "
        sql += "ORDER BY p.name LIMIT 100"
        rows = conn.execute(sql, args).fetchall()
        if not rows:
            return _err("No generated ID cards found to print.")

        from PIL import Image
        card_items = []
        card_ids = []
        for r in rows:
            ctrl = r["control_no"]
            front_path = os.path.join(db.ID_CARDS_DIR, f"{ctrl}_FRONT.png")
            back_path = os.path.join(db.ID_CARDS_DIR, f"{ctrl}_BACK.png")
            if not os.path.exists(front_path) or not os.path.exists(back_path):
                try:
                    _render_id_person_files(dict(r), dict(r))
                except Exception:
                    continue
            if os.path.exists(front_path) and os.path.exists(back_path):
                f_im = Image.open(front_path).convert("RGB")
                b_im = Image.open(back_path).convert("RGB")
                card_items.append({
                    "front": f_im,
                    "back": b_im,
                    "label": f"{r['name']} ({ctrl})"
                })
                card_ids.append(r["card_id"])

        if not card_items:
            return _err("Could not load card image files for batch printing.", 500)

        pdf_bytes = idgen.batch_a4_pdf(card_items)
        now = db.now_iso()
        if card_ids:
            placeholders = ",".join("?" for _ in card_ids)
            conn.execute(f"UPDATE id_cards SET is_printed = 1, printed_at = ? WHERE id IN ({placeholders})",
                         [now] + card_ids)
            conn.commit()

        _audit("id_card.batch_print", f"Batch printed {len(card_items)} ID card(s) onto A4 sheets (5 per sheet)")
        g.db.commit()

        stamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
        return send_file(
            io.BytesIO(pdf_bytes),
            mimetype="application/pdf",
            as_attachment=True,
            download_name=f"farmer_ids_batch_A4_{stamp}.pdf"
        )
    finally:
        conn.close()


@app.delete("/api/id-generator/persons/<int:pid>")
@admin_required
def idgen_delete_person(pid):
    conn = _id_conn()
    try:
        p = conn.execute("SELECT * FROM id_persons WHERE id = ?", (pid,)).fetchone()
        if p is None:
            return _err("ID record not found.", 404)
        card = conn.execute("SELECT * FROM id_cards WHERE person_id = ?", (pid,)).fetchone()
        if card:
            for fn in (f"{card['control_no']}_FRONT.png", f"{card['control_no']}_BACK.png", f"{card['control_no']}.pdf"):
                p_file = os.path.join(db.ID_CARDS_DIR, fn)
                if os.path.exists(p_file):
                    try:
                        os.remove(p_file)
                    except Exception:
                        pass
            conn.execute("DELETE FROM id_cards WHERE person_id = ?", (pid,))
        if p["photo_path"] and p["photo_path"].startswith("photos/id_person_"):
            p_photo = os.path.join(db.INSTANCE_DIR, p["photo_path"])
            if os.path.exists(p_photo):
                try:
                    os.remove(p_photo)
                except Exception:
                    pass
        conn.execute("DELETE FROM id_persons WHERE id = ?", (pid,))
        conn.commit()
        _audit("id_db.delete", f"Deleted ID record '{p['name']}' (RSBSA {p['rsbsa_number']})")
        g.db.commit()
        return jsonify(ok=True)
    finally:
        conn.close()


# --------------------------------------------------------------------------- #
# Dashboard chart data
# --------------------------------------------------------------------------- #
@app.get("/api/stats/charts")
@login_required
def stats_charts():
    bgy = _scope_barangay_id()
    y, m = (int(x) for x in db.now_iso()[:7].split("-"))
    months = []
    for _ in range(12):
        months.append(f"{y:04d}-{m:02d}")
        m -= 1
        if m == 0:
            m, y = 12, y - 1
    months.reverse()
    counts = {k: 0 for k in months}
    sql = "SELECT generated_at FROM certificates WHERE 1=1"
    args = []
    if bgy is not None:
        sql += " AND barangay_id = ?"
        args.append(bgy)
    for r in g.db.execute(sql, args).fetchall():
        key = r["generated_at"][:7]
        if key in counts:
            counts[key] += 1
    if bgy is None:
        by_bgy = g.db.execute(
            "SELECT b.name AS name, COUNT(c.id) AS count FROM barangays b "
            "LEFT JOIN certificates c ON c.barangay_id = b.id "
            "WHERE b.active = 1 "
            "GROUP BY b.id ORDER BY count DESC").fetchall()
        by_bgy = [dict(x) for x in by_bgy]
    else:
        n = g.db.execute(
            "SELECT COUNT(*) AS c FROM certificates WHERE barangay_id = ?",
            (bgy,)).fetchone()["c"]
        by_bgy = [{"name": g.user["barangay_name"], "count": n}]
    return jsonify(
        monthly=[{"month": k, "count": counts[k]} for k in months],
        by_barangay=by_bgy,
    )


# --------------------------------------------------------------------------- #
# Monthly accomplishment report (COA / LGU)
# --------------------------------------------------------------------------- #
_MONTH_LABELS = ["January", "February", "March", "April", "May", "June",
                 "July", "August", "September", "October", "November",
                 "December"]


def _report_payload():
    month = (request.args.get("month") or "").strip()
    parts = month.split("-")
    if (len(parts) != 2 or len(parts[0]) != 4 or not parts[0].isdigit()
            or not parts[1].isdigit() or not 1 <= int(parts[1]) <= 12):
        return None, _err("Invalid month - expected format YYYY-MM.")
    bgy = _scope_barangay_id()
    if bgy is None and request.args.get("barangay_id"):
        try:
            bgy = int(request.args.get("barangay_id"))
        except ValueError:
            return None, _err("Invalid barangay.")
    sql = (
        "SELECT c.cert_no, c.farmer_name, c.generated_at, "
        "b.name AS barangay, u.full_name AS generator "
        "FROM certificates c "
        "JOIN barangays b ON b.id = c.barangay_id "
        "JOIN users u ON u.id = c.generated_by "
        "WHERE substr(c.generated_at, 1, 7) = ?"
    )
    args = [month]
    if bgy is not None:
        sql += " AND c.barangay_id = ?"
        args.append(bgy)
    sql += " ORDER BY c.generated_at ASC"
    rows = [dict(r) for r in g.db.execute(sql, args).fetchall()]

    by_bgy, by_sec = {}, {}
    for r in rows:
        by_bgy[r["barangay"]] = by_bgy.get(r["barangay"], 0) + 1
        key = (r["generator"], r["barangay"])
        by_sec[key] = by_sec.get(key, 0) + 1
    settings = {s["key"]: s["value"] for s in
                g.db.execute("SELECT key, value FROM settings")}
    scope_label, barangay_label = "All Barangays", None
    if bgy is not None:
        bname = g.db.execute("SELECT name FROM barangays WHERE id = ?",
                             (bgy,)).fetchone()
        if bname:
            scope_label = f"Barangay {bname['name']}"
            barangay_label = scope_label
    payload = {
        "month": month,
        "month_label": f"{_MONTH_LABELS[int(parts[1]) - 1]} {parts[0]}",
        "scope_label": scope_label,
        "barangay_label": barangay_label,
        "province": settings.get("province", ""),
        "municipality": settings.get("municipality", ""),
        "generated_at": docgen.format_timestamp(db.now_iso()),
        "prepared_by": g.user["full_name"],
        "totals": len(rows),
        "rows": rows,
        "by_barangay": [{"name": k, "count": v} for k, v in
                        sorted(by_bgy.items(), key=lambda x: -x[1])],
        "by_secretary": [{"name": k[0], "barangay": k[1], "count": v}
                         for k, v in sorted(by_sec.items(),
                                            key=lambda x: -x[1])],
    }
    return payload, None


@app.get("/api/reports/accomplishment")
@login_required
def report_accomplishment():
    payload, err = _report_payload()
    if err:
        return err
    _audit("report.generate",
           f"Accomplishment report {payload['month']} "
           f"({payload['scope_label']}) previewed",
           barangay_id=_scope_barangay_id())
    g.db.commit()
    return jsonify(payload)


@app.get("/api/reports/accomplishment/pdf")
@login_required
def report_accomplishment_pdf():
    payload, err = _report_payload()
    if err:
        return err
    import reports as _reports
    try:
        pdf_path = _reports.generate_accomplishment_pdf(payload)
    except Exception as exc:  # noqa: BLE001
        return _err(f"Report generation failed: {exc}", 500)
    _audit("report.generate",
           f"Accomplishment report {payload['month']} "
           f"({payload['scope_label']}) downloaded as PDF",
           barangay_id=_scope_barangay_id())
    g.db.commit()
    scope = ("all" if payload["barangay_label"] is None
             else payload["barangay_label"].replace(" ", "_").lower())
    resp = send_file(
        pdf_path, as_attachment=True,
        download_name=f"accomplishment_{payload['month']}_{scope}.pdf")
    resp.call_on_close(lambda: _reports.cleanup_pdf(pdf_path))
    return resp


def _report_farmer_ids_payload():
    bgy = _scope_barangay_id()
    if bgy is None and request.args.get("barangay_id"):
        try:
            bgy = int(request.args.get("barangay_id"))
        except ValueError:
            return None, _err("Invalid barangay.")
    bgy_name = None
    if bgy is not None:
        brow = g.db.execute("SELECT name FROM barangays WHERE id = ?", (bgy,)).fetchone()
        if brow:
            bgy_name = brow["name"]
    elif request.args.get("barangay"):
        bgy_name = request.args.get("barangay").strip()

    date_from = (request.args.get("from") or "").strip()
    date_to = (request.args.get("to") or "").strip()
    month = (request.args.get("month") or "").strip()
    if month and len(month) == 7:
        date_from = f"{month}-01"
        date_to = f"{month}-31"

    conn = _id_conn()
    try:
        sql = ("SELECT c.control_no, c.issued_at, c.valid_until, c.reprint_count, "
               "c.status, c.is_printed, c.printed_at, "
               "p.name, p.rsbsa_number, p.gender, p.barangay, p.address, p.affiliated_fca "
               "FROM id_cards c "
               "JOIN id_persons p ON p.id = c.person_id "
               "WHERE 1=1 ")
        args = []
        if date_from:
            sql += "AND c.issued_at >= ? "
            args.append(date_from)
        if date_to:
            sql += "AND c.issued_at <= ? "
            args.append(date_to)
        sql += "ORDER BY c.issued_at DESC, p.name ASC"
        raw_rows = [dict(r) for r in conn.execute(sql, args).fetchall()]
    finally:
        conn.close()

    rows = []
    for r in raw_rows:
        if bgy_name:
            rbgy = (r.get("barangay") or "").lower()
            raddr = (r.get("address") or "").lower()
            if bgy_name.lower() not in rbgy and bgy_name.lower() not in raddr:
                continue
        rows.append(r)

    by_bgy = {}
    by_fca = {}
    for r in rows:
        b_key = r.get("barangay") or "Unspecified"
        by_bgy[b_key] = by_bgy.get(b_key, 0) + 1
        f_key = r.get("affiliated_fca") or "No FCA"
        by_fca[f_key] = by_fca.get(f_key, 0) + 1

    settings = {s["key"]: s["value"] for s in g.db.execute("SELECT key, value FROM settings")}
    scope_label = f"Barangay {bgy_name}" if bgy_name else "All Barangays"
    period_label = f"{date_from} to {date_to}" if date_from and date_to else (month if month else "All Time")

    payload = {
        "period_label": period_label,
        "scope_label": scope_label,
        "barangay_label": scope_label if bgy_name else None,
        "province": settings.get("province", ""),
        "municipality": settings.get("municipality", ""),
        "generated_at": docgen.format_timestamp(db.now_iso()),
        "prepared_by": g.user["full_name"],
        "total_issued": len(rows),
        "total_active": sum(1 for r in rows if r.get("status") == "active"),
        "total_reprints": sum(r.get("reprint_count", 0) for r in rows),
        "total_printed": sum(1 for r in rows if r.get("is_printed")),
        "rows": rows,
        "by_barangay": [{"name": k, "count": v} for k, v in sorted(by_bgy.items(), key=lambda x: -x[1])],
        "by_fca": [{"name": k, "count": v} for k, v in sorted(by_fca.items(), key=lambda x: -x[1])],
    }
    return payload, None


@app.get("/api/reports/farmer-ids")
@login_required
def report_farmer_ids():
    payload, err = _report_farmer_ids_payload()
    if err:
        return err
    _audit("report.generate", f"Farmer IDs report ({payload['scope_label']}) previewed")
    g.db.commit()
    return jsonify(payload)


@app.get("/api/reports/farmer-ids/pdf")
@login_required
def report_farmer_ids_pdf():
    payload, err = _report_farmer_ids_payload()
    if err:
        return err
    import reports as _reports
    try:
        pdf_path = _reports.generate_farmer_ids_pdf(payload)
    except Exception as exc:  # noqa: BLE001
        return _err(f"Report generation failed: {exc}", 500)
    _audit("report.generate", f"Farmer's ID report ({payload['scope_label']}) downloaded as PDF")
    g.db.commit()
    stamp = datetime.datetime.now().strftime("%Y%m%d")
    resp = send_file(pdf_path, as_attachment=True, download_name=f"farmer_ids_report_{stamp}.pdf")
    resp.call_on_close(lambda: _reports.cleanup_pdf(pdf_path))
    return resp


@app.get("/api/reports/farmer-ids/csv")
@login_required
def report_farmer_ids_csv():
    payload, err = _report_farmer_ids_payload()
    if err:
        return err
    import csv as _csv
    buf = io.StringIO()
    writer = _csv.writer(buf)
    writer.writerow(["#", "Control No", "Farmer Name", "RSBSA Number", "Gender", "Barangay", "Address", "FCA", "Issued Date", "Valid Until", "Printed?", "Reprint Count"])
    for idx, r in enumerate(payload["rows"], start=1):
        writer.writerow([
            idx,
            r.get("control_no") or "",
            r.get("name") or "",
            r.get("rsbsa_number") or "",
            r.get("gender") or "",
            r.get("barangay") or "",
            r.get("address") or "",
            r.get("affiliated_fca") or "",
            r.get("issued_at") or "",
            r.get("valid_until") or "",
            "YES" if r.get("is_printed") else "NO",
            r.get("reprint_count", 0),
        ])
    stamp = datetime.datetime.now().strftime("%Y%m%d")
    _audit("report.generate", f"Farmer's ID report ({payload['scope_label']}) downloaded as CSV")
    g.db.commit()
    return Response(
        buf.getvalue(),
        mimetype="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="farmer_ids_report_{stamp}.csv"'}
    )


# --------------------------------------------------------------------------- #
# Audit trail
# --------------------------------------------------------------------------- #
@app.get("/api/audit")
@login_required
def audit_trail():
    action = request.args.get("action") or ""
    date_from = request.args.get("from") or ""
    date_to = request.args.get("to") or ""
    sql = "SELECT * FROM audit_log WHERE 1=1"
    args = []
    if g.user["role"] != "admin":
        sql += " AND (barangay_id = ? OR actor = ?)"
        args += [g.user["barangay_id"], g.user["username"]]
    if action:
        sql += " AND action = ?"
        args.append(action)
    if date_from:
        sql += " AND substr(ts,1,10) >= ?"
        args.append(date_from)
    if date_to:
        sql += " AND substr(ts,1,10) <= ?"
        args.append(date_to)
    sql += " ORDER BY id DESC LIMIT 500"
    rows = g.db.execute(sql, args).fetchall()
    out = []
    for r in rows:
        item = dict(r)
        if r["barangay_id"]:
            b = g.db.execute("SELECT name FROM barangays WHERE id=?",
                             (r["barangay_id"],)).fetchone()
            item["barangay"] = b["name"] if b else None
        else:
            item["barangay"] = None
        out.append(item)
    return jsonify(out)


# --------------------------------------------------------------------------- #
# Admin: barangays, secretaries, templates, settings
# --------------------------------------------------------------------------- #
@app.get("/api/admin/barangays")
@admin_required
def admin_barangays():
    rows = g.db.execute(
        "SELECT b.id, b.name, "
        "(SELECT COUNT(*) FROM users u WHERE u.barangay_id=b.id AND u.active=1) "
        " AS secretaries, "
        "(SELECT COUNT(*) FROM requests r WHERE r.barangay_id=b.id) AS requests "
        "FROM barangays b WHERE b.active = 1 ORDER BY b.name"
    ).fetchall()
    return jsonify([dict(r) for r in rows])


@app.post("/api/admin/barangays")
@admin_required
def admin_add_barangay():
    body = request.get_json(silent=True) or {}
    name = (body.get("name") or "").strip().title()
    if not name:
        return _err("Barangay name is required.")
    try:
        g.db.execute("INSERT INTO barangays (name, created_at) VALUES (?, ?)",
                     (name, db.now_iso()))
    except Exception:  # noqa: BLE001
        return _err("That barangay already exists.", 409)
    _audit("barangay.create", f"Barangay '{name}' added")
    g.db.commit()
    return jsonify(ok=True)


@app.delete("/api/admin/barangays/<int:bid>")
@admin_required
def admin_delete_barangay(bid):
    used = g.db.execute(
        "SELECT (SELECT COUNT(*) FROM users WHERE barangay_id=?) + "
        "(SELECT COUNT(*) FROM requests WHERE barangay_id=?) AS c",
        (bid, bid)).fetchone()["c"]
    if used:
        return _err("Cannot delete: barangay has users or records.", 409)
    b = g.db.execute("SELECT name FROM barangays WHERE id=?", (bid,)).fetchone()
    if b is None:
        return _err("Not found.", 404)
    g.db.execute("DELETE FROM barangays WHERE id=?", (bid,))
    _audit("barangay.delete", f"Barangay '{b['name']}' removed")
    g.db.commit()
    return jsonify(ok=True)


@app.get("/api/admin/users")
@admin_required
def admin_users():
    rows = g.db.execute(
        "SELECT u.id, u.username, u.full_name, u.role, u.active, u.created_at, "
        "b.name AS barangay FROM users u "
        "LEFT JOIN barangays b ON b.id = u.barangay_id "
        "ORDER BY u.role, u.full_name"
    ).fetchall()
    return jsonify([dict(r) for r in rows])


@app.post("/api/admin/users")
@admin_required
def admin_create_user():
    body = request.get_json(silent=True) or {}
    username = (body.get("username") or "").strip()
    password = body.get("password") or ""
    full_name = (body.get("full_name") or "").strip()
    role = body.get("role") or "secretary"
    barangay_id = body.get("barangay_id")
    if not username or not password or not full_name:
        return _err("Username, password and full name are required.")
    if len(password) < 6:
        return _err("Password must be at least 6 characters.")
    if role == "secretary" and not barangay_id:
        return _err("A secretary must be assigned to a barangay.")
    if g.db.execute("SELECT 1 FROM users WHERE LOWER(username) = LOWER(?)",
                    (username,)).fetchone():
        return _err("That username is already taken.", 409)
    must_change = 1 if role == "secretary" else 0
    try:
        cur = g.db.execute(
            "INSERT INTO users (username, password_hash, full_name, role, "
            "barangay_id, must_change_password, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (username, generate_password_hash(password), full_name, role,
             barangay_id if role == "secretary" else None, must_change, db.now_iso()),
        )
    except Exception:  # noqa: BLE001
        return _err("That username is already taken.", 409)
    _audit("user.create", f"Account '{username}' ({role}) created for {full_name}")
    g.db.commit()
    return jsonify(ok=True, id=cur.lastrowid)


@app.patch("/api/admin/users/<int:uid>")
@admin_required
def admin_update_user(uid):
    body = request.get_json(silent=True) or {}
    user = g.db.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
    if user is None:
        return _err("Not found.", 404)
    if "active" in body:
        if user["id"] == g.user["id"] and not body["active"]:
            return _err("You cannot deactivate your own account.")
        g.db.execute("UPDATE users SET active=? WHERE id=?",
                     (1 if body["active"] else 0, uid))
        _audit("user.toggle",
               f"Account '{user['username']}' "
               f"{'activated' if body['active'] else 'deactivated'}")
    if body.get("password"):
        if len(body["password"]) < 6:
            return _err("Password must be at least 6 characters.")
        g.db.execute("UPDATE users SET password_hash=?, must_change_password=1 WHERE id=?",
                     (generate_password_hash(body["password"]), uid))
        _audit("user.password_reset", f"Password reset for '{user['username']}'")
    if body.get("barangay_id") and user["role"] == "secretary":
        g.db.execute("UPDATE users SET barangay_id=? WHERE id=?",
                     (body["barangay_id"], uid))
        _audit("user.reassign", f"'{user['username']}' reassigned")
    g.db.commit()
    return jsonify(ok=True)


@app.get("/api/admin/templates")
@admin_required
def admin_templates():
    _seed_sample_template()
    rows = g.db.execute(
        "SELECT t.id, t.name, t.filename, t.active, t.created_at, t.fields_json, "
        "u.full_name AS uploader FROM templates t "
        "LEFT JOIN users u ON u.id = t.uploaded_by ORDER BY t.created_at DESC"
    ).fetchall()
    out = []
    for r in rows:
        item = dict(r)
        item["fields"] = json.loads(item.pop("fields_json"))
        out.append(item)
    return jsonify(out)


@app.post("/api/admin/templates")
@admin_required
def admin_upload_template():
    if "file" not in request.files:
        return _err("No file uploaded.")
    f = request.files["file"]
    name = (request.form.get("name") or "").strip()
    if not f.filename or not f.filename.lower().endswith(".docx"):
        return _err("Please upload a .docx Word template.")
    if not name:
        name = os.path.splitext(os.path.basename(f.filename))[0]
    filename = f"tpl_{secrets.token_hex(8)}.docx"
    path = os.path.join(db.TEMPLATES_DIR, filename)
    f.save(path)
    try:
        fields = docgen.build_fields_config(path)
    except Exception as exc:  # noqa: BLE001
        os.remove(path)
        return _err(f"Could not read the template: {exc}", 400)
    if not fields:
        os.remove(path)
        return _err("No {{PLACEHOLDER}} markers found in this document.")
    cur = g.db.execute(
        "INSERT INTO templates (name, filename, fields_json, uploaded_by, "
        "created_at) VALUES (?, ?, ?, ?, ?)",
        (name, filename, json.dumps(fields), g.user["id"], db.now_iso()),
    )
    _audit("template.upload",
           f"Template '{name}' uploaded with {len(fields)} fields")
    g.db.commit()
    return jsonify(ok=True, id=cur.lastrowid, fields=fields)


@app.patch("/api/admin/templates/<int:tid>")
@admin_required
def admin_update_template(tid):
    tpl = _load_template(tid)
    if tpl is None:
        return _err("Not found.", 404)
    body = request.get_json(silent=True) or {}
    if "active" in body:
        g.db.execute("UPDATE templates SET active=? WHERE id=?",
                     (1 if body["active"] else 0, tid))
        _audit("template.toggle",
               f"Template '{tpl['name']}' "
               f"{'activated' if body['active'] else 'deactivated'}")
    if body.get("name"):
        g.db.execute("UPDATE templates SET name=? WHERE id=?",
                     (body["name"].strip(), tid))
    if isinstance(body.get("fields"), list):
        fields = []
        valid_types = ("text", "textarea", "number", "date", "select", "radio", "checkbox")
        for f in body["fields"]:
            if not f.get("key"):
                continue
            clean_key = re.sub(r"[^A-Za-z0-9_]", "", (f["key"] or "").strip().upper())
            if not clean_key:
                continue
            raw_type = f.get("type") or "text"
            ftype = raw_type if raw_type in valid_types else "text"
            opts = f.get("options") or []
            if isinstance(opts, str):
                opts = [o.strip() for o in opts.split(",") if o.strip()]
            fields.append({
                "key": clean_key,
                "label": (f.get("label") or clean_key).strip(),
                "type": ftype,
                "required": bool(f.get("required")),
                "system": bool(f.get("system")),
                "help": (f.get("help") or "").strip(),
                "placeholder": (f.get("placeholder") or "").strip(),
                "default_value": (f.get("default_value") or "").strip(),
                "options": opts,
            })
        if not fields:
            return _err("Field list cannot be empty.")
        g.db.execute("UPDATE templates SET fields_json=? WHERE id=?",
                     (json.dumps(fields), tid))
        _audit("template.fields", f"Dynamic schema updated for '{tpl['name']}' ({len(fields)} fields)")
    g.db.commit()
    return jsonify(ok=True)


@app.post("/api/admin/templates/<int:tid>/detect-docx")
@admin_required
def admin_template_detect_docx(tid):
    tpl = _load_template(tid)
    if tpl is None:
        return _err("Not found.", 404)
    path = os.path.join(db.TEMPLATES_DIR, tpl["filename"])
    if not os.path.exists(path):
        return _err("Template Word file not found on disk.", 404)
    try:
        fields = docgen.build_fields_config(path)
    except Exception as exc:  # noqa: BLE001
        return _err(f"Could not read template: {exc}", 400)
    return jsonify(fields=fields)


@app.get("/api/admin/settings")
@admin_required
def get_settings():
    vals = {r["key"]: r["value"] for r in
            g.db.execute("SELECT key, value FROM settings")}
    return jsonify({
        "municipality": vals.get("municipality", ""),
        "province": vals.get("province", ""),
        "cert_prefix": vals.get("cert_prefix", "RSBSA"),
    })


@app.get("/api/office-info")
def get_office_info():
    vals = {r["key"]: r["value"] for r in
            g.db.execute("SELECT key, value FROM settings")}
    return jsonify({
        "municipality": vals.get("municipality", ""),
        "province": vals.get("province", ""),
    })


@app.put("/api/admin/settings")
@admin_required
def put_settings():
    body = request.get_json(silent=True) or {}
    allowed = ("municipality", "province", "cert_prefix")
    for key in allowed:
        if key in body:
            val = (body[key] or "").strip()
            if key == "cert_prefix" and not val:
                return _err("Certificate prefix cannot be empty.")
            db.set_setting(g.db, key, val)
    _audit("settings.update", "System settings updated")
    g.db.commit()
    return jsonify(ok=True)

# --------------------------------------------------------------------------- #
# One-click backup & restore (admin only). A backup is a single ZIP holding
# a consistent snapshot of the database (via SQLite's backup API), every
# uploaded template, all filed certificate PDFs, farmer ID photos and the
# generated Farmer's ID cards, plus a manifest. Restoring first saves a
# "pre-restore" safety backup on the server, validates the uploaded
# database, and only then swaps files in. Both actions are audited.
# --------------------------------------------------------------------------- #
BACKUP_FORMAT = "rsbsa-backup"
BACKUPS_DIR = os.path.join(db.INSTANCE_DIR, "backups")
os.makedirs(BACKUPS_DIR, exist_ok=True)
_BACKUP_DIRS = (
    ("templates", db.TEMPLATES_DIR),
    ("photos", db.PHOTOS_DIR),
    ("id_cards", db.ID_CARDS_DIR),
    ("filings", db.FILINGS_DIR),
)
_RESTORE_ALLOWED_TOP = {"manifest.json", "rsbsa.db", "id_generator.db",
                        "secret_key", "templates", "photos", "id_cards",
                        "filings"}
_RESTORE_MAX_BYTES = 750 * 1024 * 1024  # total uncompressed


def _backup_counts(conn):
    counts = {}
    for table in ("farmers", "requests", "certificates", "audit_log",
                  "barangays", "users", "templates"):
        try:
            counts[table] = conn.execute(
                f"SELECT COUNT(*) AS n FROM {table}").fetchone()["n"]
        except Exception:
            counts[table] = 0
    return counts


def _write_backup_zip(dest_path, source_conn=None):
    """Write a full backup ZIP to dest_path. Returns the manifest dict."""
    stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    tmp_db = dest_path + ".dbtmp"
    src_conn = source_conn
    own = False
    if src_conn is None:
        src_conn = db.connect()
        own = True
    try:
        snap = sqlite3.connect(tmp_db)
        try:
            src_conn.backup(snap)
        finally:
            snap.close()
        manifest = {
            "format": BACKUP_FORMAT,
            "version": 1,
            "created_at": db.now_iso(),
            "counts": _backup_counts(src_conn),
            "includes": ["rsbsa.db (database snapshot)"]
                        + [f"{name}/" for name, _ in _BACKUP_DIRS]
                        + ["secret_key"],
        }
        if os.path.exists(db_id.ID_DB_PATH):
            manifest["includes"].append(
                "id_generator.db (ID Card Generator database)")
            try:
                _idc = sqlite3.connect(db_id.ID_DB_PATH)
                manifest["id_generator"] = {
                    "persons": _idc.execute(
                        "SELECT COUNT(*) FROM id_persons").fetchone()[0],
                    "cards": _idc.execute(
                        "SELECT COUNT(*) FROM id_cards").fetchone()[0]}
                _idc.close()
            except Exception:
                pass
        files = 0
        with zipfile.ZipFile(dest_path, "w", zipfile.ZIP_DEFLATED) as z:
            z.writestr("manifest.json", json.dumps(manifest, indent=2))
            z.write(tmp_db, "rsbsa.db")
            files += 1
            if os.path.exists(db_id.ID_DB_PATH):
                tmp_iddb = dest_path + ".iddbtmp"
                _src = sqlite3.connect(db_id.ID_DB_PATH)
                _snap = sqlite3.connect(tmp_iddb)
                try:
                    _src.backup(_snap)
                finally:
                    _snap.close()
                    _src.close()
                z.write(tmp_iddb, "id_generator.db")
                files += 1
                os.remove(tmp_iddb)
            for name, folder in _BACKUP_DIRS:
                if not os.path.isdir(folder):
                    continue
                for root, _dirs, fnames in os.walk(folder):
                    for fn in fnames:
                        full = os.path.join(root, fn)
                        arc = os.path.join(
                            name, os.path.relpath(full, folder))
                        z.write(full, arc)
                        files += 1
            if os.path.exists(_secret_file):
                z.write(_secret_file, "secret_key")
        manifest["files"] = files
        with zipfile.ZipFile(dest_path, "a", zipfile.ZIP_DEFLATED) as z:
            z.writestr("manifest.json", json.dumps(manifest, indent=2))
        return manifest
    finally:
        if own:
            src_conn.close()
        if os.path.exists(tmp_db):
            os.remove(tmp_db)


@app.get("/api/admin/backup/download")
@admin_required
def backup_download():
    stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    tmp_path = os.path.join(BACKUPS_DIR, f".download-{stamp}.zip")
    manifest = _write_backup_zip(tmp_path, g.db)
    size_mb = os.path.getsize(tmp_path) / (1024 * 1024)
    _audit("system.backup",
           f"Full backup downloaded ({manifest.get('files', 0)} files, "
           f"{size_mb:.1f} MB; farmers={manifest['counts'].get('farmers')}, "
           f"certificates={manifest['counts'].get('certificates')})")
    g.db.commit()
    resp = send_file(tmp_path, as_attachment=True,
                     download_name=f"rsbsa-backup-{stamp}.zip",
                     mimetype="application/zip")
    resp.call_on_close(lambda: os.path.exists(tmp_path)
                       and os.remove(tmp_path))
    return resp


@app.post("/api/admin/restore")
@admin_required
def backup_restore():
    up = request.files.get("file")
    if up is None or not up.filename:
        return _err("Choose a backup .zip file to restore.")
    if not up.filename.lower().endswith(".zip"):
        return _err("The backup must be a .zip file downloaded from this system.")
    stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    upload_path = os.path.join(BACKUPS_DIR, f".upload-{stamp}.zip")
    staging = tempfile.mkdtemp(prefix=".restore-", dir=db.INSTANCE_DIR)
    trash_dirs = []
    up.save(upload_path)
    try:
        try:
            zf = zipfile.ZipFile(upload_path)
        except zipfile.BadZipFile:
            return _err("That file is not a valid ZIP backup.")
        with zf:
            try:
                manifest = json.loads(zf.read("manifest.json"))
            except Exception:
                return _err("Not an RSBSA backup: manifest.json is missing.")
            if manifest.get("format") != BACKUP_FORMAT:
                return _err("Not an RSBSA backup file (format mismatch).")
            total = 0
            for info in zf.infolist():
                name = info.filename.replace("\\", "/")
                parts = [p for p in name.split("/") if p not in ("", ".")]
                if not parts or ".." in parts or os.path.isabs(info.filename):
                    return _err(f"Unsafe path inside backup: {info.filename}")
                if parts[0] not in _RESTORE_ALLOWED_TOP:
                    return _err(f"Unexpected file inside backup: {info.filename}")
                total += info.file_size
                if total > _RESTORE_MAX_BYTES:
                    return _err("Backup is too large to restore safely.")
            zf.extractall(staging)
        staged_db = os.path.join(staging, "rsbsa.db")
        if not os.path.exists(staged_db):
            return _err("Backup has no database (rsbsa.db missing).")
        staged_iddb = os.path.join(staging, "id_generator.db")
        if os.path.exists(staged_iddb):
            _probe2 = sqlite3.connect(staged_iddb)
            try:
                _tables2 = {r[0] for r in _probe2.execute(
                    "SELECT name FROM sqlite_master WHERE type='table'")}
            finally:
                _probe2.close()
            if not {"id_persons", "id_cards"}.issubset(_tables2):
                return _err("The backup's ID Generator database is invalid.")
        probe = sqlite3.connect(staged_db)
        try:
            ok = probe.execute("PRAGMA integrity_check").fetchone()[0]
            tables = {r[0] for r in probe.execute(
                "SELECT name FROM sqlite_master WHERE type='table'")}
        finally:
            probe.close()
        if ok != "ok":
            return _err("The backup database failed its integrity check.")
        needed = {"settings", "users", "barangays", "requests",
                  "certificates", "farmers", "audit_log"}
        if not needed.issubset(tables):
            return _err("The backup database is missing required tables.")

        # Safety first: snapshot the current system before touching it.
        safety_name = f"pre-restore-{stamp}.zip"
        _write_backup_zip(os.path.join(BACKUPS_DIR, safety_name), g.db)

        actor = g.user["username"]
        try:
            g.db.close()
        except Exception:
            pass
        g.db = None  # teardown tolerates None

        for name, target in _BACKUP_DIRS:
            staged = os.path.join(staging, name)
            trash = os.path.join(db.INSTANCE_DIR, f".trash-{name}-{stamp}")
            if os.path.isdir(target):
                os.replace(target, trash)
                trash_dirs.append(trash)
            if os.path.isdir(staged):
                os.replace(staged, target)
            else:
                os.makedirs(target, exist_ok=True)
        for suffix in ("-wal", "-shm"):
            stale = db.DB_PATH + suffix
            if os.path.exists(stale):
                os.remove(stale)
        os.replace(staged_db, db.DB_PATH)
        staged_secret = os.path.join(staging, "secret_key")
        if os.path.exists(staged_secret):
            os.replace(staged_secret, _secret_file)
        if os.path.exists(staged_iddb):
            for suffix in ("-wal", "-shm"):
                _stale = db_id.ID_DB_PATH + suffix
                if os.path.exists(_stale):
                    os.remove(_stale)
            os.replace(staged_iddb, db_id.ID_DB_PATH)

        db.init_db()
        conn = db.connect()
        try:
            db.log_audit(conn, actor, "admin", "system.restore",
                         f"Restored backup created "
                         f"{manifest.get('created_at', 'unknown')}; "
                         f"safety backup saved as {safety_name}")
            conn.commit()
            counts = _backup_counts(conn)
        finally:
            conn.close()
        session.clear()
        return jsonify(ok=True, safety_backup=safety_name,
                       backup_created_at=manifest.get("created_at"),
                       counts=counts, relogin=True)
    finally:
        shutil.rmtree(staging, ignore_errors=True)
        for t in trash_dirs:
            shutil.rmtree(t, ignore_errors=True)
        if os.path.exists(upload_path):
            os.remove(upload_path)



# --------------------------------------------------------------------------- #
# Parcel fields: every certificate entry is one parcel of the same farmer.
# Make sure every template collects Farm Area + Parcel Location. The farmer
# profile is auto-copied to entries 2+; these two fields never are.
# --------------------------------------------------------------------------- #
def _backfill_certificate_data():
    """Give pre-existing certificates their issued-data snapshot.

    Certificates were filed in entry order at approval, so the Nth
    certificate of a request corresponds to the Nth stored entry.
    """
    conn = db.connect()
    try:
        missing = conn.execute(
            "SELECT id, request_id FROM certificates "
            "WHERE data_json IS NULL OR data_json = '' ORDER BY id").fetchall()
        if not missing:
            return
        by_req = {}
        for r in missing:
            by_req.setdefault(r["request_id"], set()).add(r["id"])
        filled = 0
        for rid, miss_ids in by_req.items():
            req = conn.execute("SELECT data_json FROM requests WHERE id = ?",
                               (rid,)).fetchone()
            if req is None:
                continue
            entries = db.entries_of(req["data_json"])
            all_ids = [c["id"] for c in conn.execute(
                "SELECT id FROM certificates WHERE request_id = ? "
                "ORDER BY id", (rid,)).fetchall()]
            for idx, cid in enumerate(all_ids):
                if cid in miss_ids and idx < len(entries):
                    conn.execute(
                        "UPDATE certificates SET data_json = ? WHERE id = ?",
                        (json.dumps(entries[idx]), cid))
                    filled += 1
        conn.commit()
        if filled:
            print(f"[cert-data] backfilled issued data for {filled} "
                  f"certificate(s)")
    finally:
        conn.close()


def _ensure_parcel_fields():
    conn = db.connect()
    try:
        for tpl in conn.execute("SELECT id, fields_json FROM templates"):
            fields = json.loads(tpl["fields_json"])
            keys = [f["key"] for f in fields]
            changed = False
            if "FARM_AREA" not in keys:
                fields.append({
                    "key": "FARM_AREA", "label": "Farm Area (Ha)",
                    "type": "number", "required": True, "system": False,
                    "help": "Numerical value only in hectares (e.g. 0.2526). "
                            "One entry per parcel."})
                keys.append("FARM_AREA")
                changed = True
            for f in fields:
                if f.get("key") == "FARM_AREA":
                    if f.get("label") != "Farm Area (Ha)" or f.get("type") != "number":
                        f["label"] = "Farm Area (Ha)"
                        f["type"] = "number"
                        f["help"] = ("Numerical value only in hectares (e.g. 0.2526). "
                                     "One entry per parcel.")
                        changed = True
            if "PARCEL_LOCATION" not in keys:
                idx = keys.index("FARM_AREA")
                fields.insert(idx + 1, {
                    "key": "PARCEL_LOCATION", "label": "Parcel Location",
                    "type": "text", "required": True, "system": False,
                    "help": "Where this parcel is located (sitio/purok and "
                            "barangay). Each parcel entry has its own "
                            "location."})
                changed = True
            if changed:
                conn.execute(
                    "UPDATE templates SET fields_json = ? WHERE id = ?",
                    (json.dumps(fields), tpl["id"]))
        # Rebuild the built-in sample template if it predates the parcel
        # location placeholder (existing certificates are unaffected).
        if os.path.exists(db.SAMPLE_TEMPLATE_PATH):
            if ("PARCEL_LOCATION" not in
                    docgen.extract_placeholders(db.SAMPLE_TEMPLATE_PATH)):
                os.remove(db.SAMPLE_TEMPLATE_PATH)
                docgen.ensure_sample_template(db.SAMPLE_TEMPLATE_PATH)
                fields = docgen.build_fields_config(db.SAMPLE_TEMPLATE_PATH)
                conn.execute(
                    "UPDATE templates SET fields_json = ? "
                    "WHERE filename = ?",
                    (json.dumps(fields),
                     os.path.basename(db.SAMPLE_TEMPLATE_PATH)))
        conn.commit()
    finally:
        conn.close()


# --------------------------------------------------------------------------- #
# One-time backfill: link historical requests to farmer masterlist profiles
# --------------------------------------------------------------------------- #
def _rebuild_farmer_links():
    conn = db.connect()
    try:
        rows = conn.execute(
            "SELECT id, data_json, barangay_id, template_id "
            "FROM requests WHERE farmers_synced = 0").fetchall()
        for r in rows:
            linked = set()
            _tpl_ids = db.entry_templates_of(r["data_json"], r["template_id"])
            for _idx, entry in enumerate(db.entries_of(r["data_json"])):
                _tid = (_tpl_ids[_idx] if _idx < len(_tpl_ids)
                        else r["template_id"])
                tpl = conn.execute(
                    "SELECT fields_json FROM templates WHERE id = ?",
                    (_tid,)).fetchone()
                fields = json.loads(tpl["fields_json"]) if tpl else []
                rsbsa_key = next(
                    (f["key"] for f in fields
                     if "RSBSA" in f["key"].upper() and
                     ("NUM" in f["key"].upper()
                      or f["key"].upper().endswith("NO"))),
                    "RSBSA_NUMBER")
                rsbsa = str(entry.get(rsbsa_key, "")).strip()
                name_key = next((k for k in ("FARMER_NAME", "FULL_NAME", "NAME")
                                 if entry.get(k)), None)
                if not name_key:
                    name_key = next((f["key"] for f in fields
                                     if not f.get("system")
                                     and "NAME" in f["key"]), None)
                name = str(entry.get(name_key, "")).strip() if name_key else ""
                if name:
                    fid, _ = db.upsert_farmer(
                        conn, rsbsa_number=rsbsa, name=name, data=entry,
                        barangay_id=r["barangay_id"])
                    linked.add(fid)
            for fid in linked:
                conn.execute(
                    "INSERT OR IGNORE INTO request_farmers "
                    "(request_id, farmer_id) VALUES (?, ?)",
                    (r["id"], fid))
            conn.execute("UPDATE requests SET farmers_synced = 1 WHERE id = ?",
                         (r["id"],))
        conn.commit()
        if rows:
            print(f"[masterlist] linked {len(rows)} historical request(s)")
    finally:
        conn.close()


if __name__ == "__main__":
    db.init_db()
    db_id.init_db()
    _ensure_parcel_fields()
    _backfill_certificate_data()
    _rebuild_farmer_links()
    purge_expired_pdfs()          # startup sweep (PDF-only + 30-day rule)
    start_retention_scheduler()   # then re-check every 24 hours
    app.run(host="0.0.0.0", port=5000, debug=False, threaded=True)
