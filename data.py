"""
Geological, biological, and continental data for the Earth History Simulator.
All times in millions of years ago (Ma). Larger = further in the past.
"""

import math

# ── Geological Periods ────────────────────────────────────────────────────────
PERIODS = [
    # Hadean Eon
    dict(name="Hadean",       eon="Hadean",      era="--",            start=4500, end=4000,
         color=(190, 65, 25),   desc="Formation of Earth",
         event="Moon-forming impact; first crust; heavy meteorite bombardment"),
    # Archean Eon
    dict(name="Eoarchean",    eon="Archean",     era="--",            start=4000, end=3600,
         color=(160, 85, 30),   desc="Earliest crust",
         event="First continental crust forms; no confirmed life"),
    dict(name="Paleoarchean", eon="Archean",     era="--",            start=3600, end=3200,
         color=(165, 95, 35),   desc="First microbial life",
         event="Oldest confirmed microbial fossils ~3.5 Ga"),
    dict(name="Mesoarchean",  eon="Archean",     era="--",            start=3200, end=2800,
         color=(172, 108, 42),  desc="Stromatolites",
         event="Stromatolites carpet shallow seas; first supercontinents nucleate"),
    dict(name="Neoarchean",   eon="Archean",     era="--",            start=2800, end=2500,
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
         event="Global glaciation -- ice reaches the equator twice"),
    dict(name="Ediacaran",    eon="Proterozoic", era="Neoproterozoic", start=635,  end=538,
         color=(88, 162, 122),  desc="First animals",
         event="Ediacaran fauna -- earliest complex multicellular animals"),
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
         event="Vast coal forests; first reptiles; atmospheric O2 peaks at ~35%"),
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
         color=(148, 162, 108), desc="Grasslands and hominids",
         event="Grasslands spread; hominids evolve; Isthmus of Panama closes"),
    dict(name="Quaternary",   eon="Phanerozoic", era="Cenozoic",     start=2.6,  end=0,
         color=(118, 172, 128), desc="Ice ages and humans",
         event="Ice ages cycle; Homo sapiens emerge ~300 ka; megafauna extinctions"),
]

# ── Species Diversity ─────────────────────────────────────────────────────────
DIVERSITY = [
    (4300, 0),
    (3800, 1),
    (3500, 80),
    (3000, 600),
    (2700, 2_500),
    (2100, 6_000),
    (1400, 18_000),
    (800,  40_000),
    (650,  4_000),
    (600,  55_000),
    (538,  120_000),
    (520,  550_000),
    (480,  850_000),
    (444,  360_000),
    (420,  720_000),
    (380,  1_300_000),
    (359,  420_000),
    (310,  1_600_000),
    (252,  65_000),
    (235,  220_000),
    (201,  170_000),
    (160,  1_100_000),
    (100,  2_200_000),
    (66,   2_500_000),
    (65,   600_000),
    (50,   2_000_000),
    (20,   5_000_000),
    (0,    8_700_000),
]

MAX_DIVERSITY = 8_700_000


# ── Geographic helpers ────────────────────────────────────────────────────────

def _from_ll(pairs):
    """Convert (longitude, latitude) pairs to normalised (x, y) 0-1 coords.

    x = (lon + 180) / 360   [0 = 180 W, 0.5 = 0 deg, 1 = 180 E]
    y = (90 - lat) / 180    [0 = 90 N, 0.5 = equator, 1 = 90 S]
    """
    return [((lon + 180) / 360, (90 - lat) / 180) for lon, lat in pairs]


def clamp(v, lo, hi):
    return max(lo, min(hi, v))


# ── Land colour palette ───────────────────────────────────────────────────────
_LAND   = (132, 108, 58)    # generic ancient land
_LAND2  = (118,  95, 48)    # older/darker craton
_SUPERC = (148, 120, 60)    # supercontinent warm tone
_LAUR   = (130, 115, 60)    # Laurasia
_GOND   = (125, 108, 55)    # Gondwana


