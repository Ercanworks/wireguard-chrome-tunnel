// Routes Chrome traffic into the local wireproxy SOCKS5 listener. Nothing
// outside Chrome is touched: the tunnel has no adapter and no system routes.
//
// Modes:
//   browser — every Chrome request goes through the tunnel (fixed proxy).
//   tab     — only the tabs the user added. Chrome has no per-tab proxy, so each
//             tab's hosts are learned and proxied via PAC; a DNR rule blocks those
//             tabs from any host not learned yet, so nothing leaks before the PAC
//             catches up.

const API = "http://127.0.0.1:5000";
const PROTON = "https://account.protonvpn.com/api";
const DEFAULT_SOCKS = { host: "127.0.0.1", port: 25344 };
const TAB_BLOCK_RULE = 1;
const PROTON_ORIGIN_RULE = 2;
const ALL_TYPES = [
  "main_frame", "sub_frame", "stylesheet", "script", "image", "font", "object",
  "xmlhttprequest", "ping", "csp_report", "media", "websocket", "webtransport", "webbundle", "other",
];

// ------------------------------------------------------------------ storage
// tabs: { [tabId]: [hosts learned by that tab] }
const DEFAULT_ROUTE = { active: false, mode: "browser", tabs: {} };

async function getRoute() {
  const { route } = await chrome.storage.local.get("route");
  const { active, mode, tabs } = { ...DEFAULT_ROUTE, ...route };
  return { active, mode, tabs: tabs || {} };
}

const tabIdsOf = (route) => Object.keys(route.tabs).map(Number);
const allHosts = (route) => [...new Set(Object.values(route.tabs).flat())];
const isTunneledTab = (route, tabId) => route.active && route.mode === "tab" && tabId in route.tabs;
async function setRoute(patch) {
  const route = { ...(await getRoute()), ...patch };
  await chrome.storage.local.set({ route });
  return route;
}

// ------------------------------------------------------------------ local api
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

async function socksAddr() {
  const { socks } = await chrome.storage.local.get("socks");
  return socks || DEFAULT_SOCKS;
}

// ------------------------------------------------------------------ routing
function hostKey(host) {
  return host.toLowerCase().replace(/^www\./, "");
}

function pacScript(hosts, { host, port }) {
  const set = Object.fromEntries(hosts.map((h) => [h, 1]));
  return `var H=${JSON.stringify(set)};
function FindProxyForURL(url, host) {
  var h = host.toLowerCase();
  while (true) {
    if (H[h]) return "SOCKS5 ${host}:${port}";
    var i = h.indexOf(".");
    if (i < 0) return "DIRECT";
    h = h.substring(i + 1);
  }
}`;
}

async function setWebRtc(on) {
  try {
    if (on) await chrome.privacy.network.webRTCIPHandlingPolicy.set({ value: "disable_non_proxied_udp" });
    else await chrome.privacy.network.webRTCIPHandlingPolicy.clear({});
  } catch {}
}

async function applyRoute(route) {
  const socks = await socksAddr();
  const removeRuleIds = [TAB_BLOCK_RULE];

  if (!route.active) {
    await chrome.proxy.settings.clear({ scope: "regular" });
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds });
    await setWebRtc(false);
    await chrome.action.setBadgeText({ text: "" });
    return;
  }

  if (route.mode === "browser") {
    await chrome.proxy.settings.set({
      scope: "regular",
      value: {
        mode: "fixed_servers",
        rules: {
          singleProxy: { scheme: "socks5", host: socks.host, port: socks.port },
          bypassList: ["localhost", "127.0.0.1", "[::1]"],
        },
      },
    });
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds });
  } else {
    const hosts = allHosts(route);
    const tabIds = tabIdsOf(route);
    await chrome.proxy.settings.set({
      scope: "regular",
      value: { mode: "pac_script", pacScript: { data: pacScript(hosts, socks), mandatory: true } },
    });
    const addRules = [];
    if (tabIds.length) {
      const condition = { tabIds, resourceTypes: ALL_TYPES };
      if (hosts.length) condition.excludedRequestDomains = hosts;
      addRules.push({ id: TAB_BLOCK_RULE, priority: 1, action: { type: "block" }, condition });
    }
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds, addRules });
  }
  await setWebRtc(true);
  await chrome.action.setBadgeBackgroundColor({ color: "#3ecf8e" });
  await chrome.action.setBadgeText({ text: route.mode === "browser" ? "ON" : String(tabIdsOf(route).length) });
}

