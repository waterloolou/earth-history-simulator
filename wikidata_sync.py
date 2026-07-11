#!/usr/bin/env python3
"""
wikidata_sync.py -- One-time (manually-refreshed) sync of notable dated+geolocated
Wikidata items into data/wikidata_events.json, following geo.py's download-once-
and-cache pattern: never queried automatically, never run in CI, only via:

    python wikidata_sync.py --refresh                  # all categories
    python wikidata_sync.py --refresh --category battle  # just one category

Wikipedia sitelink count is used as the practical notability filter standing in
for "every Wikipedia page that could be modeled" -- see PLAN.md's Wikidata
ingestion section for the rationale. Each category has its own SITELINK_MIN
threshold (humans need a much higher bar than e.g. battles, since they vastly
outnumber every other category of dated/geolocated Wikidata item).
"""

from __future__ import annotations

import argparse
import json
import os
import re
import time
import urllib.parse
import urllib.request

_HERE = os.path.dirname(os.path.abspath(__file__))
_OUT_PATH = os.path.join(_HERE, "data", "wikidata_events.json")

_SPARQL_URL = "https://query.wikidata.org/sparql"
_USER_AGENT = "EarthHistorySimulatorBot/1.0 (https://github.com/waterloolou/earth-history-simulator)"

PAGE_SIZE = 500
MAX_PAGES_PER_CATEGORY = 20   # safety cap: up to 10,000 items per category
REQUEST_DELAY_S = 1.0        # be polite to WDQS between paged queries

# category -> (Wikidata class QID(s) to match via P31/P279*, date property,
#              subtype label, minimum Wikipedia sitelink count)
CATEGORIES = {
    "battle": {
        "category": "historical", "subtype": "battle",
        "class_qids": ["wd:Q178561"], "date_prop": "wdt:P585",
        "sitelink_min": 5,
    },
    "treaty": {
        "category": "historical", "subtype": "treaty",
        "class_qids": ["wd:Q131569"], "date_prop": "wdt:P585",
        "sitelink_min": 4,
    },
    "disaster": {
        "category": "historical", "subtype": "disaster",
        "class_qids": ["wd:Q3839081"], "date_prop": "wdt:P585",
        "sitelink_min": 5,
    },
    # Discoveries/inventions aren't consistently modeled under a single
    # instance-of class in Wikidata (a "discovery event" entity type doesn't
    # exist the way "battle" or "treaty" do) -- P575 "time of discovery or
    # invention" is set directly on the discovered/invented thing's own item,
    # so its mere presence is the class signal here; class_qids is empty.
    "discovery": {
        "category": "scientific", "subtype": "discovery",
        "class_qids": [], "date_prop": "wdt:P575",
        "sitelink_min": 15,
    },
}

_COORD_RE = re.compile(r"Point\(([-\d.]+)\s+([-\d.]+)\)")


_DATE_PROP_PID = {"wdt:P585": "P585", "wdt:P575": "P575"}


def _build_query(spec: dict, offset: int) -> str:
    class_union = " UNION ".join(
        f"{{ ?item wdt:P31/wdt:P279* {qid} . }}" for qid in spec["class_qids"]
    ) if spec["class_qids"] else ""
    pid = _DATE_PROP_PID[spec["date_prop"]]
    # Query through the full statement node (p:/psv:) rather than the simple
    # wdt: shortcut so we get wikibase:timePrecision alongside the date value --
    # otherwise low-precision Wikidata dates (e.g. "just a year") come back
    # padded to January 1st with no signal that day/month aren't meaningful,
    # which would silently overstate the precision of ancient/approximate events.
    return f"""
    SELECT ?item ?itemLabel ?date ?datePrecision ?coord ?image ?sitelinks ?article WHERE {{
      {class_union}
      ?item p:{pid} ?dateStatement .
      ?dateStatement psv:{pid} ?dateNode .
      ?dateNode wikibase:timeValue ?date .
      ?dateNode wikibase:timePrecision ?datePrecision .
      OPTIONAL {{ ?item wdt:P625 ?coord . }}
      OPTIONAL {{ ?item wdt:P18 ?image . }}
      ?item wikibase:sitelinks ?sitelinks .
      FILTER(?sitelinks >= {spec['sitelink_min']})
      OPTIONAL {{
        ?article schema:about ?item ;
                 schema:isPartOf <https://en.wikipedia.org/> .
      }}
      SERVICE wikibase:label {{ bd:serviceParam wikibase:language "en". }}
    }}
    ORDER BY ?date
    LIMIT {PAGE_SIZE} OFFSET {offset}
    """


# Wikidata time precision codes -> our precision labels.
# https://www.wikidata.org/wiki/Help:Dates#Precision
_PRECISION_MAP = {
    11: "day", 10: "month", 9: "year", 8: "decade", 7: "century", 6: "millennium",
}


def _precision_label(code: int) -> str:
    if code >= 11:
        return "day"
    return _PRECISION_MAP.get(code, "era")