# ── Continental Configurations ────────────────────────────────────────────────
# Each landmass dict: {"name": str, "color": (r,g,b), "polys": [[(x,y),...], ...]}
# "polys" is a LIST of polygon rings (supports multi-polygon landmasses).
# Historical snapshots use a single ring per landmass; the modern snapshot
# uses many rings per plate (loaded from Natural Earth at runtime).

CONTINENTAL_SNAPSHOTS: dict = {

    # 4300 Ma -- Magma ocean, no stable crust
    4300: [],

    # 3500 Ma -- Scattered Archean protocratons
    3500: [
        dict(name="Vaalbara",  color=_LAND2, polys=[_from_ll([
            (20,-24),(28,-20),(36,-24),(40,-32),(36,-40),(28,-42),(20,-38),(14,-32)])]),
        dict(name="Ur",        color=_LAND2, polys=[_from_ll([
            (62,-22),(72,-18),(80,-25),(82,-34),(75,-42),(66,-40),(58,-33),(56,-25)])]),
        dict(name="Arctica",   color=_LAND2, polys=[_from_ll([
            (-95,58),(-78,62),(-60,58),(-50,62),(-55,70),(-72,74),(-92,70),(-98,64)])]),
        dict(name="Kaapvaal",  color=_LAND2, polys=[_from_ll([
            (24,-25),(32,-22),(38,-28),(36,-35),(28,-38),(22,-34)])]),
    ],

    # 2500 Ma -- Kenorland + fragments
    2500: [
        dict(name="Kenorland",  color=_LAND, polys=[_from_ll([
            (-92,62),(-78,66),(-60,65),(-45,62),(-35,56),(-28,48),(-32,38),
            (-42,32),(-52,30),(-62,34),(-72,40),(-80,48),(-88,55)])]),
        dict(name="Ur",         color=_LAND, polys=[_from_ll([
            (58,-18),(72,-14),(85,-20),(88,-32),(80,-42),(68,-44),(58,-38),(52,-28)])]),
        dict(name="Atlantica",  color=_LAND, polys=[_from_ll([
            (-28,10),(-15,5),(-5,10),(0,20),(-8,28),(-20,28),(-30,20)])]),
    ],

    # 1800 Ma -- Columbia / Nuna supercontinent
    1800: [
        dict(name="Columbia (Nuna)", color=_SUPERC, polys=[_from_ll([
            (-55,65),(-35,68),(-12,65),(10,60),(32,58),(58,54),(82,52),(96,55),
            (105,50),(100,38),(88,24),(75,12),(60,4),(46,-6),(32,-14),(18,-16),
            (5,-13),(-8,-8),(-16,2),(-22,14),(-28,25),(-32,36),(-38,46),
            (-44,54),(-50,60)])]),
    ],

    # 1000 Ma -- Rodinia supercontinent
    1000: [
        dict(name="Rodinia", color=(128, 102, 52), polys=[_from_ll([
            (-42,58),(-22,65),(5,62),(30,58),(58,52),(82,55),(105,58),(120,52),
            (118,38),(102,22),(85,8),(74,-6),(66,-20),(60,-36),(54,-50),
            (38,-60),(18,-65),(0,-62),(-18,-56),(-32,-48),(-42,-36),
            (-48,-22),(-48,-8),(-44,8),(-42,22),(-42,36),(-42,48)])]),
    ],

    # 700 Ma -- Rodinia breaking apart
    700: [
        dict(name="Laurentia",       color=_LAND, polys=[_from_ll([
            (-95,28),(-82,22),(-72,15),(-65,20),(-60,32),(-55,44),
            (-55,56),(-62,62),(-76,62),(-88,55),(-96,44),(-98,35)])]),
        dict(name="Proto-Gondwana",  color=_LAND, polys=[_from_ll([
            (40,-5),(55,-2),(68,-8),(80,-18),(82,-32),(75,-45),(60,-55),
            (40,-62),(18,-65),(0,-62),(-18,-55),(-32,-45),(-38,-30),
            (-35,-15),(-25,-5),(-12,2),(5,0),(20,-5),(32,-5)])]),
        dict(name="Baltica",         color=_LAND, polys=[_from_ll([
            (-18,42),(-5,38),(8,40),(20,46),(22,56),(15,64),(0,65),
            (-14,58),(-22,50)])]),
        dict(name="Siberia",         color=_LAND, polys=[_from_ll([
            (52,50),(65,46),(78,50),(90,56),(95,62),(85,68),(70,68),(58,62),(52,55)])]),
    ],

    # 500 Ma -- Gondwana dominant, scattered northern continents
    500: [
        dict(name="Gondwana",  color=(108, 95, 48), polys=[_from_ll([
            (-65,10),(-72,-5),(-78,-22),(-78,-42),(-72,-62),(-55,-72),
            (-30,-80),(0,-82),(25,-78),(48,-70),(62,-58),(72,-44),(76,-28),
            (80,-12),(86,5),(90,18),(80,26),(66,22),(56,15),(46,8),
            (40,-5),(38,-20),(42,-38),(48,-52),(38,-60),(22,-52),(10,-38),
            (5,-22),(0,-8),(-5,5),(-12,15),(-26,12),(-38,8),(-50,12)])]),
        dict(name="Laurentia", color=_LAND,         polys=[_from_ll([
            (-95,26),(-80,20),(-70,12),(-64,18),(-58,28),(-54,38),
            (-54,50),(-60,58),(-76,60),(-88,52),(-96,40)])]),
        dict(name="Baltica",   color=_LAND,         polys=[_from_ll([
            (-18,40),(-5,36),(8,38),(20,44),(22,56),(14,64),(0,65),
            (-14,56),(-20,48)])]),
        dict(name="Siberia",   color=_LAND,         polys=[_from_ll([
            (52,48),(66,44),(80,48),(92,55),(98,62),(88,68),(72,68),(58,62),(52,55)])]),
        dict(name="Avalonia",  color=_LAND,         polys=[_from_ll([
            (-35,32),(-22,28),(-12,32),(-8,40),(-16,46),(-30,44)])]),
    ],

    # 280 Ma -- Pangea assembled (represented as two touching polygons)
    280: [
        dict(name="Pangea N (Laurasia)", color=_SUPERC, polys=[_from_ll([
            (-60,78),(-25,82),(5,78),(35,74),(68,70),(102,68),
            (122,62),(130,52),(120,40),(105,25),(90,12),(80,8),
            (70,13),(62,16),(55,18),(45,22),(35,25),(20,22),
            (5,22),(-10,18),(-18,12),(-26,15),(-34,22),
            (-42,32),(-50,44),(-56,56),(-62,68)])]),
        dict(name="Pangea S (Gondwana)", color=_SUPERC, polys=[_from_ll([
            (-58,15),(-64,5),(-72,-15),(-72,-35),(-68,-55),
            (-60,-65),(-42,-76),(-20,-82),(5,-80),(30,-76),
            (50,-66),(62,-52),(68,-38),(72,-22),(78,-8),
            (82,5),(88,18),(78,22),(68,18),(60,12),(52,8),
            (46,0),(48,-18),(52,-38),(45,-52),(30,-58),
            (16,-45),(8,-28),(4,-10),(0,5),(-8,12),
            (-18,8),(-28,5),(-38,10),(-48,12)])]),
    ],

    # 150 Ma -- Laurasia (N) and Gondwana (S) clearly split; South Atlantic opening
    150: [
        dict(name="Laurasia", color=_LAUR, polys=[_from_ll([
            (-70,78),(-35,82),(5,76),(35,72),(68,68),(102,66),
            (120,60),(126,48),(118,35),(105,22),(95,10),
            (85,5),(72,12),(62,18),(52,22),(38,25),(25,25),
            (10,22),(-2,24),(-12,20),(-22,16),(-30,22),
            (-38,30),(-46,40),(-55,52),(-62,64),(-66,72)])]),
        dict(name="Gondwana", color=_GOND, polys=[_from_ll([
            (-72,10),(-78,0),(-80,-18),(-78,-36),(-72,-55),
            (-65,-68),(-45,-76),(-20,-84),(8,-82),(30,-78),
            (50,-68),(62,-54),(68,-40),(72,-22),(78,-6),
            (88,8),(82,20),(72,22),(62,13),(52,8),(45,0),
            (48,-20),(52,-38),(46,-52),(28,-58),(15,-45),
            (8,-28),(4,-10),(0,5),(-8,12),(-18,8),(-30,5),
            (-42,8),(-52,12)])]),
    ],

    # 65 Ma and 0 Ma loaded from Natural Earth GeoJSON at runtime (see below)
    65: None,
    0:  None,
}

