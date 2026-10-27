const API = "http://127.0.0.1:5000";

const el = (id) => document.getElementById(id);
const $ = {
  apiOffline: el("apiOffline"),
  noWireproxy: el("noWireproxy"),
  proxyConflict: el("proxyConflict"),
  mainUI: el("mainUI"),
  connCard: el("connCard"),
  connDot: el("connDot"),
  connText: el("connText"),
  connSub: el("connSub"),
  toggleBtn: el("toggleBtn"),
  modeBrowser: el("modeBrowser"),
  modeTab: el("modeTab"),
  tabInfo: el("tabInfo"),
  tabToggleBtn: el("tabToggleBtn"),
  tabList: el("tabList"),
  pickCountryBtn: el("pickCountryBtn"),
  countryPanel: el("countryPanel"),
  countrySearch: el("countrySearch"),
  countryList: el("countryList"),
  protonTier: el("protonTier"),
  protonStatus: el("protonStatus"),
  protonLoginBtn: el("protonLoginBtn"),
  importBtn: el("importBtn"),
  fileInput: el("fileInput"),
  profileList: el("profileList"),
  profileStatus: el("profileStatus"),
};

let status = null;      // local API status
let route = null;       // background routing state
let protonMeta = {};    // profile name -> { country, logical, city }
let countries = null;
let currentTab = null;
let tunneledTabs = [];  // chrome.tabs.Tab for each tab in the tunnel
let exitInfo = null;
let busy = false;

// ---------- helpers
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const flagUrl = (cc) => `https://flagcdn.com/w40/${(cc === "UK" ? "gb" : cc).toLowerCase()}.png`;

