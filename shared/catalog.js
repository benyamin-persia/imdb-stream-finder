// Helpers only. Real templates load from gitignored shared/providers.local.js (same folder).

var STREAM_PROVIDER_CATALOG = {
  version: "empty",
  updated: null,
  sources: [],
  providers: []
};

function catalogToLinkLists(catalog) {
  const movieLinks = [];
  const tvLinks = [];
  for (const p of catalog.providers || []) {
    if (p.movie) {
      movieLinks.push({
        id: p.id + "-movie",
        name: p.name,
        url: p.movie,
        enabled: p.enabled !== false,
        source: "catalog"
      });
    }
    if (p.tv) {
      tvLinks.push({
        id: p.id + "-tv",
        name: p.name,
        url: p.tv,
        enabled: p.enabled !== false,
        source: "catalog"
      });
    }
  }
  return { movieLinks, tvLinks, version: catalog.version, updated: catalog.updated };
}

function mergeCatalogIntoLists(catalog, currentMovies, currentTv) {
  const built = catalogToLinkLists(catalog);
  const keepCustom = (list) => (list || []).filter((l) => String(l.id || "").startsWith("custom-"));
  return {
    movieLinks: built.movieLinks.concat(keepCustom(currentMovies)),
    tvLinks: built.tvLinks.concat(keepCustom(currentTv)),
    version: built.version,
    updated: built.updated
  };
}

function catalogHasProviders(catalog) {
  return !!(catalog && Array.isArray(catalog.providers) && catalog.providers.some((p) => p && (p.movie || p.tv)));
}
