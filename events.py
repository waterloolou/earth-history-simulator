"""
events.py -- Unified event schema for the Earth History Simulator.

Represents deep-time geological/biological content (wrapped, non-destructively,
from data.py/main.py) and discrete historical/scientific/cultural events (loaded
from data/events_seed.json and data/events_merged.json) through one interface.

This module is build-time only: it is imported by scripts/export_data.py and by
build_events.py, never by the browser at runtime (the web app only ever reads the
JSON these scripts produce).
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field, asdict

_HERE = os.path.dirname(os.path.abspath(__file__))
_DATA_DIR = os.path.join(_HERE, "data")

PRESENT_YEAR = 2026  # matches the Ma=0 convention already used by data.py


def ma_from_year(year: int, month: int | None = None, day: int | None = None) -> float:
    """Convert an astronomical year (negative = BCE) to Ma before present."""
    frac_year = year + (month or 1) / 12 + (day or 1) / 365
    return (PRESENT_YEAR - frac_year) / 1_000_000.0


@dataclass
class EventTime:
    ma: float                     # canonical coarse position, always set
    year: int | None = None       # astronomical year numbering; None for deep-time-only events
    month: int | None = None
    day: int | None = None
    end_ma: float | None = None   # optional duration (wars, reigns, geological periods)
    end_year: int | None = None
    precision: str = "ma"         # "era|period|epoch|ma|ka|millennium|century|decade|year|month|day"


@dataclass
class Place:
    lat: float | None = None
    lon: float | None = None
    region: str | None = None     # fallback label when there's no exact point


@dataclass
class WikiRef:
    title: str | None = None
    qid: str | None = None
    url: str | None = None


@dataclass
class Event:
    id: str
    title: str
    category: str          # "geological_period" | "tree_of_life" | "historical" | "scientific" | "cultural"
    subtype: str           # "battle" | "treaty" | "discovery" | "invention" | "birth" | "death" | "era" | "clade" | ...
    time: EventTime
    viz_mode: str           # "globe_deep_time" | "map" | "tol_overlay" | (future: "gallery" | "network_graph")
    place: Place | None = None
    description: str = ""
    image_url: str | None = None
    color: tuple | None = None
    wiki: WikiRef = field(default_factory=WikiRef)
    source: str = "seed"    # "seed" | "wikidata" | "geo_runtime"
    extra: dict = field(default_factory=dict)

    def to_json(self) -> dict:
        d = asdict(self)
        return d


# ── Adapters: wrap existing data.py / main.py structures, non-destructively ────

def periods_as_events() -> list[Event]:
    """Wrap data.PERIODS as Events. Does not modify data.py in any way."""
    from data import PERIODS

    out = []
    for p in PERIODS:
        out.append(Event(
            id=f"period-{p['name'].lower().replace(' ', '_')}",
            title=p["name"],
            category="geological_period",
            subtype="period",
            viz_mode="globe_deep_time",
            time=EventTime(ma=(p["start"] + p["end"]) / 2, end_ma=p["end"], precision="period"),
            description=p["event"],
            color=tuple(p["color"]),
            source="geo_runtime",
            extra={"eon": p["eon"], "era": p["era"], "start": p["start"], "end": p["end"],
                   "desc": p["desc"]},
        ))
    return out


def tol_as_events() -> list[Event]:
    """Wrap main._TOL_DATA (Tree of Life) as Events. Imports main lazily to avoid
    pulling in pygame/PIL/numpy for callers that only need geological data."""
    try:
        from main import _TOL_DATA
    except Exception:
        return []

    out = []
    for (nid, label, first_ma, parent_id, color, extinct_ma) in _TOL_DATA:
        out.append(Event(
            id=f"tol-{nid}",
            title=label,
            category="tree_of_life",
            subtype="clade",
            viz_mode="tol_overlay",
            time=EventTime(ma=first_ma,
                           end_ma=(extinct_ma if extinct_ma else None),
                           precision="ma"),
            color=tuple(color),
            source="geo_runtime",
            extra={"parent_id": parent_id, "extinct_ma": extinct_ma},
        ))
    return out


def diversity_as_series() -> list[tuple]:
    """Not an Event list (it's a continuous series) -- exposed for export_data.py."""
    from data import DIVERSITY
    return list(DIVERSITY)


# ── Loading discrete (historical/scientific/cultural) events from disk ─────────

def _load_json(path: str) -> list[dict]:
    if not os.path.exists(path):
        return []
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def _event_from_dict(d: dict) -> Event:
    t = d["time"]
    time = EventTime(
        ma=t.get("ma") if t.get("ma") is not None else ma_from_year(
            t.get("year", 0), t.get("month"), t.get("day")),
        year=t.get("year"), month=t.get("month"), day=t.get("day"),
        end_ma=t.get("end_ma"), end_year=t.get("end_year"),
        precision=t.get("precision", "year" if t.get("year") is not None else "ma"),
    )
    place = None
    if d.get("place"):
        p = d["place"]
        place = Place(lat=p.get("lat"), lon=p.get("lon"), region=p.get("region"))
    wiki = WikiRef(**d.get("wiki", {})) if d.get("wiki") else WikiRef()
    return Event(
        id=d["id"], title=d["title"], category=d["category"], subtype=d.get("subtype", ""),
        time=time, viz_mode=d.get("viz_mode", "map"), place=place,
        description=d.get("description", ""), image_url=d.get("image_url"),
        color=tuple(d["color"]) if d.get("color") else None,
        wiki=wiki, source=d.get("source", "seed"), extra=d.get("extra", {}),
    )


def load_discrete_events(merged: bool = True) -> list[Event]:
    """Load hand-curated (and, once available, Wikidata-merged) discrete events."""
    path = os.path.join(_DATA_DIR, "events_merged.json" if merged else "events_seed.json")
    if merged and not os.path.exists(path):
        path = os.path.join(_DATA_DIR, "events_seed.json")
    return [_event_from_dict(d) for d in _load_json(path)]


# ── Unified lookup helpers ──────────────────────────────────────────────────────

def all_events(include_tol: bool = True) -> list[Event]:
    evs = periods_as_events() + load_discrete_events()
    if include_tol:
        evs += tol_as_events()
    return evs


def get_events_in_range(lo_ma: float, hi_ma: float, categories: list[str] | None = None,
                         events: list[Event] | None = None) -> list[Event]:
    evs = events if events is not None else all_events()
    out = []
    for e in evs:
        if categories and e.category not in categories:
            continue
        if lo_ma <= e.time.ma <= hi_ma:
            out.append(e)
    return sorted(out, key=lambda e: e.time.ma, reverse=True)


def events_near(ma: float, window_ma: float, events: list[Event] | None = None) -> list[Event]:
    return get_events_in_range(ma - window_ma, ma + window_ma, events=events)


def get_event(event_id: str, events: list[Event] | None = None) -> Event | None:
    evs = events if events is not None else all_events()
    for e in evs:
        if e.id == event_id:
            return e
    return None


if __name__ == "__main__":
    periods = periods_as_events()
    tol = tol_as_events()
    discrete = load_discrete_events()
    print(f"periods_as_events(): {len(periods)} events")
    print(f"tol_as_events(): {len(tol)} events")
    print(f"load_discrete_events(): {len(discrete)} events")
    print("Sample period event:", periods[0].to_json() if periods else None)
    print("Sample discrete event:", discrete[0].to_json() if discrete else None)
