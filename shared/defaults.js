// Shared defaults — content script + popup. Uses STREAM_PROVIDER_CATALOG (filled by providers.local.js).

function getDefaultLinkLists() {
  if (typeof STREAM_PROVIDER_CATALOG !== "undefined" && catalogHasProviders(STREAM_PROVIDER_CATALOG)) {
    return catalogToLinkLists(STREAM_PROVIDER_CATALOG);
  }
  return { movieLinks: [], tvLinks: [] };
}

const STREAM_FINDER_DEFAULTS = getDefaultLinkLists();

function buildStreamUrl(template, vars) {
  return template
    .replaceAll("{imdb}", vars.imdb || "")
    .replaceAll("{imdb_raw}", vars.imdbRaw || "")
    .replaceAll("{tmdb}", vars.tmdb || "")
    .replaceAll("{season}", String(vars.season ?? 1))
    .replaceAll("{episode}", String(vars.episode ?? 1))
    .replaceAll("{type}", vars.type || "movie");
}

function linkNeedsMissingId(template, vars) {
  const needsTmdb = template.includes("{tmdb}") && !vars.tmdb;
  const needsImdb =
    (template.includes("{imdb}") || template.includes("{imdb_raw}")) && !vars.imdb;
  return needsTmdb || needsImdb;
}

function mergeLinkLists(saved, defaults) {
  if (!saved || !saved.length) return defaults.slice();
  const savedById = new Map(saved.map((l) => [l.id, l]));
  const result = defaults.map((d) => {
    const prev = savedById.get(d.id);
    if (!prev) return { ...d };
    return {
      ...d,
      enabled: prev.enabled !== false,
      name: d.name || prev.name,
      url: d.url
    };
  });
  for (const l of saved) {
    if (String(l.id || "").startsWith("custom-") && !result.some((r) => r.id === l.id)) {
      result.push(l);
    }
  }
  return result;
}