async function proxyControl() {
  const s = await chrome.proxy.settings.get({});
  return s.levelOfControl;
}

async function addTab(tabId) {
  const tab = await chrome.tabs.get(tabId);
  let hosts = [];
  try {
    const u = new URL(tab.url);
    if (u.protocol.startsWith("http")) hosts = [hostKey(u.hostname)];
  } catch {}
  const current = await getRoute();
  const tabs = current.mode === "tab" && current.active ? { ...current.tabs } : {};
  tabs[tabId] = [...new Set([...(tabs[tabId] || []), ...hosts])];
  const route = await setRoute({ active: true, mode: "tab", tabs });
  await applyRoute(route);
  // Reload so the page is fetched through the tunnel from the very first request.
  if (hosts.length) await chrome.tabs.reload(tabId, { bypassCache: true });
  return route;
}

async function removeTab(tabId, { reload = true } = {}) {
  const current = await getRoute();
  if (!(tabId in current.tabs)) return current;
  const tabs = { ...current.tabs };
  delete tabs[tabId];
  const route = await setRoute({ tabs });
  await applyRoute(route);
  // Reload so open connections made through the tunnel are dropped.
  if (reload) await chrome.tabs.reload(tabId).catch(() => {});
  return route;
}

async function startRouting(mode, tabId) {
  if (mode === "tab") {
    await setRoute({ tabs: {} });
    return addTab(tabId);
  }
  const route = await setRoute({ active: true, mode: "browser", tabs: {} });
  await applyRoute(route);
  return route;
}

async function stopRouting() {
  const route = await setRoute({ active: false, tabs: {} });
  await applyRoute(route);
  return route;
}

// ------------------------------------------------------------------ tab learning
let pending = new Map(); // tabId -> Map(host -> blocked main_frame url or null)
let flushTimer = null;
const navStartedAt = new Map(); // tabId -> ms
const reloads = new Map();      // tabId -> { at, n }

chrome.webRequest.onErrorOccurred.addListener(async (d) => {
  if (!d.error?.includes("ERR_BLOCKED_BY_CLIENT")) return;
  const route = await getRoute();
  if (!isTunneledTab(route, d.tabId)) return;
  let host;
  try { host = hostKey(new URL(d.url).hostname); } catch { return; }
  const forTab = pending.get(d.tabId) || new Map();
  if (!forTab.has(host) || d.type === "main_frame") forTab.set(host, d.type === "main_frame" ? d.url : forTab.get(host) ?? null);
  pending.set(d.tabId, forTab);
  clearTimeout(flushTimer);
  flushTimer = setTimeout(flushLearned, 250);
}, { urls: ["<all_urls>"] });

async function flushLearned() {
  const batch = pending;
  pending = new Map();
  const route = await getRoute();
  if (!route.active || route.mode !== "tab") return;

  const tabs = { ...route.tabs };
  const changed = [];
  for (const [tabId, hosts] of batch) {
    if (!(tabId in tabs)) continue;
    const fresh = [...hosts.keys()].filter((h) => !tabs[tabId].includes(h));
    if (!fresh.length) continue;
    tabs[tabId] = [...tabs[tabId], ...fresh];
    changed.push(tabId);
  }
  if (!changed.length) return;
  await applyRoute(await setRoute({ tabs }));
  await new Promise((r) => setTimeout(r, 150)); // let the new PAC take effect

  for (const tabId of changed) {
    const mainUrl = [...batch.get(tabId).values()].find(Boolean);
    if (mainUrl) {
      reloads.set(tabId, { at: Date.now(), n: 0 });
      await chrome.tabs.update(tabId, { url: mainUrl }).catch(() => {});
      continue;
    }
    // Subresources blocked while the page was still loading: reload once or twice
    // so the page renders complete. Later lazy loads just get learned silently.
    let r = reloads.get(tabId);
    if (!r || Date.now() - r.at > 20000) r = { at: Date.now(), n: 0 };
    if (Date.now() - (navStartedAt.get(tabId) || 0) < 10000 && r.n < 2) {
      r.n++;
      await chrome.tabs.reload(tabId).catch(() => {});
    }
    reloads.set(tabId, r);
  }
}

chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  if (info.status !== "loading") return;
  if (isTunneledTab(await getRoute(), tabId)) navStartedAt.set(tabId, Date.now());
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  navStartedAt.delete(tabId);
  reloads.delete(tabId);
  if (isTunneledTab(await getRoute(), tabId)) await removeTab(tabId, { reload: false });
});

