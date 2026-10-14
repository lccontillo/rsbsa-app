"use strict";

/* ============================ core helpers ============================ */
const $app = document.getElementById("app");
const $navLinks = document.getElementById("nav-links");
const $navUser = document.getElementById("nav-user");
const $modalRoot = document.getElementById("modal-root");
const $toastWrap = document.getElementById("toast-wrap");

let ME = null;
let NEEDS_SETUP = false;
const ME_KEY = "rsbsa_me_v1";
function saveMeSnapshot() {
  try {
    if (ME) localStorage.setItem(ME_KEY, JSON.stringify(ME));
    else localStorage.removeItem(ME_KEY);
  } catch (_) {}
}
function loadMeSnapshot() {
  try { return JSON.parse(localStorage.getItem(ME_KEY)) || null; }
  catch (_) { return null; }
}
const BGY_KEY = "rsbsa_barangays_v1";
function rememberBarangays(list) {
  if (Array.isArray(list) && list.length) {
    try { localStorage.setItem(BGY_KEY, JSON.stringify(list)); } catch (_) {}
  }
}
function cachedBarangays() {
  try { return JSON.parse(localStorage.getItem(BGY_KEY)) || []; }
  catch (_) { return []; }
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

/* Standard data-entry choices. Values are stored in ALL CAPS. */
const GENDER_OPTIONS = ["MALE", "FEMALE"];
const CIVIL_STATUS_OPTIONS = ["SINGLE", "MARRIED", "WIDOWED", "SEPARATED",
                              "DIVORCED", "ANNULLED"];

function _choiceValue(v) {
  return String(v || "").trim().toUpperCase();
}

function _normalizeChoice(kind, current) {
  const cur = _choiceValue(current);
  if (kind === "gender") {
    return ({ M: "MALE", MAN: "MALE", LALAKI: "MALE", F: "FEMALE",
              WOMAN: "FEMALE", BABAE: "FEMALE" })[cur] || cur;
  }
  if (kind === "civil") {
    return ({ WIDOW: "WIDOWED", WIDOWER: "WIDOWED",
              "LEGALLY SEPARATED": "SEPARATED",
              SEPARATE: "SEPARATED" })[cur] || cur;
  }
  return cur;
}

function _choiceKind(key) {
  const k = _choiceValue(key);
  if (["GENDER", "SEX", "KASARIAN"].includes(k)) return "gender";
  if (k === "CIVIL_STATUS" || k.includes("CIVIL")) return "civil";
  return "";
}

function _choiceOptionsFor(kind, current) {
  const options = kind === "gender" ? GENDER_OPTIONS : CIVIL_STATUS_OPTIONS;
  const cur = _normalizeChoice(kind, current);
  let html = `<option value="">— SELECT —</option>` +
    options.map((o) => `<option value="${esc(o)}" ${cur === o ? "selected" : ""}>${esc(o)}</option>`).join("");
  if (cur && !options.includes(cur)) {
    html += `<option value="${esc(cur)}" selected>${esc(cur)}</option>`;
  }
  return html;
}

/* CAPS standard: text-like data inputs are converted to ALL CAPS as the
   user types (password/date/number/file controls and .no-caps forms such
   as Login and Secretary/User creation are untouched). */
document.addEventListener("input", (e) => {
  const el = e.target;
  if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return;
  const fieldKey = (el.name || el.dataset.key || el.id || "").toUpperCase();
  if (fieldKey === "FARM_AREA" || fieldKey === "F_FARM_AREA") {
    let cleaned = String(el.value || "").replace(/[^0-9.]/g, "");
    const firstDot = cleaned.indexOf(".");
    if (firstDot !== -1) {
      cleaned = cleaned.slice(0, firstDot + 1) +
                cleaned.slice(firstDot + 1).replace(/\./g, "");
    }
    if (cleaned !== el.value) el.value = cleaned;
    return;
  }
  if (el.classList.contains("no-caps") ||
      el.closest(".no-caps") ||
      el.closest("#login-form") ||
      el.closest("#usr-add") ||
      el.closest("#setup-form")) {
    return;
  }
  const type = (el.type || "text").toLowerCase();
  if (el instanceof HTMLInputElement &&
      !["text", "search", "tel", "email", "url", ""].includes(type)) return;
  const upper = el.value.toUpperCase();
  if (upper === el.value) return;
  const start = el.selectionStart;
  const end = el.selectionEnd;
  el.value = upper;
  try {
    if (start !== null && end !== null) el.setSelectionRange(start, end);
  } catch (_) { /* some control types do not expose a caret */ }
});

/* Highlight mandatory fields that do not have data input yet for Secretaries */
function _applyMissingFieldHighlights(container, bannerId = "") {
  if (!container) return () => 0;
  const controls = [...container.querySelectorAll(
    'input:not([type="file"]):not([type="checkbox"]):not([disabled]), ' +
    'select:not([disabled]), textarea:not([disabled])'
  )].filter((el) => el.id !== "ap-notes" && el.id !== "entry-type" && el.id !== "prefill-rsbsa");

  function refresh() {
    let missing = 0;
    controls.forEach((el) => {
      const empty = !(el.value || "").toString().trim();
      const fieldWrap = el.closest(".field");
      el.classList.toggle("input-missing", empty);
      if (fieldWrap) {
        fieldWrap.classList.toggle("field-missing", empty);
        const lbl = fieldWrap.querySelector("label");
        if (lbl) {
          let tag = lbl.querySelector(".missing-tag");
          if (empty) {
            if (!tag) {
              tag = document.createElement("span");
              tag.className = "missing-tag";
              tag.textContent = "NEEDS INPUT";
              lbl.appendChild(tag);
            }
          } else if (tag) {
            tag.remove();
          }
        }
      }
      if (empty) missing += 1;
    });
    if (bannerId) {
      const banner = document.getElementById(bannerId);
      if (banner) {
        banner.innerHTML = missing > 0
          ? `<div class="notice warn">⚠ <b>${missing} mandatory field${missing > 1 ? "s" : ""} still need${missing === 1 ? "s" : ""} data input</b> (highlighted in amber below). All fields are mandatory for secretaries.</div>`
          : `<div class="notice" style="background:#ecfdf5;border-color:#10b981;color:#065f46">✓ <b>All mandatory fields have data input</b> — ready to save or approve &amp; issue.</div>`;
      }
    }
    return missing;
  }

  controls.forEach((el) => {
    el.addEventListener("input", refresh);
    el.addEventListener("change", refresh);
  });
  refresh();
  return refresh;
}

/* Drag-and-drop + Copy-and-Paste (Ctrl+V) helper for ID Photo uploads */
function _bindPhotoDropAndPaste({ dropId, inputId, previewId, statusId, onFile }) {
  const dropEl = document.getElementById(dropId);
  const fileInput = document.getElementById(inputId);
  const prev = document.getElementById(previewId);
  const statusEl = document.getElementById(statusId);
  if (!fileInput) return { getFile: () => null };
  let chosenFile = null;

  function acceptFile(file, sourceLabel = "Selected") {
    if (!file || !file.type || !file.type.startsWith("image/")) {
      toast("Please provide a valid JPG or PNG image.", "err");
      return;
    }
    chosenFile = file;
    try {
      const dt = new DataTransfer();
      dt.items.add(file);
      fileInput.files = dt.files;
    } catch (_) { /* fallback uses chosenFile directly */ }
    if (prev) {
      prev.src = URL.createObjectURL(file);
      prev.style.display = "";
    }
    if (statusEl) {
      statusEl.textContent = `${sourceLabel}: ${file.name || "pasted-photo.png"}`;
      statusEl.style.color = "#065f46";
      statusEl.style.fontWeight = "600";
    }
    if (onFile) onFile(file);
  }

  fileInput.addEventListener("change", () => {
    if (fileInput.files && fileInput.files[0]) {
      acceptFile(fileInput.files[0], "Selected file");
    }
  });

  if (dropEl) {
    dropEl.addEventListener("click", (e) => {
      if (e.target !== fileInput && e.target.tagName !== "BUTTON") {
        fileInput.click();
      }
    });
    ["dragenter", "dragover"].forEach((ev) =>
      dropEl.addEventListener(ev, (e) => {
        e.preventDefault();
        e.stopPropagation();
        dropEl.classList.add("dragover");
      }));
    ["dragleave", "drop"].forEach((ev) =>
      dropEl.addEventListener(ev, (e) => {
        e.preventDefault();
        e.stopPropagation();
        dropEl.classList.remove("dragover");
      }));
    dropEl.addEventListener("drop", (e) => {
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) {
        acceptFile(f, "Dropped photo");
        toast("ID photo added via drag & drop.");
      }
    });
  }

  const onPaste = (e) => {
    if (!document.body.contains(fileInput)) {
      document.removeEventListener("paste", onPaste);
      return;
    }
    const items = (e.clipboardData && e.clipboardData.items) || [];
    for (const item of items) {
      if (item.type && item.type.startsWith("image/")) {
        const blob = item.getAsFile();
        if (blob) {
          e.preventDefault();
          const ext = blob.type === "image/jpeg" ? ".jpg" : ".png";
          const named = new File([blob], `pasted_id_photo${ext}`, { type: blob.type });
          acceptFile(named, "Pasted from clipboard");
          toast("ID photo pasted from clipboard!");
          break;
        }
      }
    }
  };
  document.addEventListener("paste", onPaste);

  return {
    getFile: () => chosenFile || (fileInput.files && fileInput.files[0]) || null,
  };
}

const FCA_CACHE_KEY = "rsbsa_fcas_v1";
async function fetchFcaNames() {
  try {
    const r = await api("/api/fcas");
    const names = (r && r.names) || [];
    try { localStorage.setItem(FCA_CACHE_KEY, JSON.stringify(names)); } catch (_) {}
    return names;
  } catch (_) {
    try { return JSON.parse(localStorage.getItem(FCA_CACHE_KEY) || "[]"); }
    catch (__) { return []; }
  }
}

async function api(path, opts = {}) {
  const init = { method: opts.method || "GET", headers: {} };
  if (opts.body !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(opts.body);
  }
  if (opts.form) init.body = opts.form;
  const res = await fetch(path, init);
  let data = null;
  try { data = await res.json(); } catch (_) { /* non-JSON */ }
  if (!res.ok) {
    const msg = (data && data.error) || `Request failed (${res.status})`;
    if (res.status === 401 && !path.endsWith("/me") && path !== "/api/auth/login") {
      ME = null;
      renderNav();
    }
    throw new Error(msg);
  }
  return data;
}


/* ====================== offline mode & sync ========================== */
/* Actions taken while offline are kept in this device's outbox and sent
 * automatically when the connection returns. Nothing is marked done on
 * the server until the sync succeeds. */
const OUTBOX_KEY = "rsbsa_outbox_v1";
let _syncing = false;
let _installPrompt = null;

function outboxList() {
  try { return JSON.parse(localStorage.getItem(OUTBOX_KEY)) || []; }
  catch (_) { return []; }
}
function outboxSave(list) {
  try { localStorage.setItem(OUTBOX_KEY, JSON.stringify(list)); } catch (_) {}
  renderNetStatus();
}
function outboxAdd(item) {
  const list = outboxList();
  if (list.some((x) => x.method === item.method && x.path === item.path && !x.failed)) {
    return false; // already waiting
  }
  list.push(Object.assign({
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    ts: Date.now(),
    actor: ME ? ME.username : "guest",
    failed: false,
    error: "",
  }, item));
  outboxSave(list);
  return true;
}

async function apiQ(path, opts = {}, label = "Offline action") {
  try {
    return await api(path, opts);
  } catch (err) {
    const offline = !navigator.onLine || err instanceof TypeError
      || /failed to fetch|network|offline/i.test((err && err.message) || "");
    if (!offline) throw err;
    const added = outboxAdd({ label, path, method: opts.method || "GET", body: opts.body || null });
    const e = new Error(added
      ? "You are offline. Saved on this device \u2014 it will sync automatically when the connection returns. (Naka-save sa device na ito \u2014 magsi-sync pagbalik ng koneksyon.)"
      : "That action is already saved on this device, waiting to sync.");
    e.queued = true;
    throw e;
  }
}

function renderNetStatus() {
  const pill = document.getElementById("net-pill");
  if (!pill) return;
  const pending = outboxList().length;
  const on = navigator.onLine;
  pill.className = "net-pill" + (on ? "" : " off") + (pending ? " hasq" : "");
  pill.textContent = (on ? "\u{1F7E2} Online" : "\u{1F7E0} Offline")
    + (pending ? ` \u2022 ${pending} to sync` : "");
}

async function syncOutbox(manual = false) {
  const list = outboxList();
  if (_syncing) return;
  if (!list.length) { if (manual) toast("Nothing waiting to sync."); return; }
  if (!navigator.onLine) { if (manual) toast("Still offline \u2014 sync will run when the connection returns.", "err"); return; }
  if (!ME) { if (manual) toast("Sign in first, then sync.", "err"); return; }
  const mine = list.filter((x) => !x.actor || x.actor === "guest" || x.actor === ME.username);
  if (!mine.length) {
    if (manual) toast("The waiting items were saved under a different account \u2014 sign in with that account to sync them.", "err");
    return;
  }
  _syncing = true;
  renderNetStatus();
  let synced = 0, failed = 0, stop = false;
  for (const item of mine) {
    if (stop) break;
    if (item.failed && !manual) continue; // retries of failures are manual
    let cur = outboxList();
    try {
      const init = { method: item.method, headers: {} };
      if (item.body !== null && item.body !== undefined) {
        init.headers["Content-Type"] = "application/json";
        init.body = JSON.stringify(item.body);
      }
      const res = await fetch(item.path, init);
      let data = null;
      try { data = await res.json(); } catch (_) {}
      if (res.status === 503 && data && data.offline) { stop = true; break; }
      if (res.status === 401) {
        toast("Session expired \u2014 sign in again to finish syncing.", "err");
        stop = true; break;
      }
      if (!res.ok) throw new Error((data && data.error) || `Server answered ${res.status}`);
      cur = cur.filter((x) => x.id !== item.id);
      outboxSave(cur);
      synced++;
    } catch (err) {
      cur = cur.map((x) => x.id === item.id
        ? Object.assign({}, x, { failed: true, error: err.message || "Sync failed" }) : x);
      outboxSave(cur);
      failed++;
    }
  }
  _syncing = false;
  renderNetStatus();
  if (synced) toast(`${synced} offline action${synced > 1 ? "s" : ""} synced to the server.`);
  if (failed) toast(`${failed} offline action${failed > 1 ? "s" : ""} could not be applied \u2014 open the connection pill to review.`, "err");
  if (synced && ME) route();
}

function offlineModal() {
  const list = outboxList();
  const rows = list.length ? list.map((x) => `
    <div class="outbox-row">
      <div>
        <b>${esc(x.label)}</b>
        <div class="hint">${new Date(x.ts).toLocaleString("en-PH")} \u2014 saved by ${esc(x.actor || "guest")}
          ${x.failed ? `<br><span style="color:#b3261e">Not applied: ${esc(x.error)}</span>` : ""}</div>
      </div>
      <button class="btn btn-sm btn-danger" data-discard="${x.id}">Discard</button>
    </div>`).join("")
    : `<div class="empty">Nothing is waiting to sync. Actions you take while offline will appear here.</div>`;
  showModal(`
    <h3>\u{1F4F6} Offline Mode &amp; Sync</h3>
    <p>This app can be <b>installed</b> like a regular app and keeps working
       without internet: pages you already opened stay readable, and these
       actions are <b>saved on this device</b> and sent automatically when
       the connection returns:</p>
    <ul class="clean-list">
      <li>Farmer certification submissions</li>
      <li>Farmer Data Entry (new farmer encoding)</li>
      <li>Secretary corrections, approvals &amp; rejections</li>
    </ul>
    <p class="hint">Approvals take effect on the server only after syncing \u2014
       certificate numbers and PDFs are generated at that moment. Items the
       server rejects (for example, a request somebody else already
       approved) stay below as <b>\u201Cneeds attention\u201D</b> until you discard them.
       Queued items stay on this device, so avoid queueing on shared computers.</p>
    <h4 style="margin:14px 0 6px">Waiting on this device (${list.length})</h4>
    ${rows}
    <div class="modal-actions">
      ${_installPrompt ? '<button class="btn" id="ob-install">\u2B07 Install App</button>' : ""}
      <button class="btn" id="ob-close">Close</button>
      <button class="btn btn-primary" id="ob-sync">\u{1F504} Sync Now</button>
    </div>`, 640);
  bind("ob-close", "click", closeModal);
  bind("ob-sync", "click", async () => { await syncOutbox(true); offlineModal(); });
  const inst = document.getElementById("ob-install");
  if (inst) inst.addEventListener("click", async () => {
    if (_installPrompt) { _installPrompt.prompt(); _installPrompt = null; }
    closeModal();
  });
  document.querySelectorAll("[data-discard]").forEach((b) =>
    b.addEventListener("click", () => {
      outboxSave(outboxList().filter((x) => x.id !== b.dataset.discard));
      offlineModal();
    }));
}

window.addEventListener("online", () => { renderNetStatus(); syncOutbox(false); });
window.addEventListener("offline", renderNetStatus);
window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); _installPrompt = e; });
setInterval(() => { if (navigator.onLine && ME) syncOutbox(false); }, 60000);

function toast(msg, kind = "ok") {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $toastWrap.appendChild(el);
  setTimeout(() => el.remove(), 4200);
}

function fmtDT(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("en-PH", {
      month: "short", day: "numeric", year: "numeric",
      hour: "numeric", minute: "2-digit",
    });
  } catch (_) { return iso; }
}
function fmtD(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString("en-PH", {
      month: "short", day: "numeric", year: "numeric",
    });
  } catch (_) { return iso; }
}

function statusBadge(s) {
  const label = { pending: "Pending", approved: "Issued", rejected: "Rejected" }[s] || s;
  return `<span class="badge ${esc(s)}">${label}</span>`;
}

function showModal(html, width = 560) {
  $modalRoot.innerHTML = `
    <div class="modal-back" id="modal-back">
      <div class="modal" style="max-width:${width}px" role="dialog">${html}</div>
    </div>`;
  const back = document.getElementById("modal-back");
  back.addEventListener("mousedown", (e) => { if (e.target === back) closeModal(); });
}
function closeModal() {
  if (typeof stopQrScan === "function") stopQrScan();
  $modalRoot.innerHTML = "";
}

function bind(id, ev, fn) {
  const el = document.getElementById(id);
  if (el) el.addEventListener(ev, fn);
  return el;
}

const ACTION_LABELS = {
  login: "Signed in",
  "login.failed": "Failed sign-in",
  logout: "Signed out",
  "request.submit": "Request submitted (farmer)",
  "request.correct": "Inputs rectified by secretary",
  "request.reject": "Request rejected",
  "certificate.issue": "Certificate issued",
  "certificate.download": "Certificate downloaded",
  "certificate.docx_remove": "Certificate DOCX removed (PDF-only)",
  "certificate.pdf_purge": "Certificate PDF auto-deleted (30 days)",
  "certificate.pdf_regenerate": "Certificate PDF regenerated",
  "template.upload": "Template uploaded",
  "template.fields": "Template fields updated",
  "template.toggle": "Template activated/deactivated",
  "user.create": "Account created",
  "user.toggle": "Account activated/deactivated",
  "user.password_reset": "Password reset",
  "user.reassign": "Account reassigned",
  "barangay.create": "Barangay added",
  "barangay.delete": "Barangay removed",
  "settings.update": "Settings updated",
  "setup.complete": "Initial setup completed",
  "archive.export": "Archive exported",
  "report.generate": "Report generated",
  "farmer.lookup": "Farmer record lookup",
  "farmer.create": "Farmer encoded (data entry)",
  "farmer.verify": "Farmer verified by admin",
  "farmer.update": "Farmer record edited",
  "farmer.delete": "Bogus NEW farmer deleted",
  "farmer_id.issue": "Issued Farmer's ID",
  "id_db.csv_import": "ID database updated by CSV upload",
  "id_db.copy_masterlist": "Farmers copied into ID database",
  "id_db.update": "ID database record updated",
  "id_db.photo_upload": "ID Generator photo uploaded",
  "id_card.issue": "Issued Farmer's ID (ID Generator)",
  "id_card.reprint": "Reprinted Farmer's ID (ID Generator)",
  "farmer_id.reprint": "Reprinted Farmer's ID",
  "farmer.photo_upload": "Uploaded farmer ID photo",
  "certificate.data_export": "Issued certificate data exported (CSV)",
  "system.backup": "Full backup downloaded",
  "system.restore": "Backup restored",
};