// Generated profiles have stored meta; hand-downloaded Proton ones are named like
// "wg-NL-FREE-153.conf", which is enough to know the country.
function profileInfo(name) {
  const m = protonMeta[name];
  if (m) return { proton: true, country: m.country, label: `${m.logical}${m.city ? " · " + m.city : ""}` };
  const base = name.replace(/\.conf$/i, "");
  const proton = /^(wg|proton)[-_]/i.test(base);
  const rest = base.replace(/^(wg|proton)[-_]/i, "");
  const cc = proton ? rest.match(/^([A-Za-z]{2})(?=[-_#]|$)/)?.[1]?.toUpperCase() : null;
  if (!cc) return { proton: false, country: null, label: name };
  return { proton: true, country: cc, label: rest.replace(/[-_](\d+)$/, "#$1").toUpperCase() };
}

function hostOf(url) {
  try { const u = new URL(url); return u.protocol.startsWith("http") ? u.hostname : ""; } catch { return ""; }
}

function show(box, msg, kind = "info", autohide = true) {
  box.textContent = msg;
  box.className = `status ${kind}`;
  if (autohide) setTimeout(() => box.classList.add("hidden"), 3500);
}

async function api(path, opts = {}) {
  const res = await fetch(`${API}${path}`, {
    method: opts.method || "GET",
    headers: { "Content-Type": "application/json" },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

async function bg(type, payload = {}) {
  const res = await chrome.runtime.sendMessage({ type, ...payload });
  if (!res?.ok) {
    const err = new Error(res?.error || "Background error");
    err.auth = res?.auth;
    throw err;
  }
  return res.data;
}

async function withBusy(btn, fn) {
  if (busy) return;
  busy = true;
  const orig = btn?.textContent;
  if (btn) { btn.disabled = true; btn.textContent = "…"; }
  try { return await fn(); }
  finally {
    busy = false;
    if (btn) { btn.disabled = false; btn.textContent = orig; }
    render();
  }
}

const selectedMode = () => document.querySelector('input[name="mode"]:checked').value;

// ---------- render
function render() {
  if (!status || !route) return;
  const active = status.connected && route.active;

  $.noWireproxy.classList.toggle("hidden", status.wireproxy_installed);

  // connection card
  const half = status.connected !== route.active;
  $.connCard.className = `connection ${active ? "on" : half ? "warn" : "off"}`;
  $.connDot.className = `dot ${active ? "on" : half ? "warn" : "off"}`;
  if (active) {
    $.connText.textContent = route.mode === "browser" ? "Connected — All of Chrome" : `Connected — ${tunneledTabs.length} tab${tunneledTabs.length === 1 ? "" : "s"}`;
  } else {
    $.connText.textContent = half ? "Half connected" : "Not connected";
  }
  const activeInfo = status.active_profile && profileInfo(status.active_profile);
  let sub = activeInfo ? (activeInfo.proton ? `Proton ${activeInfo.label}` : activeInfo.label) : "No profile selected";
  if (active && exitInfo) sub += exitInfo.ok ? ` · Exit IP ${exitInfo.ip} (${exitInfo.country})` : ` · ⚠ ${exitInfo.error}`;
  $.connSub.textContent = sub;
  $.toggleBtn.textContent = active || half ? "Disconnect" : "Connect";
  $.toggleBtn.className = active || half ? "btn-danger" : "btn-primary";
  if (!busy) $.toggleBtn.disabled = !(active || half) && (!status.active_profile || !status.wireproxy_installed);

  // mode
  $.modeBrowser.checked = route.mode === "browser";
  $.modeTab.checked = route.mode === "tab";
  const tabMode = route.mode === "tab";
  const showTabs = active && tabMode;
  $.tabInfo.classList.toggle("hidden", !tabMode);
  $.tabToggleBtn.classList.toggle("hidden", !(showTabs && currentTab));
  $.tabList.classList.toggle("hidden", !(showTabs && tunneledTabs.length));
  if (tabMode) {
    $.tabInfo.textContent = active
      ? "Tabs not in the list connect directly (except requests to sites that are in the tunnel)."
      : "Pressing Connect tunnels the current tab; you can add more tabs afterwards.";
  }
  if (showTabs && currentTab) {
    const inTunnel = currentTab.id in route.tabs;
    $.tabToggleBtn.textContent = inTunnel ? "− Remove this tab from the tunnel" : "+ Add this tab to the tunnel";
    $.tabToggleBtn.className = `wide ${inTunnel ? "" : "btn-primary"}`;
  }
  $.tabList.innerHTML = tunneledTabs.map((t) => `
    <div class="list-item clickable ${t.id === currentTab?.id ? "active" : ""}" data-focus="${t.id}" title="${esc(t.url)}">
      ${t.favIconUrl?.startsWith("http") ? `<img class="flag" style="width:14px" src="${esc(t.favIconUrl)}" alt="">` : ""}
      <span class="label">${esc(t.title || hostOf(t.url) || "New tab")}</span>
      <span class="meta">${(route.tabs[t.id] || []).length} host</span>
      <button class="btn-ghost icon-btn" data-untab="${t.id}" title="Remove from the tunnel">✕</button>
    </div>`).join("");

  // profiles
  $.profileList.innerHTML = status.profiles.length
    ? status.profiles.map((p) => {
        const info = profileInfo(p);
        const isActive = p === status.active_profile;
        return `
        <div class="list-item clickable ${isActive ? "active" : ""}" data-activate="${esc(p)}" title="${esc(p)}">
          ${info.country ? `<img class="flag" src="${flagUrl(info.country)}" alt="${esc(info.country)}">` : ""}
          <span class="label">${esc(info.label)}</span>
          ${isActive ? '<span class="meta">aktif</span>' : ""}
          ${info.proton ? `<button class="btn-ghost icon-btn" data-replace="${esc(p)}" title="Make a new profile on another server in ${esc(info.country)} and delete this one">↻</button>` : ""}
          <button class="btn-ghost icon-btn" data-del="${esc(p)}" title="${info.proton ? "Delete (from the Proton account too)" : "Delete"}">✕</button>
        </div>`;
      }).join("")
    : `<div class="list-item muted"><span class="label">No profiles. Choose a location or add a .conf.</span></div>`;
}

function renderCountries() {
  if (!countries) return;
  const q = $.countrySearch.value.trim().toLocaleLowerCase("en");
  const list = countries.filter((c) => !q || c.name.toLocaleLowerCase("en").includes(q) || c.code.toLowerCase() === q);
  $.countryList.innerHTML = list.length
    ? list.map((c) => `
        <div class="list-item clickable" data-country="${esc(c.code)}">
          <img class="flag" src="${flagUrl(c.code)}" alt="${esc(c.code)}">
          <span class="label">${esc(c.name)}</span>
          <span class="meta">${c.count} server${c.count === 1 ? "" : "s"} · ${c.load}%</span>
        </div>`).join("")
    : `<div class="list-item muted"><span class="label">No matching country.</span></div>`;
}

// ---------- sync
async function refresh() {
  let proxyControl;
  try {
    const [s, bgState] = await Promise.all([api("/api/status"), bg("state")]);
    status = s;
    route = bgState.route;
    proxyControl = bgState.proxyControl;
    await loadTunneledTabs();
    $.apiOffline.classList.add("hidden");
    $.mainUI.classList.remove("hidden");
  } catch {
    $.apiOffline.classList.remove("hidden");
    $.mainUI.classList.add("hidden");
    return;
  }
  $.proxyConflict.classList.toggle("hidden", proxyControl !== "controlled_by_other_extensions");
  render();
}

async function loadTunneledTabs() {
  const ids = Object.keys(route?.tabs || {}).map(Number);
  tunneledTabs = (await Promise.all(ids.map((id) => chrome.tabs.get(id).catch(() => null)))).filter(Boolean);
}

async function updateRoute(data) {
  route = { ...route, ...data.route };
  await loadTunneledTabs();
}

async function checkExit() {
  if (!status?.connected) { exitInfo = null; return; }
  try { exitInfo = await api("/api/check"); }
  catch (e) { exitInfo = { ok: false, error: e.message }; }
  render();
}

async function afterConnect(data) {
  if (data?.status) status = data.status;
  if (data?.route) await updateRoute(data);
  exitInfo = null;
  render();
  await checkExit();
  if (exitInfo && !exitInfo.ok && protonMeta[status.active_profile]) {
    show($.protonStatus, "The tunnel passes no traffic — try a new profile in the same country with ↻.", "error", false);
  }
}

function protonError(e) {
  $.protonLoginBtn.classList.toggle("hidden", !e.auth);
  show($.protonStatus, e.auth
    ? `${e.message}. Sign in to your Proton account in this Chrome and open the page once.`
    : e.message, "error", false);
}

// ---------- handlers
$.toggleBtn.addEventListener("click", () => withBusy($.toggleBtn, async () => {
  try {
    if (status.connected || route.active) {
      const data = await bg("disconnect");
      if (data.status) status = data.status;
      await updateRoute(data);
      exitInfo = null;
    } else {
      await afterConnect(await bg("connect", { mode: selectedMode(), tabId: currentTab?.id }));
    }
  } catch (e) {
    show($.protonStatus, e.message, "error", false);
    await refresh();
  }
}));

for (const r of [$.modeBrowser, $.modeTab]) {
  r.addEventListener("change", () => withBusy(null, async () => {
    try {
      await updateRoute(await bg("setMode", { mode: selectedMode(), tabId: currentTab?.id }));
    } catch (e) { show($.protonStatus, e.message, "error"); }
  }));
}

$.tabToggleBtn.addEventListener("click", () => withBusy($.tabToggleBtn, async () => {
  const type = currentTab.id in route.tabs ? "removeTab" : "addTab";
  try { await updateRoute(await bg(type, { tabId: currentTab.id })); }
  catch (e) { show($.protonStatus, e.message, "error"); }
}));

$.tabList.addEventListener("click", (e) => {
  const rm = e.target.closest("[data-untab]");
  if (rm) {
    e.stopPropagation();
    withBusy(null, async () => updateRoute(await bg("removeTab", { tabId: Number(rm.dataset.untab) })));
    return;
  }
  const item = e.target.closest("[data-focus]");
  if (!item) return;
  const tab = tunneledTabs.find((t) => t.id === Number(item.dataset.focus));
  if (tab) {
    chrome.windows.update(tab.windowId, { focused: true });
    chrome.tabs.update(tab.id, { active: true });
  }
});

$.pickCountryBtn.addEventListener("click", () => withBusy($.pickCountryBtn, async () => {
  if (!$.countryPanel.classList.contains("hidden")) { $.countryPanel.classList.add("hidden"); return; }
  try {
    const data = await bg("protonCountries");
    countries = data.countries;
    $.protonTier.textContent = data.maxTier >= 1 ? "Plus account" : "Free account";
    $.protonLoginBtn.classList.add("hidden");
    $.protonStatus.classList.add("hidden");
    $.countryPanel.classList.remove("hidden");
    renderCountries();
    $.countrySearch.focus();
  } catch (e) { protonError(e); }
}));

$.countrySearch.addEventListener("input", renderCountries);

async function createProton(country) {
  const name = countries?.find((c) => c.code === country)?.name || country;
  show($.protonStatus, `Making a WireGuard profile for ${name}…`, "info", false);
  try {
    const data = await bg("protonCreate", {
      country, connect: true, mode: selectedMode(), tabId: currentTab?.id,
    });
    protonMeta = await bg("protonMeta");
    $.countryPanel.classList.add("hidden");
    show($.protonStatus, `${data.created.logical}${data.created.city ? " (" + data.created.city + ")" : ""} profile added and connected.`, "success");
    await afterConnect(data);
  } catch (e) {
    protonError(e);
    await refresh();
  }
}

$.countryList.addEventListener("click", (e) => {
  const item = e.target.closest("[data-country]");
  if (item) withBusy(null, () => createProton(item.dataset.country));
});

$.protonLoginBtn.addEventListener("click", () => {
  chrome.tabs.create({ url: "https://account.protonvpn.com/downloads" });
});

const PROTON_RESULT = {
  deleted: "Removed from the Proton account too.",
  notfound: "No matching entry in the Proton account (it may already be deleted).",
  skipped: "",
};

async function deleteProfile(name) {
  const info = profileInfo(name);
  const ask = info.proton
    ? `Delete "${info.label}"?\nIts WireGuard entry in the Proton account will be removed too.`
    : `Delete "${name}"?`;
  if (!confirm(ask)) return;
  let data;
  try {
    data = await bg("deleteProfile", { name });
  } catch (err) {
    if (!err.revoke) { show($.profileStatus, err.message, "error", false); return; }
    $.protonLoginBtn.classList.toggle("hidden", !err.auth);
    if (!confirm(`${err.message}\n\nDelete it from this computer only?`)) return;
    try { data = await bg("deleteProfile", { name, localOnly: true }); }
    catch (e2) { show($.profileStatus, e2.message, "error", false); return; }
  }
  status = data.status;
  await updateRoute(data);
  protonMeta = await bg("protonMeta");
  show($.profileStatus, `${info.label} deleted. ${PROTON_RESULT[data.proton] ?? ""}`, "success");
}

async function replaceProfile(name) {
  const info = profileInfo(name);
  show($.profileStatus, `Looking for another server in ${info.country}…`, "info", false);
  try {
    const data = await bg("replaceProfile", { name, mode: selectedMode(), tabId: currentTab?.id });
    protonMeta = await bg("protonMeta");
    const revoked = data.proton === "deleted" ? " The old one was removed from Proton."
      : data.proton?.startsWith("failed") ? " ⚠ The old one could not be removed from Proton." : "";
    show($.profileStatus, `${info.label} → ${data.created.logical}${data.created.city ? " (" + data.created.city + ")" : ""}.${revoked}`, "success", false);
    await afterConnect(data);
  } catch (e) {
    $.protonLoginBtn.classList.toggle("hidden", !e.auth);
    show($.profileStatus, e.message, "error", false);
    await refresh();
  }
}

$.profileList.addEventListener("click", (e) => {
  const del = e.target.closest("[data-del]");
  const rep = e.target.closest("[data-replace]");
  if (del || rep) {
    e.stopPropagation();
    withBusy(null, () => (del ? deleteProfile(del.dataset.del) : replaceProfile(rep.dataset.replace)));
    return;
  }
  const item = e.target.closest("[data-activate]");
  if (!item || item.dataset.activate === status.active_profile) return;
  withBusy(null, async () => {
    try {
      status = (await api("/api/profiles/activate", { method: "POST", body: { name: item.dataset.activate } })).status;
      if (status.connected) await afterConnect({});
    } catch (err) { show($.profileStatus, err.message, "error", false); }
  });
});

$.importBtn.addEventListener("click", () => $.fileInput.click());
$.fileInput.addEventListener("change", async () => {
  const file = $.fileInput.files[0];
  if (!file) return;
  const text = await file.text();
  await withBusy($.importBtn, async () => {
    try {
      status = (await api("/api/profiles", { method: "POST", body: { name: file.name, conf: text } })).status;
      show($.profileStatus, `Profile added: ${file.name}`, "success");
    } catch (e) { show($.profileStatus, e.message, "error", false); }
  });
  $.fileInput.value = "";
});

// ---------- init
(async () => {
  try { [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true }); } catch {}
  protonMeta = await bg("protonMeta").catch(() => ({}));
  await refresh();
  if (status?.connected && route?.active) checkExit();
  // light polling to keep the indicator fresh while the popup is open
  setInterval(() => { if (!busy) refresh(); }, 4000);
})();
