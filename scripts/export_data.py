#!/usr/bin/env python3
"""
scripts/export_data.py -- Dump data.py + events.py content to static JSON for the
web app (web/public/data/).

Run from the repo root:
    python scripts/export_data.py --out web/public/data

Has no network dependency as long as ne_land_110m.geojson already exists locally
(committed under web/public/textures/, and geo.py also checks the repo root copy).
"""

from __future__ import annotations

import argparse
import json
import os
import re
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


_QID_TITLE_RE = re.compile(r"^Q\d+$")


def export_events(out_dir: str):
    from events import periods_as_events, tol_as_events, load_discrete_events

    events = periods_as_events() + tol_as_events() + load_discrete_events()
    flat = []
    skipped = 0
    for e in events:
        # Drop discrete Wikidata items whose English label never resolved: their
        # title is a bare QID (e.g. "Q471407"), which is meaningless to a reader
        # on the timeline and map. Geological/tree-of-life adapters are exempt.
        if e.source == "wikidata" and (not e.title or _QID_TITLE_RE.match(e.title)):
            skipped += 1
            continue
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
    print(f"Wrote {path} ({len(flat)} events total"
          + (f", skipped {skipped} unlabeled QID-only events)" if skipped else ")"))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join(_ROOT, "web", "public", "data"))
    args = ap.parse_args()

    _ensure_ne_geojson_available()
    os.makedirs(args.out, exist_ok=True)

    export_periods(args.out)
    export_diversity(args.out)
    export_continents(args.out)
    export_tree_of_life(args.out)
    export_events(args.out)


if __name__ == "__main__":
    main()
