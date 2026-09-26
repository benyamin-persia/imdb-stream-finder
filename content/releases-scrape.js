// Fandango "Movies in Theaters" — scrape poster cards into chrome.storage
(() => {
  const MAX = 60;

  function posterFromEl(a) {
    const posterEl = a.querySelector(".grid-item-poster");
    if (!posterEl) return null;
    const lazy = posterEl.getAttribute("data-fd-lazy-image");
    let url = lazy || null;
    if (!url) {
      const bg = posterEl.style?.backgroundImage || "";
      const m = bg.match(/url\(["']?([^"')]+)["']?\)/i);
      url = m ? m[1] : null;
    }
    if (!url) return null;
    return url.replace(/\/ImageRenderer\/\d+\/\d+\//i, "/ImageRenderer/300/450/");
  }

  function scrape() {
    const seen = new Set();
    const items = [];
    for (const a of document.querySelectorAll("a.grid-item-link")) {
      if (items.length >= MAX) break;
      const titleEl = a.querySelector(".grid-item-title");
      const title = (titleEl?.textContent || "").trim();
      const href = a.href || "";
      if (!title || title.length < 2) continue;
      const key = title.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const yearM = title.match(/\((\d{4})\)/);
      const certEl = a.querySelector(".grid-item-certified");
      const certified = certEl
        ? certEl.textContent.replace(/\s+/g, " ").trim()
        : null;
      const sr = (a.querySelector(".sr-only")?.textContent || "").trim();
      const releasedM = sr.match(/Released\s+(.+)$/i);
      items.push({
        title,
        href,
        poster: posterFromEl(a),
        certified: certified || null,
        released: releasedM ? releasedM[1].trim() : null,
        year: yearM ? yearM[1] : null,
        imdb: null
      });
    }
    return items.length ? items : null;
  }

  async function publish(items) {
    await chrome.storage.local.set({
      latestReleases: items,
      latestReleasesAt: Date.now(),
      latestReleasesSource: location.href
    });
    chrome.runtime.sendMessage({ type: "releasesScraped", count: items.length }).catch(() => {});
  }

  let tries = 0;
  const tick = () => {
    tries += 1;
    const items = scrape();
    if (items) {
      publish(items);
      return;
    }
    if (tries < 20) setTimeout(tick, 1000);
  };

  setTimeout(tick, 500);
  const mo = new MutationObserver(() => {
    const items = scrape();
    if (items) {
      publish(items);
      mo.disconnect();
    }
  });
  mo.observe(document.documentElement, { childList: true, subtree: true });
  setTimeout(() => mo.disconnect(), 45000);
})();
