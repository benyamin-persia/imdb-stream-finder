// Public stub only — real templates live in MongoDB Atlas (served by catalog-api).
// Sync via popup remote catalog URL after running catalog-api (or your hosted API).

const STREAM_PROVIDER_CATALOG = {
  version: "remote-only",
  updated: "2026-03-14",
  sources: ["mongodb-atlas"],
  providers: [] // intentionally empty in the public repo
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

// Merge remote/bundled catalog over current lists, keep user custom-* rows
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
