(() => {
  const PANEL_ID = "imdb-stream-finder-panel"; // unique root id so we never inject twice
  const EDGE_ID = "imdb-stream-finder-edge"; // thin right-edge hover strip
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
    nowPlayingHref: null
  };

  let hideTimer = null;

  init();

  async function init() {
    const stored = await chrome.storage.local.get([
      "movieLinks",
      "tvLinks",
      "lockerEnabled",
      "edgeAutoHide"
    ]);
    state.movieLinks = mergeLinkLists(stored.movieLinks, STREAM_FINDER_DEFAULTS.movieLinks);
    state.tvLinks = mergeLinkLists(stored.tvLinks, STREAM_FINDER_DEFAULTS.tvLinks);
    // Persist refreshed catalog URLs (e.g. official 2Embed IMDb) so popup stays in sync
    await chrome.storage.local.set({
      movieLinks: state.movieLinks,
      tvLinks: state.tvLinks
    });
    state.lockerEnabled = stored.lockerEnabled !== false;
    state.edgeAutoHide = stored.edgeAutoHide !== false;
    syncLockerMain(state.lockerEnabled);

    scanPage();
    injectChrome();
    if (!state.imdb && !state.tmdb) hidePanelSoon(0);

    await enrichIds();
    renderLinks();

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      if (changes.movieLinks) state.movieLinks = changes.movieLinks.newValue;
      if (changes.tvLinks) state.tvLinks = changes.tvLinks.newValue;
      if (changes.lockerEnabled) {
        state.lockerEnabled = changes.lockerEnabled.newValue !== false;
        syncLockerMain(state.lockerEnabled);
        syncLockerUi();
      }
      if (changes.edgeAutoHide) {
        state.edgeAutoHide = changes.edgeAutoHide.newValue !== false;
        applyEdgeMode();
      }
      renderLinks();
    });
  }

  function syncLockerMain(on) {
    window.postMessage({ source: "isf-locker", enabled: on }, "*");
  }

  function scanPage() {
    const seriesImdb = findSeriesImdbOnPage();
    const pageImdb =
      findFirstImdb(location.href) ||
      findFirstImdb(document.documentElement.innerHTML.slice(0, 400000));
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
    const html = document.documentElement.innerHTML.slice(0, 400000);
    const path = html.match(TMDB_PATH_RE) || location.href.match(TMDB_PATH_RE);
    if (path) return { kind: path[1].toLowerCase(), id: path[2] };
    const q = (location.href + "\n" + html).match(TMDB_QUERY_RE);
    if (q) return { kind: null, id: q[1] };
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
    edge.title = "Stream Finder — hover to open";
    document.documentElement.appendChild(edge);

    const panel = document.createElement("aside");
    panel.id = PANEL_ID;
    panel.innerHTML = `
      <header class="isf-header">
        <div class="isf-title">Stream Finder</div>
        <div class="isf-header-actions">
          <button type="button" class="isf-pin" title="Keep open / auto-hide">📌</button>
          <button type="button" class="isf-minimize" title="Hide" aria-label="Hide">×</button>
        </div>
      </header>
      <div class="isf-player-wrap" hidden>
        <div class="isf-player-bar">
          <div class="isf-now-playing">
            <span class="isf-live-dot" aria-hidden="true"></span>
            <span class="isf-player-title">Nothing playing</span>
          </div>
          <div class="isf-player-bar-actions">
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
      <div class="isf-scroll">
        <p class="isf-status" hidden></p>
        <div class="isf-ids">
          <label>IMDb <input type="text" class="isf-imdb" placeholder="tt0000000" spellcheck="false" /></label>
          <label>TMDB <input type="text" class="isf-tmdb" placeholder="12345" spellcheck="false" /></label>
        </div>
        <div class="isf-type">
          <button type="button" data-type="movie" class="isf-type-btn">Movie</button>
          <button type="button" data-type="tv" class="isf-type-btn">TV</button>
        </div>
        <div class="isf-tv-controls" hidden>
          <label>Season <input type="number" class="isf-season" min="1" value="1" /></label>
          <label>Episode <input type="number" class="isf-episode" min="1" value="1" /></label>
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
    `;
    document.documentElement.appendChild(panel);

    const imdbInput = panel.querySelector(".isf-imdb");
    const tmdbInput = panel.querySelector(".isf-tmdb");
    const seasonInput = panel.querySelector(".isf-season");
    const episodeInput = panel.querySelector(".isf-episode");
    const lockerToggle = panel.querySelector(".isf-locker-toggle");

    imdbInput.value = state.imdb || "";
    tmdbInput.value = state.tmdb || "";
    seasonInput.value = state.season;
    episodeInput.value = state.episode;
    lockerToggle.checked = state.lockerEnabled;

    panel.querySelector(".isf-minimize").addEventListener("click", () => hidePanelSoon(0));
    panel.querySelector(".isf-pin").addEventListener("click", async () => {
      state.edgeAutoHide = !state.edgeAutoHide;
      await chrome.storage.local.set({ edgeAutoHide: state.edgeAutoHide });
      applyEdgeMode();
      setStatus(state.edgeAutoHide ? "Auto-hide on (hover right edge)" : "Pinned open");
    });
    panel.querySelector(".isf-player-close").addEventListener("click", () => closePlayer());
    panel.querySelector(".isf-fs-btn").addEventListener("click", () => togglePlayerFullscreen());
    panel.querySelector(".isf-expand-hit").addEventListener("click", () => {
      togglePlayerFullscreen(true); // enter fullscreen from click-on-player
    });
    panel.querySelector(".isf-test-all").addEventListener("click", () => testAllAndPlay());
    panel.querySelector(".isf-next-src").addEventListener("click", () => shiftSource(1));
    panel.querySelector(".isf-prev-src").addEventListener("click", () => shiftSource(-1));

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
      await chrome.storage.local.set({ lockerEnabled: state.lockerEnabled });
      syncLockerMain(state.lockerEnabled);
      setStatus(state.lockerEnabled ? "Locker ON" : "Locker OFF");
    });

    imdbInput.addEventListener("input", async () => {
      const v = imdbInput.value.trim();
      state.imdb = /^tt\d{7,8}$/i.test(v) ? v.toLowerCase() : v || null;
      renderLinks();
      if (state.imdb) await enrichIds();
    });
    tmdbInput.addEventListener("input", () => {
      const v = tmdbInput.value.trim();
      state.tmdb = /^\d+$/.test(v) ? v : v || null;
      renderLinks();
    });
    seasonInput.addEventListener("input", () => {
      state.season = Math.max(1, Number(seasonInput.value) || 1);
      renderLinks();
    });
    episodeInput.addEventListener("input", () => {
      state.episode = Math.max(1, Number(episodeInput.value) || 1);
      renderLinks();
    });

    panel.querySelectorAll(".isf-type-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.mediaType = btn.dataset.type;
        syncTypeUi();
        renderLinks();
      });
    });

    // Right-edge hover opens; leave hides (unless pinned)
    edge.addEventListener("mouseenter", () => showPanel());
    panel.addEventListener("mouseenter", () => {
      clearTimeout(hideTimer);
    });
    panel.addEventListener("mouseleave", () => {
      if (state.edgeAutoHide) hidePanelSoon(450);
    });

    // Keep wheel/trackpad scroll inside the panel — never scroll the host page
    panel.addEventListener(
      "wheel",
      (e) => {
        e.stopPropagation(); // don't bubble wheel to the page
        const scrollEl = panel.querySelector(".isf-scroll"); // only the sources area scrolls
        if (!scrollEl) {
          e.preventDefault(); // no scroll target → eat the event
          return;
        }
        const { scrollTop, scrollHeight, clientHeight } = scrollEl;
        const maxScroll = Math.max(0, scrollHeight - clientHeight);
        const next = Math.min(maxScroll, Math.max(0, scrollTop + e.deltaY)); // clamp to list bounds
        scrollEl.scrollTop = next; // move sources list ourselves
        e.preventDefault(); // block page scroll even at top/bottom of the list
      },
      { passive: false } // allow preventDefault on wheel
    );

    applyEdgeMode();
    syncTypeUi();
    syncLockerUi();
    renderLinks();
  }

  function applyEdgeMode() {
    const panel = document.getElementById(PANEL_ID);
    const edge = document.getElementById(EDGE_ID);
    if (!panel || !edge) return;
    panel.classList.toggle("isf-pinned", !state.edgeAutoHide);
    edge.hidden = !state.edgeAutoHide;
    if (!state.edgeAutoHide) showPanel();
    else hidePanelSoon(0);
  }

  function showPanel() {
    clearTimeout(hideTimer);
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;
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

  function providerPriority(id, href, index) {
    // Prefer earlier catalog order (from Atlas), not hardcoded site names
    return Math.max(0, 80 - (Number(index) || 0));
  }

  function rankScore(c, index) {
    const r = state.probeResults[c.href] || {};
    const label = r.label || (r.playable === true ? "ok" : r.playable === false ? "fail" : "maybe");
    const base = label === "ok" ? 1000 : label === "fail" ? -1000 : 100;
    return base + (r.score || 0) + providerPriority(c.id, c.href, index);
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
        .sort(
          (a, b) =>
            rankScore(b, candidates.indexOf(b)) - rankScore(a, candidates.indexOf(a))
        );

      state.playQueue = queue.length
        ? queue
        : candidates
            .slice()
            .sort(
              (a, b) =>
                rankScore(b, candidates.indexOf(b)) - rankScore(a, candidates.indexOf(a))
            );
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
      state.playQueue = getCandidateLinks().sort(
        (a, b) => rankScore(b, 0) - rankScore(a, 0)
      );
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
    pos.textContent = `${state.playIndex + 1}/${state.playQueue.length} · ${cur.name} (${label})`;
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

    title.textContent = `Playing · ${name || "Source"}`;
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