# Sorted snapshot times descending (oldest first)
SNAPSHOT_TIMES = sorted(CONTINENTAL_SNAPSHOTS.keys(), reverse=True)


# ── Runtime initialisation ────────────────────────────────────────────────────

def _init_geo():
    """Load Natural Earth data for 0 Ma and 65 Ma snapshots."""
    try:
        from geo import get_modern_continents, get_65ma_continents
        CONTINENTAL_SNAPSHOTS[0]  = get_modern_continents()
        CONTINENTAL_SNAPSHOTS[65] = get_65ma_continents()
    except Exception as exc:
        print(f"Warning: could not load Natural Earth data: {exc}")
        # Fallback: simplified modern approximations
        CONTINENTAL_SNAPSHOTS[0]  = _fallback_modern()
        CONTINENTAL_SNAPSHOTS[65] = _fallback_modern()


def _fallback_modern():
    """Rough-but-correct polygon outlines if geo data unavailable."""
    _G = (78, 142, 68)
    _I = (205, 228, 255)
    return [
        dict(name="North America", color=_G, polys=[_from_ll([
            (-168,72),(-140,60),(-130,52),(-124,36),(-110,24),(-90,16),
            (-84,10),(-80,22),(-75,36),(-68,45),(-60,46),(-52,47),
            (-55,52),(-62,58),(-68,64),(-80,72),(-120,78),(-140,78)])]),
        dict(name="South America", color=_G, polys=[_from_ll([
            (-82,10),(-78,2),(-78,-12),(-80,-34),(-74,-50),(-68,-55),
            (-62,-52),(-58,-38),(-50,-28),(-40,-22),(-36,-8),(-36,2),
            (-50,6),(-60,8),(-72,12)])]),
        dict(name="Europe",        color=_G, polys=[_from_ll([
            (-10,36),(2,36),(10,38),(20,36),(30,42),(36,48),(30,56),
            (22,62),(12,64),(0,62),(-6,54),(-8,44)])]),
        dict(name="Africa",        color=_G, polys=[_from_ll([
            (-18,16),(-18,10),(-16,4),(-8,-8),(0,-22),(16,-35),(28,-34),
            (42,-28),(52,-18),(44,-12),(42,2),(50,10),(44,12),(36,22),
            (32,32),(24,36),(16,36),(8,38),(0,30),(-10,22)])]),
        dict(name="Asia",          color=_G, polys=[_from_ll([
            (26,40),(40,36),(56,24),(64,22),(68,14),(80,12),(90,22),
            (102,2),(110,-8),(120,-8),(130,32),(140,50),(140,60),
            (130,72),(100,74),(80,72),(62,68),(48,60),(36,54),(30,48)])]),
        dict(name="Australia",     color=_G, polys=[_from_ll([
            (114,-22),(118,-28),(126,-34),(134,-36),(138,-36),(142,-28),
            (148,-20),(152,-24),(152,-34),(146,-40),(138,-36),(128,-36),
            (120,-34),(114,-26)])]),
        dict(name="Antarctica",    color=_I, polys=[_from_ll([
            (-180,-70),(0,-68),(90,-66),(180,-70),(160,-75),(120,-76),
            (80,-74),(40,-76),(0,-78),(-40,-76),(-80,-74),(-120,-76),
            (-160,-75)])]),
        dict(name="Greenland",     color=_I, polys=[_from_ll([
            (-72,76),(-52,72),(-22,70),(-18,75),(-30,82),(-52,84),
            (-68,82),(-76,78)])]),
    ]


