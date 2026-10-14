#!/usr/bin/env python3
"""Build the conceptual note PDF for Barangay Officials."""
from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_JUSTIFY, TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import (BaseDocTemplate, Frame, HRFlowable, Image,
                                KeepTogether, NextPageTemplate, PageBreak,
                                PageTemplate, Paragraph, Spacer, Table,
                                TableStyle)

ROOT = Path(__file__).resolve().parent
OUT = ROOT / "RSBSA_Conceptual_Note_Barangay_Officials.pdf"
SCREENSHOT = ROOT / "screenshots" / "18_archive_pdf_purged.png"
ID_FRONT = ROOT / "Sample_Farmers_ID_John Mark Caridad Contillo_Front.png"
ID_BACK = ROOT / "Sample_Farmers_ID_John Mark Caridad Contillo_Back.png"

NAVY = colors.HexColor("#0F3B63")
BLUE = colors.HexColor("#176BAA")
LIGHT = colors.HexColor("#EAF2F9")
LIGHT2 = colors.HexColor("#F5F8FC")
GOLD = colors.HexColor("#D79A1F")
GREEN = colors.HexColor("#16765B")
GREY = colors.HexColor("#4B5563")
DARK = colors.HexColor("#17324F")

styles = getSampleStyleSheet()
styles.add(ParagraphStyle(
    name="CoverKicker", fontName="Helvetica-Bold", fontSize=9,
    leading=12, textColor=BLUE, alignment=TA_CENTER,
    spaceAfter=4 * mm))
styles.add(ParagraphStyle(
    name="CoverTitle", fontName="Helvetica-Bold", fontSize=27,
    leading=31, textColor=NAVY, alignment=TA_CENTER,
    spaceAfter=4 * mm))
styles.add(ParagraphStyle(
    name="CoverSub", fontName="Helvetica", fontSize=13,
    leading=18, textColor=GREY, alignment=TA_CENTER,
    spaceAfter=7 * mm))
styles.add(ParagraphStyle(
    name="CoverMeta", fontName="Helvetica", fontSize=10,
    leading=15, textColor=DARK, alignment=TA_CENTER))
styles.add(ParagraphStyle(
    name="H1x", fontName="Helvetica-Bold", fontSize=15,
    leading=19, textColor=NAVY, spaceBefore=6 * mm,
    spaceAfter=2.5 * mm, keepWithNext=True))
styles.add(ParagraphStyle(
    name="H2x", fontName="Helvetica-Bold", fontSize=11.5,
    leading=15, textColor=DARK, spaceBefore=4 * mm,
    spaceAfter=1.8 * mm, keepWithNext=True))
styles.add(ParagraphStyle(
    name="Bodyx", fontName="Helvetica", fontSize=9.8,
    leading=14.5, textColor=colors.HexColor("#263645"),
    alignment=TA_JUSTIFY, spaceAfter=2.2 * mm))
styles.add(ParagraphStyle(
    name="BodySmall", fontName="Helvetica", fontSize=8.8,
    leading=12.8, textColor=colors.HexColor("#263645"),
    alignment=TA_JUSTIFY, spaceAfter=2 * mm))
styles.add(ParagraphStyle(
    name="Bulletx", parent=styles["Bodyx"], alignment=TA_LEFT,
    leftIndent=6 * mm, firstLineIndent=0, bulletIndent=2.5 * mm,
    spaceAfter=1.5 * mm))
styles.add(ParagraphStyle(
    name="TableCell", fontName="Helvetica", fontSize=8.4,
    leading=11.5, textColor=colors.HexColor("#243447"),
    alignment=TA_LEFT))
styles.add(ParagraphStyle(
    name="TableCellSmall", fontName="Helvetica", fontSize=7.9,
    leading=10.6, textColor=colors.HexColor("#243447"),
    alignment=TA_LEFT))
styles.add(ParagraphStyle(
    name="TableHead", fontName="Helvetica-Bold", fontSize=8.5,
    leading=11, textColor=colors.white, alignment=TA_LEFT))
styles.add(ParagraphStyle(
    name="Caption", fontName="Helvetica-Oblique", fontSize=8,
    leading=11, textColor=GREY, alignment=TA_CENTER,
    spaceBefore=1.5 * mm, spaceAfter=4 * mm))
styles.add(ParagraphStyle(
    name="Callout", fontName="Helvetica-Bold", fontSize=10.5,
    leading=15, textColor=NAVY, alignment=TA_CENTER))
styles.add(ParagraphStyle(
    name="CalloutBody", fontName="Helvetica", fontSize=8.8,
    leading=12.5, textColor=DARK, alignment=TA_CENTER))
styles.add(ParagraphStyle(
    name="FooterNote", fontName="Helvetica-Oblique", fontSize=7.8,
    leading=10.5, textColor=GREY, alignment=TA_LEFT))


