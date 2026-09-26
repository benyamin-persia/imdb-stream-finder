// Background: ad locker rules + playability probes + auto provider-list refresh
importScripts(
  "shared/ad-filters.js",
  "shared/catalog.js",
  "shared/providers.pack.js", // packed catalog so installs work without private files
  "shared/defaults.js"
);

const AD_RULE_BASE = 1000;
const POP_RULE_BASE = 1800;
const CATALOG_ALARM = "isf-catalog-refresh";
const UPDATE_ALARM = "isf-ext-update-check";
const CATALOG_PERIOD_MINUTES = 720; // every 12 hours
const UPDATE_PERIOD_MINUTES = 360; // check GitHub version every 6 hours

// Published on GitHub — bump version.json when you release so users get a badge
const VERSION_CHECK_URL =
  "https://raw.githubusercontent.com/benyamin-persia/imdb-stream-finder/main/version.json";
const DEFAULT_RELEASES_FEED = "https://www.fandango.com/movies-in-theaters";

const OUR_RULE_IDS = [
  ...AD_FILTERS.map((_, i) => AD_RULE_BASE + i),
  ...POPUNDER_MAIN_FRAME.map((_, i) => POP_RULE_BASE + i)
];

let syncChain = Promise.resolve();

const IMDB_SEARCH_MENU_ID = "isf-search-imdb"; // right-click → Search on IMDb

function ensureImdbSearchMenu() {
  chrome.contextMenus.removeAll(() => {
    // %s is replaced by Chrome with the highlighted selection text
    chrome.contextMenus.create({
      id: IMDB_SEARCH_MENU_ID,
      title: 'Search on IMDb for "%s"',
      contexts: ["selection"] // only when the user has text selected
    });
  });
}

chrome.contextMenus.onClicked.addListener(async (info) => {
  if (info.menuItemId !== IMDB_SEARCH_MENU_ID) return;
  const q = String(info.selectionText || "").trim(); // highlighted phrase from any page
  if (!q) return;
  // Prefer the specific title page over a search results dump
  const imdb = (await resolveImdbId(q, null)) || null;
  const url = imdb
    ? `https://www.imdb.com/title/${imdb}/`
    : `https://www.imdb.com/find/?q=${encodeURIComponent(q)}`;
  chrome.tabs.create({ url });
});

chrome.runtime.onInstalled.addListener(async () => {
  ensureImdbSearchMenu();
  queueSyncFromStorage(true);
  await ensureCatalogAlarm();
  await ensureUpdateAlarm();
  await refreshProviderCatalog("install");
  await checkExtensionUpdate("install");
});

chrome.runtime.onStartup.addListener(async () => {
  ensureImdbSearchMenu();
  queueSyncFromStorage(false);
  await ensureCatalogAlarm();
  await ensureUpdateAlarm();
  await refreshProviderCatalog("startup");
  await checkExtensionUpdate("startup");
});

ensureImdbSearchMenu(); // recreate after service worker wake
queueSyncFromStorage(false);
ensureCatalogAlarm().then(() => refreshProviderCatalog("wakeup"));
ensureUpdateAlarm().then(() => checkExtensionUpdate("wakeup"));
refreshReleasesFeed("wakeup").catch(() => {});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === CATALOG_ALARM) refreshProviderCatalog("alarm");
  if (alarm.name === UPDATE_ALARM) checkExtensionUpdate("alarm");
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.lockerEnabled) {
    enqueueSync(changes.lockerEnabled.newValue !== false);
  }
  if (changes.autoUpdateProviders?.newValue === true || changes.catalogUrl) {
    refreshProviderCatalog("settings");
  }
});

async function ensureCatalogAlarm() {
  const existing = await chrome.alarms.get(CATALOG_ALARM);
  if (!existing) {
    await chrome.alarms.create(CATALOG_ALARM, {
      periodInMinutes: CATALOG_PERIOD_MINUTES,
      delayInMinutes: 1
    });
  }
}

async function ensureUpdateAlarm() {
  const existing = await chrome.alarms.get(UPDATE_ALARM);
  if (!existing) {
    await chrome.alarms.create(UPDATE_ALARM, {
      periodInMinutes: UPDATE_PERIOD_MINUTES,
      delayInMinutes: 0.5
    });
  }
}

function compareVersions(a, b) {
  const pa = String(a || "0").split(".").map((n) => parseInt(n, 10) || 0);
  const pb = String(b || "0").split(".").map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d > 0) return 1;
    if (d < 0) return -1;
  }
  return 0;
}