_init_geo()


# ── Helper lookup functions ───────────────────────────────────────────────────

def get_period_at(ma: float) -> dict:
    for p in PERIODS:
        if p["end"] <= ma <= p["start"]:
            return p
    if ma > PERIODS[0]["start"]:
        return PERIODS[0]
    return PERIODS[-1]


def get_diversity_at(ma: float) -> int:
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
    candidates = [t for t in SNAPSHOT_TIMES if t >= ma]
    if not candidates:
        return CONTINENTAL_SNAPSHOTS.get(0, [])
    key = min(candidates)
    snap = CONTINENTAL_SNAPSHOTS[key]
    return snap if snap is not None else []


# ── Continental interpolation ─────────────────────────────────────────────────

def _continent_centroid(continent: dict) -> tuple:
    """Mean centroid across all polygon rings in the continent."""
    all_pts = [p for poly in continent["polys"] for p in poly]
    if not all_pts:
        return 0.5, 0.5
    n = len(all_pts)
    return sum(p[0] for p in all_pts) / n, sum(p[1] for p in all_pts) / n


def _nearest(target: dict, candidates: list) -> dict | None:
    if not candidates:
        return None
    tx, ty = _continent_centroid(target)
    return min(candidates, key=lambda c: (
        (_continent_centroid(c)[0] - tx) ** 2 +
        (_continent_centroid(c)[1] - ty) ** 2
    ))