def P(text, style="Bodyx"):
    return Paragraph(text, styles[style])


def bullet(text):
    return Paragraph(text, styles["Bulletx"], bulletText="•")


def cell(text, style="TableCell"):
    return Paragraph(text, styles[style])


def head(text):
    return Paragraph(text, styles["TableHead"])


def styled_table(data, widths, header=True, zebra=True, fontsize=None):
    table = Table(data, colWidths=widths, repeatRows=1 if header else 0,
                  hAlign="CENTER")
    commands = [
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("GRID", (0, 0), (-1, -1), 0.35, colors.HexColor("#C7D5E4")),
        ("LEFTPADDING", (0, 0), (-1, -1), 5),
        ("RIGHTPADDING", (0, 0), (-1, -1), 5),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]
    if header:
        commands += [
            ("BACKGROUND", (0, 0), (-1, 0), NAVY),
            ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
            ("ROWBACKGROUNDS", (0, 1), (-1, -1),
             [colors.white, LIGHT2] if zebra else [colors.white, colors.white]),
        ]
    elif zebra:
        commands.append(("ROWBACKGROUNDS", (0, 0), (-1, -1),
                         [colors.white, LIGHT2]))
    table.setStyle(TableStyle(commands))
    return table


def callout(title, body, bg=LIGHT):
    inner = Table([
        [P(title, "Callout")],
        [P(body, "CalloutBody")],
    ], colWidths=[160 * mm])
    inner.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), bg),
        ("BOX", (0, 0), (-1, -1), 0.7, BLUE),
        ("LEFTPADDING", (0, 0), (-1, -1), 10),
        ("RIGHTPADDING", (0, 0), (-1, -1), 10),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
        ("LINEBELOW", (0, 0), (-1, 0), 0.4, colors.HexColor("#BBD3EA")),
    ]))
    return inner


def header_footer(canvas, doc):
    canvas.saveState()
    w, h = A4
    if doc.page > 1:
        canvas.setStrokeColor(colors.HexColor("#C7D5E4"))
        canvas.setLineWidth(0.5)
        canvas.line(18 * mm, h - 14 * mm, w - 18 * mm, h - 14 * mm)
        canvas.setFont("Helvetica-Bold", 7.5)
        canvas.setFillColor(NAVY)
        canvas.drawString(18 * mm, h - 11 * mm,
                          "RSBSA CERTIFICATION MANAGER")
        canvas.setFont("Helvetica", 7.5)
        canvas.setFillColor(GREY)
        canvas.drawRightString(w - 18 * mm, h - 11 * mm,
                               "Conceptual Note for Barangay Officials")
    canvas.setFont("Helvetica", 7.5)
    canvas.setFillColor(GREY)
    canvas.drawString(18 * mm, 12 * mm,
                      "PDF-only filing | 30-day PDF file retention | Permanent system records")
    canvas.drawRightString(w - 18 * mm, 12 * mm, f"Page {doc.page}")
    canvas.restoreState()


def cover_bg(canvas, doc):
    canvas.saveState()
    w, h = A4
    canvas.setFillColor(NAVY)
    canvas.rect(0, h - 25 * mm, w, 25 * mm, stroke=0, fill=1)
    canvas.setFillColor(GOLD)
    canvas.rect(0, h - 27 * mm, w, 2 * mm, stroke=0, fill=1)
    canvas.setFillColor(colors.white)
    canvas.setFont("Helvetica-Bold", 9)
    canvas.drawCentredString(w / 2, h - 14 * mm,
                             "REGISTRY SYSTEM FOR BASIC SECTORS IN AGRICULTURE")
    canvas.setFont("Helvetica", 8)
    canvas.drawCentredString(w / 2, h - 19 * mm,
                             "Barangay Certification Services | Alcala, Cagayan")
    canvas.restoreState()
    header_footer(canvas, doc)


doc = BaseDocTemplate(
    str(OUT), pagesize=A4,
    rightMargin=18 * mm, leftMargin=18 * mm,
    topMargin=19 * mm, bottomMargin=16 * mm,
    title="Conceptual Note - RSBSA Certification Manager",
    author="RSBSA Certification Manager",
    subject="Digital RSBSA certification issuance, PDF-only filing, and 30-day PDF retention",
)

frame_cover = Frame(18 * mm, 16 * mm, A4[0] - 36 * mm, A4[1] - 48 * mm)
frame_body = Frame(18 * mm, 16 * mm, A4[0] - 36 * mm, A4[1] - 35 * mm)
doc.addPageTemplates([
    PageTemplate(id="Cover", frames=[frame_cover], onPage=cover_bg),
    PageTemplate(id="Body", frames=[frame_body], onPage=header_footer),
])

story = []

