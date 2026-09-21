// Fandango "Movies in Theaters" — scrape titles into chrome.storage when the page is open
(() => {
  const MAX = 60;

  function scrape() {
    const seen = new Set();
    const items = [];
    for (const a of document.querySelectorAll("a.grid-item-link")) {
      if (items.length >= MAX) break;
      const titleEl = a.querySelector(".grid-item-title");
      const title = (titleEl?.textContent || a.querySelector(".sr-only")?.textContent || "").trim();
      const href = a.href || "";
      if (!title || title.length < 2) continue;
      const key = title.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const yearM = title.match(/\((\d{4})\)/);
      items.push({
        title,
        href,
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
