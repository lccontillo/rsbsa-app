"""Template parsing and certificate (DOCX + PDF) generation."""
import os
import re
import shutil
import subprocess
import tempfile
import threading

from docx import Document

PLACEHOLDER_RE = re.compile(r"\{\{\s*([A-Za-z0-9_]+)\s*\}\}")

# Placeholders the system fills automatically — never shown as farmer questions.
SYSTEM_PLACEHOLDER_KEYS = {
    "CERT_NO", "DATE_ISSUED", "GENERATED_TIMESTAMP", "SECRETARY_NAME",
    "BARANGAY", "MUNICIPALITY", "PROVINCE", "OR_NUMBER",
}

# Writable blank for {{OR_NUMBER}} — left empty on purpose so the treasurer
# can write the Official Receipt number by hand.
OR_BLANK = "____________________"

# Serializes LibreOffice conversions so concurrent requests don't clash.
_LO_LOCK = threading.Lock()

_ACRONYMS = {"RSBSA", "TIN", "ID", "NBI", "PTR", "PSA", "BARANGAY"}


def _label_for(key: str) -> str:
    words = []
    for w in key.split("_"):
        words.append(w.upper() if w.upper() in _ACRONYMS else w.capitalize())
    return " ".join(words)


def _iter_paragraphs(doc):
    for p in doc.paragraphs:
        yield p
    for table in doc.tables:
        yield from _iter_table_paragraphs(table)
    for section in doc.sections:
        for container in (section.header, section.footer,
                          section.first_page_header, section.first_page_footer,
                          section.even_page_header, section.even_page_footer):
            if container is None:
                continue
            for p in container.paragraphs:
                yield p
            for table in container.tables:
                yield from _iter_table_paragraphs(table)


def _iter_table_paragraphs(table):
    for row in table.rows:
        for cell in row.cells:
            for p in cell.paragraphs:
                yield p
            for t in cell.tables:
                yield from _iter_table_paragraphs(t)


def extract_placeholders(docx_path: str) -> list:
    """Ordered, de-duplicated placeholder keys found anywhere in the template."""
    doc = Document(docx_path)
    seen, keys = set(), []
    for p in _iter_paragraphs(doc):
        for m in PLACEHOLDER_RE.finditer(p.text):
            key = m.group(1)
            if key not in seen:
                seen.add(key)
                keys.append(key)
    return keys


def build_fields_config(docx_path: str) -> list:
    """Default field schema for the farmer input form."""
    fields = []
    for key in extract_placeholders(docx_path):
        fields.append({
            "key": key,
            "label": _label_for(key),
            "type": "text",
            "required": True,
            "system": key in SYSTEM_PLACEHOLDER_KEYS,
            "help": "",
        })
    return fields


def _replace_in_paragraph(paragraph, mapping) -> None:
    text = paragraph.text
    if "{{" not in text:
        return
    new_text = PLACEHOLDER_RE.sub(
        lambda m: str(mapping.get(m.group(1).strip(), "")), text
    )
    if new_text == text:
        return
    if paragraph.runs:
        paragraph.runs[0].text = new_text
        for run in paragraph.runs[1:]:
            run.text = ""
    else:
        paragraph.add_run(new_text)


def fill_docx(src_path: str, dst_path: str, mapping: dict) -> None:
    """Copy the template filling every {{PLACEHOLDER}} from mapping."""
    doc = Document(src_path)
    for p in _iter_paragraphs(doc):
        _replace_in_paragraph(p, mapping)
    doc.save(dst_path)


def _soffice_bin() -> str:
    return shutil.which("soffice") or shutil.which("libreoffice") or "/usr/bin/soffice"


def docx_to_pdf(docx_path: str, out_dir: str) -> str:
    """Convert a .docx to PDF with headless LibreOffice. Returns the PDF path."""
    profile = tempfile.mkdtemp(prefix="lo_profile_")
    try:
        cmd = [
            _soffice_bin(),
            "--headless", "--nologo", "--nolockcheck",
            f"-env:UserInstallation=file://{profile}",
            "--convert-to", "pdf",
            "--outdir", out_dir,
            docx_path,
        ]
        env = dict(os.environ)
        env["HOME"] = "/tmp"
        env["SAL_USE_VCLPLUGIN"] = "svp"
        with _LO_LOCK:
            proc = subprocess.run(
                cmd, capture_output=True, text=True, timeout=120, env=env,
            )
        pdf_path = os.path.join(
            out_dir,
            os.path.splitext(os.path.basename(docx_path))[0] + ".pdf",
        )
        if not os.path.exists(pdf_path):
            detail = (proc.stderr.strip() or proc.stdout.strip() or
                      f"exit code {proc.returncode}")
            raise RuntimeError(f"PDF conversion failed: {detail}")
        return pdf_path
    finally:
        shutil.rmtree(profile, ignore_errors=True)