/* ============================== navigation ============================ */
function renderNav() {
  const h = (location.hash || "#/").slice(1);
  const link = (href, label) =>
    `<a href="#${href}" class="${h === href ? "active" : ""}">${label}</a>`;

  if (ME) {
    let links = link("/dashboard", "Dashboard") + link("/archive", "Archive") +
                link("/farmers", "Farmers") + link("/reports", "Reports") +
                link("/audit", "Audit Trail");
    if (ME.role === "admin") links += link("/id-generator", "ID Generator")
      + link("/admin", "Administration");
    $navLinks.innerHTML = links;
    $navUser.innerHTML = `
      <div class="who">
        <div class="name">${esc(ME.full_name)}</div>
        <div class="role">${ME.role === "admin" ? "Administrator" : "Secretary"}
          ${ME.barangay ? "· " + esc(ME.barangay) : ""}</div>
      </div>
      <button class="btn-logout" id="btn-logout">Sign out</button>`;
    bind("btn-logout", "click", async () => {
      const pending = outboxList().length;
      if (pending && !confirm(`${pending} offline action(s) are still waiting to sync on this device. They stay saved here; sign out anyway?`)) return;
      try { await api("/api/auth/logout", { method: "POST", body: {} }); } catch (_) {}
      if (window.caches) {
        try { const ks = await caches.keys(); await Promise.all(ks.map((k) => caches.delete(k))); } catch (_) {}
      }
      ME = null;
      saveMeSnapshot();
      renderNav();
      location.hash = "#/";
      toast("Signed out.");
    });
  } else {
    $navLinks.innerHTML = link("/", "Home") + link("/track", "Track Request");
    $navUser.innerHTML = `<button class="btn-logout" onclick="location.hash='#/login'">Secretary Login</button>`;
  }
}

/* ================================ router ============================== */
window.addEventListener("hashchange", route);

async function route() {
  const h = (location.hash || "#/").slice(1) || "/";

  if (NEEDS_SETUP && h !== "/setup") { location.hash = "#/setup"; return; }
  if (h === "/setup") return viewSetup();
  if (h === "/") return viewHome();
  if (h === "/login") return viewLogin();
  if (h === "/submit") return viewSubmit();
  if (h === "/track") return viewTrack();

  if (!ME) {
    toast("Please sign in to continue.", "err");
    location.hash = "#/login";
    return;
  }
  if (h === "/dashboard") return viewDashboard();
  if (h === "/archive") return viewArchive();
  if (h === "/farmers") return viewFarmers();
  if (h === "/reports") return viewReports();
  if (h === "/audit") return viewAudit();
  if (h === "/admin") {
    if (ME.role !== "admin") { location.hash = "#/dashboard"; return; }
    return viewAdmin();
  }
  if (h === "/id-generator") {
    if (ME.role !== "admin") { location.hash = "#/dashboard"; return; }
    return viewIdGenerator();
  }
  const m = h.match(/^\/review\/(\d+)$/);
  if (m) return viewReview(Number(m[1]));
  location.hash = "#/";
}

/* ================================= views ============================== */

function viewHome() {
  $app.innerHTML = `
    <div class="hero">
      <span class="tag">Registry System for Basic Sectors in Agriculture</span>
      <h1>RSBSA Certification Manager</h1>
      <p>Create, file, and audit RSBSA certifications in one system.
         Farmers submit requests from home; barangay secretaries review,
         admit, and issue certificates — every step recorded.</p>
    </div>

    <div class="grid-3">
      <a class="action-card" href="#/submit">
        <span class="icon">📝</span>
        <h3>Request a Certification (Humiling ng Sertipikasyon)</h3>
        <p>For farmers and fisherfolk — no account needed. Choose your
           barangay, fill in your details, and receive a reference number.
           (Para sa mga magsasaka at mangingisda — hindi kailangan ng account.
           Piliin ang iyong barangay, sagutan ang mga detalye, at tumanggap
           ng reference number.)</p>
      </a>
      <a class="action-card" href="#/track">
        <span class="icon">🔍</span>
        <h3>Track Your Request (Subaybayan ang Iyong Kahilingan)</h3>
        <p>Check whether your certification has been reviewed, issued,
           or needs correction using your reference number. (Tingnan kung
           ang iyong sertipikasyon ay nasuri na, naisyu na, o kailangang
           itama gamit ang iyong reference number.)</p>
      </a>
      <a class="action-card" href="${ME ? "#/dashboard" : "#/login"}">
        <span class="icon">🏛️</span>
        <h3>${ME ? "Go to Dashboard" : "Secretary / Admin Login"}</h3>
        <p>${ME
          ? `Signed in as ${esc(ME.full_name)}. Open your barangay request queue.`
          : "Barangay secretaries and administrators sign in to review requests, issue certificates, and browse the archive."}</p>
      </a>
    </div>

    <div class="how">
      <h3 style="margin:26px 0 12px">How it works (Paano Ito Gumagana)</h3>
      <div class="how-steps">
        <div class="how-step">
          <div class="n">1</div>
          <b>Farmer submits (guest) (Nagsusumite ang magsasaka (bilang bisita))</b>
          <span>Picks their barangay and fills the template-driven form.
                Details are queued only to that barangay's secretary.
                (Pipiliin ang barangay at sasagutan ang form. Ang mga detalye
                ay ipapadala lamang sa sekretarya ng barangay na iyon.)</span>
        </div>
        <div class="how-step">
          <div class="n">2</div>
          <b>Secretary reviews &amp; admits</b>
          <span>The secretary of that barangay checks the information and
                approves it — or rejects it with a reason.</span>
        </div>
        <div class="how-step">
          <div class="n">3</div>
          <b>Certificate filed &amp; logged</b>
          <span>The certificate is generated as a PDF (the Word rendering
                is temporary and is not saved), numbered, stored in the
                archive, and written to the audit trail. PDF files are kept
                for 30 days; the records themselves are retained
                permanently and a purged PDF can be regenerated.</span>
        </div>
      </div>
    </div>

    <p class="footer-note">
      Certificates are generated from your official
      <code class="ph">{{PLACEHOLDER}}</code> Word templates — upload them under
      Administration → Templates.
    </p>`;
}

/* ------------------------------ setup ------------------------------- */
function viewSetup() {
  $app.innerHTML = `
    <div class="center-narrow wide">
      <div class="card">
        <h3>Initial setup — create the administrator account</h3>
        <p class="page-sub">This runs only once. You will be signed in automatically.</p>
        <form id="setup-form" class="no-caps">
          <div class="form-grid">
            <div class="field full">
              <label>Office / Institution name</label>
              <input name="municipality" value="Alcala" placeholder="e.g. Alcala">
            </div>
            <div class="field full">
              <label>Province</label>
              <input name="province" value="Cagayan" placeholder="e.g. Cagayan">
            </div>
            <div class="field">
              <label>Admin full name <span class="req">*</span></label>
              <input name="full_name" class="no-caps" required placeholder="Juan Dela Cruz">
            </div>
            <div class="field">
              <label>Username <span class="req">*</span></label>
              <input name="username" class="no-caps" required autocomplete="username"
                     placeholder="admin">
            </div>
            <div class="field">
              <label>Password <span class="req">*</span></label>
              <input name="password" type="password" required minlength="6"
                     autocomplete="new-password" placeholder="At least 6 characters">
            </div>
            <div class="field full">
              <label>Barangays (one per line — you can add more later)</label>
              <textarea name="barangays" rows="5"
                placeholder="Abbeg&#10;Afusing Bato&#10;Agani&#10;Baybayog"></textarea>
            </div>
          </div>
          <button class="btn btn-primary btn-block" type="submit">Create account &amp; start</button>
        </form>
      </div>
    </div>`;
  bind("setup-form", "submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await api("/api/setup", { method: "POST", body: {
        municipality: fd.get("municipality"),
        province: fd.get("province"),
        full_name: fd.get("full_name"),
        username: fd.get("username"),
        password: fd.get("password"),
        barangays: (fd.get("barangays") || "").split("\n"),
      }});
      const b = await api("/api/auth/me");
      ME = b.me; NEEDS_SETUP = false;
      renderNav();
      location.hash = "#/dashboard";
      toast("Setup complete — welcome!");
    } catch (err) { toast(err.message, "err"); }
  });
}

/* ------------------------------ login ------------------------------- */
function viewLogin() {
  if (ME) { location.hash = "#/dashboard"; return; }
  $app.innerHTML = `
    <div class="center-narrow">
      <div class="card">
        <h3>Secretary / Administrator sign in</h3>
        <form id="login-form" class="no-caps">
          <div class="field">
            <label>Username</label>
            <input name="username" class="no-caps" required autofocus autocomplete="username">
          </div>
          <div class="field">
            <label>Password</label>
            <input name="password" class="no-caps" type="password" required autocomplete="current-password">
          </div>
          <button class="btn btn-primary btn-block" type="submit">Sign in</button>
        </form>
        <p class="footer-note" style="margin-top:16px">
          Are you a farmer? <a href="#/submit">Submit a request</a> — no login needed.
        </p>
      </div>
    </div>`;
  bind("login-form", "submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      const r = await api("/api/auth/login", { method: "POST", body: {
        username: fd.get("username"), password: fd.get("password"),
      }});
      ME = r.me;
      saveMeSnapshot();
      renderNav();
      syncOutbox(false);
      location.hash = "#/dashboard";
      toast(`Welcome, ${ME.full_name}!`);
    } catch (err) { toast(err.message, "err"); }
  });
}

/* --------------------------- submit wizard --------------------------- */
const W = { step: 1, barangay: null, barangayName: "", template: null,
            templateName: "", count: 1, entries: [], curIdx: 0, manual: {},
            fields: [], fieldsCache: {}, fieldsFor: null,
            barangays: [], templates: [], refNo: "",
            prefillNum: "" };
const MAX_CERTS = 10;

function stepsBar() {
  const labels = ["Barangay", "Number of certifications (Bilang ng Sertipikasyon)",
                  "Your details (Iyong mga Detalye)", "Done (Tapos na)"];
  return `<div class="steps">${labels.map((l, i) => {
    const n = i + 1;
    const cls = W.step === n ? "active" : (W.step > n ? "done" : "");
    return `<div class="step ${cls}"><span class="sn">${W.step > n ? "✓" : n}</span>${l}</div>`;
  }).join("")}</div>`;
}

function collectCurrentEntry() {
  const form = document.getElementById("details-form");
  if (!form) return;
  const fd = new FormData(form);
  const entry = {};
  W.fields.forEach((f) => {
    let v = (fd.get(f.key) || "").toString().trim();
    if (v && (f.type === "text" || f.type === "textarea" || _isRsbsaFieldKey(f.key))) {
      v = v.toUpperCase();                  // standardize to caps (including alphanumeric RSBSA)
    }
    if (v) entry[f.key] = v;
  });
  const wrap = W.entries[W.curIdx] ||
    (W.entries[W.curIdx] = { tpl: null, data: {} });
  wrap.data = entry;
  const tsel = document.getElementById("entry-type");
  if (tsel) wrap.tpl = Number(tsel.value);
}

function curEntryWrap() {
  return W.entries[W.curIdx] ||
    (W.entries[W.curIdx] = { tpl: null, data: {} });
}

async function fieldsForTemplate(tid) {
  if (!tid) return [];
  if (!W.fieldsCache[tid]) {
    const r = await api(`/api/public/templates/${tid}/fields`);
    W.fieldsCache[tid] = ensureParcelFields(r.fields);
  }
  return W.fieldsCache[tid];
}

/* ----- multi-parcel entries: one farmer, several parcels ------------------
   Entries 2, 3, 4... are additional parcels of the SAME farmer. The farmer
   profile (name, civil status, address, RSBSA number) is auto-copied from
   Entry 1 and stays in sync unless the farmer edits that field in a later
   entry. Parcel Location and Farm Area are never copied. */
const PARCEL_FIELD_KEYS = ["PARCEL_LOCATION", "FARM_AREA"];

function _isRsbsaFieldKey(key) {
  const k = (key || "").toUpperCase();
  return k.includes("RSBSA") && (k.includes("NUM") || k.endsWith("NO"));
}

function _isFarmerNameField(f) {
  const k = (f.key || "").toUpperCase();
  return ["FARMER_NAME", "FULL_NAME", "NAME"].includes(k) || k.includes("NAME");
}

function _isProfileField(f) {
  const k = f.key.toUpperCase();
  if (PARCEL_FIELD_KEYS.includes(k)) return false;
  return _isRsbsaFieldKey(k) ||
    ["FARMER_NAME", "FULL_NAME", "NAME", "CIVIL_STATUS", "ADDRESS"].includes(k) ||
    k.includes("NAME") || k.includes("CIVIL");
}

/* Filipino translations shown beside English on farmer-facing screens,
   in the form:  English (Filipino). Known template fields are translated
   automatically through this dictionary (by field key, then by label). */
const FIL_BY_KEY = {
  FARMER_NAME: "Pangalan ng Magsasaka",
  FULL_NAME: "Buong Pangalan",
  NAME: "Pangalan",
  CIVIL_STATUS: "Katayuang Sibil",
  ADDRESS: "Tirahan",
  RSBSA_NUMBER: "Numero ng RSBSA",
  RSBSA_NO: "Numero ng RSBSA",
  PARCEL_LOCATION: "Lokasyon ng Parsela",
  FARM_AREA: "Lawak ng Lupa (Ektarya)",
  PURPOSE: "Layunin",
  CROP_COMMODITY: "Pananim",
  CONTACT_NUMBER: "Numero ng Telepono",
  MOBILE_NUMBER: "Numero ng Cellphone",
  DATE_OF_BIRTH: "Petsa ng Kapanganakan",
  BIRTHDAY: "Petsa ng Kapanganakan",
  GENDER: "Kasarian",
  SEX: "Kasarian",
};
const FIL_BY_LABEL = {
  "farmer name": "Pangalan ng Magsasaka",
  "full name": "Buong Pangalan",
  "civil status": "Katayuang Sibil",
  "address": "Tirahan",
  "rsbsa number": "Numero ng RSBSA",
  "rsbsa no": "Numero ng RSBSA",
  "parcel location": "Lokasyon ng Parsela",
  "farm area": "Lawak ng Lupa (Ektarya)",
  "farm area (ha)": "Lawak ng Lupa (Ektarya)",
  "purpose": "Layunin",
  "crop commodity": "Pananim",
  "contact number": "Numero ng Telepono",
  "date of birth": "Petsa ng Kapanganakan",
  "gender": "Kasarian",
};

function biLabel(f) {
  const fil = FIL_BY_KEY[(f.key || "").toUpperCase()] ||
    FIL_BY_LABEL[(f.label || "").trim().toLowerCase()];
  return fil ? `${f.label} (${fil})` : f.label;
}

function ensureParcelFields(fields) {
  const out = fields.map((f) => {
    if (f.key === "FARM_AREA") {
      return {
        ...f,
        label: "Farm Area (Ha)",
        type: "number",
        help: "Numerical value only in hectares (e.g. 0.2526). One entry per parcel. (Numerikal na halaga lamang sa ektarya, hal. 0.2526.)",
      };
    }
    if (_isRsbsaFieldKey(f.key)) {
      return { ...f, type: "text" };
    }
    return f;
  });
  const has = (k) => out.some((f) => f.key === k);
  if (!has("FARM_AREA")) {
    out.push({ key: "FARM_AREA", label: "Farm Area (Ha)", type: "number",
               required: true, system: false,
               help: "Numerical value only in hectares (e.g. 0.2526). One entry per parcel. (Numerikal na halaga lamang sa ektarya, hal. 0.2526.)" });
  }
  if (!has("PARCEL_LOCATION")) {
    const idx = out.findIndex((f) => f.key === "FARM_AREA");
    out.splice(idx >= 0 ? idx + 1 : out.length, 0,
      { key: "PARCEL_LOCATION", label: "Parcel Location", type: "text",
        required: true, system: false,
        help: "Automatically pre-filled with the barangay (editable). (Awtomatikong napunan ng barangay.)" });
  }
  return out;
}

function _defaultParcelLocation() {
  return ((W.barangayName || (ME && ME.barangay) || "")).trim().toUpperCase();
}

function propagateProfile() {
  const src = (W.entries[0] || {}).data || {};
  const defLoc = _defaultParcelLocation();
  if (defLoc) {
    const wrap0 = W.entries[0] || (W.entries[0] = { tpl: null, data: {} });
    const dst0 = wrap0.data || (wrap0.data = {});
    if (!dst0.PARCEL_LOCATION && !W.manual["0:PARCEL_LOCATION"]) {
      dst0.PARCEL_LOCATION = defLoc;
    }
  }
  const keys = Object.keys(src).filter((k) => _isProfileField({ key: k }));
  for (let i = 1; i < W.count; i++) {
    const wrap = W.entries[i] || (W.entries[i] = { tpl: null, data: {} });
    const dst = wrap.data || (wrap.data = {});
    keys.forEach((k) => {
      if (W.manual[`${i}:${k}`]) return;   // farmer overrode it: keep theirs
      if (src[k]) dst[k] = src[k];
      else delete dst[k];
    });
    if (defLoc && !dst.PARCEL_LOCATION && !W.manual[`${i}:PARCEL_LOCATION`]) {
      dst.PARCEL_LOCATION = defLoc;
    }
  }
}

/* ----- Farmer Data Entry: encode a farmer directly into the database ---
   Opened automatically when an RSBSA lookup finds no match, and from the
   Farmer Masterlist page. This replaces seeding the masterlist by CSV. */
function farmerEntryModal({ rsbsa = "", barangayId = null, barangayName = "",
                            barangays = null, onSaved = null, notYet = false } = {}) {
  const secretaryStrict = !!(ME && ME.role === "secretary");
  const star = secretaryStrict ? " *" : "";
  const ruleText = secretaryStrict
    ? "Secretary account: all fields must be filled. (Account ng sekretarya: dapat punan ang lahat ng fields.)"
    : (ME
      ? "Farmer Name and RSBSA Number are required."
      : "Farmer/guest: only Barangay and Farmer's Name are required — RSBSA Number, Civil Status, and Address are optional. (Magsasaka/bisita: Barangay at Pangalan ng Magsasaka lamang ang kinakailangan — opsyonal ang Numero ng RSBSA, Katayuang Sibil, at Tirahan.)");
  const bgyField = (barangays && barangays.length)
    ? `<div class="field"><label>Barangay *</label>
         <select id="fe-barangay">${barangays.map((b) =>
           `<option value="${b.id}" ${Number(barangayId) === Number(b.id) ? "selected" : ""}>${esc(b.name)}</option>`).join("")}
         </select></div>`
    : `<div class="field"><label>Barangay *</label>
         <input type="text" value="${esc(barangayName || (ME ? (ME.barangay || "All barangays") : ""))}" disabled></div>`;
  showModal(`
    <h3>Farmer Data Entry (Pag-encode ng Datos ng Magsasaka)</h3>
    <p>${notYet ? "NOT YET RSBSA REGISTERED — no farmer record was found in the database." : "No farmer record was found for this RSBSA number."} Encode the farmer
       directly into the database below — <b>no CSV upload is needed</b>.
       The saved profile will be used to pre-fill this and future requests.
       (Walang nakitang rekord ng magsasaka para sa RSBSA number na ito.
       I-encode ang magsasaka nang direkta sa database sa ibaba —
       <b>hindi na kailangan mag-upload ng CSV</b>. Ang na-save na profile
       ay gagamitin sa kahilingang ito at sa mga susunod.)</p>
    <p class="small muted">${esc(ruleText)}</p>
    <div class="form-grid">
      <div class="field"><label>RSBSA Number (Numero ng RSBSA)${star}</label>
        <input type="text" id="fe-rsbsa" class="caps" placeholder="e.g. 02-015-02-014-EFMN47" value="${esc(rsbsa)}"></div>
      ${bgyField}
      <div class="field"><label>Farmer Name (Pangalan ng Magsasaka) *</label>
        <input type="text" id="fe-name" class="caps" placeholder="e.g. JUAN DELA CRUZ"></div>
      <div class="field"><label>Civil Status (Katayuang Sibil)${star}</label>
        <select id="fe-civil" class="caps">${_choiceOptionsFor("civil", "")}</select></div>
      <div class="field full"><label>Address (Tirahan)${star}</label>
        <input type="text" id="fe-address" class="caps" placeholder="Purok / Sitio, Barangay"></div>
    </div>
    <div class="modal-actions">
      <button class="btn" id="fe-cancel">Cancel (Kanselahin)</button>
      <button class="btn btn-primary" id="fe-save">Save to Farmer Database (I-save sa Database ng mga Magsasaka)</button>
    </div>`, 640);
  if (secretaryStrict) {
    _applyMissingFieldHighlights(document.querySelector(".modal"));
  }
  bind("fe-cancel", "click", closeModal);
  bind("fe-save", "click", async () => {
    const num = (document.getElementById("fe-rsbsa").value || "").trim().toUpperCase();
    const fullname = (document.getElementById("fe-name").value || "").trim().toUpperCase();
    const civil = (document.getElementById("fe-civil").value || "").trim().toUpperCase();
    const address = (document.getElementById("fe-address").value || "").trim().toUpperCase();
    if (!fullname) { toast("Farmer name is required.", "err"); return; }
    if (secretaryStrict && (!num || !civil || !address)) {
      toast("Secretary entries must be complete — fill in RSBSA Number, Civil Status, and Address.", "err");
      return;
    }
    if (!secretaryStrict && ME && !num) { toast("RSBSA number is required.", "err"); return; }
    const bgySel = document.getElementById("fe-barangay");
    const bid = bgySel ? Number(bgySel.value) : barangayId;
    const btn = document.getElementById("fe-save");
    btn.disabled = true;
    btn.textContent = "Saving…";
    try {
      const saved = await apiQ("/api/farmers", { method: "POST", body: {
        barangay_id: bid,
        data: {
          RSBSA_NUMBER: num,
          FARMER_NAME: fullname,
          CIVIL_STATUS: civil,
          ADDRESS: address,
        },
      }}, `Farmer data entry \u2014 ${fullname}`);
      closeModal();
      toast(`Farmer ${saved.name} saved to the database (${saved.barangay}).` +
        (saved.created ? " Tagged NEW — awaiting admin verification." : ""));
      if (onSaved) onSaved(saved);
    } catch (err) {
      toast(err.message, "err");
      btn.disabled = false;
      btn.textContent = "Save to Farmer Database (I-save sa Database ng mga Magsasaka)";
    }
  });
}