# ------------------------------------------------------------------ Cover --
story += [Spacer(1, 18 * mm),
          P("CONCEPTUAL NOTE", "CoverKicker"),
          P("RSBSA Certification<br/>Manager", "CoverTitle"),
          P("A digital system for requesting, reviewing, issuing, filing, "
            "and reporting Barangay RSBSA certifications", "CoverSub"),
          HRFlowable(width="28%", thickness=1.1, color=GOLD,
                     spaceAfter=7 * mm, spaceBefore=2 * mm, hAlign="CENTER"),
          P("Focus of this Note", "CoverKicker"),
          P("PDF-only filing and automatic 30-day PDF file retention,<br/>"
            "with permanent retention of certification records", "CoverSub"),
          callout("KEY MESSAGE",
                  "Only the PDF file expires after 30 days. "
                  "The official certification record, accomplishment-report data, "
                  "and audit trail remain in the system and are not deleted."),
          Spacer(1, 13 * mm)]
cover_meta = [
    [cell("<b>Presented to</b>", "TableCell"), cell("Barangay Officials", "TableCell")],
    [cell("<b>Presented for</b>", "TableCell"), cell("Presentation, noting, comments, and guidance", "TableCell")],
    [cell("<b>Date</b>", "TableCell"), cell("October 13, 2026", "TableCell")],
    [cell("<b>Coverage</b>", "TableCell"), cell("Alcala, Cagayan", "TableCell")],
    [cell("<b>Status</b>", "TableCell"), cell("Working system available for demonstration and pilot use", "TableCell")],
]
meta_table = Table(cover_meta, colWidths=[38 * mm, 112 * mm], hAlign="CENTER")
meta_table.setStyle(TableStyle([
    ("BACKGROUND", (0, 0), (0, -1), LIGHT),
    ("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#C7D5E4")),
    ("VALIGN", (0, 0), (-1, -1), "TOP"),
    ("LEFTPADDING", (0, 0), (-1, -1), 7),
    ("RIGHTPADDING", (0, 0), (-1, -1), 7),
    ("TOPPADDING", (0, 0), (-1, -1), 5),
    ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
]))
story += [meta_table, Spacer(1, 10 * mm),
          P("This conceptual note explains the proposed operating concept, "
            "the responsibilities of participating offices, the safeguards "
            "for public records, and the specific decision requested from "
            "Barangay Officials.", "CoverMeta"),
          NextPageTemplate("Body"), PageBreak()]

# ---------------------------------------------------------- 1. Purpose ----
story += [P("1. Purpose of this Note", "H1x"),
          P("This note presents the concept behind the <b>RSBSA Certification "
            "Manager</b>, a web-based system developed to replace the manual, "
            "Word-and-folder method of preparing RSBSA certifications at the "
            "barangay level."),
          P("It also formally presents the system's updated filing rule: "
            "<b>issued certificates are filed as PDF only</b>. The Word file "
            "is used only briefly as a template-rendering intermediate and "
            "is not saved. Thirty (30) days after a PDF is generated, the "
            "PDF file is automatically deleted; however, <b>no database "
            "record is deleted</b>. The certificate record remains searchable, "
            "counted in reports, and protected by a permanent audit trail. "
            "When an official copy is needed again, an authorized user can "
            "regenerate the PDF from the preserved record."),
          callout("DECISION REQUESTED",
                  "Barangay Officials are respectfully requested to note this "
                  "concept, approve its pilot use, confirm the official "
                  "certificate template and signatories, and designate the "
                  "barangay secretary or focal person who will operate the system.")]

# -------------------------------------------------------- 2. Background ---
story += [P("2. Background and Rationale", "H1x"),
          P("At present, RSBSA certifications are commonly prepared by "
            "opening a Word document, replacing the farmer's details, saving "
            "or printing the file, and keeping copies in local folders. This "
            "manual process works, but it creates recurring operational "
            "problems:"),
          bullet("<b>Repeated encoding.</b> Farmers and secretaries retype the same names, addresses, RSBSA numbers, and farm details for every request."),
          bullet("<b>Inconsistent output.</b> Capitalization, spelling, date formats, and certificate appearance vary from one document to another."),
          bullet("<b>Difficult retrieval.</b> Searching past issuances means opening folders and files one by one; there is no single searchable archive."),
          bullet("<b>Weak traceability.</b> It is difficult to prove who corrected, approved, downloaded, or reissued a certificate, and when."),
          bullet("<b>Duplicate risks.</b> The same RSBSA number may be encoded under different names without any warning."),
          bullet("<b>Manual reporting.</b> Monthly accomplishment reports require counting issued certificates by hand."),
          bullet("<b>Uncontrolled editable copies.</b> Retained Word copies of issued certificates increase storage clutter and the risk of confusion between the official record and editable drafts."),
          P("The proposed system addresses these problems while preserving "
            "the familiar barangay workflow: the farmer requests, the "
            "barangay secretary reviews and admits, and the certificate is "
            "issued under barangay authority.")]