async function checkExtensionUpdate(reason) {
  try {
    const local = chrome.runtime.getManifest().version;
    const res = await fetch(VERSION_CHECK_URL, { cache: "no-store" });
    if (!res.ok) return;
    const remote = await res.json();
    const remoteVer = String(remote.version || "").trim();
    if (!remoteVer) return;

    const stored = await chrome.storage.local.get(["updateDismissedVersion"]);
    const newer = compareVersions(remoteVer, local) > 0;
    const dismissed = stored.updateDismissedVersion === remoteVer;

    if (newer && !dismissed) {
      await chrome.storage.local.set({
        updateAvailable: true,
        updateRemoteVersion: remoteVer,
        updateNotes: remote.notes || "",
        updateRepo: remote.repo || "https://github.com/benyamin-persia/imdb-stream-finder",
        releasesFeedUrl: remote.releasesFeed || DEFAULT_RELEASES_FEED,
        lastUpdateCheck: Date.now(),
        lastUpdateCheckReason: reason
      });
      await chrome.action.setBadgeText({ text: "NEW" });
      await chrome.action.setBadgeBackgroundColor({ color: "#e8a838" });
      await chrome.action.setTitle({
        title: `IMDb Stream Finder — update available (v${remoteVer})`
      });
    } else {
      await chrome.storage.local.set({
        updateAvailable: false,
        updateRemoteVersion: remoteVer,
        updateNotes: remote.notes || "",
        updateRepo: remote.repo || "https://github.com/benyamin-persia/imdb-stream-finder",
        releasesFeedUrl: remote.releasesFeed || DEFAULT_RELEASES_FEED,
        lastUpdateCheck: Date.now(),
        lastUpdateCheckReason: reason
      });
      if (!newer) {
        await chrome.action.setBadgeText({ text: "" });
        await chrome.action.setTitle({ title: "IMDb Stream Finder" });
      }
    }
  } catch (err) {
    console.warn("[Stream Finder] update check failed:", err);
  }
}

async function dismissUpdateBanner() {
  const stored = await chrome.storage.local.get(["updateRemoteVersion"]);
  await chrome.storage.local.set({
    updateAvailable: false,
    updateDismissedVersion: stored.updateRemoteVersion || ""
  });
  await chrome.action.setBadgeText({ text: "" });
  await chrome.action.setTitle({ title: "IMDb Stream Finder" });
}

// Parse Fandango Movies in Theaters HTML into poster cards
function parseFandangoReleasesHtml(html, baseUrl) {
  const items = [];
  const seen = new Set();
  const blockRe =
    /<a[^>]*class="[^"]*grid-item-link[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = blockRe.exec(html)) && items.length < 60) {
    const hrefPath = m[1];
    const block = m[2];
    const titleM = block.match(/class="[^"]*grid-item-title[^"]*"[^>]*>([^<]+)/i);
    const title = String(titleM?.[1] || "").replace(/\s+/g, " ").trim();
    if (!title || title.length < 2) continue;
    const key = title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    let poster = null;
    const lazy = block.match(/data-fd-lazy-image="([^"]+)"/i);
    const bg =
      block.match(/background-image:\s*url\(&quot;([^&]+)&quot;\)/i) ||
      block.match(/background-image:\s*url\(["']?([^"')]+)["']?\)/i);
    if (lazy) poster = lazy[1];
    else if (bg) poster = bg[1];
    if (poster) {
      poster = poster
        .replace(/&amp;/g, "&")
        .replace(/\\u0026/g, "&")
        .replace(/\/ImageRenderer\/\d+\/\d+\//i, "/ImageRenderer/300/450/")
        .trim();
    }

    const certM = block.match(/grid-item-certified[\s\S]*?<\/span>([^<]+)/i);
    const certified = String(certM?.[1] || "").replace(/\s+/g, " ").trim() || null;

    const sr = block.match(/class="[^"]*sr-only[^"]*"[^>]*>([^<]+)/i);
    const srText = String(sr?.[1] || "");
    const releasedM = srText.match(/Released\s+(.+)$/i);
    const released = releasedM ? releasedM[1].trim() : null;

    const yearM = title.match(/\((\d{4})\)/);
    let href = hrefPath;
    try {
      href = new URL(hrefPath, baseUrl).href;
    } catch (_) {}

    items.push({
      title,
      href,
      poster,
      certified,
      released,
      year: yearM ? yearM[1] : null,
      imdb: null
    });
  }
  return items;
}

