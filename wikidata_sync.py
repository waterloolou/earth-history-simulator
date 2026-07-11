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
    # People vastly outnumber every other category on Wikidata (~10M+ humans
    # have a birth date) -- a FILTER(?sitelinks >= N) threshold times out at
    # that scale no matter what else is joined against it (tested extensively;
    # even a 1-year wdt:P569 date-range filter alone still hit WDQS's timeout
    # once the sitelinks range filter was added). Restricting to specific
    # notable-achievement classes first (Nobel laureates, Fields medalists,
    # heads of state/government) keeps the candidate pool small (~1k-30k)
    # *before* the sitelinks filter runs, which is fast. class_triple is a
    # verbatim SPARQL pattern override (these aren't plain instance-of
    # relationships) -- see _build_query(). Coordinates aren't on the person
    # directly -- P625 lives on the place of birth/death (P19/P20), so
    # place_path is a 2-hop property path instead of the direct wdt:P625 the
    # other categories use.
    "notable_birth": {
        "category": "people", "subtype": "birth",
        "class_triple": (
            "{ ?item wdt:P166/wdt:P279* wd:Q7191 . }"       # Nobel Prize laureates
            " UNION { ?item wdt:P166/wdt:P279* wd:Q102390 . }"  # Fields Medalists
            " UNION { ?item p:P39 ?posStatement . ?posStatement ps:P39/wdt:P279* wd:Q48352 . }"  # heads of state
        ),
        "date_prop": "wdt:P569", "place_path": "wdt:P19/wdt:P625",
        "sitelink_min": 15,
        "title_template": "Birth of {}",
    },
    "notable_death": {
        "category": "people", "subtype": "death",
        "class_triple": (
            "{ ?item wdt:P166/wdt:P279* wd:Q7191 . }"
            " UNION { ?item wdt:P166/wdt:P279* wd:Q102390 . }"
            " UNION { ?item p:P39 ?posStatement . ?posStatement ps:P39/wdt:P279* wd:Q48352 . }"
        ),
        "date_prop": "wdt:P570", "place_path": "wdt:P20/wdt:P625",
        "sitelink_min": 15,
        "title_template": "Death of {}",
    },

    # ── Expanded coverage (see PLAN.md / commit history for the "every
    # feasible Wikipedia page" ask). Each of these was feasibility-tested
    # directly against WDQS before being added -- a couple of candidates
    # (e.g. plain "building" with the wdt:P279* subclass closure) timed out
    # and needed direct_instance_only instead; anything that still wasn't
    # fast enough was left out entirely rather than forced in. ──────────────
    "war": {
        "category": "historical", "subtype": "war",
        "class_qids": ["wd:Q198"], "date_prop": "wdt:P580",
        "place_path": "wdt:P276/wdt:P625",
        "sitelink_min": 8,
    },
    "election": {
        "category": "historical", "subtype": "election",
        "class_qids": ["wd:Q40231"], "date_prop": "wdt:P585",
        "place_path": "wdt:P17/wdt:P625",
        "sitelink_min": 6,
    },
    "assassination": {
        "category": "historical", "subtype": "assassination",
        "class_qids": ["wd:Q3882219"], "date_prop": "wdt:P585",
        "place_path": "wdt:P276/wdt:P625",
        "sitelink_min": 5,
    },
    # Space missions rarely have a clean place (launch sites aren't reliably
    # modeled on the mission item itself) -- left with no place_path, so
    # these populate the timeline but not the map. Still real coverage.
    "space_mission": {
        "category": "scientific", "subtype": "space_mission",
        "class_qids": ["wd:Q2133344"], "date_prop": "wdt:P619",
        "sitelink_min": 5,
    },
    "film": {
        "category": "cultural", "subtype": "film",
        "class_qids": ["wd:Q11424"], "date_prop": "wdt:P577",
        "place_path": "wdt:P495/wdt:P625",  # country of origin's centroid
        "sitelink_min": 60,
    },
    # Use "literary work" (Q7725634), not "book" (Q571): Q571 is the
    # physical/conceptual object, and individual novels/works are almost never
    # instance-of it, so wdt:P31/wdt:P279* wd:Q571 returned only ~24 items --
    # a de-facto empty category. Q7725634 is the class Wikidata actually uses
    # for books/literary works; with sitelink_min 30 it returns ~950 in ~13s
    # (feasibility-tested against WDQS, same as the others).
    "book": {
        "category": "cultural", "subtype": "book",
        "class_qids": ["wd:Q7725634"], "date_prop": "wdt:P577",
        "place_path": "wdt:P495/wdt:P625",
        "sitelink_min": 30,
    },
    "album": {
        "category": "cultural", "subtype": "album",
        "class_qids": ["wd:Q482994"], "date_prop": "wdt:P577",
        "place_path": "wdt:P495/wdt:P625",
        "sitelink_min": 25,
    },
    "painting": {
        "category": "cultural", "subtype": "painting",
        "class_qids": ["wd:Q3305213"], "date_prop": "wdt:P571",
        "place_path": "wdt:P276/wdt:P625",  # current location (usually a museum)
        "sitelink_min": 10,
    },
    # "building" (wd:Q41176) has a very deep/broad subclass tree -- the usual
    # wdt:P31/wdt:P279* pattern timed out in testing (~48s for a 20-row page,
    # too slow to paginate reliably); direct_instance_only avoids the subclass
    # closure and brought this down to ~3s.
    "landmark": {
        "category": "cultural", "subtype": "landmark",
        "class_qids": ["wd:Q41176"], "date_prop": "wdt:P571",
        "direct_instance_only": True,
        "sitelink_min": 15,
    },
    "video_game": {
        "category": "cultural", "subtype": "video_game",
        "class_qids": ["wd:Q7889"], "date_prop": "wdt:P577",
        "place_path": "wdt:P495/wdt:P625",
        "sitelink_min": 20,
    },
}

