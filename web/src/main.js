// main.js -- app entry point: loads data, wires the timeline, mode dispatch
// (which "setting" controls the map/globe viewport), playback loop, and the
// info panel.

import { loadCoreData, loadEvents } from "./dataLoader.js";
import { Timeline, MAP_HANDOFF_SPAN_MA } from "./timeline.js";
import { MapView } from "./mapView.js";
import { getPeriodAt, getEvent, formatEventDate, formatMa, maToYear } from "./events.js";
import { MODES, MODE_BY_ID, DEFAULT_GLOBE_MODE, DEFAULT_MAP_MODE, allEventCategories } from "./modes.js";
import { readUrlState, writeUrlState } from "./urlState.js";

const SPEEDS = [5, 15, 40, 100, 250, 600, 1500]; // Ma/sec, matches main.py's SPEEDS
const HELP_SEEN_KEY = "ehs_help_seen_v1";
let speedIdx = 3;
let paused = false;
let currentMa = 0;
let lastT = performance.now();
let lastUrlSyncT = 0;
let lastUrlSnapshot = "";

let periods = [];
let allEvents = [];
let activeCategories = new Set(allEventCategories());
let selectedEventId = null; // explicitly picked via search, share link, or map/border click

let activeModeId = DEFAULT_GLOBE_MODE;
let lastMapModeId = DEFAULT_MAP_MODE; // remembered across auto globe<->map switches
let globeView = null;
let globeAvailable = true;
let mapView = null;
let timeline = null;
let treeView = null;
let treeViewLoading = null; // Promise, set while the tree module/data is being fetched

const els = {};

function q(id) { return document.getElementById(id); }

/** Rebuilding the map's marker layer (clearLayers + addLayers over
 * potentially tens of thousands of events) is the dominant cost of any
 * per-interaction refresh; debouncing it means a rapid zoom/pan gesture only
 * pays that cost once it settles, instead of once per wheel-tick. */