def format_long_date(iso_date: str) -> str:
    """'2026-10-13' -> 'October 13, 2026'."""
    try:
        parts = iso_date.split("-")
        y, m, d = int(parts[0]), int(parts[1]), int(parts[2])
        months = ["January", "February", "March", "April", "May", "June",
                  "July", "August", "September", "October", "November", "December"]
        return f"{months[m - 1]} {d}, {y}"
    except Exception:
        return iso_date


def format_timestamp(iso_ts: str) -> str:
    """'2026-10-13T17:56:00+08:00' -> 'October 13, 2026 05:56 PM'.

    System-generated timestamp printed on issued certificates.
    """
    try:
        date_part = format_long_date(iso_ts[:10])
        hh, mm = int(iso_ts[11:13]), int(iso_ts[14:16])
        ampm = "AM" if hh < 12 else "PM"
        h12 = hh % 12 or 12
        return f"{date_part} {h12:02d}:{mm:02d} {ampm}"
    except Exception:
        return iso_ts


def ensure_sample_template(path: str) -> None:
    """Create a realistic starter RSBSA certification template."""
    if os.path.exists(path):
        return
    doc = Document()

    def center(text, bold=False, size=None):
        p = doc.add_paragraph()
        p.alignment = 1  # CENTER
        run = p.add_run(text)
        run.bold = bold
        if size:
            run.font.size = size
        return p

    from docx.shared import Pt

    center("Republic of the Philippines", size=Pt(11))
    center("Province of {{PROVINCE}}", size=Pt(11))
    center("{{MUNICIPALITY}}", size=Pt(11))
    center("BARANGAY {{BARANGAY}}", bold=True, size=Pt(12))
    center("OFFICE OF THE BARANGAY SECRETARY", bold=True, size=Pt(11))
    doc.add_paragraph()

    center("CERTIFICATION", bold=True, size=Pt(14))
    doc.add_paragraph()

    p = doc.add_paragraph()
    p.add_run("This is to certify that ").bold = False
    r = p.add_run("{{FARMER_NAME}}")
    r.bold = True
    p.add_run(", of legal age, {{CIVIL_STATUS}}, and a resident of "
              "{{ADDRESS}}, Barangay {{BARANGAY}}, {{MUNICIPALITY}}, "
              "{{PROVINCE}}, is a registered farmer/fisherfolk in the "
              "Registry System for Basic Sectors in Agriculture (RSBSA) "
              "carrying RSBSA Number ")
    r = p.add_run("{{RSBSA_NUMBER}}")
    r.bold = True
    p.add_run(" covering the parcel located at ")
    r = p.add_run("{{PARCEL_LOCATION}}")
    r.bold = True
    p.add_run(" with a recorded farm/fishery area of ")
    r = p.add_run("{{FARM_AREA}}")
    r.bold = True
    p.add_run(".")

    doc.add_paragraph(
        "This certification is issued upon the request of the above-named "
        "for the purpose of {{PURPOSE}} and for whatever legal purpose it may "
        "serve."
    )
    doc.add_paragraph(
        "This certifies further that the person named above has no pending "
        "administrative case filed before this Barangay as of the date of "
        "issuance."
    )
    doc.add_paragraph()

    p = doc.add_paragraph()
    p.add_run("Given this ").italic = True
    r = p.add_run("{{DATE_ISSUED}}")
    r.italic = True
    p.add_run(" at Barangay {{BARANGAY}}, {{MUNICIPALITY}}, {{PROVINCE}}.").italic = True

    doc.add_paragraph()
    p = doc.add_paragraph()
    p.alignment = 1
    r = p.add_run("{{SECRETARY_NAME}}")
    r.bold = True
    p2 = doc.add_paragraph()
    p2.alignment = 1
    p2.add_run("Barangay Secretary / RSBSA Certifying Officer")
    p3 = doc.add_paragraph()
    p3.alignment = 1
    p3.add_run("Barangay {{BARANGAY}}, {{MUNICIPALITY}}")

    p = doc.add_paragraph()
    p.alignment = 1
    r = p.add_run("RSBSA No. {{CERT_NO}}")
    r.font.size = Pt(9)
    p = doc.add_paragraph()
    p.alignment = 1
    r = p.add_run("System generated: {{GENERATED_TIMESTAMP}}")
    r.font.size = Pt(9)

    p = doc.add_paragraph()
    r = p.add_run("OR No.: ")
    r.bold = True
    p.add_run("{{OR_NUMBER}}")
    p2 = doc.add_paragraph()
    r = p2.add_run("(Official Receipt number to be written and issued by the Treasurer)")
    r.italic = True
    r.font.size = Pt(9)

    doc.save(path)
