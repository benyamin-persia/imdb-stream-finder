// Provider catalog helpers. Templates are NOT shipped here — they live in MongoDB Atlas
// (via catalog-api) or optional private/providers-catalog.json / providers.private.json.

const STREAM_PROVIDER_CATALOG = {
  version: "remote-only",
  updated: null,
  sources: ["mongodb-atlas"],
  providers: [] // filled at runtime from remote API / private seed file
};

// Turn catalog entries into the movieLinks / tvLinks arrays the UI stores
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

// Merge remote/private catalog over current lists, keep user custom-* rows
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

// True when a catalog object has at least one usable template
function catalogHasProviders(catalog) {
  return !!(catalog && Array.isArray(catalog.providers) && catalog.providers.some((p) => p && (p.movie || p.tv)));
}