function debounce(fn, ms) {
  let t = null;
  const debounced = (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
  debounced.cancel = () => clearTimeout(t);
  return debounced;
}

let debouncedRefreshMapEvents = null; // assigned in init(); exposed at module scope so
                                       // resolvePendingFocus() can cancel a stale rebuild
let pendingFocusEvent = null; // event to pan/open once the next marker-layer rebuild lands

function cacheEls() {
  els.globeContainer = q("globe-view");
  els.mapContainer = q("map-view");
  els.infoPanel = q("info-panel");
  els.infoPanelHandle = q("info-panel-handle");
  els.modeSelect = q("mode-select");
  els.modeDesc = q("mode-desc");
  els.loadingOverlay = q("loading-overlay");
  els.globeCredits = q("globe-credits");
  els.categoryFilters = q("category-filters");
  els.timelineCanvas = q("timeline-canvas");
  els.timelineBackBtn = q("timeline-back-btn");
  els.timelineResetBtn = q("timeline-reset-btn");
  els.timelineZoomInBtn = q("timeline-zoom-in-btn");
  els.timelineZoomOutBtn = q("timeline-zoom-out-btn");
  els.timelineTodayBtn = q("timeline-today-btn");
  els.timeReadout = q("time-readout");
  els.periodReadout = q("period-readout");
  els.periodBadge = q("period-badge");
  els.periodName = q("period-name");
  els.periodRange = q("period-range");
  els.periodDesc = q("period-desc");
  els.eventDetail = q("event-detail");
  els.eventImage = q("event-image");
  els.eventDateKicker = q("event-date-kicker");
  els.eventTitle = q("event-title");
  els.eventMeta = q("event-meta");
  els.eventDesc = q("event-desc");
  els.eventWikiLink = q("event-wiki-link");
  els.treeGlobeBtn = q("tree-globe-btn");
  els.treeContainer = q("tree-view");
  els.treeLoading = q("tree-loading");
  els.eventSearch = q("event-search");
  els.searchInput = q("search-input");
  els.searchResults = q("search-results");
  els.shareBtn = q("share-btn");
  els.helpBtn = q("help-btn");
  els.helpOverlay = q("help-overlay");
  els.helpCloseBtn = q("help-close-btn");
  els.toast = q("toast");
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
  els.treeContainer.classList.toggle("hidden", mode.kind !== "tree");
  els.modeSelect.value = mode.id;
  els.modeDesc.textContent = mode.description || "";
  els.categoryFilters.classList.toggle("hidden", !(mode.kind === "map" && mode.filterable));

  // Globe imagery credits only apply in globe mode; the Leaflet map carries its
  // own CARTO/OSM + borders-data attribution; the tree is original curated
  // content, already covered by the app's own attribution, so needs none of its own.
  if (els.globeCredits) els.globeCredits.classList.toggle("hidden", mode.kind !== "globe");

  if (mode.kind === "tree") ensureTreeView();

  if (mode.kind === "map") {
    mapView.invalidateSize();
    mapView.setPinsVisible(mode.categories.length > 0);
    mapView.setBordersVisible(!!mode.borders);
    if (mode.borders) mapView.setBordersYear(maToYear(currentMa));
    refreshMapEvents();
  }
  syncUrlIfChanged();
}

function currentModeCategories() {
  const mode = MODE_BY_ID[activeModeId];
  if (!mode || mode.kind !== "map") return [];
  return mode.filterable ? mode.categories.filter((c) => activeCategories.has(c)) : mode.categories;
}

let lastMapRefreshKey = null;

function refreshMapEvents() {
  const mode = MODE_BY_ID[activeModeId];
  if (!mode || mode.kind !== "map" || mode.categories.length === 0) {
    mapView.setEvents([]);
    lastMapRefreshKey = null;
    resolvePendingFocus();
    return;
  }
  const cats = currentModeCategories();
  const win = timeline.getWindow();
  // timeline.jumpToEvent()'s animation re-fires onWindowChange (and thus the
  // debounced refresh that calls this) on every settled frame even after the
  // window stops moving, and a plain drag/zoom gesture can do the same. A
  // rebuild when nothing has actually changed is pure waste -- and worse, it
  // can clear/replace the marker cluster layer out from under an already-
  // resolved, still-animating focusEvent() pan (see MapView.focusEvent's
  // comments on the underlying library's lack of per-call scoping). allEvents
  // .length is included so this doesn't also suppress the one-time real
  // rebuild once the initially-empty allEvents finishes loading.
  const key = `${activeModeId}|${cats.join(",")}|${win.loMa.toFixed(6)}|${win.hiMa.toFixed(6)}|${allEvents.length}`;
  if (key === lastMapRefreshKey && !pendingFocusEvent) return;
  lastMapRefreshKey = key;
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
  resolvePendingFocus();
}

/** Pan/zoom to + open the popup for whatever event selectEvent(e, {flyTo})
 * queued, once the marker layer that would contain it has actually been
 * rebuilt. Resolving off the real rebuild (rather than a guessed setTimeout
 * delay) avoids a race where a later debounced refreshMapEvents() call --
 * scheduled by the timeline's own auto globe->map handoff -- clears and
 * rebuilds the cluster layer out from under an in-flight
 * cluster.zoomToShowLayer() animation, which throws inside Leaflet. Cancelling
 * any not-yet-fired debounced refresh here means that redundant rebuild (of a
 * window that has already settled) never happens at all. */
function resolvePendingFocus() {
  if (!pendingFocusEvent) return;
  const e = pendingFocusEvent;
  pendingFocusEvent = null;
  if (debouncedRefreshMapEvents) debouncedRefreshMapEvents.cancel();
  mapView.focusEvent(e);
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
  els.treeGlobeBtn.classList.add("hidden"); // only shown by selectTreeNode(), below
  if (!e) { els.eventDetail.classList.add("hidden"); return; }
  els.eventDetail.classList.remove("hidden");
  // No-op on desktop (the .expanded rule only exists inside the mobile
  // media query) -- on the mobile bottom-sheet layout, surface new detail
  // immediately rather than leaving it collapsed behind the handle.
  els.infoPanel.classList.add("expanded");
  if (e.image_url) {
    els.eventImage.onerror = () => els.eventImage.classList.add("hidden");
    els.eventImage.src = e.image_url;
    els.eventImage.classList.remove("hidden");
  } else {
    els.eventImage.classList.add("hidden");
    els.eventImage.removeAttribute("src");
  }
  // Date first, as a small kicker above the title -- the date is usually
  // the first thing a reader wants to orient on.
  els.eventDateKicker.textContent = formatEventDate(e.time);
  els.eventTitle.textContent = e.title;
  els.eventMeta.textContent = e.place && e.place.region ? e.place.region : "";
  els.eventDesc.textContent = e.description || "";
  const url = (e.wiki && e.wiki.url) || `https://en.wikipedia.org/wiki/${encodeURIComponent(e.title)}`;
  els.eventWikiLink.href = url;
}

/** Explicitly "select" an event (as opposed to a transient timeline hover
 * preview): marks it as the shareable/URL-encoded selection, shows its
 * detail, and -- when flyTo is set (search results, shared links) -- lands on
 * a map mode that can actually show this event's category, then jumps the
 * timeline to it; resolvePendingFocus() pans to and opens the marker once the
 * resulting refreshMapEvents() call lands. Used by search results, shared
 * event links, and direct map-pin clicks (border-polygon clicks intentionally
 * don't touch selectedEventId -- see the comment at that call site). */
function selectEvent(e, { flyTo = false } = {}) {
  selectedEventId = e ? e.id : null;
  showEventDetail(e);
  if (e && flyTo) {
    paused = true; // don't let autoplay immediately drift away from what was just searched for
    currentMa = e.time.ma;
    // Most map modes are locked to a single fixed category (or, for
    // "nations", none at all) -- landing in one of those when it doesn't
    // include this event's category would jump the timeline right past it
    // without ever actually showing the pin. Fall back to the all-categories
    // mode whenever the remembered one can't show it.
    let landingModeId = lastMapModeId;
    const landing = MODE_BY_ID[landingModeId];
    if (!landing || !landing.categories.includes(e.category)) landingModeId = DEFAULT_MAP_MODE;
    lastMapModeId = landingModeId;
    const targetMode = MODE_BY_ID[landingModeId];
    if (targetMode.filterable && !activeCategories.has(e.category)) {
      activeCategories.add(e.category);
      const cb = document.querySelector(`#category-filters input[data-cat="${e.category}"]`);
      if (cb) cb.checked = true;
    }
    pendingFocusEvent = e;
    const current = MODE_BY_ID[activeModeId];
    if (current && current.kind === "map" && current.id !== landingModeId) {
      // Already on a map, just the wrong one for this event -- the
      // globe->map auto-handoff in timeline.onWindowChange (below) only
      // fires on a *globe*-to-map transition, so switching mode here is the
      // only thing that actually corrects an already-map-mode mismatch.
      setMode(landingModeId);
    }
    timeline.jumpToEvent(e.time.ma);
  }
  syncUrlIfChanged();
}

/** Handle a click on a Tree of Life branch: scrub the shared playhead to
 * when that clade diverged (so it's reflected everywhere -- the timeline,
 * the tree's own "current era" ring, and the info panel), and show its
 * detail with a one-click way to actually go look at that era on the globe.
 * Doesn't touch selectedEventId/the URL -- clade nodes aren't part of the
 * events dataset (no stable cross-session id to encode), same reasoning as
 * the border-polygon click handler. */
function selectTreeNode(node) {
  currentMa = node.first_ma;
  timeline.currentMa = node.first_ma;
  const desc = node.extinct_ma > 0
    ? `Branched off ${formatMa(node.first_ma)}. This lineage died out around ${formatMa(node.extinct_ma)}.`
    : `Branched off ${formatMa(node.first_ma)}. Still alive today.`;
  showEventDetail({
    title: node.label,
    time: { ma: node.first_ma },
    place: { region: null },
    description: desc,
    wiki: { url: `https://en.wikipedia.org/wiki/${encodeURIComponent(node.label)}` },
  });
  els.treeGlobeBtn.classList.remove("hidden");
}

/** Lazily construct + load the Tree of Life view on first entry into that
 * mode (mirrors globeView's dynamic import, but deferred rather than
 * eager -- unlike the globe, tree mode isn't the default startup view, so
 * there's no reason to pay for Three.js/the tree data before it's needed).
 * Safe to call repeatedly; returns the same in-flight/resolved promise. */
function ensureTreeView() {
  if (treeViewLoading) return treeViewLoading;
  els.treeLoading.classList.remove("hidden");
  treeViewLoading = import("./tol/treeView.js")
    .then(async ({ TreeView }) => {
      const tv = new TreeView(els.treeContainer, {});
      await tv.load();
      tv.onSelect(selectTreeNode);
      tv.setMa(currentMa);
      treeView = tv;
      els.treeLoading.classList.add("hidden");
      return tv;
    })
    .catch((exc) => {
      console.error("Tree of Life view failed to load:", exc);
      els.treeLoading.textContent = "Tree of Life view failed to load.";
      throw exc;
    });
  return treeViewLoading;
}

function currentUrlState() {
  return { ma: currentMa, modeId: activeModeId, eventId: selectedEventId };
}

function urlStateKey(s) {
  return `${s.ma.toFixed(4)}|${s.modeId}|${s.eventId || ""}`;
}

function writeAndTrackUrl(s) {
  writeUrlState(s);
  lastUrlSnapshot = urlStateKey(s);
}

/** Keep the URL in sync with (ma, mode, selected event) so the current view
 * is always bookmarkable, without hammering history.replaceState every
 * animation frame -- only writes when the encoded state actually changed. */
function syncUrlIfChanged() {
  const s = currentUrlState();
  if (urlStateKey(s) === lastUrlSnapshot) return;
  writeAndTrackUrl(s);
}

let toastTimer = null;
function showToast(msg) {
  els.toast.textContent = msg;
  els.toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove("show"), 2200);
}

