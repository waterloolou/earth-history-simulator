"""
Geological, biological, and continental data for the Earth History Simulator.
All times in millions of years ago (Ma). Larger = further in the past.
"""

import math
import random

# ── Geological Periods ────────────────────────────────────────────────────────
# Fields: name, eon, start_ma, end_ma, color (RGB), short_desc, key_event
PERIODS = [
    # Hadean Eon
    dict(name="Hadean",       eon="Hadean",      era="—",            start=4500, end=4000,
         color=(190, 65, 25),   desc="Formation of Earth",
         event="Moon-forming impact; first crust; heavy meteorite bombardment"),
    # Archean Eon
    dict(name="Eoarchean",    eon="Archean",     era="—",            start=4000, end=3600,
         color=(160, 85, 30),   desc="Earliest crust",
         event="First continental crust forms; no confirmed life"),
    dict(name="Paleoarchean", eon="Archean",     era="—",            start=3600, end=3200,
         color=(165, 95, 35),   desc="First microbial life",
         event="Oldest confirmed microbial fossils ~3.5 Ga"),
    dict(name="Mesoarchean",  eon="Archean",     era="—",            start=3200, end=2800,
         color=(172, 108, 42),  desc="Stromatolites",
         event="Stromatolites carpet shallow seas; first supercontinents nucleate"),
    dict(name="Neoarchean",   eon="Archean",     era="—",            start=2800, end=2500,
         color=(180, 122, 50),  desc="Cyanobacteria rise",
         event="Cyanobacteria begin producing oxygen; Great Oxidation Event looms"),
    # Proterozoic Eon
    dict(name="Siderian",     eon="Proterozoic", era="Paleoproterozoic", start=2500, end=2300,
         color=(115, 145, 75),  desc="Great Oxidation Event",
         event="Oxygen floods the atmosphere; banded iron formations deposit"),
    dict(name="Rhyacian",     eon="Proterozoic", era="Paleoproterozoic", start=2300, end=2050,
         color=(108, 148, 82),  desc="Huronian Glaciation",
         event="Snowball Earth episodes; oldest confirmed glaciation"),
    dict(name="Orosirian",    eon="Proterozoic", era="Paleoproterozoic", start=2050, end=1800,
         color=(100, 152, 90),  desc="Columbia forms",
         event="Supercontinent Columbia/Nuna assembles; first eukaryote evidence"),
    dict(name="Statherian",   eon="Proterozoic", era="Paleoproterozoic", start=1800, end=1600,
         color=(92, 148, 97),   desc="Complex cells",
         event="Confirmed eukaryotic cells; Columbia begins rifting"),
    dict(name="Calymmian",    eon="Proterozoic", era="Mesoproterozoic", start=1600, end=1400,
         color=(85, 142, 102),  desc="Multicellular algae",
         event="Multicellular algae appear; Columbia fully broken apart"),
    dict(name="Ectasian",     eon="Proterozoic", era="Mesoproterozoic", start=1400, end=1200,
         color=(78, 136, 108),  desc="Sexual reproduction",
         event="Sexual reproduction evolves; major advantage for genetic diversity"),
    dict(name="Stenian",      eon="Proterozoic", era="Mesoproterozoic", start=1200, end=1000,
         color=(72, 132, 114),  desc="Rodinia forms",
         event="Supercontinent Rodinia assembles; first fungi appear"),
    dict(name="Tonian",       eon="Proterozoic", era="Neoproterozoic", start=1000, end=720,
         color=(68, 126, 120),  desc="Rodinia breaks up",
         event="Rodinia rifts apart; first sponge-like animals appear"),
    dict(name="Cryogenian",   eon="Proterozoic", era="Neoproterozoic", start=720,  end=635,
         color=(175, 210, 240), desc="Snowball Earth",
         event="Global glaciation — ice reaches the equator twice"),
    dict(name="Ediacaran",    eon="Proterozoic", era="Neoproterozoic", start=635,  end=538,
         color=(88, 162, 122),  desc="First animals",
         event="Ediacaran fauna — earliest complex multicellular animals"),
    # Paleozoic Era
    dict(name="Cambrian",     eon="Phanerozoic", era="Paleozoic",    start=538,  end=485,
         color=(55, 182, 132),  desc="Cambrian Explosion",
         event="Virtually all animal body plans appear; eyes evolve; trilobites dominate"),
    dict(name="Ordovician",   eon="Phanerozoic", era="Paleozoic",    start=485,  end=444,
         color=(48, 172, 142),  desc="Marine diversification",
         event="Great Ordovician Biodiversification Event; corals and nautiloids flourish"),
    dict(name="Silurian",     eon="Phanerozoic", era="Paleozoic",    start=444,  end=419,
         color=(58, 162, 118),  desc="Life invades land",
         event="First vascular land plants; jawed fish and scorpions appear"),
    dict(name="Devonian",     eon="Phanerozoic", era="Paleozoic",    start=419,  end=359,
         color=(118, 172, 68),  desc="Age of Fishes",
         event="First forests; tetrapods emerge from the sea; Late Devonian extinction"),
    dict(name="Carboniferous",eon="Phanerozoic", era="Paleozoic",    start=359,  end=299,
         color=(78, 152, 58),   desc="Coal swamp forests",
         event="Vast coal forests; first reptiles; atmospheric O₂ peaks at ~35%"),
    dict(name="Permian",      eon="Phanerozoic", era="Paleozoic",    start=299,  end=252,
         color=(158, 132, 48),  desc="Pangea assembled",
         event="Pangea fully assembled; synapsids (proto-mammals) diversify"),
    # Mesozoic Era
    dict(name="Triassic",     eon="Phanerozoic", era="Mesozoic",     start=252,  end=201,
         color=(202, 162, 78),  desc="Recovery after Great Dying",
         event="Permian extinction kills 96% of species; first dinosaurs and mammals"),
    dict(name="Jurassic",     eon="Phanerozoic", era="Mesozoic",     start=201,  end=145,
         color=(148, 182, 58),  desc="Age of Dinosaurs",
         event="Dinosaurs dominate; Pangea splits; first birds (Archaeopteryx)"),
    dict(name="Cretaceous",   eon="Phanerozoic", era="Mesozoic",     start=145,  end=66,
         color=(88, 162, 78),   desc="Flowering plants bloom",
         event="First angiosperms; dinosaurs peak; seas rise; end: K-Pg impact"),
    # Cenozoic Era
    dict(name="Paleogene",    eon="Phanerozoic", era="Cenozoic",     start=66,   end=23,
         color=(182, 142, 98),  desc="Rise of mammals",
         event="K-Pg extinction wipes out non-avian dinosaurs; mammals diversify rapidly"),
    dict(name="Neogene",      eon="Phanerozoic", era="Cenozoic",     start=23,   end=2.6,
         color=(148, 162, 108), desc="Grasslands & hominids",
         event="Grasslands spread; hominids evolve; Isthmus of Panama closes"),
    dict(name="Quaternary",   eon="Phanerozoic", era="Cenozoic",     start=2.6,  end=0,
         color=(118, 172, 128), desc="Ice ages & humans",
         event="Ice ages cycle; Homo sapiens emerge ~300 ka; megafauna extinctions"),
]