/* ----- QR scanning: read the RSBSA Number from an RSBSA QR code ---------- */
let _qrStream = null;
let _qrTimer = null;

function extractRsbsaNumber(raw) {
  let text = String(raw || "").trim();
  if (!text) return "";
  try {
    const obj = JSON.parse(text);
    if (obj && typeof obj === "object") {
      for (const k of Object.keys(obj)) {
        if (/rsbsa/i.test(k) && obj[k]) return String(obj[k]).trim().toUpperCase();
      }
    }
  } catch (_) { /* not JSON */ }
  try {
    const u = new URL(text);
    for (const [k, v] of u.searchParams.entries()) {
      if (/rsbsa|number|reg/i.test(k) && v) return v.trim().toUpperCase();
    }
    text = `${u.pathname} ${text}`;
  } catch (_) { /* not a URL */ }
  let m = text.match(/validate-rsbsa-profile\/([A-Z0-9][A-Z0-9\-_./]{3,})/i);
  if (m) return m[1].trim().toUpperCase();
  m = text.match(/RSBSA[^A-Z0-9]*([A-Z0-9][A-Z0-9\-_./ ]{3,}[A-Z0-9])/i);
  if (m && /\d/.test(m[1])) return m[1].replace(/\s+/g, "").toUpperCase();
  m = text.match(/\b([A-Z0-9]+(?:-[A-Z0-9]+){2,})\b/i);
  if (m && /\d/.test(m[1])) return m[1].toUpperCase();
  m = text.match(/\b\d[\d\- ]{4,}\d\b/);
  if (m) return m[0].replace(/\s+/g, "").toUpperCase();
  m = text.match(/[A-Z0-9][A-Z0-9\-_./]{3,}/i);
  return m ? m[0].toUpperCase() : "";
}

function _applyQrResult(raw) {
  const num = extractRsbsaNumber(raw);
  if (!num) {
    toast("A QR code was read, but no RSBSA number could be found in it.", "err");
    return;
  }
  const inp = document.getElementById("prefill-rsbsa");
  if (inp) inp.value = num;
  toast(`RSBSA Number read from QR: ${num}`);
  const btn = document.getElementById("prefill-go");
  if (btn) btn.click();
}

function stopQrScan() {
  if (_qrTimer) { clearInterval(_qrTimer); _qrTimer = null; }
  if (_qrStream) {
    _qrStream.getTracks().forEach((t) => t.stop());
    _qrStream = null;
  }
}

function startQrScan() {
  if (typeof jsQR === "undefined") {
    toast("The QR scanner is unavailable here. You can upload a QR photo " +
          "or type the RSBSA number instead.", "err");
    return;
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    toast("This browser cannot open a camera. You can upload a QR photo " +
          "or type the RSBSA number instead.", "err");
    return;
  }
  showModal(`
    <h3>Scan RSBSA QR Code (I-scan ang QR Code ng RSBSA)</h3>
    <p>Point the camera at the QR code on the RSBSA ID or document. The
       RSBSA Number will be filled in automatically. (Itapat ang camera sa
       QR code ng RSBSA ID o dokumento. Awtomatikong mapupunan ang Numero
       ng RSBSA.)</p>
    <video id="qr-video" autoplay muted playsinline
           style="width:100%;border-radius:12px"></video>
    <canvas id="qr-canvas" hidden></canvas>
    <div class="notice" id="qr-status">Starting camera…</div>
    <div class="modal-actions">
      <button class="btn" id="qr-cancel">Cancel (Kanselahin)</button>
    </div>`);
  bind("qr-cancel", "click", () => { stopQrScan(); closeModal(); });
  navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } })
    .then((stream) => {
      _qrStream = stream;
      const video = document.getElementById("qr-video");
      if (!video) { stopQrScan(); return; }
      video.srcObject = stream;
      video.play();
      const canvas = document.getElementById("qr-canvas");
      const ctx = canvas.getContext("2d");
      const status = document.getElementById("qr-status");
      if (status) status.textContent = "Camera is on — hold the QR code steady. (Bukas ang camera — itapat nang matatag ang QR code.)";
      _qrTimer = setInterval(() => {
        if (!video.videoWidth) return;
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const code = jsQR(img.data, canvas.width, canvas.height);
        if (code && code.data) {
          stopQrScan();
          closeModal();
          _applyQrResult(code.data);
        }
      }, 300);
    })
    .catch(() => {
      stopQrScan();
      closeModal();
      toast("Camera access was not allowed. You can upload a QR photo " +
            "or type the RSBSA number instead.", "err");
    });
}

function decodeQrImage(file) {
  if (typeof jsQR === "undefined") {
    toast("The QR scanner is unavailable here. Please type the RSBSA number.", "err");
    return;
  }
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0);
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const code = jsQR(data.data, canvas.width, canvas.height);
    URL.revokeObjectURL(url);
    if (code && code.data) _applyQrResult(code.data);
    else toast("No QR code was found in that image. Please try a clearer photo.", "err");
  };
  img.onerror = () => {
    URL.revokeObjectURL(url);
    toast("That image could not be read.", "err");
  };
  img.src = url;
}

async function viewSubmit() {
  if (W.step === 1 && !W.barangays.length) {
    $app.innerHTML = `<div class="loading">Loading…</div>`;
    try { W.barangays = await api("/api/barangays"); rememberBarangays(W.barangays); }
    catch (err) { toast(err.message, "err"); return; }
  }
  if (!W.barangay && ME && ME.role === "secretary" && ME.barangay_id) {
    W.barangay = Number(ME.barangay_id);
    W.barangayName = ME.barangay || "";
  }
  if (W.step === 3 && !W.templates.length) {
    $app.innerHTML = `<div class="loading">Loading…</div>`;
    try { W.templates = await api("/api/public/templates"); }
    catch (err) { toast(err.message, "err"); return; }
  }
  if (W.step === 3 && W.templates.length) {
    const wrap = curEntryWrap();
    if (!wrap.tpl) {
      wrap.tpl = (W.entries[W.curIdx - 1] || {}).tpl ||
                 (W.entries[0] || {}).tpl || W.templates[0].id;
    }
    if (W.fieldsFor !== wrap.tpl) {
      $app.innerHTML = `<div class="loading">Loading…</div>`;
      try {
        W.fields = await fieldsForTemplate(wrap.tpl);
        W.fieldsFor = wrap.tpl;
        const t = W.templates.find((x) => x.id === wrap.tpl);
        if (t) W.templateName = t.name;
      } catch (err) { toast(err.message, "err"); return; }
    }
  }

  const staffStrictSubmit = !!(ME && (ME.role === "secretary" || ME.role === "admin"));
  let body = "";
  if (W.step === 1) {
    body = `
      <div class="card">
        <h3>Step 1 — Which barangay do you belong to? (Hakbang 1 — Saang barangay ka kabilang?)</h3>
        <p class="page-sub">Your request will be sent only to the secretary of
           the barangay you select. (Ang iyong kahilingan ay ipapadala lamang
           sa sekretarya ng barangay na iyong pipiliin.)</p>
        ${W.barangays.length ? `<div class="pick-list">${W.barangays.map((b) => `
          <div class="pick ${W.barangay === b.id ? "selected" : ""}" data-id="${b.id}" data-name="${esc(b.name)}">
            <span class="dot"></span><span>${esc(b.name)}</span>
          </div>`).join("")}</div>`
        : `<div class="notice warn">No barangays have been configured yet.
             Please ask your administrator to set up the system. (Wala pang
             naka-configure na barangay. Pakihiling sa administrator na
             i-set up ang sistema.)</div>`}
        <div class="btn-row end">
          <button class="btn btn-primary" id="go2" ${W.barangay ? "" : "disabled"}>Continue (Magpatuloy) →</button>
        </div>
      </div>`;
  } else if (W.step === 2) {
    body = `
      <div class="card">
        <h3>Step 2 — How many parcels do you need certificates for? (Hakbang 2 — Ilang parsela ang kailangan mo ng sertipiko?)</h3>
        <p class="page-sub">One certificate is issued <b>per parcel</b> of the
           same farmer (up to ${MAX_CERTS} parcels in one request). In the
           next step, your farmer profile — name, civil status, address and
           RSBSA Number — is <b>automatically copied</b> to entries 2, 3,
           4…; you only enter the <b>Parcel Location</b> and <b>Farm Area</b>
           (and purpose, if different) for each succeeding parcel. All
           certificates are issued under one reference number. (Isang
           sertipiko bawat parsela ng iisang magsasaka. Awtomatikong
           makokopya ang iyong profile sa Entry 2, 3, 4…; ilalagay mo lamang
           ang Lokasyon ng Parsela at Lawak ng Lupa (at layunin, kung iba).
           Lahat ng sertipiko ay nasa iisang reference number.)</p>
        <div class="count-wrap">
          <button class="count-step" type="button" id="cnt-minus" aria-label="fewer">−</button>
          <input type="number" id="cert-count" min="1" max="${MAX_CERTS}"
                 value="${W.count}">
          <button class="count-step" type="button" id="cnt-plus" aria-label="more">+</button>
        </div>
        <div class="count-chips">
          ${[1, 2, 3, 4, 5].map((n) => `<button type="button" class="count-chip"
            data-n="${n}">${n}</button>`).join("")}
        </div>
        <div class="btn-row">
          <button class="btn" id="back2">← Back (Bumalik)</button>
          <button class="btn btn-primary" id="go3">Continue (Magpatuloy) →</button>
        </div>
      </div>`;
  } else if (W.step === 3) {
    const entryNav = W.count > 1 ? `
      <div class="entry-chips">${W.entries.map((e, i) => `
        <button type="button"
          class="entry-chip ${i === W.curIdx ? "active" : ""} ${Object.keys(e.data || {}).length ? "filled" : ""}"
          data-i="${i}">Entry ${i + 1} (Parsela ${i + 1})</button>`).join("")}</div>` : "";
    const rows = W.fields.map((f) => {
      const req = (staffStrictSubmit || _isFarmerNameField(f)) ? `<span class="req">*</span>` : "";
      let help = f.help ? `<div class="help">${esc(f.help)}</div>` : "";
      if (W.curIdx > 0 && _isProfileField(f) &&
          !W.manual[`${W.curIdx}:${f.key}`]) {
        help += `<div class="help">Auto-filled from Entry 1 — edit only if this parcel's certificate must differ. (Awtomatikong napunan mula sa Entry 1 — baguhin lamang kung kailangang maiba ang sertipiko ng parselang ito.)</div>`;
      }
      const curData = (W.entries[W.curIdx] || {}).data || {};
      if (f.key === "PARCEL_LOCATION" && !curData.PARCEL_LOCATION &&
          !W.manual[`${W.curIdx}:PARCEL_LOCATION`] && _defaultParcelLocation()) {
        curData.PARCEL_LOCATION = _defaultParcelLocation();
      }
      const valRaw = curData[f.key] || "";
      const val = esc(valRaw);
      const isRsbsa = _isRsbsaFieldKey(f.key);
      const isFarmArea = f.key.toUpperCase() === "FARM_AREA";
      const caps = (f.type === "text" || f.type === "textarea" || isRsbsa) ? "caps" : "";
      const v = `class="${caps}" name="${esc(f.key)}" id="f_${esc(f.key)}" ${(staffStrictSubmit || _isFarmerNameField(f)) ? "required" : ""}`;
      const choiceKind = _choiceKind(f.key);
      let input;
      if (choiceKind) input = `<select class="caps" name="${esc(f.key)}" id="f_${esc(f.key)}" ${(staffStrictSubmit || _isFarmerNameField(f)) ? "required" : ""}>${_choiceOptionsFor(choiceKind, valRaw)}</select>`;
      else if (f.type === "textarea") input = `<textarea ${v} rows="3">${val}</textarea>`;
      else if (f.type === "date") input = `<input type="date" ${v} value="${val}">`;
      else if (isFarmArea) input = `<input type="number" step="any" min="0" inputmode="decimal" placeholder="e.g. 0.2526" ${v} value="${val}">`;
      else if (isRsbsa) input = `<input type="text" placeholder="e.g. 02-015-02-014-EFMN47" ${v} value="${val}">`;
      else if (f.type === "number") input = `<input type="number" step="any" ${v} value="${val}">`;
      else input = `<input type="text" ${v} value="${val}">`;
      const cls = f.type === "textarea" ? "field full" : "field";
      return `<div class="${cls}"><label>${esc(biLabel(f))} ${req}</label>${input}${help}</div>`;
    }).join("");
    const isLast = W.curIdx >= W.count - 1;
    body = `
      <div class="card">
        <h3>Step 3 — Your details (Hakbang 3 — Iyong mga Detalye)
          ${W.count > 1 ? `<span class="badge blue">Certificate ${W.curIdx + 1} of ${W.count} (Sertipiko ${W.curIdx + 1} ng ${W.count})</span>` : ""}</h3>
        <p class="page-sub">Barangay: <b>${esc(W.barangayName)}</b></p>
        <div class="field" style="max-width:560px">
          <label>Certification type for Entry ${W.curIdx + 1} (Uri ng Sertipikasyon para sa Entry ${W.curIdx + 1}) <span class="req">*</span></label>
          <select id="entry-type">
            ${W.templates.map((t) => `<option value="${t.id}" ${Number(curEntryWrap().tpl) === Number(t.id) ? "selected" : ""}>${esc(t.name)}</option>`).join("")}
          </select>
          <div class="help">Each entry (parcel) asks for its own certification
            type. Changing the type changes the questions below for this entry.
            (Bawat entry (parsela) ay may sariling uri ng sertipikasyon. Ang
            pagpapalit ng uri ay magpapalit ng mga tanong sa ibaba para sa
            entry na ito.)</div>
        </div>
        ${W.count > 1 ? `<div class="notice">Each entry is one <b>parcel</b>
           of the same farmer. Your profile from Entry 1 is automatically
           copied to Entries 2, 3, 4… and stays in sync when you correct
           Entry 1 — unless you edit that field in a later entry yourself.
           For every parcel, enter its own <b>Parcel Location</b> and
           <b>Farm Area</b>. Use <b>Next entry</b> to move on; click an entry
           chip to jump back. (Bawat entry ay isang parsela ng iisang
           magsasaka. Ang profile mula Entry 1 ay awtomatikong makokopya at
           mananatiling naka-sync — maliban kung ikaw mismo ang magbago nito
           sa susunod na entry. Ilagay ang sariling Lokasyon ng Parsela at
           Lawak ng Lupa ng bawat isa.)</div>` : ""}
        <div class="notice">Please type the information exactly as it appears
           on your RSBSA registration. For standardization, everything you
           type is converted to <b>CAPITAL LETTERS</b>. The secretary will
           review it before the certificate is issued. (Pakilagay ang
           impormasyon nang eksakto ayon sa iyong rehistrasyon sa RSBSA.
           Lahat ng iyong itatype ay gagawing MALALAKING TITIK. Susuriin ito
           ng sekretarya bago iisyu ang sertipiko.)</div>
        <div class="prefill-box">
          <div class="field">
            <label>Your RSBSA Number — type it, scan the QR code, or upload a QR photo (Ang Iyong Numero ng RSBSA — itype ito, i-scan ang QR code, o mag-upload ng larawan ng QR)</label>
            <input type="text" id="prefill-rsbsa" class="caps" placeholder="e.g. 02-015-02-014-EFMN47" value="${esc(W.prefillNum || "")}">
            <div class="qr-hint">Scanning fills in Entry 1 and copies your profile to all parcel entries. (Pupunan ng scan ang Entry 1 at kokopyahin ang iyong profile sa lahat ng parsela.)</div>
          </div>
          <button type="button" class="btn" id="prefill-go">Fetch my details (Kunin ang Aking mga Detalye)</button>
          <button type="button" class="btn btn-primary" id="qr-scan">📷 Scan QR (I-scan ang QR)</button>
          <button type="button" class="btn" id="qr-upload-btn">Upload QR photo (Mag-upload ng Larawan ng QR)</button>
          <button type="button" class="btn js-not-yet-rsbsa" id="not-yet-registered">NOT YET RSBSA REGISTERED (Hindi Pa Nakarehistro)</button>
          <input type="file" id="qr-file" accept="image/*" hidden>
          <div class="qr-hint">Not yet in the farmer database? Click <b>NOT YET RSBSA REGISTERED</b> to encode your farmer data. (Wala pa sa database ng magsasaka? I-click ang <b>NOT YET RSBSA REGISTERED</b> upang i-encode ang iyong datos.)</div>
        </div>
        ${entryNav}
        <div class="notice warn" style="border-width:2px">
          <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;justify-content:space-between">
            <div>
              <b>NOT YET RSBSA REGISTERED?</b><br>
              <span>No farmer record found in the database? Click the button to open the Farmer Entry Form (Pag-encode ng Datos ng Magsasaka). (Walang nakitang rekord ng magsasaka sa database? I-click ang button upang buksan ang Farmer Entry Form.)</span>
            </div>
            <button type="button" class="btn btn-primary js-not-yet-rsbsa" id="not-yet-registered-step3">NOT YET RSBSA REGISTERED (Hindi Pa Nakarehistro)</button>
          </div>
        </div>
        ${staffStrictSubmit
          ? `<div class="notice">You are signed in with a staff account —
               <b>all information fields must be filled</b> before this
               request can be submitted.</div>`
          : `<div class="notice">Only <b>Barangay</b> and <b>Farmer's Name</b>
               are required. All other details are <b>optional</b> — the
               secretary will complete and verify them before your certificate
               is issued. (Tanging <b>Barangay</b> at <b>Pangalan ng
               Magsasaka</b> lamang ang kinakailangan. Ang ibang detalye ay
               <b>opsyonal</b> — kukumpletuhin at beberipikahin ito ng
               sekretarya bago iisyu ang iyong sertipiko.)</div>`}
        <form id="details-form"><div class="form-grid">${rows}</div>
          <div class="btn-row">
            <button type="button" class="btn" id="back4">${W.curIdx > 0 ? "← Previous entry (Nakaraang Entry)" : "← Back (Bumalik)"}</button>
            ${isLast
              ? `<button type="submit" class="btn btn-primary">Submit request (Isumite ang Kahilingan)</button>`
              : `<button type="button" class="btn btn-primary" id="btn-next">Next entry (Susunod na Entry) →</button>`}
          </div>
        </form>
      </div>`;
  } else {
    body = `
      <div class="card success-box">
        <div class="big">✓</div>
        <h3>Request submitted! (Naipadala na ang Kahilingan!)</h3>
        <p>Your request for <b>${W.count} certificate${W.count > 1 ? "s" : ""}</b>
           has been queued to the secretary of
           <b>${esc(W.barangayName)}</b>${W.count > 1
             ? ` — all ${W.count} under a single reference number` : ""}.</p>
        <div class="ref-box" id="ref-box">${esc(W.refNo)}</div>
        ${W.dupHits && W.dupHits.length ? `<div class="notice warn">&#9888;
          Possible duplicate RSBSA number(s) were detected. The secretary will
          verify your record before the certificate is issued.</div>` : ""}
        <p class="page-sub">Keep this reference number — you will need it to
           track the status of your certification. (Itago ang reference
           number na ito — kakailanganin mo ito upang subaybayan ang katayuan
           ng iyong sertipikasyon.)</p>
        <div class="btn-row" style="justify-content:center">
          <button class="btn" id="copy-ref">Copy reference number (Kopyahin ang Reference Number)</button>
          <a class="btn" href="#/track">Track request (Subaybayan ang Kahilingan)</a>
          <button class="btn btn-primary" id="another">Submit another (Magsumite ng Panibago)</button>
        </div>
      </div>`;
  }

  $app.innerHTML = `
    <div class="page-title">Request a Certification (Humiling ng Sertipikasyon)</div>
    <p class="page-sub">For farmers and fisherfolk — no login required.
      (Para sa mga magsasaka at mangingisda — hindi kailangan mag-login.)</p>
    ${stepsBar()}
    ${body}`;

  if (W.step === 1) {
    document.querySelectorAll(".pick").forEach((el) =>
      el.addEventListener("click", () => {
        const oldBgyUpper = (W.barangayName || "").trim().toUpperCase();
        W.barangay = Number(el.dataset.id);
        W.barangayName = el.dataset.name;
        const newBgyUpper = (W.barangayName || "").trim().toUpperCase();
        (W.entries || []).forEach((e, idx) => {
          if (e && e.data && (!e.data.PARCEL_LOCATION || e.data.PARCEL_LOCATION === oldBgyUpper) &&
              !W.manual[`${idx}:PARCEL_LOCATION`]) {
            e.data.PARCEL_LOCATION = newBgyUpper;
          }
        });
        viewSubmit();
      }));
    bind("go2", "click", () => { W.step = 2; viewSubmit(); });
  } else if (W.step === 2) {
    const cntInput = document.getElementById("cert-count");
    bind("cnt-minus", "click", () => {
      cntInput.value = Math.max(1, (parseInt(cntInput.value, 10) || 1) - 1);
    });
    bind("cnt-plus", "click", () => {
      cntInput.value = Math.min(MAX_CERTS, (parseInt(cntInput.value, 10) || 1) + 1);
    });
    document.querySelectorAll(".count-chip").forEach((c) =>
      c.addEventListener("click", () => { cntInput.value = c.dataset.n; }));
    bind("back2", "click", () => { W.step = 1; viewSubmit(); });
    bind("go3", "click", () => {
      const n = parseInt(cntInput.value, 10);
      if (!n || n < 1 || n > MAX_CERTS) {
        toast(`Please enter a number between 1 and ${MAX_CERTS}. (Maglagay ng numero mula 1 hanggang ${MAX_CERTS}.)`, "err");
        return;
      }
      W.count = n;
      W.entries = Array.from({ length: n }, (_, i) =>
        W.entries[i] || { tpl: (W.entries[i - 1] || {}).tpl || null, data: {} });
      propagateProfile();
      W.curIdx = Math.min(W.curIdx, n - 1);
      W.step = 3;
      viewSubmit();
    });
  } else if (W.step === 3) {
    bind("back4", "click", () => {
      collectCurrentEntry();
      if (W.curIdx > 0) W.curIdx -= 1;
      else W.step = 2;
      viewSubmit();
    });
    bind("btn-next", "click", () => {
      const form = document.getElementById("details-form");
      if (!form.reportValidity()) return;
      collectCurrentEntry();
      propagateProfile();
      W.curIdx += 1;
      viewSubmit();
    });
    document.querySelectorAll(".entry-chip").forEach((ch) =>
      ch.addEventListener("click", () => {
        collectCurrentEntry();
        propagateProfile();
        W.curIdx = Number(ch.dataset.i);
        viewSubmit();
      }));
    bind("entry-type", "change", () => {
      collectCurrentEntry();   // captures the newly chosen type
      W.fieldsFor = null;      // force loading that type's questions
      viewSubmit();
    });
    // Live sync: editing Entry 1 updates the copied profile in entries 2+
    // (unless that field was manually edited in the later entry).
    document.querySelectorAll("#details-form [name]").forEach((inp) => {
      inp.addEventListener("input", () => {
        const field = W.fields.find((f) => f.key === inp.name);
        if (!field || !_isProfileField(field)) return;
        if (W.curIdx === 0) {
          collectCurrentEntry();
          propagateProfile();
        } else {
          const src = ((W.entries[0] || {}).data || {})[inp.name] || "";
          let v = inp.value.trim();
          if (field.type === "text" || field.type === "textarea") {
            v = v.toUpperCase();
          }
          W.manual[`${W.curIdx}:${inp.name}`] = v !== src;
        }
      });
    });
    if (staffStrictSubmit) {
      _applyMissingFieldHighlights(document.getElementById("details-form"));
    }
    bind("qr-scan", "click", startQrScan);
    bind("qr-upload-btn", "click", () =>
      document.getElementById("qr-file").click());
    document.getElementById("qr-file").addEventListener("change", (e) => {
      if (e.target.files && e.target.files[0]) {
        decodeQrImage(e.target.files[0]);
      }
      e.target.value = "";
    });
    const openFarmerEntryFromWizard = (num = "") => {
      farmerEntryModal({
        rsbsa: num,
        barangayId: W.barangay,
        barangayName: W.barangayName,
        notYet: true,
        onSaved: (saved) => {
          const _wrap0 = W.entries[0] || (W.entries[0] = { tpl: null, data: {} });
          const target = _wrap0.data || (_wrap0.data = {});
          const rsbsaField = W.fields.find((f) => _isRsbsaFieldKey(f.key));
          if (rsbsaField) target[rsbsaField.key] = saved.rsbsa_number;
          W.fields.forEach((f) => {
            if (!_isProfileField(f)) return;
            if (!target[f.key] && saved.data[f.key]) {
              target[f.key] = String(saved.data[f.key]).toUpperCase();
            }
          });
          propagateProfile();
          viewSubmit();
          toast("Farmer encoded — profile copied to all parcel entries. " +
                "Please complete the parcel details.");
        },
      });
    };
    document.querySelectorAll(".js-not-yet-rsbsa").forEach((btn) =>
      btn.addEventListener("click", () => {
        const num = (document.getElementById("prefill-rsbsa").value || "").trim().toUpperCase();
        W.prefillNum = num;
        collectCurrentEntry();
        openFarmerEntryFromWizard(num);
      }));
    bind("prefill-go", "click", async () => {
      const num = (document.getElementById("prefill-rsbsa").value || "").trim();
      if (!num) { toast("Enter your RSBSA number first.", "err"); return; }
      W.prefillNum = num;
      try {
        const r = await api(`/api/farmers/lookup?rsbsa=${encodeURIComponent(num)}` +
          `&barangay_id=${W.barangay}`);
        if (!r.found) {
          // No match in the database: this is the NOT YET RSBSA REGISTERED path —
          // open Farmer Data Entry so the farmer is encoded directly into
          // the masterlist (no CSV upload needed).
          openFarmerEntryFromWizard(num);
          return;
        }
        // Pre-fill always targets Entry 1 (the farmer profile), then the
        // profile is copied to every parcel entry unless manually edited.
        const _wrap0 = W.entries[0] || (W.entries[0] = { tpl: null, data: {} });
        const target = _wrap0.data || (_wrap0.data = {});
        let filled = 0;
        const rsbsaField = W.fields.find((f) => _isRsbsaFieldKey(f.key));
        if (rsbsaField && !target[rsbsaField.key]) {
          target[rsbsaField.key] = num.toUpperCase(); filled++;
        }
        W.fields.forEach((f) => {
          if (!_isProfileField(f)) return;
          if (!target[f.key] && r.data[f.key]) {
            target[f.key] = String(r.data[f.key]).toUpperCase(); filled++;
          }
        });
        propagateProfile();
        viewSubmit();
        toast(filled
          ? `Details pre-filled from your record as ${r.name} — copied to all parcel entries.`
          : `Record found for ${r.name} — your form is already complete.`);
        if (r.verification_status === "new") {
          toast("Note: your farmer profile is tagged NEW and awaiting " +
                "admin verification — you may continue.", "");
        }
      } catch (err) { toast(err.message, "err"); }
    });
    bind("details-form", "submit", async (e) => {
      e.preventDefault();
      const form = e.target;
      if (!form.reportValidity()) return;
      collectCurrentEntry();
      for (let i = 0; i < W.entries.length; i++) {
        const flds = await fieldsForTemplate(W.entries[i].tpl);
        if (flds.some((f) => (staffStrictSubmit || _isFarmerNameField(f)) && !(W.entries[i].data || {})[f.key])) {
          W.curIdx = i;
          W.fields = flds;
          W.fieldsFor = W.entries[i].tpl;
          viewSubmit();
          toast(staffStrictSubmit
            ? `Entry ${i + 1} is incomplete — staff accounts must fill in all fields.`
            : `Entry ${i + 1} needs the Farmer's Name — please fill it in. (Kailangan ang Pangalan ng Magsasaka sa Entry ${i + 1} — pakipunan ito.)`, "err");
          return;
        }
      }
      try {
        const r = await apiQ("/api/requests", { method: "POST", body: {
          barangay_id: W.barangay,
          template_id: (W.entries[0] || {}).tpl,
          entries: W.entries.map((e) => ({
            template_id: e.tpl, data: e.data || {},
          })),
        }}, `Farmer request submission \u2014 ${W.entries.length} certificate(s), ${W.barangayName || "barangay"}`);
        W.refNo = r.ref_no;
        W.count = r.count || W.entries.length;
        W.dupHits = r.dup_hits || [];
        W.step = 4;
        viewSubmit();
        toast("Request submitted successfully.");
      } catch (err) { toast(err.message, "err"); }
    });
  } else {
    bind("copy-ref", "click", async () => {
      try {
        await navigator.clipboard.writeText(W.refNo);
        toast("Copied!");
      } catch (_) { toast("Copy not available — please note it manually.", "err"); }
    });
    bind("another", "click", () => {
      Object.assign(W, { step: 1, barangay: null, barangayName: "",
                         template: null, templateName: "", count: 1,
                         entries: [], curIdx: 0, manual: {}, fields: [],
                         refNo: "", prefillNum: "" });
      viewSubmit();
    });
  }
}

