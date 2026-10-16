"""Farmer's ID card renderer (front + back, CR80 at 600 dpi).

Minimal, modern design (warm paper, deep-green ink, matcha gradient
accents, pill chips, rounded photo/QR frames). All styling lives in
DESIGN / TERMS below so the card can be re-skinned in one place without
touching the workflow. Renders PNG previews and a two-page, true-size
PDF (page 1 = front, page 2 = back) for back-to-back printing.
"""
import io
import os

import qrcode
from PIL import Image, ImageDraw, ImageFont, ImageOps

# -------------------------------------------------------------------------- #
# DESIGN (modifiable): colours, header text and back-of-card reminders.
# -------------------------------------------------------------------------- #
DESIGN = {
    "paper": (250, 248, 243),        # warm off-white card
    "ink": (20, 35, 27),             # deep green-black text
    "muted": (110, 122, 112),        # soft grey-green labels
    "green": (30, 122, 70),          # primary green
    "grad_a": (31, 157, 85),         # gradient start (fresh green)
    "grad_b": (167, 224, 106),       # gradient end (matcha lime)
    "chip": (233, 245, 226),         # pill chip background
    "line": (226, 228, 219),         # hairlines / borders
    "white": (255, 255, 255),
    "header_line1": "REPUBLIC OF THE PHILIPPINES",
    "title": "farmer's id",
    "subtitle": "Registry System for Basic Sectors in Agriculture (RSBSA)",
}

TERMS = [
    "Present this ID when claiming farm inputs, subsidies, crop "
    "insurance, and other agriculture assistance.",
    "This ID is non-transferable and remains the property of the "
    "issuing barangay / local government unit.",
    "Report loss or damage of this ID to the Barangay Hall "
    "immediately.",
]

BASE_W, BASE_H = 1016, 638  # authored layout space (CR80 @ 300 dpi)
RENDER_SCALE = 2             # render natively at 2x -> 600 dpi output
DPI = 300 * RENDER_SCALE
W, H = BASE_W * RENDER_SCALE, BASE_H * RENDER_SCALE


def S(v):
    """Scale an authored (300-dpi) measurement to render pixels."""
    return int(round(v * RENDER_SCALE))

# Official seal of the Office of the Municipal Agriculturist, Alcala,
# Province of Cagayan (transparent PNG; drawn on both card faces when present).
LOGO_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                         "assets", "mao_logo.png")
_logo_cache = {}


def _paste_logo(base, x, y, height):
    if not os.path.exists(LOGO_PATH):
        return
    if "img" not in _logo_cache:
        _logo_cache["img"] = Image.open(LOGO_PATH).convert("RGBA")
    logo = _logo_cache["img"]
    w = int(height * logo.width / logo.height)
    resized = logo.resize((w, height), Image.Resampling.LANCZOS)
    base.paste(resized, (x, y), resized)

_FONT_DIRS = [
    "/usr/share/fonts/opentype/inter",
    "/usr/share/fonts/truetype/dejavu",
    "/usr/share/fonts/dejavu",
]

_FONT_FILES = {
    "display": "InterDisplay-ExtraBold.otf",
    "black": "InterDisplay-Black.otf",
    "bold": "Inter-Bold.otf",
    "semi": "Inter-SemiBold.otf",
    "med": "Inter-Medium.otf",
    "reg": "Inter-Regular.otf",
    "mono": "DejaVuSansMono-Bold.ttf",
}


def _font(name, size):
    for d in _FONT_DIRS:
        p = os.path.join(d, name)
        if os.path.exists(p):
            return ImageFont.truetype(p, size)
    # Fallback if the Inter family is unavailable: DejaVu (bold for the
    # heavy weights) rather than PIL's tiny bitmap default.
    fb = ("DejaVuSansMono-Bold.ttf" if "Mono" in name else
          "DejaVuSans-Bold.ttf" if any(
              w in name for w in ("Bold", "Black", "SemiBold", "Medium"))
          else "DejaVuSans.ttf")
    for d in _FONT_DIRS:
        p = os.path.join(d, fb)
        if os.path.exists(p):
            return ImageFont.truetype(p, size)
    return ImageFont.load_default()


def F(size, bold=False, mono=False, weight=None):
    """Font helper. weight: display|black|bold|semi|med|reg|mono."""
    if weight is None:
        weight = "mono" if mono else ("bold" if bold else "reg")
    return _font(_FONT_FILES[weight], S(size))


