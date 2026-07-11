// dataLoader.js -- fetches the static JSON produced by scripts/export_data.py.
// All paths are relative (no leading "/") since GitHub Pages serves this as a
// project site under a repo-name subpath.

async function fetchJson(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`Failed to fetch ${path}: ${res.status}`);
  return res.json();
}

/** Core datasets needed to render the initial globe + timeline. These are all
 * small (periods/diversity/tree_of_life are a few KB; continents ~120KB gzip),
 * so the app can become interactive as soon as they resolve. The large
 * events.json (~800KB gzip / 12.5k objects) is intentionally NOT fetched here --
 * the default deep-time globe view needs zero events, and events only matter
 * once the user zooms the timeline in far enough for markers/map mode. Fetch it
 * separately via loadEvents() so it never blocks time-to-interactive. */
export async function loadCoreData() {
  const [periods, diversity, continents, treeOfLife] = await Promise.all([
    fetchJson("public/data/periods.json"),
    fetchJson("public/data/diversity.json"),
    fetchJson("public/data/continents.json"),
    fetchJson("public/data/tree_of_life.json"),
  ]);
  return { periods, diversity, continents, treeOfLife };
}

export async function loadEvents() {
  return fetchJson("public/data/events.json");
}

/** Kept for callers that want everything up front (unused by the app's hot
 * path, which now defers events -- see loadCoreData/loadEvents). */
export async function loadAllData() {
  const [core, events] = await Promise.all([loadCoreData(), loadEvents()]);
  return { ...core, events };
}