/* ------------------------------ track ------------------------------- */
function viewTrack() {
  $app.innerHTML = `
    <div class="page-title">Track Your Request (Subaybayan ang Iyong Kahilingan)</div>
    <p class="page-sub">Enter the reference number you received when you submitted.
      (Ilagay ang reference number na natanggap mo nang magsumite ka.)</p>
    <div class="center-narrow wide">
      <div class="card">
        <form id="track-form" class="filters">
          <div class="field" style="max-width:none;flex:1">
            <label>Reference number (Numero ng Reperensya)</label>
            <input name="ref" placeholder="REQ-2026-00001" required autofocus>
          </div>
          <button class="btn btn-primary" type="submit">Check status (Tingnan ang Katayuan)</button>
        </form>
        <div id="track-result"></div>
      </div>
    </div>`;
  bind("track-form", "submit", async (e) => {
    e.preventDefault();
    const ref = new FormData(e.target).get("ref").toString().trim();
    const out = document.getElementById("track-result");
    out.innerHTML = `<div class="loading">Searching…</div>`;
    try {
      const r = await api(`/api/requests/track/${encodeURIComponent(ref)}`);
      let note = "";
      if (r.status === "rejected" && r.notes)
        note = `<div class="notice warn"><b>Reason (Dahilan):</b> ${esc(r.notes)}</div>`;
      if (r.status === "pending")
        note = `<div class="notice">Your request is waiting for review by the
                  barangay secretary. Please check again later. (Ang iyong
                  kahilingan ay naghihintay ng pagsusuri ng sekretarya ng
                  barangay. Pakitingnan muli mamaya.)</div>`;
      out.innerHTML = `
        <div style="margin-top:18px">
          <div class="meta-grid">
            <div class="meta-item"><div class="k">Reference</div>
              <div class="v mono">${esc(r.ref_no)}</div></div>
            <div class="meta-item"><div class="k">Status (Katayuan)</div>
              <div class="v">${statusBadge(r.status)}</div></div>
            <div class="meta-item"><div class="k">Barangay</div>
              <div class="v">${esc(r.barangay)}</div></div>
            <div class="meta-item"><div class="k">Certification (Uri ng Sertipikasyon)</div>
              <div class="v">${esc(r.template)}</div></div>
            <div class="meta-item"><div class="k">Submitted (Isinumite)</div>
              <div class="v">${fmtDT(r.submitted_at)}</div></div>
            <div class="meta-item"><div class="k">Reviewed (Sinuri)</div>
              <div class="v">${fmtDT(r.reviewed_at)}</div></div>
            ${r.entry_count > 1 ? `<div class="meta-item"><div class="k">Certificates requested (Bilang ng Sertipikong Hiniling)</div>
              <div class="v">${r.entry_count}</div></div>` : ""}
            ${r.cert_nos && r.cert_nos.length ? `<div class="meta-item"><div class="k">Certificate No.${r.cert_nos.length > 1 ? "s" : ""} (Numero ng Sertipiko)</div>
              <div class="v mono">${r.cert_nos.map(esc).join("<br>")}</div></div>` : ""}
          </div>
          ${note}
        </div>`;
    } catch (err) {
      out.innerHTML = `<div class="notice warn" style="margin-top:16px">
        ${esc(err.message)}</div>`;
    }
  });
}

/* ---------------------------- dashboard ----------------------------- */
async function viewDashboard() {
  $app.innerHTML = `<div class="loading">Loading…</div>`;
  let st, pend, certs, charts;
  try {
    [st, pend, certs, charts] = await Promise.all([
      api("/api/stats"), api("/api/requests/pending"),
      api("/api/certificates"), api("/api/stats/charts"),
    ]);
  } catch (err) { toast(err.message, "err"); return; }

  const scope = ME.role === "admin"
    ? "All barangays (administrator view)"
    : `Barangay ${esc(ME.barangay)}`;

  const statCards = `
    <div class="stats">
      <div class="stat gold"><div class="num">${st.pending}</div>
        <div class="label">Pending requests</div></div>
      <div class="stat green"><div class="num">${st.certificates}</div>
        <div class="label">Certificates issued</div></div>
      <div class="stat red"><div class="num">${st.rejected}</div>
        <div class="label">Rejected requests</div></div>
      ${ME.role === "admin" ? `
      <div class="stat"><div class="num">${st.barangays}</div>
        <div class="label">Barangays</div></div>
      <div class="stat"><div class="num">${st.secretaries}</div>
        <div class="label">Active secretaries</div></div>` : ""}
    </div>`;

  const chartMonthly = charts.monthly.some((m) => m.count > 0)
    ? svgBarChart(charts.monthly.map((m) => ({
        label: m.month.slice(5) + "/" + m.month.slice(2, 4),
        value: m.count })))
    : `<div class="chart-empty">No certificates issued yet.</div>`;
  const chartBgy = charts.by_barangay.some((b) => b.count > 0)
    ? svgHBarChart(charts.by_barangay.map((b) => ({
        label: b.name, value: b.count })))
    : `<div class="chart-empty">No certificates issued yet.</div>`;
  const chartSection = `
    <div class="grid-2">
      <div class="card chart-card"><h3>Issuances per month</h3>${chartMonthly}
        <div class="chart-legend">Last 12 months — ${
          ME.role === "admin" ? "all barangays" : esc(ME.barangay || "")}</div></div>
      <div class="card chart-card"><h3>Issuances per barangay</h3>${chartBgy}
        <div class="chart-legend">Cumulative totals${
          ME.role === "admin" ? " — all barangays" : " — your barangay"}</div></div>
    </div>`;

  const pendingRows = pend.length ? pend.map((r) => `
    <tr>
      <td class="mono">${esc(r.ref_no)}</td>
      <td>${fmtDT(r.submitted_at)}</td>
      <td>${esc(r.subject)}${r.count > 1
            ? ` <span class="badge blue">${r.count} certs</span>` : ""}</td>
      <td>${esc(r.template)}</td>
      ${ME.role === "admin" ? `<td>${esc(r.barangay)}</td>` : ""}
      <td><a class="btn btn-sm btn-primary" href="#/review/${r.id}">Review</a></td>
    </tr>`).join("") : "";

  const recentRows = certs.slice(0, 6).map((c) => `
    <tr>
      <td class="mono">${esc(c.cert_no)}</td>
      <td>${esc(c.farmer_name || "—")}</td>
      ${ME.role === "admin" ? `<td>${esc(c.barangay)}</td>` : ""}
      <td>${fmtD(c.generated_at)}</td>
      <td>
        ${c.pdf_available
          ? `<a class="btn btn-sm" href="/api/certificates/${c.id}/download/pdf">PDF</a>`
          : `<span class="badge rejected" title="PDF deleted after the 30-day retention period — record retained; regenerate it from the Archive">PDF purged</span>`}
      </td>
    </tr>`).join("");

  $app.innerHTML = `
    <div class="section-head">
      <div>
        <div class="page-title">Dashboard</div>
        <p class="page-sub" style="margin:0">Welcome, ${esc(ME.full_name)} — ${scope}</p>
      </div>
      <a class="btn btn-primary" href="#/archive">Open archive</a>
    </div>
    ${statCards}
    ${chartSection}
    <div class="card">
      <div class="section-head">
        <h3>Pending requests for review</h3>
        <span class="badge pending">${st.pending} waiting</span>
      </div>
      <div class="table-wrap">
        <table class="table">
          <thead><tr><th>Reference</th><th>Submitted</th><th>Requester</th>
            <th>Certification</th>${ME.role === "admin" ? "<th>Barangay</th>" : ""}
            <th></th></tr></thead>
          <tbody>${pendingRows || ""}</tbody>
        </table>
        ${pend.length ? "" : `<div class="empty">🎉 No pending requests.</div>`}
      </div>
    </div>
    <div class="card">
      <div class="section-head">
        <h3>Recently issued certificates</h3>
        <a href="#/archive">View all →</a>
      </div>
      <div class="table-wrap">
        <table class="table">
          <thead><tr><th>Certificate No.</th><th>Farmer</th>
            ${ME.role === "admin" ? "<th>Barangay</th>" : ""}
            <th>Issued</th><th>Copies</th></tr></thead>
          <tbody>${recentRows}</tbody>
        </table>
        ${certs.length ? "" : `<div class="empty">No certificates issued yet.</div>`}
      </div>
    </div>`;
}