# ------------------------------------------------------------ 3. Concept --
story += [P("3. The Concept", "H1x"),
          P("The RSBSA Certification Manager is a single web application "
            "that connects three participants: the <b>farmer</b>, who submits "
            "a request without needing an account; the <b>barangay secretary</b>, "
            "who reviews only the requests of the assigned barangay; and the "
            "<b>system administrator</b>, who manages barangays, user accounts, "
            "official templates, and office settings."),
          P("The system is built on six principles:", "Bodyx"),
          bullet("<b>Template-driven issuance.</b> Certificates are generated from the official Word template containing placeholders, preserving the approved format and wording."),
          bullet("<b>Barangay-level routing and access control.</b> Every request is directed to the secretary of the selected barangay; a secretary cannot view or process another barangay's records."),
          bullet("<b>PDF-only issued copy.</b> The filed certificate is a PDF. The Word rendering exists only temporarily during generation and is never retained as an issued copy."),
          bullet("<b>Expiring files, permanent records.</b> File storage is time-bound (30 days), while the underlying certification records, reports, and audit logs are permanent within the system."),
          bullet("<b>Full auditability.</b> Submissions, corrections, approvals, rejections, issuances, downloads, file deletions, and regenerations are recorded with the user, date, time, and barangay."),
          bullet("<b>Regeneration instead of indefinite file storage.</b> Because the record is preserved, an official PDF can be reproduced when needed rather than keeping editable or duplicate files indefinitely.")]

# ----------------------------------------------------------- 4. Workflow --
story += [P("4. How the System Works", "H1x")]
workflow = [
    [head("Step"), head("Actor"), head("Action and system response")],
    [cell("1"), cell("<b>Farmer (guest)</b>"),
     cell("Selects the barangay, states how many certifications are needed first (1 to 10), then completes one form per certificate — choosing the certification type separately for each entry. The system issues one reference number for the whole request.")],
    [cell("2"), cell("<b>System</b>"),
     cell("Checks the RSBSA number against the farmer masterlist. Known farmers can pre-fill their details, a matching RSBSA number under a different name triggers a duplicate warning, and if no record matches, a Farmer Data Entry form encodes the farmer directly into the masterlist - no CSV upload is needed.")],
    [cell("3"), cell("<b>Barangay Secretary</b>"),
     cell("Reviews only the assigned barangay's queue, rectifies any mistyped information, then approves and issues or rejects with a stated reason. Every correction is recorded with its old and new values.")],
    [cell("4"), cell("<b>System</b>"),
     cell("Assigns the certificate number, inserts the system timestamp, leaves the OR Number blank for the Treasurer, renders the certificate, and files the PDF. The temporary Word rendering is automatically deleted.")],
    [cell("5"), cell("<b>Secretary / Admin</b>"),
     cell("Searches the archive, downloads the PDF while it is retained, exports listings to Excel or CSV, and prepares the monthly accomplishment report.")],
    [cell("6"), cell("<b>System (after 30 days)</b>"),
     cell("Automatically deletes the PDF file only. The certificate record remains in the archive and reports, marked \"PDF purged - record retained,\" and the deletion is written to the audit trail.")],
    [cell("7"), cell("<b>Authorized user</b>"),
     cell("If an official copy is needed later, regenerates the PDF from the preserved record. The regenerated certificate keeps the original certificate number, issue date, and timestamp, and receives a fresh 30-day file retention.")],
]
story += [styled_table(workflow, [14 * mm, 36 * mm, 124 * mm]),
          P("The farmer can track the status of a request at any time using "
            "the reference number. Approved requests display all issued "
            "certificate numbers; rejected requests display the secretary's "
            "reason.", "BodySmall")]

