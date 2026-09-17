(() => {
  const params = new URLSearchParams(location.search);
  const src = params.get("src") || ""; // embed URL from Stream Finder
  const title = params.get("title") || "Stream";

  const player = document.getElementById("player");
  const bar = document.getElementById("bar");
  const err = document.getElementById("err");
  const titleEl = document.getElementById("title");
  const hideUi = document.getElementById("hide-ui");
  const showUi = document.getElementById("show-ui");
  const fsBtn = document.getElementById("fs");

  titleEl.textContent = title;
  document.title = `Cast — ${title}`;

  function measureBar() {
    document.body.style.setProperty("--bar-h", `${bar.offsetHeight}px`); // keep iframe under tips bar
  }

  if (!src) {
    err.hidden = false;
    player.hidden = true;
  } else {
    player.src = src; // same embed the dock was playing
    document.body.classList.add("ui-on");
    measureBar();
  }

  hideUi.addEventListener("click", () => {
    document.body.classList.add("casting-clean"); // cleaner picture for Chromecast tab cast
    document.body.classList.remove("ui-on");
    showUi.hidden = false;
  });

  showUi.addEventListener("click", () => {
    document.body.classList.remove("casting-clean");
    document.body.classList.add("ui-on");
    showUi.hidden = true;
    measureBar();
  });

  fsBtn.addEventListener("click", async () => {
    try {
      if (!document.fullscreenElement) await document.documentElement.requestFullscreen();
      else await document.exitFullscreen();
    } catch (_) {}
  });

  window.addEventListener("resize", measureBar);
})();