/* ----------------------------- review ------------------------------- */
async function viewReview(id) {
  $app.innerHTML = `<div class="loading">Loading…</div>`;
  let r;
  try { r = await api(`/api/requests/${id}`); }
  catch (err) { toast(err.message, "err"); location.hash = "#/dashboard"; return; }

  const pending = r.status === "pending";
  const farmerFields = r.fields.filter((f) => !f.system);
  const typeByKey = {};
  r.fields.forEach((f) => { typeByKey[f.key] = f.type; });
  (r.entry_templates || []).forEach((t) =>
    (t.fields || []).forEach((f) => { typeByKey[f.key] = f.type; }));
  const entries = (r.entries && r.entries.length) ? r.entries : [r.data || {}];
  let orig = JSON.parse(JSON.stringify(entries));
  const defaultParcelLoc = (r.barangay || (ME && ME.barangay) || "").trim().toUpperCase();
  entries.forEach((e) => {
    if (e && !String(e.PARCEL_LOCATION || "").trim() && defaultParcelLoc) {
      e.PARCEL_LOCATION = defaultParcelLoc;
    }
  });
  let dirty = JSON.stringify(entries) !== JSON.stringify(orig);

  const today = new Date().toLocaleDateString("en-PH", {
    month: "long", day: "numeric", year: "numeric" });

  const processed = !pending ? `
    <div class="notice ${r.status === "rejected" ? "warn" : ""}">
      <b>This request was ${esc(r.status)}</b> on ${fmtDT(r.reviewed_at)}
      by ${esc(r.reviewer || "—")}.
      ${r.notes ? `<br><b>Notes:</b> ${esc(r.notes)}` : ""}
    </div>` : "";

  const dupNotice = (r.dup && r.dup.length) ? `
    <div class="notice warn">&#9888; <b>Possible duplicate RSBSA number detected:</b>
      <ul style="margin:6px 0 0 18px">
        ${r.dup.map((d) => `<li>RSBSA <b class="mono">${esc(d.rsbsa)}</b>
          submitted as &ldquo;${esc(d.submitted_name)}&rdquo; is already
          registered to <b>${esc(d.existing_name)}</b>.</li>`).join("")}
      </ul>
      Verify the farmer's identity before issuing.</div>` : "";

  const reqStar = pending ? ' <span class="req">*</span>' : "";
  const entryBlocks = entries.map((entry, i) => {
    const info = (r.entry_templates || [])[i];
    const efields = ensureParcelFields(
      info ? info.fields.filter((f) => !f.system) : farmerFields
    );
    const rows = efields.map((f) => {
      const rawVal = (f.key === "PARCEL_LOCATION" && !entry[f.key] && defaultParcelLoc)
        ? defaultParcelLoc
        : (entry[f.key] || "");
      const val = esc(rawVal);
      const isRsbsa = _isRsbsaFieldKey(f.key);
      const isFarmArea = f.key.toUpperCase() === "FARM_AREA";
      const labelText = isFarmArea ? "Farm Area (Ha)" : f.label;
      const caps = (f.type === "text" || f.type === "textarea" || isRsbsa) ? " caps" : "";
      const dis = pending ? " required" : " disabled";
      const common = `class="rectify-input${caps}" data-ei="${i}" data-key="${esc(f.key)}"${dis}`;
      const choiceKind = _choiceKind(f.key);
      let input;
      if (choiceKind) input = `<select ${common}>${_choiceOptionsFor(choiceKind, rawVal)}</select>`;
      else if (f.type === "textarea") input = `<textarea ${common} rows="3">${val}</textarea>`;
      else if (f.type === "date") input = `<input type="date" ${common} value="${val}">`;
      else if (isFarmArea) input = `<input type="number" step="any" min="0" inputmode="decimal" placeholder="e.g. 0.2526" ${common} value="${val}">`;
      else if (isRsbsa) input = `<input type="text" placeholder="e.g. 02-015-02-014-EFMN47" ${common} value="${val}">`;
      else if (f.type === "number") input = `<input type="number" step="any" ${common} value="${val}">`;
      else input = `<input type="text" ${common} value="${val}">`;
      const cls = f.type === "textarea" ? "field full" : "field";
      return `<div class="${cls}"><label>${esc(labelText)}${reqStar}</label>${input}</div>`;
    }).join("");
    const name = entry.FARMER_NAME ||
      Object.entries(entry).find(([k]) => k.includes("NAME"))?.[1] || "";
    return `
      <div class="entry-block">
        <div class="entry-head">
          <span>Certificate ${entries.length > 1
            ? `${i + 1} of ${entries.length}` : "details"}</span>
          <span class="badge blue">${esc(info ? info.name : r.template)}</span>
          <span class="mono">${esc(name)}</span>
        </div>
        <div class="form-grid">${rows}</div>
      </div>`;
  }).join("");

  $app.innerHTML = `
    <div class="section-head">
      <div>
        <div class="page-title">Review request <span class="mono">${esc(r.ref_no)}</span></div>
        <p class="page-sub" style="margin:0">${esc(r.template_label || r.template)} · ${esc(r.barangay)}
           · submitted ${fmtDT(r.submitted_at)}</p>
      </div>
      ${statusBadge(r.status)}
    </div>
    ${processed}
    ${dupNotice}
    ${(r.new_farmers && r.new_farmers.length) ? `
    <div class="notice warn">🆕 <b>New farmer — for admin verification:</b>
      ${r.new_farmers.map((x) => `${esc(x.name)} (RSBSA ${esc(x.rsbsa_number || "—")})`).join(", ")}
      is tagged NEW in the Farmer Masterlist and has not been verified by
      the admin yet. You may still process this request.</div>` : ""}
    <div class="grid-2">
      <div class="card">
        <div class="section-head">
          <h3>Information submitted by the farmer
            <span class="badge neutral">${entries.length} certificate${entries.length > 1 ? "s" : ""}</span></h3>
          ${pending ? `<button class="btn btn-sm" id="btn-save" disabled>Save corrections</button>` : ""}
        </div>
        ${pending ? `<div class="notice">Secretaries may <b>rectify</b> any
           entry before issuing — fix anything the farmer mistyped. Saved
           corrections are written to the audit trail. All text is
           standardized to <b>CAPITAL LETTERS</b>. <b>All information
           fields must be filled</b> before saving or issuing.</div>
           <div id="review-missing-banner"></div>` : ""}
        <div id="review-entries-wrap">${entryBlocks}</div>
      </div>
      <div>
        <div class="card">
          <h3>Certificate will be issued with</h3>
          <div class="meta-grid">
            <div class="meta-item"><div class="k">Barangay</div>
              <div class="v">${esc(r.barangay)}</div></div>
            <div class="meta-item"><div class="k">Certifying officer</div>
              <div class="v">${esc(ME.full_name)}</div></div>
            <div class="meta-item"><div class="k">Date issued</div>
              <div class="v">${today}</div></div>
            <div class="meta-item"><div class="k">Certificates to generate</div>
              <div class="v">${entries.length}</div></div>
            <div class="meta-item"><div class="k">Certificate no.</div>
              <div class="v">Assigned automatically on approval</div></div>
          </div>
        </div>
        ${pending ? `
        <div class="card">
          <h3>Decision</h3>
          <p class="page-sub">Verify — and correct if needed — the details on
             the left before admitting the request.</p>
          <div class="btn-row">
            <button class="btn btn-danger" id="btn-reject">Reject request</button>
            <button class="btn btn-success" id="btn-approve"
                    style="margin-left:auto">Approve &amp; issue ${entries.length > 1 ? `${entries.length} certificates` : "certificate"}</button>
          </div>
        </div>` : `
        <div class="card">
          <h3>Certificate copy</h3>
          <div class="btn-row">
            <a class="btn btn-primary" href="#/archive">Go to archive</a>
          </div>
        </div>`}
      </div>
    </div>`;

  if (!pending) return;

  const saveBtn = document.getElementById("btn-save");

  function collect() {
    const out = JSON.parse(JSON.stringify(orig));
    document.querySelectorAll(".rectify-input").forEach((el) => {
      const ei = Number(el.dataset.ei);
      const key = el.dataset.key;
      let v = (el.value || "").trim();
      const t = typeByKey[key] || "text";
      if (v && (t === "text" || t === "textarea")) v = v.toUpperCase();
      if (!out[ei]) out[ei] = {};
      if (v) out[ei][key] = v;
      else delete out[ei][key];
    });
    return out;
  }

  function markDirty() {
    dirty = JSON.stringify(collect()) !== JSON.stringify(orig);
    if (saveBtn) saveBtn.disabled = !dirty;
  }
  const checkMissing = _applyMissingFieldHighlights(
    document.getElementById("review-entries-wrap"),
    "review-missing-banner"
  );
  markDirty();
  document.querySelectorAll(".rectify-input").forEach((el) => {
    el.addEventListener("input", markDirty);
    el.addEventListener("change", markDirty);
  });

  async function saveCorrections() {
    const payload = collect();
    if (JSON.stringify(payload) === JSON.stringify(orig)) return true;
    try {
      const res = await apiQ(`/api/requests/${r.id}/correct`,
        { method: "POST", body: { entries: payload } },
        `Corrections to ${r.ref_no}`);
      orig = payload;
      dirty = false;
      if (saveBtn) saveBtn.disabled = true;
      if (res.changes) {
        toast(`${res.changes} correction${res.changes > 1 ? "s" : ""} saved to the audit trail.`);
      }
      return true;
    } catch (err) { toast(err.message, "err"); return false; }
  }

  bind("btn-save", "click", saveCorrections);
  bind("btn-approve", "click", async () => {
    if (checkMissing() > 0) {
      toast("All fields are mandatory for secretaries — please fill in all highlighted fields before issuing.", "err");
      return;
    }
    if (dirty && !(await saveCorrections())) return;
    approveModal(r, entries.length);
  });
  bind("btn-reject", "click", () => rejectModal(r));
}

function approveModal(r, count = 1) {
  const certWord = count > 1 ? `${count} certificates` : "a certificate";
  showModal(`
    <h3>Approve and issue ${esc(certWord)}</h3>
    <p>You are about to admit request <b class="mono">${esc(r.ref_no)}</b>
       ${count > 1 ? `covering <b>${count} certificates</b>` : ""}.
       ${count > 1 ? "Each entry will receive its own" : "It will receive its own"}
       certificate number, a PDF copy will be filed in the archive
       (Word renderings are temporary and are not saved; PDF files are
       retained for 30 days while the records are kept permanently), and
       every issuance will be recorded in the audit trail.</p>
    <div class="field">
      <label>Notes (optional)</label>
      <textarea id="ap-notes" rows="2"
        placeholder="Anything worth recording about this issuance"></textarea>
    </div>
    <div class="modal-actions">
      <button class="btn" id="ap-cancel">Cancel</button>
      <button class="btn btn-success" id="ap-go">Approve &amp; Issue</button>
    </div>`);
  bind("ap-cancel", "click", closeModal);
  bind("ap-go", "click", async () => {
    const btn = document.getElementById("ap-go");
    btn.disabled = true; btn.textContent = "Generating…";
    try {
      const res = await apiQ(`/api/requests/${r.id}/approve`, {
        method: "POST",
        body: { notes: document.getElementById("ap-notes").value },
      }, `Approve & issue ${r.ref_no}`);
      const rows = res.certs.map((c) => `
        <div class="cert-result-row">
          <div><b class="mono">${esc(c.cert_no)}</b>
            <div class="hint">${esc(c.farmer_name || "")}</div></div>
          <div style="display:flex;gap:6px;flex-wrap:wrap">
            <a class="btn btn-sm btn-primary" href="/api/certificates/${c.id}/download/pdf">PDF</a>
          </div>
        </div>`).join("");
      showModal(`
        <h3>${res.certs.length} certificate${res.certs.length > 1 ? "s" : ""} issued ✓</h3>
        <div class="cert-results">${rows}</div>
        <p class="page-sub" style="margin-top:12px">Filed in the archive and
           recorded in the audit trail.</p>
        <div class="modal-actions">
          <button class="btn btn-success" id="ok-done">Done</button>
        </div>`, 620);
      bind("ok-done", "click", () => {
        closeModal();
        location.hash = "#/dashboard";
      });
      toast(`${res.certs.length} certificate${res.certs.length > 1 ? "s" : ""} issued.`);
    } catch (err) {
      toast(err.message, "err");
      btn.disabled = false; btn.textContent = "Approve & Issue";
    }
  });
}

function rejectModal(r) {
  showModal(`
    <h3>Reject request</h3>
    <p>Request <b class="mono">${esc(r.ref_no)}</b> will be marked as rejected.
       The reason is shown to the farmer when they track their request.</p>
    <div class="field">
      <label>Reason <span class="req">*</span></label>
      <textarea id="rj-notes" rows="3" required
        placeholder="e.g. Name does not match RSBSA records"></textarea>
    </div>
    <div class="modal-actions">
      <button class="btn" id="rj-cancel">Cancel</button>
      <button class="btn btn-danger" id="rj-go">Reject request</button>
    </div>`);
  bind("rj-cancel", "click", closeModal);
  bind("rj-go", "click", async () => {
    const notes = document.getElementById("rj-notes").value.trim();
    if (!notes) { toast("Please provide a reason.", "err"); return; }
    try {
      await apiQ(`/api/requests/${r.id}/reject`, { method: "POST", body: { notes } },
        `Reject ${r.ref_no}`);
      closeModal();
      toast("Request rejected.");
      location.hash = "#/dashboard";
    } catch (err) { toast(err.message, "err"); }
  });
}

/* ----------------------------- archive ------------------------------ */
async function viewArchive() {
  $app.innerHTML = `
    <div class="page-title">Certificate Archive</div>
    <p class="page-sub">Filing system for every certificate issued through
       this app. ${ME.role === "admin" ? "Showing all barangays."
       : "Showing barangay " + esc(ME.barangay) + "."}
       Certificates are filed as <b>PDF only</b> — PDF files are
       automatically deleted after 30 days, but every certificate record,
       report and audit entry is retained permanently, and a purged PDF
       can be regenerated at any time.</p>
    <div class="card">
      <form id="arc-filters" class="filters">
        <div class="field"><label>Search</label>
          <input name="q" placeholder="Name, cert no., reference…"></div>
        <div class="field"><label>From</label><input type="date" name="from"></div>
        <div class="field"><label>To</label><input type="date" name="to"></div>
        <button class="btn btn-primary" type="submit">Search</button>
        <a class="btn" id="exp-xlsx" href="/api/certificates/export/xlsx">⬇ Excel</a>
        <a class="btn" id="exp-csv" href="/api/certificates/export/csv">⬇ CSV</a>
        <a class="btn btn-primary" id="exp-data" href="/api/certificates/export-data"
           title="One row per issued certificate, including every field the farmer entered">⬇ Issued Data (CSV)</a>
      </form>
      <p class="small muted" style="margin:0 0 10px"><b>Issued Data (CSV)</b>
        exports each issued certificate together with all the information
        entered for it (farmer name, RSBSA number, parcel location, farm
        area, purpose…) as logged in the database at issuance.</p>
      <div id="arc-results"><div class="loading">Loading…</div></div>
    </div>`;

  async function load() {
    const fd = new FormData(document.getElementById("arc-filters"));
    const qs = new URLSearchParams();
    ["q", "from", "to"].forEach((k) => {
      const v = (fd.get(k) || "").toString().trim();
      if (v) qs.set(k, v);
    });
    document.getElementById("exp-xlsx").href =
      "/api/certificates/export/xlsx?" + qs.toString();
    document.getElementById("exp-csv").href =
      "/api/certificates/export/csv?" + qs.toString();
    document.getElementById("exp-data").href =
      "/api/certificates/export-data?" + qs.toString();
    const out = document.getElementById("arc-results");
    try {
      const rows = await api(`/api/certificates?${qs.toString()}`);
      out.innerHTML = rows.length ? `
        <div class="table-wrap">
          <table class="table">
            <thead><tr><th>Certificate No.</th><th>Farmer</th>
              ${ME.role === "admin" ? "<th>Barangay</th>" : ""}
              <th>Template</th><th>Reference</th><th>Issued</th>
              <th>Issued by</th><th>Copies</th></tr></thead>
            <tbody>${rows.map((c) => `
              <tr>
                <td class="mono">${esc(c.cert_no)}</td>
                <td>${esc(c.farmer_name || "—")}</td>
                ${ME.role === "admin" ? `<td>${esc(c.barangay)}</td>` : ""}
                <td>${esc(c.template)}</td>
                <td class="mono">${esc(c.ref_no)}</td>
                <td>${fmtDT(c.generated_at)}
                  ${c.pdf_available && c.pdf_expires_at
                    ? `<div class="hint">PDF kept until ${fmtD(c.pdf_expires_at)}</div>`
                    : c.pdf_purged_at
                      ? `<div class="hint">PDF purged ${fmtD(c.pdf_purged_at)} — record retained</div>`
                      : ""}</td>
                <td>${esc(c.generator)}</td>
                <td style="white-space:nowrap">
                  ${c.pdf_available
                    ? `<a class="btn btn-sm" href="/api/certificates/${c.id}/download/pdf">PDF</a>`
                    : `<span class="badge rejected">PDF purged</span>
                       <button class="btn btn-sm btn-primary" data-regen="${c.id}">Regenerate PDF</button>`}
                </td>
              </tr>`).join("")}</tbody>
          </table>
        </div>`
        : `<div class="empty">No certificates match your search.</div>`;
      out.querySelectorAll("[data-regen]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          btn.disabled = true;
          btn.textContent = "Regenerating…";
          try {
            const res = await api(
              `/api/certificates/${btn.dataset.regen}/regenerate`,
              { method: "POST", body: {} });
            toast(`PDF regenerated for ${res.cert_no} — kept for a fresh 30 days.`);
            await load();
          } catch (err) {
            toast(err.message, "err");
            btn.disabled = false;
            btn.textContent = "Regenerate PDF";
          }
        });
      });
    } catch (err) { toast(err.message, "err"); }
  }
  bind("arc-filters", "submit", (e) => { e.preventDefault(); load(); });
  await load();
}

/* ---------------------------- audit trail --------------------------- */
async function viewAudit() {
  const actions = Object.entries(ACTION_LABELS);
  $app.innerHTML = `
    <div class="page-title">Audit Trail</div>
    <p class="page-sub">Every action recorded by the system
       ${ME.role === "admin" ? "(all users, all barangays)."
       : "(your barangay and your actions)."} Latest 500 entries shown.</p>
    <div class="card">
      <form id="aud-filters" class="filters">
        <div class="field"><label>Action</label>
          <select name="action">
            <option value="">All actions</option>
            ${actions.map(([v, l]) => `<option value="${v}">${l}</option>`).join("")}
          </select></div>
        <div class="field"><label>From</label><input type="date" name="from"></div>
        <div class="field"><label>To</label><input type="date" name="to"></div>
        <button class="btn btn-primary" type="submit">Filter</button>
      </form>
      <div id="aud-results"><div class="loading">Loading…</div></div>
    </div>`;

  async function load() {
    const fd = new FormData(document.getElementById("aud-filters"));
    const qs = new URLSearchParams();
    ["action", "from", "to"].forEach((k) => {
      const v = (fd.get(k) || "").toString().trim();
      if (v) qs.set(k, v);
    });
    const out = document.getElementById("aud-results");
    try {
      const rows = await api(`/api/audit?${qs.toString()}`);
      out.innerHTML = rows.length ? `
        <div class="table-wrap">
          <table class="table">
            <thead><tr><th>Timestamp</th><th>Actor</th><th>Role</th>
              <th>Action</th><th>Barangay</th><th>Details</th></tr></thead>
            <tbody>${rows.map((a) => `
              <tr>
                <td style="white-space:nowrap">${fmtDT(a.ts)}</td>
                <td>${esc(a.actor)}</td>
                <td><span class="badge neutral">${esc(a.actor_role)}</span></td>
                <td><span class="badge blue">${esc(ACTION_LABELS[a.action] || a.action)}</span></td>
                <td>${esc(a.barangay || "—")}</td>
                <td>${esc(a.detail || "")}</td>
              </tr>`).join("")}</tbody>
          </table>
        </div>`
        : `<div class="empty">No audit entries match your filter.</div>`;
    } catch (err) { toast(err.message, "err"); }
  }
  bind("aud-filters", "submit", (e) => { e.preventDefault(); load(); });
  await load();
}

/* ------------------------------ admin ------------------------------- */
/* ------------------------------ charts ------------------------------ */
function svgBarChart(items) {
  const CW = 640, CH = 240, padL = 36, padB = 36, padT = 24, padR = 8;
  const max = Math.max(1, ...items.map((i) => i.value));
  const innerW = CW - padL - padR, innerH = CH - padT - padB;
  const bw = innerW / Math.max(1, items.length);
  let bars = "", labels = "", grid = "";
  for (let g = 0; g <= 4; g++) {
    const val = Math.round((max * g) / 4);
    const y = padT + innerH - (innerH * g) / 4;
    grid += `<line x1="${padL}" y1="${y}" x2="${CW - padR}" y2="${y}"
      stroke="#e5e7eb" stroke-width="1"/>
      <text x="${padL - 6}" y="${y + 4}" text-anchor="end"
      font-size="10" fill="#6b7280">${val}</text>`;
  }
  items.forEach((it, i) => {
    const h = (it.value / max) * innerH;
    const x = padL + i * bw + bw * 0.15;
    const y = padT + innerH - h;
    bars += `<rect x="${x}" y="${y}" width="${bw * 0.7}" height="${h}"
      rx="3" fill="#0f4c81"><title>${esc(it.label)}: ${it.value}</title></rect>`;
    if (it.value) {
      bars += `<text x="${x + bw * 0.35}" y="${y - 4}" text-anchor="middle"
        font-size="10" fill="#0f4c81" font-weight="700">${it.value}</text>`;
    }
    const lx = x + bw * 0.35, ly = CH - padB + 16;
    labels += `<text x="${lx}" y="${ly}" text-anchor="end" font-size="9.5"
      fill="#6b7280" transform="rotate(-45 ${lx} ${ly})">${esc(it.label)}</text>`;
  });
  return `<svg viewBox="0 0 ${CW} ${CH}" role="img">${grid}${bars}${labels}</svg>`;
}

function svgHBarChart(items) {
  const CW = 640, rowH = 30, padT = 8, padL = 150, padR = 44;
  const CH = padT + items.length * rowH + 8;
  const max = Math.max(1, ...items.map((i) => i.value));
  const innerW = CW - padL - padR;
  let out = "";
  items.forEach((it, i) => {
    const y = padT + i * rowH;
    const w = Math.max(2, (it.value / max) * innerW);
    out += `<text x="${padL - 8}" y="${y + rowH / 2 + 4}" text-anchor="end"
      font-size="12" fill="#1f2937">${esc(it.label)}</text>
      <rect x="${padL}" y="${y + 5}" width="${w}" height="${rowH - 14}"
      rx="4" fill="#0f4c81"><title>${esc(it.label)}: ${it.value}</title></rect>
      <text x="${padL + w + 7}" y="${y + rowH / 2 + 4}" font-size="12"
      fill="#0f4c81" font-weight="700">${it.value}</text>`;
  });
  return `<svg viewBox="0 0 ${CW} ${CH}" role="img">${out}</svg>`;
}

/* ---------------------------- farmers ------------------------------ */
let farmerTab = "all";

function confirmModal(title, text, okLabel, onOk, danger = false) {
  showModal(`
    <h3>${esc(title)}</h3>
    <p>${text}</p>
    <div class="modal-actions">
      <button class="btn" id="cf-cancel">Cancel</button>
      <button class="btn ${danger ? "btn-danger" : "btn-primary"}"
              id="cf-ok">${esc(okLabel)}</button>
    </div>`);
  bind("cf-cancel", "click", closeModal);
  bind("cf-ok", "click", async () => { closeModal(); await onOk(); });
}

async function farmerEditModal(f, onSaved) {
  let bgy = [];
  try { bgy = await api("/api/admin/barangays"); } catch (_) { /* admin only */ }
  showModal(`
    <h3>Edit Farmer Record</h3>
    <p>Correct any detail below. The record keeps its verification status:
      ${f.verification_status === "new"
        ? `<span class="badge pending">NEW — for verification</span>`
        : `<span class="badge approved">Verified</span>`}</p>
    <div class="form-grid">
      <div class="field"><label>Farmer Name *</label>
        <input type="text" id="ed-name" class="caps" value="${esc(f.name)}"></div>
      <div class="field"><label>RSBSA Number</label>
        <input type="text" id="ed-rsbsa" class="caps" value="${esc(f.rsbsa_number || "")}"></div>
      <div class="field"><label>Civil Status</label>
        <select id="ed-civil" class="caps">${_choiceOptionsFor("civil", f.civil_status || "")}</select></div>
      <div class="field"><label>Barangay *</label>
        <select id="ed-barangay">${bgy.map((b) =>
          `<option value="${b.id}" ${Number(f.barangay_id) === Number(b.id) ? "selected" : ""}>${esc(b.name)}</option>`).join("")}
        </select></div>
      <div class="field full"><label>Address</label>
        <input type="text" id="ed-address" class="caps" value="${esc(f.address || "")}"></div>
    </div>
    <div class="modal-actions">
      <button class="btn" id="ed-cancel">Cancel</button>
      <button class="btn btn-primary" id="ed-save">Save changes</button>
    </div>`, 640);
  bind("ed-cancel", "click", closeModal);
  bind("ed-save", "click", async () => {
    const body = {
      name: document.getElementById("ed-name").value.trim(),
      rsbsa_number: document.getElementById("ed-rsbsa").value.trim(),
      civil_status: document.getElementById("ed-civil").value.trim(),
      address: document.getElementById("ed-address").value.trim(),
      barangay_id: Number(document.getElementById("ed-barangay").value),
    };
    if (!body.name) { toast("Farmer name is required.", "err"); return; }
    try {
      await api(`/api/farmers/${f.id}`, { method: "PUT", body });
      closeModal();
      toast(`Farmer record for ${body.name.toUpperCase()} updated.`);
      if (onSaved) onSaved();
    } catch (err) { toast(err.message, "err"); }
  });
}


