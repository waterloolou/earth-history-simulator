// main.js -- app entry point: loads data, wires the timeline, mode dispatch
// (which "setting" controls the map/globe viewport), playback loop, and the
// info panel.

import { loadCoreData, loadEvents } from "./dataLoader.js";
import { Timeline, MAP_HANDOFF_SPAN_MA } from "./timeline.js";
import { MapView } from "./mapView.js";
import { getPeriodAt, formatEventDate, formatMa, maToYear } from "./events.js";
import { MODES, MODE_BY_ID, DEFAULT_GLOBE_MODE, DEFAULT_MAP_MODE, allEventCategories } from "./modes.js";

const SPEEDS = [5, 15, 40, 100, 250, 600, 1500]; // Ma/sec, matches main.py's SPEEDS
let speedIdx = 3;
let paused = false;
let currentMa = 0;
let lastT = performance.now();

let periods = [];
let allEvents = [];
let activeCategories = new Set(allEventCategories());

let activeModeId = DEFAULT_GLOBE_MODE;
let lastMapModeId = DEFAULT_MAP_MODE; // remembered across auto globe<->map switches
let globeView = null;
let globeAvailable = true;
let mapView = null;
let timeline = null;

const els = {};

function q(id) { return document.getElementById(id); }

/** Rebuilding the map's marker layer (clearLayers + addLayers over
 * potentially tens of thousands of events) is the dominant cost of any
 * per-interaction refresh; debouncing it means a rapid zoom/pan gesture only
 * pays that cost once it settles, instead of once per wheel-tick. */
function debounce(fn, ms) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

function cacheEls() {
  els.globeContainer = q("globe-view");
  els.mapContainer = q("map-view");
  els.modeSelect = q("mode-select");
  els.modeDesc = q("mode-desc");
  els.loadingOverlay = q("loading-overlay");
  els.globeCredits = q("globe-credits");
  els.categoryFilters = q("category-filters");
  els.timelineCanvas = q("timeline-canvas");
  els.timelineBackBtn = q("timeline-back-btn");
  els.timelineResetBtn = q("timeline-reset-btn");
  els.timeReadout = q("time-readout");
  els.periodReadout = q("period-readout");
  els.periodBadge = q("period-badge");
  els.periodName = q("period-name");
  els.periodRange = q("period-range");
  els.periodDesc = q("period-desc");
  els.eventDetail = q("event-detail");
  els.eventTitle = q("event-title");
  els.eventMeta = q("event-meta");
  els.eventDesc = q("event-desc");
  els.eventWikiLink = q("event-wiki-link");
}

function populateModeSelect() {
  els.modeSelect.innerHTML = "";
  for (const m of MODES) {
    const opt = document.createElement("option");
    opt.value = m.id;
    opt.textContent = m.label;
    els.modeSelect.appendChild(opt);
  }
}

/** Switch the active "setting". Modes are looked up by id in MODES/MODE_BY_ID
 * (see modes.js) -- each says what kind of viewport it needs (globe vs map)
 * and, for map-kind modes, which event categories and/or the borders overlay
 * should be visible. Falls back to the map if the globe is unavailable
 * (no WebGL) and a globe-kind mode was requested. */
function setMode(modeId) {
  let mode = MODE_BY_ID[modeId] || MODE_BY_ID[DEFAULT_GLOBE_MODE];
  if (mode.kind === "globe" && !globeAvailable) mode = MODE_BY_ID[DEFAULT_MAP_MODE];
  activeModeId = mode.id;
  if (mode.kind === "map") lastMapModeId = mode.id;

  els.globeContainer.classList.toggle("hidden", mode.kind !== "globe");
  els.mapContainer.classList.toggle("hidden", mode.kind !== "map");
  els.modeSelect.value = mode.id;
  els.modeDesc.textContent = mode.description || "";
  els.categoryFilters.classList.toggle("hidden", !(mode.kind === "map" && mode.filterable));

  // Globe imagery credits only apply in globe mode; the Leaflet map carries its
  // own CARTO/OSM + borders-data attribution.
  if (els.globeCredits) els.globeCredits.classList.toggle("hidden", mode.kind !== "globe");

  if (mode.kind === "map") {
    mapView.invalidateSize();
    mapView.setPinsVisible(mode.categories.length > 0);
    mapView.setBordersVisible(!!mode.borders);
    if (mode.borders) mapView.setBordersYear(maToYear(currentMa));
    refreshMapEvents();
  }
}