def _run_query(query: str) -> dict:
    url = f"{_SPARQL_URL}?{urllib.parse.urlencode({'query': query, 'format': 'json'})}"
    req = urllib.request.Request(url, headers={
        "Accept": "application/sparql-results+json",
        "User-Agent": _USER_AGENT,
    })
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _parse_date(date_str: str) -> tuple[int | None, int | None, int | None]:
    """Wikidata date literals look like '1815-06-18T00:00:00Z' (or just a year
    for low-precision dates); BCE dates use a leading '-'."""
    m = re.match(r"^(-?\d+)-(\d{2})-(\d{2})", date_str)
    if not m:
        return None, None, None
    year, month, day = int(m.group(1)), int(m.group(2)), int(m.group(3))
    if month == 0:
        month = None
    if day == 0:
        day = None
    return year, month, day


def _ma_from_year(year: int) -> float:
    return (2026 - year) / 1_000_000.0


def sync_category(name: str, spec: dict) -> list[dict]:
    print(f"Syncing category '{name}' (sitelinks >= {spec['sitelink_min']})...")
    events: list[dict] = []
    seen_qids: set[str] = set()

    for page in range(MAX_PAGES_PER_CATEGORY):
        offset = page * PAGE_SIZE
        query = _build_query(spec, offset)
        try:
            data = _run_query(query)
        except Exception as exc:
            print(f"  Query failed at offset {offset}: {exc}")
            break

        bindings = data.get("results", {}).get("bindings", [])
        if not bindings:
            break

        for b in bindings:
            qid = b["item"]["value"].rsplit("/", 1)[-1]
            if qid in seen_qids:
                continue
            seen_qids.add(qid)

            title = b.get("itemLabel", {}).get("value", qid)
            # Skip items whose English label never resolved: the label service
            # falls back to the bare QID (e.g. "Q471407"), which is meaningless
            # on the timeline/map. (Wikipedia sitelink count can be met by
            # non-English wikis alone, so unlabeled items do slip through.)
            if re.fullmatch(r"Q\d+", title):
                continue
            year, month, day = _parse_date(b["date"]["value"]) if "date" in b else (None, None, None)
            if year is None:
                continue
            precision = _precision_label(int(b["datePrecision"]["value"])) if "datePrecision" in b else "year"
            # Wikidata pads unknown components to 01 (e.g. a month-precision date
            # comes back as YYYY-MM-01). Drop the padded components so we never
            # overstate precision: keep month only for month/day precision, and
            # keep day only for day precision. (These two conditions were
            # previously swapped, which nulled the real month on month-precision
            # events while keeping the meaningless padded day=1.)
            if precision not in ("day", "month"):
                month = None
            if precision != "day":
                day = None

            place = None
            if "coord" in b:
                m = _COORD_RE.match(b["coord"]["value"])
                if m:
                    lon, lat = float(m.group(1)), float(m.group(2))
                    place = {"lat": lat, "lon": lon, "region": None}

            wiki_url = b.get("article", {}).get("value")

            events.append({
                "id": f"wd-{qid.lower()}",
                "title": title,
                "category": spec["category"],
                "subtype": spec["subtype"],
                "viz_mode": "map",
                "time": {
                    "year": year, "month": month, "day": day,
                    "ma": _ma_from_year(year),
                    "precision": precision,
                },
                "place": place,
                "description": "",
                "image_url": b.get("image", {}).get("value"),
                "color": None,
                "wiki": {"title": title, "qid": qid, "url": wiki_url},
                "source": "wikidata",
                "extra": {"sitelinks": int(b["sitelinks"]["value"])},
            })

        print(f"  page {page}: +{len(bindings)} rows ({len(events)} total so far)")
        if len(bindings) < PAGE_SIZE:
            break
        time.sleep(REQUEST_DELAY_S)

    print(f"  -> {len(events)} events for '{name}'")
    return events


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--refresh", action="store_true", required=True,
                     help="Confirm you intend to hit the live Wikidata SPARQL endpoint.")
    ap.add_argument("--category", choices=sorted(CATEGORIES), default=None,
                     help="Sync only this category (default: all).")
    ap.add_argument("--out", default=_OUT_PATH)
    args = ap.parse_args()

    names = [args.category] if args.category else list(CATEGORIES)
    all_events: list[dict] = []

    # Merge with whatever is already on disk for categories not being refreshed
    # this run, so `--category X` doesn't clobber previously-synced categories.
    existing: list[dict] = []
    if os.path.exists(args.out):
        with open(args.out, encoding="utf-8") as fh:
            existing = json.load(fh)
    kept = [e for e in existing if e.get("subtype") not in
            {CATEGORIES[n]["subtype"] for n in names}]
    all_events.extend(kept)

    for name in names:
        all_events.extend(sync_category(name, CATEGORIES[name]))

    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(all_events, fh, indent=1)
    print(f"\nWrote {args.out} ({len(all_events)} events total)")


if __name__ == "__main__":
    main()