async function farmerIdModal(f, onDone) {
  const hasId = !!f.id_control_no;
  const bust = Date.now();
  const previews = hasId ? `
    <div id="fid-preview">
      <div class="id-preview-grid">
        <figure>
          <img src="/api/farmers/${f.id}/id-card/front?v=${bust}" alt="ID front">
          <figcaption>Front</figcaption>
        </figure>
        <figure>
          <img src="/api/farmers/${f.id}/id-card/back?v=${bust}" alt="ID back">
          <figcaption>Back (QR = RSBSA Number)</figcaption>
        </figure>
      </div>
      <div class="actions" style="margin-top:10px">
        <a class="btn btn-primary" href="/api/farmers/${f.id}/id-card/pdf">⬇ PDF — back-to-back (CR80)</a>
        <a class="btn" href="/api/farmers/${f.id}/id-card/front">⬇ Front PNG</a>
        <a class="btn" href="/api/farmers/${f.id}/id-card/back">⬇ Back PNG</a>
      </div>
    </div>` : `<div id="fid-preview"></div>`;
  showModal(`
    <h3>🪪 Farmer's ID — ${esc(f.name)}</h3>
    <p class="small muted">The card is generated from the farmer's masterlist
      record. Birthdate, contact numbers and the photo are saved to
      the profile, so reprints are one click. The QR code on the back
      encodes the RSBSA Number and works with this app's QR scanner.</p>
    ${hasId ? `<div class="notice">ID <b class="mono">${esc(f.id_control_no)}</b>
      is already issued — valid until ${fmtD(f.id_valid_until)}
      (${f.id_reprints || 0} reprint(s) so far). Generating again is a
      <b>reprint</b> with the same control number.</div>` : ""}
    <div class="meta-grid" style="margin-bottom:12px">
      <div class="meta-item"><div class="k">RSBSA No.</div>
        <div class="v mono">${esc(f.rsbsa_number || "—")}</div></div>
      <div class="meta-item"><div class="k">Barangay</div>
        <div class="v">${esc(f.barangay || "—")}</div></div>
      <div class="meta-item"><div class="k">Civil Status</div>
        <div class="v">${esc(f.civil_status || "—")}</div></div>
      <div class="meta-item"><div class="k">Address</div>
        <div class="v">${esc(f.address || "—")}</div></div>
    </div>
    <form id="fid-form">
      <div class="form-grid">
        <div class="field"><label>Birthdate</label>
          <input type="date" id="fid-birthdate" value="${esc(f.birthdate || "")}"></div>
        <div class="field"><label>Contact Number</label>
          <input id="fid-contact" class="caps" value="${esc(f.contact_number || "")}" placeholder="09XX XXX XXXX"></div>
        <div class="field"><label>Contact Person in Case of Emergency (Name — Number)</label>
          <input id="fid-emergency" class="caps" value="${esc(f.emergency_contact || "")}" placeholder="MARIA CRUZ - 0917 123 4567"></div>
      </div>
      <div class="field full"><label>Farmer's Affiliated FCA (printed below QR code at the back of the ID)</label>
        <input id="fid-fca" class="caps" list="fid-fca-datalist" value="${esc(f.affiliated_fca || "")}" placeholder="Select or type FCA name (e.g. ALCALA FARMERS COOPERATIVE)">
        <datalist id="fid-fca-datalist"></datalist>
      </div>
      <div class="field"><label>ID Photo (JPG/PNG) — Browse, Drag &amp; Drop, or Copy &amp; Paste (Ctrl+V)</label>
        <div class="photo-dropzone" id="fid-photo-drop" tabindex="0">
          ${f.photo_path ? `<img class="id-thumb" src="/api/farmers/${f.id}/photo?v=${bust}" alt="Farmer photo">` : `<span class="small muted">No photo yet — the card will show a silhouette.</span>`}
          <img class="id-thumb" id="fid-photo-preview" alt="" style="display:none">
          <div style="flex:1;min-width:200px">
            <div style="font-weight:600;font-size:13px">Drag &amp; drop a photo here, press <b>Ctrl+V</b> to paste an image, or browse:</div>
            <input type="file" id="fid-photo" accept="image/png,image/jpeg,image/webp" style="margin-top:6px">
            <div class="small muted" id="fid-photo-status">Supports JPG, PNG, or pasted clipboard images</div>
          </div>
        </div>
      </div>
      ${hasId ? "" : `<div class="field"><label>Validity</label>
        <select id="fid-years">
          <option value="1">1 year</option>
          <option value="2">2 years</option>
          <option value="3" selected>3 years</option>
          <option value="5">5 years</option>
        </select></div>`}
    </form>
    ${previews}
    <div class="modal-actions">
      <button class="btn" id="fid-close" type="button">Close</button>
      <button class="btn btn-primary" id="fid-go" type="button">${hasId ? "🖨 Reprint ID Card" : "🪪 Generate ID Card"}</button>
    </div>`, 800);
  bind("fid-close", "click", closeModal);
  fetchFcaNames().then((names) => {
    const dl = document.getElementById("fid-fca-datalist");
    if (dl) dl.innerHTML = names.map((n) => `<option value="${esc(n)}"></option>`).join("");
  });
  const photoHelper = _bindPhotoDropAndPaste({
    dropId: "fid-photo-drop",
    inputId: "fid-photo",
    previewId: "fid-photo-preview",
    statusId: "fid-photo-status",
  });
  bind("fid-go", "click", async () => {
    const btn = document.getElementById("fid-go");
    const extras = {
      birthdate: document.getElementById("fid-birthdate").value,
      contact_number: document.getElementById("fid-contact").value.trim(),
      emergency_contact: document.getElementById("fid-emergency").value.trim(),
      affiliated_fca: (document.getElementById("fid-fca").value || "").trim().toUpperCase(),
    };
    btn.disabled = true;
    btn.textContent = "Generating…";
    try {
      const changed = Object.entries(extras).some(
        ([k, v]) => (v || "") !== (f[k] || ""));
      if (changed) {
        await api(`/api/farmers/${f.id}`, { method: "PUT", body: {
          name: f.name, rsbsa_number: f.rsbsa_number || "",
          civil_status: f.civil_status || "", address: f.address || "",
          barangay_id: f.barangay_id, ...extras } });
      }
      const file = photoHelper.getFile();
      if (file) {
        const fd = new FormData();
        fd.append("photo", file);
        await api(`/api/farmers/${f.id}/photo`, { method: "POST", form: fd });
      }
      const yearsEl = document.getElementById("fid-years");
      const res = await api(`/api/farmers/${f.id}/id-card`, {
        method: "POST",
        body: { valid_years: yearsEl ? Number(yearsEl.value) : 3 } });
      toast(`Farmer's ID ${res.control_no} ${res.reprints ? "reprinted" : "generated"} — valid until ${res.valid_until}.`);
      closeModal();
      if (onDone) onDone();
      const d = await api(`/api/farmers/${f.id}`).catch(() => null);
      if (d && d.id_card) {
        farmerIdModal({ ...f, ...extras,
          photo_path: d.has_photo ? "1" : f.photo_path,
          id_control_no: d.id_card.control_no,
          id_valid_until: d.id_card.valid_until,
          id_reprints: d.id_card.reprint_count }, onDone);
      }
    } catch (err) {
      toast(err.message, "err");
      btn.disabled = false;
      btn.textContent = hasId ? "🖨 Reprint ID Card" : "🪪 Generate ID Card";
    }
  });
}

async function viewFarmers() {
  $app.innerHTML = `
    <div class="page-title">Farmer Masterlist</div>
    <p class="page-sub">Automatically built from certification requests —
       ${ME.role === "admin" ? "all barangays."
         : "Barangay " + esc(ME.barangay) + " only."}
       Search by name or RSBSA number. Repeat requests can pre-fill the
       farmer's form.</p>
    <div class="card">
      <div class="actions" style="margin-bottom:12px">
        <button class="btn btn-primary" id="farmer-add" type="button">＋ Farmer Data Entry</button>
        <span class="small muted">Encode a farmer directly into the database — no CSV upload needed.</span>
      </div>
      <div class="entry-chips" style="margin-bottom:12px">
        <button type="button" class="entry-chip ${farmerTab === "all" ? "active" : ""}" data-ftab="all">All farmers</button>
        <button type="button" class="entry-chip ${farmerTab === "new" ? "active" : ""}" data-ftab="new">🆕 New — for verification</button>
        <button type="button" class="entry-chip ${farmerTab === "verified" ? "active" : ""}" data-ftab="verified">✓ Verified</button>
        <span class="small muted" id="farmers-counts"></span>
      </div>
      <form id="farmers-filters" class="filters">
        <div class="field"><label>Search</label>
          <input name="q" placeholder="Name or RSBSA number"></div>
        <button class="btn btn-primary" type="submit">Search</button>
      </form>
      <div id="farmers-results"><div class="loading">Loading…</div></div>
    </div>`;

  async function load() {
    const q = (new FormData(document.getElementById("farmers-filters"))
      .get("q") || "").toString();
    const out = document.getElementById("farmers-results");
    try {
      const st = await api("/api/farmers/stats").catch(() => null);
      const cntEl = document.getElementById("farmers-counts");
      if (cntEl && st) {
        cntEl.textContent = st.new
          ? `${st.new} new farmer(s) awaiting admin verification of ${st.total} records.`
          : `All ${st.total} farmer record(s) verified.`;
      }
      const statusQ = farmerTab === "all" ? "" : `&status=${farmerTab}`;
      const rows = await api(`/api/farmers?q=${encodeURIComponent(q)}${statusQ}`);
      out.innerHTML = rows.length ? `
        <div class="table-wrap">
          <table class="table">
            <thead><tr><th>Name</th><th>RSBSA No.</th><th>Barangay</th>
              <th>Requests</th><th>Last request</th><th>Status</th><th>Farmer's ID</th><th></th></tr></thead>
            <tbody>${rows.map((f) => `
              <tr>
                <td><b>${esc(f.name)}</b></td>
                <td class="mono">${esc(f.rsbsa_number || "—")}</td>
                <td>${esc(f.barangay || "—")}</td>
                <td>${f.requests}</td>
                <td class="mono">${esc(f.last_ref || "—")}</td>
                <td>${f.verification_status === "new"
                  ? `<span class="badge pending">NEW</span>`
                  : `<span class="badge approved">Verified</span>`}</td>
                <td>${f.id_control_no
                  ? `<span class="badge blue mono">${esc(f.id_control_no)}</span>
                     <div class="small muted">until ${fmtD(f.id_valid_until)}</div>`
                  : `<span class="small muted">Not yet issued</span>`}</td>
                <td style="white-space:nowrap">
                  <button class="btn btn-sm" data-farmer="${f.id}">Profile</button>
                  ${ME.role === "admin" ? `<button class="btn btn-sm" data-fidcard="${f.id}">🪪 ID Generator</button>` : ""}
                  ${ME.role === "admin" ? `<button class="btn btn-sm" data-fedit="${f.id}">Edit</button>` : ""}
                  ${ME.role === "admin" && f.verification_status === "new" ? `<button class="btn btn-sm btn-success" data-fverify="${f.id}">Verify</button>
                  <button class="btn btn-sm btn-danger" data-fdelete="${f.id}">Delete</button>` : ""}
                </td>
              </tr>`).join("")}</tbody>
          </table>
        </div>` : `<div class="empty">No farmers match your search.</div>`;
      document.querySelectorAll("[data-farmer]").forEach((btn) =>
        btn.addEventListener("click", () =>
          farmerModal(Number(btn.dataset.farmer))));
      document.querySelectorAll("[data-fidcard]").forEach((btn) =>
        btn.addEventListener("click", async () => {
          const f = rows.find((x) => x.id === Number(btn.dataset.fidcard));
          if (!f) return;
          if (!f.rsbsa_number) {
            toast("This farmer has no RSBSA Number yet — add one first (Edit).", "err");
            return;
          }
          btn.disabled = true;
          try {
            const r = await api("/api/id-generator/copy-masterlist",
              { method: "POST", body: { farmer_ids: [f.id] } });
            idGenOpenRsbsa = f.rsbsa_number;
            toast(r.added_count
              ? `${f.name} copied into the ID Generator database.`
              : `${f.name} is already in the ID Generator database.`);
            location.hash = "#/id-generator";
          } catch (err) { toast(err.message, "err"); btn.disabled = false; }
        }));
      document.querySelectorAll("[data-fedit]").forEach((btn) =>
        btn.addEventListener("click", () => {
          const f = rows.find((x) => x.id === Number(btn.dataset.fedit));
          if (f) farmerEditModal(f, load);
        }));
      document.querySelectorAll("[data-fverify]").forEach((btn) =>
        btn.addEventListener("click", () => {
          const f = rows.find((x) => x.id === Number(btn.dataset.fverify));
          if (!f) return;
          confirmModal("Verify farmer",
            `Mark <b>${esc(f.name)}</b> (RSBSA ${esc(f.rsbsa_number || "—")}) ` +
            `as <b>verified</b>? You should have checked this record first.`,
            "Verify", async () => {
              try {
                await api(`/api/farmers/${f.id}/verify`, { method: "POST", body: {} });
                toast(`${f.name} marked as verified.`);
                load();
              } catch (err) { toast(err.message, "err"); }
            });
        }));
      document.querySelectorAll("[data-fdelete]").forEach((btn) =>
        btn.addEventListener("click", () => {
          const f = rows.find((x) => x.id === Number(btn.dataset.fdelete));
          if (!f) return;
          confirmModal("Delete NEW farmer record",
            `Delete the unverified record of <b>${esc(f.name)}</b> ` +
            `(RSBSA ${esc(f.rsbsa_number || "—")})? This is only for bogus ` +
            `or test entries with no issued certificates, and is recorded ` +
            `in the audit trail.`,
            "Delete record", async () => {
              try {
                await api(`/api/farmers/${f.id}`, { method: "DELETE" });
                toast(`NEW farmer record of ${f.name} deleted.`);
                load();
              } catch (err) { toast(err.message, "err"); }
            }, true);
        }));
    } catch (err) { toast(err.message, "err"); }
  }
  bind("farmers-filters", "submit", (e) => { e.preventDefault(); load(); });
  document.querySelectorAll("[data-ftab]").forEach((btn) =>
    btn.addEventListener("click", () => {
      farmerTab = btn.dataset.ftab;
      viewFarmers();
    }));
  bind("farmer-add", "click", async () => {
    let bgy = [];
    if (ME.role === "admin") {
      try { bgy = await api("/api/admin/barangays"); rememberBarangays(bgy); }
      catch (_) { /* offline: fall back below */ }
    }
    if (!bgy.length) {
      try { bgy = await api("/api/barangays"); rememberBarangays(bgy); }
      catch (_) { bgy = cachedBarangays(); }
    }
    farmerEntryModal({
      barangays: bgy.length ? bgy : null,
      barangayId: ME.barangay_id,
      barangayName: ME.barangay || "",
      onSaved: () => load(),
    });
  });
  await load();
}

async function farmerModal(id) {
  let f;
  try { f = await api(`/api/farmers/${id}`); }
  catch (err) { toast(err.message, "err"); return; }
  const dataRows = Object.entries(f.data || {}).slice(0, 12).map(([k, v]) =>
    `<tr><td style="width:42%"><b>${esc(
      k.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()))}</b></td>
     <td class="caps">${esc(v)}</td></tr>`).join("");
  const reqRows = (f.requests || []).map((r) => `
    <tr>
      <td class="mono">${esc(r.ref_no)}</td>
      <td>${fmtD(r.submitted_at)}</td>
      <td>${statusBadge(r.status)}</td>
      <td>${esc(r.template)}</td>
      <td class="mono">${esc(r.cert_nos || "—")}</td>
    </tr>`).join("");
  showModal(`
    <h3>${esc(f.name)}</h3>
    <div class="meta-grid" style="margin-bottom:12px">
      <div class="meta-item"><div class="k">RSBSA No.</div>
        <div class="v mono">${esc(f.rsbsa_number || "—")}</div></div>
      <div class="meta-item"><div class="k">Barangay</div>
        <div class="v">${esc(f.barangay || "—")}</div></div>
      <div class="meta-item"><div class="k">Verification</div>
        <div class="v">${f.verification_status === "new"
          ? `<span class="badge pending">NEW — for admin verification</span>`
          : `<span class="badge approved">Verified</span>${f.verified_at ? ` <span class="small muted">${fmtD(f.verified_at)}</span>` : ""}`}</div></div>
      <div class="meta-item"><div class="k">Farmer's ID</div>
        <div class="v">${f.id_card
          ? `<span class="mono">${esc(f.id_card.control_no)}</span>
             <span class="small muted">issued ${fmtD(f.id_card.issued_at)} · valid until ${fmtD(f.id_card.valid_until)} · ${f.id_card.reprint_count} reprint(s)</span>`
          : `<span class="muted">Not yet issued</span>`}</div></div>
      <div class="meta-item"><div class="k">First request</div>
        <div class="v">${fmtD(f.first_seen)}</div></div>
      <div class="meta-item"><div class="k">Last request</div>
        <div class="v">${fmtD(f.last_seen)}</div></div>
    </div>
    ${dataRows ? `<table class="table"><tbody>${dataRows}</tbody></table>` : ""}
    <h3 style="margin-top:14px">Request history</h3>
    ${reqRows ? `<div class="table-wrap"><table class="table">
      <thead><tr><th>Reference</th><th>Submitted</th><th>Status</th>
        <th>Certification</th><th>Certificates</th></tr></thead>
      <tbody>${reqRows}</tbody></table></div>`
      : `<div class="empty">No requests yet.</div>`}
    <div class="modal-actions">
      <button class="btn" id="far-close">Close</button>
    </div>`, 740);
  bind("far-close", "click", closeModal);
}


/* ---------------- ID Card Generator (separate database) -------------- */
let idGenOpenRsbsa = "";

