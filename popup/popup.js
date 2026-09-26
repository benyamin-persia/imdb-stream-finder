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

  document.getElementById("update-dismiss").addEventListener("click", async () => {
    await chrome.runtime.sendMessage({ type: "dismissUpdate" }).catch(() => {});
    document.getElementById("update-banner").hidden = true;
    flash("Update reminder dismissed");
  });

  document.getElementById("update-open-repo").addEventListener("click", async () => {
    const stored = await chrome.storage.local.get(["updateRepo"]);
    const url = stored.updateRepo || "https://github.com/benyamin-persia/imdb-stream-finder";
    chrome.tabs.create({ url });
  });

  document.getElementById("refresh-releases").addEventListener("click", async () => {
    flash("Fetching now-playing list…");
    try {
      const res = await chrome.runtime.sendMessage({ type: "refreshReleasesFeed" });
      if (res?.ok) {
        const stored = await chrome.storage.local.get(["latestReleases", "latestReleasesAt"]);
        renderReleases(stored.latestReleases || [], stored.latestReleasesAt);
        flash(
          `Loaded ${res.count} movies` +
            (res.linked != null ? ` · ${res.linked} IMDb links` : "")
        );
      } else {
        flash("Fetch failed — opening Fandango so you can retry");
        await chrome.runtime.sendMessage({ type: "openReleasesFeed" }).catch(() => {});
      }
    } catch (_) {
      flash("Could not refresh releases");
    }
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
      "lastCatalogRefresh",
      "updateAvailable",
      "updateRemoteVersion",
      "updateNotes",
      "latestReleases",
      "latestReleasesAt"
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

    renderUpdateBanner(stored);
    renderReleases(stored.latestReleases || [], stored.latestReleasesAt);
    render();

    // Re-check GitHub version when popup opens
    chrome.runtime.sendMessage({ type: "checkExtensionUpdate" }).then((res) => {
      if (res?.ok) renderUpdateBanner(res);
    }).catch(() => {});
  }

  function renderUpdateBanner(stored) {
    const banner = document.getElementById("update-banner");
    const text = document.getElementById("update-banner-text");
    const local = chrome.runtime.getManifest().version;
    if (stored.updateAvailable && stored.updateRemoteVersion) {
      banner.hidden = false;
      text.textContent =
        `v${local} → v${stored.updateRemoteVersion}` +
        (stored.updateNotes ? ` — ${stored.updateNotes}` : "") +
        ". Pull latest from GitHub, then Reload unpacked.";
    } else {
      banner.hidden = true;
    }
  }

  function normalizePosterUrl(url) {
    if (!url) return null;
    let u = String(url).trim();
    // Fandango uses ImageRenderer/200/0/ — force a real 300x450 poster crop
    u = u.replace(/\/ImageRenderer\/\d+\/\d+\//i, "/ImageRenderer/300/450/");
    return u;
  }

  function renderReleases(items, at) {
    const list = document.getElementById("releases-list");
    const meta = document.getElementById("releases-meta");
    list.innerHTML = "";
    if (!items.length) {
      meta.textContent = "No list yet — click Refresh list to load Fandango now-playing.";
      return;
    }
    meta.textContent =
      `${items.length} now playing` +
      (at ? ` · ${new Date(at).toLocaleString()}` : "") +
      " · click a poster → its IMDb page";

    for (const item of items.slice(0, 48)) {
      const card = document.createElement("a"); // real link card — never <button> (UA squashes imgs)
      card.className = "release-card";
      card.href = "#";
      card.title = item.title;
      // Inline lock: even if CSS cache is stale, cards stay tall posters not strips
      card.style.cssText =
        "display:flex;flex-direction:column;margin:0;padding:0;min-height:220px;" +
        "border:1px solid #2c3448;border-radius:8px;background:#12161f;overflow:hidden;" +
        "text-decoration:none;color:#eef1f7;cursor:pointer;box-sizing:border-box;";

      const wrap = document.createElement("div"); // 2:3 frame via padding-top (width-based, can't collapse)
      wrap.className = "release-poster-wrap";
      wrap.style.cssText =
        "position:relative;display:block;width:100%;height:0;padding-top:150%;" +
        "background:#1a2030;overflow:hidden;flex-shrink:0;";

      const posterUrl = normalizePosterUrl(item.poster);
      if (posterUrl) {
        const img = document.createElement("img");
        img.className = "release-poster";
        img.src = posterUrl;
        img.alt = item.title;
        img.loading = "lazy";
        img.decoding = "async";
        img.style.cssText =
          "position:absolute;inset:0;width:100%;height:100%;object-fit:cover;object-position:center top;border:0;";
        wrap.appendChild(img);
      } else {
        const ph = document.createElement("div");
        ph.className = "release-poster release-poster--empty";
        ph.style.cssText = "position:absolute;inset:0;background:linear-gradient(160deg,#1a2030,#0c0e14);";
        wrap.appendChild(ph);
      }
      card.appendChild(wrap);

      const metaInfo = document.createElement("div");
      metaInfo.className = "release-meta";
      metaInfo.style.cssText = "display:grid;gap:2px;padding:6px 7px 8px;min-width:0;";

      const title = document.createElement("span");
      title.className = "release-title";
      title.textContent = item.title;
      metaInfo.appendChild(title);

      if (item.certified) {
        const badge = document.createElement("span");
        badge.className = "release-certified";
        badge.textContent = item.certified;
        metaInfo.appendChild(badge);
      } else if (item.released) {
        const rel = document.createElement("span");
        rel.className = "release-date";
        rel.textContent = item.released;
        metaInfo.appendChild(rel);
      }

      card.appendChild(metaInfo);

      if (item.imdb && /^tt\d{7,8}$/i.test(item.imdb)) {
        card.href = `https://www.imdb.com/title/${item.imdb}/`; // direct title page when already resolved
      }

      const openImdb = async (e) => {
        e.preventDefault();
        let id = item.imdb && /^tt\d{7,8}$/i.test(item.imdb) ? item.imdb.toLowerCase() : null;
        if (!id) {
          // Resolve this poster’s IMDb id (never dump the user on a search page)
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
          flash("Could not find IMDb page for this title");
          return;
        }
        item.imdb = id; // keep for next click in this popup session
        chrome.tabs.create({ url: `https://www.imdb.com/title/${id}/` });
      };
      card.addEventListener("click", openImdb);
      list.appendChild(card);
    }
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
