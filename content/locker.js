// Isolated-world locker companion — runs in ALL frames; syncs MAIN world + blocks blank popouts
(() => {
  const PANEL_ID = "imdb-stream-finder-panel";
  let enabled = true;

  const META_ALLOW =
    /(^|\.)(imdb\.com|themoviedb\.org|wikipedia\.org|youtube\.com|youtu\.be)$/i; // identity / docs sites only

  let catalogAllow = null; // hosts built from synced movie/tv link templates in storage

  function rebuildAllowFromLinks(movieLinks, tvLinks) {
    const hosts = new Set();
    for (const list of [movieLinks || [], tvLinks || []]) {
      for (const link of list) {
        try {
          const u = new URL(String(link.url || "").replace(/\{[^}]+\}/g, "x")); // fill placeholders for parse
          if (u.hostname) hosts.add(u.hostname.toLowerCase());
        } catch (_) {}
      }
    }
    const escaped = [...hosts].map((h) => h.replace(/\./g, "\\."));
    catalogAllow = escaped.length
      ? new RegExp(`^(?:${escaped.join("|")})$`, "i")
      : null;
  }

  function hostAllowed(host) {
    if (!host) return false;
    if (META_ALLOW.test(host)) return true;
    if (catalogAllow && catalogAllow.test(host)) return true;
    // also allow subdomains of catalog hosts
    if (catalogAllow) {
      const parts = host.split(".");
      for (let i = 1; i < parts.length - 1; i++) {
        const parent = parts.slice(i).join(".");
        if (catalogAllow.test(parent)) return true;
      }
    }
    return false;
  }

  function publish() {
    try {
      window.postMessage({ source: "isf-locker", enabled }, "*");
      // Reach same-origin children when possible
      for (let i = 0; i < window.frames.length; i++) {
        try {
          window.frames[i].postMessage({ source: "isf-locker", enabled }, "*");
        } catch (_) {}
      }
    } catch (_) {}
  }

  chrome.storage.local.get(["lockerEnabled", "movieLinks", "tvLinks"], (stored) => {
    enabled = stored.lockerEnabled !== false;
    rebuildAllowFromLinks(stored.movieLinks, stored.tvLinks);
    publish();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.lockerEnabled) {
      enabled = changes.lockerEnabled.newValue !== false;
      publish();
    }
    if (changes.movieLinks || changes.tvLinks) {
      chrome.storage.local.get(["movieLinks", "tvLinks"], (stored) => {
        rebuildAllowFromLinks(stored.movieLinks, stored.tvLinks);
      });
    }
  });

  // Keep MAIN locker informed (SPA / late iframes)
  setInterval(publish, 2000);

  document.addEventListener(
    "click",
    (e) => {
      if (!enabled) return;
      if (e.target?.closest?.(`#${PANEL_ID}`)) return;

      const a = e.target?.closest?.("a");
      if (!a) {
        // Buttons that only open popups
        const btn = e.target?.closest?.("[onclick],[data-href]");
        if (btn && /window\.open|popup/i.test(btn.getAttribute("onclick") || "")) {
          e.preventDefault();
          e.stopPropagation();
        }
        return;
      }

      const href = a.getAttribute("href") || "";
      const target = (a.getAttribute("target") || "").toLowerCase();

      if (!href || href === "#" || /^javascript:/i.test(href) || /^data:/i.test(href)) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }

      let host = "";
      try {
        host = new URL(href, location.href).hostname;
      } catch (_) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }

      const isPopupIntent =
        target === "_blank" ||
        target === "_new" ||
        /\b(popup|popunder|sponsor|offer)\b/i.test(a.className || "") ||
        /\b(popup|popunder|sponsor|offer)\b/i.test(a.id || "");

      if (!isPopupIntent) return;

      // Inside embed iframes: block almost all blank opens
      const inFrame = window.top !== window;
      if (inFrame && !hostAllowed(host)) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }

      // Top page: block known ad hosts on blank clicks
      if (
        /(^|\.)(doubleclick|googlesyndication|popads|popcash|exoclick|exosrv|juicyads|propeller|adsterra|hilltopads|clickadu|trafficstars|stripchat|chaturbate|livejasmin|onclick|adspyglass|tsyndicate)\./i.test(
          host
        )
      ) {
        e.preventDefault();
        e.stopPropagation();
      }
    },
    true
  );

  // Soft-remove obvious ad iframes in this frame
  const killAdIframes = () => {
    if (!enabled) return;
    document.querySelectorAll("iframe").forEach((frame) => {
      const src = frame.getAttribute("src") || frame.src || "";
      if (
        /(popads|popcash|exoclick|juicyads|propeller|adsterra|hilltopads|clickadu|doubleclick|googlesyndication|stripchat|chaturbate|livejasmin|adservice|pagead2)/i.test(
          src
        )
      ) {
        frame.remove();
      }
    });
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", killAdIframes, { once: true });
  } else {
    killAdIframes();
  }
  setInterval(killAdIframes, 2500);

  // Isolated world open trap (defense in depth; MAIN world is primary)
  try {
    const nativeOpen = window.open.bind(window);
    window.open = function () {
      if (!enabled) return nativeOpen(...arguments);
      return null;
    };
  } catch (_) {}
})();
