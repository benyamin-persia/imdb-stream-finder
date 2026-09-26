(() => {
  const PANEL_ID = "imdb-stream-finder-panel"; // unique root id so we never inject twice
  const EDGE_ID = "imdb-stream-finder-edge"; // top-left corner tab (keeps right scrollbar free)
  const IMDB_RE = /\btt\d{7,8}\b/gi;
  const TMDB_PATH_RE = /(?:themoviedb\.org|tmdb\.org)\/(movie|tv)\/(\d+)/i;
  const TMDB_QUERY_RE = /[?&](?:tmdb|tmdb_id|tmdbId)=(\d+)/i;

  let state = {
    imdb: null,
    tmdb: null,
    mediaType: "movie",
    season: 1,
    episode: 1,
    movieLinks: [],
    tvLinks: [],
    resolving: false,
    lockerEnabled: true,
    edgeAutoHide: true,
    probeResults: {}, // href -> probe verdict
    playQueue: [], // ranked candidates for Next source
    playIndex: -1,
    nowPlayingHref: null,
    pendingTitle: null // highlighted title the user wants to look up
  };

  let hideTimer = null;

  function extAlive() {
    // False after chrome://extensions Reload — old page scripts must stop using chrome.*
    try {
      return Boolean(chrome?.runtime?.id);
    } catch (_) {
      return false;
    }
  }

  async function storageGet(keys) {
    if (!extAlive()) return {};
    try {
      return await chrome.storage.local.get(keys);
    } catch (_) {
      return {};
    }
  }

  async function storageSet(obj) {
    if (!extAlive()) return;
    try {
      await chrome.storage.local.set(obj);
    } catch (_) {}
  }

  function storageGetCb(keys, cb) {
    if (!extAlive()) {
      cb({});
      return;
    }
    try {
      chrome.storage.local.get(keys, (stored) => {
        if (chrome.runtime.lastError) cb({});
        else cb(stored || {});
      });
    } catch (_) {
      cb({});
    }
  }

  init().catch(() => {}); // swallow "Extension context invalidated" after reload

  async function init() {
    if (!extAlive()) return;
    const stored = await storageGet([
      "movieLinks",
      "tvLinks",
      "lockerEnabled",
      "edgeAutoHide"
    ]);
    state.movieLinks = mergeLinkLists(stored.movieLinks, STREAM_FINDER_DEFAULTS.movieLinks);
    state.tvLinks = mergeLinkLists(stored.tvLinks, STREAM_FINDER_DEFAULTS.tvLinks);
    // Only persist when we actually have sources (never write empty over a good list)
    if (state.movieLinks.length || state.tvLinks.length) {
      await storageSet({
        movieLinks: state.movieLinks,
        tvLinks: state.tvLinks
      });
    } else {
      // Ask background to seed from local catalog, then re-read
      try {
        if (extAlive()) await chrome.runtime.sendMessage({ type: "refreshCatalogNow" });
      } catch (_) {}
      const again = await storageGet(["movieLinks", "tvLinks"]);
      state.movieLinks = again.movieLinks || [];
      state.tvLinks = again.tvLinks || [];
    }
    state.lockerEnabled = stored.lockerEnabled !== false;
    state.edgeAutoHide = stored.edgeAutoHide !== false;
    syncLockerMain(state.lockerEnabled);

    scanPage();
    injectChrome();
    // Remove leftover browse iframe from older builds
    document.getElementById("isf-imdb-browse")?.remove();
    document.documentElement.classList.remove("isf-imdb-framed");
    window.addEventListener("popstate", () => {
      // Back/forward: soft-swap IMDb again so SF still does not remount
      const m = location.pathname.match(/\/title\/(tt\d{7,8})\/?/i);
      if (!m || !isOnImdbHost()) return;
      softOpenImdbTitle(m[1], null, { push: false }).catch(() => {});
    });
    await enrichIds();
    applyChromeVisibility(); // only show SF when IMDb/TMDB found (or later via highlight)
    renderLinks();
    await loadPanelReleases(); // fill right-side Latest releases from storage
    bindTitleSelection(); // highlight a title → reveal Stream Finder

    if (!extAlive()) return;
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (!extAlive() || area !== "local") return;
        if (changes.movieLinks) state.movieLinks = changes.movieLinks.newValue;
        if (changes.tvLinks) state.tvLinks = changes.tvLinks.newValue;
        if (changes.lockerEnabled) {
          state.lockerEnabled = changes.lockerEnabled.newValue !== false;
          syncLockerMain(state.lockerEnabled);
          syncLockerUi();
        }
        if (changes.edgeAutoHide) {
          state.edgeAutoHide = changes.edgeAutoHide.newValue !== false;
          applyChromeVisibility();
        }
        if (changes.updateAvailable || changes.updateRemoteVersion) syncUpdateTip();
        if (changes.latestReleases || changes.latestReleasesAt) {
          storageGet(["latestReleases", "latestReleasesAt"]).then((s) => {
            renderPanelReleases(s.latestReleases || [], s.latestReleasesAt);
          });
        }
        renderLinks();
      });
    } catch (_) {}
  }

  function syncUpdateTip() {
    const tip = document.querySelector(`#${PANEL_ID} .isf-update-tip`);
    const text = document.querySelector(`#${PANEL_ID} .isf-update-tip-text`);
    if (!tip) return;
    storageGetCb(["updateAvailable", "updateRemoteVersion"], (stored) => {
      if (stored.updateAvailable && stored.updateRemoteVersion) {
        tip.hidden = false;
        if (text) text.textContent = `Update available → v${stored.updateRemoteVersion}`;
      } else {
        tip.hidden = true;
      }
    });
  }

  function syncLockerMain(on) {
    window.postMessage({ source: "isf-locker", enabled: on }, "*");
  }

  function scanPage() {
    const seriesImdb = findSeriesImdbOnPage();
    const pageImdb = findPageImdb(); // careful scan — avoid random tt hits in scripts
    state.imdb = (seriesImdb || pageImdb || "").toLowerCase() || null;

    const tmdbHit = findTmdbOnPage();
    if (tmdbHit) {
      state.tmdb = tmdbHit.id;
      if (tmdbHit.kind === "tv") state.mediaType = "tv";
      if (tmdbHit.kind === "movie") state.mediaType = "movie";
    }

    state.mediaType = detectMediaType() || state.mediaType;

    const se = location.href.match(/[?&](?:season|s)=(\d+)/i);
    const ep = location.href.match(/[?&](?:episode|e)=(\d+)/i);
    const pathSe = location.pathname.match(/\/(?:season|s)\/(\d+)/i);
    const pathEp = location.pathname.match(/\/(?:episode|e)\/(\d+)/i);
    if (se) state.season = Number(se[1]);
    if (ep) state.episode = Number(ep[1]);
    if (pathSe) state.season = Number(pathSe[1]);
    if (pathEp) state.episode = Number(pathEp[1]);

    const epMeta = document.querySelector(
      '[data-testid="hero-subnav-bar-season-episode-numbers-section"]'
    );
    if (epMeta) {
      const m = epMeta.textContent.match(/S(\d+)\s*[.·]?\s*E(\d+)/i);
      if (m) {
        state.season = Number(m[1]);
        state.episode = Number(m[2]);
        state.mediaType = "tv";
      }
    }
  }

  // Prefer URL / meta / links — full HTML scan only on IMDb/TMDB hosts
  function findPageImdb() {
    const fromUrl = findFirstImdb(location.href);
    if (fromUrl) return fromUrl;

    const canon = document.querySelector('link[rel="canonical"]')?.href || "";
    const og = document.querySelector('meta[property="og:url"]')?.content || "";
    const fromMeta = findFirstImdb(canon) || findFirstImdb(og);
    if (fromMeta) return fromMeta;

    for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const id = findFirstImdb(script.textContent || "");
        if (id) return id;
      } catch (_) {}
    }

    const titleLink =
      document.querySelector('a[href*="imdb.com/title/tt"]') ||
      document.querySelector('a[href*="/title/tt"]');
    if (titleLink) {
      const id = findFirstImdb(titleLink.getAttribute("href") || "");
      if (id) return id;
    }

    if (/imdb\.com|themoviedb\.org|tmdb\.org/i.test(location.hostname)) {
      return findFirstImdb(document.documentElement.innerHTML.slice(0, 400000));
    }
    return null;
  }

  function findFirstImdb(text) {
    const m = String(text || "").match(IMDB_RE);
    return m ? m[0] : null;
  }

  function findSeriesImdbOnPage() {
    for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const data = JSON.parse(script.textContent);
        const nodes = Array.isArray(data) ? data : [data];
        for (const node of nodes) {
          const series = node?.partOfSeries;
          const url = series?.url || series?.["@id"] || "";
          const id = findFirstImdb(url) || findFirstImdb(series?.sameAs || "");
          if (id) return id;
        }
      } catch (_) {}
    }
    const seriesLink =
      document.querySelector('a[data-testid="hero-title-block__series-link"]') ||
      document.querySelector('.ipc-page-section a[href*="/title/tt"]');
    if (seriesLink) return findFirstImdb(seriesLink.getAttribute("href") || "");
    return null;
  }

  function findTmdbOnPage() {
    // URL / meta first — don't treat random scripts as a TMDB hit on every site
    const fromUrl = location.href.match(TMDB_PATH_RE) || location.href.match(TMDB_QUERY_RE);
    if (fromUrl) {
      if (fromUrl[2]) return { kind: fromUrl[1].toLowerCase(), id: fromUrl[2] };
      return { kind: null, id: fromUrl[1] };
    }
    const canon = document.querySelector('link[rel="canonical"]')?.href || "";
    const og = document.querySelector('meta[property="og:url"]')?.content || "";
    const metaHit = (canon + "\n" + og).match(TMDB_PATH_RE);
    if (metaHit) return { kind: metaHit[1].toLowerCase(), id: metaHit[2] };

    const tmdbLink = document.querySelector('a[href*="themoviedb.org/"], a[href*="tmdb.org/"]');
    if (tmdbLink) {
      const href = tmdbLink.getAttribute("href") || "";
      const path = href.match(TMDB_PATH_RE);
      if (path) return { kind: path[1].toLowerCase(), id: path[2] };
    }

    if (/imdb\.com|themoviedb\.org|tmdb\.org/i.test(location.hostname)) {
      const html = document.documentElement.innerHTML.slice(0, 400000);
      const path = html.match(TMDB_PATH_RE);
      if (path) return { kind: path[1].toLowerCase(), id: path[2] };
      const q = html.match(TMDB_QUERY_RE);
      if (q) return { kind: null, id: q[1] };
    }
    return null;
  }

  function detectMediaType() {
    for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const data = JSON.parse(script.textContent);
        const nodes = Array.isArray(data) ? data : [data];
        for (const node of nodes) {
          const types = []
            .concat(node?.["@type"] || [])
            .flat()
            .map((t) => String(t).toLowerCase());
          if (types.some((t) => /tvseries|tvepisode|tvseason|tvminiseries|radioseries/.test(t))) {
            return "tv";
          }
          if (types.some((t) => t === "movie")) return "movie";
        }
      } catch (_) {}
    }
    const ogType = document.querySelector('meta[property="og:type"]')?.content || "";
    if (/video\.tv_show|tv_show|tvseries/i.test(ogType)) return "tv";
    if (/video\.movie/i.test(ogType)) return "movie";
    const heroMeta =
      document.querySelector('[data-testid="hero-title-block__metadata"]')?.innerText || "";
    if (/TV Mini Series|TV Series|TV Episode|Podcast Series/i.test(heroMeta)) return "tv";
    if (/TV Movie/i.test(heroMeta)) return "movie";
    if (/\/tv\//i.test(location.pathname) || /[?&]type=tv\b/i.test(location.search)) return "tv";
    if (/\/movie\//i.test(location.pathname)) return "movie";
    const topText = (document.body?.innerText || "").slice(0, 12000);
    if (/\bTV Mini Series\b|\bTV Series\b|\bTV Episode\b/i.test(topText)) return "tv";
    return null;
  }

  async function enrichIds() {
    if (!state.imdb) return;
    setStatus("Looking up titles…");
    state.resolving = true;
    try {
      const info = await lookupViaWikidata(state.imdb);
      if (info.tmdbTv) {
        state.tmdb = String(info.tmdbTv);
        state.mediaType = "tv";
      } else if (info.tmdbMovie) {
        state.tmdb = String(info.tmdbMovie);
        if (state.mediaType !== "tv") state.mediaType = "movie";
      }
      if (info.isTv) state.mediaType = "tv";
      if (info.isMovie && state.mediaType !== "tv") state.mediaType = "movie";
    } catch (_) {
    } finally {
      state.resolving = false;
      syncTypeUi();
      syncIdInputs();
      setStatus("");
    }
  }

  async function lookupViaWikidata(imdb) {
    const sparql = `
      SELECT ?tmdbMovie ?tmdbTv ?isTv ?isMovie WHERE {
        ?item wdt:P345 "${imdb}".
        OPTIONAL { ?item wdt:P4947 ?tmdbMovie. }
        OPTIONAL { ?item wdt:P4983 ?tmdbTv. }
        BIND(EXISTS { ?item wdt:P31/wdt:P279* wd:Q5398426 } AS ?isTv)
        BIND(EXISTS { ?item wdt:P31/wdt:P279* wd:Q11424 } AS ?isMovie)
      } LIMIT 1`.trim();
    const url =
      "https://query.wikidata.org/sparql?format=json&query=" + encodeURIComponent(sparql);
    const res = await fetch(url, { headers: { Accept: "application/sparql-results+json" } });
    if (!res.ok) throw new Error("wikidata " + res.status);
    const json = await res.json();
    const row = json?.results?.bindings?.[0] || {};
    return {
      tmdbMovie: row.tmdbMovie?.value || null,
      tmdbTv: row.tmdbTv?.value || null,
      isTv: row.isTv?.value === "true",
      isMovie: row.isMovie?.value === "true"
    };
  }

  function vars() {
    return {
      imdb: state.imdb || "",
      imdbRaw: state.imdb ? state.imdb.replace(/^tt/i, "") : "",
      tmdb: state.tmdb || "",
      season: state.season,
      episode: state.episode,
      type: state.mediaType
    };
  }

  function injectChrome() {
    if (document.getElementById(PANEL_ID)) return;

    const edge = document.createElement("div");
    edge.id = EDGE_ID;
    edge.title = "Stream Finder — hover top-left to open";
    document.documentElement.appendChild(edge);

    const panel = document.createElement("aside");
    panel.id = PANEL_ID;
    panel.innerHTML = `
      <header class="isf-header">
        <div class="isf-title">Stream Finder</div>
        <div class="isf-header-actions">
          <button type="button" class="isf-pin" title="Pin open — shrinks the page to sit beside Stream Finder">📌</button>
          <button type="button" class="isf-minimize" title="Hide" aria-label="Hide">×</button>
        </div>
      </header>
      <div class="isf-update-tip" hidden>
        <span class="isf-update-tip-text">Update available</span>
        <button type="button" class="isf-update-open">Get it</button>
        <button type="button" class="isf-update-dismiss">×</button>
      </div>
      <div class="isf-player-wrap" hidden>
        <div class="isf-player-bar">
          <div class="isf-now-playing">
            <span class="isf-live-dot" aria-hidden="true"></span>
            <span class="isf-player-title">Nothing playing</span>
          </div>
          <div class="isf-player-bar-actions">
            <button type="button" class="isf-cast-btn" title="Cast to Chromecast / TV">📡</button>
            <button type="button" class="isf-fs-btn" title="Fullscreen">⛶</button>
            <button type="button" class="isf-player-close" title="Close">×</button>
          </div>
        </div>
        <div class="isf-source-nav">
          <button type="button" class="isf-prev-src">◀ Prev</button>
          <span class="isf-source-pos">—</span>
          <button type="button" class="isf-next-src">Next source ▶</button>
        </div>
        <div class="isf-stage">
          <iframe class="isf-player" title="Stream embed" allow="autoplay; fullscreen; encrypted-media; picture-in-picture" referrerpolicy="origin"></iframe>
          <button type="button" class="isf-expand-hit" title="Click for fullscreen">
            Click player for fullscreen
          </button>
        </div>
        <p class="isf-probe-line"></p>
      </div>
      <div class="isf-split">
        <div class="isf-scroll">
          <p class="isf-status" hidden></p>
          <div class="isf-ids">
            <label>IMDb <input type="text" class="isf-imdb" placeholder="tt0000000" spellcheck="false" /></label>
            <label>TMDB <input type="text" class="isf-tmdb" placeholder="12345" spellcheck="false" /></label>
          </div>
          <div class="isf-title-search">
            <label>Title <input type="text" class="isf-title-query" placeholder="Highlight a title or type one" spellcheck="false" /></label>
            <button type="button" class="isf-lookup-title">Lookup</button>
          </div>
          <div class="isf-type">
            <button type="button" data-type="movie" class="isf-type-btn">Movie</button>
            <button type="button" data-type="tv" class="isf-type-btn">TV</button>
          </div>
          <div class="isf-tv-controls" hidden>
            <label>Season <input type="number" class="isf-season" min="1" value="1" /></label>
            <label>Episode <input type="number" class="isf-episode" min="1" value="1" /></label>
            <button type="button" class="isf-play-episode" title="Load and play this season/episode">
              Play episode
            </button>
          </div>
          <label class="isf-locker-row">
            <input type="checkbox" class="isf-locker-toggle" />
            <span>Popup + ad locker</span>
          </label>
          <button type="button" class="isf-test-all">Test all & play best</button>
          <div class="isf-links-head">Sources</div>
          <div class="isf-links"></div>
          <p class="isf-hint">Player stays on top while you scroll sources. OK / ? / FAIL — use Next if blank.</p>
        </div>
        <aside class="isf-releases" aria-label="Latest releases">
          <div class="isf-releases-head">
            <h3>Latest releases</h3>
            <button type="button" class="isf-releases-refresh">Refresh</button>
          </div>
          <p class="isf-releases-meta">Now playing — click a poster to update the IMDb page (Stream Finder stays open).</p>
          <div class="isf-releases-list"></div>
        </aside>
      </div>
    `;
    document.documentElement.appendChild(panel);

    const imdbInput = panel.querySelector(".isf-imdb");
    const tmdbInput = panel.querySelector(".isf-tmdb");
    const titleInput = panel.querySelector(".isf-title-query");
    const seasonInput = panel.querySelector(".isf-season");
    const episodeInput = panel.querySelector(".isf-episode");
    const lockerToggle = panel.querySelector(".isf-locker-toggle");

    imdbInput.value = state.imdb || "";
    tmdbInput.value = state.tmdb || "";
    titleInput.value = state.pendingTitle || "";
    seasonInput.value = state.season;
    episodeInput.value = state.episode;
    lockerToggle.checked = state.lockerEnabled;

    panel.querySelector(".isf-minimize").addEventListener("click", () => hidePanelSoon(0));
    panel.querySelector(".isf-pin").addEventListener("click", async () => {
      state.edgeAutoHide = !state.edgeAutoHide;
      await storageSet({ edgeAutoHide: state.edgeAutoHide });
      applyChromeVisibility();
      setStatus(
        state.edgeAutoHide
          ? "Auto-hide on (hover top-left)"
          : "Pinned — page shrunk to fit beside Stream Finder"
      );
    });
    panel.querySelector(".isf-player-close").addEventListener("click", () => closePlayer());
    panel.querySelector(".isf-cast-btn").addEventListener("click", () => openCastTab());
    panel.querySelector(".isf-fs-btn").addEventListener("click", () => togglePlayerFullscreen());
    panel.querySelector(".isf-expand-hit").addEventListener("click", () => {
      togglePlayerFullscreen(true); // enter fullscreen from click-on-player
    });
    panel.querySelector(".isf-test-all").addEventListener("click", () => testAllAndPlay());
    panel.querySelector(".isf-next-src").addEventListener("click", () => shiftSource(1));
    panel.querySelector(".isf-prev-src").addEventListener("click", () => shiftSource(-1));
    panel.querySelector(".isf-lookup-title").addEventListener("click", () => {
      lookupTitle(titleInput.value.trim());
    });
    titleInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") lookupTitle(titleInput.value.trim());
    });
    panel.querySelector(".isf-releases-refresh").addEventListener("click", () => refreshPanelReleases());
    panel.querySelector(".isf-update-dismiss").addEventListener("click", async () => {
      try {
        if (extAlive()) await chrome.runtime.sendMessage({ type: "dismissUpdate" });
      } catch (_) {}
      syncUpdateTip();
    });
    panel.querySelector(".isf-update-open").addEventListener("click", async () => {
      const stored = await storageGet(["updateRepo"]);
      const url = stored.updateRepo || "https://github.com/benyamin-persia/imdb-stream-finder";
      window.open(url, "_blank", "noopener,noreferrer");
    });
    syncUpdateTip();

    document.addEventListener("fullscreenchange", () => {
      const wrap = document.querySelector(`#${PANEL_ID} .isf-player-wrap`);
      const hit = document.querySelector(`#${PANEL_ID} .isf-expand-hit`);
      if (!wrap) return;
      const fs = document.fullscreenElement === wrap;
      wrap.classList.toggle("isf-fs", fs);
      if (hit) hit.hidden = fs; // let user control the embed once fullscreen
    });

    lockerToggle.addEventListener("change", async () => {
      state.lockerEnabled = lockerToggle.checked;
      await storageSet({ lockerEnabled: state.lockerEnabled });
      syncLockerMain(state.lockerEnabled);
      setStatus(state.lockerEnabled ? "Locker ON" : "Locker OFF");
    });

    imdbInput.addEventListener("input", async () => {
      const v = imdbInput.value.trim();
      state.imdb = /^tt\d{7,8}$/i.test(v) ? v.toLowerCase() : v || null;
      applyChromeVisibility();
      renderLinks();
      if (state.imdb) await enrichIds();
    });
    tmdbInput.addEventListener("input", () => {
      const v = tmdbInput.value.trim();
      state.tmdb = /^\d+$/.test(v) ? v : v || null;
      applyChromeVisibility();
      renderLinks();
    });
    seasonInput.addEventListener("input", () => syncSeasonEpisodeInputs(seasonInput, episodeInput));
    seasonInput.addEventListener("change", () => syncSeasonEpisodeInputs(seasonInput, episodeInput));
    episodeInput.addEventListener("input", () => syncSeasonEpisodeInputs(seasonInput, episodeInput));
    episodeInput.addEventListener("change", () => syncSeasonEpisodeInputs(seasonInput, episodeInput));
    panel.querySelector(".isf-play-episode").addEventListener("click", () => {
      syncSeasonEpisodeInputs(seasonInput, episodeInput);
      playSelectedEpisode();
    });

    panel.querySelectorAll(".isf-type-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.mediaType = btn.dataset.type;
        syncTypeUi();
        state.probeResults = {}; // movie/tv URLs differ
        renderLinks();
        setStatus(
          state.mediaType === "tv"
            ? "TV mode — pick Season & Episode, then Play episode"
            : "Movie mode"
        );
      });
    });

    // Top-left tab opens; leave hides (unless pinned) — right edge stays free for page scrollbar
    edge.addEventListener("mouseenter", () => showPanel());
    edge.addEventListener("click", () => showPanel()); // also click for touchpads / stubborn hover
    panel.addEventListener("mouseenter", () => {
      clearTimeout(hideTimer);
    });
    panel.addEventListener("mouseleave", () => {
      if (state.edgeAutoHide) hidePanelSoon(450);
    });

    // Keep wheel/trackpad scroll inside the hovered pane — never the host page or the wrong column
    panel.addEventListener(
      "wheel",
      (e) => {
        e.stopPropagation();
        e.preventDefault();
        // Prefer the pane under the cursor: Latest releases vs Sources
        const path = typeof e.composedPath === "function" ? e.composedPath() : [];
        let scrollEl = null;
        for (const node of path) {
          if (!node || !node.classList) continue;
          if (node.classList.contains("isf-releases-list") || node.classList.contains("isf-scroll")) {
            scrollEl = node;
            break;
          }
        }
        if (!scrollEl) {
          const overReleases = e.target?.closest?.(".isf-releases");
          scrollEl = overReleases
            ? panel.querySelector(".isf-releases-list")
            : panel.querySelector(".isf-scroll");
        }
        if (!scrollEl) return;
        const maxScroll = Math.max(0, scrollEl.scrollHeight - scrollEl.clientHeight);
        scrollEl.scrollTop = Math.min(maxScroll, Math.max(0, scrollEl.scrollTop + e.deltaY));
      },
      { passive: false }
    );

    applyChromeVisibility();
    syncTypeUi();
    syncLockerUi();
    renderLinks();
  }

  function hasMediaSignal() {
    return !!(state.imdb || state.tmdb || state.pendingTitle);
  }

  // Hide SF completely on pages with no IMDb/TMDB and no title highlight
  function applyChromeVisibility() {
    const panel = document.getElementById(PANEL_ID);
    const edge = document.getElementById(EDGE_ID);
    if (!panel || !edge) return;

    if (!hasMediaSignal()) {
      clearTimeout(hideTimer);
      edge.hidden = true;
      panel.hidden = true;
      panel.classList.remove("isf-open", "isf-pinned", "isf-playing");
      panel.classList.add("isf-hidden");
      applyPageDock(false); // restore full page width when SF is gone
      return;
    }

    panel.hidden = false;
    const pinned = !state.edgeAutoHide; // pin = keep open + dock page
    panel.classList.toggle("isf-pinned", pinned);
    edge.hidden = !state.edgeAutoHide; // tab only when auto-hide mode
    edge.title = state.pendingTitle
      ? `Stream Finder — “${state.pendingTitle.slice(0, 40)}”`
      : "Stream Finder — hover top-left to open";

    if (pinned) showPanel();
    else hidePanelSoon(0);
    applyPageDock(pinned); // shrink host page only while pinned
  }

  function applyPageDock(on) {
    const root = document.documentElement;
    if (!on) {
      root.classList.remove("isf-docked");
      root.style.removeProperty("--isf-dock-w");
      return;
    }
    const panel = document.getElementById(PANEL_ID);
    // Match real panel width so the page gutter lines up with SF
    const w = panel
      ? Math.round(panel.getBoundingClientRect().width) || Math.round(window.innerWidth * 0.42)
      : Math.round(window.innerWidth * 0.42);
    root.style.setProperty("--isf-dock-w", `${w}px`);
    root.classList.add("isf-docked");
  }

  function normalizePosterUrl(url) {
    if (!url) return null;
    let u = String(url).trim();
    u = u.replace(/\/ImageRenderer\/\d+\/\d+\//i, "/ImageRenderer/300/450/");
    return u;
  }

  async function loadPanelReleases() {
    const stored = await storageGet(["latestReleases", "latestReleasesAt"]);
    renderPanelReleases(stored.latestReleases || [], stored.latestReleasesAt);
    // Auto-fetch once if empty so the right pane isn't blank on first open
    if (!(stored.latestReleases || []).length && extAlive()) {
      refreshPanelReleases();
    }
  }

  async function refreshPanelReleases() {
    const meta = document.querySelector(`#${PANEL_ID} .isf-releases-meta`);
    const btn = document.querySelector(`#${PANEL_ID} .isf-releases-refresh`);
    if (meta) meta.textContent = "Fetching now-playing…";
    if (btn) btn.disabled = true;
    try {
      if (!extAlive()) throw new Error("extension_reloaded");
      const res = await chrome.runtime.sendMessage({ type: "refreshReleasesFeed" });
      const stored = await storageGet(["latestReleases", "latestReleasesAt"]);
      renderPanelReleases(stored.latestReleases || [], stored.latestReleasesAt);
      if (!res?.ok && meta) meta.textContent = "Fetch failed — try Refresh again";
    } catch (_) {
      if (meta) meta.textContent = "Could not refresh — reload extension / page";
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  function renderPanelReleases(items, at) {
    state._releases = items || [];
    const list = document.querySelector(`#${PANEL_ID} .isf-releases-list`);
    const meta = document.querySelector(`#${PANEL_ID} .isf-releases-meta`);
    if (!list || !meta) return;
    list.innerHTML = "";
    if (!items.length) {
      meta.textContent = "No list yet — click Refresh to load Fandango now-playing.";
      return;
    }
    meta.textContent =
      `${items.length} now playing` +
      (at ? ` · ${new Date(at).toLocaleString()}` : "") +
      " · click → update IMDb page (SF stays open)";

    for (const item of items.slice(0, 48)) {
      const card = document.createElement("div");
      card.className = "isf-release-card";
      card.role = "button";
      card.tabIndex = 0;
      card.title = item.title + (item.imdb ? ` (${item.imdb})` : "");
      card.style.cssText =
        "display:flex;flex-direction:column;margin:0;padding:0;overflow:hidden;" +
        "min-height:200px;height:auto;border:1px solid #2e3548;border-radius:8px;background:#12161f;cursor:pointer;";

      const wrap = document.createElement("div");
      wrap.className = "isf-release-poster-wrap";
      // Fixed px height + in-flow img (absolute posters were stacking on top of each other)
      wrap.style.cssText =
        "display:block;width:100%;height:170px;min-height:170px;max-height:170px;" +
        "flex:0 0 170px;padding:0;margin:0;background:#1a2030;overflow:hidden;";

      const posterUrl = normalizePosterUrl(item.poster);
      if (posterUrl) {
        const img = document.createElement("img");
        img.className = "isf-release-poster";
        img.src = posterUrl;
        img.alt = item.title;
        img.loading = "lazy";
        img.decoding = "async";
        img.style.cssText =
          "display:block;position:static;width:100%;height:170px;min-height:170px;" +
          "object-fit:cover;object-position:center top;border:0;margin:0;padding:0;";
        wrap.appendChild(img);
      } else {
        const ph = document.createElement("div");
        ph.className = "isf-release-poster isf-release-poster--empty";
        ph.style.cssText = "display:block;width:100%;height:170px;background:linear-gradient(160deg,#1a2030,#0c0e14);";
        wrap.appendChild(ph);
      }
      card.appendChild(wrap);

      const info = document.createElement("div");
      info.className = "isf-release-meta";
      info.style.cssText = "display:grid;gap:2px;padding:5px 6px 7px;min-width:0;flex:0 0 auto;";
      const title = document.createElement("span");
      title.className = "isf-release-title";
      title.textContent = item.title;
      info.appendChild(title);
      if (item.certified) {
        const badge = document.createElement("span");
        badge.className = "isf-release-certified";
        badge.textContent = item.certified;
        info.appendChild(badge);
      } else if (item.released) {
        const rel = document.createElement("span");
        rel.className = "isf-release-date";
        rel.textContent = item.released;
        info.appendChild(rel);
      }
      card.appendChild(info);

      const activate = () => selectReleaseInPanel(item);
      card.addEventListener("click", activate);
      card.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          activate();
        }
      });
      list.appendChild(card);
    }
  }

  async function selectReleaseInPanel(item) {
    showPanel();
    setStatus(`Opening IMDb for “${item.title}”…`);
    let id = item.imdb && /^tt\d{7,8}$/i.test(item.imdb) ? item.imdb.toLowerCase() : null;
    if (!id && extAlive()) {
      try {
        const res = await chrome.runtime.sendMessage({
          type: "resolveReleaseImdb",
          title: item.title,
          year: item.year
        });
        if (res?.imdb) id = res.imdb;
      } catch (_) {}
    }
    if (!id) {
      setStatus(`No IMDb id for “${item.title}”`);
      return;
    }

    // Keep SF pinned so the dock stays while we swap only the IMDb page content
    if (state.edgeAutoHide) {
      state.edgeAutoHide = false;
      await storageSet({ edgeAutoHide: false });
    }

    try {
      await softOpenImdbTitle(id, item.title, { push: true });
    } catch (err) {
      // Last resort: full navigation (SF remounts) — only if soft swap failed
      setStatus("Soft open failed — loading page…");
      location.assign(`https://www.imdb.com/title/${id}/`);
    }
  }

  function isOnImdbHost() {
    return /(^|\.)imdb\.com$/i.test(location.hostname);
  }

  // Swap only IMDb’s page tree — Stream Finder nodes on <html> stay mounted
  async function softOpenImdbTitle(id, titleLabel, { push = true } = {}) {
    const tt = String(id || "").toLowerCase();
    if (!/^tt\d{7,8}$/.test(tt)) throw new Error("bad_imdb");

    if (!isOnImdbHost()) {
      // Must be on IMDb for in-place swap; one hard navigation to get there
      location.assign(`https://www.imdb.com/title/${tt}/`);
      return;
    }

    const path = `/title/${tt}/`;
    // Already on this title — just sync SF
    if (location.pathname.replace(/\/$/, "") === path.replace(/\/$/, "")) {
      await applyTitleToStreamFinder(tt, titleLabel);
      setStatus(`Already on “${titleLabel || tt}”`);
      return;
    }

    setStatus(`Loading “${titleLabel || tt}”…`);
    const res = await fetch(path, {
      credentials: "include",
      cache: "no-store",
      headers: { Accept: "text/html" }
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const html = await res.text();
    const doc = new DOMParser().parseFromString(html, "text/html");

    const panel = document.getElementById(PANEL_ID);
    const edge = document.getElementById(EDGE_ID);

    const newNext = doc.getElementById("__next");
    const oldNext = document.getElementById("__next");
    if (newNext && oldNext) {
      const imported = document.importNode(newNext, true);
      imported.querySelectorAll("script").forEach((s) => s.remove()); // don't re-exec Next bundles
      oldNext.replaceWith(imported);
    } else {
      // Generic fallback: replace body kids except SF chrome
      const keep = new Set([PANEL_ID, EDGE_ID]);
      [...document.body.children].forEach((el) => {
        if (!keep.has(el.id)) el.remove();
      });
      [...doc.body.children].forEach((el) => {
        if (el.tagName === "SCRIPT") return;
        if (keep.has(el.id)) return;
        document.body.appendChild(document.importNode(el, true));
      });
    }

    // SF must stay on <html> above the page (never lost in a body replace)
    if (edge) document.documentElement.appendChild(edge);
    if (panel) document.documentElement.appendChild(panel);

    if (doc.title) document.title = doc.title;
    if (push) history.pushState({ isfSoft: tt }, document.title, path);
    else history.replaceState({ isfSoft: tt }, document.title, path);
    window.scrollTo(0, 0);

    await applyTitleToStreamFinder(tt, titleLabel);
    setStatus(`“${titleLabel || tt}” — page updated, Stream Finder stayed open`);
  }

  async function applyTitleToStreamFinder(tt, titleLabel) {
    state.imdb = tt;
    state.tmdb = null;
    state.mediaType = "movie";
    state.pendingTitle = titleLabel || state.pendingTitle;
    state.probeResults = {};
    state.playQueue = [];
    state.playIndex = -1;
    state.nowPlayingHref = null;
    try {
      closePlayer();
    } catch (_) {}
    syncIdInputs();
    syncTypeUi();
    applyChromeVisibility();
    showPanel();
    await enrichIds();
    renderLinks();
  }

  function bindTitleSelection() {
    let selectTimer = null;
    document.addEventListener("mouseup", () => {
      clearTimeout(selectTimer);
      selectTimer = setTimeout(() => {
        const sel = window.getSelection();
        const text = (sel && String(sel.toString() || "").trim()) || "";
        const panel = document.getElementById(PANEL_ID);
        if (panel && sel?.anchorNode && panel.contains(sel.anchorNode)) return; // ignore selects inside SF

        if (!isTitleLikeSelection(text)) {
          // Keep SF if we already have real ids; only clear pending title
          if (!state.imdb && !state.tmdb && state.pendingTitle) {
            state.pendingTitle = null;
            applyChromeVisibility();
          }
          return;
        }

        state.pendingTitle = text;
        const titleInput = panel?.querySelector(".isf-title-query");
        if (titleInput) titleInput.value = text;
        applyChromeVisibility();
        const edge = document.getElementById(EDGE_ID);
        if (edge) edge.hidden = false; // always show tab when user highlights a title
        setStatus(`Title selected: “${text.slice(0, 48)}” — open SF & Lookup`);
      }, 120);
    });
  }

  function isTitleLikeSelection(text) {
    if (!text || text.length < 2 || text.length > 120) return false;
    if (/^https?:\/\//i.test(text)) return false;
    if (/^tt\d{7,8}$/i.test(text)) return true; // pasted IMDb id
    if (/^\d{2,8}$/.test(text)) return false; // bare number — not a title
    if (!/[a-zA-Z\u00C0-\u024F]/.test(text)) return false; // need letters
    return true;
  }

  async function lookupTitle(rawTitle) {
    const title = String(rawTitle || state.pendingTitle || "").trim();
    if (!title) {
      setStatus("Highlight a movie/TV title, then tap Lookup");
      return;
    }
    state.pendingTitle = title;
    applyChromeVisibility();
    showPanel();
    setStatus(`Looking up “${title}”…`);

    // Direct IMDb id pasted as the “title”
    if (/^tt\d{7,8}$/i.test(title)) {
      state.imdb = title.toLowerCase();
      syncIdInputs();
      await enrichIds();
      renderLinks();
      setStatus(`Found ${state.imdb}`);
      return;
    }

    try {
      const hit = await searchTitleViaWikidata(title);
      if (!hit?.imdb) {
        setStatus(`No IMDb match for “${title}” — try right‑click → Search on IMDb`);
        return;
      }
      state.imdb = hit.imdb.toLowerCase();
      if (hit.tmdbTv) {
        state.tmdb = String(hit.tmdbTv);
        state.mediaType = "tv";
      } else if (hit.tmdbMovie) {
        state.tmdb = String(hit.tmdbMovie);
        state.mediaType = "movie";
      }
      if (hit.isTv) state.mediaType = "tv";
      syncIdInputs();
      syncTypeUi();
      renderLinks();
      setStatus(`Matched “${title}” → ${state.imdb}`);
    } catch (_) {
      setStatus(`Lookup failed — try right‑click → Search on IMDb`);
    }
  }

  async function searchTitleViaWikidata(title) {
    const safe = title.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const sparql = `
      SELECT ?imdb ?tmdbMovie ?tmdbTv ?isTv WHERE {
        ?item rdfs:label "${safe}"@en.
        ?item wdt:P345 ?imdb.
        OPTIONAL { ?item wdt:P4947 ?tmdbMovie. }
        OPTIONAL { ?item wdt:P4983 ?tmdbTv. }
        BIND(EXISTS { ?item wdt:P31/wdt:P279* wd:Q5398426 } AS ?isTv)
      } LIMIT 1`;
    const url =
      "https://query.wikidata.org/sparql?format=json&query=" + encodeURIComponent(sparql);
    const res = await fetch(url, { headers: { Accept: "application/sparql-results+json" } });
    if (!res.ok) throw new Error("wikidata");
    const data = await res.json();
    const row = data?.results?.bindings?.[0];
    if (!row?.imdb?.value) return null;
    return {
      imdb: row.imdb.value,
      tmdbMovie: row.tmdbMovie?.value,
      tmdbTv: row.tmdbTv?.value,
      isTv: row.isTv?.value === "true"
    };
  }

  function applyEdgeMode() {
    applyChromeVisibility();
  }

  function showPanel() {
    clearTimeout(hideTimer);
    const panel = document.getElementById(PANEL_ID);
    if (!panel || !hasMediaSignal()) return;
    panel.hidden = false;
    panel.classList.add("isf-open");
    panel.classList.remove("isf-hidden");
  }

  function hidePanelSoon(ms) {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      const panel = document.getElementById(PANEL_ID);
      if (!panel || !state.edgeAutoHide) return;
      // Keep open while player is testing
      if (!panel.querySelector(".isf-player-wrap")?.hidden) return;
      panel.classList.remove("isf-open");
      panel.classList.add("isf-hidden");
    }, ms);
  }

  function syncIdInputs() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;
    panel.querySelector(".isf-imdb").value = state.imdb || "";
    panel.querySelector(".isf-tmdb").value = state.tmdb || "";
  }

  function syncTypeUi() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;
    panel.querySelectorAll(".isf-type-btn").forEach((btn) => {
      btn.classList.toggle("isf-active", btn.dataset.type === state.mediaType);
    });
    panel.querySelector(".isf-tv-controls").hidden = state.mediaType !== "tv";
    const head = panel.querySelector(".isf-links-head");
    if (head) {
      head.textContent =
        state.mediaType === "tv"
          ? `Sources · S${state.season}E${state.episode}`
          : "Sources";
    }
  }

  function syncSeasonEpisodeInputs(seasonInput, episodeInput) {
    state.season = Math.max(1, Number(seasonInput.value) || 1);
    state.episode = Math.max(1, Number(episodeInput.value) || 1);
    seasonInput.value = state.season;
    episodeInput.value = state.episode;
    syncTypeUi();
    renderLinks(); // refresh source hrefs for the chosen S/E (play happens on the button)
  }

  async function playSelectedEpisode() {
    if (state.mediaType !== "tv") {
      state.mediaType = "tv";
      syncTypeUi();
    }
    const panel = document.getElementById(PANEL_ID);
    const seasonInput = panel?.querySelector(".isf-season");
    const episodeInput = panel?.querySelector(".isf-episode");
    if (seasonInput && episodeInput) syncSeasonEpisodeInputs(seasonInput, episodeInput);

    state.probeResults = {};
    renderLinks();
    setStatus(`Loading S${state.season}E${state.episode}…`);

    const candidates = getCandidateLinks();
    if (!candidates.length) {
      setStatus("No TV sources — need IMDb/TMDB id and TV mode");
      return;
    }

    // Probe + play best for this season/episode
    await testAllAndPlay();
    setStatus(`Playing S${state.season}E${state.episode}`);
  }

  function syncLockerUi() {
    const el = document.querySelector(`#${PANEL_ID} .isf-locker-toggle`);
    if (el) el.checked = state.lockerEnabled;
  }

  function setStatus(msg) {
    const el = document.querySelector(`#${PANEL_ID} .isf-status`);
    if (!el) return;
    el.hidden = !msg;
    el.textContent = msg || "";
  }

  function renderLinks() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;
    const list = panel.querySelector(".isf-links");
    const links = (state.mediaType === "tv" ? state.tvLinks : state.movieLinks).filter(
      (l) => l.enabled !== false
    );
    const v = vars();
    list.innerHTML = "";

    if (!links.length) {
      list.innerHTML = `<p class="isf-empty">No links yet — add some in the extension popup.</p>`;
      return;
    }

    for (const link of links) {
      const missing = linkNeedsMissingId(link.url, v);
      const href = buildStreamUrl(link.url, v);
      const row = document.createElement("div");
      const isPlaying = state.nowPlayingHref && state.nowPlayingHref === href;
      row.className =
        "isf-link-row" +
        (missing ? " isf-disabled" : "") +
        (isPlaying ? " isf-playing-row" : "");

      const a = document.createElement("a");
      a.className = "isf-link";
      a.href = missing ? "#" : href;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.textContent = (isPlaying ? "▶ " : "") + (link.name || "Open");
      if (missing) {
        a.title = "Needs IMDb or TMDB id";
        a.addEventListener("click", (e) => e.preventDefault());
      } else if (isPlaying) {
        a.title = "Currently playing";
      } else {
        a.title = href;
      }

      const probeBadge = document.createElement("span");
      probeBadge.className = "isf-badge";
      const cached = state.probeResults[href];
      const label = badgeLabel(cached);
      probeBadge.textContent = label;
      if (label === "OK") probeBadge.classList.add("isf-ok");
      else if (label === "FAIL") probeBadge.classList.add("isf-fail");
      else if (label === "?") probeBadge.classList.add("isf-maybe");

      const playBtn = document.createElement("button");
      playBtn.type = "button";
      playBtn.className = "isf-play";
      playBtn.textContent = "▶";
      playBtn.title = "Play this source in-app";
      playBtn.disabled = missing;
      playBtn.addEventListener("click", () => {
        state.playQueue = getCandidateLinks();
        state.playIndex = state.playQueue.findIndex((c) => c.href === href);
        loadQueueItem(Math.max(0, state.playIndex));
      });

      row.appendChild(a);
      row.appendChild(probeBadge);
      row.appendChild(playBtn);
      list.appendChild(row);
    }
  }

  function badgeLabel(cached) {
    if (!cached) return "—";
    if (cached.label === "ok" || cached.playable === true) return "OK";
    if (cached.label === "fail" || cached.playable === false) return "FAIL";
    return "?";
  }

  function getCandidateLinks() {
    const v = vars();
    return (state.mediaType === "tv" ? state.tvLinks : state.movieLinks)
      .filter((l) => l.enabled !== false)
      .map((link) => {
        const missing = linkNeedsMissingId(link.url, v);
        const href = buildStreamUrl(link.url, v);
        return { id: link.id, name: link.name, href, missing, urlTemplate: link.url };
      })
      .filter((c) => !c.missing && c.href);
  }

  function providerPriority(id) {
    // Prefer earlier entries in the user's saved list (catalog order)
    const idx = state.queue.findIndex((q) => q.id === id);
    return idx >= 0 ? Math.max(0, 100 - idx) : 10;
  }

  function rankScore(c) {
    const r = state.probeResults[c.href] || {};
    const label = r.label || (r.playable === true ? "ok" : r.playable === false ? "fail" : "maybe");
    const base = label === "ok" ? 1000 : label === "fail" ? -1000 : 100;
    return base + (r.score || 0) + providerPriority(c.id);
  }

  async function testAllAndPlay() {
    showPanel();
    const candidates = getCandidateLinks();
    if (!candidates.length) {
      setStatus("No providers ready — need IMDb/TMDB ids");
      return;
    }

    const btn = document.querySelector(`#${PANEL_ID} .isf-test-all`);
    if (btn) {
      btn.disabled = true;
      btn.textContent = `Scanning 0/${candidates.length}…`;
    }
    setStatus(`Scanning ${candidates.length} providers (OK / ? / FAIL)…`);

    try {
      if (!extAlive()) throw new Error("extension_reloaded");
      const batch = await chrome.runtime.sendMessage({
        type: "probeEmbedBatch",
        urls: candidates.map((c) => c.href)
      });
      const byUrl = new Map((batch || []).map((r) => [r.url, r]));

      let done = 0;
      for (const c of candidates) {
        state.probeResults[c.href] = byUrl.get(c.href) || {
          label: "maybe",
          playable: null,
          score: 1
        };
        done += 1;
        if (btn) btn.textContent = `Scanning ${done}/${candidates.length}…`;
      }
      renderLinks();

      const queue = candidates
        .filter((c) => badgeLabel(state.probeResults[c.href]) !== "FAIL")
        .sort((a, b) => rankScore(b) - rankScore(a));

      state.playQueue = queue.length
        ? queue
        : candidates.slice().sort((a, b) => rankScore(b) - rankScore(a));
      state.playIndex = 0;

      const okCount = candidates.filter((c) => badgeLabel(state.probeResults[c.href]) === "OK").length;
      const maybeCount = candidates.filter((c) => badgeLabel(state.probeResults[c.href]) === "?").length;
      const failCount = candidates.filter((c) => badgeLabel(state.probeResults[c.href]) === "FAIL").length;

      setStatus(`OK ${okCount} · ? ${maybeCount} · FAIL ${failCount} — use Next source if blank`);
      loadQueueItem(0);
    } catch (err) {
      setStatus("Scan failed: " + (err.message || err));
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = "Test all & play best";
      }
    }
  }

  function shiftSource(delta) {
    if (!state.playQueue.length) {
      state.playQueue = getCandidateLinks().sort((a, b) => rankScore(b) - rankScore(a));
      // start near currently playing if possible
      if (state.nowPlayingHref) {
        const idx = state.playQueue.findIndex((c) => c.href === state.nowPlayingHref);
        state.playIndex = idx >= 0 ? idx : 0;
      } else {
        state.playIndex = 0;
      }
    }
    if (!state.playQueue.length) return;
    const next = (state.playIndex + delta + state.playQueue.length) % state.playQueue.length;
    loadQueueItem(next, { animate: false }); // keep dock open; swap stream
  }

  function loadQueueItem(index, opts = {}) {
    if (!state.playQueue.length) return;
    state.playIndex = Math.max(0, Math.min(index, state.playQueue.length - 1));
    const item = state.playQueue[state.playIndex];
    openPlayer(item.name, item.href, opts);
    updateSourceNav();
  }

  function updateSourceNav() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;
    const pos = panel.querySelector(".isf-source-pos");
    if (!pos) return;
    if (!state.playQueue.length) {
      pos.textContent = "—";
      return;
    }
    const cur = state.playQueue[state.playIndex];
    const label = badgeLabel(state.probeResults[cur.href]);
    pos.textContent =
      state.mediaType === "tv"
        ? `${state.playIndex + 1}/${state.playQueue.length} · ${cur.name} · S${state.season}E${state.episode} (${label})`
        : `${state.playIndex + 1}/${state.playQueue.length} · ${cur.name} (${label})`;
  }

  function openPlayer(name, href, opts = {}) {
    const animate = opts.animate !== false;
    showPanel();
    const panel = document.getElementById(PANEL_ID);
    const wrap = panel.querySelector(".isf-player-wrap");
    const iframe = panel.querySelector(".isf-player");
    const line = panel.querySelector(".isf-probe-line");
    const title = panel.querySelector(".isf-player-title");
    const hit = panel.querySelector(".isf-expand-hit");
    const alreadyOpen = panel.classList.contains("isf-playing") && !wrap.hidden;

    wrap.hidden = false;
    panel.classList.add("isf-playing");
    state.nowPlayingHref = href;

    title.textContent =
      state.mediaType === "tv"
        ? `Playing · ${name || "Source"} · S${state.season}E${state.episode}`
        : `Playing · ${name || "Source"}`;
    if (hit) {
      hit.hidden = !!document.fullscreenElement;
      hit.textContent = "Click for fullscreen";
    }

    // Only spring-animate when the dock first appears
    if (animate && !alreadyOpen) {
      wrap.classList.remove("isf-player-pop");
      void wrap.offsetWidth;
      wrap.classList.add("isf-player-pop");
    }

    // Reload stream for Prev/Next without killing the dock
    iframe.src = "about:blank";
    requestAnimationFrame(() => {
      iframe.src = href;
    });

    const result = state.probeResults[href];
    const label = badgeLabel(result);
    if (label === "OK") {
      line.textContent = `Now playing ${name} — click player for fullscreen · Next/Prev to switch`;
      line.className = "isf-probe-line isf-ok";
    } else if (label === "FAIL") {
      line.textContent = `Now playing ${name} (marked FAIL) — try Next if it doesn’t play`;
      line.className = "isf-probe-line isf-fail";
    } else {
      line.textContent = `Now playing ${name} — click player for fullscreen · Next if blank`;
      line.className = "isf-probe-line isf-maybe";
    }
    setStatus(`Now playing: ${name}`);
    renderLinks();
  }

  function openCastTab() {
    const panel = document.getElementById(PANEL_ID);
    const iframe = panel?.querySelector(".isf-player");
    const src = iframe?.src || state.nowPlayingHref || "";
    if (!src || src === "about:blank") {
      setStatus("Play a source first, then tap Cast");
      return;
    }
    const title =
      panel.querySelector(".isf-player-title")?.textContent?.trim() || "Stream";
    // Open dedicated cast tab — Chromecast cannot hijack cross-origin embeds directly
    if (!extAlive()) {
      setStatus("Extension reloaded — refresh this page");
      return;
    }
    chrome.runtime.sendMessage({
      type: "openCastTab",
      src,
      title
    }).catch(() => {
      try {
        const url =
          chrome.runtime.getURL("cast/cast.html") +
          `?src=${encodeURIComponent(src)}&title=${encodeURIComponent(title)}`;
        window.open(url, "_blank", "noopener,noreferrer");
      } catch (_) {
        setStatus("Extension reloaded — refresh this page");
      }
    });
    setStatus("Cast tab opened — use Chrome Cast → Cast tab");
  }

  async function togglePlayerFullscreen(forceEnter = false) {
    const wrap = document.querySelector(`#${PANEL_ID} .isf-player-wrap`);
    if (!wrap || wrap.hidden) return;
    try {
      if (!document.fullscreenElement) {
        await wrap.requestFullscreen();
      } else if (!forceEnter) {
        await document.exitFullscreen();
      }
    } catch (err) {
      // Fallback: expand inside the panel if Fullscreen API is blocked
      wrap.classList.toggle("isf-fs-fallback", forceEnter || !wrap.classList.contains("isf-fs-fallback"));
      setStatus("Expanded player (fullscreen API blocked on this page)");
    }
  }

  function closePlayer() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;
    const wrap = panel.querySelector(".isf-player-wrap");
    const iframe = panel.querySelector(".isf-player");
    if (document.fullscreenElement === wrap) {
      document.exitFullscreen().catch(() => {});
    }
    iframe.src = "about:blank";
    wrap.hidden = true;
    wrap.classList.remove("isf-player-pop", "isf-fs", "isf-fs-fallback");
    panel.classList.remove("isf-playing");
    state.nowPlayingHref = null;
    setStatus("");
    renderLinks();
    if (state.edgeAutoHide) hidePanelSoon(400);
  }
})();