function cleanReleaseTitle(title) {
  // Strip (2025) / trailing junk so IMDb suggestion matches the movie name
  return String(title || "")
    .replace(/\s*\(\d{4}\)\s*$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function pickImdbSuggestion(results, title, year) {
  const want = cleanReleaseTitle(title).toLowerCase();
  const yearNum = year ? Number(year) : null;
  const list = (results || []).filter((r) => /^tt\d{7,8}$/i.test(r?.id || ""));
  if (!list.length) return null;

  const score = (r) => {
    let s = 0;
    const name = String(r.l || "").toLowerCase();
    if (name === want) s += 100;
    else if (name.startsWith(want) || want.startsWith(name)) s += 40;
    else if (name.includes(want) || want.includes(name)) s += 15;
    const qid = String(r.qid || r.q || "").toLowerCase();
    if (qid === "movie" || qid === "feature") s += 30; // prefer theatrical movies
    if (qid === "tvseries" || qid === "tv") s -= 40;
    if (yearNum && Number(r.y) === yearNum) s += 50; // year from Fandango title wins ties
    if (yearNum && r.y && Math.abs(Number(r.y) - yearNum) <= 1) s += 10;
    return s;
  };

  list.sort((a, b) => score(b) - score(a));
  return list[0].id.toLowerCase();
}

async function resolveImdbId(title, year) {
  const q = cleanReleaseTitle(title);
  if (!q) return null;
  if (/^tt\d{7,8}$/i.test(q)) return q.toLowerCase();
  const first = q[0].toLowerCase();
  const pathChar = /[a-z0-9]/.test(first) ? first : "_"; // IMDb uses "_" for non-alnum
  const url =
    `https://v2.sg.media-imdb.com/suggestion/${pathChar}/` +
    `${encodeURIComponent(q)}.json`;
  try {
    const res = await fetch(url, {
      cache: "no-store",
      headers: { Accept: "application/json" }
    });
    if (!res.ok) return null;
    const data = await res.json();
    return pickImdbSuggestion(data?.d, title, year);
  } catch (_) {
    return null;
  }
}

async function enrichReleasesWithImdb(items) {
  const out = Array.isArray(items) ? items.slice() : [];
  const CONCURRENCY = 6; // resolve several at once without hammering IMDb
  let i = 0;
  async function worker() {
    while (i < out.length) {
      const idx = i++;
      const item = out[idx];
      if (item?.imdb && /^tt\d{7,8}$/i.test(item.imdb)) continue;
      const id = await resolveImdbId(item.title, item.year);
      if (id) out[idx] = { ...item, imdb: id };
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  return out;
}

// Indian / South Asian theatrical titles — user does not want these in Latest releases
const INDIAN_LANG_HINT =
  /\b(bollywood|tollywood|kollywood|sandalwood|mollywood|hindi|tamil|telugu|malayalam|kannada|punjabi|marathi|bengali|gujarati|bhojpuri|indian\s+film)\b/i;
const DEVANAGARI_RE = /[\u0900-\u097F]/; // Hindi etc. in the title
const INDIAN_ORIGIN_Q = "Q668"; // Wikidata India
const INDIAN_LANG_Q = new Set([
  "Q1568", // Hindi
  "Q5885", // Tamil
  "Q8097", // Telugu
  "Q36236", // Malayalam
  "Q3368", // Kannada
  "Q9610", // Bengali
  "Q1571", // Marathi
  "Q58635", // Punjabi
  "Q5137", // Gujarati
  "Q33265" // Bhojpuri
]);

function looksIndianFromText(item) {
  const blob = `${item?.title || ""} ${item?.href || ""} ${item?.certified || ""}`;
  if (DEVANAGARI_RE.test(blob)) return true;
  if (INDIAN_LANG_HINT.test(blob)) return true;
  return false;
}

async function isIndianViaWikidata(imdb) {
  if (!imdb || !/^tt\d{7,8}$/i.test(imdb)) return false;
  const sparql = `
    SELECT ?country ?lang WHERE {
      ?item wdt:P345 "${imdb.toLowerCase()}".
      OPTIONAL { ?item wdt:P495 ?country. }
      OPTIONAL { ?item wdt:P364 ?lang. }
    } LIMIT 8`.trim();
  try {
    const url =
      "https://query.wikidata.org/sparql?format=json&query=" + encodeURIComponent(sparql);
    const res = await fetch(url, {
      headers: { Accept: "application/sparql-results+json" },
      cache: "no-store"
    });
    if (!res.ok) return false;
    const data = await res.json();
    const rows = data?.results?.bindings || [];
    for (const row of rows) {
      const c = String(row.country?.value || "");
      const l = String(row.lang?.value || "");
      if (c.endsWith("/" + INDIAN_ORIGIN_Q) || c.endsWith(INDIAN_ORIGIN_Q)) return true;
      const langId = l.split("/").pop();
      if (langId && INDIAN_LANG_Q.has(langId)) return true;
    }
  } catch (_) {}
  return false;
}

async function filterOutIndianReleases(items) {
  const list = Array.isArray(items) ? items : [];
  const drop = new Array(list.length).fill(false);
  const CONCURRENCY = 4;
  let i = 0;
  async function worker() {
    while (i < list.length) {
      const idx = i++;
      const item = list[idx];
      if (!item) {
        drop[idx] = true;
        continue;
      }
      if (looksIndianFromText(item)) {
        drop[idx] = true;
        continue;
      }
      if (item.imdb && (await isIndianViaWikidata(item.imdb))) drop[idx] = true;
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  return list.filter((_, n) => !drop[n]);
}

async function refreshReleasesFeed(reason) {
  const stored = await chrome.storage.local.get(["releasesFeedUrl"]);
  let url = stored.releasesFeedUrl || DEFAULT_RELEASES_FEED;
  if (/onionplay/i.test(url)) url = DEFAULT_RELEASES_FEED; // migrate away from old feed
  try {
    const res = await fetch(url, {
      cache: "no-store",
      headers: {
        Accept: "text/html",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
      }
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const html = await res.text();
    let items = parseFandangoReleasesHtml(html, url);
    if (!items.length) throw new Error("no_titles_parsed");
    items = await enrichReleasesWithImdb(items); // attach tt##### so poster clicks open the title page
    items = await filterOutIndianReleases(items); // drop India / Hindi / Tamil / … titles
    await chrome.storage.local.set({
      latestReleases: items,
      latestReleasesAt: Date.now(),
      latestReleasesSource: url,
      releasesFeedUrl: url,
      lastReleasesRefreshReason: reason
    });
    const linked = items.filter((x) => x.imdb).length;
    return { ok: true, count: items.length, linked, url };
  } catch (err) {
    console.warn("[Stream Finder] releases refresh failed:", err);
    return { ok: false, error: String(err?.message || err), url };
  }
}

// Prefer local providers. Optional remote URL only if you set one yourself.
async function loadPrivateCatalogFile() {
  const candidates = ["providers.private.json", "private/providers-catalog.json"];
  for (const rel of candidates) {
    try {
      const res = await fetch(chrome.runtime.getURL(rel), { cache: "no-store" });
      if (!res.ok) continue;
      const data = await res.json();
      if (catalogHasProviders(data)) return data;
    } catch (_) {}
  }
  return null;
}

async function refreshProviderCatalog(reason) {
  try {
    const stored = await chrome.storage.local.get([
      "autoUpdateProviders",
      "catalogUrl",
      "movieLinks",
      "tvLinks"
    ]);
    if (stored.autoUpdateProviders === false) return;

    // Drop leftover localhost catalog URL if present (nothing should listen there)
    let remoteUrl = String(stored.catalogUrl || "").trim();
    if (/127\.0\.0\.1|localhost/i.test(remoteUrl)) {
      remoteUrl = "";
      await chrome.storage.local.remove("catalogUrl");
    }

    // 1) Bundled local catalog (providers.local.js)
    let catalog = catalogHasProviders(STREAM_PROVIDER_CATALOG) ? STREAM_PROVIDER_CATALOG : null;

    // 2) Optional remote JSON (only if user set a real URL)
    if (remoteUrl) {
      try {
        const res = await fetch(remoteUrl, { cache: "no-store" });
        if (res.ok) {
          const remote = await res.json();
          if (catalogHasProviders(remote)) catalog = remote;
        }
      } catch (err) {
        console.warn("[Stream Finder] remote catalog fetch failed:", err);
      }
    }

    // 3) Private JSON seed files
    if (!catalogHasProviders(catalog)) {
      catalog = await loadPrivateCatalogFile();
    }

    if (!catalogHasProviders(catalog)) return;

    const merged = mergeCatalogIntoLists(catalog, stored.movieLinks, stored.tvLinks);
    await chrome.storage.local.set({
      movieLinks: merged.movieLinks,
      tvLinks: merged.tvLinks,
      catalogVersion: merged.version || "local",
      catalogUpdated: merged.updated || null,
      lastCatalogRefresh: Date.now(),
      lastCatalogRefreshReason: reason,
      autoUpdateProviders: true
    });
  } catch (err) {
    console.warn("[Stream Finder] catalog refresh failed:", err);
  }
}

function queueSyncFromStorage(initDefaults) {
  enqueueSync(null, initDefaults);
}

function enqueueSync(enabledOverride, initDefaults = false) {
  syncChain = syncChain
    .then(async () => {
      if (initDefaults) {
        const stored = await chrome.storage.local.get([
          "lockerEnabled",
          "edgeAutoHide",
          "autoUpdateProviders"
        ]);
        if (
          stored.lockerEnabled === undefined ||
          stored.edgeAutoHide === undefined ||
          stored.autoUpdateProviders === undefined
        ) {
          const enabled =
            enabledOverride !== null ? enabledOverride : stored.lockerEnabled !== false;
          await syncAdRules(enabled);
          await chrome.storage.local.set({
            lockerEnabled: stored.lockerEnabled !== false,
            edgeAutoHide: stored.edgeAutoHide !== false,
            autoUpdateProviders: stored.autoUpdateProviders !== false
          });
          return;
        }
      }
      if (enabledOverride !== null) {
        await syncAdRules(enabledOverride);
        return;
      }
      const stored = await chrome.storage.local.get(["lockerEnabled"]);
      await syncAdRules(stored.lockerEnabled !== false);
    })
    .catch((err) => {
      console.warn("[Stream Finder] ad-rule sync failed:", err);
    });
  return syncChain;
}

async function syncAdRules(enabled) {
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const extraIds = existing
    .filter((r) => r.id >= AD_RULE_BASE && r.id < AD_RULE_BASE + 2000)
    .map((r) => r.id);
  const removeRuleIds = [...new Set([...OUR_RULE_IDS, ...extraIds])];

  if (!enabled) {
    if (removeRuleIds.length) {
      await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds,
        addRules: []
      });
    }
    return;
  }

  const resourceTypes = [
    "script",
    "xmlhttprequest",
    "image",
    "sub_frame",
    "ping",
    "other",
    "media",
    "websocket",
    "font"
  ];

  const addRules = AD_FILTERS.map((urlFilter, i) => ({
    id: AD_RULE_BASE + i,
    priority: 1,
    action: { type: "block" },
    condition: { urlFilter, resourceTypes }
  }));

  for (let i = 0; i < POPUNDER_MAIN_FRAME.length; i++) {
    addRules.push({
      id: POP_RULE_BASE + i,
      priority: 2,
      action: { type: "block" },
      condition: {
        urlFilter: POPUNDER_MAIN_FRAME[i],
        resourceTypes: ["main_frame", "sub_frame"]
      }
    });
  }

  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds,
    addRules
  });
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "probeEmbed") {
    probeEmbed(msg.url).then(sendResponse);
    return true;
  }
  if (msg?.type === "probeEmbedBatch") {
    const urls = Array.isArray(msg.urls) ? msg.urls : [];
    probeBatch(urls, 4).then(sendResponse);
    return true;
  }
  if (msg?.type === "refreshCatalogNow") {
    refreshProviderCatalog("manual").then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg?.type === "checkExtensionUpdate") {
    checkExtensionUpdate("manual").then(async () => {
      const s = await chrome.storage.local.get([
        "updateAvailable",
        "updateRemoteVersion",
        "updateNotes",
        "updateRepo"
      ]);
      sendResponse({ ok: true, ...s, localVersion: chrome.runtime.getManifest().version });
    });
    return true;
  }
  if (msg?.type === "dismissUpdate") {
    dismissUpdateBanner().then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg?.type === "openReleasesFeed") {
    chrome.storage.local.get(["releasesFeedUrl"]).then((s) => {
      const url = s.releasesFeedUrl || DEFAULT_RELEASES_FEED;
      chrome.tabs.create({ url }).then(() => sendResponse({ ok: true, url }));
    });
    return true;
  }
  if (msg?.type === "refreshReleasesFeed") {
    refreshReleasesFeed("manual").then(sendResponse);
    return true;
  }
  if (msg?.type === "resolveReleaseImdb") {
    // On-demand: popup click when cached item still has imdb:null
    resolveImdbId(msg.title, msg.year).then((imdb) => sendResponse({ ok: !!imdb, imdb }));
    return true;
  }
  if (msg?.type === "releasesScraped") {
    // Scrape path also left imdb null — resolve tt ids, drop Indian titles, then badge pulse
    chrome.storage.local.get(["latestReleases"]).then(async (s) => {
      let enriched = await enrichReleasesWithImdb(s.latestReleases || []);
      enriched = await filterOutIndianReleases(enriched);
      await chrome.storage.local.set({ latestReleases: enriched });
    });
    chrome.action.setBadgeText({ text: "TV" }).catch(() => {});
    setTimeout(() => {
      chrome.storage.local.get(["updateAvailable"]).then((s) => {
        chrome.action.setBadgeText({ text: s.updateAvailable ? "NEW" : "" });
      });
    }, 4000);
    sendResponse({ ok: true });
    return false;
  }
  if (msg?.type === "openCastTab") {
    const src = String(msg.src || "");
    const title = String(msg.title || "Stream");
    if (!src) {
      sendResponse({ ok: false, error: "missing_src" });
      return false;
    }
    const url =
      chrome.runtime.getURL("cast/cast.html") +
      `?src=${encodeURIComponent(src)}&title=${encodeURIComponent(title)}`;
    chrome.tabs.create({ url }).then(() => sendResponse({ ok: true }));
    return true; // async response
  }
  return false;
});

async function probeBatch(urls, concurrency) {
  const out = new Array(urls.length);
  let i = 0;
  async function worker() {
    while (i < urls.length) {
      const idx = i++;
      const url = urls[idx];
      out[idx] = { url, ...(await probeEmbed(url)) };
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, urls.length) }, () => worker()));
  return out;
}

