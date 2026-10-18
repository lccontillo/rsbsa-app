"use strict";

/* ============================ core helpers ============================ */
const $app = document.getElementById("app");
const $navLinks = document.getElementById("nav-links");
const $navUser = document.getElementById("nav-user");
const $modalRoot = document.getElementById("modal-root");
const $toastWrap = document.getElementById("toast-wrap");
const $sidebar = document.getElementById("sidebar");
const $sidebarNav = document.getElementById("sidebar-nav");
const $sidebarToggle = document.getElementById("sidebar-toggle");
const $sidebarClose = document.getElementById("sidebar-close");
const $sidebarBackdrop = document.getElementById("sidebar-backdrop");

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
const CROP_OPTIONS = ["RICE/PALAY", "CORN", "HIGH-VALUE CROPS", "TOBACCO"];
const FARMER_REMARKS_OPTIONS = [
  "Active", "Deceased", "No Farm", "OFW",
  "Working in other Province", "Severely Sick", "Bedridden"
];

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
  if (kind === "crop") {
    if (cur.includes("RICE") || cur.includes("PALAY")) return "RICE/PALAY";
    if (cur.includes("CORN") || cur.includes("MAIS")) return "CORN";
    if (cur.includes("HIGH") || cur.includes("HVC") || cur.includes("VEGETABLE")) return "HIGH-VALUE CROPS";
    if (cur.includes("TOBACCO") || cur.includes("TABAKO")) return "TOBACCO";
    return cur;
  }
  return cur;
}

function _choiceKind(key) {
  const k = _choiceValue(key);
  if (["GENDER", "SEX", "KASARIAN"].includes(k)) return "gender";
  if (k === "CIVIL_STATUS" || k.includes("CIVIL")) return "civil";
  if (k === "CROP" || k.includes("COMMODITY") || k.includes("PANANIM") || k.includes("CROPS")) return "crop";
  return "";
}

