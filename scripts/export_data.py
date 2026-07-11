#!/usr/bin/env python3
"""
scripts/export_data.py -- Dump data.py + events.py content to static JSON for the
web app (web/public/data/). Also generates the plate-drift offset texture used by
the browser globe's displacement shader.

Run from the repo root:
    python scripts/export_data.py --out web/public/data

Has no network dependency as long as ne_land_110m.geojson already exists locally
(committed under web/public/textures/, and geo.py also checks the repo root copy).
"""

from __future__ import annotations

import argparse
import json
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(_HERE)
sys.path.insert(0, _ROOT)


def _ensure_ne_geojson_available():
    """geo.py caches ne_land_110m.geojson at the repo root; if it's missing but
    the committed web copy exists, seed it from there so _init_geo() doesn't need
    a network fetch during CI."""
    root_path = os.path.join(_ROOT, "ne_land_110m.geojson")
    web_copy = os.path.join(_ROOT, "web", "public", "textures", "ne_land_110m.geojson")
    if not os.path.exists(root_path) and os.path.exists(web_copy):
        import shutil
        shutil.copyfile(web_copy, root_path)


def export_periods(out_dir: str):
    from data import PERIODS
    path = os.path.join(out_dir, "periods.json")
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(PERIODS, fh)
    print(f"Wrote {path} ({len(PERIODS)} periods)")


def export_diversity(out_dir: str):
    from data import DIVERSITY, MAX_DIVERSITY
    path = os.path.join(out_dir, "diversity.json")
    with open(path, "w", encoding="utf-8") as fh:
        json.dump({"points": DIVERSITY, "max": MAX_DIVERSITY}, fh)
    print(f"Wrote {path} ({len(DIVERSITY)} points)")


def export_continents(out_dir: str):
    from data import CONTINENTAL_SNAPSHOTS, SNAPSHOT_TIMES
    # Continent dicts already contain only JSON-safe types (str/tuple/list/float)
    # except colors, which are tuples -> lists for JSON.
    snapshots = {}
    for ma, conts in CONTINENTAL_SNAPSHOTS.items():
        snapshots[str(ma)] = [
            {"name": c["name"], "color": list(c["color"]), "polys": c["polys"]}
            for c in (conts or [])
        ]
    path = os.path.join(out_dir, "continents.json")
    with open(path, "w", encoding="utf-8") as fh:
        json.dump({"snapshot_times": SNAPSHOT_TIMES, "snapshots": snapshots}, fh)
    print(f"Wrote {path} ({len(snapshots)} snapshot keyframes)")


def export_tree_of_life(out_dir: str):
    # main.py calls pygame.display.set_mode() at import time, which needs a video
    # driver; CI runners (and this script run headless) have no real display, so
    # force SDL's no-op dummy driver before importing.
    os.environ.setdefault("SDL_VIDEODRIVER", "dummy")
    os.environ.setdefault("SDL_AUDIODRIVER", "dummy")
    try:
        from main import _TOL_DATA
    except Exception as exc:
        print(f"Skipping tree-of-life export (main.py import failed: {exc})")
        return
    data = [
        {"id": nid, "label": label, "first_ma": first_ma, "parent_id": parent_id,
         "color": list(color), "extinct_ma": extinct_ma}
        for (nid, label, first_ma, parent_id, color, extinct_ma) in _TOL_DATA
    ]
    path = os.path.join(out_dir, "tree_of_life.json")
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(data, fh)
    print(f"Wrote {path} ({len(data)} clades)")


def export_events(out_dir: str):
    from events import periods_as_events, tol_as_events, load_discrete_events

    events = periods_as_events() + tol_as_events() + load_discrete_events()
    flat = []
    for e in events:
        flat.append({
            "id": e.id, "title": e.title, "category": e.category, "subtype": e.subtype,
            "viz_mode": e.viz_mode,
            "time": {"ma": e.time.ma, "year": e.time.year, "month": e.time.month,
                     "day": e.time.day, "end_ma": e.time.end_ma,
                     "end_year": e.time.end_year, "precision": e.time.precision},
            "place": ({"lat": e.place.lat, "lon": e.place.lon, "region": e.place.region}
                      if e.place else None),
            "description": e.description,
            "image_url": e.image_url,
            "color": list(e.color) if e.color else None,
            "wiki": {"title": e.wiki.title, "qid": e.wiki.qid, "url": e.wiki.url},
            "source": e.source,
            "extra": e.extra,
        })
    path = os.path.join(out_dir, "events.json")
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(flat, fh)
    print(f"Wrote {path} ({len(flat)} events total)")


