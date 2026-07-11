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
    this.map = L.map(containerEl, { worldCopyJump: true }).setView([20, 10], 2);
    L.tileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png", {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
      maxZoom: 19,
    }).addTo(this.map);

    // chunkedLoading spreads large marker inserts across animation frames so
    // setEvents() never blocks the main thread for a full second on the ~6.9k
    // geolocated events (see addLayers bulk insert below).
    this.cluster = L.markerClusterGroup({ maxClusterRadius: 45, chunkedLoading: true });
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
    if (visible) { if (!this.map.hasLayer(this.cluster)) this.map.addLayer(this.cluster); }
    else { if (this.map.hasLayer(this.cluster)) this.map.removeLayer(this.cluster); }
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
    // chunkedLoading, yields to the event loop between chunks.
    this.cluster.addLayers(markers);
  }

  _popupHtml(e) {
    const dateStr = formatEventDate(e.time);
    const wikiUrl = (e.wiki && e.wiki.url) || `https://en.wikipedia.org/wiki/${encodeURIComponent(e.title)}`;
    return `<div class="event-popup">
       <h3>${escapeHtml(e.title)}</h3>
       <div class="meta">${escapeHtml(dateStr)} &middot; ${escapeHtml(e.place.region || "")}</div>
       <p>${escapeHtml(e.description || "")}</p>
       <a href="${wikiUrl}" target="_blank" rel="noopener">Read more on Wikipedia &rarr;</a>
     </div>`;
  }

  focusOnYearRange(loYear, hiYear) {
    // Placeholder hook for future in-page year-range filtering UI.
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}
