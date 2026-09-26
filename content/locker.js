// Isolated-world locker companion — runs in ALL frames; syncs MAIN world + blocks blank popouts
(() => {
  const PANEL_ID = "imdb-stream-finder-panel";
  let enabled = true;

  // Only well-known reference sites; embed hosts come from user catalog, not hardcoded here
  const ALLOW_HOST = /(^|\.)(imdb\.com|themoviedb\.org|wikipedia\.org|youtube\.com|youtu\.be)/i;

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

  chrome.storage.local.get(["lockerEnabled"], (stored) => {
    try {
      if (chrome.runtime.lastError || !chrome.runtime?.id) return;
      enabled = stored.lockerEnabled !== false;
      publish();
    } catch (_) {}
  });
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      try {
        if (!chrome.runtime?.id) return;
        if (area === "local" && changes.lockerEnabled) {
          enabled = changes.lockerEnabled.newValue !== false;
          publish();
        }
      } catch (_) {}
    });
  } catch (_) {}

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
      if (inFrame && !ALLOW_HOST.test(host)) {
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