# ── Species Diversity ─────────────────────────────────────────────────────────
# (time_ma, estimated_species_count) — approximate, illustrative values
DIVERSITY = [
    (4300, 0),
    (3800, 1),
    (3500, 80),
    (3000, 600),
    (2700, 2_500),
    (2100, 6_000),
    (1400, 18_000),
    (800,  40_000),
    (650,  4_000),      # Snowball Earth crash
    (600,  55_000),     # Ediacaran recovery
    (538,  120_000),
    (520,  550_000),    # Cambrian explosion
    (480,  850_000),
    (444,  360_000),    # Ordovician extinction (−57%)
    (420,  720_000),
    (380,  1_300_000),
    (359,  420_000),    # Late Devonian extinction (−75%)
    (310,  1_600_000),
    (252,  65_000),     # Permian extinction (−96%)
    (235,  220_000),
    (201,  170_000),    # Triassic-Jurassic extinction
    (160,  1_100_000),
    (100,  2_200_000),
    (66,   2_500_000),
    (65,   600_000),    # K-Pg extinction (−76%)
    (50,   2_000_000),
    (20,   5_000_000),
    (0,    8_700_000),
]

MAX_DIVERSITY = 8_700_000

# ── Continental Configurations ────────────────────────────────────────────────
# For each snapshot time, define a list of landmasses.
# Each landmass: {"name": str, "color": (r,g,b), "poly": [(x, y), ...]}
# Coordinates normalized 0-1 within the map rectangle.