def _shift_polys(polys: list, dx: float, dy: float) -> list:
    return [[(x + dx, y + dy) for x, y in poly] for poly in polys]


def get_interpolated_continents(ma: float) -> list:
    """Continents with smoothly interpolated positions and alpha values.

    Each returned dict includes an 'alpha' key (0-255).  Continents drift
    toward their counterparts in the adjacent snapshot (centroid-based),
    creating the appearance of active plate motion.
    """
    older_list = [t for t in SNAPSHOT_TIMES if t >= ma]
    newer_list = [t for t in SNAPSHOT_TIMES if t < ma]

    if not older_list:
        return []

    older_t = min(older_list)

    if not newer_list:
        snap = CONTINENTAL_SNAPSHOTS[older_t]
        return [dict(c, alpha=255) for c in (snap or [])]

    newer_t = max(newer_list)
    span    = older_t - newer_t
    frac    = (older_t - ma) / span if span > 0 else 0.0  # 0=older, 1=newer

    old_config = CONTINENTAL_SNAPSHOTS[older_t] or []
    new_config = CONTINENTAL_SNAPSHOTS[newer_t] or []
    result: list = []

    # Old continents: drift towards nearest new, fade out
    for oc in old_config:
        nc = _nearest(oc, new_config)
        if nc:
            ocx, ocy = _continent_centroid(oc)
            ncx, ncy = _continent_centroid(nc)
            dx = (ncx - ocx) * frac
            dy = (ncy - ocy) * frac
        else:
            dx, dy = 0.0, 0.0
        result.append({
            **oc,
            "polys": _shift_polys(oc["polys"], dx, dy),
            "alpha": int(255 * (1.0 - frac)),
        })

    # New continents: arrive from nearest old, fade in
    for nc in new_config:
        oc = _nearest(nc, old_config)
        if oc:
            ncx, ncy = _continent_centroid(nc)
            ocx, ocy = _continent_centroid(oc)
            dx = (ocx - ncx) * (1.0 - frac)
            dy = (ocy - ncy) * (1.0 - frac)
        else:
            dx, dy = 0.0, 0.0
        result.append({
            **nc,
            "polys": _shift_polys(nc["polys"], dx, dy),
            "alpha": int(255 * frac),
        })

    return result