async function copyShareLink() {
  writeAndTrackUrl(currentUrlState());
  try {
    await navigator.clipboard.writeText(window.location.href);
    showToast("Link copied to clipboard");
  } catch {
    showToast(window.location.href);
  }
}

// ── event search ────────────────────────────────────────────────────────
function hideSearchResults() { els.searchResults.classList.add("hidden"); }

function runSearch(query) {
  const q = query.trim().toLowerCase();
  if (q.length < 2 || allEvents.length === 0) { hideSearchResults(); return; }
  const scored = [];
  for (const e of allEvents) {
    // _titleLower is precomputed once when events load (see loadEvents().then
    // in init()) -- recomputing toLowerCase() per event on every keystroke
    // was a measurable per-keystroke cost at ~24k events.
    const title = e._titleLower;
    const idx = title.indexOf(q);
    if (idx === -1) continue;
    // Prefix matches first, then shorter titles (more likely to be the
    // event's main subject rather than an incidental mention in a longer name).
    scored.push({ e, score: (idx === 0 ? 0 : 1) * 1000 + title.length });
  }
  scored.sort((a, b) => a.score - b.score);
  renderSearchResults(scored.slice(0, 20).map((s) => s.e));
}

/** Events (of any year) that fall on today's calendar month/day -- a
 * pure client-side filter over data already loaded, no new fetch. Shown by
 * default when the search box is focused empty, giving repeat visitors a
 * reason to check back in rather than only ever reaching content via an
 * exact-title search or manual scrub. */
