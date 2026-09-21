// Runs on the releases feed page after Cloudflare — scrapes titles into chrome.storage
(() => {
  const MAX = 40;

  function isChallengePage() {
    const t = (document.title || "") + " " + (document.body?.innerText || "").slice(0, 500);
    return /verifying access|security verification|cf-turnstile|just a moment/i.test(t);
  }

  function scrape() {
    if (isChallengePage()) return null;

    const seen = new Set();
    const items = [];

    const push = (title, href, year) => {
      const clean = String(title || "")
        .replace(/\s+/g, " ")
        .replace(/\(\d{4}\)\s*$/, (m) => m) // keep year if already in title
        .trim();
      if (clean.length < 2 || clean.length > 160) return;
      if (/^(home|updates?|movies?|tv|login|register|more)$/i.test(clean)) return;
      const key = clean.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      items.push({
        title: clean,
        href: href || location.href,
        year: year || null,
        imdb: (href && (href.match(/\b(tt\d{7,8})\b/i) || [])[1]) || null
      });
    };

    // Prefer structured cards / list links
    const candidates = document.querySelectorAll(
      "a[href*='/movie'], a[href*='/watch'], a[href*='/film'], a[href*='/tv'], article a, .card a, .update a, .post a, h2 a, h3 a, li a"
    );
    for (const a of candidates) {
      if (items.length >= MAX) break;
      const href = a.href || "";
      if (!href || href === location.href) continue;
      if (/\/updates\/?$/i.test(href)) continue;
      const text = (a.getAttribute("title") || a.textContent || "").trim();
      const yearM = text.match(/\((\d{4})\)/);
      push(text, href, yearM ? yearM[1] : null);
    }

    // Fallback: headings that look like "Title (2024)"
    if (items.length < 5) {
      for (const h of document.querySelectorAll("h1, h2, h3, h4, .title, .entry-title")) {
        if (items.length >= MAX) break;
        const text = (h.textContent || "").trim();
        if (!/\(\d{4}\)/.test(text) && text.split(" ").length < 2) continue;
        const yearM = text.match(/\((\d{4})\)/);
        const link = h.closest("a") || h.querySelector("a");
        push(text, link?.href || location.href, yearM ? yearM[1] : null);
      }
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
    if (tries < 40) setTimeout(tick, 1500); // wait for CF / lazy content
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => setTimeout(tick, 800));
  } else {
    setTimeout(tick, 800);
  }

  // SPA / late paint
  const mo = new MutationObserver(() => {
    const items = scrape();
    if (items) {
      publish(items);
      mo.disconnect();
    }
  });
  mo.observe(document.documentElement, { childList: true, subtree: true });
  setTimeout(() => mo.disconnect(), 90000);
})();