def _blob(cx, cy, rx, ry, n=14, rough=0.18, seed=0):
    """Irregular ellipse polygon for a landmass."""
    rng = random.Random(seed)
    pts = []
    for i in range(n):
        a = 2 * math.pi * i / n + rng.uniform(-0.1, 0.1)
        r = math.sqrt((rx * math.cos(a)) ** 2 + (ry * math.sin(a)) ** 2)
        r *= (1 + rng.uniform(-rough, rough))
        pts.append((clamp(cx + r * math.cos(a), 0.02, 0.98),
                    clamp(cy + r * math.sin(a), 0.02, 0.98)))
    return pts

def clamp(v, lo, hi):
    return max(lo, min(hi, v))

_LAND = (132, 108, 58)
_LAND2 = (118, 95, 48)

CONTINENTAL_SNAPSHOTS = {
    # 4300 Ma — Magma ocean, no stable crust
    4300: [],

    # 3500 Ma — Small scattered protocratons
    3500: [
        dict(name="Vaalbara fragment",  color=_LAND2, poly=_blob(0.38, 0.42, 0.07, 0.06, seed=1)),
        dict(name="Ur fragment",        color=_LAND2, poly=_blob(0.62, 0.38, 0.06, 0.05, seed=2)),
        dict(name="Arctica fragment",   color=_LAND2, poly=_blob(0.50, 0.25, 0.05, 0.05, seed=3)),
        dict(name="Kaapvaal craton",    color=_LAND2, poly=_blob(0.72, 0.60, 0.04, 0.04, seed=4)),
    ],

    # 2500 Ma — Kenorland assembles
    2500: [
        dict(name="Kenorland",  color=_LAND, poly=_blob(0.42, 0.35, 0.17, 0.14, seed=10, rough=0.22)),
        dict(name="Ur",         color=_LAND, poly=_blob(0.68, 0.55, 0.10, 0.09, seed=11)),
        dict(name="Atlantica",  color=_LAND, poly=_blob(0.25, 0.60, 0.08, 0.07, seed=12)),
    ],

    # 1800 Ma — Columbia/Nuna supercontinent
    1800: [
        dict(name="Columbia (Nuna)", color=_LAND, poly=_blob(0.50, 0.42, 0.26, 0.22, seed=20, rough=0.24)),
    ],

    # 1000 Ma — Rodinia supercontinent
    1000: [
        dict(name="Rodinia", color=(128, 102, 52), poly=_blob(0.48, 0.45, 0.24, 0.20, seed=30, rough=0.24)),
    ],

    # 700 Ma — Rodinia breaking apart
    700: [
        dict(name="Laurentia",      color=_LAND, poly=_blob(0.25, 0.32, 0.13, 0.11, seed=40)),
        dict(name="Proto-Gondwana", color=_LAND, poly=_blob(0.62, 0.58, 0.20, 0.16, seed=41, rough=0.22)),
        dict(name="Baltica",        color=_LAND, poly=_blob(0.48, 0.22, 0.09, 0.08, seed=42)),
        dict(name="Siberia",        color=_LAND, poly=_blob(0.68, 0.20, 0.08, 0.07, seed=43)),
    ],

    # 500 Ma — Gondwana in south, Laurentia + Baltica in north
    500: [
        dict(name="Gondwana",  color=(108, 95, 48), poly=_blob(0.58, 0.65, 0.24, 0.19, seed=50, rough=0.22)),
        dict(name="Laurentia", color=_LAND,          poly=_blob(0.20, 0.30, 0.13, 0.11, seed=51)),
        dict(name="Baltica",   color=_LAND,          poly=_blob(0.45, 0.20, 0.09, 0.08, seed=52)),
        dict(name="Siberia",   color=_LAND,          poly=_blob(0.65, 0.18, 0.09, 0.08, seed=53)),
        dict(name="Avalonia",  color=_LAND,          poly=_blob(0.35, 0.22, 0.05, 0.05, seed=54)),
    ],

    # 280 Ma — Pangea, one giant supercontinent
    280: [
        dict(name="Pangea", color=(142, 115, 55), poly=[
            (0.37, 0.12), (0.52, 0.10), (0.66, 0.17), (0.76, 0.30),
            (0.74, 0.44), (0.80, 0.57), (0.72, 0.72), (0.60, 0.82),
            (0.44, 0.80), (0.36, 0.67), (0.24, 0.58), (0.27, 0.40),
            (0.21, 0.28), (0.28, 0.18), (0.37, 0.12),
        ]),
    ],

    # 150 Ma — Pangea splitting: Laurasia north, Gondwana south
    150: [
        dict(name="Laurasia",     color=(128, 112, 58), poly=_blob(0.46, 0.26, 0.25, 0.14, seed=60, rough=0.20)),
        dict(name="Gondwana",     color=(128, 112, 58), poly=_blob(0.50, 0.65, 0.22, 0.15, seed=61, rough=0.20)),
        dict(name="South America",color=(118, 105, 52), poly=_blob(0.22, 0.62, 0.09, 0.13, seed=62)),
    ],

    # 65 Ma — Near-modern continents
    65: [
        dict(name="North America", color=(95, 132, 62),  poly=_blob(0.18, 0.28, 0.13, 0.17, seed=70)),
        dict(name="South America", color=(95, 132, 62),  poly=_blob(0.22, 0.60, 0.08, 0.13, seed=71)),
        dict(name="Eurasia",       color=(95, 132, 62),  poly=_blob(0.55, 0.26, 0.23, 0.14, seed=72, rough=0.20)),
        dict(name="Africa",        color=(95, 132, 62),  poly=_blob(0.50, 0.54, 0.10, 0.15, seed=73)),
        dict(name="India",         color=(95, 132, 62),  poly=_blob(0.66, 0.50, 0.06, 0.07, seed=74)),
        dict(name="Antarctica",    color=(200, 222, 248),poly=_blob(0.50, 0.91, 0.20, 0.07, seed=75)),
        dict(name="Australia",     color=(95, 132, 62),  poly=_blob(0.79, 0.64, 0.09, 0.08, seed=76)),
    ],

    # 0 Ma — Present day
    0: [
        dict(name="North America", color=(78, 142, 68), poly=[
            (0.09, 0.18), (0.14, 0.11), (0.21, 0.10), (0.27, 0.17),
            (0.29, 0.28), (0.25, 0.43), (0.20, 0.52), (0.17, 0.46),
            (0.11, 0.38), (0.07, 0.28), (0.09, 0.18),
        ]),
        dict(name="South America", color=(78, 142, 68), poly=[
            (0.17, 0.51), (0.22, 0.48), (0.28, 0.53), (0.27, 0.62),
            (0.25, 0.73), (0.21, 0.82), (0.16, 0.77), (0.14, 0.66),
            (0.15, 0.56), (0.17, 0.51),
        ]),
        dict(name="Europe",     color=(78, 142, 68), poly=_blob(0.47, 0.22, 0.07, 0.07, seed=80)),
        dict(name="Africa",     color=(78, 142, 68), poly=[
            (0.44, 0.32), (0.50, 0.28), (0.56, 0.33), (0.58, 0.44),
            (0.56, 0.57), (0.52, 0.67), (0.48, 0.72), (0.44, 0.63),
            (0.42, 0.50), (0.43, 0.38), (0.44, 0.32),
        ]),
        dict(name="Asia",       color=(78, 142, 68), poly=[
            (0.53, 0.14), (0.63, 0.11), (0.76, 0.14), (0.85, 0.22),
            (0.87, 0.32), (0.83, 0.42), (0.75, 0.46), (0.65, 0.43),
            (0.58, 0.38), (0.54, 0.26), (0.53, 0.14),
        ]),
        dict(name="Australia",  color=(78, 142, 68), poly=_blob(0.80, 0.64, 0.09, 0.07, seed=82)),
        dict(name="Antarctica", color=(205, 228, 255), poly=_blob(0.50, 0.92, 0.26, 0.07, seed=83)),
        dict(name="Greenland",  color=(205, 228, 255), poly=_blob(0.30, 0.11, 0.04, 0.055, seed=84)),
    ],
}