_COORD_RE = re.compile(r"Point\(([-\d.]+)\s+([-\d.]+)\)")


_DATE_PROP_PID = {
    "wdt:P585": "P585", "wdt:P575": "P575", "wdt:P569": "P569", "wdt:P570": "P570",
    "wdt:P580": "P580", "wdt:P619": "P619", "wdt:P577": "P577", "wdt:P571": "P571",
}


def _build_query(spec: dict, offset: int) -> str:
    if "class_triple" in spec:
        # Verbatim override for relationships that aren't a plain instance-of
        # (e.g. "held the position of head of state" is P39/ps:P39, not P31).
        class_union = spec["class_triple"]
    else:
        # Humans are always asserted directly (wdt:P31 wd:Q5), never via a
        # subclass tier -- skipping the wdt:P279* transitive-closure join
        # (needed for something like "battle", which has many subclasses)
        # keeps this query fast; with it, WDQS was timing out before
        # returning even one page.
        class_pattern = "wdt:P31/wdt:P279*" if not spec.get("direct_instance_only") else "wdt:P31"
        class_union = " UNION ".join(
            f"{{ ?item {class_pattern} {qid} . }}" for qid in spec["class_qids"]
        ) if spec["class_qids"] else ""
    pid = _DATE_PROP_PID[spec["date_prop"]]
    place_path = spec.get("place_path", "wdt:P625")
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
      OPTIONAL {{ ?item {place_path} ?coord . }}
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
    # WDQS serializes dates in XSD/ISO-8601 *astronomical* year numbering, which
    # HAS a year zero: "-0062" is 63 BCE, not 62 BCE (astronomical year 0 = 1
    # BCE, -1 = 2 BCE, ...). The rest of this app -- the hand-curated seed events
    # and the historical-basemaps border snapshots -- uses *historical* numbering
    # with no year zero, where a negative year N renders directly as "N BCE"
    # (events.js / bordersLayer.js both do `${-year} BCE`). Convert astronomical
    # -> historical here so one BCE-display convention holds everywhere:
    # 1 BCE (astro 0) -> -1, 63 BCE (astro -62) -> -63. Without this, every
    # BCE Wikidata event rendered one year too recent (e.g. Augustus's 63 BCE
    # birth showed as "62 BCE").
    if year <= 0:
        year -= 1
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

            display_title = spec.get("title_template", "{}").format(title)

            events.append({
                "id": f"wd-{spec['subtype']}-{qid.lower()}",
                "title": display_title,
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
