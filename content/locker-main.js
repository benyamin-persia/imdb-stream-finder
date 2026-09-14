// MAIN-world hard popup locker — must run in ALL frames at document_start
(function () {
  "use strict";
  const NATIVE_OPEN = window.open;
  let enabled = true;
  let installGeneration = 0;

  window.addEventListener(
    "message",
    (ev) => {
      if (ev.source !== window && ev.source !== window.parent) return;
      if (!ev.data || ev.data.source !== "isf-locker") return;
      if (typeof ev.data.enabled === "boolean") {
        enabled = ev.data.enabled;
        harden();
      }
    },
    true
  );

  function blockedOpen() {
    return null;
  }

  function harden() {
    const gen = ++installGeneration;
    const openFn = function () {
      if (!enabled) return NATIVE_OPEN.apply(window, arguments);
      return blockedOpen();
    };

    try {
      Object.defineProperty(window, "open", {
        configurable: true,
        enumerable: true,
        get() {
          return enabled ? openFn : NATIVE_OPEN;
        },
        set(v) {
          // Ignore ad scripts that try to restore/replace open while locker is on
          if (!enabled && typeof v === "function") {
            try {
              Object.defineProperty(window, "open", {
                configurable: true,
                writable: true,
                value: v
              });
            } catch (_) {}
          }
        }
      });
    } catch (_) {
      try {
        window.open = openFn;
      } catch (_) {}
    }

    // Re-assert shortly after — many players redefine open in the first tick
    [0, 50, 200, 1000, 3000].forEach((ms) => {
      setTimeout(() => {
        if (gen !== installGeneration) return;
        if (!enabled) return;
        try {
          if (window.open !== openFn) {
            Object.defineProperty(window, "open", {
              configurable: true,
              enumerable: true,
              get() {
                return openFn;
              },
              set() {}
            });
          }
        } catch (_) {}
      }, ms);
    });
  }

  // Stop common popunder helpers
  try {
    const trap = {
      apply(_t, _thisArg, args) {
        if (!enabled) return Reflect.apply(NATIVE_OPEN, window, args);
        return null;
      }
    };
    // noop placeholder for older patterns
    void trap;
  } catch (_) {}

  // Neutralize target=_blank / window.open in inline handlers as nodes appear
  function scrubNode(node) {
    if (!enabled || !node || node.nodeType !== 1) return;
    try {
      if (node.tagName === "A") {
        const href = (node.getAttribute("href") || "").trim();
        if (/^(javascript:|data:)/i.test(href) || href === "#" || href === "") {
          node.removeAttribute("href");
        }
        if (node.getAttribute("target") === "_blank") {
          // Keep player UI links; blank outsides become same-tab (less popunder)
          node.setAttribute("target", "_self");
          node.setAttribute("rel", "noopener noreferrer");
        }
        ["onclick", "onmousedown", "onmouseup", "ontouchstart"].forEach((attr) => {
          const v = node.getAttribute(attr) || "";
          if (/window\.open|popup|popunder/i.test(v)) node.removeAttribute(attr);
        });
      }
      if (node.tagName === "IFRAME") {
        const src = node.getAttribute("src") || "";
        if (
          /(popads|popcash|exoclick|juicyads|propeller|adsterra|hilltopads|clickadu|doubleclick|googlesyndication|stripchat|chaturbate|livejasmin)/i.test(
            src
          )
        ) {
          node.remove();
          return;
        }
      }
      if (node.querySelectorAll) {
        node.querySelectorAll("a[target='_blank'], iframe").forEach(scrubNode);
      }
    } catch (_) {}
  }

  function observe() {
    const mo = new MutationObserver((muts) => {
      if (!enabled) return;
      for (const m of muts) {
        m.addedNodes && m.addedNodes.forEach(scrubNode);
      }
    });
    const start = () => {
      try {
        mo.observe(document.documentElement || document, {
          childList: true,
          subtree: true
        });
        scrubNode(document.documentElement);
      } catch (_) {}
    };
    if (document.documentElement) start();
    else document.addEventListener("DOMContentLoaded", start, { once: true });
  }

  // Capture-phase click kill for leftover blanks / fake buttons
  document.addEventListener(
    "click",
    (e) => {
      if (!enabled) return;
      const t = e.target;
      if (!t || !t.closest) return;
      const a = t.closest("a");
      if (!a) return;
      const href = a.getAttribute("href") || "";
      if (/javascript:/i.test(href) || href === "#") {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    },
    true
  );

  harden();
  observe();
})();