# Sorted snapshot times (descending, oldest first)
SNAPSHOT_TIMES = sorted(CONTINENTAL_SNAPSHOTS.keys(), reverse=True)


# ── Helper lookup functions ───────────────────────────────────────────────────

def get_period_at(ma: float) -> dict:
    """Return the geological period active at the given time (Ma)."""
    for p in PERIODS:
        if p["end"] <= ma <= p["start"]:
            return p
    # Clamp to nearest
    if ma > PERIODS[0]["start"]:
        return PERIODS[0]
    return PERIODS[-1]


def get_diversity_at(ma: float) -> int:
    """Interpolate species count at the given time."""
    if ma >= DIVERSITY[0][0]:
        return DIVERSITY[0][1]
    if ma <= DIVERSITY[-1][0]:
        return DIVERSITY[-1][1]
    for i in range(len(DIVERSITY) - 1):
        t1, d1 = DIVERSITY[i]
        t2, d2 = DIVERSITY[i + 1]
        if t2 <= ma <= t1:
            frac = (t1 - ma) / (t1 - t2)
            return int(d1 + (d2 - d1) * frac)
    return 0


def get_continents_at(ma: float) -> list:
    """Snapshot lookup (used internally)."""
    candidates = [t for t in SNAPSHOT_TIMES if t >= ma]
    if not candidates:
        return CONTINENTAL_SNAPSHOTS.get(0, [])
    return CONTINENTAL_SNAPSHOTS[min(candidates)]


