"""WSGI entry point for RSBSA Certification Manager."""
import os
import sys

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
if BASE_DIR not in sys.path:
    sys.path.insert(0, BASE_DIR)

from werkzeug.middleware.proxy_fix import ProxyFix
import db
import db_id
from app import (
    app,
    _ensure_parcel_fields,
    _backfill_certificate_data,
    _rebuild_farmer_links,
    purge_expired_pdfs,
    start_retention_scheduler,
)

# Startup initializations (idempotent database schema and sync)
db.init_db()
db_id.init_db()
_ensure_parcel_fields()
_backfill_certificate_data()
_rebuild_farmer_links()
purge_expired_pdfs()
start_retention_scheduler()

# Wrap app with ProxyFix to correctly handle reverse proxy headers behind Nginx
app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1, x_prefix=1)

if __name__ == "__main__":
    app.run()