function currentModeCategories() {
  const mode = MODE_BY_ID[activeModeId];
  if (!mode || mode.kind !== "map") return [];
  return mode.filterable ? mode.categories.filter((c) => activeCategories.has(c)) : mode.categories;
}

function refreshMapEvents() {
  const mode = MODE_BY_ID[activeModeId];
  if (!mode || mode.kind !== "map" || mode.categories.length === 0) {
    mapView.setEvents([]);
    return;
  }
  const cats = currentModeCategories();
  const win = timeline.getWindow();
  const filtered = allEvents.filter((e) => {
    if (e.place == null || e.place.lat == null) return false;
    if (!cats.includes(e.category)) return false;
    return e.time.ma >= win.loMa - 1e-6 && e.time.ma <= win.hiMa + 1e-6;
  });
  // If the visible window contains almost nothing (e.g. still zoomed out),
  // show everything in the active mode's categories rather than an empty map.
  mapView.setEvents(filtered.length > 0 ? filtered : allEvents.filter(
    (e) => e.place && e.place.lat != null && cats.includes(e.category)
  ));
}

function timelineEventFilter() {
  // The timeline always shows markers for every category currently enabled
  // via the checkboxes (when relevant) so switching modes doesn't require
  // re-fetching -- category relevance to the *map* is handled separately in
  // refreshMapEvents()/currentModeCategories().
  return allEvents;
}

function updateInfoPanel(ma) {
  const p = getPeriodAt(periods, ma);
  if (!p) return;
  els.periodBadge.style.background = `rgb(${p.color[0]},${p.color[1]},${p.color[2]})`;
  els.periodBadge.textContent = p.era && p.era !== "--" ? `${p.eon} · ${p.era}` : p.eon;
  els.periodBadge.style.color = "#fff";
  els.periodBadge.style.textAlign = "center";
  els.periodBadge.style.fontSize = "12px";
  els.periodBadge.style.lineHeight = "22px";
  els.periodName.textContent = p.name;
  const sStr = p.start < 1000 ? `${Math.round(p.start)} Ma` : `${(p.start / 1000).toFixed(1)} Ga`;
  const eStr = p.end > 0 ? `${Math.round(p.end)} Ma` : "present";
  els.periodRange.textContent = `${sStr} to ${eStr}`;
  els.periodDesc.textContent = p.event;

  els.timeReadout.textContent = formatMa(ma);
  els.periodReadout.textContent = `${p.eon} · ${p.name}`;
}

function showEventDetail(e) {
  if (!e) { els.eventDetail.classList.add("hidden"); return; }
  els.eventDetail.classList.remove("hidden");
  els.eventTitle.textContent = e.title;
  els.eventMeta.textContent = `${formatEventDate(e.time)}${e.place && e.place.region ? " · " + e.place.region : ""}`;
  els.eventDesc.textContent = e.description || "";
  const url = (e.wiki && e.wiki.url) || `https://en.wikipedia.org/wiki/${encodeURIComponent(e.title)}`;
  els.eventWikiLink.href = url;
}

function tick() {
  const now = performance.now();
  const dt = Math.min((now - lastT) / 1000, 0.08);
  lastT = now;

  if (!paused) {
    currentMa -= SPEEDS[speedIdx] * dt;
    if (currentMa < 0) currentMa = 0;
  }

  timeline.render(currentMa);
  updateInfoPanel(currentMa);

  const mode = MODE_BY_ID[activeModeId];
  if (mode && mode.kind === "globe" && globeAvailable) {
    globeView.tickInertia(dt);
    globeView.setMa(currentMa);
    globeView.render();
  } else if (mode && mode.kind === "map" && mode.borders) {
    mapView.setBordersYear(maToYear(currentMa));
  }

  requestAnimationFrame(tick);
}

