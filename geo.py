"""
geo.py -- Natural Earth 110m land data for modern continental configurations.

Downloads ne_land_110m.geojson once, then groups polygons by tectonic plate.
"""
import os
import json
import urllib.request

_HERE  = os.path.dirname(os.path.abspath(__file__))
_CACHE = os.path.join(_HERE, "ne_land_110m.geojson")
_NE_URL = (
    "https://raw.githubusercontent.com/nvkelso/"
    "natural-earth-vector/master/geojson/ne_110m_land.geojson"
)

PLATE_COLOR = {
    "north_america":  (100, 155, 78),
    "south_america":  (102, 158, 72),
    "europe":         (110, 158, 82),
    "africa":         (185, 152, 78),
    "eurasia":        (108, 152, 78),
    "india":          (168, 142, 72),
    "se_asia":        (100, 150, 70),
    "australia":      (192, 150, 72),
    "greenland":      (205, 225, 250),
    "antarctica":     (218, 235, 255),
    "other":          (100, 150, 75),
}

# Displacement (dx, dy in normalised 0-1) of each plate 65 Ma ago vs. modern.
# Positive dy = further south.  These are geologically reasonable approximations.
_OFFSET_65MA = {
    "north_america":  ( 0.005,  0.003),
    "south_america":  ( 0.010,  0.004),
    "europe":         (-0.003, -0.002),
    "africa":         ( 0.000,  0.006),
    "eurasia":        (-0.005, -0.003),
    "india":          ( 0.015, -0.088),   # was ~1600 km further south
    "se_asia":        (-0.004, -0.006),
    "australia":      ( 0.008, -0.070),   # was ~1200 km further south/west
    "greenland":      (-0.010,  0.000),
    "antarctica":     ( 0.000,  0.000),
    "other":          ( 0.000,  0.000),
}


def _poly_area(pts):
    n, a = len(pts), 0.0
    for i in range(n):
        j = (i + 1) % n
        a += pts[i][0] * pts[j][1] - pts[j][0] * pts[i][1]
    return abs(a) * 0.5


def _centroid(pts):
    n = len(pts)
    return sum(p[0] for p in pts) / n, sum(p[1] for p in pts) / n


def _assign_plate(pts):
    """Assign polygon to major plate via centroid lon/lat."""
    cx, cy = _centroid(pts)
    lon = cx * 360 - 180
    lat = 90  - cy * 180

    if lat < -57:
        return "antarctica"
    if 108 <= lon <= 162 and -46 <= lat <= -8:
        return "australia"
    if 62 <= lon <= 100 and 5 <= lat <= 40:
        return "india"
    if 90 <= lon and -12 <= lat <= 30:
        return "se_asia"
    if lon < -50:
        if lat > 56:
            return "greenland"
        if lat > 5:
            return "north_america"
        return "south_america"
    if -90 <= lon < -30 and lat < 12:
        return "south_america"
    if -20 <= lon <= 57 and lat < 42:
        return "africa"
    if lon > 25:
        return "eurasia"
    return "europe"


_ne_by_plate: dict | None = None


def _load_ne() -> dict:
    global _ne_by_plate
    if _ne_by_plate is not None:
        return _ne_by_plate

    if not os.path.exists(_CACHE):
        print("Downloading Natural Earth land data (one-time setup)…", flush=True)
        urllib.request.urlretrieve(_NE_URL, _CACHE)
        print("Done.")

    with open(_CACHE, encoding="utf-8") as fh:
        gj = json.load(fh)

    by_plate: dict = {k: [] for k in PLATE_COLOR}

    for feat in gj["features"]:
        geom = feat["geometry"]
        if geom["type"] == "Polygon":
            rings = [geom["coordinates"][0]]
        elif geom["type"] == "MultiPolygon":
            rings = [poly[0] for poly in geom["coordinates"]]
        else:
            continue

        for ring in rings:
            if len(ring) < 4:
                continue
            pts = [((lon + 180) / 360, (90 - lat) / 180) for lon, lat in ring]
            if _poly_area(pts) < 5e-6:   # drop sub-pixel islands
                continue
            plate = _assign_plate(pts)
            by_plate[plate].append(pts)

    _ne_by_plate = by_plate
    return by_plate


def get_modern_continents() -> list:
    """Continent dicts for 0 Ma using real Natural Earth coastline data."""
    by_plate = _load_ne()
    return [
        {"name": plate, "color": PLATE_COLOR[plate], "polys": polys}
        for plate, polys in by_plate.items()
        if polys
    ]


def get_65ma_continents() -> list:
    """Continent dicts for ~65 Ma: real shapes, small palaeographic displacements."""
    by_plate = _load_ne()
    result = []
    for plate, polys in by_plate.items():
        if not polys:
            continue
        dx, dy = _OFFSET_65MA.get(plate, (0, 0))
        shifted = [[(x + dx, y + dy) for x, y in poly] for poly in polys]
        result.append({"name": plate, "color": PLATE_COLOR[plate], "polys": shifted})
    return result
