// mapView.js -- Leaflet-based historical/scientific event map.
// Leaflet (window.L) is loaded via classic <script> tags in index.html.

import { CATEGORY_COLOR, formatEventDate } from "./events.js";
import { BordersLayer } from "./bordersLayer.js";

function pinIcon(color, category) {
  return L.divIcon({
    className: "",
    // role/aria-label give screen readers a meaningful pin instead of an empty
    // colored div; the category name also disambiguates the color coding for
    // colorblind users who can't distinguish the pin hues alone.
    html: `<div class="event-pin" role="img" aria-label="${category} event" title="${category} event" style="width:14px;height:14px;background:${color}"></div>`,
    iconSize: [14, 14],
    iconAnchor: [7, 7],
  });
}

const ICONS = Object.fromEntries(
  Object.entries(CATEGORY_COLOR).map(([cat, color]) => [cat, pinIcon(color, cat)])
);

export class MapView {
  constructor(containerEl) {
    this.container = containerEl;
    // minZoom: 2 -- prevents zooming out past a single world view (below
    // zoom 2 the tile layer starts showing mostly empty space/repeated
    // copies rather than anything more useful). worldCopyJump still allows
    // continuous horizontal panning/wrapping at that zoom, so this only
    // stops "zooming out past the map", not east-west panning.
    this.map = L.map(containerEl, { worldCopyJump: true, minZoom: 2 }).setView([20, 10], 2);
    L.tileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png", {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
      maxZoom: 19,
      minZoom: 2,
    }).addTo(this.map);

    // Settling state must exist before the cluster is constructed/attached
    // below: attaching an empty cluster to an already-ready map fires its
    // chunkProgress synchronously (an empty addLayers() batch still reports
    // 0/0 "done"), which reaches _finishSettle() before the constructor
    // would otherwise get around to initializing these fields.
    this._settling = false;
    this._onSettled = [];
    this._queuedEvents = null;

    // chunkedLoading spreads large marker inserts across animation frames so
    // setEvents() never blocks the main thread for a full second on the now
    // ~23.8k geolocated events (see addLayers bulk insert below). chunkInterval
    // caps how long each chunk runs before yielding: markercluster defaults to
    // 200ms, which on the grown "All Events"/"World History"/"People" sets
    // produced measured ~200-300ms main-thread freezes on mode entry. 50ms
    // keeps each yielded chunk near a single frame's budget so entering a large
    // map mode stays responsive instead of hitching for a third of a second.
    this.cluster = L.markerClusterGroup({
      maxClusterRadius: 45,
      chunkedLoading: true,
      chunkInterval: 50,
      // chunkProgress is the *only* completion signal addLayers()'s chunked
      // insert exposes in this library version -- there is no "chunkend"
      // event (leaflet.markercluster@1.5.3 fires none). It's called once per
      // chunk of *any* addLayers() call on this cluster, with processed ===
      // total on the final chunk, which _finishSettle() below treats as
      // "the most recent setEvents() batch has fully landed".
      chunkProgress: (processed, total) => {
        if (processed === total) this._finishSettle();
      },
    });
    this.map.addLayer(this.cluster);
    this._markersByEventId = new Map();
    this._onSelect = null;

    this.borders = new BordersLayer(this.map);
  }

  onSelect(cb) { this._onSelect = cb; }

  invalidateSize() { this.map.invalidateSize(); }

  /** Show/hide the event-pin cluster layer (the "Nations & Borders" mode
   * hides pins entirely so the border polygons aren't obscured/competing). */
  setPinsVisible(visible) {
    if (visible) { if (!this.map.hasLayer(this.cluster)) this.map.addLayer(this.cluster); return; }
    // Removing the cluster layer detaches its map reference. If a chunked
    // addLayers() batch is still running at that moment (leaflet.markercluster
    // has no way to cancel one), its next scheduled chunk throws trying to use
    // that now-null map reference. Defer the removal until settled instead --
    // a no-op wait in the (overwhelmingly common) already-settled case.
    this.whenSettled(() => {
      if (this.map.hasLayer(this.cluster)) this.map.removeLayer(this.cluster);
    });
  }

  setBordersVisible(visible) {
    if (visible) this.borders.show(); else this.borders.hide();
  }

  /** Update the borders layer to the nearest available year, if it's
   * currently visible. Safe/cheap to call every frame -- setYear() itself
   * no-ops once the nearest snapshot hasn't changed. */
  setBordersYear(year) {
    if (this.borders.visible) this.borders.setYear(year);
  }

  setEvents(events) {
    if (this._settling) {
      // A previous chunked insert is still running. leaflet.markercluster
      // has no way to cancel an in-flight addLayers() -- its chunk loop
      // keeps going via its own setTimeout chain regardless of clearLayers(),
      // and calling clearLayers() again here (starting a second overlapping
      // batch) can leave the *first* batch's stale continuation touching a
      // cluster/map reference that's since changed, throwing deep inside the
      // library. So instead of rebuilding immediately, queue this call to
      // start once the current one actually finishes (last-write-wins if
      // setEvents() is called again before that happens).
      const alreadyQueued = this._queuedEvents !== null;
      this._queuedEvents = events;
      if (!alreadyQueued) {
        this.whenSettled(() => {
          const next = this._queuedEvents;
          this._queuedEvents = null;
          this._applyEvents(next);
        });
      }
      return;
    }
    this._applyEvents(events);
  }

  _applyEvents(events) {
    this.cluster.clearLayers();
    this._markersByEventId.clear();
    const markers = [];
    for (const e of events) {
      if (!e.place || e.place.lat == null || e.place.lon == null) continue;
      const icon = ICONS[e.category] || ICONS.historical;
      // keyboard:true (Leaflet default) makes the marker Tab-focusable; alt gives
      // it an accessible name announced on focus.
      const marker = L.marker([e.place.lat, e.place.lon], { icon, keyboard: true, alt: e.title });
      // Popup HTML is built lazily on first open (not up front for every marker):
      // for ~12k markers, eagerly building/escaping every popup string is pure
      // waste since almost none are ever opened.
      marker.bindPopup(() => this._popupHtml(e));
      marker.on("click", () => { if (this._onSelect) this._onSelect(e); });
      markers.push(marker);
      this._markersByEventId.set(e.id, marker);
    }
    // Bulk insert -- markercluster's addLayers is dramatically faster than
    // repeated addLayer (which re-clusters on every call) and, with
    // chunkedLoading, yields to the event loop between chunks. That yielding
    // means addLayers() returns well before every marker has actually landed
    // in the cluster's spatial index for a large set -- _settling/whenSettled
    // below let focusEvent() wait for that real completion (via the
    // chunkProgress option above) instead of assuming this call was synchronous.
    this._settling = true;
    this.cluster.addLayers(markers);
    // An empty batch never enters addLayers' chunk loop at all (nothing to
    // iterate), so chunkProgress never fires for it -- resolve immediately.
    if (markers.length === 0) this._finishSettle();
  }

  _finishSettle() {
    this._settling = false;
    const callbacks = this._onSettled;
    this._onSettled = [];
    if (callbacks.length) {
      // Deferred to the next tick: leaflet.markercluster's addLayers() calls
      // chunkProgress (which reaches here) *before* it recalculates the
      // completed batch's cluster bounds and attaches children to the map
      // (both still to come, synchronously, right after chunkProgress
      // returns -- see its source). Calling zoomToShowLayer synchronously
      // from here would run against not-yet-finalized bounds and throw.
      setTimeout(() => callbacks.forEach((cb) => cb()), 0);
    }
  }

  /** Run cb once the marker layer from the most recent setEvents() call has
   * fully landed in the cluster (see the chunkedLoading note above) --
   * required before focusEvent()'s zoomToShowLayer can reliably locate a
   * marker/cluster and compute valid bounds. A list (not a single slot)
   * because a queued setEvents() call (see above) and a pending focusEvent()
   * can both legitimately be waiting on the same completion at once. */
  whenSettled(cb) {
    if (!this._settling) { cb(); return; }
    this._onSettled.push(cb);
  }

  _popupHtml(e) {
    const dateStr = formatEventDate(e.time);
    const wikiUrl = (e.wiki && e.wiki.url) || `https://en.wikipedia.org/wiki/${encodeURIComponent(e.title)}`;
    // Date first (as a small "kicker" above the title), not buried in the
    // meta line below it -- the date is usually the first thing a reader
    // wants to orient on, especially skimming a cluster of pins.
    return `<div class="event-popup">
       ${e.image_url ? `<img class="popup-thumb" src="${escapeHtml(e.image_url)}" alt="" loading="lazy" onerror="this.remove()" />` : ""}
       <div class="date-kicker">${escapeHtml(dateStr)}</div>
       <h3>${escapeHtml(e.title)}</h3>
       ${e.place.region ? `<div class="meta">${escapeHtml(e.place.region)}</div>` : ""}
       <p>${escapeHtml(e.description || "")}</p>
       <a href="${wikiUrl}" target="_blank" rel="noopener">Read more on Wikipedia &rarr;</a>
     </div>`;
  }

  /** Pan/zoom to a specific event's marker and open its popup -- used by the
   * event search box and by shared-link event focus. zoomToShowLayer handles
   * the case where the marker is currently absorbed into a cluster at the
   * map's current zoom level, spiderifying/zooming as needed before the
   * popup can actually open. */
  focusEvent(e) {
    if (!e.place || e.place.lat == null || e.place.lon == null) return;
    const panOnly = () => this.map.setView([e.place.lat, e.place.lon], Math.max(this.map.getZoom(), 6));
    this.whenSettled(() => {
      const marker = this._markersByEventId.get(e.id);
      // chunkProgress (see the constructor) is shared across every
      // addLayers() call on this cluster, not scoped to the one setEvents()
      // queued this focus for, and can itself fire synchronously/reentrantly
      // when a batch happens to finish within a single chunk -- so even with
      // hasLayer() as a further check, there's no fully watertight way (with
      // what this library exposes) to guarantee the specific cluster node
      // this marker belongs to has finalized bounds at this exact moment.
      // Fall back to a plain pan rather than let an internal library
      // exception reach the page if that rare interleaving happens.
      if (!marker || !this.cluster.hasLayer(marker)) { panOnly(); return; }
      try {
        this.cluster.zoomToShowLayer(marker, () => marker.openPopup());
      } catch (exc) {
        console.warn("MapView.focusEvent: zoomToShowLayer failed, falling back to a plain pan", exc);
        panOnly();
      }
    });
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}
