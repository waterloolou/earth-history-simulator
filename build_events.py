#!/usr/bin/env python3
"""
build_events.py -- Merge data/events_seed.json (hand-curated) with
data/wikidata_events.json (from wikidata_sync.py) into data/events_merged.json,
which events.py's load_discrete_events() reads at export time.

Run after every wikidata_sync.py refresh:
    python build_events.py

Dedup strategy (see PLAN.md's Wikidata ingestion section):
  1. Exact QID match -> seed's hand-written fields win; Wikidata only backfills
     missing image_url/place.
  2. Fallback fuzzy match (normalized title + exact year) for unmapped QIDs.
  3. Anything ambiguous (multiple fuzzy candidates) goes to
     data/wikidata_review.json for manual triage instead of being guessed.
"""

from __future__ import annotations

import json
import os
import re

_HERE = os.path.dirname(os.path.abspath(__file__))
_DATA_DIR = os.path.join(_HERE, "data")
_SEED_PATH = os.path.join(_DATA_DIR, "events_seed.json")
_WIKIDATA_PATH = os.path.join(_DATA_DIR, "wikidata_events.json")
_MERGED_PATH = os.path.join(_DATA_DIR, "events_merged.json")
_REVIEW_PATH = os.path.join(_DATA_DIR, "wikidata_review.json")


def _load(path: str) -> list[dict]:
    if not os.path.exists(path):
        return []
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def _normalize_title(title: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", title.lower()).strip()


def merge() -> None:
    seed = _load(_SEED_PATH)
    wikidata = _load(_WIKIDATA_PATH)

    seed_by_qid = {e["wiki"]["qid"]: e for e in seed if e.get("wiki", {}).get("qid")}
    seed_by_title_year: dict[tuple, list[dict]] = {}
    for e in seed:
        year = e.get("time", {}).get("year")
        if year is None:
            continue
        key = (_normalize_title(e["title"]), year)
        seed_by_title_year.setdefault(key, []).append(e)

    merged = list(seed)
    review: list[dict] = []
    added = 0
    backfilled = 0

    for wd in wikidata:
        qid = wd.get("wiki", {}).get("qid")

        if qid and qid in seed_by_qid:
            target = seed_by_qid[qid]
            if not target.get("image_url") and wd.get("image_url"):
                target["image_url"] = wd["image_url"]
                backfilled += 1
            if not target.get("place") and wd.get("place"):
                target["place"] = wd["place"]
                backfilled += 1
            continue

        year = wd.get("time", {}).get("year")
        key = (_normalize_title(wd["title"]), year) if year is not None else None
        candidates = seed_by_title_year.get(key, []) if key else []

        if len(candidates) == 1:
            target = candidates[0]
            if not target.get("image_url") and wd.get("image_url"):
                target["image_url"] = wd["image_url"]
            if not target.get("place") and wd.get("place"):
                target["place"] = wd["place"]
            if not target.get("wiki", {}).get("qid"):
                target.setdefault("wiki", {})["qid"] = qid
            backfilled += 1
            continue

        if len(candidates) > 1:
            review.append({"wikidata_event": wd, "reason": "multiple fuzzy title/year matches",
                            "candidate_ids": [c["id"] for c in candidates]})
            continue

        merged.append(wd)
        added += 1

    os.makedirs(_DATA_DIR, exist_ok=True)
    with open(_MERGED_PATH, "w", encoding="utf-8") as fh:
        json.dump(merged, fh, indent=1)
    if review:
        with open(_REVIEW_PATH, "w", encoding="utf-8") as fh:
            json.dump(review, fh, indent=1)

    print(f"Seed events: {len(seed)}")
    print(f"Wikidata events: {len(wikidata)}")
    print(f"Backfilled from Wikidata into existing seed events: {backfilled}")
    print(f"New events added from Wikidata: {added}")
    print(f"Ambiguous matches sent to review: {len(review)}")
    print(f"Wrote {_MERGED_PATH} ({len(merged)} total events)")


if __name__ == "__main__":
    merge()
