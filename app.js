(() => {
  "use strict";

  window.addEventListener("error", (e) => console.error("App error:", e.error || e.message));

  // Configuration
  const FILE_STORAGE_KEY = "contactbook.file.handle.v1"; // persisted FileSystemFileHandle
  const CACHE_KEY = "contactbook.contacts.cache.v4";
  const GH_CONFIG_KEY = "contactbook.github.config.v1";
  const GH_LAST_PUSHED_KEY = "contactbook.github.lastPushed.v1";
  const FILE_NAME_DEFAULT = "contacts.json";
  const SAVE_DEBOUNCE_MS = 400;
  const SEARCH_DEBOUNCE_MS = 180;
  const HAS_FS_API = "showSaveFilePicker" in window;

  const state = {
    contacts: loadContacts(),
    selectedId: null,
    editingId: null,
    searchTerm: "",
    fileHandle: null,
    fileName: null,
    saveStatus: "saved",
    saveTimer: null,
    github: loadGithubConfig(),
    lastPushed: parseInt(localStorage.getItem(GH_LAST_PUSHED_KEY) || "0", 10) || 0,
  };

  // ============================================================
  // Persistence layer
  // ============================================================
  function loadContacts() {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return [];
      const data = JSON.parse(raw);
      return Array.isArray(data) ? data.map(normalize) : [];
    } catch { return []; }
  }
  function writeCache() {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(state.contacts)); } catch {}
  }
  function normalize(c) {
    return {
      id: c.id || uid(),
      firstName: c.firstName || "",
      lastName: c.lastName || "",
      phone: c.phone || "",
      createdAt: c.createdAt || Date.now(),
      updatedAt: c.updatedAt || Date.now(),
    };
  }
  function uid() { return "c_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36); }

  // ---- File System Access API path ----
  async function pickFile(mode) {
    if (!HAS_FS_API) return null;
    const opts = {
      types: [{ description: "Contacts", accept: { "application/json": [".json"] } }],
      excludeAcceptAllOption: false,
    };
    try {
      if (mode === "save") {
        return await window.showSaveFilePicker({ ...opts, suggestedName: FILE_NAME_DEFAULT });
      }
      return await window.showOpenFilePicker(opts).then(handles => handles[0]);
    } catch (e) {
      if (e.name === "AbortError") return null;
      throw e;
    }
  }
  async function readFile(handle) {
    const file = await handle.getFile();
    const text = await file.text();
    return JSON.parse(text);
  }
  async function writeFile(handle, data) {
    const writable = await handle.createWritable();
    await writable.write(JSON.stringify(data, null, 2));
    await writable.close();
  }
  async function persistHandle(handle) {
    try { localStorage.setItem(FILE_STORAGE_KEY, handle.name || FILE_NAME_DEFAULT); } catch {}
  }
  async function restoreHandle() {
    // FileSystemFileHandle cannot be persisted across reloads without user gesture
    // unless using IndexedDB. We prompt the user on launch if cache exists but no handle.
    return null;
  }
  async function verifyPermission(handle) {
    if (!handle) return false;
    if (handle.queryPermission) {
      const opts = { mode: "readwrite" };
      if ((await handle.queryPermission(opts)) === "granted") return true;
      if ((await handle.requestPermission(opts)) === "granted") return true;
    }
    return false;
  }
  async function openOrCreateFile() {
    if (!HAS_FS_API) {
      // Fallback: trigger download of the file as the "save" mechanism
      return null;
    }
    // If there's a cached file, offer to reuse it via a re-pick (we cannot reopen without gesture)
    return new Promise((resolve) => {
      openFirstRunModal(resolve);
    });
  }
  function openFirstRunModal(resolve) {
    const modal = document.getElementById("fileSetupModal");
    const newBtn = document.getElementById("fileNewBtn");
    const openBtn = document.getElementById("fileOpenBtn");
    const skipBtn = document.getElementById("fileSkipBtn");
    modal.classList.remove("hidden");
    const cleanup = () => {
      newBtn.onclick = null; openBtn.onclick = null; skipBtn.onclick = null;
      modal.classList.add("hidden");
    };
    newBtn.onclick = async () => { cleanup(); const h = await pickFile("save"); resolve(h); };
    openBtn.onclick = async () => { cleanup(); const h = await pickFile("open"); resolve(h); };
    skipBtn.onclick = () => { cleanup(); resolve(null); };
  }

  // ============================================================
  // GitHub sync (Contents API)
  // ============================================================
  function loadGithubConfig() {
    try {
      const raw = localStorage.getItem(GH_CONFIG_KEY);
      if (!raw) return null;
      const c = JSON.parse(raw);
      return c && c.token ? c : null;
    } catch { return null; }
  }
  function saveGithubConfig(cfg) {
    try { localStorage.setItem(GH_CONFIG_KEY, JSON.stringify(cfg)); } catch {}
    state.github = cfg;
  }
  function ghConfigured() {
    return !!(state.github && state.github.token && state.github.owner && state.github.repo && state.github.branch && state.github.path);
  }
  function ghHeaders(cfg) {
    return {
      "Authorization": "Bearer " + cfg.token,
      "Accept": "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "Contacts-PWA",
    };
  }
  async function ghTest(cfg) {
    const url = `https://api.github.com/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}`;
    const res = await fetch(url, { headers: ghHeaders(cfg) });
    if (res.status === 401) throw new Error("Invalid token. Check it has 'repo' scope.");
    if (res.status === 404) throw new Error("Repository not found. Check owner and repo name.");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return data;
  }
  async function ghPush() {
    if (!ghConfigured()) { openGithubSheet(); return; }
    const cfg = state.github;
    const btn = document.getElementById("ghQuickPush");
    if (btn) btn.classList.add("pushing");
    try {
      const apiBase = `https://api.github.com/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}/contents/${encodeURIComponent(cfg.path)}`;
      // 1. Get current file SHA (if it exists)
      let sha = null;
      const head = await fetch(`${apiBase}?ref=${encodeURIComponent(cfg.branch)}`, { headers: ghHeaders(cfg) });
      if (head.ok) {
        const j = await head.json();
        sha = j.sha;
      } else if (head.status !== 404) {
        const t = await head.text();
        throw new Error(`Could not read current file (HTTP ${head.status})`);
      }
      // 2. PUT new content
      const content = btoa(unescape(encodeURIComponent(JSON.stringify(state.contacts, null, 2))));
      const body = {
        message: `contacts: update ${new Date().toISOString().slice(0, 16).replace("T", " ")}`,
        content,
        branch: cfg.branch,
      };
      if (sha) body.sha = sha;
      const put = await fetch(apiBase, {
        method: "PUT",
        headers: { ...ghHeaders(cfg), "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!put.ok) {
        const t = await put.text();
        if (put.status === 401) throw new Error("Invalid token.");
        if (put.status === 404) throw new Error("Repo or branch not found.");
        if (put.status === 409) throw new Error("Conflict — file changed on GitHub. Refresh and retry.");
        if (put.status === 422) throw new Error("Validation failed. Check branch and path.");
        throw new Error(`HTTP ${put.status}: ${t.slice(0, 100)}`);
      }
      const result = await put.json();
      state.lastPushed = Date.now();
      try { localStorage.setItem(GH_LAST_PUSHED_KEY, String(state.lastPushed)); } catch {}
      updateGhUI();
      toast(`Pushed ${state.contacts.length} contact${state.contacts.length === 1 ? "" : "s"} to ${cfg.owner}/${cfg.repo}`, "success", {
        label: "View",
        onClick: () => window.open(result.content.html_url, "_blank", "noopener"),
      });
    } catch (e) {
      console.error("GitHub push failed", e);
      toast("Push failed: " + e.message, "error");
    } finally {
      if (btn) btn.classList.remove("pushing");
    }
  }

  function openGithubSheet() {
    const sheet = document.getElementById("githubSheet");
    const form = document.getElementById("githubForm");
    sheet.classList.remove("hidden");
    document.body.style.overflow = "hidden";
    if (state.github) {
      form.elements.ghToken.value = state.github.token || "";
      form.elements.ghOwner.value = state.github.owner || "";
      form.elements.ghRepo.value = state.github.repo || "";
      form.elements.ghBranch.value = state.github.branch || "main";
      form.elements.ghPath.value = state.github.path || "contacts.json";
    } else {
      form.reset();
      form.elements.ghBranch.value = "main";
      form.elements.ghPath.value = "contacts.json";
    }
    updateGhUI();
  }
  function closeGithubSheet() {
    document.getElementById("githubSheet").classList.add("hidden");
    document.body.style.overflow = "";
  }
  function updateGhUI() {
    const lastEl = document.getElementById("ghLastPushed");
    const menuStatus = document.getElementById("githubMenuStatus");
    const quick = document.getElementById("ghQuickPush");
    if (lastEl) {
      lastEl.textContent = state.lastPushed
        ? new Date(state.lastPushed).toLocaleString()
        : "never";
    }
    const configured = ghConfigured();
    if (menuStatus) menuStatus.textContent = configured ? "Ready" : "";
    if (quick) quick.classList.toggle("hidden", !configured);
  }

  // ---- Save pipeline ----
  function scheduleSave() {
    state.saveStatus = "saving";
    updateSaveStatus();
    clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(doSave, SAVE_DEBOUNCE_MS);
  }
  async function doSave() {
    writeCache();
    if (!state.fileHandle || !HAS_FS_API) {
      state.saveStatus = "saved";
      updateSaveStatus();
      return;
    }
    try {
      if (!(await verifyPermission(state.fileHandle))) {
        state.saveStatus = "error";
        updateSaveStatus();
        toast("File permission denied. Click the file name to reconnect.", "error");
        return;
      }
      await writeFile(state.fileHandle, state.contacts);
      state.saveStatus = "saved";
      updateSaveStatus();
    } catch (e) {
      console.error("Save failed", e);
      state.saveStatus = "error";
      updateSaveStatus();
      toast("Could not save to file. Using local cache.", "error");
    }
  }
  async function flushSave() {
    clearTimeout(state.saveTimer);
    await doSave();
  }

  // ============================================================
  // DOM
  // ============================================================
  const $ = (sel) => document.querySelector(sel);
  const app = $("#app");
  const listScreen = $("#listScreen");
  const detailScreen = $("#detailScreen");
  const listEl = $("#contactList");
  const listMeta = $("#listMeta");
  const searchInput = $("#searchInput");
  const searchClear = $("#searchClear");
  const viewAvatar = $("#viewAvatar");
  const viewName = $("#viewName");
  const viewPhone = $("#viewPhone");
  const viewCallBtn = $("#viewCallBtn");
  const viewSmsBtn = $("#viewSmsBtn");
  const viewCopyBtn = $("#viewCopyBtn");
  const detailTitle = $("#detailTitle");
  const sheet = $("#sheet");
  const sheetBackdrop = $("#sheetBackdrop");
  const sheetForm = $("#sheetForm");
  const sheetTitle = $("#sheetTitle");
  const sheetCancel = $("#sheetCancel");
  const sheetSave = $("#sheetSave");
  const confirmModal = $("#confirmModal");
  const confirmTitle = $("#confirmTitle");
  const confirmMessage = $("#confirmMessage");
  const confirmOk = $("#confirmOk");
  const confirmCancel = $("#confirmCancel");
  const toastContainer = $("#toastContainer");
  const dropOverlay = $("#dropOverlay");
  const menu = $("#menu");
  const menuBtn = $("#menuBtn");
  const importFile = $("#importFile");
  const fileChip = $("#fileChip");

  // ============================================================
  // Memoized helpers
  // ============================================================
  const PALETTE = [
    "#6366f1", "#8b5cf6", "#ec4899", "#f43f5e",
    "#f97316", "#eab308", "#10b981", "#14b8a6",
    "#0ea5e9", "#3b82f6", "#a855f7", "#d946ef",
  ];
  const initialsCache = new Map();
  const colorCache = new Map();
  const fullNameCache = new WeakMap();

  function fullName(c) {
    if (!c) return "";
    let n = fullNameCache.get(c);
    if (n !== undefined) return n;
    n = [c.firstName, c.lastName].filter(Boolean).join(" ").trim() || "Unnamed";
    fullNameCache.set(c, n);
    return n;
  }
  function initials(c) {
    if (!c) return "?";
    const key = c.id;
    let v = initialsCache.get(key);
    if (v !== undefined) return v;
    const f = (c.firstName || "").trim();
    const l = (c.lastName || "").trim();
    v = ((f[0] || "") + (l[0] || "")).toUpperCase() || "?";
    initialsCache.set(key, v);
    return v;
  }
  function colorFor(name) {
    let c = colorCache.get(name);
    if (c) return c;
    let h = 0;
    for (let i = 0; i < name.length; i++) h = name.charCodeAt(i) + ((h << 5) - h);
    c = PALETTE[Math.abs(h) % PALETTE.length];
    colorCache.set(name, c);
    return c;
  }
  function paintAvatar(el, c) {
    el.textContent = initials(c);
    el.style.background = colorFor(fullName(c));
  }
  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).catch(() => fallback());
    } else fallback();
    function fallback() {
      const ta = document.createElement("textarea");
      ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); } catch {}
      ta.remove();
    }
  }
  function debounce(fn, ms) {
    let t;
    return function(...args) { clearTimeout(t); t = setTimeout(() => fn.apply(this, args), ms); };
  }

  // ============================================================
  // List rendering with event delegation
  // ============================================================
  function getFiltered() {
    const term = state.searchTerm.trim().toLowerCase();
    let list = state.contacts;
    if (term) {
      list = list.filter(c => {
        return fullName(c).toLowerCase().includes(term) || (c.phone || "").toLowerCase().includes(term);
      });
    }
    // sort by name; copy to avoid mutating state.contacts
    return [...list].sort((a, b) => fullName(a).toLowerCase().localeCompare(fullName(b).toLowerCase()));
  }

  // Delegated click handler (attached once)
  listEl.addEventListener("click", (e) => {
    const item = e.target.closest(".contact-item");
    if (!item) return;
    const id = item.dataset.id;
    if (id) openDetail(id);
  });

  function renderList() {
    const filtered = getFiltered();
    const total = state.contacts.length;
    listMeta.textContent = state.searchTerm
      ? `${filtered.length} of ${total}`
      : `${total} contact${total === 1 ? "" : "s"}`;

    if (filtered.length === 0) {
      listEl.innerHTML = renderEmptyHTML(total === 0);
      return;
    }

    // Build HTML as a single string (one layout pass)
    const parts = [];
    let lastLetter = null;
    for (let i = 0; i < filtered.length; i++) {
      const c = filtered[i];
      const name = fullName(c);
      const letter = (name[0] || "?").toUpperCase();
      if (letter !== lastLetter) {
        parts.push(`<div class="section-label">${escapeHtml(letter)}</div>`);
        lastLetter = letter;
      }
      parts.push(renderItemHTML(c, i));
    }
    listEl.innerHTML = parts.join("");
  }
  function renderItemHTML(c, i) {
    const name = escapeHtml(fullName(c));
    const phone = escapeHtml(c.phone || "—");
    const init = escapeHtml(initials(c));
    const color = colorFor(fullName(c));
    return `<div class="contact-item${c.id === state.selectedId ? " selected" : ""}" data-id="${c.id}" role="button" tabindex="0">
      <div class="avatar avatar-md" style="background:${color}">${init}</div>
      <div class="ci-text">
        <span class="ci-name">${name}</span>
        <span class="ci-sub">${phone}</span>
      </div>
    </div>`;
  }
  function renderEmptyHTML(noContacts) {
    if (noContacts) {
      return `<div class="empty-list">
        <div class="empty-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
        </div>
        <h2>No contacts yet</h2>
        <p>Tap the + button to add your first contact.</p>
      </div>`;
    }
    return `<div class="empty-list">
      <h2>No matches</h2>
      <p>Try a different search.</p>
    </div>`;
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, ch => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[ch]));
  }

  // ============================================================
  // Detail
  // ============================================================
  function openDetail(id) {
    const c = state.contacts.find(x => x.id === id);
    if (!c) return;
    state.selectedId = id;
    c.updatedAt = Date.now();
    renderDetail();
    app.classList.add("show-detail");
  }
  function closeDetail() {
    app.classList.remove("show-detail");
    state.selectedId = null;
  }
  function renderDetail() {
    const c = state.contacts.find(x => x.id === state.selectedId);
    if (!c) return;
    paintAvatar(viewAvatar, c);
    const name = fullName(c);
    viewName.textContent = name;
    detailTitle.textContent = name;
    viewPhone.textContent = c.phone || "—";
    const dial = c.phone ? c.phone.replace(/[^\d+]/g, "") : "";
    viewCallBtn.href = dial ? `tel:${dial}` : "#";
    viewSmsBtn.href = dial ? `sms:${dial}` : "#";
    viewCallBtn.classList.toggle("disabled", !dial);
    viewSmsBtn.classList.toggle("disabled", !dial);
    // Update active item in list without full re-render
    const prev = listEl.querySelector(".contact-item.selected");
    if (prev) prev.classList.remove("selected");
    const next = listEl.querySelector(`.contact-item[data-id="${c.id}"]`);
    if (next) next.classList.add("selected");
  }

  // ============================================================
  // Sheet (add / edit)
  // ============================================================
  function openSheet(contact) {
    state.editingId = contact ? contact.id : null;
    sheetTitle.textContent = contact ? "Edit contact" : "New contact";
    sheetForm.reset();
    if (contact) {
      sheetForm.elements.firstName.value = contact.firstName || "";
      sheetForm.elements.lastName.value = contact.lastName || "";
      sheetForm.elements.phone.value = contact.phone || "";
    }
    sheet.classList.remove("hidden");
    sheetBackdrop.classList.remove("hidden");
    document.body.style.overflow = "hidden";
    setTimeout(() => sheetForm.elements.firstName.focus(), 280);
  }
  function closeSheet() {
    sheet.classList.add("hidden");
    sheetBackdrop.classList.add("hidden");
    document.body.style.overflow = "";
    state.editingId = null;
  }
  function saveSheet() {
    const fd = new FormData(sheetForm);
    const firstName = (fd.get("firstName") || "").toString().trim();
    const lastName = (fd.get("lastName") || "").toString().trim();
    const phone = (fd.get("phone") || "").toString().trim();
    if (!firstName) { shake(sheetForm.elements.firstName); sheetForm.elements.firstName.focus(); return; }
    if (!phone)     { shake(sheetForm.elements.phone);     sheetForm.elements.phone.focus();     return; }
    if (state.editingId) {
      const i = state.contacts.findIndex(c => c.id === state.editingId);
      if (i >= 0) {
        state.contacts[i] = { ...state.contacts[i], firstName, lastName, phone, updatedAt: Date.now() };
        toast("Contact updated", "success");
      }
    } else {
      const newC = { id: uid(), firstName, lastName, phone, createdAt: Date.now(), updatedAt: Date.now() };
      state.contacts.push(newC);
      state.selectedId = newC.id;
      toast("Contact added", "success");
    }
    persist();
    renderList();
    closeSheet();
    if (state.selectedId) renderDetail();
  }
  function shake(el) {
    el.style.transition = "transform 60ms";
    let i = 0;
    const seq = [0, -8, 8, -6, 6, -3, 3, 0];
    function step() {
      if (i >= seq.length) { el.style.transform = ""; el.style.transition = ""; return; }
      el.style.transform = `translateX(${seq[i]}px)`;
      i++;
      setTimeout(step, 40);
    }
    step();
  }
  function persist() {
    writeCache();
    scheduleSave();
  }

  // ============================================================
  // Delete
  // ============================================================
  function deleteCurrent() {
    const c = state.contacts.find(x => x.id === state.selectedId);
    if (!c) return;
    openConfirm({
      title: "Delete contact?",
      message: `${fullName(c)} will be removed.`,
      okLabel: "Delete",
      onOk: () => {
        const removed = c;
        const idx = state.contacts.findIndex(x => x.id === state.selectedId);
        state.contacts.splice(idx, 1);
        persist();
        closeDetail();
        renderList();
        toast("Contact deleted", "success", {
          label: "Undo",
          onClick: () => { state.contacts.splice(idx, 0, removed); persist(); renderList(); toast("Contact restored", "success"); }
        });
      }
    });
  }

  // ============================================================
  // vCard (delegated to a Web Worker for large files)
  // ============================================================
  function escapeVcard(v) {
    if (v == null) return "";
    return String(v).replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/,/g, "\\,").replace(/;/g, "\\;");
  }
  function foldLine(line) {
    if (line.length <= 75) return line;
    const out = []; let i = 0;
    while (i < line.length) {
      const chunk = line.slice(i, i + (i === 0 ? 75 : 74));
      out.push(i === 0 ? chunk : " " + chunk);
      i += (i === 0 ? 75 : 74);
    }
    return out.join("\r\n");
  }
  function contactToVcard(c) {
    const lines = ["BEGIN:VCARD", "VERSION:3.0", "PRODID:-//Contacts//EN"];
    const n = [c.lastName || "", c.firstName || "", "", "", ""];
    lines.push(foldLine(`N:${n.map(escapeVcard).join(";")}`));
    lines.push(foldLine(`FN:${escapeVcard(fullName(c))}`));
    if (c.phone) lines.push(foldLine(`TEL;TYPE=CELL,VOICE:${escapeVcard(c.phone)}`));
    const rev = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
    lines.push(`REV:${rev}`);
    lines.push("END:VCARD");
    return lines.join("\r\n") + "\r\n";
  }
  function vcardFilename(c) { return (fullName(c).replace(/[^a-z0-9]+/gi, "_").replace(/^_+|_+$/g, "") || "contact") + ".vcf"; }
  function downloadVcard(content, filename) {
    const blob = new Blob([content], { type: "text/vcard;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 0);
  }
  function exportOne(c) { downloadVcard(contactToVcard(c), vcardFilename(c)); toast("vCard downloaded", "success"); }
  function exportAll() {
    if (state.contacts.length === 0) { toast("No contacts to export", "error"); return; }
    const content = state.contacts.map(contactToVcard).join("");
    downloadVcard(content, "contacts.vcf");
    toast(`Exported ${state.contacts.length} contact${state.contacts.length === 1 ? "" : "s"}`, "success");
  }
  function parseVcardsSync(text) {
    const unfolded = text.replace(/\r\n[ \t]/g, "").replace(/\n[ \t]/g, "");
    const lines = unfolded.split("\n");
    const cards = []; let cur = null;
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      if (!raw.trim()) continue;
      const idx = raw.indexOf(":"); if (idx === -1) continue;
      const left = raw.slice(0, idx); const value = raw.slice(idx + 1);
      const [name] = left.split(";");
      const key = name.toUpperCase();
      if (key === "BEGIN" && value.toUpperCase() === "VCARD") { cur = { phone: "" }; continue; }
      if (key === "END" && value.toUpperCase() === "VCARD") { if (cur) cards.push(cur); cur = null; continue; }
      if (!cur) continue;
      const v = value.replace(/\\n/gi, "\n").replace(/\\,/g, ",").replace(/\\;/g, ";").replace(/\\\\/g, "\\");
      if (key === "N") { const p = v.split(";"); cur.lastName = p[0] || ""; cur.firstName = p[1] || ""; }
      else if (key === "FN") { if (!cur.firstName && !cur.lastName) { const p = v.split(" "); cur.firstName = p[0] || ""; cur.lastName = p.slice(1).join(" "); } }
      else if (key === "TEL") cur.phone = v;
    }
    return cards;
  }
  function importFile2(file) {
    if (file.name.endsWith(".json")) {
      const r = new FileReader();
      r.onload = () => {
        try {
          const data = JSON.parse(r.result);
          if (!Array.isArray(data)) throw new Error("Invalid");
          let added = 0;
          for (const c of data) {
            const n = normalize(c);
            if (n.firstName || n.lastName) { state.contacts.push(n); added++; }
          }
          persist(); renderList();
          toast(`Restored ${added} contact${added === 1 ? "" : "s"}`, "success");
        } catch { toast("Invalid JSON file", "error"); }
      };
      r.readAsText(file);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const text = String(reader.result || "");
        const imported = parseVcardsSync(text);
        if (imported.length === 0) { toast("No contacts found", "error"); return; }
        let added = 0;
        for (const c of imported) { state.contacts.push(normalize(c)); added++; }
        persist(); renderList();
        toast(`Imported ${added} contact${added === 1 ? "" : "s"}`, "success");
      } catch { toast("Failed to import vCard", "error"); }
    };
    reader.readAsText(file);
  }

  // ============================================================
  // Confirm
  // ============================================================
  function openConfirm({ title, message, okLabel, onOk }) {
    confirmTitle.textContent = title; confirmMessage.textContent = message;
    confirmOk.textContent = okLabel || "OK"; confirmModal.classList.remove("hidden");
    confirmOk.onclick = () => { onOk && onOk(); closeConfirm(); };
  }
  function closeConfirm() { confirmModal.classList.add("hidden"); confirmOk.onclick = null; }

  // ============================================================
  // Toast
  // ============================================================
  function toast(msg, type, action) {
    const el = document.createElement("div");
    el.className = "toast" + (type ? " " + type : "");
    const t = document.createElement("span"); t.textContent = msg; el.appendChild(t);
    if (action) {
      const btn = document.createElement("button");
      btn.textContent = action.label;
      btn.addEventListener("click", () => { action.onClick(); el.remove(); });
      el.appendChild(btn);
    }
    toastContainer.appendChild(el);
    setTimeout(() => {
      el.style.transition = "opacity 200ms, transform 200ms";
      el.style.opacity = "0"; el.style.transform = "translate(-50%, -6px)";
      setTimeout(() => el.remove(), 220);
    }, action ? 4500 : 2200);
  }

  // ============================================================
  // Save status indicator
  // ============================================================
  function updateSaveStatus() {
    if (!fileChip) return;
    if (!state.fileHandle) {
      fileChip.classList.add("hidden");
      return;
    }
    fileChip.classList.remove("hidden");
    fileChip.classList.toggle("saving", state.saveStatus === "saving");
    fileChip.classList.toggle("error", state.saveStatus === "error");
    const text = fileChip.querySelector(".file-name");
    if (text) text.textContent = state.fileName || FILE_NAME_DEFAULT;
  }

  // ============================================================
  // Events
  // ============================================================
  $("#newContactBtn").addEventListener("click", () => openSheet(null));
  $("#backBtn").addEventListener("click", closeDetail);
  $("#deleteBtn").addEventListener("click", deleteCurrent);
  $("#editBtn").addEventListener("click", () => {
    const c = state.contacts.find(x => x.id === state.selectedId);
    if (c) openSheet(c);
  });
  $("#exportOneBtn").addEventListener("click", () => {
    const c = state.contacts.find(x => x.id === state.selectedId);
    if (c) exportOne(c);
  });
  viewCopyBtn.addEventListener("click", () => {
    const c = state.contacts.find(x => x.id === state.selectedId);
    if (c && c.phone) { copyText(c.phone); toast("Phone copied", "success"); }
  });

  sheetCancel.addEventListener("click", closeSheet);
  sheetBackdrop.addEventListener("click", closeSheet);
  sheetSave.addEventListener("click", saveSheet);
  sheetForm.addEventListener("submit", (e) => { e.preventDefault(); saveSheet(); });
  sheetForm.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); saveSheet(); }
  });

  // Debounced search
  const debouncedRender = debounce(() => renderList(), SEARCH_DEBOUNCE_MS);
  searchInput.addEventListener("input", (e) => {
    state.searchTerm = e.target.value;
    searchClear.classList.toggle("hidden", !state.searchTerm);
    debouncedRender();
  });
  searchClear.addEventListener("click", () => {
    state.searchTerm = "";
    searchInput.value = "";
    searchClear.classList.add("hidden");
    searchInput.focus();
    renderList();
  });

  confirmCancel.addEventListener("click", closeConfirm);
  confirmModal.addEventListener("click", (e) => { if (e.target === confirmModal) closeConfirm(); });

  // Menu
  menuBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const r = menuBtn.getBoundingClientRect();
    menu.style.top = (r.bottom + 8) + "px";
    menu.style.right = (window.innerWidth - r.right) + "px";
    menu.style.left = "auto";
    menu.classList.toggle("hidden");
  });
  document.addEventListener("click", (e) => {
    if (!menu.contains(e.target) && e.target !== menuBtn && !menuBtn.contains(e.target)) menu.classList.add("hidden");
  });
  menu.querySelectorAll("button").forEach(btn => {
    btn.addEventListener("click", async () => {
      menu.classList.add("hidden");
      const a = btn.dataset.action;
      if (a === "import") importFile.click();
      else if (a === "exportAll") exportAll();
      else if (a === "saveAs") await chooseFile("save");
      else if (a === "openFile") await chooseFile("open");
      else if (a === "github") openGithubSheet();
      else if (a === "backup") {
        const blob = new Blob([JSON.stringify(state.contacts, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const el = document.createElement("a"); el.href = url; el.download = "contacts-backup.json";
        document.body.appendChild(el); el.click();
        setTimeout(() => { URL.revokeObjectURL(url); el.remove(); }, 0);
        toast("Backup downloaded", "success");
      } else if (a === "wipe") {
        openConfirm({
          title: "Delete all contacts?",
          message: `This will remove all ${state.contacts.length} contact${state.contacts.length === 1 ? "" : "s"}.`,
          okLabel: "Delete all",
          onOk: () => {
            const backup = state.contacts;
            state.contacts = []; persist(); renderList();
            toast(`Deleted ${backup.length}`, "success", {
              label: "Undo",
              onClick: () => { state.contacts = backup; persist(); renderList(); toast("Restored", "success"); }
            });
          }
        });
      }
    });
  });

  async function chooseFile(mode) {
    if (!HAS_FS_API) {
      toast("Your browser doesn't support file system access. Use Backup/Restore instead.", "error");
      return;
    }
    try {
      const handle = await pickFile(mode);
      if (!handle) return;
      if (mode === "save") {
        state.fileHandle = handle;
        state.fileName = handle.name || FILE_NAME_DEFAULT;
        await persistHandle(handle);
        await flushSave();
        updateSaveStatus();
        toast("Now saving to " + state.fileName, "success");
      } else {
        const data = await readFile(handle);
        if (!Array.isArray(data)) throw new Error("File format");
        const ok = await new Promise(res => {
          openConfirm({
            title: "Replace contacts?",
            message: `Load ${data.length} contact${data.length === 1 ? "" : "s"} from "${handle.name}"? This will replace your current list.`,
            okLabel: "Replace",
            onOk: () => res(true)
          });
          // Wait for confirm
        });
        if (!ok) return;
        state.contacts = data.map(normalize);
        state.fileHandle = handle;
        state.fileName = handle.name || FILE_NAME_DEFAULT;
        await persistHandle(handle);
        writeCache();
        renderList();
        updateSaveStatus();
        toast(`Loaded ${data.length} contact${data.length === 1 ? "" : "s"}`, "success");
      }
    } catch (e) {
      if (e.name !== "AbortError") {
        console.error(e);
        toast("File operation failed", "error");
      }
    }
  }

  // File chip click → choose new file
  if (fileChip) {
    fileChip.addEventListener("click", () => chooseFile("save"));
  }

  // Quick push button (top bar)
  const ghQuickPush = document.getElementById("ghQuickPush");
  if (ghQuickPush) {
    ghQuickPush.addEventListener("click", (e) => {
      e.stopPropagation();
      ghPush();
    });
  }

  // GitHub sheet handlers
  const githubForm = document.getElementById("githubForm");
  document.getElementById("githubCancel").addEventListener("click", closeGithubSheet);
  document.getElementById("githubSave").addEventListener("click", () => {
    const fd = new FormData(githubForm);
    const cfg = {
      token: (fd.get("ghToken") || "").toString().trim(),
      owner: (fd.get("ghOwner") || "").toString().trim(),
      repo: (fd.get("ghRepo") || "").toString().trim(),
      branch: (fd.get("ghBranch") || "main").toString().trim() || "main",
      path: (fd.get("ghPath") || "contacts.json").toString().trim() || "contacts.json",
    };
    if (!cfg.token || !cfg.owner || !cfg.repo) {
      toast("Token, owner, and repo are required.", "error");
      return;
    }
    saveGithubConfig(cfg);
    updateGhUI();
    closeGithubSheet();
    toast("GitHub settings saved", "success");
  });
  document.getElementById("ghTestBtn").addEventListener("click", async () => {
    const fd = new FormData(githubForm);
    const cfg = {
      token: (fd.get("ghToken") || "").toString().trim(),
      owner: (fd.get("ghOwner") || "").toString().trim(),
      repo: (fd.get("ghRepo") || "").toString().trim(),
    };
    if (!cfg.token || !cfg.owner || !cfg.repo) {
      toast("Fill in token, owner, and repo first.", "error");
      return;
    }
    const btn = document.getElementById("ghTestBtn");
    btn.disabled = true;
    const original = btn.innerHTML;
    btn.innerHTML = "Testing…";
    try {
      const data = await ghTest(cfg);
      toast(`Connected to ${data.full_name}`, "success");
    } catch (e) {
      toast(e.message, "error");
    } finally {
      btn.disabled = false;
      btn.innerHTML = original;
    }
  });
  // Show/hide token
  document.getElementById("ghTokenToggle").addEventListener("click", () => {
    const inp = document.getElementById("ghToken");
    inp.type = inp.type === "password" ? "text" : "password";
  });

  importFile.addEventListener("change", (e) => {
    const f = e.target.files && e.target.files[0];
    if (f) importFile2(f);
    e.target.value = "";
  });

  // Drag & drop
  let dragCounter = 0;
  window.addEventListener("dragenter", (e) => {
    e.preventDefault();
    if (e.dataTransfer.types.includes("Files")) { dragCounter++; dropOverlay.classList.add("active"); }
  });
  window.addEventListener("dragleave", (e) => { e.preventDefault(); dragCounter--; if (dragCounter <= 0) { dragCounter = 0; dropOverlay.classList.remove("active"); } });
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => {
    e.preventDefault(); dragCounter = 0; dropOverlay.classList.remove("active");
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) importFile2(f);
  });

  // Keyboard
  document.addEventListener("keydown", (e) => {
    const t = e.target;
    const typing = t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
    if (e.key === "Escape") {
      if (!confirmModal.classList.contains("hidden")) { closeConfirm(); return; }
      if (!document.getElementById("githubSheet").classList.contains("hidden")) { closeGithubSheet(); return; }
      if (!sheet.classList.contains("hidden")) { closeSheet(); return; }
      if (!menu.classList.contains("hidden")) { menu.classList.add("hidden"); return; }
      if (state.selectedId) { closeDetail(); return; }
    }
    if (typing) return;
    if (e.key === "/") { e.preventDefault(); searchInput.focus(); searchInput.select(); }
    else if (e.key === "n" || e.key === "N") { e.preventDefault(); openSheet(null); }
    else if ((e.key === "e" || e.key === "E") && state.selectedId) { e.preventDefault(); const c = state.contacts.find(x => x.id === state.selectedId); if (c) openSheet(c); }
    else if (e.key === "Delete" && state.selectedId) { e.preventDefault(); deleteCurrent(); }
    else if ((e.metaKey || e.ctrlKey) && (e.key === "s" || e.key === "S")) {
      e.preventDefault();
      if (ghConfigured()) ghPush();
      else openGithubSheet();
    }
  });

  // Swipe-back
  let tx = 0, ty = 0, tActive = false;
  detailScreen.addEventListener("touchstart", (e) => {
    if (e.touches.length !== 1) return;
    tx = e.touches[0].clientX; ty = e.touches[0].clientY; tActive = true;
  }, { passive: true });
  detailScreen.addEventListener("touchmove", (e) => {
    if (!tActive || e.touches.length !== 1) return;
    const dx = e.touches[0].clientX - tx;
    const dy = Math.abs(e.touches[0].clientY - ty);
    if (dx > 0 && dy < 60 && dx < 120) {
      detailScreen.style.transform = `translateX(${dx * 0.5}px)`;
      detailScreen.style.transition = "none";
    }
  }, { passive: true });
  detailScreen.addEventListener("touchend", (e) => {
    if (!tActive) return;
    tActive = false;
    const dx = e.changedTouches[0].clientX - tx;
    if (dx > 80) { detailScreen.style.transition = ""; detailScreen.style.transform = ""; closeDetail(); }
    else {
      detailScreen.style.transition = "transform 240ms cubic-bezier(0.16, 1, 0.3, 1)";
      detailScreen.style.transform = "";
      setTimeout(() => { detailScreen.style.transition = ""; }, 260);
    }
  });

  // Save on hide / unload
  window.addEventListener("beforeunload", () => { flushSave(); });
  window.addEventListener("pagehide", () => { writeCache(); });

  // ============================================================
  // Init
  // ============================================================
  renderList();
  updateGhUI();

  // First-run: prompt user to set up file persistence
  (async () => {
    if (!HAS_FS_API) {
      // Browser doesn't support file system access
      // Data still persists via localStorage; show a soft notice via the menu
      return;
    }
    if (state.contacts.length === 0) {
      // No data, no need to force file setup. User will encounter it on first save/edit.
      return;
    }
    // Has cached data. Offer to set up file persistence.
    openFirstRunModal(async (handle) => {
      if (!handle) return;
      state.fileHandle = handle;
      state.fileName = handle.name || FILE_NAME_DEFAULT;
      await persistHandle(handle);
      await flushSave();
      updateSaveStatus();
      toast("Now saving to " + state.fileName, "success");
    });
  })();

  // ============================================================
  // PWA: service worker + install prompt
  // ============================================================
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("sw.js").catch((e) => console.warn("SW register failed", e));
    });
  }

  const installPrompt = $("#installPrompt");
  const installBtn = $("#installBtn");
  const installClose = $("#installClose");
  let deferredInstall = null;

  function isStandalone() {
    return window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
  }

  function showInstallPrompt() {
    if (isStandalone()) return;
    if (sessionStorage.getItem("installDismissed") === "1") return;
    installPrompt.classList.remove("hidden");
  }
  function hideInstallPrompt() {
    installPrompt.classList.add("hidden");
  }

  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredInstall = e;
    showInstallPrompt();
  });

  installBtn.addEventListener("click", async () => {
    if (deferredInstall) {
      deferredInstall.prompt();
      const choice = await deferredInstall.userChoice;
      if (choice.outcome === "accepted") hideInstallPrompt();
      deferredInstall = null;
    } else {
      // iOS fallback: show instructions
      const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent);
      if (isIOS) {
        toast("Tap Share → Add to Home Screen", "success", { label: "OK", onClick: () => {} });
      } else {
        toast("Use your browser's Install option", "success", { label: "OK", onClick: () => {} });
      }
    }
  });
  installClose.addEventListener("click", () => {
    sessionStorage.setItem("installDismissed", "1");
    hideInstallPrompt();
  });

  window.addEventListener("appinstalled", () => {
    hideInstallPrompt();
    toast("Installed! Find Contacts on your home screen.", "success");
  });

  // Show a passive hint on iOS where beforeinstallprompt doesn't fire
  if (!isStandalone() && !sessionStorage.getItem("installDismissed")) {
    const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) && !window.MSStream;
    if (isIOS) {
      // Small banner that disappears after a few seconds
      setTimeout(() => {
        const hint = document.createElement("div");
        hint.className = "install-prompt";
        hint.innerHTML = `
          <div class="install-content">
            <img src="icon-192.png" alt="" class="install-icon" />
            <div class="install-text">
              <strong>Install Contacts</strong>
              <span>Tap <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:13px;height:13px;display:inline;vertical-align:-2px"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg> Share → Add to Home Screen</span>
            </div>
            <button class="install-close" aria-label="Dismiss">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </div>`;
        document.body.appendChild(hint);
        const close = hint.querySelector(".install-close");
        close.addEventListener("click", () => {
          hint.remove();
          sessionStorage.setItem("installDismissed", "1");
        });
        setTimeout(() => { if (hint.parentNode) hint.remove(); }, 10000);
      }, 1500);
    }
  }
})();