function onThisDayEvents() {
  const now = new Date();
  const month = now.getMonth() + 1, day = now.getDate();
  return allEvents
    .filter((e) => e.time.month === month && e.time.day === day)
    .sort((a, b) => (b.time.year ?? -Infinity) - (a.time.year ?? -Infinity));
}

function showOnThisDay() {
  if (allEvents.length === 0) { hideSearchResults(); return; }
  renderSearchResults(onThisDayEvents().slice(0, 20), "On this day");
}

/** Decides what the search dropdown shows for the current input value:
 * real matches at 2+ characters (unchanged), "on this day" suggestions when
 * genuinely empty (new), or nothing for the ambiguous single-character
 * transitional state in between (unchanged from before "on this day" existed). */
function updateSearchDropdown(query) {
  const q = query.trim();
  if (q.length >= 2) { runSearch(q); return; }
  if (q.length === 0) { showOnThisDay(); return; }
  hideSearchResults();
}

function renderSearchResults(results, heading = null) {
  els.searchResults.innerHTML = "";
  if (heading) {
    const h = document.createElement("div");
    h.className = "search-heading";
    h.textContent = heading;
    els.searchResults.appendChild(h);
  }
  if (results.length === 0) {
    const empty = document.createElement("div");
    empty.className = "search-empty";
    empty.textContent = heading ? "No events recorded for today's date yet" : "No matches";
    els.searchResults.appendChild(empty);
    els.searchResults.classList.remove("hidden");
    return;
  }
  for (const e of results) {
    const btn = document.createElement("button");
    btn.className = "search-result";
    btn.type = "button";
    btn.setAttribute("role", "option");
    const date = document.createElement("span");
    date.className = "sr-date";
    date.textContent = formatEventDate(e.time);
    const title = document.createElement("span");
    title.className = "sr-title";
    title.textContent = e.title;
    btn.append(date, title);
    btn.addEventListener("click", () => {
      selectEvent(e, { flyTo: true });
      hideSearchResults();
      els.searchInput.value = e.title;
      els.searchInput.blur();
    });
    els.searchResults.appendChild(btn);
  }
  els.searchResults.classList.remove("hidden");
}