function bindControls() {
  els.modeSelect.addEventListener("change", () => setMode(els.modeSelect.value));

  els.timelineResetBtn.addEventListener("click", () => {
    timeline.reset();
    currentMa = timeline.fullHiMa;
  });
  els.timelineBackBtn.addEventListener("click", () => timeline.back());

  window.addEventListener("keydown", (ev) => {
    if (ev.code === "Space") { paused = !paused; ev.preventDefault(); }
    else if (ev.code === "ArrowRight") speedIdx = Math.min(speedIdx + 1, SPEEDS.length - 1);
    else if (ev.code === "ArrowLeft") speedIdx = Math.max(speedIdx - 1, 0);
    else if (ev.code === "KeyR") { timeline.reset(); currentMa = timeline.fullHiMa; }
    else if (ev.code === "KeyW") {
      const mode = MODE_BY_ID[activeModeId];
      setMode(mode && mode.kind === "globe" ? lastMapModeId : DEFAULT_GLOBE_MODE);
    }
  });

  for (const cb of document.querySelectorAll("#category-filters input[type=checkbox]")) {
    cb.addEventListener("change", () => {
      const cat = cb.dataset.cat;
      if (cb.checked) activeCategories.add(cat); else activeCategories.delete(cat);
      refreshMapEvents();
    });
  }
}

async function init() {
  cacheEls();
  populateModeSelect();
  bindControls();

  const data = await loadCoreData();
  periods = data.periods;
  currentMa = periods.length ? periods[0].start : 4500;

  timeline = new Timeline(els.timelineCanvas, periods);
  timeline.setEvents(allEvents); // empty for now; populated when events arrive
  timeline.onSeek((ma) => { currentMa = ma; });
  const debouncedRefreshMapEvents = debounce(refreshMapEvents, 200);
  timeline.onWindowChange((win) => {
    els.timelineBackBtn.classList.toggle("hidden", timeline.zoomStack.length === 0);
    const span = win.hiMa - win.loMa;
    const mode = MODE_BY_ID[activeModeId];
    const wasMap = mode && mode.kind === "map";
    if (span <= MAP_HANDOFF_SPAN_MA) {
      if (!wasMap) setMode(lastMapModeId);
    } else if (wasMap) {
      setMode(DEFAULT_GLOBE_MODE);
    }
    if (MODE_BY_ID[activeModeId].kind === "map" && wasMap) debouncedRefreshMapEvents();
  });
  timeline.onHoverEvent((e) => showEventDetail(e));

  mapView = new MapView(els.mapContainer);
  mapView.onSelect((e) => showEventDetail(e));
  mapView.borders.onFeatureClick(({ name, year }) => {
    showEventDetail({
      title: name,
      time: { ma: null, year },
      place: { region: null },
      description: `Territory as of ${year < 0 ? -year + " BCE" : year + " CE"}, from historical border reconstructions.`,
      wiki: { url: `https://en.wikipedia.org/wiki/${encodeURIComponent(name)}` },
    });
  });

  try {
    const { GlobeView } = await import("./globe/globeView.js");
    globeView = new GlobeView(els.globeContainer, {});
    await globeView.load();
  } catch (exc) {
    console.error("Globe view unavailable, falling back to map mode:", exc);
    globeAvailable = false;
  }

  setMode(globeAvailable ? DEFAULT_GLOBE_MODE : DEFAULT_MAP_MODE);
  els.loadingOverlay.classList.add("hidden");
  requestAnimationFrame(tick);

  // Events are not needed for the initial globe view (they only surface as
  // timeline markers below ~50,000 years of span and in map modes), so fetch
  // them in the background after the app is already interactive.
  loadEvents()
    .then((events) => {
      allEvents = events;
      timeline.setEvents(timelineEventFilter());
      if (MODE_BY_ID[activeModeId].kind === "map") refreshMapEvents();
    })
    .catch((exc) => console.error("Failed to load events:", exc));
}

init().catch((exc) => {
  console.error(exc);
  const overlay = q("loading-overlay");
  if (overlay) overlay.textContent = "Failed to load Earth History Simulator data. See console for details.";
});