chrome.tabs.onReplaced.addListener(async (added, removed) => {
  const route = await getRoute();
  if (!isTunneledTab(route, removed)) return;
  const tabs = { ...route.tabs, [added]: route.tabs[removed] };
  delete tabs[removed];
  await applyRoute(await setRoute({ tabs }));
});

// ------------------------------------------------------------------ connect
async function connect(mode, tabId) {
  const data = await api("/api/connect", { method: "POST" });
  await chrome.storage.local.set({ socks: data.status.socks });
  await startRouting(mode, tabId);
  return data.status;
}

async function disconnect() {
  await stopRouting();
  const data = await api("/api/disconnect", { method: "POST" }).catch(() => null);
  return data?.status;
}

async function restoreOnStartup() {
  const route = await getRoute();
  if (!route.active) return applyRoute(route);
  if (route.mode === "tab") return stopRouting(); // tab ids don't survive restarts
  try {
    const status = await api("/api/status");
    if (!status.connected) await api("/api/connect", { method: "POST" });
    await applyRoute(route);
  } catch {
    await stopRouting();
    await chrome.action.setBadgeBackgroundColor({ color: "#f14e62" });
    await chrome.action.setBadgeText({ text: "!" });
  }
}

chrome.runtime.onStartup.addListener(restoreOnStartup);
chrome.runtime.onInstalled.addListener(() => { installProtonOriginRule(); restoreOnStartup(); });
chrome.runtime.onStartup.addListener(installProtonOriginRule);

// ------------------------------------------------------------------ proton
// Uses the Proton web session already signed in in this Chrome. The web app's
// own requests are observed to learn the session UID and app version headers.

chrome.webRequest.onSendHeaders.addListener((d) => {
  if (d.initiator === `chrome-extension://${chrome.runtime.id}`) return;
  const get = (n) => d.requestHeaders?.find((h) => h.name.toLowerCase() === n)?.value;
  const uid = get("x-pm-uid");
  const appVersion = get("x-pm-appversion");
  if (uid && appVersion) chrome.storage.local.set({ protonSession: { uid, appVersion } });
}, { urls: ["https://account.protonvpn.com/api/*"] }, ["requestHeaders", "extraHeaders"]);

async function installProtonOriginRule() {
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [PROTON_ORIGIN_RULE],
    addRules: [{
      id: PROTON_ORIGIN_RULE,
      priority: 1,
      action: {
        type: "modifyHeaders",
        requestHeaders: [
          { header: "origin", operation: "set", value: "https://account.protonvpn.com" },
          { header: "referer", operation: "set", value: "https://account.protonvpn.com/downloads" },
        ],
      },
      condition: { urlFilter: "||account.protonvpn.com/api/", tabIds: [chrome.tabs.TAB_ID_NONE] },
    }],
  });
}

class ProtonAuthError extends Error {}

async function protonHeaders() {
  const { protonSession } = await chrome.storage.local.get("protonSession");
  let uid = protonSession?.uid;
  if (!uid) {
    const cookies = await chrome.cookies.getAll({ domain: "account.protonvpn.com" });
    uid = cookies.find((c) => c.name.startsWith("AUTH-"))?.name.slice(5);
  }
  if (!uid) throw new ProtonAuthError("No Proton session found");
  return {
    "x-pm-uid": uid,
    "x-pm-appversion": protonSession?.appVersion || "web-vpn-settings@5.0.999.999",
    Accept: "application/vnd.protonmail.v1+json",
    "Content-Type": "application/json",
  };
}

