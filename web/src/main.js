// main.js -- app entry point: loads data, wires the timeline, mode dispatch
// (globe vs map viewport), playback loop, and the info panel.

import { loadCoreData, loadEvents } from "./dataLoader.js";
import { Timeline, MAP_HANDOFF_SPAN_MA } from "./timeline.js";
import { MapView } from "./mapView.js";
import { getPeriodAt, formatEventDate, formatMa } from "./events.js";

const SPEEDS = [5, 15, 40, 100, 250, 600, 1500]; // Ma/sec, matches main.py's SPEEDS
let speedIdx = 3;
let paused = false;
let currentMa = 0;
let lastT = performance.now();

let periods = [];
let allEvents = [];
let activeCategories = new Set(["historical", "scientific", "cultural"]);

let viewportMode = "globe"; // "globe" | "map"
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
  els.modeGlobeBtn = q("mode-globe-btn");
  els.modeMapBtn = q("mode-map-btn");
  els.loadingOverlay = q("loading-overlay");
  els.globeCredits = q("globe-credits");
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

function setMode(mode) {
  if (mode === "globe" && !globeAvailable) mode = "map";
  viewportMode = mode;
  els.globeContainer.classList.toggle("hidden", mode !== "globe");
  els.mapContainer.classList.toggle("hidden", mode !== "map");
  els.modeGlobeBtn.classList.toggle("active", mode === "globe");
  els.modeMapBtn.classList.toggle("active", mode === "map");
  // Globe imagery credits only apply in globe mode; the Leaflet map carries its
  // own CARTO/OSM attribution.
  if (els.globeCredits) els.globeCredits.classList.toggle("hidden", mode !== "globe");
  if (mode === "map") {
    mapView.invalidateSize();
    refreshMapEvents();
  }
}

function refreshMapEvents() {
  const win = timeline.getWindow();
  const filtered = allEvents.filter((e) => {
    if (e.place == null || e.place.lat == null) return false;
    if (!activeCategories.has(e.category)) return false;
    return e.time.ma >= win.loMa - 1e-6 && e.time.ma <= win.hiMa + 1e-6;
  });
  // If the visible window contains almost nothing (e.g. still zoomed out),
  // show everything rather than an empty map.
  mapView.setEvents(filtered.length > 0 ? filtered : allEvents.filter(
    (e) => e.place && e.place.lat != null && activeCategories.has(e.category)
  ));
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

  if (viewportMode === "globe" && globeAvailable) {
    globeView.tickInertia(dt);
    globeView.setMa(currentMa);
    globeView.render();
  }

  requestAnimationFrame(tick);
}

function bindControls() {
  els.modeGlobeBtn.addEventListener("click", () => setMode("globe"));
  els.modeMapBtn.addEventListener("click", () => setMode("map"));
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
    else if (ev.code === "KeyW") setMode(viewportMode === "globe" ? "map" : "globe");
  });

  for (const cb of document.querySelectorAll("#category-filters input[type=checkbox]")) {
    cb.addEventListener("change", () => {
      const cat = cb.dataset.cat;
      if (cb.checked) activeCategories.add(cat); else activeCategories.delete(cat);
      timeline.setEvents(allEvents.filter((e) => activeCategories.has(e.category) || e.category === "geological_period"));
      if (viewportMode === "map") refreshMapEvents();
    });
  }
}

async function init() {
  cacheEls();
  bindControls();

  const data = await loadCoreData();
  periods = data.periods;
  currentMa = periods.length ? periods[0].start : 4500;

  timeline = new Timeline(els.timelineCanvas, periods);
  timeline.setEvents(allEvents); // empty for now; populated when events.json arrives
  timeline.onSeek((ma) => { currentMa = ma; });
  const debouncedRefreshMapEvents = debounce(refreshMapEvents, 200);
  timeline.onWindowChange((win) => {
    els.timelineBackBtn.classList.toggle("hidden", timeline.zoomStack.length === 0);
    const span = win.hiMa - win.loMa;
    const wasMap = viewportMode === "map";
    setMode(span <= MAP_HANDOFF_SPAN_MA ? "map" : (viewportMode === "map" && span > MAP_HANDOFF_SPAN_MA ? "globe" : viewportMode));
    // setMode() already refreshes immediately on first entry into map mode
    // (so there's no blank map); while continuing to zoom/pan within map
    // mode, subsequent refreshes are debounced so a rapid gesture doesn't
    // rebuild the marker layer once per wheel-tick.
    if (viewportMode === "map" && wasMap) debouncedRefreshMapEvents();
  });
  timeline.onHoverEvent((e) => showEventDetail(e));

  mapView = new MapView(els.mapContainer);
  mapView.onSelect((e) => showEventDetail(e));

  try {
    const { GlobeView } = await import("./globe/globeView.js");
    globeView = new GlobeView(els.globeContainer, {});
    await globeView.load();
  } catch (exc) {
    console.error("Globe view unavailable, falling back to map mode:", exc);
    globeAvailable = false;
    els.modeGlobeBtn.disabled = true;
    els.modeGlobeBtn.title = "3D globe unavailable in this browser (WebGL required)";
  }

  setMode(globeAvailable ? "globe" : "map");
  els.loadingOverlay.classList.add("hidden");
  requestAnimationFrame(tick);

  // Events are not needed for the initial globe view (they only surface as
  // timeline markers below ~3 Ma of span and in map mode), so fetch the large
  // events.json in the background after the app is already interactive.
  loadEvents()
    .then((events) => {
      allEvents = events;
      timeline.setEvents(allEvents.filter(
        (e) => activeCategories.has(e.category) || e.category === "geological_period"));
      if (viewportMode === "map") refreshMapEvents();
    })
    .catch((exc) => console.error("Failed to load events.json:", exc));
}

init().catch((exc) => {
  console.error(exc);
  const overlay = q("loading-overlay");
  if (overlay) overlay.textContent = "Failed to load Earth History Simulator data. See console for details.";
});
