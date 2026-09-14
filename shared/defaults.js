// Shared defaults — loaded by both the content script and the popup
// Built from STREAM_PROVIDER_CATALOG when catalog.js is present.

function getDefaultLinkLists() {
  if (typeof STREAM_PROVIDER_CATALOG !== "undefined") {
    return catalogToLinkLists(STREAM_PROVIDER_CATALOG);
  }
  // Empty fallback if catalog failed to load — real list comes from MongoDB via catalog-api
  return {
    movieLinks: [],
    tvLinks: []
  };
}

const STREAM_FINDER_DEFAULTS = getDefaultLinkLists();

// Build a final URL from a template by replacing known placeholders
function buildStreamUrl(template, vars) {
  return template
    .replaceAll("{imdb}", vars.imdb || "")
    .replaceAll("{imdb_raw}", vars.imdbRaw || "")
    .replaceAll("{tmdb}", vars.tmdb || "")
    .replaceAll("{season}", String(vars.season ?? 1))
    .replaceAll("{episode}", String(vars.episode ?? 1))
    .replaceAll("{type}", vars.type || "movie"); // movie | tv for sites using /{type}/
}

// True when a template still has an empty required id after substitution
function linkNeedsMissingId(template, vars) {
  const needsTmdb = template.includes("{tmdb}") && !vars.tmdb;
  const needsImdb =
    (template.includes("{imdb}") || template.includes("{imdb_raw}")) && !vars.imdb;
  return needsTmdb || needsImdb;
}

// Refresh catalog URLs by id; keep enabled flags + custom-* rows
function mergeLinkLists(saved, defaults) {
  if (!saved || !saved.length) return defaults.slice();
  const savedById = new Map(saved.map((l) => [l.id, l]));
  const result = defaults.map((d) => {
    const prev = savedById.get(d.id);
    if (!prev) return { ...d };
    return {
      ...d,
      enabled: prev.enabled !== false, // keep user on/off, refresh URL/name from catalog
      name: d.name || prev.name,
      url: d.url // always take latest catalog template
    };
  });
  for (const l of saved) {
    if (String(l.id || "").startsWith("custom-") && !result.some((r) => r.id === l.id)) {
      result.push(l);
    }
  }
  return result;
}