def _wrap(draw, text, font, max_w):
    words = str(text or "").split()
    lines, cur = [], ""
    for w in words:
        t = (cur + " " + w).strip()
        if draw.textlength(t, font=font) <= max_w:
            cur = t
        else:
            if cur:
                lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)
    return lines or ["—"]


def _tracked(draw, x, y, text, font, fill, tracking=3):
    """Draw text with letter spacing (for the tiny uppercase labels)."""
    tracking = S(tracking)
    cx = x
    for ch in str(text):
        draw.text((cx, y), ch, font=font, fill=fill)
        cx += draw.textlength(ch, font=font) + tracking
    return cx - tracking


def _tracked_w(draw, text, font, tracking=3):
    tracking = S(tracking)
    return sum(draw.textlength(ch, font=font) + tracking
               for ch in str(text)) - tracking


def _gradient(w, h, a, b):
    """Horizontal two-stop gradient image."""
    img = Image.new("RGB", (w, h))
    d = ImageDraw.Draw(img)
    for x in range(w):
        t = x / max(w - 1, 1)
        d.line([x, 0, x, h],
               fill=tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3)))
    return img


def _pill(base, xy, text, font, fg, bg=None, pad_x=18, grad=False):
    """Draw a rounded pill with centred text; returns its width."""
    pad_x = S(pad_x)
    d = ImageDraw.Draw(base)
    tw = d.textlength(text, font=font)
    w, h = int(tw + pad_x * 2), xy[3] - xy[1]
    x0, y0 = xy[0], xy[1]
    mask = Image.new("L", (w, h), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, w - 1, h - 1],
                                           radius=h // 2, fill=255)
    if grad:
        base.paste(_gradient(w, h, DESIGN["grad_a"], DESIGN["grad_b"]),
                   (x0, y0), mask)
    else:
        base.paste(Image.new("RGB", (w, h), bg), (x0, y0), mask)
    d = ImageDraw.Draw(base)
    d.text((x0 + pad_x, y0 + (h - font.size) // 2 - S(2)), text, font=font,
           fill=fg)
    return w


def _blobs(img):
    """Soft gradient-tinted circles bleeding off the top-right corner."""
    ov = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(ov)
    d.ellipse([S(770), S(-190), S(1150), S(190)], fill=DESIGN["grad_b"] + (110,))
    d.ellipse([S(880), S(-120), S(1180), S(180)], fill=DESIGN["grad_a"] + (70,))
    d.ellipse([S(-120), S(520), S(90), S(730)], fill=DESIGN["grad_b"] + (60,))
    img.paste(Image.alpha_composite(img.convert("RGBA"), ov).convert("RGB"),
              (0, 0))


def _field(draw, x, y, label, value, w=300, vsize=24):
    _tracked(draw, x, y, label.upper(), F(14, weight="semi"),
             DESIGN["muted"])
    draw.text((x, y + S(22)), str(value or "—"), font=F(vsize, weight="semi"),
              fill=DESIGN["ink"])


def render_front(farmer: dict, control_no: str, valid_until: str,
                 photo: Image.Image | None, org_line: str) -> Image.Image:
    img = Image.new("RGB", (W, H), DESIGN["paper"])
    img.info["dpi"] = (DPI, DPI)
    _blobs(img)
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([S(1), S(1), W - S(2), H - S(2)], radius=S(26),
                        outline=DESIGN["line"], width=S(2))

    # header: Municipal Agriculturist seal + two quiet lines
    _paste_logo(img, S(40), S(16), S(92))
    _tracked(d, S(148), S(38), DESIGN["header_line1"], F(16, weight="semi"),
             DESIGN["muted"], tracking=4)
    d.text((S(148), S(62)), org_line, font=F(20, weight="semi"),
           fill=DESIGN["ink"])
    # big title + lime dot + MAO Verified pill
    title = DESIGN["title"].upper()
    d.text((S(42), S(108)), title, font=F(74, weight="black"),
           fill=DESIGN["ink"])
    tw = d.textlength(title, font=F(74, weight="black"))
    d.ellipse([S(52) + tw, S(164), S(70) + tw, S(182)], fill=DESIGN["grad_a"])
    vt = "MAO Verified"
    vw = int(d.textlength(vt, font=F(18, weight="bold")) + S(40))
    _pill(img, (W - S(44) - vw, S(126), W - S(44), S(170)), vt,
          F(18, weight="bold"), DESIGN["white"], grad=True, pad_x=20)
    d = ImageDraw.Draw(img)

    # photo (square squircle, high-quality resample)
    px, py, pw, ph = S(44), S(224), S(320), S(320)
    if photo is not None:
        ph_img = ImageOps.fit(photo.convert("RGB"), (pw, ph),
                              method=Image.Resampling.LANCZOS)
        mask = Image.new("L", (pw, ph), 0)
        ImageDraw.Draw(mask).rounded_rectangle([0, 0, pw - 1, ph - 1],
                                               radius=S(22), fill=255)
        img.paste(ph_img, (px, py), mask)
    else:
        d.rounded_rectangle([px, py, px + pw, py + ph], radius=S(22),
                            fill=(238, 240, 233))
        d.ellipse([px + S(98), py + S(66), px + S(222), py + S(190)],
                  fill=(178, 188, 175))
        d.pieslice([px + S(54), py + S(182), px + S(266), py + S(318)],
                   180, 360, fill=(178, 188, 175))
        t = "no photo"
        tw2 = d.textlength(t, font=F(19, weight="semi"))
        d.text((px + (pw - tw2) / 2, py + ph - S(42)), t,
               font=F(19, weight="semi"), fill=DESIGN["muted"])
    d.rounded_rectangle([px, py, px + pw, py + ph], radius=S(22),
                        outline=DESIGN["line"], width=S(2))

    # details (fixed rows — airy, no dividers)
    x = S(392)
    _tracked(d, x, S(224), "NAME", F(14, weight="semi"), DESIGN["muted"])
    name_lines = _wrap(d, farmer.get("name"), F(37, weight="bold"), S(580))[:2]
    yy = S(246)
    for line in name_lines:
        d.text((x, yy), line, font=F(37, weight="bold"), fill=DESIGN["ink"])
        yy += S(43)
    # RSBSA number: full-width panel using the whole detail column, with
    # the number auto-fitted as large as the available space allows.
    rsbsa_t = str(farmer.get('rsbsa_number') or '—')
    d.rounded_rectangle([x, S(334), W - S(44), S(426)], radius=S(18),
                        fill=DESIGN["chip"], outline=DESIGN["line"],
                        width=S(2))
    _tracked(d, x + S(20), S(346), "RSBSA NUMBER", F(12, weight="semi"),
             DESIGN["green"], tracking=3)
    rsbsa_size = 42
    while (rsbsa_size > 20 and
           d.textlength(rsbsa_t, font=F(rsbsa_size, weight="mono")) > S(540)):
        rsbsa_size -= 1
    d.text((x + S(20), S(370)), rsbsa_t, font=F(rsbsa_size, weight="mono"),
           fill=DESIGN["green"])
    gender_val = str(farmer.get("gender") or "").strip().upper()
    bgy_val = str(farmer.get("barangay") or "").strip()
    if gender_val:
        _field(d, x, S(438), "Gender", gender_val, vsize=24)
    elif bgy_val:
        _field(d, x, S(438), "Barangay", bgy_val, vsize=24)
    else:
        _field(d, x, S(438), "Gender", "—", vsize=24)
    _field(d, x + S(306), S(438), "Birthdate", farmer.get("birthdate") or "—",
           vsize=24)
    _field(d, x, S(516), "Civil Status", farmer.get("civil_status"),
           vsize=24)
    _tracked(d, x + S(306), S(516), "ADDRESS", F(14, weight="semi"),
             DESIGN["muted"])
    ay = S(538)
    for line in _wrap(d, farmer.get("address"), F(20, weight="med"),
                      S(262))[:2]:
        d.text((x + S(306), ay), line, font=F(20, weight="med"),
               fill=DESIGN["ink"])
        ay += S(24)

    return img


def render_back(farmer: dict, control_no: str, issued_at: str,
                valid_until: str, org_line: str) -> Image.Image:
    img = Image.new("RGB", (W, H), DESIGN["paper"])
    img.info["dpi"] = (DPI, DPI)
    _blobs(img)
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([S(1), S(1), W - S(2), H - S(2)], radius=S(26),
                        outline=DESIGN["line"], width=S(2))

    _paste_logo(img, W - S(44) - S(78), S(18), S(78))
    d.text((S(42), S(30)), "Farmer's ID", font=F(32, weight="black"),
           fill=DESIGN["ink"])
    tw = d.textlength("Farmer's ID", font=F(32, weight="black"))
    d.ellipse([S(50) + tw, S(52), S(62) + tw, S(64)], fill=DESIGN["grad_a"])

    d.text((S(42), S(108)), "reminders", font=F(50, weight="black"),
           fill=DESIGN["ink"])

    y = S(182)
    if "gender" in farmer:
        return_line = ("If found, please return to the Office of the "
                       "Municipal Agriculturist.")
    else:
        return_line = (f"If found, please return to the Barangay Hall of "
                       f"{farmer.get('barangay') or 'the barangay'}.")
    for term in TERMS + [return_line]:
        d.ellipse([S(46), y + S(10), S(58), y + S(22)], fill=DESIGN["grad_a"])
        for line in _wrap(d, term, F(21, weight="reg"), S(520)):
            d.text((S(72), y), line, font=F(21, weight="reg"),
                   fill=DESIGN["ink"])
            y += S(27)
        y += S(12)

    # QR card (white squircle) — QR encodes the RSBSA Number; modules are
    # resampled with NEAREST so they stay perfectly crisp at 600 dpi
    qx, qy, qs = S(628), S(116), S(336)
    d.rounded_rectangle([qx + S(6), qy + S(10), qx + qs + S(6),
                         qy + qs + S(10)],
                        radius=S(26), fill=(232, 234, 226))
    d.rounded_rectangle([qx, qy, qx + qs, qy + qs], radius=S(26),
                        fill=DESIGN["white"], outline=DESIGN["line"],
                        width=S(2))
    qr = qrcode.QRCode(border=1, box_size=10)
    qr.add_data(farmer.get("rsbsa_number") or "")
    qr.make(fit=True)
    qr_img = qr.make_image(fill_color="black", back_color="white") \
        .convert("RGB").resize((S(292), S(292)), Image.Resampling.NEAREST)
    img.paste(qr_img, (qx + S(22), qy + S(22)))
    d = ImageDraw.Draw(img)

    # Farmer's Affiliated FCA panel directly below the QR code
    fx0, fy0, fx1, fy1 = qx, S(476), qx + qs, S(604)
    d.rounded_rectangle([fx0, fy0, fx1, fy1], radius=S(18),
                        fill=DESIGN["chip"], outline=DESIGN["grad_a"],
                        width=S(2))
    _tracked(d, fx0 + S(18), fy0 + S(14), "AFFILIATED FCA",
             F(13, weight="bold"), DESIGN["green"], tracking=2)
    fca_val = str(farmer.get("affiliated_fca") or "").strip().upper() or "—"
    fca_max_w = (fx1 - fx0) - S(36)
    fca_lines = [fca_val]
    fca_font = F(22, weight="bold")
    for pt in range(22, 13, -1):
        cand = F(pt, weight="bold")
        wrapped = _wrap(d, fca_val, cand, fca_max_w)
        if len(wrapped) == 1 and d.textlength(wrapped[0], font=cand) <= fca_max_w:
            fca_font = cand
            fca_lines = wrapped
            break
        if len(wrapped) <= 2 and pt <= 19:
            fca_font = cand
            fca_lines = wrapped[:2]
            break
    else:
        fca_font = F(14, weight="bold")
        fca_lines = _wrap(d, fca_val, fca_font, fca_max_w)[:2]
    line_step = int(fca_font.size * 1.15)
    total_text_h = len(fca_lines) * line_step
    text_top = fy0 + S(38) + max(0, ((fy1 - fy0 - S(52)) - total_text_h) // 2)
    for idx_line, line in enumerate(fca_lines):
        d.text((fx0 + S(18), text_top + idx_line * line_step), line,
               font=fca_font, fill=DESIGN["ink"])

    # signature + issued line: the issued line sits high so there is a
    # clear blank area to sign in above the signature line
    d.text((S(44), S(492)), f"issued {issued_at}  ·  {control_no}",
           font=F(16, weight="med"), fill=DESIGN["muted"])
    d.line([S(44), S(588), S(540), S(588)], fill=DESIGN["muted"],
           width=S(2))
    d.text((S(44), S(596)), "farmer's signature", font=F(15, weight="med"),
           fill=DESIGN["muted"])
    return img


def card_pdf(front: Image.Image, back: Image.Image) -> bytes:
    """Two-page PDF; each page is exactly CR80 (85.6 x 54 mm) at 600 dpi."""
    buf = io.BytesIO()
    front.save(buf, format="PDF", save_all=True, append_images=[back],
               resolution=float(DPI), quality=95)
    return buf.getvalue()


def png_bytes(img: Image.Image) -> bytes:
    """Lossless PNG with 600-dpi metadata for print/import tools."""
    buf = io.BytesIO()
    img.save(buf, format="PNG", dpi=(DPI, DPI), optimize=True)
    return buf.getvalue()


def batch_a4_pdf(card_items: list) -> bytes:
    """Render a batch of ID cards on A4 paper (210 x 297 mm at 300 dpi).

    Each A4 page is optimized for 5 Farmers' IDs (Front and Back side-by-side):
      * Column 1: Front of IDs 1 to 5
      * Column 2: Back of IDs 1 to 5
    Includes clear cutting guide lines for cutting and lamination.
    card_items: list of dicts with 'front' (Image), 'back' (Image), and optional 'label' (str).
    """
    if not card_items:
        raise ValueError("No card items provided for batch print.")

    a4_w, a4_h = 2480, 3508
    target_card_w, target_card_h = 1011, 638
    col_gap = 156
    margin_x = (a4_w - (target_card_w * 2 + col_gap)) // 2  # 151
    row_gap = 28
    margin_y = (a4_h - (target_card_h * 5 + row_gap * 4)) // 2  # 103

    pages = []
    # Process in chunks of 5
    for chunk_idx in range(0, len(card_items), 5):
        chunk = card_items[chunk_idx:chunk_idx + 5]
        page = Image.new("RGB", (a4_w, a4_h), (255, 255, 255))
        d = ImageDraw.Draw(page)

        for row_idx, item in enumerate(chunk):
            y = margin_y + row_idx * (target_card_h + row_gap)
            front_x = margin_x
            back_x = margin_x + target_card_w + col_gap

            f_img = item["front"]
            b_img = item["back"]

            if f_img.size != (target_card_w, target_card_h):
                f_resized = f_img.resize((target_card_w, target_card_h), Image.Resampling.LANCZOS)
            else:
                f_resized = f_img

            if b_img.size != (target_card_w, target_card_h):
                b_resized = b_img.resize((target_card_w, target_card_h), Image.Resampling.LANCZOS)
            else:
                b_resized = b_img

            page.paste(f_resized, (front_x, y))
            page.paste(b_resized, (back_x, y))

            # Draw precise cutting guide lines around front and back cards
            guide_color = (210, 212, 206)
            d.rectangle([front_x - 1, y - 1, front_x + target_card_w, y + target_card_h],
                        outline=guide_color, width=1)
            d.rectangle([back_x - 1, y - 1, back_x + target_card_w, y + target_card_h],
                        outline=guide_color, width=1)

            # Draw subtle tick marks in the margin
            d.line([front_x - 12, y - 1, front_x - 2, y - 1], fill=guide_color, width=1)
            d.line([front_x - 12, y + target_card_h, front_x - 2, y + target_card_h], fill=guide_color, width=1)
            d.line([back_x + target_card_w + 2, y - 1, back_x + target_card_w + 12, y - 1], fill=guide_color, width=1)
            d.line([back_x + target_card_w + 2, y + target_card_h, back_x + target_card_w + 12, y + target_card_h], fill=guide_color, width=1)

            # Label on outer margin
            label = item.get("label") or f"Farmer ID #{chunk_idx + row_idx + 1}"
            d.text((front_x, y - 16), f"FRONT  ·  {label}", font=F(11, weight="med"), fill=(140, 145, 140))
            d.text((back_x, y - 16), f"BACK  ·  {label}", font=F(11, weight="med"), fill=(140, 145, 140))

        pages.append(page)

    buf = io.BytesIO()
    first_page = pages[0]
    other_pages = pages[1:]
    first_page.save(buf, format="PDF", save_all=True, append_images=other_pages,
                    resolution=300.0, quality=95)
    return buf.getvalue()

