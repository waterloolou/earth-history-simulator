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

let _eventsIndexPromise = null;

/** The manifest of available event categories (id/count/file), fetched once
 * and cached -- callers that only need to know what's available (e.g. a
 * mode/category picker) don't need to pull any category's full event list. */
export function loadEventsIndex() {
  if (!_eventsIndexPromise) _eventsIndexPromise = fetchJson("public/data/events_index.json");
  return _eventsIndexPromise;
}

/** Fetch discrete events, sharded by category (see scripts/export_data.py) so
 * a growing Wikidata-sourced dataset doesn't mean one ever-larger blob: each
 * category is its own file, fetched in parallel, so time-to-first-marker
 * isn't gated on categories the caller doesn't need yet. Pass `categories` to
 * fetch only a subset (e.g. a mode that only cares about "historical"); omit
 * it to fetch everything the index lists. */
export async function loadEvents(categories = null) {
  const index = await loadEventsIndex();
  const wanted = categories
    ? index.categories.filter((c) => categories.includes(c.id))
    : index.categories;
  const shards = await Promise.all(wanted.map((c) => fetchJson(`public/data/${c.file}`)));
  return shards.flat();
}

/** Kept for callers that want everything up front (unused by the app's hot
 * path, which now defers events -- see loadCoreData/loadEvents). */
export async function loadAllData() {
  const [core, events] = await Promise.all([loadCoreData(), loadEvents()]);
  return { ...core, events };
}
