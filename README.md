# RSBSA Certification Manager

A web application that replaces the manual Word-and-folder process for issuing
**RSBSA certifications**. Farmers submit requests as guests, barangay
secretaries review and admit only their own barangay's requests, and every
issued certificate is filed (Word + PDF) with a complete audit trail.

## Roles

| Role | Access | What they can do |
|---|---|---|
| **Farmer / guest** | No login | Choose barangay → **say how many certifications are needed first (1–10)** → fill one form per certificate, **choosing the certification type separately for each entry** → receive a single reference number for the whole batch; track status with that number. Each entry may use a different certification type (mixed-type batches are fully supported, and older single-type requests still work). |
| **Secretary** | Login | See pending requests **only for their assigned barangay**, review the submitted details, **rectify (override) anything the farmer mistyped**, then **Approve & Issue** all certificates in the request (or Reject with a reason). Browse their barangay's archive and audit trail. |
| **Admin** | Login | First-run setup, manage barangays, secretary accounts, templates, office settings — plus full archive and audit views across all barangays. |

## Feature highlights

- **Batch requests** — the farmer is first asked *"How many certificates are
  you requesting?"* (up to 10). All entries live under **one reference number**
  (e.g. `REQ-2026-00004`), and approval issues one numbered certificate per
  entry in a single action.
- **Multi-parcel entries with auto-populate** — the certificate count means
  *parcels of the same farmer*: one certificate is issued per parcel.
  Entries 2, 3, 4… **automatically copy the farmer profile** (name, civil
  status, address, RSBSA number) from Entry 1 and stay in sync when Entry 1
  is corrected — unless the farmer edits that field in a later entry, in
  which case their edit is preserved. Only **Parcel Location** and
  **Farm Area** (plus purpose, if different) are entered per parcel. Every
  template automatically collects `PARCEL_LOCATION` + `FARM_AREA`, and the
  sample template prints the parcel location on the certificate.
- **QR scan for the RSBSA Number** — on the farmer's form, the RSBSA number
  can be typed, **scanned with the device camera**, or read from an
  **uploaded QR photo/screenshot** (manual typing always remains available).
  The decoder (jsQR) is bundled locally in `static/jsQR.js`, so scanning
  works offline; the number is extracted from plain text, labelled text,
  JSON, or a verification URL, then the masterlist pre-fill runs as usual.
