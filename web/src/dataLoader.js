// dataLoader.js -- fetches the static JSON produced by scripts/export_data.py.
// All paths are relative (no leading "/") since GitHub Pages serves this as a
// project site under a repo-name subpath.

async function fetchJson(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`Failed to fetch ${path}: ${res.status}`);
  return res.json();
}

export async function loadAllData() {
  const [periods, diversity, continents, treeOfLife, events] = await Promise.all([
    fetchJson("public/data/periods.json"),
    fetchJson("public/data/diversity.json"),
    fetchJson("public/data/continents.json"),
    fetchJson("public/data/tree_of_life.json"),
    fetchJson("public/data/events.json"),
  ]);
  return { periods, diversity, continents, treeOfLife, events };
}
