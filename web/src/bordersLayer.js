// bordersLayer.js -- "Nations & Borders" mode: renders the nearest available
// historical political-border snapshot (see borders_sync.py /
// web/public/borders/) as a Leaflet GeoJSON layer, swapping to a new
// snapshot as the timeline crosses into a different keyframe's nearest-year
// window. Borders are shown as-of the nearest snapshot year rather than
// smoothly morphed between keyframes -- real border topology changes
// constantly (countries appear, merge, split), so there's no well-defined
// continuous interpolation the way there is for continent polygons; a
// keyframe swap is the same honest approach main.py's Scotese blending used
// for paleogeography before this app's globe-rendering unification, just
// without the crossfade (a hard swap reads more clearly for borders, where a
// blended in-between shape would be actively misleading).

// GPL-3.0 credit for the historical-basemaps border data (see
// web/public/borders/ATTRIBUTION.md). Shown in Leaflet's attribution control
// only while this mode is active, added/removed explicitly in show()/hide()
// (a layer-level `attribution` option is not reliably surfaced for a GeoJSON
// group, so we drive the control directly instead).
const BORDERS_ATTRIBUTION =
  'Borders: <a href="https://github.com/aourednik/historical-basemaps" target="_blank" rel="noopener">historical-basemaps</a> (GPL-3.0)';

function hashColor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  const hue = Math.abs(h) % 360;
  return `hsl(${hue}, 55%, 55%)`;
}

export class BordersLayer {
  constructor(leafletMap, bordersBase = "public/borders") {
    this.map = leafletMap;
    this.bordersBase = bordersBase;
    this.manifest = null;
    this.layer = null;
    this.visible = false;
    this._geojsonCache = new Map(); // year -> geojson
    this._pendingYear = null;
    this._currentYear = null;
    this._onFeatureClick = null;
  }

  onFeatureClick(cb) { this._onFeatureClick = cb; }

  async _loadManifest() {
    if (this.manifest) return this.manifest;
    const res = await fetch(`${this.bordersBase}/manifest.json`);
    this.manifest = await res.json(); // [{year, file, features}], sorted ascending
    return this.manifest;
  }

  _nearestSnapshot(year) {
    const m = this.manifest;
    if (!m || !m.length) return null;
    if (year <= m[0].year) return m[0];
    if (year >= m[m.length - 1].year) return m[m.length - 1];
    // binary search for the closest entry
    let lo = 0, hi = m.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (m[mid].year <= year) lo = mid; else hi = mid;
    }
    return (year - m[lo].year <= m[hi].year - year) ? m[lo] : m[hi];
  }

  async _getGeojson(year) {
    const snap = this._nearestSnapshot(year);
    if (!snap) return null;
    // Cache is keyed by snapshot year (not the raw query year), and every
    // return goes through the same {gj, snapYear} shape -- an earlier version
    // checked the cache with the raw `year` while storing under `snap.year`,
    // so a rare exact-year hit returned the bare geojson instead of the wrapper
    // and setYear() then rendered nothing / lost the current-year label.
    if (this._geojsonCache.has(snap.year)) {
      return { gj: this._geojsonCache.get(snap.year), snapYear: snap.year };
    }
    const res = await fetch(`${this.bordersBase}/${snap.file}`);
    const gj = await res.json();
    this._geojsonCache.set(snap.year, gj);
    if (this._geojsonCache.size > 12) {
      this._geojsonCache.delete(this._geojsonCache.keys().next().value);
    }
    return { gj, snapYear: snap.year };
  }

  style(feature) {
    const name = feature.properties.NAME || feature.properties.SUBJECTO || "?";
    return {
      color: "rgba(255,255,255,0.55)",
      weight: 1,
      fillColor: hashColor(name),
      fillOpacity: 0.45,
    };
  }

  /** Update to the nearest snapshot for `year`. Cheap no-op if already
   * showing that snapshot (avoids rebuilding the Leaflet layer every frame
   * while playback is running). */
  async setYear(year) {
    await this._loadManifest();
    const snap = this._nearestSnapshot(year);
    if (!snap || snap.year === this._currentYear) return;
    if (this._pendingYear === snap.year) return; // already loading this one
    this._pendingYear = snap.year;

    const result = await this._getGeojson(year);
    if (!result || this._pendingYear !== snap.year) return; // superseded by a newer request
    this._pendingYear = null;
    this._currentYear = result.snapYear;

    if (this.layer) this.map.removeLayer(this.layer);
    this.layer = L.geoJSON(result.gj, {
      style: (f) => this.style(f),
      onEachFeature: (feature, lyr) => {
        const name = feature.properties.NAME || feature.properties.SUBJECTO || "Unknown";
        lyr.bindTooltip(name, { sticky: true });
        lyr.on("click", () => {
          if (this._onFeatureClick) this._onFeatureClick({ name, year: result.snapYear, properties: feature.properties });
        });
      },
    });
    if (this.visible) this.layer.addTo(this.map);
  }

  show() {
    if (this.visible) return;
    this.visible = true;
    if (this.map.attributionControl) this.map.attributionControl.addAttribution(BORDERS_ATTRIBUTION);
    if (this.layer && !this.map.hasLayer(this.layer)) this.layer.addTo(this.map);
  }

  hide() {
    if (!this.visible) return;
    this.visible = false;
    if (this.map.attributionControl) this.map.attributionControl.removeAttribution(BORDERS_ATTRIBUTION);
    if (this.layer && this.map.hasLayer(this.layer)) this.map.removeLayer(this.layer);
  }

  currentYearLabel() {
    if (this._currentYear == null) return "";
    return this._currentYear < 0 ? `${-this._currentYear} BCE` : `${this._currentYear} CE`;
  }
}