- **Bilingual farmer interface** — farmer-facing pages (home, request wizard, tracking, Farmer Data Entry, QR scan) show Filipino translations beside the English, in the form *English (Filipino)*. Known template fields are translated automatically through a built-in dictionary (Farmer Name → *Pangalan ng Magsasaka*, Parcel Location → *Lokasyon ng Parsela*, etc.); secretary/admin screens remain English.
- **Issued certificate data logging + CSV export** — at approval, each certificate row snapshots the exact information entered for it in the database (`certificates.data_json`), independent of later farmer-record edits; older certificates are backfilled from their requests at startup. The Archive's **⬇ Issued Data (CSV)** button downloads one row per issued certificate: certificate metadata plus every entered field (Farmer Name, RSBSA Number, Parcel Location, Farm Area, Purpose, …) as columns, honouring barangay scope and the archive's search/date filters, and is audit-logged (`certificate.data_export`).
- **Farmer's ID Card Maker** — the admin can generate a back-to-back **FARMER'S ID** for any farmer from the Farmer Masterlist (**🪪 ID Card** button). Name, RSBSA Number, Barangay, Civil Status, and Address come from the masterlist record; **Birthdate, Contact Number, Contact Person in Case of Emergency, and an uploaded ID photo** are saved to the farmer's profile for one-click reprints. The minimalist front carries the seal of the Office of the Municipal Agriculturist (Alcala, Cagayan), the farmer's photo and details, and a gradient **MAO Verified** pill; the back carries reminders, a signature line, and a **QR Code encoding the RSBSA Number** (the emergency contact stays on the farmer's profile and is no longer printed on the card) (readable by this app's QR scanner — verified by decoding the generated cards). Every ID is registered with a control number (**FID-YYYY-####**), issued date, and validity (default 3 years); generating again is a **reprint** that keeps the same control number and bumps the reprint counter. Downloads: front PNG, back PNG, and a two-page true-size **CR80 (85.6 × 54 mm) PDF** for back-to-back printing.

- **Separate ID Card Generator database** — ID generation runs from its **own database** (`instance/id_generator.db`), independent from the Farmer Masterlist used for certifications, managed on the admin-only **ID Generator** page. The admin can **update it by uploading a CSV file** with the fields used to generate the ID — **RSBSA Number, Farmer Name, Gender, Civil Status, Address, Birthdate, Contact Number, and Contact Person in Case of Emergency** (a downloadable template is provided; common header spellings are accepted, and birthdates may be `YYYY-MM-DD` or `MM/DD/YYYY`). Imports are **append-only**: rows whose RSBSA Number already exists (in the database or earlier in the same file) are **skipped and reported**, never overwritten; rows with missing required values or invalid values are skipped and reported too. The admin can also **copy selected farmers from the Farmer Masterlist** into the ID database (profile and photo included; farmers already present are skipped). Any ID detail left blank in the CSV, and the ID photo (which cannot be embedded in a CSV), are **encoded/uploaded per person in the ID Generator**. Control numbers stay unique across both the ID database and the older masterlist-issued cards, the generator's card status is shown on the masterlist, CSV imports/copies/updates are audit-logged (`id_db.csv_import` / `id_db.copy_masterlist` / `id_db.update`), and the separate database is **included in backup & restore**. Cards are rendered natively at **600 DPI** (2032 × 1276 px PNGs, lossless with 600-DPI metadata; the PDF embeds the 600-DPI render at high quality while keeping the exact CR80 page size) — for best photo sharpness, upload a clear photo of at least 640 × 640 px. Issue/reprint/photo actions are audit-logged (`farmer_id.issue` / `farmer_id.reprint` / `farmer.photo_upload`); secretaries can see each farmer's ID status but cannot generate cards. The card design is centralized in [`idgen.py`](idgen.py) (`DESIGN` / `TERMS` constants) so it can be re-skinned later without touching the workflow. Sample outputs: `Sample_Farmers_ID_John Mark Caridad Contillo_Front.png`, `Sample_Farmers_ID_John Mark Caridad Contillo_Back.png`, `Sample_Farmers_ID_John Mark Caridad Contillo.pdf`.
- **One-click backup & restore (admin)** — Administration → Settings → **⬇ Download Full Backup (.zip)** saves one ZIP containing a consistent database snapshot (SQLite backup API) plus every template, filed certificate PDF, farmer ID photo, and generated Farmer's ID card, with a `manifest.json`. Restoring (same card) validates the ZIP and its database, first saves a `pre-restore-YYYYMMDD-HHMMSS.zip` safety backup under `instance/backups/`, then swaps the data in and signs the admin out; both actions are audit-logged (`system.backup` / `system.restore`). Backups contain personal data and password hashes — store them securely. Admin only (secretaries get 403).
- **Offline mode (PWA)** — the app ships a web-app manifest, icons, and a service worker (`/sw.js`) so it can be **installed** on a phone or PC and keeps working without internet: the app shell and previously viewed pages (dashboard, queues, masterlist, archive) stay readable from cache, and farmer submissions, Farmer Data Entry, secretary corrections, approvals, and rejections made offline are kept in an on-device **outbox** (topbar connection pill shows `🟠 Offline • N to sync`) and sync automatically when the connection returns. Approvals take effect on the server at sync time (certificate numbers/PDFs are generated then); items the server rejects stay listed as *needs attention* instead of being silently dropped. Cached pages are cleared on sign-out.
- **NEW farmer tagging & admin verification** — every newly created farmer profile (Farmer Data Entry encodings and profiles auto-created from request submissions) is tagged **NEW**; pre-existing records count as Verified. Nothing is blocked, but secretaries see a "New farmer — for admin verification" flag when reviewing that farmer's requests. Only the **admin** can edit masterlist entries (with audited old→new diffs), mark NEW records **Verified**, or delete bogus NEW records (only when no certificates were issued) — all actions are written to the audit trail (`farmer.verify` / `farmer.update` / `farmer.delete`).
- **Farmer Data Entry (no CSV needed)** — if an RSBSA lookup finds **no
  match** in the database, or the farmer clicks **NOT YET RSBSA REGISTERED** in
  Step 3 of the certification request form, the system opens a **Farmer Data Entry** tab:
  the farmer (or staff) encodes the name, civil status, and address directly
  into the masterlist, and the saved profile immediately pre-fills Entry 1
  and copies to all parcel entries. The same tab is available anytime on the
  Farmer Masterlist page via
  **＋ Farmer Data Entry** — secretaries can only encode for their own
  barangay, admins may choose any barangay. An RSBSA number already
  registered to a *different* name is refused (duplicate protection), and
  every encoding is audit-logged as `farmer.create`. This replaces seeding
  or re-uploading a CSV file whenever a farmer is missing.
- **Required fields by role** — farmer/guest submissions require only the
  **Barangay** and **Farmer's Name**; all other request and Farmer Data
  Entry inputs are optional for guests. Secretary accounts must fill in
  **all** inputs: the server rejects incomplete secretary Farmer Data
  Entry, incomplete saved corrections, and any **Approve & Issue** while
  a field is still blank.
- **Secretary rectification** — on the review screen every field is editable.
  Secretaries can correct farmer-typed values before admitting the request;
  each correction is saved and written to the audit trail with the exact
  `old → new` change (`Inputs rectified by secretary`).
- **CAPS standardization + choice dropdowns** — data-entry inputs display
  and store text in ALL CAPS as the standard format. **Gender** uses a
  `MALE` / `FEMALE` dropdown and **Civil Status** uses a dropdown
  (`SINGLE`, `MARRIED`, `WIDOWED`, `SEPARATED`, `DIVORCED`, `ANNULLED`)
  in the request form, Farmer Data Entry, secretary review, Farmer
  Masterlist edit, and ID Generator; common aliases (e.g. `F`, `WIDOWER`)
  are normalized to the standard values on save.
- **Excel/CSV export** — one click on the Archive page downloads the filtered
  certificate list as a styled `.xlsx` or `.csv` (UTF-8 BOM, opens cleanly in
  Excel) — ready to forward to the Municipal Agriculturist or DA.
  Exports respect the user's barangay scope and active filters, and are
  audit-logged.
- **Monthly accomplishment report** — Reports page: pick a month (and, for
  admins, a barangay) → on-screen preview (totals, by barangay, by certifying
  officer, full detail list) + **one-click downloadable PDF** with signature
  blocks, formatted for COA/LGU submission. Secretaries are automatically
  scoped to their own barangay.
- **Dashboard charts** — both dashboards show *issuances per month* (last 12
  months) and *issuances per barangay* as inline SVG charts — spot which
  offices are behind at a glance.
- **Farmer masterlist** — automatically built from every request: each farmer
  gets a profile (RSBSA number, address, request history, certificates).
  Repeat requests **pre-fill the farmer's form** from their RSBSA number, and
  **duplicates are detected by RSBSA number** — a warning appears on the
  secretary's review screen when a number is already registered to a
  different name (and on the farmer's confirmation screen).
  All lookups are audit-logged.
- **PDF-only filing & 30-day retention** — issued certificates are filed as
  **PDF only**. The Word document is used only as a temporary rendering
  intermediate and is deleted the moment the PDF is produced (uploaded
  *templates* are unaffected and stay `.docx`). A background job runs at
  every startup and then daily: any PDF older than **30 days** is
  automatically deleted from disk. **No database record is ever deleted** —
  certificate rows, request/farmer records, accomplishment-report data and
  the audit trail are retained permanently (the archive keeps counting
  purged certificates, and each purge writes its own `certificate.pdf_purge`
  audit entry). A purged PDF can be **regenerated at any time** from the
  stored record (Archive → *Regenerate PDF*), which reproduces the original
  certificate — same number, issue date and timestamp — and starts a fresh
  30-day retention.

## Demo credentials (pre-seeded)

- **Admin:** `admin` / `admin123`
- **Secretary (Barangay Lucao):** `secretary1` / `secret123`

There is one pending request (`REQ-2026-00002`) and one issued certificate
(`RSBSA-2026-0001`) ready for you to explore.

## How certificate generation works

1. Admin uploads an official **.docx Word template** containing
   `{{PLACEHOLDER}}` markers (the same style already used in Word).
2. The app parses the file and **auto-builds the farmer's input form** from the
   placeholders — labels, field types, and required flags are editable
   (Administration → Templates → Edit fields).
3. When a secretary approves a request, the app:
   - fills every placeholder (farmer data + system values),
   - saves the filled **.docx**,
   - converts it to **PDF** with headless LibreOffice,
   - numbers it (`RSBSA-YYYY-NNNN`), files both copies under `filings/YYYY/`,
     and writes the event to the audit log.

### System placeholders (filled automatically — hidden from farmers)

| Placeholder | Filled with |
|---|---|
| `{{CERT_NO}}` | Generated certificate number |
| `{{DATE_ISSUED}}` | Today's date in long form (e.g. October 13, 2026) |
| `{{GENERATED_TIMESTAMP}}` | **System-generated timestamp of issuance** (e.g. October 13, 2026 05:56 PM) — proves when the system created the certificate |
| `{{OR_NUMBER}}` | Prints a **blank line left for the Treasurer** to write and issue the Official Receipt number |
| `{{SECRETARY_NAME}}` | Full name of the secretary issuing the certificate |
| `{{BARANGAY}}` | Barangay of the request |
| `{{MUNICIPALITY}}` | Office setting |
| `{{PROVINCE}}` | Office setting |

Any other `{{PLACEHOLDER}}` becomes a question on the farmer's form.
Date-type fields are written to the document as *Month D, YYYY*.

## Audit trail

Every action is logged with timestamp, actor, role, and barangay:
sign-ins (including failed attempts), submissions, **rectifications (with the
exact field-level old → new values)**, approvals, rejections, certificate
issuances and downloads, template/account/barangay changes, and settings
updates. Secretaries see their own barangay's activity; admins see
everything. Filter by action and date in **Audit Trail**.

## File layout

```
rsbsa-app/
├── app.py              # Flask app: API + auth + role scoping
├── db.py               # SQLite schema, numbering, audit helpers
├── docgen.py           # Placeholder parsing, DOCX fill, PDF conversion
├── static/             # Single-page front-end (HTML/CSS/JS)
├── instance/
│   ├── rsbsa.db        # SQLite database
│   ├── secret_key      # Session signing key
│   └── templates/      # Uploaded template files
└── filings/
    └── 2026/           # Issued certificates: RSBSA-2026-0001.docx/.pdf
```

## Running it

```bash
cd rsbsa-app
python3 app.py          # serves http://0.0.0.0:5000
```

Requires: Python 3, Flask, python-docx, LibreOffice (for PDF conversion).

## Resetting to a fresh install

```bash
cd rsbsa-app
rm -rf instance/rsbsa.db* instance/secret_key instance/templates/*.docx filings/*
python3 app.py
```

The first-run setup wizard will appear, letting you create a new admin,
office/municipality, and the initial list of barangays.

## Notes

- A secretary can never see or process another barangay's requests,
  certificates, or audit entries — enforced server-side.
- Rejected requests show the secretary's reason to the farmer in
  *Track Your Request*; approved batch requests list **all** issued
  certificate numbers there.
- Corrections made by a secretary are applied **before** issuance and become
  part of the permanent record — the issued certificate reflects the
  rectified values.
- Certificate numbers are sequential per year and never reused; a batch of
  N certificates consumes N numbers in one approval.
- Validation is bilingual-safe: missing fields in a batch are reported per
  entry (e.g. `Entry 2: Civil Status is required.`).
- Sample template included: deactivate or replace it under
  **Administration → Templates** once your official templates are uploaded.

## Screenshots

`rsbsa-app/screenshots/` contains up-to-date captures of every screen
(`00_overview.png` is a contact sheet of all of them), including the
certificate-count step, the multi-entry rectification screen, and the
batch-issuance confirmation.
