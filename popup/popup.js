(() => {
  let movieLinks = [];
  let tvLinks = [];

  const movieList = document.getElementById("movie-list");
  const tvList = document.getElementById("tv-list");
  const status = document.getElementById("status");
  const catalogUrlInput = document.getElementById("catalog-url");
  const catalogMeta = document.getElementById("catalog-meta");
  const lockerEnabled = document.getElementById("locker-enabled");
  const edgeAutohide = document.getElementById("edge-autohide");
  const autoUpdate = document.getElementById("auto-update");

  lockerEnabled.addEventListener("change", async () => {
    await chrome.storage.local.set({ lockerEnabled: lockerEnabled.checked });
    flash(lockerEnabled.checked ? "Popup + ad locker ON" : "Locker OFF");
  });
  edgeAutohide.addEventListener("change", async () => {
    await chrome.storage.local.set({ edgeAutoHide: edgeAutohide.checked });
    flash(edgeAutohide.checked ? "Edge auto-hide ON" : "Panel stays open");
  });
  autoUpdate.addEventListener("change", async () => {
    await chrome.storage.local.set({ autoUpdateProviders: autoUpdate.checked });
    flash(autoUpdate.checked ? "Auto-update ON (every 12h)" : "Auto-update OFF");
    if (autoUpdate.checked) {
      chrome.runtime.sendMessage({ type: "refreshCatalogNow" }).catch(() => {});
    }
  });

  document.getElementById("add-movie").addEventListener("click", () => {
    movieLinks.push({
      id: "custom-movie-" + Date.now(), // unique key for this custom template
      name: "New movie link",
      url: "https://example.com/movie/{imdb}",
      enabled: true
    });
    render();
  });

  document.getElementById("add-tv").addEventListener("click", () => {
    tvLinks.push({
      id: "custom-tv-" + Date.now(),
      name: "New TV link",
      url: "https://example.com/tv/{tmdb}/{season}/{episode}",
      enabled: true
    });
    render();
  });

  document.getElementById("reset").addEventListener("click", async () => {
    const built = getDefaultLinkLists(); // restore from bundled catalog
    movieLinks = built.movieLinks;
    tvLinks = built.tvLinks;
    render();
    await save(false);
    flash("Defaults restored from catalog " + (STREAM_PROVIDER_CATALOG?.version || ""));
    showCatalogMeta(STREAM_PROVIDER_CATALOG);
  });

  document.getElementById("sync-bundled").addEventListener("click", async () => {
    syncFromDom();
    if (!catalogHasProviders(STREAM_PROVIDER_CATALOG)) {
      try {
        await chrome.runtime.sendMessage({ type: "refreshCatalogNow" });
      } catch (_) {}
      const stored = await chrome.storage.local.get(["movieLinks", "tvLinks", "catalogVersion"]);
      movieLinks = stored.movieLinks || [];
      tvLinks = stored.tvLinks || [];
      render();
      flash(movieLinks.length ? `Loaded ${movieLinks.length} movie / ${tvLinks.length} TV` : "No local sources found");
      return;
    }
    const merged = mergeCatalogIntoLists(STREAM_PROVIDER_CATALOG, movieLinks, tvLinks);
    movieLinks = merged.movieLinks;
    tvLinks = merged.tvLinks;
    render();
    await save(false);
    await chrome.storage.local.set({
      catalogVersion: merged.version,
      catalogUpdated: merged.updated,
      catalogUrl: "" // clear dead localhost Atlas URL if any
    });
    flash(`Reloaded local sources (${merged.movieLinks.length} movie / ${merged.tvLinks.length} TV)`);
    showCatalogMeta(STREAM_PROVIDER_CATALOG);
  });

  document.getElementById("sync-remote").addEventListener("click", async () => {
    const url = catalogUrlInput.value.trim();
    if (!url) {
      flash("Paste a catalog JSON URL first");
      return;
    }
    try {
      syncFromDom();
      const catalog = await fetchRemoteCatalog(url);
      const merged = mergeCatalogIntoLists(catalog, movieLinks, tvLinks);
      movieLinks = merged.movieLinks;
      tvLinks = merged.tvLinks;
      render();
      await chrome.storage.local.set({
        catalogUrl: url,
        catalogVersion: merged.version,
        catalogUpdated: merged.updated,
        movieLinks,
        tvLinks
      });
      flash("Synced remote catalog v" + (merged.version || "?"));
      showCatalogMeta(catalog);
    } catch (err) {
      flash("Remote sync failed: " + (err.message || err));
    }
  });

  document.getElementById("save").addEventListener("click", async () => {
    await save(true);
  });

  init();

  async function init() {
    const stored = await chrome.storage.local.get([
      "movieLinks",
      "tvLinks",
      "catalogUrl",
      "catalogVersion",
      "catalogUpdated",
      "lockerEnabled",
      "edgeAutoHide",
      "autoUpdateProviders",
      "lastCatalogRefresh"
    ]);
    const defaults = getDefaultLinkLists();
    movieLinks = mergeLinkLists(stored.movieLinks, defaults.movieLinks);
    tvLinks = mergeLinkLists(stored.tvLinks, defaults.tvLinks);
    catalogUrlInput.value = stored.catalogUrl || "";
    lockerEnabled.checked = stored.lockerEnabled !== false;
    edgeAutohide.checked = stored.edgeAutoHide !== false;
    autoUpdate.checked = stored.autoUpdateProviders !== false;
    const last =
      stored.lastCatalogRefresh != null
        ? new Date(stored.lastCatalogRefresh).toLocaleString()
        : "not yet";
    catalogMeta.textContent = stored.catalogVersion
      ? `Catalog v${stored.catalogVersion}` +
        (stored.catalogUpdated ? ` (${stored.catalogUpdated})` : "") +
        ` · auto-refresh: ${last}`
      : `Bundled catalog: v${STREAM_PROVIDER_CATALOG.version} · auto-refresh: ${last}`;
    render();
  }

  async function fetchRemoteCatalog(url) {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    if (!data || !Array.isArray(data.providers)) {
      throw new Error("JSON must include a providers[] array");
    }
    return data;
  }

  async function save(showFlash) {
    syncFromDom();
    await chrome.storage.local.set({
      movieLinks,
      tvLinks,
      catalogUrl: catalogUrlInput.value.trim()
    });
    if (showFlash) flash("Saved — refresh pages to pick up changes");
  }

  function showCatalogMeta(catalog) {
    catalogMeta.textContent =
      `Catalog v${catalog.version || "?"} · ${catalog.providers?.length || 0} providers` +
      (catalog.updated ? ` · ${catalog.updated}` : "");
  }

  function flash(msg) {
    status.hidden = false;
    status.textContent = msg;
    setTimeout(() => {
      status.hidden = true;
    }, 2800);
  }

  function syncFromDom() {
    movieLinks = readGroup(movieList);
    tvLinks = readGroup(tvList);
  }

  function readGroup(container) {
    return [...container.querySelectorAll(".card")].map((card) => ({
      id: card.dataset.id,
      enabled: card.querySelector(".enabled").checked,
      name: card.querySelector(".name").value.trim() || "Untitled",
      url: card.querySelector(".url").value.trim()
    }));
  }

  function render() {
    movieList.innerHTML = "";
    tvList.innerHTML = "";
    movieLinks.forEach((link, i) => movieList.appendChild(cardEl(link, "movie", i)));
    tvLinks.forEach((link, i) => tvList.appendChild(cardEl(link, "tv", i)));
  }

  function cardEl(link, kind, index) {
    const el = document.createElement("div");
    el.className = "card";
    el.dataset.id = link.id;
    el.innerHTML = `
      <div class="row">
        <input class="enabled" type="checkbox" title="Enabled" ${link.enabled !== false ? "checked" : ""} />
        <input class="name" type="text" value="${escapeAttr(link.name)}" placeholder="Name" />
        <button type="button" class="danger remove">Remove</button>
      </div>
      <input class="url" type="text" value="${escapeAttr(link.url)}" placeholder="https://…/{tmdb}" />
    `;
    el.querySelector(".remove").addEventListener("click", () => {
      if (kind === "movie") movieLinks.splice(index, 1);
      else tvLinks.splice(index, 1);
      render();
    });
    return el;
  }

  function escapeAttr(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll('"', "&quot;")
      .replaceAll("<", "&lt;");
  }
})();