function _choiceOptionsFor(kind, current) {
  let options = GENDER_OPTIONS;
  if (kind === "civil") options = CIVIL_STATUS_OPTIONS;
  else if (kind === "crop") options = CROP_OPTIONS;
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

async function copyToClipboard(text, successMsg = "Copied to clipboard!") {
  if (!text) return false;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    toast(successMsg);
    return true;
  } catch (err) {
    toast("Failed to copy to clipboard", "err");
    return false;
  }
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

async function fetchOfficeInfo() {
  try {
    const s = await api("/api/office-info");
    const parts = [s.municipality, s.province].filter(Boolean);
    const txt = parts.join(", ");
    const el = document.getElementById("brand-location");
    if (el) el.textContent = txt;
    const elSide = document.getElementById("sidebar-location");
    if (elSide) elSide.textContent = txt;
  } catch (_) {}
}

let _heartbeatTimer = null;
let _ws = null;
let _wsOnlineUserIds = new Set();
let _onWsMessageListeners = [];

function addWsListener(fn) {
  _onWsMessageListeners.push(fn);
  return () => {
    _onWsMessageListeners = _onWsMessageListeners.filter((f) => f !== fn);
  };
}

function initWebSocket() {
  if (!ME) {
    if (_ws) { try { _ws.close(); } catch (_) {} _ws = null; }
    return;
  }
  if (_ws && (_ws.readyState === WebSocket.OPEN || _ws.readyState === WebSocket.CONNECTING)) {
    return;
  }
  try {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${proto}//${location.host}/ws/chat`;
    _ws = new WebSocket(wsUrl);

    _ws.onopen = () => {
      // connected, ping to keep alive
    };

    _ws.onmessage = (evt) => {
      try {
        const data = JSON.parse(evt.data);
        if (data.type === "connected" || data.type === "presence") {
          if (Array.isArray(data.online_user_ids)) {
            _wsOnlineUserIds = new Set(data.online_user_ids.map(Number));
          }
        } else if (data.type === "new_message") {
          // If message is directed to me or is broadcast from someone else, update unread count
          if (data.message && (data.message.recipient_id === ME.id || (data.message.is_broadcast && data.message.sender_id !== ME.id))) {
            const badge = document.getElementById("msg-badge");
            if (badge) {
              const cur = parseInt(badge.textContent || "0", 10) || 0;
              badge.textContent = cur + 1;
              badge.style.display = "inline-block";
            }
          }
        }
        _onWsMessageListeners.forEach((fn) => {
          try { fn(data); } catch (_) {}
        });
      } catch (_) {}
    };

    _ws.onclose = () => {
      _ws = null;
      // Reconnect after 3 seconds if user is still logged in
      if (ME) setTimeout(initWebSocket, 3000);
    };

    _ws.onerror = () => {
      try { _ws.close(); } catch (_) {}
    };
  } catch (_) {}
}

function startHeartbeat() {
  if (_heartbeatTimer) clearInterval(_heartbeatTimer);
  initWebSocket();
  const tick = async () => {
    if (!ME) return;
    try {
      if (_ws && _ws.readyState === WebSocket.OPEN) {
        _ws.send(JSON.stringify({ type: "ping" }));
      } else {
        initWebSocket();
      }
      await api("/api/heartbeat", { method: "POST" });
      const { unread } = await api("/api/messages/unread-count");
      const badge = document.getElementById("msg-badge");
      if (badge) {
        if (unread > 0) {
          badge.textContent = unread;
          badge.style.display = "inline-block";
        } else {
          badge.style.display = "none";
        }
      }
    } catch (_) {}
  };
  tick();
  _heartbeatTimer = setInterval(tick, 15000);
}

function changePasswordModal(mandatory = false) {
  showModal(`
    <h3>${mandatory ? "Welcome! Please change your password" : "Change Password"}</h3>
    <p class="page-sub">${mandatory ? "For account security, you must choose a new password on your first login." : "Update your account password below."}</p>
    <form id="chpass-form">
      <div class="field">
        <label>Current Password <span class="req">*</span></label>
        <input type="password" id="cur-pass" required autocomplete="current-password">
      </div>
      <div class="field">
        <label>New Password (min. 6 characters) <span class="req">*</span></label>
        <input type="password" id="new-pass" required minlength="6" autocomplete="new-password">
      </div>
      <div class="field">
        <label>Confirm New Password <span class="req">*</span></label>
        <input type="password" id="confirm-pass" required minlength="6" autocomplete="new-password">
      </div>
      <div class="modal-actions">
        ${mandatory ? "" : `<button type="button" class="btn" id="chpass-cancel">Cancel</button>`}
        <button type="submit" class="btn btn-primary">Update Password</button>
      </div>
    </form>
  `, 450);

  if (!mandatory) {
    bind("chpass-cancel", "click", closeModal);
  }

  bind("chpass-form", "submit", async (e) => {
    e.preventDefault();
    const cur = document.getElementById("cur-pass").value;
    const n = document.getElementById("new-pass").value;
    const c = document.getElementById("confirm-pass").value;
    if (n !== c) {
      toast("New passwords do not match.", "err");
      return;
    }
    if (n.length < 6) {
      toast("Password must be at least 6 characters.", "err");
      return;
    }
    try {
      await api("/api/auth/change-password", {
        method: "POST",
        body: { current_password: cur, new_password: n }
      });
      if (ME) ME.must_change_password = false;
      closeModal();
      toast("Password successfully changed!");
    } catch (err) {
      toast(err.message, "err");
    }
  });
}

async function openMessengerModal() {
  const isAdmin = ME && ME.role === "admin";
  let activeTab = isAdmin ? "active" : "direct";
  let activeSecId = null;

  async function renderMessenger() {
    showModal(`
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
        <h3 style="margin:0">💬 Internal Messenger</h3>
        <button class="btn btn-sm" id="msg-close">✕ Close</button>
      </div>
      <div class="entry-chips" style="margin-bottom:14px">
        ${isAdmin ? `<button type="button" class="entry-chip ${activeTab === "active" ? "active" : ""}" id="mtab-active">🟢 Active Secretaries</button>` : ""}
        <button type="button" class="entry-chip ${activeTab === "direct" ? "active" : ""}" id="mtab-direct">${isAdmin ? "💬 Direct Messages" : "💬 Message Admin"}</button>
        <button type="button" class="entry-chip ${activeTab === "broadcast" ? "active" : ""}" id="mtab-broadcast">📢 Announcements</button>
      </div>
      <div id="msg-body" style="min-height:300px;max-height:450px;display:flex;flex-direction:column"></div>
    `, 700);

    bind("msg-close", "click", closeModal);
    if (isAdmin) {
      bind("mtab-active", "click", () => { activeTab = "active"; loadTab(); });
    }
    bind("mtab-direct", "click", () => { activeTab = "direct"; loadTab(); });
    bind("mtab-broadcast", "click", () => { activeTab = "broadcast"; loadTab(); });

    async function loadTab() {
      const bodyEl = document.getElementById("msg-body");
      if (!bodyEl) return;
      if (activeTab === "active" && isAdmin) {
        bodyEl.innerHTML = `<div class="loading">Fetching active secretaries...</div>`;
        try {
          const sRes = await api("/api/admin/active-secretaries");
          const secs = Array.isArray(sRes) ? sRes : (sRes && sRes.secretaries ? sRes.secretaries : []);
          bodyEl.innerHTML = `
            <p class="page-sub" style="margin-top:0">Secretaries active within the last 5 minutes are marked Online.</p>
            <div class="table-wrap">
              <table class="table">
                <thead><tr><th>Status</th><th>Secretary Name</th><th>Barangay</th><th>Last Active</th><th>Action</th></tr></thead>
                <tbody>
                  ${secs.map((s) => `
                    <tr>
                      <td>${s.is_online ? `<span class="badge approved">🟢 Online</span>` : `<span class="badge neutral">Offline</span>`}</td>
                      <td><b>${esc(s.full_name)}</b> <span class="small muted">(@${esc(s.username)})</span></td>
                      <td>${esc(s.barangay || "—")}</td>
                      <td class="small muted">${s.last_active_at ? fmtDT(s.last_active_at) : "Never"}</td>
                      <td><button class="btn btn-sm btn-primary" data-chat-sec="${s.id}">Chat</button></td>
                    </tr>
                  `).join("") || `<tr><td colspan="5" class="empty">No secretary accounts registered.</td></tr>`}
                </tbody>
              </table>
            </div>
          `;
          bodyEl.querySelectorAll("[data-chat-sec]").forEach((btn) => {
            btn.addEventListener("click", () => {
              activeSecId = Number(btn.dataset.chatSec);
              activeTab = "direct";
              loadTab();
            });
          });
        } catch (err) { bodyEl.innerHTML = `<div class="notice warn">${esc(err.message)}</div>`; }
      } else if (activeTab === "direct") {
        bodyEl.innerHTML = `<div class="loading">Loading conversation...</div>`;
        try {
          let url = "/api/messages";
          let secs = [];
          if (isAdmin) {
            const sRes = await api("/api/admin/active-secretaries");
            secs = Array.isArray(sRes) ? sRes : (sRes && sRes.secretaries ? sRes.secretaries : []);
            if (!activeSecId && secs.length) activeSecId = secs[0].id;
            url += `?partner_id=${activeSecId || ""}`;
          }
          const mRes = await api(url);
          const msgs = Array.isArray(mRes) ? mRes : (mRes.messages || []);
          const unreadIds = msgs.filter((m) => m.recipient_id === ME.id).map((m) => m.id);
          if (unreadIds.length || !isAdmin) {
            api("/api/messages/mark-read", {
              method: "POST",
              body: { message_ids: unreadIds, partner_id: isAdmin ? activeSecId : (mRes.partner_id || null) }
            }).then(() => {
              api("/api/messages/unread-count").then(({ unread }) => {
                const b = document.getElementById("msg-badge");
                if (b) {
                  if (unread > 0) { b.textContent = unread; b.style.display = "inline-block"; }
                  else { b.style.display = "none"; }
                }
              }).catch(() => {});
            }).catch(() => {});
          }

          let secSelector = "";
          if (isAdmin && secs.length) {
            secSelector = `
              <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
                <label style="font-weight:600">Secretary:</label>
                <select id="chat-sec-select" style="flex:1">
                  ${secs.map((s) => `<option value="${s.id}" ${s.id === activeSecId ? "selected" : ""}>${s.is_online ? "🟢 " : ""}${esc(s.full_name)} (${esc(s.barangay || "No Brgy")})</option>`).join("")}
                </select>
              </div>
            `;
          }

          bodyEl.innerHTML = `
            ${secSelector}
            <div id="chat-stream" style="flex:1;overflow-y:auto;border:1px solid #ddd;border-radius:6px;padding:12px;background:#f9f9f9;margin-bottom:10px;min-height:200px;max-height:260px">
              ${msgs.filter((m) => !m.is_broadcast).map((m) => {
                const isMine = m.sender_id === ME.id;
                return `
                  <div style="display:flex;flex-direction:column;align-items:${isMine ? "flex-end" : "flex-start"};margin-bottom:10px">
                    <div style="font-size:11px;color:#777;margin-bottom:2px">${esc(m.sender_name)} · ${fmtDT(m.sent_at || m.created_at)}</div>
                    <div style="max-width:75%;padding:8px 12px;border-radius:12px;background:${isMine ? "#0f4c81" : "#e2e8f0"};color:${isMine ? "#fff" : "#1a202c"};font-size:13px;word-break:break-word">
                      ${esc(m.message || m.content || "")}
                    </div>
                  </div>
                `;
              }).join("") || `<div class="empty">No messages yet. Send a message below!</div>`}
            </div>
            <form id="chat-send-form" style="display:flex;gap:8px">
              <input type="text" id="chat-input" class="no-caps" placeholder="Type a message..." required style="flex:1">
              <button type="submit" class="btn btn-primary">Send</button>
            </form>
          `;

          const stream = document.getElementById("chat-stream");
          if (stream) stream.scrollTop = stream.scrollHeight;

          const sel = document.getElementById("chat-sec-select");
          if (sel) {
            sel.addEventListener("change", () => {
              activeSecId = Number(sel.value);
              loadTab();
            });
          }

          bind("chat-send-form", "submit", async (e) => {
            e.preventDefault();
            const input = document.getElementById("chat-input");
            const txt = input.value.trim();
            if (!txt) return;
            try {
              await api("/api/messages", {
                method: "POST",
                body: {
                  message: txt,
                  content: txt,
                  recipient_id: isAdmin ? activeSecId : null,
                  is_broadcast: false,
                }
              });
              input.value = "";
              loadTab();
            } catch (err) { toast(err.message, "err"); }
          });
        } catch (err) { bodyEl.innerHTML = `<div class="notice warn">${esc(err.message)}</div>`; }
      } else if (activeTab === "broadcast") {
        bodyEl.innerHTML = `<div class="loading">Loading announcements...</div>`;
        try {
          const bRes = await api("/api/messages?broadcast_only=1");
          const msgs = Array.isArray(bRes) ? bRes : (bRes.messages || []);
          api("/api/messages/mark-read", { method: "POST", body: { is_broadcast: true } })
            .then(() => {
              api("/api/messages/unread-count").then(({ unread }) => {
                const b = document.getElementById("msg-badge");
                if (b) {
                  if (unread > 0) { b.textContent = unread; b.style.display = "inline-block"; }
                  else { b.style.display = "none"; }
                }
              }).catch(() => {});
            }).catch(() => {});
          bodyEl.innerHTML = `
            ${isAdmin ? `
              <form id="bc-send-form" style="display:flex;gap:8px;margin-bottom:14px">
                <input type="text" id="bc-input" class="no-caps" placeholder="Post group announcement to all users..." required style="flex:1">
                <button type="submit" class="btn btn-primary">📢 Broadcast</button>
              </form>
            ` : ""}
            <div id="bc-stream" style="flex:1;overflow-y:auto;border:1px solid #ddd;border-radius:6px;padding:12px;background:#f9f9f9;min-height:220px;max-height:300px">
              ${msgs.filter((m) => m.is_broadcast).map((m) => `
                <div style="background:#fff;border-left:4px solid #0f4c81;border-radius:4px;padding:10px;margin-bottom:10px;box-shadow:0 1px 3px rgba(0,0,0,0.06);position:relative">
                  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
                    <b>📢 ${esc(m.sender_name)} (${esc((m.sender_role || "ADMIN").toUpperCase())})</b>
                    <div style="display:flex;align-items:center;gap:8px">
                      <span class="small muted">${fmtDT(m.sent_at || m.created_at)}</span>
                      ${isAdmin ? `<button class="btn btn-sm btn-danger" data-bc-del="${m.id}" style="padding:1px 6px;font-size:11px" title="Delete announcement">🗑 Delete</button>` : ""}
                    </div>
                  </div>
                  <div style="font-size:13px;color:#2d3748">${esc(m.message || m.content || "")}</div>
                </div>
              `).join("") || `<div class="empty">No group announcements posted yet.</div>`}
            </div>
          `;
          if (isAdmin) {
            bodyEl.querySelectorAll("[data-bc-del]").forEach((btn) => {
              btn.addEventListener("click", () => {
                const mid = Number(btn.dataset.bcDel);
                confirmModal("Delete Announcement", "Are you sure you want to delete this announcement? It will be removed for all users.", "Delete", async () => {
                  try {
                    await api(`/api/messages/${mid}`, { method: "DELETE" });
                    toast("Announcement deleted.");
                    loadTab();
                  } catch (err) { toast(err.message, "err"); }
                }, true);
              });
            });

            bind("bc-send-form", "submit", async (e) => {
              e.preventDefault();
              const inp = document.getElementById("bc-input");
              const txt = inp.value.trim();
              if (!txt) return;
              try {
                await api("/api/messages", {
                  method: "POST",
                  body: { message: txt, content: txt, is_broadcast: true }
                });
                inp.value = "";
                toast("Announcement broadcasted to all users.");
                loadTab();
              } catch (err) { toast(err.message, "err"); }
            });
          }
        } catch (err) { bodyEl.innerHTML = `<div class="notice warn">${esc(err.message)}</div>`; }
      }
    }

    let removeWs = null;

    function handleWsEvent(evt) {
      if (!evt) return;
      if (evt.type === "presence" || evt.type === "connected") {
        if (activeTab === "active" && isAdmin) {
          // Refresh active secretaries list live
          loadTab();
        } else if (activeTab === "direct" && isAdmin) {
          const sel = document.getElementById("chat-sec-select");
          if (sel) {
            Array.from(sel.options).forEach((opt) => {
              const sid = Number(opt.value);
              const isOnline = _wsOnlineUserIds.has(sid);
              const baseText = opt.textContent.replace(/^🟢\s*/, "");
              opt.textContent = (isOnline ? "🟢 " : "") + baseText;
            });
          }
        }
      } else if (evt.type === "new_message" && evt.message) {
        const m = evt.message;
        if (m.is_broadcast && activeTab === "broadcast") {
          loadTab();
        } else if (!m.is_broadcast && activeTab === "direct") {
          const isMine = m.sender_id === ME.id;
          const isPartner = isAdmin ? (m.sender_id === activeSecId || m.recipient_id === activeSecId) : true;
          if (isPartner) {
            const stream = document.getElementById("chat-stream");
            if (stream) {
              const empty = stream.querySelector(".empty");
              if (empty) empty.remove();
              const msgHtml = `
                <div style="display:flex;flex-direction:column;align-items:${isMine ? "flex-end" : "flex-start"};margin-bottom:10px">
                  <div style="font-size:11px;color:#777;margin-bottom:2px">${esc(m.sender_name)} · ${fmtDT(m.sent_at || m.created_at)}</div>
                  <div style="max-width:75%;padding:8px 12px;border-radius:12px;background:${isMine ? "#0f4c81" : "#e2e8f0"};color:${isMine ? "#fff" : "#1a202c"};font-size:13px;word-break:break-word">
                    ${esc(m.message || m.content || "")}
                  </div>
                </div>
              `;
              stream.insertAdjacentHTML("beforeend", msgHtml);
              stream.scrollTop = stream.scrollHeight;
            }
            if (!isMine) {
              api("/api/messages/mark-read", { method: "POST", body: { message_ids: [m.id], partner_id: m.sender_id } }).catch(() => {});
            }
          }
        }
      } else if (evt.type === "delete_message" && activeTab === "broadcast") {
        loadTab();
      }
    }

    removeWs = addWsListener(handleWsEvent);
    const origClose = closeModal;
    const modalCloseBtn = document.getElementById("msg-close");
    if (modalCloseBtn) {
      modalCloseBtn.addEventListener("click", () => {
        if (removeWs) removeWs();
      });
    }

    loadTab();
  }

  await renderMessenger();
}

/* ============================== navigation ============================ */
const SIDEBAR_COLLAPSED_KEY = "rsbsa_sidebar_collapsed_v1";

function setupSidebarEvents() {
  if (setupSidebarEvents._initialized) return;
  setupSidebarEvents._initialized = true;

  if (localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1" && window.innerWidth > 992) {
    document.body.classList.add("sidebar-collapsed");
  }

  if ($sidebarToggle) {
    $sidebarToggle.addEventListener("click", () => {
      if (window.innerWidth <= 992) {
        document.body.classList.toggle("sidebar-open");
      } else {
        document.body.classList.toggle("sidebar-collapsed");
        try {
          localStorage.setItem(SIDEBAR_COLLAPSED_KEY,
            document.body.classList.contains("sidebar-collapsed") ? "1" : "0");
        } catch (_) {}
      }
    });
  }

  if ($sidebarClose) {
    $sidebarClose.addEventListener("click", () => {
      document.body.classList.remove("sidebar-open");
    });
  }

  if ($sidebarBackdrop) {
    $sidebarBackdrop.addEventListener("click", () => {
      document.body.classList.remove("sidebar-open");
    });
  }
}

function updateNavActive() {
  const h = (location.hash || "#/").slice(1) || "/";
  document.querySelectorAll(".side-link").forEach((a) => {
    const href = (a.getAttribute("href") || "").replace(/^#/, "");
    if (href === h) {
      a.classList.add("active");
    } else {
      a.classList.remove("active");
    }
  });
  document.querySelectorAll(".nav-links a").forEach((a) => {
    const href = (a.getAttribute("href") || "").replace(/^#/, "");
    if (href === h) {
      a.classList.add("active");
    } else {
      a.classList.remove("active");
    }
  });
}

function renderNav() {
  setupSidebarEvents();
  fetchOfficeInfo();
  const h = (location.hash || "#/").slice(1) || "/";
  const link = (href, label) =>
    `<a href="#${href}" class="${h === href ? "active" : ""}">${label}</a>`;

  if (ME) {
    document.body.classList.add("has-user");
    document.body.classList.remove("not-logged-in");

    const navGroups = [
      {
        heading: "MAIN MENU",
        items: [
          {
            href: "/dashboard",
            label: "Dashboard",
            icon: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="9"></rect><rect x="14" y="3" width="7" height="5"></rect><rect x="14" y="12" width="7" height="9"></rect><rect x="3" y="16" width="7" height="5"></rect></svg>`,
          },
          {
            href: "/archive",
            label: "Archive",
            icon: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="21 8 21 21 3 21 3 8"></polyline><rect x="1" y="3" width="22" height="5"></rect><line x1="10" y1="12" x2="14" y2="12"></line></svg>`,
          },
          {
            href: "/farmers",
            label: "Farmers",
            icon: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M23 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path></svg>`,
          },
          {
            href: "/reports",
            label: "Reports",
            icon: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="20" x2="18" y2="10"></line><line x1="12" y1="20" x2="12" y2="4"></line><line x1="6" y1="20" x2="6" y2="14"></line></svg>`,
          },
          {
            href: "/audit",
            label: "Audit Trail",
            icon: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line></svg>`,
          },
        ],
      },
    ];

    if (ME.role === "admin") {
      navGroups.push({
        heading: "MANAGEMENT",
        items: [
          {
            href: "/id-generator",
            label: "ID Generator",
            icon: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"></rect><line x1="2" y1="10" x2="22" y2="10"></line><circle cx="7" cy="15" r="1.5"></circle><line x1="12" y1="15" x2="18" y2="15"></line></svg>`,
          },
          {
            href: "/admin",
            label: "Administration",
            icon: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>`,
          },
        ],
      });
    }

    let sideHtml = "";
    for (const group of navGroups) {
      sideHtml += `<div class="side-nav-heading">${group.heading}</div>`;
      for (const it of group.items) {
        const active = h === it.href;
        sideHtml += `
          <a href="#${it.href}" class="side-link ${active ? "active" : ""}">
            <span class="side-link-icon">${it.icon}</span>
            <span class="side-link-label">${it.label}</span>
          </a>`;
      }
    }

    if ($sidebarNav) {
      $sidebarNav.innerHTML = sideHtml;
      $sidebarNav.querySelectorAll(".side-link").forEach((a) => {
        a.addEventListener("click", () => {
          if (window.innerWidth <= 992) {
            document.body.classList.remove("sidebar-open");
          }
        });
      });
    }

    $navLinks.innerHTML = "";
    $navUser.innerHTML = `
      <div class="who">
        <div class="name">${esc(ME.full_name)}</div>
        <div class="role">${ME.role === "admin" ? "Administrator" : "Secretary"}
          ${ME.barangay ? "· " + esc(ME.barangay) : ""}</div>
      </div>
      <button class="btn-logout" id="btn-messages" title="Internal Messages and Announcements" style="position:relative">💬 Messages <span id="msg-badge" style="display:none;background:#e53e3e;color:#fff;border-radius:10px;padding:1px 6px;font-size:11px;font-weight:700"></span></button>
      <button class="btn-logout" id="btn-chpass" title="Change your account password">🔑 Password</button>
      <button class="btn-logout" id="btn-logout">Sign out</button>`;
    bind("btn-messages", "click", openMessengerModal);
    bind("btn-chpass", "click", () => changePasswordModal(false));
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
    startHeartbeat();
    if (ME.must_change_password) {
      setTimeout(() => changePasswordModal(true), 300);
    }
  } else {
    document.body.classList.remove("has-user", "sidebar-open", "sidebar-collapsed");
    document.body.classList.add("not-logged-in");
    if ($sidebarNav) $sidebarNav.innerHTML = "";
    $navLinks.innerHTML = link("/", "Home") + link("/track", "Track Request");
    $navUser.innerHTML = `<button class="btn-logout" onclick="location.hash='#/login'">LOG IN</button>`;
  }
}

/* ================================ router ============================== */
window.addEventListener("hashchange", route);

async function route() {
  updateNavActive();
  document.body.classList.remove("sidebar-open");
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
    </div>`;
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
    <p>${notYet ? "NOT YET RSBSA REGISTERED — no farmer record was found in the database." : "No farmer record was found for this RSBSA number."}
       The saved profile will be used to pre-fill this and future requests.
       (Walang nakitang rekord ng magsasaka para sa RSBSA number na ito.
       Ang na-save na profile ay gagamitin sa kahilingang ito at sa mga susunod.)</p>
    <p class="small muted">${esc(ruleText)}</p>
    <div class="form-grid">
      <div class="field"><label>RSBSA Number (Numero ng RSBSA)${star}</label>
        <input type="text" id="fe-rsbsa" class="caps" placeholder="e.g. 02-015-02-014-EFMN47" value="${esc(rsbsa)}"></div>
      ${bgyField}
      <div class="field"><label>Farmer Name (Pangalan ng Magsasaka) *</label>
        <input type="text" id="fe-name" class="caps" placeholder="e.g. JUAN DELA CRUZ"></div>
      <div class="field"><label>Civil Status (Katayuang Sibil)${star}</label>
        <select id="fe-civil" class="caps">${_choiceOptionsFor("civil", "")}</select></div>
      <div class="field"><label>Gender (Kasarian)</label>
        <select id="fe-gender" class="caps">${_choiceOptionsFor("gender", "")}</select></div>
      <div class="field"><label>Birthdate (Araw ng Kapanganakan)</label>
        <input type="date" id="fe-birthdate"></div>
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
    const gender = (document.getElementById("fe-gender")?.value || "").trim().toUpperCase();
    const birthdate = (document.getElementById("fe-birthdate")?.value || "").trim();
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
          GENDER: gender,
          BIRTHDATE: birthdate,
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
        ${W.barangays.length ? `<div class="pick-list">${W.barangays.map((b) => `
          <div class="pick ${W.barangay === b.id ? "selected" : ""}" data-id="${b.id}" data-name="${esc(b.name)}">
            <span class="dot"></span><span>${esc(b.name)}</span>
          </div>`).join("")}</div>`
        : `<div class="notice warn">No barangays have been configured yet.
             Please ask your administrator to set up the system.</div>`}
        <div class="btn-row end">
          <button class="btn btn-primary" id="go2" ${W.barangay ? "" : "disabled"}>Continue (Magpatuloy) →</button>
        </div>
      </div>`;
  } else if (W.step === 2) {
    body = `
      <div class="card">
        <h3>Step 2 — How many parcels do you need certificates for? (Hakbang 2 — Ilang parsela ang kailangan mo ng sertipiko?)</h3>
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
        help += `<div class="help">Auto-filled from Entry 1 — edit only if this parcel differs.</div>`;
      }
      const curData = (W.entries[W.curIdx] || {}).data || {};
      if (f.key === "PARCEL_LOCATION" && !curData.PARCEL_LOCATION &&
          !W.manual[`${W.curIdx}:PARCEL_LOCATION`] && _defaultParcelLocation()) {
        curData.PARCEL_LOCATION = _defaultParcelLocation();
      }
      if (!curData[f.key] && f.default_value && !W.manual[`${W.curIdx}:${f.key}`]) {
        curData[f.key] = f.default_value;
      }
      const valRaw = curData[f.key] || "";
      const val = esc(valRaw);
      const isRsbsa = _isRsbsaFieldKey(f.key);
      const isFarmArea = f.key.toUpperCase() === "FARM_AREA";
      const caps = (f.type === "text" || f.type === "textarea" || isRsbsa) ? "caps" : "";
      const v = `class="${caps}" name="${esc(f.key)}" id="f_${esc(f.key)}" ${(staffStrictSubmit || _isFarmerNameField(f)) ? "required" : ""}`;
      const choiceKind = _choiceKind(f.key);
      let input;
      if (f.options && f.options.length) {
        input = `<select class="caps" name="${esc(f.key)}" id="f_${esc(f.key)}" ${(staffStrictSubmit || _isFarmerNameField(f)) ? "required" : ""}>
          <option value="">— Select ${esc(biLabel(f))} —</option>
          ${f.options.map((o) => `<option value="${esc(o)}" ${valRaw.toUpperCase() === o.toUpperCase() ? "selected" : ""}>${esc(o)}</option>`).join("")}
        </select>`;
      } else if (choiceKind) {
        input = `<select class="caps" name="${esc(f.key)}" id="f_${esc(f.key)}" ${(staffStrictSubmit || _isFarmerNameField(f)) ? "required" : ""}>${_choiceOptionsFor(choiceKind, valRaw)}</select>`;
      } else if (f.type === "textarea") {
        input = `<textarea ${v} rows="3" placeholder="${esc(f.placeholder || "")}">${val}</textarea>`;
      } else if (f.type === "date") {
        input = `<input type="date" ${v} value="${val}">`;
      } else if (isFarmArea) {
        input = `<input type="number" step="any" min="0" inputmode="decimal" placeholder="${esc(f.placeholder || "e.g. 0.2526")}" ${v} value="${val}">`;
      } else if (isRsbsa) {
        input = `<input type="text" placeholder="${esc(f.placeholder || "e.g. 02-015-02-014-EFMN47")}" ${v} value="${val}">`;
      } else if (f.type === "number") {
        input = `<input type="number" step="any" placeholder="${esc(f.placeholder || "")}" ${v} value="${val}">`;
      } else if (f.type === "checkbox") {
        input = `<label style="display:flex;align-items:center;gap:8px;margin-top:6px;cursor:pointer"><input type="checkbox" name="${esc(f.key)}" id="f_${esc(f.key)}" ${valRaw ? "checked" : ""}> <span class="small">${esc(f.placeholder || "Yes / Approved")}</span></label>`;
      } else if (f.type === "radio" && f.options && f.options.length) {
        input = `<div style="display:flex;gap:12px;flex-wrap:wrap;margin-top:6px">${f.options.map((o, oi) => `
          <label style="display:inline-flex;align-items:center;gap:5px;cursor:pointer">
            <input type="radio" name="${esc(f.key)}" id="f_${esc(f.key)}_${oi}" value="${esc(o)}" ${valRaw.toUpperCase() === o.toUpperCase() ? "checked" : ""}>
            <span>${esc(o)}</span>
          </label>`).join("")}</div>`;
      } else {
        input = `<input type="text" placeholder="${esc(f.placeholder || "")}" ${v} value="${val}">`;
      }
      const cls = f.type === "textarea" ? "field full" : "field";
      return `<div class="${cls}"><label>${esc(biLabel(f))} ${req}</label>${input}${help}</div>`;
    }).join("");
    const isLast = W.curIdx >= W.count - 1;
    body = `
      <div class="card">
        <h3>Step 3 — Your details (Hakbang 3 — Iyong mga Detalye)
          ${W.count > 1 ? `<span class="badge blue">Certificate ${W.curIdx + 1} of ${W.count}</span>` : ""}</h3>
        <p class="page-sub">Barangay: <b>${esc(W.barangayName)}</b></p>
        <div class="field" style="max-width:560px">
          <label>Certification type for Entry ${W.curIdx + 1} <span class="req">*</span></label>
          <select id="entry-type">
            ${W.templates.map((t) => `<option value="${t.id}" ${Number(curEntryWrap().tpl) === Number(t.id) ? "selected" : ""}>${esc(t.name)}</option>`).join("")}
          </select>
        </div>
        <div class="prefill-box">
          <div class="field">
            <label>Your RSBSA Number — type it, scan the QR code, or upload a QR photo</label>
            <input type="text" id="prefill-rsbsa" class="caps" placeholder="e.g. 02-015-02-014-EFMN47" value="${esc(W.prefillNum || "")}">
          </div>
          <button type="button" class="btn" id="prefill-go">Fetch my details (Kunin ang Detalye)</button>
          <button type="button" class="btn btn-primary" id="qr-scan">📷 Scan QR</button>
          <button type="button" class="btn" id="qr-upload-btn">Upload QR photo</button>
          <input type="file" id="qr-file" accept="image/*" hidden>
        </div>
        ${entryNav}
        <div class="notice warn" style="border-width:2px;margin:12px 0">
          <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;justify-content:space-between">
            <div>
              <b>NOT YET RSBSA REGISTERED?</b><br>
              <span>Walang rekord sa database? I-click ang button upang buksan ang Farmer Entry Form.</span>
            </div>
            <button type="button" class="btn btn-primary js-not-yet-rsbsa" id="not-yet-registered-step3">NOT YET RSBSA REGISTERED</button>
          </div>
        </div>
        <form id="details-form"><div class="form-grid">${rows}</div>
          <div class="btn-row">
            <button type="button" class="btn" id="back4">${W.curIdx > 0 ? "← Previous entry" : "← Back"}</button>
            ${isLast
              ? `<button type="submit" class="btn btn-primary">Submit request (Isumite ang Kahilingan)</button>`
              : `<button type="button" class="btn btn-primary" id="btn-next">Next entry →</button>`}
          </div>
        </form>
      </div>`;
  } else {
    body = `
      <div class="card success-box">
        <div class="big">✓</div>
        <h3>Request submitted! (Naipadala na ang Kahilingan!)</h3>
        <div class="notice warn" style="border-width:2px;font-size:1.05rem;font-weight:700;margin:16px 0;background:#fff8e6;border-color:#e6a100;color:#8a5700;line-height:1.4;text-align:left">
          ⚠️ WARNING:<br>Itugot ti nagrukudan (Georeferencing stub) nga inted ti DA wennu Agriculture staff a kas pammaneknek a narukuden. No awan nagrukudan awan ti ISSUANCE ti Certification.
        </div>
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
      let input = "";
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
      if (f.options && f.options.length) {
        input = `<select ${common}>
          <option value="">— Select ${esc(labelText)} —</option>
          ${f.options.map((o) => `<option value="${esc(o)}" ${rawVal.toUpperCase() === o.toUpperCase() ? "selected" : ""}>${esc(o)}</option>`).join("")}
        </select>`;
      } else if (choiceKind) {
        input = `<select ${common}>${_choiceOptionsFor(choiceKind, rawVal)}</select>`;
      } else if (f.type === "textarea") {
        input = `<textarea ${common} rows="3" placeholder="${esc(f.placeholder || "")}">${val}</textarea>`;
      } else if (f.type === "date") {
        input = `<input type="date" ${common} value="${val}">`;
      } else if (isFarmArea) {
        input = `<input type="number" step="any" min="0" inputmode="decimal" placeholder="${esc(f.placeholder || "e.g. 0.2526")}" ${common} value="${val}">`;
      } else if (isRsbsa) {
        input = `<input type="text" placeholder="${esc(f.placeholder || "e.g. 02-015-02-014-EFMN47")}" ${common} value="${val}">`;
      } else if (f.type === "number") {
        input = `<input type="number" step="any" placeholder="${esc(f.placeholder || "")}" ${common} value="${val}">`;
      } else if (f.type === "checkbox") {
        input = `<label style="display:flex;align-items:center;gap:8px;margin-top:6px;cursor:pointer"><input type="checkbox" ${common} ${rawVal ? "checked" : ""}> <span class="small">${esc(f.placeholder || "Yes / Approved")}</span></label>`;
      } else if (f.type === "radio" && f.options && f.options.length) {
        input = `<div style="display:flex;gap:12px;flex-wrap:wrap;margin-top:6px">${f.options.map((o, oi) => `
          <label style="display:inline-flex;align-items:center;gap:5px;cursor:pointer">
            <input type="radio" ${common} value="${esc(o)}" ${rawVal.toUpperCase() === o.toUpperCase() ? "checked" : ""}>
            <span>${esc(o)}</span>
          </label>`).join("")}</div>`;
      } else {
        input = `<input type="text" placeholder="${esc(f.placeholder || "")}" ${common} value="${val}">`;
      }
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
  let tpls = [];
  try { tpls = await api("/api/public/templates"); } catch (_) {}
  $app.innerHTML = `
    <div class="page-title">Certificate Archive</div>
    <p class="page-sub">Filing system for every certificate issued through
       this app. ${ME.role === "admin" ? "Showing all barangays."
       : "Showing barangay " + esc(ME.barangay) + "."}
       Certificates are filed as <b>PDF only</b> — PDF files are
       automatically deleted after 30 days, but every certificate record,
       report and audit entry is retained permanently, and a purged PDF
       can be regenerated at any time with the issue date updated to today.</p>
    <div class="card">
      <form id="arc-filters" class="filters">
        <div class="field"><label>Search</label>
          <input name="q" placeholder="Name, cert no., reference…"></div>
        <div class="field"><label>Template</label>
          <select name="template_id">
            <option value="">All Templates</option>
            ${tpls.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join("")}
          </select></div>
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
    ["q", "template_id", "from", "to"].forEach((k) => {
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
              <th>Template</th><th>Inputted Details (Placeholders)</th><th>Reference</th><th>Issued</th>
              <th>Issued by</th><th>Action</th></tr></thead>
            <tbody>${rows.map((c) => {
              const dataEntries = Object.entries(c.data || {}).filter(([k]) =>
                !["DATE_ISSUED", "MUNICIPALITY", "PROVINCE", "CERT_NO"].includes(k));
              const dataHtml = dataEntries.length ? dataEntries.map(([k, v]) =>
                `<span class="small" style="display:inline-block;margin-right:6px;background:#f0f4f8;padding:2px 6px;border-radius:4px;margin-bottom:2px"><b>${esc(k)}:</b> <span class="caps">${esc(v)}</span></span>`).join(" ")
                : `<span class="small muted">—</span>`;
              return `
              <tr>
                <td class="mono"><b>${esc(c.cert_no)}</b></td>
                <td><b>${esc(c.farmer_name || "—")}</b></td>
                ${ME.role === "admin" ? `<td>${esc(c.barangay)}</td>` : ""}
                <td>${esc(c.template)}</td>
                <td style="max-width:320px">${dataHtml}</td>
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
                    ? `<button class="btn btn-sm btn-primary" data-preview="${c.id}">Preview</button>
                       <a class="btn btn-sm" href="/api/certificates/${c.id}/download/pdf">Download</a>`
                    : `<span class="badge rejected">PDF purged</span>
                       <button class="btn btn-sm btn-primary" data-regen="${c.id}">Regenerate PDF</button>`}
                </td>
              </tr>`;
            }).join("")}</tbody>
          </table>
        </div>`
        : `<div class="empty">No certificates match your search.</div>`;
      out.querySelectorAll("[data-preview]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const cid = btn.dataset.preview;
          const c = rows.find((x) => String(x.id) === String(cid));
          showModal(`
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
              <h3 style="margin:0">Preview Certificate — ${esc(c ? c.cert_no : "")}</h3>
              <button class="btn btn-sm" id="prev-close">✕ Close</button>
            </div>
            <iframe src="/api/certificates/${cid}/preview" style="width:100%;height:75vh;border:1px solid #ccc;border-radius:4px"></iframe>
            <div class="modal-actions" style="margin-top:10px">
              <a class="btn btn-primary" href="/api/certificates/${cid}/download/pdf">⬇ Download PDF</a>
              <button class="btn" id="prev-close2">Close</button>
            </div>
          `, 850);
          bind("prev-close", "click", closeModal);
          bind("prev-close2", "click", closeModal);
        });
      });
      out.querySelectorAll("[data-regen]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          btn.disabled = true;
          btn.textContent = "Regenerating…";
          try {
            const res = await api(
              `/api/certificates/${btn.dataset.regen}/regenerate`,
              { method: "POST", body: {} });
            toast(`PDF regenerated for ${res.cert_no} with today's issue date.`);
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
  const isAdmin = ME && ME.role === "admin";
  showModal(`
    <h3>Edit Farmer Record — ${esc(f.name)}</h3>
    <p class="page-sub">${isAdmin ? "Update details directly in the system." : "Secretaries can submit remarks changes for Admin confirmation and approval."}</p>
    <div class="form-grid">
      <div class="field"><label>Farmer Name *</label>
        <input type="text" id="ed-name" class="caps" value="${esc(f.name)}" ${isAdmin ? "" : "readonly style='background:#f3f4f6'"}></div>
      <div class="field"><label>RSBSA Number</label>
        <input type="text" id="ed-rsbsa" class="caps" value="${esc(f.rsbsa_number || "")}" ${isAdmin ? "" : "readonly style='background:#f3f4f6'"}></div>
      <div class="field"><label>Remarks <span class="req">*</span></label>
        <select id="ed-remarks">
          ${FARMER_REMARKS_OPTIONS.map((r) => `<option value="${r}" ${(f.remarks || "Active") === r ? "selected" : ""}>${r}</option>`).join("")}
        </select>
        ${f.pending_remarks ? `<div class="help" style="color:#d97706;font-weight:600">Pending approval to: ${esc(f.pending_remarks)}</div>` : ""}
      </div>
      <div class="field"><label>Gender</label>
        <select id="ed-gender" class="caps" ${isAdmin ? "" : "disabled"}>${_choiceOptionsFor("gender", f.gender || "")}</select></div>
      <div class="field"><label>Birthdate</label>
        <input type="date" id="ed-birthdate" value="${esc(f.birthdate ? f.birthdate.slice(0, 10) : "")}" ${isAdmin ? "" : "readonly style='background:#f3f4f6'"}></div>
      <div class="field"><label>Civil Status</label>
        <select id="ed-civil" class="caps" ${isAdmin ? "" : "disabled"}>${_choiceOptionsFor("civil", f.civil_status || "")}</select></div>
      <div class="field"><label>Barangay *</label>
        <select id="ed-barangay" ${isAdmin ? "" : "disabled"}>${bgy.map((b) =>
          `<option value="${b.id}" ${Number(f.barangay_id) === Number(b.id) ? "selected" : ""}>${esc(b.name)}</option>`).join("")}
        </select></div>
      <div class="field full"><label>Address</label>
        <input type="text" id="ed-address" class="caps" value="${esc(f.address || "")}" ${isAdmin ? "" : "readonly style='background:#f3f4f6'"}></div>
    </div>
    <div class="modal-actions">
      <button class="btn" id="ed-cancel">Cancel</button>
      <button class="btn btn-primary" id="ed-save">${isAdmin ? "Save changes" : "Submit Remarks Change"}</button>
    </div>`, 640);
  bind("ed-cancel", "click", closeModal);
  bind("ed-save", "click", async () => {
    const remarks = document.getElementById("ed-remarks").value;
    if (!isAdmin) {
      try {
        await api(`/api/farmers/${f.id}/remarks`, { method: "POST", body: { remarks } });
        closeModal();
        toast("Remarks update submitted for Admin confirmation and approval.");
        if (onSaved) onSaved();
      } catch (err) { toast(err.message, "err"); }
      return;
    }
    const body = {
      name: document.getElementById("ed-name").value.trim(),
      rsbsa_number: document.getElementById("ed-rsbsa").value.trim(),
      remarks: remarks,
      gender: document.getElementById("ed-gender")?.value || "",
      birthdate: document.getElementById("ed-birthdate")?.value || "",
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
        <div class="field"><label>Gender</label>
          <select id="fid-gender" class="caps">${_choiceOptionsFor("gender", f.gender || "")}</select></div>
        <div class="field"><label>Birthdate</label>
          <input type="date" id="fid-birthdate" value="${esc(f.birthdate ? f.birthdate.slice(0, 10) : "")}"></div>
        <div class="field"><label>Contact Number</label>
          <input id="fid-contact" class="caps" value="${esc(f.contact_number || "")}" placeholder="09XX XXX XXXX"></div>
        <div class="field"><label>Contact Person in Case of Emergency (Name — Number)</label>
          <input id="fid-emergency" class="caps" value="${esc(f.emergency_contact || "")}" placeholder="MARIA CRUZ - 0917 123 4567"></div>
      </div>
      <div class="field full"><label>Farmer's Affiliated FCA</label>
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
      gender: document.getElementById("fid-gender") ? document.getElementById("fid-gender").value : "",
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
  let bgys = [];
  try {
    bgys = ME.role === "admin" ? await api("/api/admin/barangays") : await api("/api/barangays");
  } catch (_) {
    bgys = cachedBarangays();
  }
  $app.innerHTML = `
    <div class="page-title">Farmer Masterlist</div>
    <p class="page-sub">Automatically built from certification requests —
       ${ME.role === "admin" ? "all barangays."
         : "Barangay " + esc(ME.barangay) + " only."}
       Search by name or RSBSA number. Repeat requests can pre-fill the
       farmer's form.</p>
    <div class="card">
      <div class="actions" style="margin-bottom:12px;display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        <button class="btn btn-primary" id="farmer-add" type="button">＋ Farmer Data Entry</button>
        <a class="btn" id="farmer-export-csv" href="/api/farmers/export-csv">⬇ Export CSV</a>
        ${ME.role === "admin" ? `<button class="btn" id="farmer-sync-id" type="button" title="Import/copy all farmers from ID Generator database and tag as verified">🔄 Sync from ID Database</button>` : ""}
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
        ${ME.role === "admin" ? `
          <div class="field"><label>Barangay</label>
            <select name="barangay_id">
              <option value="">All Barangays</option>
              ${bgys.map((b) => `<option value="${b.id}">${esc(b.name)}</option>`).join("")}
            </select></div>` : ""}
        <div class="field"><label>Remarks</label>
          <select name="remarks" id="farmers-filter-remarks">
            <option value="">All Remarks</option>
            ${FARMER_REMARKS_OPTIONS.map((r) => `<option value="${r}">${r}</option>`).join("")}
          </select></div>
        <div class="field"><label>Farmer's ID Status</label>
          <select name="id_status" id="farmers-filter-id-status">
            <option value="">All ID Statuses</option>
            <option value="not_yet_generated">Not yet generated</option>
            <option value="generated">Generated</option>
          </select></div>
        <button class="btn btn-primary" type="submit">Search</button>
      </form>
      <div id="farmers-results"><div class="loading">Loading…</div></div>
    </div>`;

  async function load() {
    const fd = new FormData(document.getElementById("farmers-filters"));
    const q = (fd.get("q") || "").toString().trim();
    const bgyId = (fd.get("barangay_id") || "").toString().trim();
    const remarks = (fd.get("remarks") || "").toString().trim();
    const idStatus = (fd.get("id_status") || "").toString().trim();

    const qs = new URLSearchParams();
    if (q) qs.set("q", q);
    if (bgyId) qs.set("barangay_id", bgyId);
    if (remarks) qs.set("remarks", remarks);
    if (idStatus) qs.set("id_status", idStatus);
    if (farmerTab !== "all") qs.set("status", farmerTab);

    const expBtn = document.getElementById("farmer-export-csv");
    if (expBtn) expBtn.href = "/api/farmers/export-csv?" + qs.toString();

    const out = document.getElementById("farmers-results");
    try {
      const st = await api("/api/farmers/stats").catch(() => null);
      const cntEl = document.getElementById("farmers-counts");
      if (cntEl && st) {
        cntEl.textContent = st.new
          ? `${st.new} new farmer(s) awaiting admin verification of ${st.total} records.`
          : `All ${st.total} farmer record(s) verified.`;
      }
      const rows = await api(`/api/farmers?${qs.toString()}`);
      out.innerHTML = rows.length ? `
        <div class="table-wrap">
          <table class="table">
            <thead><tr><th>Name</th><th>RSBSA No.</th><th>Barangay</th>
              <th>Requests</th><th>Last request</th><th>Remarks</th><th>Status</th><th>Farmer's ID</th><th>Actions</th></tr></thead>
            <tbody>${rows.map((f) => `
              <tr>
                <td><b>${esc(f.name)}</b></td>
                <td class="mono">${esc(f.rsbsa_number || "—")}</td>
                <td>${esc(f.barangay || "—")}</td>
                <td>${f.requests}</td>
                <td class="mono">${esc(f.last_ref || "—")}</td>
                <td>
                  <span class="badge ${f.remarks === 'Active' ? 'approved' : 'neutral'}">${esc(f.remarks || 'Active')}</span>
                  ${f.pending_remarks ? `
                    <div style="margin-top:3px;font-size:11px;color:#b45309;font-weight:600">
                      ⏳ Req: ${esc(f.pending_remarks)}
                      ${ME.role === "admin" ? `
                        <button class="btn btn-sm btn-success" data-apprem="${f.id}" style="padding:1px 5px;font-size:10px" title="Approve">✓</button>
                        <button class="btn btn-sm btn-danger" data-rejrem="${f.id}" style="padding:1px 5px;font-size:10px" title="Reject">✕</button>
                      ` : ""}
                    </div>
                  ` : ""}
                </td>
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
                  <button class="btn btn-sm" data-fedit="${f.id}">Edit</button>
                  ${ME.role === "admin" && f.verification_status === "new" ? `<button class="btn btn-sm btn-success" data-fverify="${f.id}">Verify</button>` : ""}
                  ${ME.role === "admin" ? `<button class="btn btn-sm btn-danger" data-fdelete="${f.id}">Delete</button>` : ""}
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
      document.querySelectorAll("[data-apprem]").forEach((btn) =>
        btn.addEventListener("click", async () => {
          const fid = Number(btn.dataset.apprem);
          try {
            await api(`/api/farmers/${fid}/remarks/approve`, { method: "POST" });
            toast("Remarks update approved.");
            load();
          } catch (err) { toast(err.message, "err"); }
        }));
      document.querySelectorAll("[data-rejrem]").forEach((btn) =>
        btn.addEventListener("click", async () => {
          const fid = Number(btn.dataset.rejrem);
          try {
            await api(`/api/farmers/${fid}/remarks/reject`, { method: "POST" });
            toast("Remarks update rejected.");
            load();
          } catch (err) { toast(err.message, "err"); }
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
          confirmModal("Delete farmer record",
            `Delete the farmer record of <b>${esc(f.name)}</b> ` +
            `(RSBSA ${esc(f.rsbsa_number || "—")})? This action will permanently remove this record from the database, and is recorded ` +
            `in the audit trail.`,
            "Delete record", async () => {
              try {
                await api(`/api/farmers/${f.id}`, { method: "DELETE" });
                toast(`Farmer record of ${f.name} deleted.`);
                load();
              } catch (err) { toast(err.message, "err"); }
            }, true);
        }));
    } catch (err) { toast(err.message, "err"); }
  }
  bind("farmers-filters", "submit", (e) => { e.preventDefault(); load(); });
  document.getElementById("farmers-filter-remarks")?.addEventListener("change", () => load());
  document.getElementById("farmers-filter-id-status")?.addEventListener("change", () => load());
  document.querySelectorAll("[data-ftab]").forEach((btn) =>
    btn.addEventListener("click", () => {
      farmerTab = btn.dataset.ftab;
      viewFarmers();
    }));
  const syncBtn = document.getElementById("farmer-sync-id");
  if (syncBtn) {
    syncBtn.addEventListener("click", async () => {
      syncBtn.disabled = true;
      syncBtn.textContent = "Syncing…";
      try {
        const res = await api("/api/farmers/sync-from-id-db", { method: "POST" });
        toast(`Synced: ${res.added} farmer(s) added as verified (${res.skipped} already in masterlist).`);
        await load();
      } catch (err) {
        toast(err.message, "err");
      } finally {
        syncBtn.disabled = false;
        syncBtn.textContent = "🔄 Sync from ID Database";
      }
    });
  }
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
let idgPage = 1;
let idgLimit = 50;
const idgSelectedIds = new Set();

async function viewIdGenerator() {
  $app.innerHTML = `
    <div class="page-title">🪪 ID Card Generator</div>
    <p class="page-sub">Generate and print official Farmer's ID cards (CR80 standard).
       Cards can be printed individually or in batch on A4 paper (5 IDs per sheet, front and back side-by-side with cutting guides).</p>

    <div class="grid-3">
      <div class="card stat-card"><div class="stat-num" id="idg-total">—</div>
        <div class="stat-label">Records in ID database</div></div>
      <div class="card stat-card"><div class="stat-num" id="idg-issued">—</div>
        <div class="stat-label">IDs generated</div></div>
      <div class="card stat-card"><div class="stat-num">A4 Batch</div>
        <div class="stat-label">5 Farmers' IDs per A4 sheet (Front &amp; Back)</div></div>
    </div>

    <div class="card" style="margin-top:16px">
      <div class="section-head" style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
        <div>
          <h3 style="margin:0">ID Database Records</h3>
          <span class="small muted" id="idg-record-summary">Loading records…</span>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
          <button class="btn btn-primary" id="idg-batch-print" type="button">🖨 Batch Print A4 (5 IDs/sheet)</button>
          <div id="idg-batch-actions-grp" style="display:none;gap:6px;align-items:center">
            <button class="btn btn-sm" id="idg-batch-tag-printed" type="button" title="Mark selected cards as Printed">✓ Tag Printed</button>
            <button class="btn btn-sm" id="idg-batch-untag-printed" type="button" title="Mark selected cards as Not Printed">Untag Printed</button>
            ${ME.role === "admin" ? `<button class="btn btn-sm btn-danger" id="idg-batch-delete" type="button" title="Delete selected ID records">🗑 Batch Delete</button>` : ""}
            <button class="btn btn-sm" id="idg-batch-clear" type="button" title="Clear selected items" style="color:#666">✕ Clear</button>
          </div>
          <button class="btn" id="idg-copy">Copy from Farmer Masterlist</button>
          <button class="btn" id="idg-manage-fcas" type="button">🌾 Manage Affiliated FCAs</button>
        </div>
      </div>
      <form id="idg-filters" class="filters">
        <div class="field" style="flex:2;min-width:180px"><label>Search</label>
          <input name="q" id="idg-search-q" placeholder="Name, RSBSA, or FCA"></div>
        <div class="field"><label>Barangay</label>
          <input name="barangay" id="idg-search-bgy" placeholder="Barangay"></div>
        <div class="field"><label>Remarks</label>
          <select name="remarks" id="idg-search-rem">
            <option value="">All Remarks</option>
            ${FARMER_REMARKS_OPTIONS.map((r) => `<option value="${r}">${r}</option>`).join("")}
          </select></div>
        <div class="field"><label>Farmer's ID Status</label>
          <select name="id_status" id="idg-search-id-status">
            <option value="">All ID Statuses</option>
            <option value="not_yet_generated">Not yet generated</option>
            <option value="generated">Generated</option>
          </select></div>
        <div class="field"><label>Printed Status</label>
          <select name="printed" id="idg-search-print">
            <option value="">All Statuses</option>
            <option value="0">Not Yet Printed</option>
            <option value="1">Printed</option>
          </select></div>
        <div class="field" style="max-width:110px"><label>Page Size</label>
          <select name="limit" id="idg-search-limit">
            <option value="25">25</option>
            <option value="50" selected>50</option>
            <option value="100">100</option>
            <option value="250">250</option>
            <option value="all">All</option>
          </select></div>
        <button class="btn btn-primary" type="submit">Filter</button>
      </form>
      <div id="idg-results"><div class="loading">Loading records…</div></div>
    </div>`;

  let currentPersons = [];

  function updateBatchButtonText() {
    const btn = document.getElementById("idg-batch-print");
    const grp = document.getElementById("idg-batch-actions-grp");
    if (!btn) return;
    if (idgSelectedIds.size > 0) {
      btn.textContent = `🖨 Batch Print A4 (${idgSelectedIds.size} selected)`;
      btn.classList.add("btn-success");
      if (grp) grp.style.display = "inline-flex";
    } else {
      btn.textContent = "🖨 Batch Print A4 (5 IDs/sheet)";
      btn.classList.remove("btn-success");
      if (grp) grp.style.display = "none";
    }
  }

  async function loadPersons(page = idgPage) {
    idgPage = page;
    const fd = new FormData(document.getElementById("idg-filters"));
    const qs = new URLSearchParams();
    ["q", "barangay", "remarks", "id_status", "printed"].forEach((k) => {
      const v = (fd.get(k) || "").toString().trim();
      if (v) qs.set(k, v);
    });
    const limitVal = document.getElementById("idg-search-limit")?.value || "50";
    qs.set("limit", limitVal);
    qs.set("page", idgPage);

    const out = document.getElementById("idg-results");
    out.innerHTML = `<div class="loading" style="padding:24px">Loading records…</div>`;

    try {
      const r = await api(`/api/id-generator/persons?${qs.toString()}`);
      document.getElementById("idg-total").textContent = r.total_all || r.total;
      document.getElementById("idg-issued").textContent = r.issued;

      const summaryEl = document.getElementById("idg-record-summary");
      if (summaryEl) {
        summaryEl.textContent = `Showing ${r.persons.length ? ((r.page - 1) * (r.limit || r.persons.length) + 1) : 0}–${((r.page - 1) * (r.limit || r.persons.length)) + r.persons.length} of ${r.total} filtered records (${r.total_all || r.total} total in database)`;
      }

      currentPersons = r.persons || [];
      const totalPages = r.total_pages || 1;

      if (!currentPersons.length) {
        out.innerHTML = `<div class="empty">No ID records found matching your filters.</div>`;
        return;
      }

      const rowsHtml = currentPersons.map((p) => {
        const isChecked = idgSelectedIds.has(p.id);
        return `
          <tr>
            <td><input type="checkbox" class="idg-card-check" data-pid="${p.id}" ${p.id_control_no ? "" : "disabled"} ${isChecked ? "checked" : ""}></td>
            <td><b>${esc(p.name)}</b></td>
            <td class="mono" style="white-space:nowrap">
              <span>${esc(p.rsbsa_number)}</span>
              ${p.rsbsa_number ? `<button class="btn-action-icon" data-copy-rsbsa="${esc(p.rsbsa_number)}" title="Copy RSBSA Number" type="button" style="margin-left:5px">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                </svg>
              </button>` : ""}
            </td>
            <td>${esc(p.barangay || "—")}</td>
            <td><span class="badge ${p.remarks === 'Active' ? 'approved' : 'neutral'}">${esc(p.remarks || 'Active')}</span></td>
            <td>${esc(p.gender || "—")}</td>
            <td>${esc(p.birthdate ? p.birthdate.slice(0, 10) : "—")}</td>
            <td>${p.id_control_no
              ? `<span class="badge blue mono">${esc(p.id_control_no)}</span>
                 <div class="small muted">until ${fmtD(p.id_valid_until)}${p.id_reprints ? ` · ${p.id_reprints} regen` : ""}</div>`
              : `<span class="small muted">Not yet generated</span>`}</td>
            <td>${p.is_printed
              ? `<span class="badge approved">✓ Printed</span>${p.printed_at ? `<div class="small muted">${fmtD(p.printed_at)}</div>` : ""}`
              : `<span class="badge neutral">— Not Printed</span>`}</td>
            <td style="white-space:nowrap">
              <button class="btn btn-sm btn-primary" data-idg="${p.id}">Details &amp; Generate</button>
              ${p.id_control_no ? `<button class="btn btn-sm" data-tagprint="${p.id}" data-printed="${p.is_printed ? 1 : 0}">${p.is_printed ? "Untag" : "Tag Printed"}</button>` : ""}
              ${ME.role === "admin" ? `<button class="btn btn-sm btn-danger" data-idgdel="${p.id}">Delete</button>` : ""}
            </td>
          </tr>`;
      }).join("");

      const paginationHtml = totalPages > 1 ? `
        <div class="pagination-bar">
          <div class="small muted">Page <b>${r.page}</b> of <b>${totalPages}</b></div>
          <div style="display:flex;gap:4px">
            <button class="page-btn idg-page-go" data-page="1" ${r.page <= 1 ? "disabled" : ""}>« First</button>
            <button class="page-btn idg-page-go" data-page="${r.page - 1}" ${r.page <= 1 ? "disabled" : ""}>‹ Prev</button>
            <button class="page-btn idg-page-go" data-page="${r.page + 1}" ${r.page >= totalPages ? "disabled" : ""}>Next ›</button>
            <button class="page-btn idg-page-go" data-page="${totalPages}" ${r.page >= totalPages ? "disabled" : ""}>Last »</button>
          </div>
        </div>` : "";

      out.innerHTML = `
        <div class="table-wrap"><table class="table">
          <thead><tr>
            <th><input type="checkbox" id="idg-check-all" title="Select all on this page for batch print"></th>
            <th>Farmer</th><th>RSBSA No.</th><th>Barangay</th><th>Remarks</th><th>Gender</th>
            <th>Birthdate</th><th>Farmer's ID</th><th>Printed?</th><th>Actions</th>
          </tr></thead>
          <tbody>${rowsHtml}</tbody>
        </table></div>
        ${paginationHtml}`;

      updateBatchButtonText();

      if (idGenOpenRsbsa) {
        const target = currentPersons.find((x) => x.rsbsa_number === idGenOpenRsbsa);
        idGenOpenRsbsa = "";
        if (target) idGenPersonModal(target, loadPersons);
      }
    } catch (err) {
      out.innerHTML = `<div class="empty">${esc(err.message)}</div>`;
    }
  }

  // Event Delegation on #idg-results: zero DOM lag, high speed!
  const resultsBox = document.getElementById("idg-results");
  resultsBox.addEventListener("click", async (e) => {
    // Copy RSBSA Number
    const btnCopyRsbsa = e.target.closest("[data-copy-rsbsa]");
    if (btnCopyRsbsa) {
      e.stopPropagation();
      await copyToClipboard(btnCopyRsbsa.dataset.copyRsbsa, "RSBSA Number copied!");
      return;
    }

    // Details & Generate Modal
    const btnIdg = e.target.closest("[data-idg]");
    if (btnIdg) {
      const pid = Number(btnIdg.dataset.idg);
      const p = currentPersons.find((x) => x.id === pid);
      if (p) idGenPersonModal(p, loadPersons);
      return;
    }

    // Tag / Untag Printed Toggle
    const btnTag = e.target.closest("[data-tagprint]");
    if (btnTag) {
      const pid = Number(btnTag.dataset.tagprint);
      const wasPrinted = btnTag.dataset.printed === "1";
      btnTag.disabled = true;
      try {
        await api(`/api/id-generator/cards/${pid}/tag-printed`, {
          method: "POST",
          body: { is_printed: !wasPrinted }
        });
        toast(`Card tagged as ${!wasPrinted ? "printed" : "unprinted"}.`);
        await loadPersons();
      } catch (err) {
        toast(err.message, "err");
        btnTag.disabled = false;
      }
      return;
    }

    // Delete Record
    const btnDel = e.target.closest("[data-idgdel]");
    if (btnDel) {
      const pid = Number(btnDel.dataset.idgdel);
      const p = currentPersons.find((x) => x.id === pid);
      if (!p) return;
      confirmModal("Delete ID Record",
        `Permanently delete ID record for <b>${esc(p.name)}</b> (RSBSA ${esc(p.rsbsa_number)})? Any generated cards and photos will also be removed.`,
        "Delete record", async () => {
          try {
            await api(`/api/id-generator/persons/${pid}`, { method: "DELETE" });
            idgSelectedIds.delete(pid);
            toast(`ID record of ${p.name} deleted.`);
            await loadPersons();
          } catch (err) { toast(err.message, "err"); }
        }, true);
      return;
    }

    // Pagination button
    const btnPage = e.target.closest(".idg-page-go");
    if (btnPage) {
      const p = Number(btnPage.dataset.page);
      if (p > 0) loadPersons(p);
      return;
    }
  });

  // Checkbox state tracking via change event delegation
  resultsBox.addEventListener("change", (e) => {
    if (e.target.id === "idg-check-all") {
      const isChecked = e.target.checked;
      resultsBox.querySelectorAll(".idg-card-check:not(:disabled)").forEach((chk) => {
        chk.checked = isChecked;
        const pid = Number(chk.dataset.pid);
        if (isChecked) idgSelectedIds.add(pid);
        else idgSelectedIds.delete(pid);
      });
      updateBatchButtonText();
      return;
    }

    if (e.target.classList.contains("idg-card-check")) {
      const pid = Number(e.target.dataset.pid);
      if (e.target.checked) idgSelectedIds.add(pid);
      else idgSelectedIds.delete(pid);
      updateBatchButtonText();
    }
  });

  // Debounced input search on typing
  let searchTimer = null;
  function debouncedSearch() {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      idgPage = 1;
      loadPersons(1);
    }, 280);
  }
  document.getElementById("idg-search-q").addEventListener("input", debouncedSearch);
  document.getElementById("idg-search-bgy").addEventListener("input", debouncedSearch);
  document.getElementById("idg-search-rem").addEventListener("change", () => loadPersons(1));
  document.getElementById("idg-search-id-status")?.addEventListener("change", () => loadPersons(1));
  document.getElementById("idg-search-print").addEventListener("change", () => loadPersons(1));
  document.getElementById("idg-search-limit").addEventListener("change", () => loadPersons(1));

  bind("idg-filters", "submit", (e) => { e.preventDefault(); loadPersons(1); });
  bind("idg-copy", "click", () => idGenCopyModal(loadPersons));
  bind("idg-manage-fcas", "click", () => {
    adminTab = "fcas";
    location.hash = "#/admin";
  });

  bind("idg-batch-print", "click", async () => {
    const checked = Array.from(idgSelectedIds);
    const btn = document.getElementById("idg-batch-print");
    btn.disabled = true;
    btn.textContent = "Generating A4 Batch…";
    try {
      const res = await fetch("/api/id-generator/batch-print", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ person_ids: checked.length ? checked : null }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Batch print failed.");
      }
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `farmer_ids_batch_A4_${Date.now()}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
      toast(`Batch A4 PDF downloaded (5 IDs/sheet). ${checked.length ? checked.length + " card(s)" : "All issued cards"} tagged as printed.`);
      idgSelectedIds.clear();
      await loadPersons();
    } catch (err) {
      toast(err.message, "err");
    } finally {
      btn.disabled = false;
      updateBatchButtonText();
    }
  });

  bind("idg-batch-tag-printed", "click", async () => {
    const checked = Array.from(idgSelectedIds);
    if (!checked.length) return;
    try {
      await Promise.all(checked.map((pid) =>
        api(`/api/id-generator/cards/${pid}/tag-printed`, { method: "POST", body: { is_printed: true } }).catch(() => {})
      ));
      toast(`Tagged ${checked.length} selected farmer(s) as Printed.`);
      idgSelectedIds.clear();
      await loadPersons();
    } catch (err) {
      toast(err.message, "err");
    }
  });

  bind("idg-batch-untag-printed", "click", async () => {
    const checked = Array.from(idgSelectedIds);
    if (!checked.length) return;
    try {
      await Promise.all(checked.map((pid) =>
        api(`/api/id-generator/cards/${pid}/tag-printed`, { method: "POST", body: { is_printed: false } }).catch(() => {})
      ));
      toast(`Marked ${checked.length} selected farmer(s) as Not Printed.`);
      idgSelectedIds.clear();
      await loadPersons();
    } catch (err) {
      toast(err.message, "err");
    }
  });

  bind("idg-batch-delete", "click", () => {
    const checked = Array.from(idgSelectedIds);
    if (!checked.length) return;
    confirmModal("Batch Delete ID Records",
      `Are you sure you want to permanently delete <b>${checked.length}</b> selected ID record(s) and their issued cards?`,
      "Delete Selected", async () => {
        try {
          await Promise.all(checked.map((pid) =>
            api(`/api/id-generator/persons/${pid}`, { method: "DELETE" }).catch(() => {})
          ));
          toast(`Deleted ${checked.length} ID record(s).`);
          idgSelectedIds.clear();
          await loadPersons();
        } catch (err) {
          toast(err.message, "err");
        }
      }, true);
  });

  bind("idg-batch-clear", "click", () => {
    idgSelectedIds.clear();
    resultsBox.querySelectorAll(".idg-card-check").forEach((chk) => (chk.checked = false));
    const chkAll = document.getElementById("idg-check-all");
    if (chkAll) chkAll.checked = false;
    updateBatchButtonText();
  });

  await loadPersons();
}

function idGenCopyModal(onDone) {
  showModal(`
    <h3>Copy farmers from the Masterlist</h3>
    <p class="small muted">Copies the farmer's profile into the separate
       ID database. Farmers already in the ID database are skipped.</p>
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
          <th>RSBSA No.</th><th>Status</th></tr></thead>
        <tbody>${rows.map((f) => `
          <tr>
            <td><input type="checkbox" class="idg-pick" value="${f.farmer_id}"
              ${f.in_id_db || !f.rsbsa_number ? "disabled" : ""}></td>
            <td><b>${esc(f.name)}</b></td>
            <td class="mono">${esc(f.rsbsa_number || "—")}</td>
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
  const copySvg = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>`;
  const editSvg = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path></svg>`;
  const saveSvg = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path><polyline points="17 21 17 13 7 13 7 21"></polyline><polyline points="7 3 7 8 15 8"></polyline></svg>`;

  showModal(`
    <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap">
      <div id="fid-header-view" style="display:flex;align-items:center;gap:6px;flex:1;min-width:0">
        <h3 style="margin:0;display:inline-flex;align-items:center;gap:6px;word-break:break-word">
          🪪 Farmer's ID — <span id="fid-title-name">${esc(p.name)}</span>
        </h3>
        <button class="btn-action-icon" id="fid-btn-edit" type="button" title="Edit Farmer's Name" style="flex-shrink:0">
          ${editSvg}
        </button>
        <button class="btn-action-icon" id="fid-btn-copy" type="button" title="Copy Farmer's Name and RSBSA No." style="flex-shrink:0">
          ${copySvg}
        </button>
      </div>
      <div id="fid-header-edit" style="display:none;align-items:center;gap:8px;flex:1;min-width:280px">
        <input type="text" id="fid-name-input" class="caps" value="${esc(p.name)}" placeholder="Farmer's Name" style="flex:1;padding:6px 10px;font-size:15px;font-weight:600">
        <button class="btn btn-sm btn-primary" id="fid-btn-save" type="button" style="display:inline-flex;align-items:center;gap:4px">
          ${saveSvg} <span>Save</span>
        </button>
        <button class="btn btn-sm" id="fid-btn-cancel-edit" type="button">Cancel</button>
      </div>
    </div>
    <p class="page-sub">Check and complete the ID details below. Details are saved to the ID database for one-click regenerations.</p>
    ${hasId ? `<div class="notice">ID <b class="mono">${esc(p.id_control_no)}</b>
      is already generated — valid until ${fmtD(p.id_valid_until)}
      (${p.id_reprints || 0} regeneration(s)). Generating again will
      <b>regenerate</b> the ID card with the same control number.</div>` : ""}
    <div class="meta-grid" style="margin-bottom:12px">
      <div class="meta-item"><div class="k">RSBSA No.</div>
        <div class="v mono">${esc(p.rsbsa_number)}</div></div>
      <div class="meta-item"><div class="k">Gender</div>
        <div class="v">${esc(p.gender || "—")}</div></div>
      <div class="meta-item"><div class="k">Birthdate</div>
        <div class="v">${esc(p.birthdate ? p.birthdate.slice(0, 10) : "—")}</div></div>
      <div class="meta-item"><div class="k">Barangay</div>
        <div class="v">${esc(p.barangay || "—")}</div></div>
    </div>
    <form id="idg-form">
      <div class="field" style="margin-bottom:14px">
        <label style="font-weight:700">ID Photo (JPG/PNG) — Browse, Drag &amp; Drop, or Copy &amp; Paste (Ctrl+V)</label>
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
      <div class="form-grid">
        <div class="field"><label>Gender</label>
          <select id="idg-gender" class="caps">${_choiceOptionsFor("gender", p.gender || "")}</select></div>
        <div class="field"><label>Birthdate</label>
          <input type="date" id="idg-birthdate" value="${esc(p.birthdate ? p.birthdate.slice(0, 10) : "")}"></div>
        <div class="field full"><label>Address</label>
          <input id="idg-address" class="caps" value="${esc(p.address || "")}" placeholder="PUROK / SITIO, BARANGAY, ALCALA, CAGAYAN"></div>
        <div class="field full">
          <label>Farmer's Affiliated FCA</label>
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
    </form>
    ${previews}
    <div class="modal-actions">
      <button class="btn" id="idg-close" type="button">Close</button>
      <button class="btn btn-primary" id="idg-go" type="button">${hasId ? "🖨 Regenerate ID Card" : "🪪 Generate ID Card"}</button>
    </div>`, 800);

  // Edit and Copy icon interactions in Farmer's ID header
  const headerView = document.getElementById("fid-header-view");
  const headerEdit = document.getElementById("fid-header-edit");
  const btnEdit = document.getElementById("fid-btn-edit");
  const btnCopy = document.getElementById("fid-btn-copy");
  const btnSave = document.getElementById("fid-btn-save");
  const btnCancelEdit = document.getElementById("fid-btn-cancel-edit");
  const nameInput = document.getElementById("fid-name-input");
  const titleName = document.getElementById("fid-title-name");

  if (btnCopy) {
    btnCopy.addEventListener("click", () => {
      const copyTextVal = p.rsbsa_number ? `${p.name} (${p.rsbsa_number})` : p.name;
      copyToClipboard(copyTextVal, `Copied: ${copyTextVal}`);
    });
  }

  if (btnEdit && headerView && headerEdit) {
    btnEdit.addEventListener("click", () => {
      headerView.style.display = "none";
      headerEdit.style.display = "flex";
      nameInput.value = p.name || "";
      nameInput.focus();
      nameInput.select();
    });

    btnCancelEdit.addEventListener("click", () => {
      headerEdit.style.display = "none";
      headerView.style.display = "flex";
    });

    nameInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        btnSave.click();
      } else if (e.key === "Escape") {
        btnCancelEdit.click();
      }
    });

    btnSave.addEventListener("click", async () => {
      const newName = (nameInput.value || "").trim().toUpperCase();
      if (!newName) {
        toast("Farmer name cannot be empty.", "err");
        return;
      }
      btnSave.disabled = true;
      btnSave.querySelector("span").textContent = "Saving…";
      try {
        const updated = await api(`/api/id-generator/persons/${p.id}`, {
          method: "PUT",
          body: { name: newName }
        });
        p.name = updated.name || newName;
        titleName.textContent = p.name;
        headerEdit.style.display = "none";
        headerView.style.display = "flex";
        toast("Farmer data updated successfully!");
        if (onDone) onDone();
      } catch (err) {
        toast(err.message, "err");
      } finally {
        btnSave.disabled = false;
        btnSave.querySelector("span").textContent = "Save";
      }
    });
  }

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
      civil_status: document.getElementById("idg-civil") ? document.getElementById("idg-civil").value.trim() : (p.civil_status || ""),
      address: document.getElementById("idg-address").value.trim(),
      birthdate: document.getElementById("idg-birthdate").value,
      affiliated_fca: (document.getElementById("idg-fca").value || "").trim().toUpperCase(),
    };
    btn.disabled = true; btn.textContent = hasId ? "Regenerating…" : "Generating…";
    try {
      await api(`/api/id-generator/persons/${p.id}`, { method: "PUT", body });
      const file = photoHelper.getFile();
      if (file) {
        const fd = new FormData();
        fd.append("photo", file);
        await api(`/api/id-generator/persons/${p.id}/photo`, { method: "POST", form: fd });
      }
      const res = await api(`/api/id-generator/persons/${p.id}/id-card`, {
        method: "POST", body: { valid_years: 3 } });
      toast(`Farmer's ID ${res.control_no} ${res.reprints ? "regenerated" : "generated"} — valid until ${res.valid_until}.`);
      closeModal();
      if (onDone) onDone();
      const fresh = await api(`/api/id-generator/persons/${p.id}`).catch(() => null);
      if (fresh) idGenPersonModal(fresh, onDone);
    } catch (err) {
      toast(err.message, "err");
      btn.disabled = false;
      btn.textContent = hasId ? "🖨 Regenerate ID Card" : "🪪 Generate ID Card";
    }
  });
}


/* ---------------------------- reports ------------------------------ */
/* ---------------------------- reports ------------------------------ */
let reportTab = "certs";

async function viewReports() {
  const defaultMonth = new Date().toISOString().slice(0, 7);
  let bgys = [];
  try {
    bgys = ME.role === "admin" ? await api("/api/admin/barangays") : await api("/api/barangays");
  } catch (_) {
    bgys = cachedBarangays();
  }

  $app.innerHTML = `
    <div class="page-title">Reports &amp; Accomplishments</div>
    <p class="page-sub">Generate and download official accomplishment reports for COA/LGU submission${ME.role === "secretary" ? " (scoped to your barangay)" : ""}.</p>
    <div class="tabs" id="rep-tabs">
      <button data-tab="certs" class="${reportTab === "certs" ? "active" : ""}">📜 Certificates Issued</button>
      <button data-tab="farmer_ids" class="${reportTab === "farmer_ids" ? "active" : ""}">🪪 Generated Farmers IDs</button>
    </div>
    <div id="rep-body"></div>`;

  document.querySelectorAll("#rep-tabs button").forEach((b) =>
    b.addEventListener("click", () => {
      reportTab = b.dataset.tab;
      viewReports();
    })
  );

  if (reportTab === "certs") {
    renderCertificatesReport(defaultMonth, bgys);
  } else {
    renderFarmerIdsReport(defaultMonth, bgys);
  }
}

function renderCertificatesReport(defaultMonth, bgys) {
  const body = document.getElementById("rep-body");
  body.innerHTML = `
    <div class="card">
      <div class="section-head">
        <h3>Monthly Accomplishment Report — Certificates</h3>
      </div>
      <p class="page-sub" style="margin-top:-6px">Certificates issued per barangay and per certifying officer for the month, with complete detail records ready for COA/LGU submission.</p>
      <div class="report-head">
        <div class="field"><label>Month</label>
          <input type="month" id="rep-month" value="${defaultMonth}"></div>
        ${ME.role === "admin" ? `<div class="field"><label>Barangay</label>
          <select id="rep-bgy">
            <option value="">All barangays</option>
            ${bgys.map((b) => `<option value="${b.id}">${esc(b.name)}</option>`).join("")}
          </select></div>` : ""}
        <button class="btn btn-primary" id="rep-preview">Preview</button>
        <a class="btn btn-success" id="rep-pdf" href="#">⬇ Download PDF</a>
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
        <p class="page-sub">The PDF download contains the full formatted report with signature blocks for submission.</p>`;
    } catch (err) {
      out.innerHTML = `<div class="notice warn">${esc(err.message)}</div>`;
    }
  });
  document.getElementById("rep-month").addEventListener("change", syncPdf);
  const sel = document.getElementById("rep-bgy");
  if (sel) sel.addEventListener("change", syncPdf);
  syncPdf();
}

function renderFarmerIdsReport(defaultMonth, bgys) {
  const body = document.getElementById("rep-body");
  body.innerHTML = `
    <div class="card">
      <div class="section-head">
        <h3>Generated Farmers ID Report</h3>
      </div>
      <p class="page-sub" style="margin-top:-6px">Accomplishment report of official Farmer's ID cards generated, reprinted/regenerated, and printed per barangay and Affiliated FCA.</p>
      <div class="report-head" style="flex-wrap:wrap">
        <div class="field"><label>Month (optional)</label>
          <input type="month" id="repid-month" value="${defaultMonth}"></div>
        <div class="field"><label>From</label>
          <input type="date" id="repid-from"></div>
        <div class="field"><label>To</label>
          <input type="date" id="repid-to"></div>
        ${ME.role === "admin" ? `<div class="field"><label>Barangay</label>
          <select id="repid-bgy">
            <option value="">All barangays</option>
            ${bgys.map((b) => `<option value="${b.id}">${esc(b.name)}</option>`).join("")}
          </select></div>` : ""}
        <button class="btn btn-primary" id="repid-preview">Preview</button>
        <a class="btn btn-success" id="repid-pdf" href="#">⬇ Download PDF</a>
        <a class="btn" id="repid-csv" href="#" style="background:#047857;color:#fff;border:none">⬇ Download CSV</a>
      </div>
      <div id="repid-output">
        <div class="chart-empty">Choose period or click Preview to generate report.</div>
      </div>
    </div>`;

  function qsId() {
    const p = new URLSearchParams();
    const fromVal = document.getElementById("repid-from")?.value;
    const toVal = document.getElementById("repid-to")?.value;
    const mVal = document.getElementById("repid-month")?.value;
    if (fromVal && toVal) {
      p.set("from", fromVal);
      p.set("to", toVal);
    } else if (mVal) {
      p.set("month", mVal);
    }
    const sel = document.getElementById("repid-bgy");
    if (sel && sel.value) p.set("barangay_id", sel.value);
    return p;
  }

  function syncIdLinks() {
    const q = qsId().toString();
    const pdfBtn = document.getElementById("repid-pdf");
    if (pdfBtn) pdfBtn.href = `/api/reports/farmer-ids/pdf?${q}`;
    const csvBtn = document.getElementById("repid-csv");
    if (csvBtn) csvBtn.href = `/api/reports/farmer-ids/csv?${q}`;
  }

  bind("repid-preview", "click", async () => {
    const out = document.getElementById("repid-output");
    out.innerHTML = `<div class="loading">Generating Farmers ID report…</div>`;
    syncIdLinks();
    try {
      const p = await api("/api/reports/farmer-ids?" + qsId().toString());
      out.innerHTML = `
        <div class="kpi-row">
          <div class="kpi"><div class="num">${p.total_issued}</div>
            <div class="lbl">Total IDs Generated</div></div>
          <div class="kpi"><div class="num">${p.total_active}</div>
            <div class="lbl">Active IDs</div></div>
          <div class="kpi"><div class="num">${p.total_reprints}</div>
            <div class="lbl">Regenerations</div></div>
          <div class="kpi"><div class="num">${p.total_printed}</div>
            <div class="lbl">Tagged Printed</div></div>
        </div>
        <div class="grid-2">
          <div><h3>Distribution by Barangay</h3>
            <table class="table">
              <thead><tr><th>Barangay</th><th>IDs Generated</th></tr></thead>
              <tbody>${p.by_barangay.map((b) =>
                `<tr><td>${esc(b.name)}</td><td><b>${b.count}</b></td></tr>`).join("")
                || `<tr><td colspan="2" class="empty">No records</td></tr>`}</tbody>
            </table></div>
          <div><h3>Distribution by Affiliated FCA</h3>
            <table class="table">
              <thead><tr><th>Affiliated FCA</th><th>IDs Generated</th></tr></thead>
              <tbody>${p.by_fca.map((f) =>
                `<tr><td>${esc(f.name)}</td><td><b>${f.count}</b></td></tr>`).join("")
                || `<tr><td colspan="2" class="empty">No records</td></tr>`}</tbody>
            </table></div>
        </div>
        <h3 style="margin-top:16px">Generated Farmer IDs List — ${p.rows.length} record${p.rows.length === 1 ? "" : "s"}</h3>
        <div class="table-wrap"><table class="table">
          <thead><tr>
            <th>Control No.</th><th>Farmer Name</th><th>RSBSA No.</th><th>Gender</th>
            <th>Barangay</th><th>Affiliated FCA</th><th>Issued Date</th><th>Valid Until</th><th>Printed?</th>
          </tr></thead>
          <tbody>${p.rows.map((r) => `<tr>
            <td class="mono"><b>${esc(r.control_no)}</b></td>
            <td><b>${esc(r.name || "—")}</b></td>
            <td class="mono">${esc(r.rsbsa_number || "—")}</td>
            <td>${esc(r.gender || "—")}</td>
            <td>${esc(r.barangay || "—")}</td>
            <td>${esc(r.affiliated_fca || "—")}</td>
            <td>${fmtD(r.issued_at)}</td>
            <td>${fmtD(r.valid_until)}</td>
            <td>${r.is_printed
              ? `<span class="badge approved">✓ Printed</span>`
              : `<span class="badge neutral">— Not yet</span>`}</td>
          </tr>`).join("")
          || `<tr><td colspan="9" class="empty">No farmer IDs found for this period.</td></tr>`}</tbody>
        </table></div>
        <p class="page-sub">The PDF download contains the full formatted report with official header and signature blocks ready for submission.</p>`;
    } catch (err) {
      out.innerHTML = `<div class="notice warn">${esc(err.message)}</div>`;
    }
  });

  ["repid-month", "repid-from", "repid-to"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener("change", syncIdLinks);
  });
  const selBgy = document.getElementById("repid-bgy");
  if (selBgy) selBgy.addEventListener("change", syncIdLinks);
  syncIdLinks();
}

let adminTab = "barangays";

async function viewAdmin() {
  const tabs = [
    ["barangays", "Barangays"],
    ["users", "Secretaries & Accounts"],
    ["fcas", "Affiliated FCAs"],
    ["databases", "Update the Databases"],
    ["templates", "Templates"],
    ["settings", "Settings"],
  ];
  $app.innerHTML = `
    <div class="page-title">Administration</div>
    <p class="page-sub">Manage barangays, secretary accounts, Affiliated FCAs,
       database synchronization, certification templates, and office settings.</p>
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
  if (adminTab === "databases") return adminDatabases();
  if (adminTab === "templates") return adminTemplates();
  return adminSettings();
}

async function adminDatabases() {
  const body = document.getElementById("adm-body");
  body.innerHTML = `
    <div class="card">
      <div class="section-head" style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
        <h3>Update the Databases</h3>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <a class="btn" href="/api/id-generator/template.csv">⬇ Download CSV Template</a>
          <button class="btn" id="db-sync-masterlist" type="button">🔄 Sync Masterlist from ID Database</button>
        </div>
      </div>
      <p class="page-sub">Upload a master CSV file to populate or update <b>both the Farmer Masterlist and the ID Generator database</b> at the same time.</p>
      
      <div class="notice" style="margin-bottom:16px">
        <b>Deduplication &amp; Verification Rules:</b>
        <ul style="margin:6px 0 0 18px;padding:0">
          <li>Rows are matched by <b>RSBSA Number</b>. Duplicates within the database or file are automatically detected so duplicate farmer profiles are never created.</li>
          <li>Every farmer recorded or updated via this CSV upload is automatically tagged with <b>Verification Status: VERIFIED</b>.</li>
          <li>For existing records, updated details (Remarks, Gender, Birthdate, Barangay, FCA) are synchronized.</li>
        </ul>
      </div>

      <form id="db-upload-form" class="filters" style="align-items:flex-end">
        <div class="field" style="flex:1;min-width:240px">
          <label>Select CSV File (.csv)</label>
          <input type="file" id="db-csv-file" accept=".csv,text/csv" required>
        </div>
        <button class="btn btn-primary" type="submit" id="db-upload-btn">Upload &amp; Update Databases</button>
      </form>
      <div id="db-import-result"></div>

      <div class="help" style="margin-top:16px;line-height:1.5">
        <b>Supported CSV Columns:</b> <code>RSBSA Number</code>, <code>Farmer Name</code>, <code>Gender</code>, <code>Civil Status</code>, <code>Address</code>, <code>Barangay</code>, <code>Remarks</code>, <code>Birthdate</code> (YYYY-MM-DD), <code>Contact Number</code>, <code>Emergency Contact</code>, <code>Affiliated FCA</code>.<br>
        <i>Remarks can be: Active, Deceased, No Farm, OFW, Working in other Province, Severely Sick, Bedridden.</i>
      </div>
    </div>
  `;

  bind("db-sync-masterlist", "click", async () => {
    const btn = document.getElementById("db-sync-masterlist");
    btn.disabled = true;
    btn.textContent = "Syncing…";
    try {
      const res = await api("/api/farmers/sync-from-id-db", { method: "POST" });
      toast(`Synchronized: ${res.synced} added/verified in Masterlist (${res.skipped} already verified).`);
    } catch (err) {
      toast(err.message, "err");
    } finally {
      btn.disabled = false;
      btn.textContent = "🔄 Sync Masterlist from ID Database";
    }
  });

  bind("db-upload-form", "submit", async (e) => {
    e.preventDefault();
    const fileInput = document.getElementById("db-csv-file");
    const file = fileInput.files && fileInput.files[0];
    if (!file) {
      toast("Please select a CSV file to upload.", "err");
      return;
    }
    const btn = document.getElementById("db-upload-btn");
    btn.disabled = true;
    btn.textContent = "Processing CSV…";
    const resultBox = document.getElementById("db-import-result");
    resultBox.innerHTML = `<div class="loading">Importing and synchronizing records…</div>`;

    try {
      const fd = new FormData();
      fd.append("file", file);
      const r = await api("/api/id-generator/import-csv", { method: "POST", form: fd });
      const detail = [
        ...(r.duplicate_rows || []).map((d) =>
          `Row ${d.row}: existing/duplicate RSBSA ${esc(d.rsbsa)} (${esc(d.name)}) — synchronized &amp; verified`),
        ...(r.invalid_rows || []).map((d) =>
          `Row ${d.row}: ${esc(d.reason)}`),
      ].slice(0, 15);

      resultBox.innerHTML = `
        <div class="notice" style="margin-top:14px;background:#f0fdf4;border-color:#86efac;color:#166534">
          <div style="font-weight:700;font-size:15px;margin-bottom:4px">✓ Databases Successfully Updated</div>
          <div><b>${r.added}</b> new record(s) inserted · <b>${r.duplicates}</b> existing record(s) verified &amp; synchronized · <b>${r.invalid}</b> invalid row(s) skipped.</div>
          <div class="small" style="margin-top:4px">All records have been synchronized to both the ID Database and the Farmer Masterlist with status <b>VERIFIED</b>.</div>
          ${detail.length ? `<div class="small muted" style="margin-top:8px;max-height:180px;overflow:auto">${detail.join("<br>")}</div>` : ""}
        </div>
      `;
      toast(`Databases updated: ${r.added} added, ${r.duplicates} synchronized.`);
      fileInput.value = "";
    } catch (err) {
      resultBox.innerHTML = `<div class="notice warn" style="margin-top:14px">${esc(err.message)}</div>`;
      toast(err.message, "err");
    } finally {
      btn.disabled = false;
      btn.textContent = "Upload & Update Databases";
    }
  });
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
            <div style="display:flex;gap:8px;flex-wrap:wrap">
              <button class="btn btn-sm btn-primary" data-schema="${t.id}">🛠 Dynamic Schema Builder</button>
              <button class="btn btn-sm" data-edit="${t.id}">Quick edit</button>
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

  document.querySelectorAll("[data-schema]").forEach((btn) =>
    btn.addEventListener("click", () => {
      const t = tpls.find((x) => x.id === Number(btn.dataset.schema));
      openDynamicSchemaBuilder(t, adminTemplates);
    }));

  document.querySelectorAll("[data-edit]").forEach((btn) =>
    btn.addEventListener("click", () => {
      const t = tpls.find((x) => x.id === Number(btn.dataset.edit));
      fieldsModal(t, adminTemplates);
    }));
}

const AGRICULTURAL_PRESETS = [
  {
    name: "Crop Commodity (Pananim)",
    field: {
      key: "CROP_COMMODITY",
      label: "Crop Commodity (Pananim)",
      type: "select",
      options: ["Rice/Palay", "Corn", "High-value crops", "Tobacco"],
      required: true,
      system: false,
      placeholder: "",
      default_value: "Rice/Palay",
      help: "Select crop commodity for certification",
    },
  },
  {
    name: "Farm Area in Hectares (Sukat ng Sakahan)",
    field: {
      key: "FARM_AREA",
      label: "Farm Area (Hectares)",
      type: "number",
      options: [],
      required: true,
      system: false,
      placeholder: "e.g. 1.25",
      default_value: "",
      help: "Total area cultivated in hectares",
    },
  },
  {
    name: "Tenurial Status (Katayuan sa Lupa)",
    field: {
      key: "TENURIAL_STATUS",
      label: "Tenurial Status (Katayuan sa Lupa)",
      type: "select",
      options: ["Owner", "Tenant", "Lessee", "Agrarian Reform Beneficiary (ARB)"],
      required: true,
      system: false,
      placeholder: "",
      default_value: "Owner",
      help: "Ownership or tenancy status of farm parcel",
    },
  },
  {
    name: "Parcel Location (Sitio/Purok/Barangay)",
    field: {
      key: "PARCEL_LOCATION",
      label: "Parcel Location (Lokasyon ng Parsela)",
      type: "text",
      options: [],
      required: true,
      system: false,
      placeholder: "e.g. Sitio Centro, Purok 3",
      default_value: "",
      help: "Specific location of parcel",
    },
  },
  {
    name: "Variety / Strain (Uri / Barayti)",
    field: {
      key: "VARIETY",
      label: "Crop Variety / Strain",
      type: "text",
      options: [],
      required: false,
      system: false,
      placeholder: "e.g. NSIC Rc 222, Pioneer 3561",
      default_value: "",
      help: "Planted seed variety or strain",
    },
  },
  {
    name: "Estimated Harvest (Tinatayang Ani)",
    field: {
      key: "ESTIMATED_HARVEST",
      label: "Estimated Harvest / Yield",
      type: "text",
      options: [],
      required: false,
      system: false,
      placeholder: "e.g. 80 cavans / 4 metric tons",
      default_value: "",
      help: "Expected harvest volume",
    },
  },
  {
    name: "Purpose of Certification (Layunin)",
    field: {
      key: "PURPOSE",
      label: "Purpose of Certification",
      type: "select",
      options: ["Loan Application", "PCIC Crop Insurance", "Fuel Subsidy", "Fertilizer Subsidy", "Calamity Assistance", "Registry Verification"],
      required: true,
      system: false,
      placeholder: "",
      default_value: "Loan Application",
      help: "Official purpose for this issuance",
    },
  },
  {
    name: "Cause of Damage (Dahilan ng Pagkasira)",
    field: {
      key: "DAMAGE_CAUSE",
      label: "Cause of Damage (Dahilan ng Pagkasira)",
      type: "select",
      options: ["Typhoon / Flood", "Drought / El Niño", "Pest Infestation", "Plant Disease"],
      required: false,
      system: false,
      placeholder: "",
      default_value: "Typhoon / Flood",
      help: "Required for Calamity / Damage certifications",
    },
  },
  {
    name: "Official Receipt Number (OR Number)",
    field: {
      key: "OR_NUMBER",
      label: "Official Receipt (OR) Number",
      type: "text",
      options: [],
      required: false,
      system: true,
      placeholder: "",
      default_value: "",
      help: "Leaves a blank line for Municipal Treasurer's OR stamp",
    },
  },
  {
    name: "Issuance Timestamp (Date & Time)",
    field: {
      key: "GENERATED_TIMESTAMP",
      label: "Issuance Timestamp",
      type: "text",
      options: [],
      required: false,
      system: true,
      placeholder: "",
      default_value: "",
      help: "Auto-stamped issuance date & time",
    },
  },
];

function openDynamicSchemaBuilder(t, onSaved) {
  let fields = (t.fields || []).map((f) => ({
    key: f.key || "",
    label: f.label || f.key || "",
    type: f.type || "text",
    required: !!f.required,
    system: !!f.system,
    help: f.help || "",
    placeholder: f.placeholder || "",
    default_value: f.default_value || "",
    options: Array.isArray(f.options) ? [...f.options] : (typeof f.options === "string" ? f.options.split(",").map((s) => s.trim()).filter(Boolean) : []),
  }));

  showModal(`
    <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:12px;gap:12px;flex-wrap:wrap">
      <div>
        <h3 style="margin:0 0 4px">🛠 Dynamic Schema Builder — ${esc(t.name)}</h3>
        <p class="page-sub" style="margin:0">
          Configure placeholders, input controls, dropdown options, and validation rules with live preview.
        </p>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        <button class="btn btn-sm btn-primary" id="sb-add-field" type="button">➕ Add Field</button>
        <div style="position:relative;display:inline-block">
          <button class="btn btn-sm" id="sb-preset-btn" type="button">🌾 Insert Preset ▾</button>
          <div id="sb-preset-menu" style="display:none;position:absolute;right:0;top:100%;background:#fff;border:1px solid var(--border);border-radius:8px;box-shadow:0 6px 18px rgba(0,0,0,0.15);z-index:100;min-width:280px;padding:6px 0;margin-top:4px;max-height:320px;overflow-y:auto">
            ${AGRICULTURAL_PRESETS.map((p, pi) => `
              <div class="preset-item" data-pi="${pi}" style="padding:8px 12px;font-size:12.5px;cursor:pointer;border-bottom:1px solid #f1f5f9;display:flex;justify-content:space-between;align-items:center">
                <div>
                  <div style="font-weight:600;color:#1e293b">${esc(p.name)}</div>
                  <div style="font-size:11px;color:var(--muted);font-family:monospace">{{${p.field.key}}} (${p.field.type})</div>
                </div>
                <span class="badge ${p.field.system ? 'blue' : 'neutral'}" style="font-size:10px">${p.field.system ? 'System' : 'Input'}</span>
              </div>
            `).join("")}
          </div>
        </div>
        <button class="btn btn-sm" id="sb-rescan" type="button" title="Scan actual .docx file on disk to discover unconfigured placeholders">🔍 Re-scan Word DOCX</button>
      </div>
    </div>

    <div class="schema-builder-layout">
      <div class="schema-editor-col" id="sb-editor-col"></div>
      <div class="schema-preview-col" id="sb-preview-col"></div>
    </div>

    <div class="modal-actions" style="margin-top:16px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px">
      <div id="sb-status-bar" class="page-sub" style="margin:0"></div>
      <div style="display:flex;gap:8px">
        <button class="btn" id="sb-cancel" type="button">Cancel</button>
        <button class="btn btn-primary" id="sb-save" type="button">💾 Save Schema</button>
      </div>
    </div>`, 1080);

  function updateStatusBar() {
    const sb = document.getElementById("sb-status-bar");
    if (!sb) return;
    const userCount = fields.filter((f) => !f.system).length;
    const sysCount = fields.filter((f) => f.system).length;
    sb.innerHTML = `<b>${fields.length}</b> total fields &middot; <b>${userCount}</b> input fields &middot; <b>${sysCount}</b> system auto-filled`;
  }

  function updatePreview() {
    const pCol = document.getElementById("sb-preview-col");
    if (!pCol) return;
    const userFields = fields.filter((f) => !f.system);
    const systemFields = fields.filter((f) => f.system);

    pCol.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;padding-bottom:8px;border-bottom:1px solid #e2e8f0">
        <div>
          <h4 style="margin:0;font-size:14px;font-weight:700">📱 Live Interactive Form Preview</h4>
          <span class="small" style="color:var(--muted)">Simulates how secretaries &amp; farmers will see Step 3</span>
        </div>
        <span class="badge blue">${fields.length} placeholders</span>
      </div>

      ${systemFields.length ? `
        <div style="background:#e0f2fe;border:1px solid #bae6fd;border-radius:6px;padding:8px 10px;margin-bottom:14px">
          <div style="font-size:11px;font-weight:700;color:#0369a1;text-transform:uppercase;margin-bottom:4px">
            ⚡ Auto-Filled System Placeholders (${systemFields.length})
          </div>
          <div style="display:flex;gap:4px;flex-wrap:wrap">
            ${systemFields.map((sf) => `<span class="badge blue" style="font-size:11px">{{${esc(sf.key)}}}</span>`).join("")}
          </div>
        </div>` : ""}

      <div style="background:#fff;border:1px solid var(--border);border-radius:8px;padding:14px;box-shadow:0 1px 4px rgba(0,0,0,0.05)">
        <h4 style="margin:0 0 12px;font-size:14px;border-bottom:1px solid #f1f5f9;padding-bottom:6px">
          Entry 1 (Parsela 1) — ${esc(t.name)}
        </h4>

        ${userFields.length === 0 ? `
          <div style="text-align:center;padding:24px 8px;color:var(--muted);font-size:13px">
            No user input fields configured yet. Add fields or insert presets on the left.
          </div>` : userFields.map((f) => {
            const req = f.required ? `<span class="req" style="color:#dc2626">*</span>` : "";
            const help = f.help ? `<div class="help" style="font-size:11px;color:var(--muted);margin-top:2px">${esc(f.help)}</div>` : "";
            let input = "";
            const opts = Array.isArray(f.options) ? f.options : (typeof f.options === "string" ? f.options.split(",").map((s) => s.trim()).filter(Boolean) : []);

            if (f.type === "select") {
              input = `
                <select style="width:100%;padding:6px 8px;border:1px solid var(--border);border-radius:6px;font-size:13px">
                  <option value="">— Select ${esc(f.label || f.key)} —</option>
                  ${opts.map((o) => `<option value="${esc(o)}" ${f.default_value === o ? 'selected' : ''}>${esc(o)}</option>`).join("")}
                </select>`;
            } else if (f.type === "radio" && opts.length) {
              input = `
                <div style="display:flex;gap:12px;flex-wrap:wrap;margin-top:4px">
                  ${opts.map((o, oi) => `
                    <label style="display:inline-flex;align-items:center;gap:5px;font-size:12.5px;cursor:pointer">
                      <input type="radio" name="preview_${esc(f.key)}" value="${esc(o)}" ${(oi === 0 && !f.default_value) || f.default_value === o ? 'checked' : ''}>
                      <span>${esc(o)}</span>
                    </label>`).join("")}
                </div>`;
            } else if (f.type === "textarea") {
              input = `<textarea rows="2" style="width:100%;padding:6px 8px;border:1px solid var(--border);border-radius:6px;font-size:13px" placeholder="${esc(f.placeholder || "")}">${esc(f.default_value || "")}</textarea>`;
            } else if (f.type === "date") {
              input = `<input type="date" style="width:100%;padding:6px 8px;border:1px solid var(--border);border-radius:6px;font-size:13px" value="${esc(f.default_value || "")}">`;
            } else if (f.type === "number") {
              input = `<input type="number" step="any" style="width:100%;padding:6px 8px;border:1px solid var(--border);border-radius:6px;font-size:13px" placeholder="${esc(f.placeholder || "")}" value="${esc(f.default_value || "")}">`;
            } else if (f.type === "checkbox") {
              input = `
                <label style="display:inline-flex;align-items:center;gap:8px;margin-top:4px;cursor:pointer;font-size:13px">
                  <input type="checkbox" ${f.default_value ? 'checked' : ''}>
                  <span>${esc(f.placeholder || "Yes / Approved")}</span>
                </label>`;
            } else {
              input = `<input type="text" style="width:100%;padding:6px 8px;border:1px solid var(--border);border-radius:6px;font-size:13px" placeholder="${esc(f.placeholder || "")}" value="${esc(f.default_value || "")}">`;
            }

            return `
              <div style="margin-bottom:12px">
                <label style="display:block;font-size:12px;font-weight:600;margin-bottom:4px;color:#1e293b">
                  ${esc(f.label || f.key)} ${req}
                  <code style="font-size:10px;color:var(--muted);font-weight:400;margin-left:4px">{{${esc(f.key)}}}</code>
                </label>
                ${input}
                ${help}
              </div>
            `;
          }).join("")}
      </div>
    `;
  }

  function renderCards() {
    const col = document.getElementById("sb-editor-col");
    if (!col) return;
    if (!fields.length) {
      col.innerHTML = `
        <div class="empty" style="padding:32px 16px;text-align:center">
          <p>No placeholders configured yet.</p>
          <button class="btn btn-sm btn-primary" id="sb-empty-add">+ Add your first field</button>
        </div>`;
      updatePreview();
      updateStatusBar();
      return;
    }

    col.innerHTML = fields.map((f, i) => {
      const isSys = !!f.system;
      const isFirst = i === 0;
      const isLast = i === fields.length - 1;
      const optsStr = Array.isArray(f.options) ? f.options.join(", ") : (f.options || "");
      const showOpts = f.type === "select" || f.type === "radio";

      return `
        <div class="schema-field-card ${isSys ? 'system-field' : ''}" data-idx="${i}">
          <div class="schema-field-head">
            <div style="display:flex;align-items:center;gap:6px">
              <button class="page-btn btn-icon-sm" data-action="up" data-idx="${i}" ${isFirst ? 'disabled' : ''} title="Move up">▲</button>
              <button class="page-btn btn-icon-sm" data-action="down" data-idx="${i}" ${isLast ? 'disabled' : ''} title="Move down">▼</button>
              <span class="badge ${isSys ? 'blue' : 'neutral'}" style="font-family:monospace;font-size:12px;font-weight:700">
                {{${esc(f.key || 'FIELD')}}}
              </span>
              ${isSys ? '<span class="badge blue">System Auto</span>' : '<span class="badge green">User Input</span>'}
              ${f.required ? '<span class="badge" style="background:#fee2e2;color:#b91c1c;border-color:#fca5a5">Required</span>' : ''}
            </div>
            <div>
              <button class="btn btn-sm btn-danger btn-icon-sm" data-action="delete" data-idx="${i}" title="Delete field">🗑 Delete</button>
            </div>
          </div>

          <div class="schema-grid-3">
            <div class="field">
              <label>Placeholder Key</label>
              <input class="caps" data-k="key" data-idx="${i}" value="${esc(f.key || '')}" placeholder="e.g. CROP_COMMODITY">
            </div>
            <div class="field">
              <label>Field Label (Tagalog/English)</label>
              <input data-k="label" data-idx="${i}" value="${esc(f.label || '')}" placeholder="e.g. Crop Commodity (Pananim)">
            </div>
            <div class="field">
              <label>Control Type</label>
              <select data-k="type" data-idx="${i}">
                <option value="text" ${f.type === 'text' ? 'selected' : ''}>Text (Single line)</option>
                <option value="textarea" ${f.type === 'textarea' ? 'selected' : ''}>Textarea (Multi-line)</option>
                <option value="number" ${f.type === 'number' ? 'selected' : ''}>Number / Decimal</option>
                <option value="date" ${f.type === 'date' ? 'selected' : ''}>Date picker</option>
                <option value="select" ${f.type === 'select' ? 'selected' : ''}>Select Dropdown</option>
                <option value="radio" ${f.type === 'radio' ? 'selected' : ''}>Radio Buttons</option>
                <option value="checkbox" ${f.type === 'checkbox' ? 'selected' : ''}>Checkbox Toggle</option>
              </select>
            </div>
          </div>

          <div class="field" style="margin-bottom:8px;${showOpts ? '' : 'display:none'}" id="opts-wrap-${i}">
            <label>Dropdown / Radio Options (comma-separated)</label>
            <input data-k="options" data-idx="${i}" value="${esc(optsStr)}" placeholder="e.g. Rice/Palay, Corn, High-value crops, Tobacco">
          </div>

          <div class="schema-grid-2">
            <div class="field">
              <label>Placeholder Hint</label>
              <input data-k="placeholder" data-idx="${i}" value="${esc(f.placeholder || '')}" placeholder="e.g. e.g. NSIC Rc 222">
            </div>
            <div class="field">
              <label>Default Value</label>
              <input data-k="default_value" data-idx="${i}" value="${esc(f.default_value || '')}" placeholder="e.g. Active or Rice/Palay">
            </div>
          </div>

          <div class="field" style="margin-bottom:8px">
            <label>Help Note</label>
            <input data-k="help" data-idx="${i}" value="${esc(f.help || '')}" placeholder="Instructions displayed below the field on the farmer form">
          </div>

          <div class="schema-toggles">
            <label>
              <input type="checkbox" data-k="required" data-idx="${i}" ${f.required ? 'checked' : ''}>
              <span>Mandatory (Required *)</span>
            </label>
            <label>
              <input type="checkbox" data-k="system" data-idx="${i}" ${isSys ? 'checked' : ''}>
              <span>System placeholder (Auto-generated by server / office settings / date)</span>
            </label>
          </div>
        </div>
      `;
    }).join("");

    updatePreview();
    updateStatusBar();
  }

  renderCards();

  const editorCol = document.getElementById("sb-editor-col");
  if (editorCol) {
    editorCol.addEventListener("click", (e) => {
      const actBtn = e.target.closest("[data-action]");
      if (actBtn) {
        const act = actBtn.dataset.action;
        const idx = Number(actBtn.dataset.idx);
        if (isNaN(idx) || !fields[idx]) return;
        if (act === "up" && idx > 0) {
          const tmp = fields[idx - 1];
          fields[idx - 1] = fields[idx];
          fields[idx] = tmp;
          renderCards();
        } else if (act === "down" && idx < fields.length - 1) {
          const tmp = fields[idx + 1];
          fields[idx + 1] = fields[idx];
          fields[idx] = tmp;
          renderCards();
        } else if (act === "delete") {
          const kName = fields[idx].key || "FIELD";
          if (confirm(`Remove placeholder {{${kName}}} from this template schema?`)) {
            fields.splice(idx, 1);
            renderCards();
          }
        }
        return;
      }
      if (e.target.id === "sb-empty-add") {
        const ab = document.getElementById("sb-add-field");
        if (ab) ab.click();
      }
    });

    editorCol.addEventListener("input", (e) => {
      const target = e.target;
      const idx = Number(target.dataset.idx);
      const k = target.dataset.k;
      if (isNaN(idx) || !k || !fields[idx]) return;

      if (target.type === "checkbox") {
        fields[idx][k] = target.checked;
      } else if (k === "key") {
        const clean = target.value.toUpperCase().replace(/[^A-Z0-9_]/g, "");
        fields[idx][k] = clean;
        const card = target.closest(".schema-field-card");
        if (card) {
          const b = card.querySelector(".schema-field-head .badge");
          if (b) b.textContent = `{{${clean || 'FIELD'}}}`;
        }
      } else if (k === "options") {
        fields[idx].options = target.value.split(",").map((s) => s.trim()).filter(Boolean);
      } else {
        fields[idx][k] = target.value;
      }
      updatePreview();
      updateStatusBar();
    });

    editorCol.addEventListener("change", (e) => {
      const target = e.target;
      const idx = Number(target.dataset.idx);
      const k = target.dataset.k;
      if (isNaN(idx) || !k || !fields[idx]) return;

      if (k === "type") {
        fields[idx].type = target.value;
        const optsWrap = document.getElementById(`opts-wrap-${idx}`);
        if (optsWrap) {
          optsWrap.style.display = (target.value === "select" || target.value === "radio") ? "block" : "none";
        }
        updatePreview();
      } else if (k === "system" || k === "required") {
        renderCards();
      }
    });
  }

  // Header button handlers
  const addBtn = document.getElementById("sb-add-field");
  if (addBtn) {
    addBtn.addEventListener("click", () => {
      fields.push({
        key: `CUSTOM_FIELD_${fields.length + 1}`,
        label: `Custom Field ${fields.length + 1}`,
        type: "text",
        options: [],
        required: false,
        system: false,
        placeholder: "",
        default_value: "",
        help: "",
      });
      renderCards();
      if (editorCol) editorCol.scrollTop = editorCol.scrollHeight;
    });
  }

  // Presets dropdown
  const presetBtn = document.getElementById("sb-preset-btn");
  const presetMenu = document.getElementById("sb-preset-menu");
  if (presetBtn && presetMenu) {
    presetBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      presetMenu.style.display = presetMenu.style.display === "block" ? "none" : "block";
    });
    document.addEventListener("click", (e) => {
      if (presetMenu && !presetMenu.contains(e.target) && e.target !== presetBtn) {
        presetMenu.style.display = "none";
      }
    });
    presetMenu.querySelectorAll(".preset-item").forEach((item) => {
      item.addEventListener("click", () => {
        const pi = Number(item.dataset.pi);
        const p = AGRICULTURAL_PRESETS[pi];
        if (!p) return;
        const existIdx = fields.findIndex((x) => x.key.toUpperCase() === p.field.key.toUpperCase());
        if (existIdx >= 0) {
          if (confirm(`Placeholder {{${p.field.key}}} is already defined. Overwrite with preset configuration?`)) {
            fields[existIdx] = JSON.parse(JSON.stringify(p.field));
          }
        } else {
          fields.push(JSON.parse(JSON.stringify(p.field)));
        }
        presetMenu.style.display = "none";
        renderCards();
        toast(`Preset '${p.name}' applied.`);
      });
    });
  }

  // Re-scan Word DOCX
  const rescanBtn = document.getElementById("sb-rescan");
  if (rescanBtn) {
    rescanBtn.addEventListener("click", async () => {
      try {
        toast("Scanning Word document template...");
        const res = await api(`/api/admin/templates/${t.id}/detect-docx`, { method: "POST" });
        const detected = res.fields || [];
        let addedCount = 0;
        for (const df of detected) {
          const kUpper = (df.key || "").toUpperCase().replace(/[^A-Z0-9_]/g, "");
          if (!kUpper) continue;
          if (!fields.some((x) => x.key.toUpperCase() === kUpper)) {
            fields.push({
              key: kUpper,
              label: df.label || kUpper,
              type: df.type || "text",
              required: !!df.required,
              system: !!df.system,
              help: df.help || "",
              placeholder: "",
              default_value: "",
              options: [],
            });
            addedCount++;
          }
        }
        renderCards();
        toast(`Scan complete: ${detected.length} placeholders found in .docx (${addedCount} new added).`);
      } catch (err) {
        toast(err.message, "err");
      }
    });
  }

  // Cancel & Save
  bind("sb-cancel", "click", closeModal);
  bind("sb-save", "click", async () => {
    const payload = fields.map((f) => ({
      key: (f.key || "").trim().toUpperCase().replace(/[^A-Z0-9_]/g, ""),
      label: (f.label || "").trim() || (f.key || "FIELD"),
      type: f.type || "text",
      required: !!f.required,
      system: !!f.system,
      help: (f.help || "").trim(),
      placeholder: (f.placeholder || "").trim(),
      default_value: (f.default_value || "").trim(),
      options: Array.isArray(f.options) ? f.options : (typeof f.options === "string" ? f.options.split(",").map((s) => s.trim()).filter(Boolean) : []),
    })).filter((f) => f.key.length > 0);

    if (!payload.length) {
      toast("Please configure at least one placeholder field.", "warn");
      return;
    }

    try {
      await api(`/api/admin/templates/${t.id}`, { method: "PATCH", body: { fields: payload } });
      toast("Dynamic schema saved successfully!");
      closeModal();
      if (onSaved) onSaved();
    } catch (err) {
      toast(err.message, "err");
    }
  });
}

function fieldsModal(t, onSaved) {
  const typeSel = (v) => `
    <select data-k="type">
      ${["text", "textarea", "number", "date", "select", "radio", "checkbox"].map((x) =>
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
    <div class="modal-actions" style="display:flex;justify-content:space-between;align-items:center">
      <button class="btn btn-sm btn-primary" id="fm-open-builder" type="button">🛠 Open Dynamic Schema Builder</button>
      <div style="display:flex;gap:8px">
        <button class="btn" id="fm-cancel">Cancel</button>
        <button class="btn btn-primary" id="fm-save">Save fields</button>
      </div>
    </div>`, 760);
  bind("fm-open-builder", "click", () => {
    closeModal();
    openDynamicSchemaBuilder(t, onSaved);
  });
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
        placeholder: orig.placeholder || "",
        default_value: orig.default_value || "",
        options: orig.options || [],
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