function bindSearch() {
  const debouncedUpdate = debounce(() => updateSearchDropdown(els.searchInput.value), 120);
  els.searchInput.addEventListener("input", debouncedUpdate);
  els.searchInput.addEventListener("focus", () => updateSearchDropdown(els.searchInput.value));
  document.addEventListener("click", (ev) => {
    if (!els.eventSearch.contains(ev.target)) hideSearchResults();
  });
}

// ── onboarding help ─────────────────────────────────────────────────────
function showHelp() {
  els.helpOverlay.classList.remove("hidden");
  paused = true; // don't let autoplay drift away from the starting view while it's being read
}
function hideHelp() {
  els.helpOverlay.classList.add("hidden");
  try { localStorage.setItem(HELP_SEEN_KEY, "1"); } catch { /* privacy mode, etc. */ }
}
function bindHelp() {
  els.helpBtn.addEventListener("click", showHelp);
  els.helpCloseBtn.addEventListener("click", hideHelp);
  els.helpOverlay.addEventListener("click", (ev) => { if (ev.target === els.helpOverlay) hideHelp(); });
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
  } else if (mode && mode.kind === "tree" && treeView) {
    treeView.tickInertia(dt);
    treeView.setMa(currentMa);
    treeView.render();
  }

  // Periodic (not per-frame) URL sync so a shared/copied link stays roughly
  // current during autoplay without hammering history.replaceState every tick.
  if (now - lastUrlSyncT > 1000) { lastUrlSyncT = now; syncUrlIfChanged(); }

  requestAnimationFrame(tick);
}