def export_plate_offset_texture(out_textures_dir: str, size: int = 180):
    """Encode geo._OFFSET_65MA as a small RG8 PNG the browser globe's plate-drift
    displacement shader can sample: R/G channels store dx/dy scaled+biased into
    [0, 255] (encoded = offset*4.0 + 0.5, i.e. matches the decode in the shader:
    (texel/255 - 0.5) / 4.0), one plate region per pixel via the same lat/lon
    threshold rules used by main.py's _init_blue_marble()."""
    import numpy as np
    from PIL import Image
    from geo import _OFFSET_65MA

    # endpoint=False: -180 and +180 are the same meridian, so the array must
    # not include both as separate columns or the texture won't tile cleanly
    # at the antimeridian seam (u=0/u=1 boundary on the sphere).
    w, h = size * 2, size
    lon = np.linspace(-180.0, 180.0, w, endpoint=False, dtype=np.float32)
    lat = np.linspace(90.0, -90.0, h, dtype=np.float32)
    lon2, lat2 = np.meshgrid(lon, lat)

    dx = np.zeros((h, w), dtype=np.float32)
    dy = np.zeros((h, w), dtype=np.float32)

    def apply(mask, plate):
        pdx, pdy = _OFFSET_65MA.get(plate, (0.0, 0.0))
        dx[mask] = pdx
        dy[mask] = pdy

    # Lowest -> highest priority, matching main.py's _init_blue_marble() exactly.
    apply(lon2 > 25, "eurasia")
    apply((lon2 >= -20) & (lon2 <= 57) & (lat2 < 42), "africa")
    apply(((lon2 >= -90) & (lon2 < -30) & (lat2 < 12)) | ((lon2 < -50) & (lat2 <= 5)),
          "south_america")
    apply((lon2 < -50) & (lat2 > 5) & (lat2 <= 56), "north_america")
    apply((lon2 < -50) & (lat2 > 56), "greenland")
    apply((lon2 >= 90) & (lat2 >= -12) & (lat2 <= 30), "se_asia")
    apply((lon2 >= 62) & (lon2 <= 100) & (lat2 >= 5) & (lat2 <= 40), "india")
    apply((lon2 >= 108) & (lon2 <= 162) & (lat2 >= -46) & (lat2 <= -8), "australia")
    apply(lat2 < -57, "antarctica")

    # Encode: value*4.0 + 0.5 clamps offsets in roughly [-0.125, 0.125] normalised
    # coords to [0, 1] before quantizing to 8 bits -- generous given the largest
    # _OFFSET_65MA magnitude (India's -0.088) fits comfortably inside that range.
    r = np.clip(dx * 4.0 + 0.5, 0, 1) * 255
    g = np.clip(dy * 4.0 + 0.5, 0, 1) * 255
    b = np.zeros_like(r)
    a = np.full_like(r, 255)
    rgba = np.stack([r, g, b, a], axis=-1).astype(np.uint8)

    os.makedirs(out_textures_dir, exist_ok=True)
    path = os.path.join(out_textures_dir, "plate_offset.png")
    Image.fromarray(rgba, "RGBA").save(path)
    print(f"Wrote {path} ({w}x{h})")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join(_ROOT, "web", "public", "data"))
    ap.add_argument("--textures-out", default=os.path.join(_ROOT, "web", "public", "textures"))
    args = ap.parse_args()

    _ensure_ne_geojson_available()
    os.makedirs(args.out, exist_ok=True)

    export_periods(args.out)
    export_diversity(args.out)
    export_continents(args.out)
    export_tree_of_life(args.out)
    export_events(args.out)
    export_plate_offset_texture(args.textures_out)


if __name__ == "__main__":
    main()