# ── Animated continental interpolation ───────────────────────────────────────

def _centroid(poly):
    cx = sum(p[0] for p in poly) / len(poly)
    cy = sum(p[1] for p in poly) / len(poly)
    return cx, cy


def _nearest(target_poly, candidates):
    """Candidate whose centroid is nearest to target's centroid."""
    if not candidates:
        return None
    tcx, tcy = _centroid(target_poly)
    return min(candidates, key=lambda c: (
        (_centroid(c["poly"])[0] - tcx) ** 2 +
        (_centroid(c["poly"])[1] - tcy) ** 2
    ))


def get_interpolated_continents(ma: float) -> list:
    """Return continents with smoothly interpolated positions and alpha values.

    Each dict includes an 'alpha' key (0-255).  Between snapshots every
    continent drifts toward its nearest counterpart in the adjacent
    snapshot while crossfading, giving the appearance of active plate
    motion.
    """
    older_t_list = [t for t in SNAPSHOT_TIMES if t >= ma]
    newer_t_list = [t for t in SNAPSHOT_TIMES if t < ma]

    if not older_t_list:
        return []

    older_t = min(older_t_list)          # closest past/present snapshot

    if not newer_t_list:
        return [dict(c, alpha=255) for c in CONTINENTAL_SNAPSHOTS[older_t]]

    newer_t = max(newer_t_list)          # closest future snapshot

    span = older_t - newer_t
    frac = (older_t - ma) / span if span > 0 else 0.0   # 0 = older, 1 = newer

    old_config = CONTINENTAL_SNAPSHOTS[older_t]
    new_config = CONTINENTAL_SNAPSHOTS[newer_t]
    result = []

    # Old continents: drift towards nearest new counterpart, fade out
    for oc in old_config:
        nc = _nearest(oc["poly"], new_config)
        if nc:
            ocx, ocy = _centroid(oc["poly"])
            ncx, ncy = _centroid(nc["poly"])
            dx = (ncx - ocx) * frac
            dy = (ncy - ocy) * frac
        else:
            dx, dy = 0.0, 0.0
        moved = [(x + dx, y + dy) for x, y in oc["poly"]]
        result.append({**oc, "poly": moved, "alpha": int(255 * (1.0 - frac))})

    # New continents: arrive from nearest old counterpart, fade in
    for nc in new_config:
        oc = _nearest(nc["poly"], old_config)
        if oc:
            ncx, ncy = _centroid(nc["poly"])
            ocx, ocy = _centroid(oc["poly"])
            dx = (ocx - ncx) * (1.0 - frac)
            dy = (ocy - ncy) * (1.0 - frac)
        else:
            dx, dy = 0.0, 0.0
        moved = [(x + dx, y + dy) for x, y in nc["poly"]]
        result.append({**nc, "poly": moved, "alpha": int(255 * frac)})

    return result