async function viewIdGenerator() {
  $app.innerHTML = `
    <div class="page-title">🪪 ID Card Generator</div>
    <p class="page-sub">This generator keeps its <b>own separate database</b>
       (<span class="mono">instance/id_generator.db</span>), independent from
       the certification Farmer Masterlist. Populate it by uploading a CSV
       containing the fields used to generate the ID, or by copying farmers
       from the masterlist, then complete any missing details and generate
       their Farmer's ID.</p>

    <div class="grid-3">
      <div class="card stat-card"><div class="stat-num" id="idg-total">—</div>
        <div class="stat-label">Records in ID database</div></div>
      <div class="card stat-card"><div class="stat-num" id="idg-issued">—</div>
        <div class="stat-label">IDs generated</div></div>
      <div class="card stat-card"><div class="stat-num">CSV</div>
        <div class="stat-label">RSBSA · Name · Gender · Civil Status · Address · Birthdate · Contacts</div></div>
    </div>

    <div class="card" style="margin-top:16px">
      <div class="section-head"><h3>Update the ID database</h3></div>
      <div class="actions" style="flex-wrap:wrap">
        <a class="btn" href="/api/id-generator/template.csv">⬇ CSV Template</a>
        <input type="file" id="idg-csv" accept=".csv,text/csv">
        <button class="btn btn-primary" id="idg-import">Upload CSV</button>
        <button class="btn" id="idg-copy">Copy from Farmer Masterlist</button>
        <button class="btn" id="idg-manage-fcas" type="button">🌾 Manage Affiliated FCAs</button>
      </div>
      <p class="small muted">CSV uploads <b>add new records only</b> — rows whose
         RSBSA Number is already in the ID database are skipped and reported,
         never overwritten. Use the CSV columns needed for ID generation:
         <b>RSBSA Number, Farmer Name, Gender, Civil Status, Address,
         Birthdate, Contact Number, Contact Person in Case of Emergency, and Affiliated FCA</b>
         (Birthdate should be YYYY-MM-DD). Any blank ID detail, and the
         photo, can be completed per person below.</p>
      <div id="idg-import-result"></div>
    </div>

    <div class="card" style="margin-top:16px">
      <div class="section-head"><h3>ID database records</h3></div>
      <form id="idg-filters" class="filters">
        <div class="field" style="max-width:none;flex:1"><label>Search</label>
          <input name="q" placeholder="Name, RSBSA number, or gender"></div>
        <button class="btn btn-primary" type="submit">Search</button>
      </form>
      <div id="idg-results"><div class="loading">Loading…</div></div>
    </div>`;

  async function loadPersons() {
    const q = (new FormData(document.getElementById("idg-filters"))
      .get("q") || "").toString();
    const out = document.getElementById("idg-results");
    try {
      const r = await api(`/api/id-generator/persons?q=${encodeURIComponent(q)}`);
      document.getElementById("idg-total").textContent = r.total;
      document.getElementById("idg-issued").textContent = r.issued;
      const rows = r.persons;
      out.innerHTML = rows.length ? `
        <div class="table-wrap"><table class="table">
          <thead><tr><th>Farmer</th><th>RSBSA No.</th><th>Gender</th>
            <th>Source</th><th>ID Details</th><th>Farmer's ID</th><th></th></tr></thead>
          <tbody>${rows.map((p) => `
            <tr>
              <td><b>${esc(p.name)}</b></td>
              <td class="mono">${esc(p.rsbsa_number)}</td>
              <td>${esc(p.gender || "—")}</td>
              <td><span class="badge ${p.source === "csv" ? "blue" : "neutral"}">${p.source === "csv" ? "CSV upload" : "Masterlist copy"}</span></td>
              <td class="small">${p.gender ? "Gender ✓" : "Gender —"} ·
                  ${p.civil_status ? "Civil status ✓" : "Civil status —"}<br>
                  ${p.address ? "Address ✓" : "Address —"} ·
                  ${p.birthdate ? "Birthdate ✓" : "Birthdate —"}<br>
                  ${p.contact_number ? "Contact ✓" : "Contact —"} ·
                  ${p.emergency_contact ? "Emergency ✓" : "Emergency —"} ·
                  ${p.affiliated_fca ? `FCA: ${esc(p.affiliated_fca)} ✓` : "FCA —"} ·
                  ${p.has_photo ? "Photo ✓" : "Photo —"}</td>
              <td>${p.id_control_no
                ? `<span class="badge blue mono">${esc(p.id_control_no)}</span>
                   <div class="small muted">until ${fmtD(p.id_valid_until)} · ${p.id_reprints} reprint(s)</div>`
                : `<span class="small muted">Not yet generated</span>`}</td>
              <td style="white-space:nowrap">
                <button class="btn btn-sm btn-primary" data-idg="${p.id}">Details &amp; Generate</button>
              </td>
            </tr>`).join("")}</tbody>
        </table></div>` : `<div class="empty">No records yet. Upload a CSV or copy farmers from the masterlist.</div>`;
      out.querySelectorAll("[data-idg]").forEach((btn) =>
        btn.addEventListener("click", () => {
          const p = rows.find((x) => x.id === Number(btn.dataset.idg));
          if (p) idGenPersonModal(p, loadPersons);
        }));
      if (idGenOpenRsbsa) {
        const target = rows.find((x) => x.rsbsa_number === idGenOpenRsbsa);
        idGenOpenRsbsa = "";
        if (target) idGenPersonModal(target, loadPersons);
      }
    } catch (err) {
      out.innerHTML = `<div class="empty">${esc(err.message)}</div>`;
    }
  }

  bind("idg-filters", "submit", (e) => { e.preventDefault(); loadPersons(); });
  bind("idg-import", "click", async () => {
    const file = document.getElementById("idg-csv").files[0];
    if (!file) { toast("Choose a CSV file first.", "err"); return; }
    const btn = document.getElementById("idg-import");
    btn.disabled = true; btn.textContent = "Uploading…";
    try {
      const fd = new FormData();
      fd.append("file", file);
      const r = await api("/api/id-generator/import-csv",
        { method: "POST", form: fd });
      const detail = [
        ...(r.duplicate_rows || []).map((d) =>
          `Row ${d.row}: duplicate RSBSA ${esc(d.rsbsa)} (${esc(d.name)}) — skipped`),
        ...(r.invalid_rows || []).map((d) =>
          `Row ${d.row}: ${esc(d.reason)}`),
      ].slice(0, 12);
      document.getElementById("idg-import-result").innerHTML = `
        <div class="notice" style="margin-top:10px">
          <b>${r.added}</b> record(s) added · <b>${r.duplicates}</b> duplicate(s)
          skipped · <b>${r.invalid}</b> invalid row(s) skipped.
          ${detail.length ? `<div class="small" style="margin-top:6px">${detail.join("<br>")}</div>` : ""}
        </div>`;
      toast(`CSV imported: ${r.added} added, ${r.duplicates} duplicates skipped.`);
      loadPersons();
    } catch (err) { toast(err.message, "err"); }
    btn.disabled = false; btn.textContent = "Upload CSV";
  });
  bind("idg-copy", "click", () => idGenCopyModal(loadPersons));
  bind("idg-manage-fcas", "click", () => {
    adminTab = "fcas";
    location.hash = "#/admin";
  });
  await loadPersons();
}

function idGenCopyModal(onDone) {
  showModal(`
    <h3>Copy farmers from the Masterlist</h3>
    <p class="small muted">Copies the farmer's profile (including civil status,
       address, birthdate, contacts, and photo when present) into the separate
       ID database. Gender is encoded in the ID Generator after copying.
       Farmers already in the ID database are skipped.</p>
    <div class="field"><label>Search masterlist</label>
      <input id="idg-copy-q" placeholder="Name or RSBSA number"></div>
    <div id="idg-copy-list"><div class="loading">Loading…</div></div>
    <div class="modal-actions">
      <button class="btn" id="idg-copy-cancel">Cancel</button>
      <button class="btn btn-primary" id="idg-copy-go">Copy Selected</button>
    </div>`, 680);

  async function renderList() {
    const q = document.getElementById("idg-copy-q").value || "";
    const box = document.getElementById("idg-copy-list");
    try {
      const rows = await api(`/api/id-generator/masterlist-candidates?q=${encodeURIComponent(q)}`);
      box.innerHTML = rows.length ? `
        <div class="table-wrap" style="max-height:320px;overflow:auto">
        <table class="table"><thead><tr><th></th><th>Farmer</th>
          <th>RSBSA No.</th><th>Gender</th><th>Status</th></tr></thead>
        <tbody>${rows.map((f) => `
          <tr>
            <td><input type="checkbox" class="idg-pick" value="${f.farmer_id}"
              ${f.in_id_db || !f.rsbsa_number ? "disabled" : ""}></td>
            <td><b>${esc(f.name)}</b></td>
            <td class="mono">${esc(f.rsbsa_number || "—")}</td>
            <td><span class="small muted">Encode after copy</span></td>
            <td>${f.in_id_db ? '<span class="badge blue">In ID database</span>'
                : !f.rsbsa_number ? '<span class="badge rejected">No RSBSA No.</span>'
                : '<span class="badge approved">Can copy</span>'}</td>
          </tr>`).join("")}</tbody></table></div>`
        : `<div class="empty">No farmers match.</div>`;
    } catch (err) { box.innerHTML = `<div class="empty">${esc(err.message)}</div>`; }
  }
  document.getElementById("idg-copy-q").addEventListener("input", renderList);
  bind("idg-copy-cancel", "click", closeModal);
  bind("idg-copy-go", "click", async () => {
    const ids = [...document.querySelectorAll(".idg-pick:checked")]
      .map((c) => Number(c.value));
    if (!ids.length) { toast("Select at least one farmer.", "err"); return; }
    try {
      const r = await api("/api/id-generator/copy-masterlist",
        { method: "POST", body: { farmer_ids: ids } });
      closeModal();
      toast(`Copied ${r.added_count} farmer(s) into the ID database; ${r.skipped_count} skipped.`);
      if (onDone) onDone();
    } catch (err) { toast(err.message, "err"); }
  });
  renderList();
}

function idGenPersonModal(p, onDone) {
  const hasId = !!p.id_control_no;
  const bust = Date.now();
  const previews = hasId ? `
    <div id="fid-preview">
      <div class="id-preview-grid">
        <figure><img src="/api/id-generator/persons/${p.id}/id-card/front?v=${bust}" alt="ID front">
          <figcaption>Front</figcaption></figure>
        <figure><img src="/api/id-generator/persons/${p.id}/id-card/back?v=${bust}" alt="ID back">
          <figcaption>Back (QR = RSBSA Number)</figcaption></figure>
      </div>
      <div class="actions" style="margin-top:10px">
        <a class="btn btn-primary" href="/api/id-generator/persons/${p.id}/id-card/pdf">⬇ PDF — back-to-back (CR80)</a>
        <a class="btn" href="/api/id-generator/persons/${p.id}/id-card/front">⬇ Front PNG</a>
        <a class="btn" href="/api/id-generator/persons/${p.id}/id-card/back">⬇ Back PNG</a>
      </div>
    </div>` : `<div id="fid-preview"></div>`;
  showModal(`
    <h3>🪪 Farmer's ID — ${esc(p.name)}</h3>
    <p class="small muted">Record from the <b>separate ID Generator database</b>
      (${p.source === "csv" ? "CSV upload" : "copied from masterlist"}).
      Check or complete the ID details here; details supplied by the CSV
      are already filled in, and changes are saved to the ID database for
      one-click reprints. The QR code encodes the RSBSA Number.</p>
    ${hasId ? `<div class="notice">ID <b class="mono">${esc(p.id_control_no)}</b>
      already generated — valid until ${fmtD(p.id_valid_until)}
      (${p.id_reprints || 0} reprint(s)). Generating again is a
      <b>reprint</b> with the same control number.</div>` : ""}
    <div class="meta-grid" style="margin-bottom:12px">
      <div class="meta-item"><div class="k">RSBSA No.</div>
        <div class="v mono">${esc(p.rsbsa_number)}</div></div>
      <div class="meta-item"><div class="k">Gender</div>
        <div class="v">${esc(p.gender || "—")}</div></div>
    </div>
    <form id="idg-form">
      <div class="form-grid">
        <div class="field"><label>Gender</label>
          <select id="idg-gender" class="caps">${_choiceOptionsFor("gender", p.gender || "")}</select></div>
        <div class="field"><label>Civil Status</label>
          <select id="idg-civil" class="caps">${_choiceOptionsFor("civil", p.civil_status || "")}</select></div>
        <div class="field"><label>Birthdate</label>
          <input type="date" id="idg-birthdate" value="${esc(p.birthdate || "")}"></div>
        <div class="field"><label>Contact Number</label>
          <input id="idg-contact" class="caps" value="${esc(p.contact_number || "")}" placeholder="09XX XXX XXXX"></div>
        <div class="field"><label>Contact Person in Case of Emergency (Name — Number)</label>
          <input id="idg-emergency" class="caps" value="${esc(p.emergency_contact || "")}" placeholder="MARIA CRUZ - 0917 123 4567"></div>
        <div class="field full"><label>Address</label>
          <input id="idg-address" class="caps" value="${esc(p.address || "")}" placeholder="PUROK / SITIO, BARANGAY, ALCALA, CAGAYAN"></div>
        <div class="field full">
          <label>Farmer's Affiliated FCA (printed below QR code on the back of the ID)</label>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <input id="idg-fca" class="caps" list="idg-fca-datalist" value="${esc(p.affiliated_fca || "")}"
                   placeholder="Type FCA name or pick a saved FCA →" style="flex:2;min-width:220px">
            <select id="idg-fca-pick" class="caps" style="flex:1;min-width:190px">
              <option value="">— Saved FCAs —</option>
            </select>
          </div>
          <datalist id="idg-fca-datalist"></datalist>
          <div class="help">New FCA names typed here are automatically remembered for future IDs. You can also edit the FCA list under <b>Administration → Affiliated FCAs</b>.</div>
        </div>
      </div>
      <div class="field"><label>ID Photo (JPG/PNG) — Browse, Drag &amp; Drop, or Copy &amp; Paste (Ctrl+V)</label>
        <div class="photo-dropzone" id="idg-photo-drop" tabindex="0">
          ${p.has_photo ? `<img class="id-thumb" src="/api/id-generator/persons/${p.id}/photo?v=${bust}" alt="ID photo">` : `<span class="small muted">No photo yet — the card will show a silhouette.</span>`}
          <img class="id-thumb" id="idg-photo-preview" alt="" style="display:none">
          <div style="flex:1;min-width:200px">
            <div style="font-weight:600;font-size:13px">Drag &amp; drop a photo here, press <b>Ctrl+V</b> to paste an image, or browse:</div>
            <input type="file" id="idg-photo" accept="image/png,image/jpeg,image/webp" style="margin-top:6px">
            <div class="small muted" id="idg-photo-status">Supports JPG, PNG, or pasted clipboard images</div>
          </div>
        </div>
      </div>
      ${hasId ? "" : `<div class="field"><label>Validity</label>
        <select id="idg-years">
          <option value="1">1 year</option><option value="2">2 years</option>
          <option value="3" selected>3 years</option><option value="5">5 years</option>
        </select></div>`}
    </form>
    ${previews}
    <div class="modal-actions">
      <button class="btn" id="idg-close" type="button">Close</button>
      <button class="btn btn-primary" id="idg-go" type="button">${hasId ? "🖨 Reprint ID Card" : "🪪 Generate ID Card"}</button>
    </div>`, 800);
  bind("idg-close", "click", closeModal);
  fetchFcaNames().then((names) => {
    const dl = document.getElementById("idg-fca-datalist");
    const sel = document.getElementById("idg-fca-pick");
    const cur = (p.affiliated_fca || "").toUpperCase();
    if (dl) dl.innerHTML = names.map((n) => `<option value="${esc(n)}"></option>`).join("");
    if (sel) {
      sel.innerHTML = `<option value="">— Saved FCAs (${names.length}) —</option>` +
        names.map((n) => `<option value="${esc(n)}" ${n === cur ? "selected" : ""}>${esc(n)}</option>`).join("");
      sel.addEventListener("change", () => {
        if (sel.value) document.getElementById("idg-fca").value = sel.value;
      });
    }
  });
  const photoHelper = _bindPhotoDropAndPaste({
    dropId: "idg-photo-drop",
    inputId: "idg-photo",
    previewId: "idg-photo-preview",
    statusId: "idg-photo-status",
  });
  bind("idg-go", "click", async () => {
    const btn = document.getElementById("idg-go");
    const body = {
      gender: document.getElementById("idg-gender").value,
      civil_status: document.getElementById("idg-civil").value.trim(),
      address: document.getElementById("idg-address").value.trim(),
      birthdate: document.getElementById("idg-birthdate").value,
      contact_number: document.getElementById("idg-contact").value.trim(),
      emergency_contact: document.getElementById("idg-emergency").value.trim(),
      affiliated_fca: (document.getElementById("idg-fca").value || "").trim().toUpperCase(),
    };
    btn.disabled = true; btn.textContent = "Generating…";
    try {
      await api(`/api/id-generator/persons/${p.id}`, { method: "PUT", body });
      const file = photoHelper.getFile();
      if (file) {
        const fd = new FormData();
        fd.append("photo", file);
        await api(`/api/id-generator/persons/${p.id}/photo`, { method: "POST", form: fd });
      }
      const yearsEl = document.getElementById("idg-years");
      const res = await api(`/api/id-generator/persons/${p.id}/id-card`, {
        method: "POST", body: { valid_years: yearsEl ? Number(yearsEl.value) : 3 } });
      toast(`Farmer's ID ${res.control_no} ${res.reprints ? "reprinted" : "generated"} — valid until ${res.valid_until}.`);
      closeModal();
      if (onDone) onDone();
      const fresh = await api(`/api/id-generator/persons/${p.id}`).catch(() => null);
      if (fresh) idGenPersonModal(fresh, onDone);
    } catch (err) {
      toast(err.message, "err");
      btn.disabled = false;
      btn.textContent = hasId ? "🖨 Reprint ID Card" : "🪪 Generate ID Card";
    }
  });
}


/* ---------------------------- reports ------------------------------ */
async function viewReports() {
  const defaultMonth = new Date().toISOString().slice(0, 7);
  const bgy = ME.role === "admin" ? await api("/api/admin/barangays") : [];
  $app.innerHTML = `
    <div class="page-title">Monthly Accomplishment Report</div>
    <p class="page-sub">Certificates issued per barangay and per certifying
       officer for the month, with the full detail list — ready for
       COA/LGU submission${ME.role === "secretary" ? " (your barangay)" : ""}.</p>
    <div class="card">
      <div class="report-head">
        <div class="field"><label>Month</label>
          <input type="month" id="rep-month" value="${defaultMonth}"></div>
        ${ME.role === "admin" ? `<div class="field"><label>Barangay</label>
          <select id="rep-bgy">
            <option value="">All barangays</option>
            ${bgy.map((b) => `<option value="${b.id}">${esc(b.name)}</option>`).join("")}
          </select></div>` : ""}
        <button class="btn btn-primary" id="rep-preview">Preview</button>
        <a class="btn btn-success" id="rep-pdf" href="#">&#11015; Download PDF</a>
      </div>
      <div id="rep-output">
        <div class="chart-empty">Choose a month, then click Preview.</div>
      </div>
    </div>`;

  function qs() {
    const p = new URLSearchParams({
      month: document.getElementById("rep-month").value,
    });
    const sel = document.getElementById("rep-bgy");
    if (sel && sel.value) p.set("barangay_id", sel.value);
    return p;
  }
  function syncPdf() {
    document.getElementById("rep-pdf").href =
      "/api/reports/accomplishment/pdf?" + qs().toString();
  }

  bind("rep-preview", "click", async () => {
    const out = document.getElementById("rep-output");
    out.innerHTML = `<div class="loading">Generating…</div>`;
    syncPdf();
    try {
      const p = await api("/api/reports/accomplishment?" + qs().toString());
      out.innerHTML = `
        <div class="kpi-row">
          <div class="kpi"><div class="num">${p.totals}</div>
            <div class="lbl">Certificates issued</div></div>
          <div class="kpi"><div class="num">${p.by_barangay.length}</div>
            <div class="lbl">Barangays with issuances</div></div>
          <div class="kpi"><div class="num">${p.by_secretary.length}</div>
            <div class="lbl">Certifying officers</div></div>
        </div>
        <div class="grid-2">
          <div><h3>By barangay</h3>
            <table class="table">
              <thead><tr><th>Barangay</th><th>Certificates</th></tr></thead>
              <tbody>${p.by_barangay.map((b) =>
                `<tr><td>${esc(b.name)}</td><td>${b.count}</td></tr>`).join("")
                || `<tr><td colspan="2" class="empty">None</td></tr>`}</tbody>
            </table></div>
          <div><h3>By certifying officer</h3>
            <table class="table">
              <thead><tr><th>Officer</th><th>Barangay</th><th>Certificates</th></tr></thead>
              <tbody>${p.by_secretary.map((s) =>
                `<tr><td>${esc(s.name)}</td><td>${esc(s.barangay)}</td>
                 <td>${s.count}</td></tr>`).join("")
                || `<tr><td colspan="3" class="empty">None</td></tr>`}</tbody>
            </table></div>
        </div>
        <h3 style="margin-top:16px">Detail — ${p.rows.length} record${p.rows.length === 1 ? "" : "s"}</h3>
        <div class="table-wrap"><table class="table">
          <thead><tr><th>Certificate No.</th><th>Farmer</th><th>Barangay</th>
            <th>Date issued</th><th>Issued by</th></tr></thead>
          <tbody>${p.rows.map((r) => `<tr>
            <td class="mono">${esc(r.cert_no)}</td>
            <td>${esc(r.farmer_name || "—")}</td>
            <td>${esc(r.barangay)}</td>
            <td>${fmtDT(r.generated_at)}</td>
            <td>${esc(r.generator)}</td></tr>`).join("")
            || `<tr><td colspan="5" class="empty">No certificates were issued for this period.</td></tr>`}</tbody>
        </table></div>
        <p class="page-sub">The PDF download contains the full formatted
           report with signature blocks for submission.</p>`;
    } catch (err) {
      out.innerHTML = `<div class="notice warn">${esc(err.message)}</div>`;
    }
  });
  document.getElementById("rep-month").addEventListener("change", syncPdf);
  const sel = document.getElementById("rep-bgy");
  if (sel) sel.addEventListener("change", syncPdf);
  syncPdf();
}

let adminTab = "barangays";

async function viewAdmin() {
  const tabs = [
    ["barangays", "Barangays"],
    ["users", "Secretaries & Accounts"],
    ["fcas", "Affiliated FCAs"],
    ["templates", "Templates"],
    ["settings", "Settings"],
  ];
  $app.innerHTML = `
    <div class="page-title">Administration</div>
    <p class="page-sub">Manage barangays, secretary accounts, Affiliated FCAs,
       certification templates, and office settings.</p>
    <div class="tabs" id="adm-tabs">
      ${tabs.map(([k, l]) => `<button data-tab="${k}"
        class="${adminTab === k ? "active" : ""}">${l}</button>`).join("")}
    </div>
    <div id="adm-body"><div class="loading">Loading…</div></div>`;
  document.querySelectorAll("#adm-tabs button").forEach((b) =>
    b.addEventListener("click", () => { adminTab = b.dataset.tab; viewAdmin(); }));

  if (adminTab === "barangays") return adminBarangays();
  if (adminTab === "users") return adminUsers();
  if (adminTab === "fcas") return adminFcas();
  if (adminTab === "templates") return adminTemplates();
  return adminSettings();
}