function bindControls() {
  els.modeSelect.addEventListener("change", () => setMode(els.modeSelect.value));
  els.treeGlobeBtn.addEventListener("click", () => setMode(DEFAULT_GLOBE_MODE));

  // Mobile bottom-sheet handle -- inert on desktop (toggling a class the
  // desktop CSS never reads). role=button + tabindex means it needs an
  // explicit Enter/Space handler too, not just click.
  els.infoPanelHandle.addEventListener("click", () => els.infoPanel.classList.toggle("expanded"));
  els.infoPanelHandle.addEventListener("keydown", (ev) => {
    if (ev.code === "Enter" || ev.code === "Space") {
      ev.preventDefault();
      els.infoPanel.classList.toggle("expanded");
    }
  });

  els.timelineResetBtn.addEventListener("click", () => {
    timeline.reset();
    currentMa = timeline.fullHiMa;
  });
  els.timelineBackBtn.addEventListener("click", () => timeline.back());
  els.timelineZoomInBtn.addEventListener("click", () => timeline.zoomStep(1.6));
  els.timelineZoomOutBtn.addEventListener("click", () => timeline.zoomStep(1 / 1.6));
  els.timelineTodayBtn.addEventListener("click", () => {
    timeline.jumpToPresent();
    currentMa = 0;
  });

  els.shareBtn.addEventListener("click", () => copyShareLink());
  bindSearch();
  bindHelp();

  window.addEventListener("keydown", (ev) => {
    // Don't let typing in the search box (or any future input) trigger
    // playback shortcuts -- e.g. typing "war" would otherwise toggle pause
    // (space), speed up (r is not bound, but w toggles the globe/map).
    const tag = ev.target && ev.target.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") {
      if (ev.code === "Escape") { ev.target.blur(); hideSearchResults(); }
      return;
    }
    if (!els.helpOverlay.classList.contains("hidden")) {
      if (ev.code === "Escape") hideHelp();
      return;
    }
    if (ev.code === "Space") { paused = !paused; ev.preventDefault(); }
    else if (ev.code === "ArrowRight") speedIdx = Math.min(speedIdx + 1, SPEEDS.length - 1);
    else if (ev.code === "ArrowLeft") speedIdx = Math.max(speedIdx - 1, 0);
    else if (ev.code === "Equal" || ev.code === "NumpadAdd") timeline.zoomStep(1.6);
    else if (ev.code === "Minus" || ev.code === "NumpadSubtract") timeline.zoomStep(1 / 1.6);
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

  const urlState = readUrlState();
  const pendingEventId = urlState.eventId;

  const data = await loadCoreData();
  periods = data.periods;
  currentMa = periods.length ? periods[0].start : 4500;
  if (urlState.ma != null) currentMa = Math.min(currentMa, Math.max(0, urlState.ma));

  timeline = new Timeline(els.timelineCanvas, periods);
  timeline.setEvents(allEvents); // empty for now; populated when events arrive
  timeline.onSeek((ma) => { currentMa = ma; });
  debouncedRefreshMapEvents = debounce(refreshMapEvents, 200);
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
  timeline.onHoverEvent((e) => {
    if (e) { showEventDetail(e); return; }
    // Hover ended -- fall back to whatever's actually selected (e.g. via
    // search or a shared link) instead of just blanking the panel because
    // the mouse drifted off a marker.
    showEventDetail(selectedEventId ? getEvent(allEvents, selectedEventId) : null);
  });

  mapView = new MapView(els.mapContainer);
  mapView.onSelect((e) => selectEvent(e));
  mapView.borders.onFeatureClick(({ name, year }) => {
    // Border-polygon clicks aren't part of the events dataset (no stable id
    // to encode in the URL), so show detail without touching selectedEventId.
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

  const initialModeId = urlState.modeId || (globeAvailable ? DEFAULT_GLOBE_MODE : DEFAULT_MAP_MODE);
  setMode(initialModeId);
  els.loadingOverlay.classList.add("hidden");
  requestAnimationFrame(tick);

  try {
    if (!pendingEventId && !localStorage.getItem(HELP_SEEN_KEY)) showHelp();
  } catch { /* localStorage unavailable (e.g. privacy mode) -- skip onboarding */ }

  // Events are not needed for the initial globe view (they only surface as
  // timeline markers below ~50,000 years of span and in map modes), so fetch
  // them in the background after the app is already interactive.
  loadEvents()
    .then((events) => {
      allEvents = events;
      // Precomputed once here rather than per-keystroke in runSearch() --
      // recomputing toLowerCase() for every event on every search debounce
      // tick was a measurable cost at ~24k events.
      for (const e of allEvents) e._titleLower = e.title.toLowerCase();
      // The timeline shows markers for every loaded category regardless of
      // the active mode/checkboxes -- category relevance to the *map* is
      // handled separately in refreshMapEvents()/currentModeCategories().
      timeline.setEvents(allEvents);
      if (MODE_BY_ID[activeModeId].kind === "map") refreshMapEvents();
      if (pendingEventId) {
        const e = getEvent(allEvents, pendingEventId);
        if (e) selectEvent(e, { flyTo: true });
      }
    })
    .catch((exc) => console.error("Failed to load events:", exc));
}

init().catch((exc) => {
  console.error(exc);
  const overlay = q("loading-overlay");
  if (overlay) overlay.textContent = "Failed to load Earth History Simulator data. See console for details.";
});