async function papi(path, opts = {}) {
  const res = await fetch(`${PROTON}/${path}`, {
    method: opts.method || "GET",
    headers: await protonHeaders(),
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    credentials: "include",
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 || res.status === 403 || data.Code === 5003) {
    await chrome.storage.local.remove("protonSession");
    throw new ProtonAuthError(data.Error || "The Proton session is not valid");
  }
  if (!res.ok || (data.Code && data.Code !== 1000 && data.Code !== 1001)) {
    const err = new Error(data.Error || `Proton HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

async function papiFirst(paths) {
  let last;
  for (const p of paths) {
    try { return await papi(p); }
    catch (e) { if (e instanceof ProtonAuthError) throw e; last = e; }
  }
  throw last;
}

let logicalsCache = { at: 0, maxTier: 0, list: [] };

async function protonServers(force = false) {
  if (!force && Date.now() - logicalsCache.at < 5 * 60_000) return logicalsCache;
  const [vpn, logicals] = await Promise.all([
    papiFirst(["vpn/v2", "vpn"]),
    papiFirst(["vpn/v1/logicals", "vpn/logicals"]),
  ]);
  const maxTier = vpn?.VPN?.MaxTier ?? 0;
  const list = (logicals.LogicalServers || [])
    .map((l) => ({ ...l, Servers: (l.Servers || []).filter((s) => s.X25519PublicKey && s.Status !== 0) }))
    // Skip Secure Core (1) and Tor (2) entries, as Proton's own download page does.
    .filter((l) => l.Status !== 0 && l.Tier <= maxTier && (l.Features & 3) === 0 && l.Servers.length)
    .sort((a, b) => a.Score - b.Score);
  logicalsCache = { at: Date.now(), maxTier, list };
  return logicalsCache;
}

const regionNames = new Intl.DisplayNames(["en"], { type: "region" });

async function protonCountries() {
  const { list, maxTier } = await protonServers();
  const byCode = new Map();
  for (const l of list) {
    const cc = l.ExitCountry;
    const entry = byCode.get(cc) || { code: cc, count: 0, load: 0 };
    entry.count++;
    entry.load += l.Load || 0;
    byCode.set(cc, entry);
  }
  const countries = [...byCode.values()].map((c) => {
    let name = c.code;
    try { name = regionNames.of(c.code === "UK" ? "GB" : c.code); } catch {}
    return { ...c, name, load: Math.round(c.load / c.count) };
  }).sort((a, b) => a.name.localeCompare(b.name, "en"));
  return { countries, maxTier };
}

const b64 = (bytes) => btoa(String.fromCharCode(...bytes));

// Same scheme as Proton's web client: an Ed25519 key is registered with the API
// and the WireGuard key is its X25519 counterpart (sha512(seed)[0..32], clamped).
async function generateKeys() {
  const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const pub = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  const seed = new Uint8Array(await crypto.subtle.exportKey("pkcs8", kp.privateKey)).slice(-32);
  const x = new Uint8Array(await crypto.subtle.digest("SHA-512", seed)).slice(0, 32);
  x[0] &= 0xf8;
  x[31] &= 0x7f;
  x[31] |= 0x40;
  return { ed25519Public: b64(pub), wgPrivate: b64(x) };
}

function protonFeatures(maxTier, logical, server) {
  const base = maxTier >= 1
    ? { NetShieldLevel: 0, RandomNAT: true, PortForwarding: false, SplitTCP: true }
    : { SplitTCP: true };
  return {
    ...(server.Label ? { Bouncing: server.Label } : {}),
    ...base,
    peerName: logical.Name,
    peerIp: server.EntryIP,
    peerPublicKey: server.X25519PublicKey,
    platform: "Windows",
  };
}

function buildConf(logical, server, wgPrivate) {
  return `[Interface]
# Proton VPN ${logical.Name} (${logical.City || logical.ExitCountry}) - WG Chrome Tunnel
PrivateKey = ${wgPrivate}
Address = 10.2.0.2/32
DNS = 10.2.0.1

[Peer]
# ${logical.Name}
PublicKey = ${server.X25519PublicKey}
AllowedIPs = 0.0.0.0/0
Endpoint = ${server.EntryIP}:51820
PersistentKeepalive = 25
`;
}

async function protonCreate(country, { exclude } = {}) {
  const { list, maxTier } = await protonServers(true);
  const candidates = list.filter((l) => l.ExitCountry === country);
  if (!candidates.length) throw new Error(`No suitable server in ${country} (account tier: ${maxTier})`);

  const { protonUsed = {}, protonMeta = {} } = await chrome.storage.local.get(["protonUsed", "protonMeta"]);
  let used = [...new Set([...(protonUsed[country] || []), ...(exclude ? [exclude] : [])])];
  let logical = candidates.find((l) => !used.includes(l.Name));
  if (!logical) { used = []; logical = candidates[0]; }
  const server = logical.Servers[Math.floor(Math.random() * logical.Servers.length)];

  const keys = await generateKeys();
  const certBody = (features) => ({
    ClientPublicKey: keys.ed25519Public,
    Mode: "persistent",
    DeviceName: `WGCM-${logical.Name}`.slice(0, 40),
    Features: features,
  });
  let cert;
  try {
    cert = await papi("vpn/v1/certificate", { method: "POST", body: certBody(protonFeatures(maxTier, logical, server)) });
  } catch (e) {
    if (e instanceof ProtonAuthError) throw e;
    cert = await papi("vpn/v1/certificate", { method: "POST", body: certBody({}) });
  }

  const name = `proton-${logical.Name}`.replace(/[^A-Za-z0-9._-]/g, "_") + ".conf";
  const saved = await api("/api/profiles", {
    method: "POST",
    body: { name, conf: buildConf(logical, server, keys.wgPrivate), activate: true },
  });

  protonMeta[saved.name] = {
    country, logical: logical.Name, city: logical.City || "", at: Date.now(),
    serial: cert?.SerialNumber || null, fingerprint: cert?.ClientKeyFingerprint || null,
  };
  protonUsed[country] = [...used, logical.Name];
  await chrome.storage.local.set({ protonUsed, protonMeta });
  return { name: saved.name, logical: logical.Name, city: logical.City };
}

// Profiles downloaded by hand from Proton are named like "wg-NL-FREE-153.conf".
function countryFromName(name) {
  const m = name.replace(/\.conf$/i, "").replace(/^(wg|proton)[-_]/i, "").match(/^([A-Za-z]{2})(?=[-_#]|$)/);
  return m ? m[1].toUpperCase() : null;
}
function logicalFromName(name) {
  return name.replace(/\.conf$/i, "").replace(/^(wg|proton)[-_]/i, "").replace(/[-_](\d+)$/, "#$1").toUpperCase();
}

// ---- revoking certificates on the Proton account
const ED_P = 2n ** 255n - 19n;
const X25519_PKCS8 = [0x30, 0x2e, 2, 1, 0, 0x30, 5, 6, 3, 0x2b, 0x65, 0x6e, 4, 0x22, 4, 0x20];
const leToBig = (b) => b.reduceRight((n, byte) => (n << 8n) | BigInt(byte), 0n);
const bigToLe = (n) => Uint8Array.from({ length: 32 }, (_, i) => Number((n >> BigInt(8 * i)) & 0xffn));
const unb64 = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/").replace(/\s+/g, "")), (c) => c.charCodeAt(0));
function modPow(b, e) {
  let r = 1n;
  b %= ED_P;
  for (; e > 0n; e >>= 1n, b = (b * b) % ED_P) if (e & 1n) r = (r * b) % ED_P;
  return r;
}

// Proton registers the Ed25519 key; the .conf only holds its X25519 counterpart.
// The Ed25519 public key's y coordinate is (u-1)/(u+1) of the X25519 public u,
// so a cert matches when its key equals that y (sign bit ignored).
async function edYFromWgPrivate(privB64) {
  const der = new Uint8Array([...X25519_PKCS8, ...unb64(privB64)]);
  const key = await crypto.subtle.importKey("pkcs8", der, { name: "X25519" }, true, ["deriveBits"]);
  const u = leToBig(unb64((await crypto.subtle.exportKey("jwk", key)).x));
  return bigToLe(((u - 1n + ED_P) % ED_P) * modPow(u + 1n, ED_P - 2n) % ED_P);
}

function certKeyMatches(clientKey, y) {
  if (!clientKey) return false;
  let raw;
  try { raw = unb64(clientKey.replace(/-----[^-]+-----/g, "")).slice(-32); } catch { return false; }
  raw[31] &= 0x7f;
  return raw.length === 32 && raw.every((b, i) => b === y[i]);
}

async function findCert(match) {
  const limit = 50;
  for (let page = 0; page < 20; page++) {
    const data = await papi(`vpn/v1/certificate/all?Mode=persistent&Offset=${page * limit}&Limit=${limit}`);
    const certs = data.Certificates || Object.values(data).find(Array.isArray) || [];
    const hit = certs.find(match);
    if (hit) return hit;
    if (certs.length < limit) return null;
  }
  return null;
}

async function protonRevoke(meta, conf) {
  let filter = meta?.serial ? { SerialNumber: meta.serial } : null;
  if (!filter) {
    const priv = conf?.match(/^\s*PrivateKey\s*=\s*(\S+)/im)?.[1];
    if (!priv) return "notfound";
    const y = await edYFromWgPrivate(priv);
    const cert = await findCert((c) => certKeyMatches(c.ClientKey, y));
    if (!cert) return "notfound";
    filter = cert.SerialNumber
      ? { SerialNumber: cert.SerialNumber }
      : { ClientPublicKeyFingerprint: cert.ClientKeyFingerprint };
  }
  try {
    await papi("vpn/v1/certificate", { method: "DELETE", body: filter });
  } catch (e) {
    if (e.status === 404 || e.status === 422) return "notfound"; // already gone on the account
    throw e;
  }
  return "deleted";
}

class ProtonRevokeError extends Error {}

async function deleteProfile(name, { localOnly = false } = {}) {
  const { protonMeta = {} } = await chrome.storage.local.get("protonMeta");
  const meta = protonMeta[name];
  let proton = "skipped";
  if (!localOnly) {
    const conf = meta?.serial ? null
      : (await api("/api/profiles/read", { method: "POST", body: { name } })).conf;
    // 10.2.0.2/32 is the tunnel address in every Proton WireGuard config.
    if (meta || /10\.2\.0\.2\/32/.test(conf)) {
      try { proton = await protonRevoke(meta, conf); }
      catch (e) {
        const err = new ProtonRevokeError(`Could not remove it from the Proton account: ${e.message}`);
        err.auth = e instanceof ProtonAuthError;
        throw err;
      }
    }
  }
  const data = await api("/api/profiles/delete", { method: "POST", body: { name } });
  delete protonMeta[name];
  await chrome.storage.local.set({ protonMeta });
  if (!data.status.connected && (await getRoute()).active) await stopRouting();
  return { status: data.status, proton };
}

// Swap a Proton profile for another server in the same country and revoke the old one.
async function replaceProfile(name, mode, tabId) {
  const { protonMeta = {} } = await chrome.storage.local.get("protonMeta");
  const oldMeta = protonMeta[name];
  const country = oldMeta?.country || countryFromName(name);
  if (!country) throw new Error("Could not tell this profile's country");
  const oldConf = oldMeta?.serial ? null
    : (await api("/api/profiles/read", { method: "POST", body: { name } }).catch(() => ({}))).conf;

  const created = await protonCreate(country, { exclude: oldMeta?.logical || logicalFromName(name) });
  let proton;
  try { proton = await protonRevoke(oldMeta, oldConf); }
  catch (e) { proton = `failed: ${e.message}`; }
  if (created.name !== name) {
    await api("/api/profiles/delete", { method: "POST", body: { name } }).catch(() => {});
    const { protonMeta: latest = {} } = await chrome.storage.local.get("protonMeta");
    delete latest[name];
    await chrome.storage.local.set({ protonMeta: latest });
  }
  const status = await connect(mode, tabId);
  return { created, proton, status };
}

// ------------------------------------------------------------------ messages
const handlers = {
  async state() {
    return { route: await getRoute(), proxyControl: await proxyControl() };
  },
  async connect({ mode, tabId }) {
    return { status: await connect(mode, tabId), route: await getRoute() };
  },
  async disconnect() {
    return { status: await disconnect(), route: await getRoute() };
  },
  async setMode({ mode, tabId }) {
    const route = await getRoute();
    if (!route.active) return { route: await setRoute({ mode }) };
    return { route: await startRouting(mode, tabId) };
  },
  async addTab({ tabId }) {
    return { route: await addTab(tabId) };
  },
  async removeTab({ tabId }) {
    return { route: await removeTab(tabId) };
  },
  async protonCountries() {
    return protonCountries();
  },
  async protonCreate({ country, connect: doConnect, mode, tabId }) {
    const created = await protonCreate(country);
    let status = null;
    if (doConnect) status = await connect(mode, tabId);
    return { created, status, route: await getRoute() };
  },
  async protonMeta() {
    const { protonMeta = {} } = await chrome.storage.local.get("protonMeta");
    return protonMeta;
  },
  async deleteProfile({ name, localOnly }) {
    return { ...(await deleteProfile(name, { localOnly })), route: await getRoute() };
  },
  async replaceProfile({ name, mode, tabId }) {
    return { ...(await replaceProfile(name, mode, tabId)), route: await getRoute() };
  },
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const fn = handlers[msg?.type];
  if (!fn) return false;
  fn(msg)
    .then((data) => sendResponse({ ok: true, data }))
    .catch((e) => sendResponse({
      ok: false,
      error: e.message || String(e),
      auth: e instanceof ProtonAuthError || !!e.auth,
      revoke: e instanceof ProtonRevokeError,
    }));
  return true;
});