# ------------------------------------------------------------- 5. Features -
story += [P("5. Principal Features for Barangay Operations", "H1x"),
          bullet("<b>Batch certification requests.</b> One reference number may cover up to ten certificates, each receiving its own certificate number upon approval."),
          bullet("<b>Secretary rectification.</b> Authorized secretaries may correct farmer-encoded information before issuance; the exact correction is permanently auditable."),
          bullet("<b>Standardized CAPITAL-letter entries</b> for consistent names and details on issued certificates."),
          bullet("<b>Farmer masterlist and pre-filling.</b> Profiles are built automatically from requests, reducing repeated encoding for returning farmers."),
          bullet("<b>Duplicate detection.</b> Reuse of an RSBSA number under a different name is flagged to both the farmer and the reviewing secretary."),
          bullet("<b>Searchable certificate archive</b> with Excel and CSV export for submission to higher offices."),
          bullet("<b>Monthly accomplishment report</b> summarizing issuances by barangay and by certifying officer, with a downloadable signed-format PDF."),
          bullet("<b>Dashboard indicators</b> showing issuances by month and by barangay."),
          bullet("<b>System-generated timestamp</b> on every certificate, while the OR Number remains blank for the Treasurer to write and issue."),
          bullet("<b>Multi-parcel requests.</b> Additional entries represent other parcels of the same farmer: name, civil status, address, and RSBSA number copy automatically from the first entry, while each parcel keeps its own location and farm area, printed on its own certificate."),
          bullet("<b>QR scanning of the RSBSA Number.</b> Instead of typing, farmers may scan a QR code with the device camera or upload a QR photo; manual typing remains available."),
          bullet("<b>Farmer Data Entry.</b> When an RSBSA number is not yet in the database, the farmer or staff encode the profile directly into the masterlist instead of preparing and uploading a CSV file."),
          bullet("<b>Bilingual farmer screens.</b> Farmer-facing pages show Filipino beside the English (for example, <i>Farmer Name (Pangalan ng Magsasaka)</i>); staff screens remain in English."),
          bullet("<b>Separate ID Card Generator database.</b> Farmer's IDs are generated from a dedicated database that the administrator updates by uploading a CSV file containing the fields used to generate the ID (RSBSA Number, Farmer Name, Gender, Civil Status, Address, Birthdate, Contact Number, and Contact Person in Case of Emergency) - imports only add new records and skip duplicate RSBSA numbers instead of overwriting them - or by copying selected farmers from the masterlist; blank details and the ID photo are completed in the ID Generator itself.")]

story += [P("Safeguarding the masterlist: NEW-tag verification", "H2x"),
          P("Every farmer profile created through Farmer Data Entry or from a "
            "submitted request is automatically tagged <b>NEW</b>; profiles "
            "that already existed count as verified. The tag blocks nothing - "
            "the farmer may still request and be issued certificates - but it "
            "is visible to the secretary during review and tells the "
            "administrator that the record still has to be checked. Only the "
            "<b>administrator</b> can edit masterlist entries, mark a NEW "
            "record <b>Verified</b>, or delete an unverified record found to "
            "be bogus; deletion is refused once the farmer has issued "
            "certificates, so certificate history can never be erased this "
            "way. Every edit (recorded with its old and new values), "
            "verification, and deletion is written to the audit trail."),
          P("Logging of issued information and CSV export", "H2x"),
          P("At the moment a certificate is approved and issued, the system "
            "permanently saves in the database the exact information entered "
            "for that certificate - farmer name, RSBSA number, parcel "
            "location, farm area, purpose, and any other requested details. "
            "This snapshot belongs to the certificate itself, so later edits "
            "to the farmer's masterlist profile never rewrite issued history. "
            "From the Archive, authorized users can download the <b>Issued "
            "Data (CSV)</b>: one row per issued certificate showing its "
            "certificate number, type, reference, date, and issuer, plus "
            "every entered detail as a spreadsheet column. The export "
            "respects barangay access and the archive's search and date "
            "filters, and every download is audit-logged. The office "
            "therefore keeps a complete, spreadsheet-ready record of what "
            "was actually issued, independent of the 30-day PDF retention."),
          P("Farmer's ID Card Maker", "H2x"),
          P("The system also generates an official back-to-back <b>FARMER'S "
            "ID</b> for each registered farmer. The administrator opens the "
            "farmer's record in the separate ID Generator database, confirms "
            "the details on file (name, RSBSA number, gender, civil status, "
            "address, and birthdate) together with the farmer's photo and "
            "contact person in case of emergency, and generates the card. "
            "The back carries reminders, a signature line, and a <b>QR code encoding the "
            "farmer's RSBSA Number</b> - readable by the same QR scanner "
            "used in the request form. Each card is registered with a "
            "control number (<b>FID-YYYY-####</b>), an issued date, and a "
            "validity period, and bears an <b>MAO Verified</b> mark. "
            "Reprints keep the same control number and are counted in the "
            "registry; generation and reprinting are audit-logged, while "
            "secretaries may view a farmer's ID status but cannot produce "
            "cards. The output is a print-ready two-page PDF sized exactly "
            "to a standard CR80 card (85.6 x 54 mm), plus front and back "
            "images."),
          P("One-Click Backup and Restore", "H2x"),
          P("The administrator can download a <b>full backup in one click</b> "
            "(Administration, then Settings): a single ZIP file containing "
            "the complete database together with every template, filed "
            "certificate PDF, farmer ID photo, and generated ID card. "
            "Restoring a backup first saves a <b>pre-restore safety copy</b> "
            "on the server, validates the backup before anything is "
            "replaced, and writes the restore to the audit trail. This "
            "gives the office a simple safekeeping and recovery practice "
            "that does not depend on technical staff."),
          P("Offline Mode for Remote Barangays", "H2x"),
          P("The system can be <b>installed like an application</b> on a "
            "phone or computer and keeps working <b>without internet</b>. "
            "Pages already opened - the dashboard, request queues, farmer "
            "masterlist, and archive - remain readable, and work done "
            "offline (farmer submissions, encoding of new farmers, and "
            "secretary corrections, approvals, and rejections) is saved "
            "on the device and <b>syncs automatically</b> when the "
            "connection returns. Approvals take effect on the server at "
            "the moment of syncing, when certificate numbers and PDFs are "
            "generated; anything the server cannot apply stays flagged "
            "for the secretary's attention instead of being lost. This "
            "supports barangays with weak or intermittent connectivity.")]
