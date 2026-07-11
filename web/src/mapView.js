// mapView.js -- Leaflet-based historical/scientific event map.
// Leaflet (window.L) is loaded via classic <script> tags in index.html.

import { CATEGORY_COLOR, formatEventDate } from "./events.js";

function pinIcon(color) {
  return L.divIcon({
    className: "",
    html: `<div class="event-pin" style="width:14px;height:14px;background:${color}"></div>`,
    iconSize: [14, 14],
    iconAnchor: [7, 7],
  });
}

const ICONS = Object.fromEntries(
  Object.entries(CATEGORY_COLOR).map(([cat, color]) => [cat, pinIcon(color)])
);

export class MapView {
  constructor(containerEl) {
    this.container = containerEl;
    this.map = L.map(containerEl, { worldCopyJump: true }).setView([20, 10], 2);
    L.tileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png", {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
      maxZoom: 19,
    }).addTo(this.map);

    this.cluster = L.markerClusterGroup({ maxClusterRadius: 45 });
    this.map.addLayer(this.cluster);
    this._markersByEventId = new Map();
    this._onSelect = null;
  }

  onSelect(cb) { this._onSelect = cb; }

  invalidateSize() { this.map.invalidateSize(); }

  setEvents(events) {
    this.cluster.clearLayers();
    this._markersByEventId.clear();
    for (const e of events) {
      if (!e.place || e.place.lat == null || e.place.lon == null) continue;
      const icon = ICONS[e.category] || ICONS.historical;
      const marker = L.marker([e.place.lat, e.place.lon], { icon });
      const dateStr = formatEventDate(e.time);
      const wikiUrl = (e.wiki && e.wiki.url) || `https://en.wikipedia.org/wiki/${encodeURIComponent(e.title)}`;
      marker.bindPopup(
        `<div class="event-popup">
           <h3>${escapeHtml(e.title)}</h3>
           <div class="meta">${escapeHtml(dateStr)} &middot; ${escapeHtml(e.place.region || "")}</div>
           <p>${escapeHtml(e.description || "")}</p>
           <a href="${wikiUrl}" target="_blank" rel="noopener">Read more on Wikipedia &rarr;</a>
         </div>`
      );
      marker.on("click", () => { if (this._onSelect) this._onSelect(e); });
      this.cluster.addLayer(marker);
      this._markersByEventId.set(e.id, marker);
    }
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
