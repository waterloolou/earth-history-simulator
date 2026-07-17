#!/usr/bin/env python3
"""
species_sync.py -- One-time (manually-refreshed) sync of notable species into
data/species.json, extending the Tree of Life view's hand-curated 34-clade
backbone (see main.py's _TOL_DATA) with real per-species leaves pulled from
Wikidata. Follows the exact same cache pattern as wikidata_sync.py: never
queried automatically, never run in CI, only via:

    python species_sync.py --refresh                # all groups
    python species_sync.py --refresh --group primate_species  # just one

## Why only 14 of the ~18 candidate taxonomic groups

Every group here is queried via `?species wdt:P171* wd:<QID>` (species whose
parent-taxon chain transitively leads back to the group's class/order), which
requires WDQS to materialize that whole transitive closure before any filter
can narrow it down. For a *hyper-diverse* taxon -- Insecta (~1M+ described
species), Fungi (~150k), Arachnida (~110k), Actinopterygii/fish (~34k) -- that
closure is too large for WDQS to traverse in reasonable time: verified
directly (2026-07-15) by testing each of these with a bare COUNT query (no
row fetching, no sorting) at multiple sitelink thresholds, and every one
timed out past 20s regardless. The other 14 groups here all completed a COUNT
in under 10s. This mirrors the exact same class of limitation
wikidata_sync.py's `discovery` category already hit and documents -- a real
WDQS performance ceiling, not a bug in this script. If WDQS performance ever
improves or a narrower per-order query (e.g. splitting Insecta into
Lepidoptera/Coleoptera/Hymenoptera/Diptera separately) is worth the added
complexity, revisit then.

## Positioning species in time

Wikidata does not have per-species divergence-time data at any real scale --
unlike the curated backbone (main.py's _TOL_DATA), which has real first-
appearance dates for each of its 34 hand-picked clades. Rather than fabricate
a plausible-looking date per species, every species inherits its anchor
clade's own first_ma (the branch point) and extinct_ma (0 if the anchor is
extant, else the anchor's own extinction date, e.g. 66 Ma for non-avian
dinosaurs) -- so a species branches from exactly where its parent clade's own
node sits, honestly reflecting "we know this lineage split off around here,
not precisely when this specific species itself diverged."
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
_OUT_PATH = os.path.join(_HERE, "data", "species.json")

_SPARQL_URL = "https://query.wikidata.org/sparql"
_USER_AGENT = "EarthHistorySimulatorBot/1.0 (https://github.com/waterloolou/earth-history-simulator)"

PAGE_SIZE = 500
MAX_PAGES_PER_GROUP = 6  # safety cap: up to 3,000 species per group
REQUEST_DELAY_S = 1.0    # be polite to WDQS between paged queries
_SPECIES_RANK_QID = "Q7432"  # wikidata's "species" taxon rank

# group -> (anchor clade id in tree_of_life.json, Wikidata class QID, anchor's
# own first_ma/extinct_ma/color copied verbatim from main.py's _TOL_DATA so a
# species always inherits the exact values its parent branch already has,
# excluded_qid: a taxon to subtract out via FILTER NOT EXISTS, when a smaller
# group is already broken out separately from a larger sibling group.
GROUPS = {
    "bacteria_species":    {"anchor": "bacteria",  "qid": "Q10876",   "first_ma": 3800, "extinct_ma": 0,  "color": (255, 90, 60),   "sitelink_min": 4},
    "archaea_species":     {"anchor": "archaea",   "qid": "Q10872",   "first_ma": 3500, "extinct_ma": 0,  "color": (255, 160, 60),  "sitelink_min": 3},
    "angiosperm_species":  {"anchor": "angio",     "qid": "Q1307404", "first_ma": 130,  "extinct_ma": 0,  "color": (255, 140, 200), "sitelink_min": 8},
    "conifer_species":     {"anchor": "nonfl",     "qid": "Q132825",  "first_ma": 900,  "extinct_ma": 0,  "color": (80, 200, 70),   "sitelink_min": 5},
    "mollusk_species":     {"anchor": "mollusca",  "qid": "Q25326",   "first_ma": 540,  "extinct_ma": 0,  "color": (255, 160, 120), "sitelink_min": 15},
    "amphibian_species":   {"anchor": "amphibia",  "qid": "Q10908",   "first_ma": 370,  "extinct_ma": 0,  "color": (60, 200, 160),  "sitelink_min": 8},
    "squamate_species":    {"anchor": "lepido",    "qid": "Q122422",  "first_ma": 240,  "extinct_ma": 0,  "color": (140, 200, 80),  "sitelink_min": 10},
    "crocodilian_species": {"anchor": "crocs",     "qid": "Q25363",   "first_ma": 240,  "extinct_ma": 0,  "color": (80, 200, 100),  "sitelink_min": 3},
    "bird_species":        {"anchor": "aves",      "qid": "Q5113",    "first_ma": 150,  "extinct_ma": 0,  "color": (255, 220, 80),  "sitelink_min": 15},
    "dinosaur_species":    {"anchor": "dinosaur",  "qid": "Q430",     "first_ma": 230,  "extinct_ma": 66, "color": (200, 255, 80),  "sitelink_min": 8, "exclude_anchor": "aves", "exclude_desc_contains": ["bird"]},
    "trilobite_species":   {"anchor": "trilobita", "qid": "Q17170",   "first_ma": 521,  "extinct_ma": 252,"color": (180, 180, 100), "sitelink_min": 3},
    "marsupial_species":   {"anchor": "marsup",    "qid": "Q25336",   "first_ma": 180,  "extinct_ma": 0,  "color": (220, 180, 100), "sitelink_min": 4},
    "placental_species":   {"anchor": "placental", "qid": "Q25833",   "first_ma": 80,   "extinct_ma": 0,  "color": (255, 200, 150), "sitelink_min": 8, "exclude_qid": "Q7380"},
    "primate_species":     {"anchor": "primates",  "qid": "Q7380",    "first_ma": 65,   "extinct_ma": 0,  "color": (255, 200, 180), "sitelink_min": 4},
}


def _build_query(spec: dict, offset: int) -> str:
    exclude = ""
    if "exclude_qid" in spec:
        exclude = f"FILTER NOT EXISTS {{ ?item wdt:P171* wd:{spec['exclude_qid']} . }}"
    return f"""
    SELECT DISTINCT ?item ?itemLabel ?sitelinks ?image ?description ?article WHERE {{
      ?item wdt:P171* wd:{spec['qid']} .
      ?item wdt:P105 wd:{_SPECIES_RANK_QID} .
      {exclude}
      ?item wikibase:sitelinks ?sitelinks .
      FILTER(?sitelinks >= {spec['sitelink_min']})
      OPTIONAL {{ ?item wdt:P18 ?image . }}
      OPTIONAL {{ ?item schema:description ?description . FILTER(LANG(?description) = "en") }}
      OPTIONAL {{
        ?article schema:about ?item ;
                 schema:isPartOf <https://en.wikipedia.org/> .
      }}
      SERVICE wikibase:label {{ bd:serviceParam wikibase:language "en". }}
    }}
    LIMIT {PAGE_SIZE} OFFSET {offset}
    """
    # Deliberately no ORDER BY -- sorting the pre-filtered set by sitelinks
    # was tested and found to push several of these groups (mollusca, aves,
    # dinosaur) over WDQS's timeout even though the same query without
    # ordering succeeds; the sitelink_min FILTER already keeps quality
    # reasonable without needing "most-notable-first" truncation.


def _run_query(query: str) -> dict:
    url = f"{_SPARQL_URL}?{urllib.parse.urlencode({'query': query, 'format': 'json'})}"
    req = urllib.request.Request(url, headers={
        "Accept": "application/sparql-results+json",
        "User-Agent": _USER_AGENT,
    })
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.loads(resp.read().decode("utf-8"))


def sync_group(name: str, spec: dict, exclude_qids: set[str] = frozenset()) -> list[dict]:
    print(f"Syncing species group '{name}' (sitelinks >= {spec['sitelink_min']})...")
    species: list[dict] = []
    seen_qids: set[str] = set()

    for page in range(MAX_PAGES_PER_GROUP):
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
            if qid in exclude_qids:
                continue  # already covered by exclude_anchor's own (correctly filtered) group

            title = b.get("itemLabel", {}).get("value", qid)
            if re.fullmatch(r"Q\d+", title):
                continue  # label never resolved to English -- meaningless on the tree

            description = b.get("description", {}).get("value", "")
            if any(sub in description.lower() for sub in spec.get("exclude_desc_contains", ())):
                # exclude_anchor's QID-set check only catches items that also
                # passed the *other* anchor's own (stricter) sitelink
                # threshold -- e.g. Aves requires sitelinks>=15, so plenty of
                # lower-notability birds sail through Dinosauria's own
                # sitelinks>=8 threshold uncaught. Wikidata's short
                # descriptions are consistently "Species of X (fossil)"
                # where X is the plain-English group, so a substring check
                # against the real fetched description catches these
                # reliably; verified on this exact case (695 candidates,
                # 600 correctly caught as "Species of bird[s]", 0 false
                # positives among the 95 kept non-avian dinosaurs/reptiles).
                continue
            if description:
                description = description[0].upper() + description[1:]

            species.append({
                "id": f"sp-{qid.lower()}",
                "label": title,
                "parent_id": spec["anchor"],
                "first_ma": spec["first_ma"],
                "extinct_ma": spec["extinct_ma"],
                "color": list(spec["color"]),
                "image_url": b.get("image", {}).get("value"),
                "description": description,
                "wiki": {"title": title, "qid": qid, "url": b.get("article", {}).get("value")},
            })

        print(f"  page {page}: +{len(bindings)} rows ({len(species)} total so far)")
        if len(bindings) < PAGE_SIZE:
            break
        time.sleep(REQUEST_DELAY_S)

    print(f"  -> {len(species)} species for '{name}'")
    return species


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--refresh", action="store_true", required=True,
                     help="Confirm you intend to hit the live Wikidata SPARQL endpoint.")
    ap.add_argument("--group", choices=sorted(GROUPS), default=None,
                     help="Sync only this group (default: all).")
    ap.add_argument("--out", default=_OUT_PATH)
    args = ap.parse_args()

    names = [args.group] if args.group else list(GROUPS)
    all_species: list[dict] = []

    existing: list[dict] = []
    if os.path.exists(args.out):
        with open(args.out, encoding="utf-8") as fh:
            existing = json.load(fh)
    kept = [s for s in existing if s.get("parent_id") not in
            {GROUPS[n]["anchor"] for n in names}]
    all_species.extend(kept)

    for name in names:
        spec = GROUPS[name]
        exclude_qids = set()
        if "exclude_anchor" in spec:
            # Wikidata nests some anchors inside others (Aves under
            # Dinosauria being the notorious one -- without this, every
            # living bird shows up as a "non-avian dinosaur extinct 66 Ma
            # ago"). A SPARQL-side FILTER NOT EXISTS with a second wdt:P171*
            # transitive closure was tried first and reliably times out
            # (Aves alone has ~11-12k members, too expensive to check per
            # candidate row); excluding by QID set against the *other*
            # anchor's own already-synced, already-correct species is both
            # cheaper and more accurate than any single-query approach.
            exclude_qids = {s["wiki"]["qid"] for s in existing if s.get("parent_id") == spec["exclude_anchor"]}
        all_species.extend(sync_group(name, spec, exclude_qids))

    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(all_species, fh, indent=1)
    print(f"\nWrote {args.out} ({len(all_species)} species total)")


if __name__ == "__main__":
    main()