if ID_FRONT.exists() and ID_BACK.exists():
    id_fig = Table([[Image(str(ID_FRONT), width=85 * mm, height=53.4 * mm),
                     Image(str(ID_BACK), width=85 * mm, height=53.4 * mm)]],
                   colWidths=[87 * mm, 87 * mm], hAlign="CENTER")
    id_fig.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP"),
                                ("LEFTPADDING", (0, 0), (-1, -1), 1),
                                ("RIGHTPADDING", (0, 0), (-1, -1), 1)]))
    story += [id_fig,
              P("Figure 1. The Farmer's ID (front and back) generated by the "
                "system. The QR code on the back encodes the farmer's RSBSA "
                "Number.", "Caption")]

# ------------------------------------------------------------ 6. Retention -
story += [P("6. PDF-Only Filing and 30-Day File Retention", "H1x"),
          P("This section presents the specific update for the officials' "
            "consideration. It distinguishes between the <b>certificate file</b> "
            "and the <b>certificate record</b>. The file is temporary; the "
            "record is permanent."),
          callout("RULE IN ONE SENTENCE",
                  "No editable Word copy of an issued certificate is saved; "
                  "the PDF copy is kept for 30 days and then automatically "
                  "deleted, but the certificate record is never deleted and "
                  "the PDF can be regenerated whenever officially needed.")]
retention = [
    [head("Item"), head("Treatment under the concept"), head("Retention")],
    [cell("<b>Issued certificate in Word (.docx)</b>"),
     cell("Used only as a temporary rendering file during generation; deleted immediately after the PDF is produced. It is not filed and cannot be downloaded."),
     cell("<b>Not retained</b>")],
    [cell("<b>Issued certificate in PDF (.pdf)</b>"),
     cell("The sole filed copy of the issued certificate. Available for download from the archive during the retention window."),
     cell("<b>30 days</b> from generation or latest regeneration, then automatically deleted")],
    [cell("<b>Certificate record</b>"),
     cell("Certificate number, farmer, barangay, template, request reference, issuer, and issue date/time stored in the database."),
     cell("<b>Permanent</b>; never deleted by the retention process")],
    [cell("<b>Audit trail</b>"),
     cell("Records submissions, corrections, approvals, issuances, downloads, PDF deletions, and PDF regenerations."),
     cell("<b>Permanent</b>; deletions add entries rather than removing them")],
    [cell("<b>Accomplishment-report data</b>"),
     cell("Computed from permanent certificate records; a certificate continues to be counted even after its PDF file has been deleted."),
     cell("<b>Permanent</b>")],
    [cell("<b>Farmer masterlist</b>"),
     cell("Profiles, request history, and certificate references built from submitted requests."),
     cell("<b>Permanent</b>, subject to office direction")],
    [cell("<b>Farmer's ID registry and card files</b>"),
     cell("Control number, issued date, validity, and reprint count stored in the database; card images and PDF kept separately from certificate filings for one-click reprinting."),
     cell("<b>Permanent</b> registry; card files are not covered by the 30-day certificate PDF purge")],
    [cell("<b>Official Word template</b>"),
     cell("The source format uploaded by the administrator. This is not an issued certificate copy and remains necessary for generation."),
     cell("Retained until replaced or deactivated by the administrator")],
]
story += [styled_table(retention, [39 * mm, 92 * mm, 43 * mm]),
          P("The automatic deletion runs when the system starts and once "
            "every 24 hours thereafter. Before any file is deleted, the "
            "system verifies that it has reached the 30-day limit. Each "
            "deletion is itself recorded in the audit trail, so officials "
            "can verify not only that a certificate was issued, but also "
            "when its PDF file was disposed of and that the record remains."),
          P("<b>Regeneration safeguard.</b> Regeneration is limited to the "
            "administrator and the secretary of the barangay that issued the "
            "certificate. The regenerated PDF reproduces the original "
            "certificate number, issue date, timestamp, farmer information, "
            "and issuing officer. Regeneration does not create a new "
            "certificate record and does not alter accomplishment-report "
            "totals; it only produces a fresh file with a new 30-day period.")]