async function probeEmbed(url) {
  try {
    const res = await fetch(url, {
      redirect: "follow",
      credentials: "omit",
      headers: {
        Accept: "text/html,application/xhtml+xml,*/*",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
      }
    });
    const status = res.status;
    const finalUrl = res.url;
    const text = (await res.text()).slice(0, 180000);
    const lower = text.toLowerCase();
    const verdict = classifyEmbedHtml(status, lower);
    return { ok: true, status, finalUrl, ...verdict };
  } catch (err) {
    return {
      ok: false,
      playable: null,
      label: "?",
      confidence: "low",
      score: 1,
      error: String(err?.message || err)
    };
  }
}

function classifyEmbedHtml(status, lower) {
  if (status === 404 || status === 410) {
    return pack("fail", false, "high", 0, { dead: true });
  }
  if (status === 403 || status === 451 || status === 429) {
    return pack("maybe", null, "low", 2, { blocked: true });
  }
  if (status < 200 || status >= 500) {
    return pack("maybe", null, "low", 1, { blocked: true });
  }

  const waf =
    lower.includes("cf-browser-verification") ||
    lower.includes("just a moment") ||
    lower.includes("attention required") ||
    lower.includes("enable javascript and cookies");

  const deadStrong =
    /no videos?\s+found|media not found|title not found|we couldn['’]t find|no sources available|"sources"\s*:\s*\[\s*\]|file was deleted|content is not available|invalid imdb|invalid tmdb|movie not found|tv show not found/.test(
      lower
    );

  const strongPlay =
    /\.m3u8(\?|"|'|\s|\\|\/|&|$)/.test(lower) ||
    /https?:\/\/[^"' <]+\.mp4/.test(lower) ||
    /jwplayer\s*\(/.test(lower) ||
    /new\s+hls\b/.test(lower) ||
    /hls\.js/.test(lower) ||
    /videojs\s*\(/.test(lower) ||
    /<source[^>]+src\s*=/.test(lower) ||
    /file\s*:\s*["']https?:\/\//.test(lower) ||
    /sources?\s*:\s*\[\s*\{/.test(lower);

  const playerShell =
    /<video[\s>]/.test(lower) ||
    /id=["']player["']/.test(lower) ||
    /class=["'][^"']*player/.test(lower) ||
    /plyr|clappr|jw-/.test(lower);

  if (deadStrong && !strongPlay) {
    return pack("fail", false, "high", 0, { dead: true });
  }
  if (waf && !strongPlay) {
    return pack("maybe", null, "low", 2, { blocked: true });
  }
  if (strongPlay) {
    return pack("ok", true, "high", 8, { hasPlayer: true });
  }
  if (playerShell) {
    return pack("maybe", null, "low", 3, { hasPlayer: true });
  }
  return pack("maybe", null, "low", 2, { hasPlayer: false });
}

function pack(label, playable, confidence, score, extra = {}) {
  return { label, playable, confidence, score, ...extra };
}
