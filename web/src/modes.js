// modes.js -- registry of "settings" the user can pick to sort/display the
// Wikidata-sourced event data, replacing the old binary Globe/Map toggle.
// Each mode says what kind of viewport it needs and, for map-kind modes,
// which event categories and/or overlay layers should be visible.

export const MODES = [
  {
    id: "deep_time",
    label: "Deep Time",
    kind: "globe",
    description: "Continental drift, paleoclimate, and the geological time scale across 4.5 billion years.",
  },
  {
    id: "all_events",
    label: "All Events",
    kind: "map",
    categories: ["historical", "scientific", "cultural", "people"],
    borders: false,
    filterable: true,
    description: "Every category of event at once -- use the checkboxes to narrow it down.",
  },
  {
    id: "world_history",
    label: "World History",
    kind: "map",
    categories: ["historical"],
    borders: false,
    description: "Battles, treaties, disasters, and other pivotal historical events.",
  },
  {
    id: "science",
    label: "Science & Discovery",
    kind: "map",
    categories: ["scientific"],
    borders: false,
    description: "Scientific discoveries and inventions, from antiquity to the present.",
  },
  {
    id: "culture",
    label: "Arts & Culture",
    kind: "map",
    categories: ["cultural"],
    borders: false,
    description: "Cultural, artistic, and religious milestones.",
  },
  {
    id: "people",
    label: "Notable People",
    kind: "map",
    categories: ["people"],
    borders: false,
    description: "Births and deaths of historically significant figures.",
  },
  {
    id: "nations",
    label: "Nations & Borders",
    kind: "map",
    categories: [],
    borders: true,
    description: "Political borders as they shift from ancient empires and kingdoms to today's countries.",
  },
  {
    id: "tree_of_life",
    label: "Tree of Life",
    kind: "tree",
    description: "Every major lineage since LUCA, 3.8 billion years ago -- zoom in on a branch to reveal thousands of notable species from Wikidata. Click any branch to jump the timeline to when it split off.",
  },
];

export const MODE_BY_ID = Object.fromEntries(MODES.map((m) => [m.id, m]));

export const DEFAULT_GLOBE_MODE = "deep_time";
export const DEFAULT_MAP_MODE = "all_events";

/** All category ids referenced by any map-kind mode -- used to build the
 * category-filter checkboxes and to know what to fetch. */
export function allEventCategories() {
  const set = new Set();
  for (const m of MODES) if (m.categories) for (const c of m.categories) set.add(c);
  return [...set];
}