# ------------------------------------------------------------- 7. Benefits -
story += [P("7. Expected Benefits", "H1x")]
benefits = [
    [head("Beneficiary"), head("Expected benefit")],
    [cell("<b>Farmers</b>"),
     cell("Faster requests, a single reference number for multiple certificates, online tracking, less repeated encoding through masterlist pre-filling, and an official Farmer's ID card whose QR code carries their RSBSA Number.")],
    [cell("<b>Barangay Secretaries</b>"),
     cell("A focused queue for their own barangay, editable review screens, one-click batch issuance, searchable records, and automatic monthly reports.")],
    [cell("<b>Barangay Officials</b>"),
     cell("Consistent certificates under the official template, clear accountability for every issuance, reliable accomplishment figures, and reduced exposure from uncontrolled editable certificate copies.")],
    [cell("<b>Public / higher offices</b>"),
     cell("Standardized PDF certificates, exportable listings, and a verifiable audit trail for monitoring and reporting.")],
]
story += [styled_table(benefits, [42 * mm, 132 * mm])]

# ---------------------------------------------------------------- 8. Roles -
story += [P("8. Roles and Responsibilities", "H1x")]
roles = [
    [head("Role"), head("Responsibilities under the concept")],
    [cell("<b>Punong Barangay / Barangay Officials</b>"),
     cell("Note and approve the operating concept; confirm the official certificate template, signatories, and any office-specific instructions; designate the secretary or focal person.")],
    [cell("<b>Barangay Secretary</b>"),
     cell("Review and rectify requests, approve or reject with reasons, issue certificates, download or regenerate PDFs when needed, and prepare monthly accomplishment reports.")],
    [cell("<b>System Administrator</b>"),
     cell("Create accounts and barangays, upload and maintain official templates, configure office settings, verify NEW farmer records, generate and reprint Farmer's ID cards, monitor the audit trail, and safeguard database backups.")],
    [cell("<b>Barangay Treasurer</b>"),
     cell("Write and issue the Official Receipt number on the space intentionally left blank on the certificate.")],
    [cell("<b>Farmer / requesting party</b>"),
     cell("Provide accurate information, keep the reference number, and track the request status through the system.")],
]
story += [styled_table(roles, [48 * mm, 126 * mm])]

# ------------------------------------------------------------ 9. Safeguards -
story += [P("9. Safeguards, Limitations, and Risk Controls", "H1x"),
          bullet("<b>Access control.</b> Secretaries and administrators use individual password-protected accounts. Farmers submit as guests but cannot access internal records."),
          bullet("<b>Barangay scoping.</b> A secretary's access is limited server-side to the assigned barangay's requests, certificates, farmers, reports, and audit entries."),
          bullet("<b>Auditability.</b> Logins, submissions, rectifications, decisions, downloads, exports, PDF deletions, and regenerations are timestamped and attributable."),
          bullet("<b>Record permanence.</b> The retention process deletes files only. It does not delete certificate, request, farmer, report, or audit records, and certificate numbers are never reused."),
          bullet("<b>Template control.</b> Only administrators may upload or deactivate official templates and edit the fields collected from farmers."),
          bullet("<b>Controlled ID issuance.</b> Only the administrator can generate or reprint Farmer's ID cards; secretaries can view a farmer's ID status but cannot produce cards."),
          bullet("<b>Operational caution.</b> Because the database holds the permanent records, regular and secure backups of the system database should be part of standard office operations."),
          P("This concept note does not amend any existing records-disposition "
            "schedule or legal requirement. Before full adoption, officials "
            "may align the 30-day PDF-file rule and the permanent system-record "
            "retention with applicable barangay, city, COA, and data-privacy "
            "guidance. The system's file-level rule is intentionally "
            "conservative: even when a PDF file is deleted, the evidence of "
            "issuance and the ability to reproduce the certificate remain.")]

# ------------------------------------------------------------ 10. Request --
story += [P("10. Requested Action from Barangay Officials", "H1x"),
          P("In view of the foregoing, Barangay Officials are respectfully "
            "requested to:"),
          bullet("<b>Note</b> the RSBSA Certification Manager concept, including PDF-only filing and the 30-day PDF file retention with permanent system records;"),
          bullet("<b>Approve</b> the pilot use of the system for RSBSA certification requests and issuances in the barangay;"),
          bullet("<b>Confirm</b> the official certificate template, signatories, and barangay information to be used by the system;"),
          bullet("<b>Designate</b> the Barangay Secretary or focal person responsible for reviewing requests and preparing monthly accomplishment reports; and"),
          bullet("<b>Provide guidance</b> on any additional office policies that should be reflected in the system's configuration or operating procedures.")]