async function adminFcas() {
  const body = document.getElementById("adm-body");
  const rows = await api("/api/admin/fcas");
  try { localStorage.setItem(FCA_CACHE_KEY, JSON.stringify(rows.map((r) => r.name))); } catch (_) {}
  body.innerHTML = `
    <div class="card">
      <div class="section-head"><h3>Add an Affiliated FCA</h3></div>
      <p class="page-sub">FCA names added here (or typed when generating a
         Farmer's ID) appear in the Affiliated FCA dropdown/autocomplete and
         are printed below the QR code on the back of the Farmer's ID.</p>
      <form id="fca-add" class="filters">
        <div class="field" style="max-width:440px;flex:1">
          <label>FCA Name</label>
          <input name="name" class="caps" required placeholder="e.g. ALCALA FARMERS COOPERATIVE">
        </div>
        <button class="btn btn-primary" type="submit">Add FCA</button>
      </form>
    </div>
    <div class="card">
      <div class="section-head"><h3>Saved Affiliated FCAs (${rows.length})</h3></div>
      <div class="table-wrap">
        <table class="table">
          <thead><tr><th>FCA Name</th><th>Farmers Affiliated</th><th></th></tr></thead>
          <tbody>${rows.map((r) => `
            <tr>
              <td><b>${esc(r.name)}</b></td>
              <td>${r.members || 0}</td>
              <td style="text-align:right;white-space:nowrap">
                <button class="btn btn-sm" data-fca-edit="${r.id}" data-name="${esc(r.name)}">Edit / Rename</button>
                <button class="btn btn-sm btn-danger" data-fca-del="${r.id}" data-name="${esc(r.name)}">Delete</button>
              </td>
            </tr>`).join("") || ""}</tbody>
        </table>
        ${rows.length ? "" : `<div class="empty">No Affiliated FCAs saved yet. Add one above or type one in the ID Generator.</div>`}
      </div>
    </div>`;
  bind("fca-add", "submit", async (e) => {
    e.preventDefault();
    const name = new FormData(e.target).get("name");
    try {
      await api("/api/admin/fcas", { method: "POST", body: { name } });
      toast("Affiliated FCA added.");
      adminFcas();
    } catch (err) { toast(err.message, "err"); }
  });
  document.querySelectorAll("[data-fca-edit]").forEach((btn) =>
    btn.addEventListener("click", () => {
      const id = btn.dataset.fcaEdit;
      const oldName = btn.dataset.name;
      showModal(`
        <h3>Edit Affiliated FCA</h3>
        <p class="small muted">Renaming an FCA also updates any farmer ID record currently assigned to <b>${esc(oldName)}</b>.</p>
        <div class="field">
          <label>FCA Name *</label>
          <input id="fca-new-name" class="caps" value="${esc(oldName)}">
        </div>
        <div class="modal-actions">
          <button class="btn" id="fca-cancel" type="button">Cancel</button>
          <button class="btn btn-primary" id="fca-save" type="button">Save FCA</button>
        </div>`, 520);
      bind("fca-cancel", "click", closeModal);
      bind("fca-save", "click", async () => {
        const name = (document.getElementById("fca-new-name").value || "").trim().toUpperCase();
        if (!name) { toast("FCA name is required.", "err"); return; }
        try {
          await api(`/api/admin/fcas/${id}`, { method: "PUT", body: { name } });
          closeModal();
          toast("Affiliated FCA updated.");
          adminFcas();
        } catch (err) { toast(err.message, "err"); }
      });
    }));
  document.querySelectorAll("[data-fca-del]").forEach((btn) =>
    btn.addEventListener("click", async () => {
      if (!confirm(`Remove "${btn.dataset.name}" from the saved FCA list?`)) return;
      try {
        await api(`/api/admin/fcas/${btn.dataset.fcaDel}`, { method: "DELETE" });
        toast("Affiliated FCA removed from list.");
        adminFcas();
      } catch (err) { toast(err.message, "err"); }
    }));
}

async function adminBarangays() {
  const body = document.getElementById("adm-body");
  const rows = await api("/api/admin/barangays");
  body.innerHTML = `
    <div class="card">
      <div class="section-head"><h3>Add a barangay</h3></div>
      <form id="bgy-add" class="filters">
        <div class="field" style="max-width:340px">
          <label>Barangay name</label>
          <input name="name" required placeholder="e.g. Baybayog">
        </div>
        <button class="btn btn-primary" type="submit">Add barangay</button>
      </form>
    </div>
    <div class="card">
      <div class="section-head"><h3>Barangays (${rows.length})</h3></div>
      <div class="table-wrap">
        <table class="table">
          <thead><tr><th>Name</th><th>Secretaries</th><th>Requests</th><th></th></tr></thead>
          <tbody>${rows.map((b) => `
            <tr>
              <td><b>${esc(b.name)}</b></td>
              <td>${b.secretaries}</td>
              <td>${b.requests}</td>
              <td style="text-align:right">
                <button class="btn btn-sm btn-danger" data-del="${b.id}"
                  data-name="${esc(b.name)}">Delete</button>
              </td>
            </tr>`).join("") || ""}</tbody>
        </table>
        ${rows.length ? "" : `<div class="empty">No barangays yet.</div>`}
      </div>
    </div>`;
  bind("bgy-add", "submit", async (e) => {
    e.preventDefault();
    try {
      await api("/api/admin/barangays", { method: "POST",
        body: { name: new FormData(e.target).get("name") } });
      toast("Barangay added.");
      adminBarangays();
    } catch (err) { toast(err.message, "err"); }
  });
  document.querySelectorAll("[data-del]").forEach((btn) =>
    btn.addEventListener("click", async () => {
      if (!confirm(`Delete barangay "${btn.dataset.name}"?`)) return;
      try {
        await api(`/api/admin/barangays/${btn.dataset.del}`, { method: "DELETE" });
        toast("Barangay deleted.");
        adminBarangays();
      } catch (err) { toast(err.message, "err"); }
    }));
}

async function adminUsers() {
  const body = document.getElementById("adm-body");
  const [users, bgy] = await Promise.all([
    api("/api/admin/users"), api("/api/admin/barangays")]);
  body.innerHTML = `
    <div class="card">
      <div class="section-head"><h3>Create an account</h3></div>
      <form id="usr-add" class="no-caps">
        <div class="form-grid">
          <div class="field"><label>Full name <span class="req">*</span></label>
            <input name="full_name" class="no-caps" required></div>
          <div class="field"><label>Username <span class="req">*</span></label>
            <input name="username" class="no-caps" required autocomplete="off"></div>
          <div class="field"><label>Password <span class="req">*</span></label>
            <input name="password" class="no-caps" type="password" required minlength="6"
                   autocomplete="new-password"></div>
          <div class="field"><label>Role</label>
            <select name="role" id="usr-role">
              <option value="secretary">Barangay secretary</option>
              <option value="admin">Administrator</option>
            </select></div>
          <div class="field" id="usr-bgy-wrap"><label>Assigned barangay <span class="req">*</span></label>
            <select name="barangay_id">
              ${bgy.map((b) => `<option value="${b.id}">${esc(b.name)}</option>`).join("")}
            </select></div>
        </div>
        <button class="btn btn-primary" type="submit">Create account</button>
      </form>
    </div>
    <div class="card">
      <div class="section-head"><h3>Accounts (${users.length})</h3></div>
      <div class="table-wrap">
        <table class="table">
          <thead><tr><th>Name</th><th>Username</th><th>Role</th>
            <th>Barangay</th><th>Status</th><th></th></tr></thead>
          <tbody>${users.map((u) => `
            <tr>
              <td><b>${esc(u.full_name)}</b></td>
              <td class="mono">${esc(u.username)}</td>
              <td><span class="badge ${u.role === "admin" ? "blue" : "neutral"}">
                  ${u.role === "admin" ? "Admin" : "Secretary"}</span></td>
              <td>${esc(u.barangay || "—")}</td>
              <td>${u.active
                    ? '<span class="badge approved">Active</span>'
                    : '<span class="badge rejected">Disabled</span>'}</td>
              <td style="text-align:right;white-space:nowrap">
                <button class="btn btn-sm" data-pwd="${u.id}"
                  data-name="${esc(u.username)}">Reset password</button>
                <button class="btn btn-sm ${u.active ? "btn-danger" : ""}"
                  data-tog="${u.id}" data-active="${u.active}"
                  data-name="${esc(u.username)}">
                  ${u.active ? "Deactivate" : "Activate"}</button>
              </td>
            </tr>`).join("") || ""}</tbody>
        </table>
        ${users.length ? "" : `<div class="empty">No accounts yet.</div>`}
      </div>
    </div>`;

  const roleSel = document.getElementById("usr-role");
  const bgyWrap = document.getElementById("usr-bgy-wrap");
  roleSel.addEventListener("change", () => {
    bgyWrap.style.display = roleSel.value === "secretary" ? "" : "none";
  });

  bind("usr-add", "submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const role = fd.get("role");
    try {
      await api("/api/admin/users", { method: "POST", body: {
        full_name: fd.get("full_name"), username: fd.get("username"),
        password: fd.get("password"), role,
        barangay_id: role === "secretary" ? Number(fd.get("barangay_id")) : null,
      }});
      toast("Account created.");
      adminUsers();
    } catch (err) { toast(err.message, "err"); }
  });

  document.querySelectorAll("[data-tog]").forEach((btn) =>
    btn.addEventListener("click", async () => {
      try {
        await api(`/api/admin/users/${btn.dataset.tog}`, { method: "PATCH",
          body: { active: btn.dataset.active !== "1" } });
        toast("Account updated.");
        adminUsers();
      } catch (err) { toast(err.message, "err"); }
    }));

  document.querySelectorAll("[data-pwd]").forEach((btn) =>
    btn.addEventListener("click", () => {
      showModal(`
        <h3>Reset password — ${esc(btn.dataset.name)}</h3>
        <div class="field">
          <label>New password <span class="req">*</span></label>
          <input type="password" id="np" minlength="6" autocomplete="new-password">
        </div>
        <div class="modal-actions">
          <button class="btn" id="np-cancel">Cancel</button>
          <button class="btn btn-primary" id="np-go">Save password</button>
        </div>`);
      bind("np-cancel", "click", closeModal);
      bind("np-go", "click", async () => {
        const pw = document.getElementById("np").value;
        if (pw.length < 6) { toast("Password must be at least 6 characters.", "err"); return; }
        try {
          await api(`/api/admin/users/${btn.dataset.pwd}`,
            { method: "PATCH", body: { password: pw } });
          closeModal();
          toast("Password reset.");
        } catch (err) { toast(err.message, "err"); }
      });
    }));
}

async function adminTemplates() {
  const body = document.getElementById("adm-body");
  const tpls = await api("/api/admin/templates");
  body.innerHTML = `
    <div class="card">
      <div class="section-head"><h3>Upload a Word template (.docx)</h3></div>
      <p class="page-sub">Use <code class="ph">{{PLACEHOLDER}}</code> markers in
         your document for every value that should be filled in — e.g.
         <code class="ph">{{FARMER_NAME}}</code>, <code class="ph">{{ADDRESS}}</code>.
         The app detects them automatically and builds the farmer's input form.
         System values (<code class="ph">{{CERT_NO}}</code>,
         <code class="ph">{{DATE_ISSUED}}</code>,
         <code class="ph">{{GENERATED_TIMESTAMP}}</code>,
         <code class="ph">{{SECRETARY_NAME}}</code>,
         <code class="ph">{{BARANGAY}}</code>,
         <code class="ph">{{MUNICIPALITY}}</code>,
         <code class="ph">{{PROVINCE}}</code>,
         <code class="ph">{{OR_NUMBER}}</code>) are filled automatically —
         <code class="ph">{{GENERATED_TIMESTAMP}}</code> stamps the date and
         time of issuance, and <code class="ph">{{OR_NUMBER}}</code> prints a
         blank line for the Treasurer to write the Official Receipt number.</p>
      <form id="tpl-upload" class="filters" enctype="multipart/form-data">
        <div class="field" style="max-width:260px">
          <label>Template name</label>
          <input name="name" placeholder="e.g. Farm Owner Certification">
        </div>
        <div class="field" style="max-width:none;flex:2">
          <label>Word file</label>
          <input type="file" name="file" accept=".docx" required>
        </div>
        <button class="btn btn-primary" type="submit">Upload</button>
      </form>
    </div>
    <div class="card">
      <div class="section-head"><h3>Templates (${tpls.length})</h3></div>
      ${tpls.map((t) => `
        <div style="border:1px solid var(--border);border-radius:10px;
                    padding:14px;margin-bottom:12px">
          <div class="section-head" style="margin-bottom:6px">
            <div>
              <b>${esc(t.name)}</b>
              ${t.active ? '<span class="badge approved">Active</span>'
                         : '<span class="badge rejected">Inactive</span>'}
              <div class="page-sub" style="margin:2px 0 0">
                ${t.fields.length} fields · uploaded by
                ${esc(t.uploader || "system")} · ${fmtD(t.created_at)}</div>
            </div>
            <div style="display:flex;gap:8px">
              <button class="btn btn-sm" data-edit="${t.id}">Edit fields</button>
              <button class="btn btn-sm ${t.active ? "btn-danger" : ""}"
                data-toggle="${t.id}" data-active="${t.active}"
                data-name="${esc(t.name)}">
                ${t.active ? "Deactivate" : "Activate"}</button>
            </div>
          </div>
          <div>${t.fields.map((f) =>
            `<span class="badge ${f.system ? "blue" : "neutral"}"
              style="margin:2px 3px 0 0">${esc(f.key)}</span>`).join("")}</div>
        </div>`).join("") || `<div class="empty">No templates uploaded yet.</div>`}
    </div>`;

  bind("tpl-upload", "submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    if (!fd.get("name")) fd.delete("name");   // server derives a default
    try {
      await api("/api/admin/templates", { method: "POST", form: fd });
      toast("Template uploaded — form fields generated.");
      adminTemplates();
    } catch (err) { toast(err.message, "err"); }
  });

  document.querySelectorAll("[data-toggle]").forEach((btn) =>
    btn.addEventListener("click", async () => {
      try {
        await api(`/api/admin/templates/${btn.dataset.toggle}`,
          { method: "PATCH", body: { active: btn.dataset.active !== "1" } });
        toast("Template updated.");
        adminTemplates();
      } catch (err) { toast(err.message, "err"); }
    }));

  document.querySelectorAll("[data-edit]").forEach((btn) =>
    btn.addEventListener("click", () => {
      const t = tpls.find((x) => x.id === Number(btn.dataset.edit));
      fieldsModal(t, adminTemplates);
    }));
}

function fieldsModal(t, onSaved) {
  const typeSel = (v) => `
    <select data-k="type">
      ${["text", "textarea", "number", "date"].map((x) =>
        `<option value="${x}" ${v === x ? "selected" : ""}>${x}</option>`).join("")}
    </select>`;
  showModal(`
    <h3>Form fields — ${esc(t.name)}</h3>
    <p class="page-sub">Labels appear on the farmer's input form. Mark fields
       as <b>system</b> if they must be filled automatically instead.</p>
    <div class="table-wrap">
      <table class="table">
        <thead><tr><th>Placeholder</th><th>Label</th><th>Type</th>
          <th>Req.</th><th>System</th></tr></thead>
        <tbody>${t.fields.map((f, i) => `
          <tr data-i="${i}">
            <td><code class="ph">${esc(f.key)}</code></td>
            <td><input data-k="label" value="${esc(f.label)}"></td>
            <td>${typeSel(f.type)}</td>
            <td style="text-align:center">
              <input type="checkbox" data-k="required" ${f.required ? "checked" : ""}></td>
            <td style="text-align:center">
              <input type="checkbox" data-k="system" ${f.system ? "checked" : ""}></td>
          </tr>`).join("")}</tbody>
      </table>
    </div>
    <div class="modal-actions">
      <button class="btn" id="fm-cancel">Cancel</button>
      <button class="btn btn-primary" id="fm-save">Save fields</button>
    </div>`, 760);
  bind("fm-cancel", "click", closeModal);
  bind("fm-save", "click", async () => {
    const fields = [];
    document.querySelectorAll(".modal tbody tr").forEach((tr) => {
      const orig = t.fields[Number(tr.dataset.i)];
      fields.push({
        key: orig.key,
        label: tr.querySelector('[data-k="label"]').value || orig.key,
        type: tr.querySelector('[data-k="type"]').value,
        required: tr.querySelector('[data-k="required"]').checked,
        system: tr.querySelector('[data-k="system"]').checked,
        help: orig.help || "",
      });
    });
    try {
      await api(`/api/admin/templates/${t.id}`, { method: "PATCH", body: { fields } });
      closeModal();
      toast("Fields saved.");
      if (onSaved) onSaved();
    } catch (err) { toast(err.message, "err"); }
  });
}

async function adminSettings() {
  const body = document.getElementById("adm-body");
  const s = await api("/api/admin/settings");
  body.innerHTML = `
    <div class="card" style="max-width:640px">
      <h3>Office settings</h3>
      <form id="set-form">
        <div class="field">
          <label>Municipality / City</label>
          <input name="municipality" value="${esc(s.municipality)}"
                 placeholder="e.g. Alcala">
          <div class="help">Fills <code class="ph">{{MUNICIPALITY}}</code></div>
        </div>
        <div class="field">
          <label>Province</label>
          <input name="province" value="${esc(s.province)}"
                 placeholder="e.g. Cagayan">
          <div class="help">Fills <code class="ph">{{PROVINCE}}</code></div>
        </div>
        <div class="field">
          <label>Certificate number prefix</label>
          <input name="cert_prefix" value="${esc(s.cert_prefix)}" required>
          <div class="help">Certificate numbers look like
             <code class="ph">${esc(s.cert_prefix)}-2026-0001</code></div>
        </div>
        <button class="btn btn-primary" type="submit">Save settings</button>
      </form>
    </div>
    <div class="card" style="max-width:640px;margin-top:18px">
      <h3>\u{1F4BE} Backup &amp; Restore (one-click)</h3>
      <p class="page-sub">A backup is one <b>.zip</b> containing the complete
         database plus every template, filed certificate PDF, farmer ID
         photo and generated Farmer's ID card. Download it regularly and
         keep it somewhere safe \u2014 it contains personal data and account
         password hashes.</p>
      <p><a class="btn btn-primary" href="/api/admin/backup/download">\u2B07 Download Full Backup (.zip)</a></p>
      <hr style="border:none;border-top:1px solid var(--border);margin:16px 0">
      <div class="field">
        <label>Restore from a backup .zip</label>
        <input type="file" id="bk-file" accept=".zip,application/zip">
        <div class="help">Restoring <b>replaces the current database and files</b>.
           The system first saves a <code class="ph">pre-restore</code> safety
           backup on the server, validates the backup, and records the
           restore in the audit trail. You will be signed out afterwards.</div>
      </div>
      <button class="btn btn-danger" id="bk-restore">Restore Backup</button>
    </div>
    <div class="card" style="max-width:640px;margin-top:18px">
      <h3>\u{1F4F6} Offline Mode (PWA)</h3>
      <p class="page-sub">The system installs as an app and keeps working
         without internet: already-opened pages stay readable, and farmer
         submissions, Farmer Data Entry, corrections, approvals and
         rejections are saved on the device and sync automatically when
         the connection returns. Use the <b>connection pill</b> at the top
         of the screen to see what is waiting to sync.</p>
      <button class="btn" id="bk-offline">Open Offline &amp; Sync Panel</button>
    </div>`;
  bind("bk-offline", "click", offlineModal);
  bind("bk-restore", "click", () => {
    const f = document.getElementById("bk-file").files[0];
    if (!f) { toast("Choose a backup .zip file first.", "err"); return; }
    confirmModal("Restore this backup?",
      `This will <b>replace the entire current database and files</b> with
       <b>${esc(f.name)}</b>. A pre-restore safety backup is saved on the
       server first, and the restore is written to the audit trail.`,
      "Restore Backup", async () => {
        const fd = new FormData();
        fd.append("file", f);
        try {
          const r = await api("/api/admin/restore", { method: "POST", form: fd });
          ME = null;
          renderNav();
          location.hash = "#/login";
          toast(`Backup restored (safety copy: ${r.safety_backup}). Please sign in again.`);
        } catch (err) { toast(err.message, "err"); }
      }, true);
  });
  bind("set-form", "submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await api("/api/admin/settings", { method: "PUT", body: {
        municipality: fd.get("municipality"),
        province: fd.get("province"),
        cert_prefix: fd.get("cert_prefix"),
      }});
      toast("Settings saved.");
    } catch (err) { toast(err.message, "err"); }
  });
}

/* ================================ boot =============================== */
if ("serviceWorker" in navigator && /^https?:$/.test(location.protocol)) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}
(async function boot() {
  bind("net-pill", "click", offlineModal);
  renderNetStatus();
  try {
    const b = await api("/api/auth/me");
    ME = b.me;
    NEEDS_SETUP = b.needs_setup;
    saveMeSnapshot();
  } catch (_) {
    // Offline (or server unreachable): fall back to the identity saved on
    // this device so already-cached pages keep working. Server actions
    // still wait in the outbox until a real connection returns.
    if (!navigator.onLine) ME = loadMeSnapshot();
  }
  renderNav();
  renderNetStatus();
  if (ME) syncOutbox(false);
  await route();
})();
