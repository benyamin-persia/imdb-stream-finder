// Background: ad locker rules + playability probes + auto provider-list refresh
importScripts(
  "shared/ad-filters.js",
  "shared/catalog.js",
  "shared/providers.local.js", // local catalog (gitignored) — fills STREAM_PROVIDER_CATALOG
  "shared/defaults.js"
);

const AD_RULE_BASE = 1000;
const POP_RULE_BASE = 1800;
const CATALOG_ALARM = "isf-catalog-refresh";
const CATALOG_PERIOD_MINUTES = 720; // every 12 hours

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

chrome.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId !== IMDB_SEARCH_MENU_ID) return;
  const q = String(info.selectionText || "").trim(); // highlighted phrase from any page
  if (!q) return;
  const url = `https://www.imdb.com/find/?q=${encodeURIComponent(q)}`; // official IMDb find
  chrome.tabs.create({ url });
});

chrome.runtime.onInstalled.addListener(async () => {
  ensureImdbSearchMenu();
  queueSyncFromStorage(true);
  await ensureCatalogAlarm();
  await refreshProviderCatalog("install");
});

chrome.runtime.onStartup.addListener(async () => {
  ensureImdbSearchMenu();
  queueSyncFromStorage(false);
  await ensureCatalogAlarm();
  await refreshProviderCatalog("startup");
});

ensureImdbSearchMenu(); // recreate after service worker wake
queueSyncFromStorage(false);
ensureCatalogAlarm().then(() => refreshProviderCatalog("wakeup"));

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === CATALOG_ALARM) refreshProviderCatalog("alarm");
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