story += [P("11. Conclusion", "H1x"),
          P("The RSBSA Certification Manager preserves the established "
            "barangay certification process while making it faster, more "
            "consistent, searchable, and accountable. Its PDF-only and "
            "30-day file-retention rule reduces uncontrolled editable copies "
            "and storage burden without sacrificing public records: the "
            "certificate evidence, monthly reporting basis, and audit trail "
            "remain permanently available, and an official PDF can be "
            "regenerated whenever required."),
          P("The system is ready for demonstration. Officials may inspect "
            "the farmer submission flow, secretary review and rectification, "
            "certificate archive, farmer masterlist, accomplishment report, "
            "audit trail, the Farmer's ID Card Maker, and the PDF "
            "purge-and-regeneration process during the presentation."),
          Spacer(1, 7 * mm),
          HRFlowable(width="100%", thickness=0.5,
                     color=colors.HexColor("#C7D5E4"),
                     spaceBefore=2 * mm, spaceAfter=5 * mm)]
signatures = [
    [cell("Prepared by:", "TableCellSmall"), cell("Noted by:", "TableCellSmall")],
    [cell("<br/><br/>___________________________________<br/>"
          "<b>System Administrator / Proponent</b><br/>Date: ______________", "TableCellSmall"),
     cell("<br/><br/>___________________________________<br/>"
          "<b>Punong Barangay</b><br/>Date: ______________", "TableCellSmall")],
    [cell("Reviewed by:", "TableCellSmall"), cell("Conforme:", "TableCellSmall")],
    [cell("<br/><br/>___________________________________<br/>"
          "<b>Barangay Secretary</b><br/>Date: ______________", "TableCellSmall"),
     cell("<br/><br/>___________________________________<br/>"
          "<b>Barangay Official</b><br/>Date: ______________", "TableCellSmall")],
]
sig_table = Table(signatures, colWidths=[87 * mm, 87 * mm], hAlign="CENTER")
sig_table.setStyle(TableStyle([
    ("VALIGN", (0, 0), (-1, -1), "TOP"),
    ("LEFTPADDING", (0, 0), (-1, -1), 8),
    ("RIGHTPADDING", (0, 0), (-1, -1), 8),
    ("TOPPADDING", (0, 0), (-1, -1), 7),
    ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
]))
story += [sig_table, PageBreak()]

# --------------------------------------------------------------- Appendix --
story += [P("Appendix A. System Reference View", "H1x"),
          P("The archive screen below shows the operating rule in the live "
            "system. Each certificate displays how long its PDF will be kept. "
            "A certificate whose PDF has reached 30 days is marked "
            "<b>\"PDF purged - record retained\"</b> and offers an authorized "
            "<b>Regenerate PDF</b> action. The certificate itself remains in "
            "the archive and continues to be counted in reports.")]
if SCREENSHOT.exists():
    story += [Image(str(SCREENSHOT), width=174 * mm, height=118 * mm),
              P("Figure 2. Certificate Archive showing PDF retention dates, "
                "a purged PDF record, and the Regenerate PDF action.", "Caption")]
story += [P("Appendix B. Key Terms", "H1x")]
terms = [
    [head("Term"), head("Meaning in this concept")],
    [cell("<b>Certificate file</b>"), cell("The PDF copy stored on disk for download. Subject to the 30-day file retention.")],
    [cell("<b>Certificate record</b>"), cell("The permanent database entry proving that a numbered certificate was issued, to whom, where, when, and by whom.")],
    [cell("<b>PDF purge</b>"), cell("Automatic deletion of the PDF file after 30 days. It is not a deletion of the certificate record.")],
    [cell("<b>Regeneration</b>"), cell("Reproduction of the same certificate as a new PDF from the permanent record, with a fresh 30-day file retention.")],
    [cell("<b>Template</b>"), cell("The official Word format controlled by the administrator and used to render certificates. Templates are not issued certificate copies.")],
    [cell("<b>Farmer's ID</b>"), cell("The official back-to-back identification card generated per farmer, registered under a control number (FID-YYYY-####) with an MAO Verified mark and a QR code of the RSBSA Number.")],
    [cell("<b>NEW farmer record</b>"), cell("A newly encoded farmer profile awaiting the administrator's verification; the tag is informational and does not block requests or issuances.")],
    [cell("<b>Issued data</b>"), cell("The permanent database snapshot of the exact information entered for each issued certificate, exportable from the Archive as CSV.")],
]
story += [styled_table(terms, [42 * mm, 132 * mm]),
          Spacer(1, 5 * mm),
          P("Prepared for presentation to Barangay Officials. This document "
            "explains the system concept and operating safeguards; it does "
            "not contain user passwords or confidential farmer information.",
            "FooterNote")]

doc.build(story)
print(f"Wrote {OUT} ({OUT.stat().st_size:,} bytes)")
