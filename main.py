#!/usr/bin/env python3
"""
Earth History Simulator - Globe Edition
4.3 billion years rendered using Pillow+numpy (anti-aliased globe) + pygame (UI/animations).

Controls: SPACE=pause  LEFT/RIGHT=speed  R=reset  G=grid  click timeline=jump
"""

import pygame
import sys
import math
import time as _time
import random
import io
import os
import urllib.request as _urlreq

import numpy as np
from PIL import Image, ImageDraw, ImageChops, ImageFilter

from data import (
    PERIODS, DIVERSITY, MAX_DIVERSITY,
    get_period_at, get_diversity_at, get_interpolated_continents,
)

pygame.init()
pygame.display.set_caption("Earth History Simulator")

W, H = 1400, 860
screen = pygame.display.set_mode((W, H), pygame.DOUBLEBUF)
clock  = pygame.time.Clock()

# ── Fonts ──────────────────────────────────────────────────────────────────────
def _f(sz, bold=False):
    for face in ("segoeui", "calibri", "arial"):
        try:
            return pygame.font.SysFont(face, sz, bold=bold)
        except Exception:
            pass
    return pygame.font.Font(None, sz)

F_TITLE  = _f(34, bold=True)
F_PERIOD = _f(24, bold=True)
F_LG     = _f(19, bold=True)
F_MD     = _f(15)
F_SM     = _f(12)
F_XS     = _f(10)

# ── Layout ─────────────────────────────────────────────────────────────────────
HDR_H  = 62
TL_H   = 105
PAD    = 12

SPACE_W = 855
SPACE_H = H - HDR_H - TL_H - 3 * PAD
SPACE_X = PAD
SPACE_Y = HDR_H + PAD

INFO_X = SPACE_X + SPACE_W + PAD
INFO_Y = SPACE_Y
INFO_W = W - INFO_X - PAD
INFO_H = SPACE_H

TL_X = PAD
TL_Y = H - TL_H - PAD
TL_W = W - 2 * PAD

GLOBE_CX = SPACE_X + SPACE_W // 2
GLOBE_CY = SPACE_Y + SPACE_H // 2
GLOBE_R  = min(SPACE_W, SPACE_H) // 2 - 16
GLOBE_D  = GLOBE_R * 2      # display diameter in pixels

# Render at display resolution; PIL SMOOTH filter softens polygon edges cheaply
RENDER_D    = GLOBE_D
RENDER_R    = GLOBE_R

# ── Palette ────────────────────────────────────────────────────────────────────
BG            = ( 4,  8, 22)
PANEL         = (12, 16, 38)
PANEL2        = (16, 22, 50)
BORDER        = (36, 46, 86)
BORDER2       = (52, 68, 118)
WHITE         = (255, 255, 255)
LGRAY         = (170, 175, 195)
GRAY          = ( 88,  94, 122)
DGRAY         = ( 42,  48,  72)
GOLD          = (220, 183,  52)
GOLD2         = (255, 213,  78)
RED           = (232,  62,  52)
GREEN         = ( 66, 210,  90)
GREEN2        = ( 38, 168,  62)
CYAN          = ( 52, 215, 222)
OCEAN_SHALLOW = ( 28,  95, 175)
OCEAN_DEEP    = (  8,  30,  80)
LAVA_HOT      = (255, 148,  18)
LAVA_DARK     = (155,  38,   8)
ICE_BRIGHT    = (255, 255, 255)
ICE_DARK      = (220, 235, 255)

# ── Simulation state ───────────────────────────────────────────────────────────
START_MA    = 4300.0
END_MA      = 0.0
SPEEDS      = [5, 15, 40, 100, 250, 600, 1500]
speed_idx   = 3
current_ma  = float(START_MA)
paused      = False
show_grid   = False
last_t      = _time.perf_counter()
anim_t      = 0.0
event_queue = []
prev_period = ""
_graph_cache = {}

# ── Tree of Life ───────────────────────────────────────────────────────────────
# (id, label, first_appearance_ma, parent_id, color_rgb, extinct_ma)
# extinct_ma = 0  →  still extant
_TOL_DATA = (
    ("luca",     "LUCA",              3800, None,          (255, 230, 100),   0),
    ("bacteria", "Bacteria",          3800, "luca",        (255,  90,  60),   0),
    ("bact_oth", "Other Bacteria",    3800, "bacteria",    (255, 120,  80),   0),
    ("cyano",    "Cyanobacteria",     2700, "bacteria",    ( 60, 180, 255),   0),
    ("archaea",  "Archaea",           3500, "luca",        (255, 160,  60),   0),
    ("eukarya",  "Eukaryota",         2100, "luca",        (120, 220, 120),   0),
    ("protists", "Protists",          1800, "eukarya",     (200,  80, 220),   0),
    ("fungi",    "Fungi",             1000, "eukarya",     (200, 150,  80),   0),
    ("plantae",  "Plants",             900, "eukarya",     ( 60, 200,  60),   0),
    ("nonfl",    "Non-fl. Plants",     900, "plantae",     ( 80, 200,  70),   0),
    ("angio",    "Flowering Plants",   130, "plantae",     (255, 140, 200),   0),
    ("animalia", "Animals",            800, "eukarya",     (100, 160, 255),   0),
    ("arthropod","Arthropods",         540, "animalia",    (255, 200,  80),   0),
    ("trilobita","Trilobites",         521, "arthropod",   (180, 180, 100),  252),
    ("insecta",  "Insects",            410, "arthropod",   (255, 220,  60),   0),
    ("mollusca", "Mollusks",           540, "animalia",    (255, 160, 120),   0),
    ("chordata", "Chordates",          530, "animalia",    ( 80, 140, 255),   0),
    ("fish",     "Fish",               500, "chordata",    (120, 160, 255),   0),
    ("tetrapoda","Tetrapods",          375, "chordata",    ( 80, 200, 150),   0),
    ("amphibia", "Amphibians",         370, "tetrapoda",   ( 60, 200, 160),   0),
    ("amniota",  "Amniotes",           310, "tetrapoda",   (150, 210, 100),   0),
    ("saurop",   "Sauropsida",         310, "amniota",     (160, 215,  80),   0),
    ("lepido",   "Lizards & Snakes",   240, "saurop",      (140, 200,  80),   0),
    ("archosaur","Archosaurs",         252, "saurop",      (160, 220,  80),   0),
    ("crocs",    "Crocodilians",       240, "archosaur",   ( 80, 200, 100),   0),
    ("dinosaur", "Non-avian Dinos",    230, "archosaur",   (200, 255,  80),  66),
    ("aves",     "Birds",              150, "archosaur",   (255, 220,  80),   0),
    ("synapsida","Synapsida",          310, "amniota",     (230, 165, 100),   0),
    ("mammalia", "Mammals",            220, "synapsida",   (230, 160, 100),   0),
    ("marsup",   "Marsupials",         180, "mammalia",    (220, 180, 100),   0),
    ("placental","Placental Mammals",   80, "mammalia",    (255, 200, 150),   0),
    ("oth_plac", "Other Placentals",    65, "placental",   (245, 195, 145),   0),
    ("primates", "Primates",            65, "placental",   (255, 200, 180),   0),
    ("homo",     "Homo sapiens",         0.3,"primates",   (255, 240, 220),   0),
)
_show_tree:        bool           = False
_tol_layout_cache: dict | None    = None
_tol_btn_rect                     = None
_tol_close_rect                   = None

# Equirectangular texture cache (view-angle independent, keyed by rounded Ma)
_tex_cache:   dict = {}
_TEX_MAX      = 60

# Projected globe surface cache (keyed by (ma_rounded, lon5, lat5))
_globe_cache: dict = {}
CACHE_MA_STEP = 3
CACHE_MAX     = 80

# Pygame overlay surface (lava + particles, reused every frame)
_overlay_surf = pygame.Surface((GLOBE_D, GLOBE_D), pygame.SRCALPHA)
_overlay_mask = pygame.Surface((GLOBE_D, GLOBE_D), pygame.SRCALPHA)
_overlay_mask.fill((0, 0, 0, 0))
pygame.draw.circle(_overlay_mask, (255, 255, 255, 255), (GLOBE_R, GLOBE_R), GLOBE_R)

# Stars
_srng = random.Random(42)
STARS = [(_srng.randint(0, W), _srng.randint(0, H - TL_H - PAD),
          _srng.random(), _srng.random() * 6.28) for _ in range(240)]

# ── Helpers ────────────────────────────────────────────────────────────────────
def lerp(a, b, t): return a + (b - a) * t
def clamp(v, lo, hi): return max(lo, min(hi, v))
def mix(c1, c2, t): return tuple(int(lerp(c1[i], c2[i], clamp(t,0,1))) for i in range(3))

def txt(surf, s, fnt, color, x, y, center=False, right=False):
    img = fnt.render(str(s), True, color)
    if center: x -= img.get_width() // 2
    elif right: x -= img.get_width()
    surf.blit(img, (x, y))
    return img.get_width()

def panel(surf, rect, color=PANEL, bcolor=BORDER, r=8):
    pygame.draw.rect(surf, color, rect, border_radius=r)
    pygame.draw.rect(surf, bcolor, rect, width=1, border_radius=r)

def fmt_ma(ma):
    if ma < 0.001: return "Present Day"
    if ma < 1:     return f"{ma*1000:.0f} ka ago"
    if ma < 10:    return f"{ma:.2f} Ma ago"
    if ma < 100:   return f"{ma:.1f} Ma ago"
    if ma < 1000:  return f"{ma:.0f} Ma ago"
    return f"{ma/1000:.3f} Ga ago"

def fmt_species(n):
    if n < 1000: return str(n)
    if n < 1e6:  return f"{n/1000:.1f}k"
    return f"{n/1e6:.2f}M"

# ── Era helpers ────────────────────────────────────────────────────────────────
def atm_color(ma):
    if ma > 4000: return (68, 22,  8)
    if ma > 3000: return (40, 25, 15)
    if ma > 2400: return (26, 28, 40)
    if ma > 1800: return (18, 36, 66)
    if ma >  700: return (14, 48, 95)
    return (10, 55, 118)

def ocean_pair(ma):
    if ma > 4200: return LAVA_HOT, LAVA_DARK
    if ma > 3800:
        t = (4200 - ma) / 400
        return mix(LAVA_HOT, OCEAN_SHALLOW, t), mix(LAVA_DARK, OCEAN_DEEP, t)
    # High sea level → more continental shelf flooding → lighter/more turquoise shallow water
    sl      = _sea_level(ma)
    shallow = mix(OCEAN_SHALLOW, (48, 148, 208), sl * 0.40)
    return shallow, OCEAN_DEEP

# ── Paleoclimate state (Scotese et al. 2021, PALEOMAP) ───────────────────────

def _warmth_factor(ma: float) -> float:
    """Relative global warmth vs. modern (1.0). >1 = greenhouse, <1 = icehouse.
    Derived from Scotese 2021 Phanerozoic temperature curve."""
    if ma < 2.6:    return 0.90   # Quaternary glaciation
    if ma < 34:     return 1.10   # Eocene–Oligocene warm
    if ma < 55:     return 1.20   # Paleocene-Eocene thermal maximum
    if ma < 90:     return 1.30   # Cretaceous thermal maximum (~90 Ma peak)
    if ma < 145:    return 1.20   # Jurassic greenhouse
    if ma < 201:    return 1.15   # Triassic hothouse (post P/T recovery)
    if ma < 252:    return 1.05   # Late Permian warming after glaciation
    if ma < 310:    return 0.70   # Carboniferous–Early Permian icehouse (peak ~300 Ma)
    if ma < 360:    return 0.85   # Late Devonian cooling onset
    if ma < 385:    return 1.05   # Middle Devonian moderate
    if ma < 420:    return 1.20   # Silurian warm greenhouse
    if ma < 445:    return 0.75   # Late Ordovician (Hirnantian) glaciation
    if ma < 485:    return 1.20   # Early–Middle Ordovician warm
    if ma < 540:    return 1.25   # Cambrian hothouse
    return 1.10   # Precambrian


def _sea_level(ma: float) -> float:
    """Relative sea level (0 = Quaternary low, 1 = Cretaceous maximum).
    Based on Vail eustasy curve and Scotese PALEOMAP reconstructions."""
    if ma < 2.6:    return 0.05   # Quaternary low (continental glaciation)
    if ma < 34:     return 0.45   # Eocene moderate
    if ma < 66:     return 0.80   # Late Cretaceous high
    if ma < 100:    return 1.00   # Cretaceous maximum (vast epicontinental seas)
    if ma < 145:    return 0.85   # Jurassic high (opening Atlantic + Tethys)
    if ma < 201:    return 0.55   # Triassic moderate
    if ma < 252:    return 0.30   # Late Permian low (Pangea assembly, cool)
    if ma < 310:    return 0.20   # Carboniferous low (Gondwana glaciation)
    if ma < 359:    return 0.55   # Devonian moderate
    if ma < 419:    return 0.90   # Silurian high
    if ma < 444:    return 0.95   # Ordovician maximum (highest of Phanerozoic)
    if ma < 485:    return 0.75   # Cambrian high
    return 0.50


def _climate_state(ma: float) -> str:
    """Climate state label for UI, based on Scotese 2021 temperature curve."""
    w = _warmth_factor(ma)
    if w >= 1.25:   return "HOTHOUSE"
    if w >= 1.10:   return "GREENHOUSE"
    if w >= 0.95:   return "MODERATE"
    if w >= 0.80:   return "COOL"
    if w >= 0.70:   return "ICEHOUSE"
    return "GLACIAL"


def biome_color(cy: float, ma: float) -> tuple:
    """
    Land surface color based on latitude (cy: 0=N.pole, 0.5=equator, 1=S.pole)
    and geological time.  Called per polygon ring so large continents show
    latitudinal variation (e.g. tropical Africa green, Saharan Africa tan).
    Latitude band thresholds are scaled by _warmth_factor so greenhouse worlds
    have wider tropical/temperate belts and icehouse worlds have wider polar zones.
    """
    lat = abs(90.0 - cy * 180.0)   # 0 = equator, 90 = poles

    v_plant  = ma < 430   # vascular land plants (~430 Ma)
    v_forest = ma < 385   # first forests (Late Devonian)
    v_angio  = ma < 130   # angiosperms / flowering plants (Early Cretaceous)
    v_grass  = ma < 34    # grasses and savanna (Oligocene)

    # Scale latitude band thresholds with paleoclimate warmth.
    # Greenhouse worlds: tropical/temperate belts push further poleward.
    # Icehouse worlds:   polar/subpolar belts expand toward the equator.
    warmth      = _warmth_factor(ma)
    band_scale  = 0.5 + 0.5 * warmth          # 0.70→0.85 … 1.00→1.00 … 1.30→1.15
    t_polar     = min(88.0, 70.0 * band_scale)
    t_subpolar  = min(t_polar   - 8.0, 55.0 * band_scale)
    t_temperate = min(t_subpolar - 8.0, 35.0 * band_scale)
    t_subtrop   = max( 8.0, 22.0 * band_scale)

    # ── Pre-vegetation: red-bed bare rock ───────────────────────────────────
    if not v_plant:
        if lat > t_polar:     return (182, 174, 162)
        if lat > t_temperate: return (150, 124,  88)
        return                        (145, 110,  68)

    # ── Polar ───────────────────────────────────────────────────────────────
    if lat > t_polar:
        if ma < 2.6:          return (230, 240, 255)   # Quaternary ice sheets
        if v_grass:           return (195, 205, 188)   # tundra / permafrost
        if warmth >= 1.10:    return ( 95, 125,  65)   # warm polar forest (greenhouse)
        return                       (178, 168, 150)   # cold rocky ground

    # ── Sub-polar / boreal ──────────────────────────────────────────────────
    if lat > t_subpolar:
        if v_grass:           return ( 65, 100,  55)   # taiga / boreal forest
        if v_angio:           return ( 78, 115,  60)   # warm boreal
        if v_forest:          return ( 88, 112,  60)   # Mesozoic conifers
        if warmth >= 1.10:    return ( 88, 118,  65)   # greenhouse high-lat forest
        return                       (105, 108,  70)   # sparse early colonisation

    # ── Temperate ───────────────────────────────────────────────────────────
    if lat > t_temperate:
        if v_grass:           return (108, 150,  75)   # mixed forest / grassland
        if v_angio:           return ( 92, 132,  68)   # broadleaf angiosperm forest
        if v_forest:          return ( 82, 118,  60)   # fern + conifer
        return                       ( 98, 115,  68)   # early land plants

    # ── Subtropical – prone to aridity ──────────────────────────────────────
    if lat > t_subtrop:
        if v_grass:           return (192, 162,  82)   # savanna / arid scrub (Sahara zone)
        if v_angio:           return (148, 135,  72)   # warm subtropical deciduous
        if v_forest:          return (118, 128,  65)   # Mesozoic subtropical
        return                       (138, 115,  75)

    # ── Tropical ─────────────────────────────────────────────────────────────
    if v_grass:               return ( 52, 122,  50)   # tropical rainforest
    if v_angio:               return ( 60, 115,  52)   # Paleogene jungle
    if v_forest:              return ( 68, 108,  54)   # cycad / tree-fern forest
    return                           ( 88, 108,  62)   # early tropical plants


# ── Mountain ranges (accurate collision timing + paleogeographic coordinates) ─
# form : Ma when collision began (first mountains appear)
# erode: 0 = still active today; >0 = Ma when range was fully flattened
# height: characteristic peak height km (scales symbol size)
# ridge : (lon, lat) waypoints along the spine

MOUNTAIN_RANGES = [
    # Currently prominent ───────────────────────────────────────────────────
    dict(name="Himalayas",     form=55,  erode=0,   height=8.8,
         ridge=[(74,36),(80,33),(87,29),(93,27),(98,27),(103,26)]),
    dict(name="Alps",          form=35,  erode=0,   height=4.8,
         ridge=[(6,46),(10,46),(14,47)]),
    dict(name="Pyrenees",      form=65,  erode=0,   height=3.4,
         ridge=[(-2,43),(2,43)]),
    dict(name="Atlas",         form=65,  erode=0,   height=4.2,
         ridge=[(-5,32),(1,32),(8,33)]),
    dict(name="Zagros",        form=25,  erode=0,   height=4.5,
         ridge=[(48,30),(53,28),(58,26)]),
    dict(name="Caucasus",      form=25,  erode=0,   height=5.6,
         ridge=[(40,43),(43,43),(46,43)]),
    dict(name="Andes",         form=25,  erode=0,   height=6.9,
         ridge=[(-75,9),(-72,0),(-68,-18),(-68,-34),(-70,-51)]),
    dict(name="Rockies",       form=80,  erode=0,   height=4.4,
         ridge=[(-121,51),(-115,45),(-108,38),(-106,32)]),
    dict(name="Sierra Nevada", form=100, erode=0,   height=4.4,
         ridge=[(-121,38),(-118,36)]),
    # Eroded but still visible ───────────────────────────────────────────────
    dict(name="Appalachians",  form=480, erode=0,   height=2.2,
         ridge=[(-84,34),(-80,38),(-77,42),(-74,44)]),
    dict(name="Urals",         form=390, erode=0,   height=1.9,
         ridge=[(59,51),(59,57),(60,62),(60,67)]),
    dict(name="Scandinavian",  form=410, erode=0,   height=2.4,
         ridge=[(6,58),(8,62),(14,67),(17,70)]),
    # Ancient / fully eroded (historical paleogeographic coordinates) ────────
    # Caledonian: Laurentia-Baltica suture, ~490–370 Ma
    dict(name="Caledonian",    form=490, erode=370, height=5.0,
         ridge=[(-10,55),(0,57),(8,61),(14,66),(18,70)]),
    # Variscan / Hercynian: central European segment of Pangea assembly ~380–200 Ma
    dict(name="Variscan",      form=380, erode=200, height=4.0,
         ridge=[(-4,48),(4,49),(10,50),(16,49),(22,48)]),
    # Acadian: east Laurentia collision ~375–325 Ma
    dict(name="Acadian",       form=375, erode=320, height=4.5,
         ridge=[(-74,40),(-71,43),(-66,46)]),
    # Taconic: Laurentia east-coast arc collision ~490–440 Ma
    dict(name="Taconic",       form=490, erode=440, height=3.5,
         ridge=[(-74,40),(-71,43)]),
    # Ancestral Rockies: intracratonic Pennsylvanian uplift ~320–280 Ma
    dict(name="Anc. Rockies",  form=320, erode=280, height=3.0,
         ridge=[(-108,38),(-105,34)]),
    # Pan-African: Gondwana assembly ~620–510 Ma
    dict(name="Pan-African",   form=620, erode=500, height=4.5,
         ridge=[(25,-10),(30,-20),(35,-30),(38,-38)]),
    # Trans-Saharan: Gondwana interior sutures ~600–550 Ma
    dict(name="Trans-Saharan", form=600, erode=520, height=4.0,
         ridge=[(8,20),(12,18),(18,16)]),
]


def _mtn_frac(rng: dict, ma: float) -> float:
    """Height fraction 0–1 at simulation time ma."""
    fm, em = rng["form"], rng["erode"]
    if ma > fm:
        return 0.0                   # not yet formed
    if em > 0 and ma < em:
        return 0.0                   # fully eroded away
    age = fm - ma                    # Ma since first collision
    if em > 0:
        span = fm - em
        t = age / span               # 0 at fm, 1 at em
        # rapid growth to peak at t=0.25, then slow erosion to 0 at t=1
        if t < 0.25:
            return t / 0.25
        return (1.0 - t) / 0.75
    else:
        # still active: grows from 0 to full height, reaches ~max after 40% of lifetime
        return min(1.0, age / max(fm * 0.40, 15.0))


def _draw_mountains(draw: ImageDraw.Draw, ma: float) -> None:
    """
    Paint mountain ranges as colour zones in the equirectangular texture,
    mimicking satellite / Google Earth appearance:
      - wide, semi-transparent outer ring  : lower rocky slopes (grey-brown)
      - narrower inner ring                : upper bare rock    (light grey)
      - small centre blob                  : permanent snow/ice (near-white)
    Multiple ridge points overlap into a continuous coloured belt.
    """
    for rng in MOUNTAIN_RANGES:
        frac = _mtn_frac(rng, ma)
        if frac < 0.06:
            continue
        eff_h = rng["height"] * frac      # effective height km at this time

        # ── Layer radii (px) — width ≈ proportional to mountain mass ────────
        r_outer = max(6, int(eff_h * 3.5))
        r_inner = max(4, int(eff_h * 2.0))
        r_snow  = max(2, int(eff_h * 0.9))

        # ── Colours keyed to height, based on satellite imagery ─────────────
        if eff_h >= 5.5:
            # Highest ranges (Himalayas, Karakoram, Andes high):
            # extensive permanent snowfields, grey limestone/granite showing through
            c_outer = (148, 132, 115)   # brown-grey lower flanks
            c_inner = (188, 182, 172)   # light grey upper rock
            c_snow  = (238, 240, 244)   # bright snow / permanent ice
        elif eff_h >= 3.5:
            # High ranges (Alps, Rockies, Zagros, Caucasus):
            # seasonal snow, exposed grey rock dominates upper zone
            c_outer = (142, 128, 110)   # rocky lower slopes
            c_inner = (172, 165, 152)   # grey-buff upper rock
            c_snow  = (215, 218, 222)   # seasonal/partial snow
        elif eff_h >= 2.0:
            # Mid-height / eroding ranges (Appalachians, Urals, Scandinavian):
            # mostly forested flanks, exposed grey rock only near summits
            c_outer = (130, 120, 102)   # forested rocky slopes
            c_inner = (155, 148, 132)   # exposed summit rock
            c_snow  = (188, 188, 182)   # patchy seasonal snow
        else:
            # Low, heavily eroded hills — barely contrast with terrain
            c_outer = (125, 118,  98)
            c_inner = (140, 132, 115)
            c_snow  = (158, 155, 148)

        for lon, lat in rng["ridge"]:
            tx = int((lon + 180) / 360 * W_TEX)
            ty = int((90 - lat) / 180 * H_TEX)
            if not (0 <= tx < W_TEX and 0 <= ty < H_TEX):
                continue

            # Paint outer → inner → snow so inner colours overwrite outer
            # Ellipses are wider E-W than N-S (ridges run roughly E-W)
            for rx, ry_frac, col, alpha in [
                (r_outer, 0.55, c_outer, 175),
                (r_inner, 0.55, c_inner, 195),
                (r_snow,  0.60, c_snow,  210),
            ]:
                ry = max(2, int(rx * ry_frac))
                draw.ellipse([tx - rx, ty - ry, tx + rx, ty + ry],
                             fill=(*col, alpha))


def o2_frac(ma):
    if ma > 2500: return 0.0
    if ma > 2000: return lerp(0.0, 0.02, (2500-ma)/500) / 0.21
    if ma >  540: return lerp(0.02, 0.10, (2000-ma)/1460) / 0.21
    if ma >  300: return lerp(0.10, 0.35, (540-ma)/240) / 0.21
    if ma >  200: return lerp(0.35, 0.16, (300-ma)/100) / 0.21
    return clamp(lerp(0.16, 0.21, (200-ma)/200), 0, 1)


def co2_ppm(ma: float) -> float:
    """Atmospheric CO₂ in ppm. Based on GEOCARB/COPSE models and proxy data."""
    if ma > 4000:  return 500_000   # Hadean: extreme volcanic outgassing
    if ma > 3500:  return 100_000   # early Archean high-CO2 greenhouse
    if ma > 2500:  return  30_000   # late Archean
    if ma > 2000:  return  10_000   # early Proterozoic (post-GOE)
    if ma > 1000:  return   5_000   # mid-Proterozoic
    if ma >  700:  return   2_500   # Cryogenian/Ediacaran
    if ma >  485:  return   4_200   # Cambrian – no land plants, high CO2
    if ma >  444:  return   3_000   # Ordovician – declining
    if ma >  419:  return   2_200   # Silurian – vascular plants spreading
    if ma >  380:  return   1_200   # Devonian – forests consuming CO2
    if ma >  300:  return     400   # Carboniferous – coal forests near-modern low
    if ma >  260:  return   1_000   # Early Permian – glaciation retreating
    if ma >  252:  return   1_600   # Late Permian
    if ma >  201:  return   2_000   # Triassic hothouse
    if ma >  145:  return   1_500   # Jurassic
    if ma >   66:  return     800   # Cretaceous
    if ma >   55:  return     600   # late Paleocene
    if ma >   34:  return     450   # Eocene warmth
    if ma >   2.6: return     350   # Oligocene–Pliocene gradual decline
    return 240   # Quaternary ice ages (lower during glacial maxima)


def global_temp_c(ma: float) -> float:
    """Global mean surface temperature in °C. Calibrated to Scotese 2021."""
    if ma > 4200: return 85.0
    if ma > 3800: return lerp(85.0, 35.0, (4200 - ma) / 400)
    if ma > 3000: return lerp(35.0, 22.0, (3800 - ma) / 800)
    if ma > 1000: return lerp(22.0, 18.0, (3000 - ma) / 2000)
    if ma >  500: return 18.0   # Cambrian warm
    if ma >  480: return 22.0   # Cambrian hothouse peak
    if ma >  460: return 19.0   # Ordovician warm
    if ma >  443: return 11.0   # Hirnantian glaciation minimum
    if ma >  430: return 19.0   # Silurian recovery
    if ma >  400: return 22.0   # Devonian warm peak
    if ma >  360: return 18.0   # Late Devonian cooling
    if ma >  280: return 12.0   # Carboniferous–Permian icehouse
    if ma >  260: return 16.0   # Late Permian warming
    if ma >  252: return 22.0   # End-Permian hothouse (P/T boundary)
    if ma >  200: return 22.0   # Triassic hothouse
    if ma >  150: return 19.0   # Jurassic moderate
    if ma >   90: return 23.0   # Cretaceous thermal maximum
    if ma >   66: return 18.0   # Late Cretaceous
    if ma >   55: return 26.0   # Paleocene-Eocene Thermal Maximum (PETM)
    if ma >   34: return 19.0   # Eocene warm
    if ma >   23: return 15.0   # Oligocene cooling
    if ma >    5: return 14.0   # Miocene
    if ma >  2.6: return 13.5   # Pliocene
    return 10.0   # Quaternary glacial average


# ══════════════════════════════════════════════════════════════════════════════
# 3-D GLOBE RENDERING  (orthographic projection + Lambertian shading, cached)
# ══════════════════════════════════════════════════════════════════════════════

# Viewing parameters — Atlantic view, slightly north-tilted (mutable for drag)
GLOBE_LON0  = -20.0
GLOBE_LAT0  =  20.0
_INIT_LON   = GLOBE_LON0
_INIT_LAT   = GLOBE_LAT0

# Equirectangular intermediate texture (continents painted here, then projected)
W_TEX = 720
H_TEX = 360

# Derived trig (updated by _set_view whenever the view angle changes)
_cos_lat0 = math.cos(math.radians(GLOBE_LAT0))
_sin_lat0 = math.sin(math.radians(GLOBE_LAT0))
_lon0_rad  = math.radians(GLOBE_LON0)

# ── Drag / rotation state ──────────────────────────────────────────────────────
_drag_active = False
_drag_prev   = (0, 0)
_spin_lon    = 0.0   # deg/s inertia after drag release
_spin_lat    = 0.0


def _set_view(lon: float, lat: float) -> None:
    """Update the globe viewing angle and invalidate projection tables."""
    global GLOBE_LON0, GLOBE_LAT0, _cos_lat0, _sin_lat0, _lon0_rad, _PROJ_TABLES
    GLOBE_LON0 = lon % 360
    GLOBE_LAT0 = clamp(lat, -85.0, 85.0)
    _cos_lat0  = math.cos(math.radians(GLOBE_LAT0))
    _sin_lat0  = math.sin(math.radians(GLOBE_LAT0))
    _lon0_rad  = math.radians(GLOBE_LON0)
    _PROJ_TABLES = None   # projection tables bake the view angle — force rebuild

# Specular highlight (pre-baked once)
_PIL_SPECULAR: Image.Image | None = None

def _get_specular() -> Image.Image:
    global _PIL_SPECULAR
    if _PIL_SPECULAR is None:
        sz = RENDER_D; r = RENDER_R
        s  = Image.new("RGBA", (sz, sz), (0, 0, 0, 0))
        sd = ImageDraw.Draw(s, "RGBA")
        # Light direction lx=0.38, ly=0.52, lz=0.76 → specular peak in upper-right
        # half-vector with view=(0,0,1): hv ≈ (0.21, 0.28, 0.96) normalised
        # Screen pos: x = hv_x * r + r ≈ 1.21*r,  y = r - hv_y * r ≈ 0.72*r
        hx, hy = int(r * 1.22), int(r * 0.72)
        mx = int(r * 0.46)   # wider glint — Google Earth has a broad ocean glint
        for rad in range(mx, 2, -2):
            a = int(55 * (1 - rad / mx) ** 2.2)
            sd.ellipse((hx-rad, hy-rad, hx+rad, hy+rad), fill=(255, 255, 255, a))
        _PIL_SPECULAR = s
    return _PIL_SPECULAR


# ── NASA Blue Marble + cloud texture ─────────────────────────────────────────
# Both downloaded once on first run and loaded from local cache.
# Blue Marble: photorealistic base for 0–65 Ma.
# Cloud layer: greyscale cloud-cover composite blended over Blue Marble.

_BM_URL  = ("https://eoimages.gsfc.nasa.gov/images/imagerecords/57000/57752/"
             "land_shallow_topo_2048.jpg")
_BM_URL2 = ("https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi"
            "?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap"
            "&BBOX=-90,-180,90,180&CRS=EPSG:4326&WIDTH=2048&HEIGHT=1024"
            "&LAYERS=BlueMarble_NextGeneration&FORMAT=image/jpeg")
_BM_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "blue_marble.jpg")

_CLOUD_URL  = ("https://eoimages.gsfc.nasa.gov/images/imagerecords/57000/57747/"
               "cloud_combined_2048.jpg")
_CLOUD_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "cloud_layer.jpg")

_bm_tex:    "np.ndarray | None" = None   # (H_TEX, W_TEX, 3) uint8
_bm_dx:     "np.ndarray | None" = None   # (H_TEX, W_TEX) float32 – 65 Ma plate dx
_bm_dy:     "np.ndarray | None" = None   # (H_TEX, W_TEX) float32 – 65 Ma plate dy
_bm_failed: bool                = False  # True after a failed download / load
_cloud_tex: "np.ndarray | None" = None   # (H_TEX, W_TEX) uint8 greyscale


def _init_blue_marble() -> bool:
    """Download (first run) and load the NASA Blue Marble; build plate-shift tables.
    Returns True if texture is ready."""
    global _bm_tex, _bm_dx, _bm_dy, _bm_failed
    if isinstance(_bm_tex, np.ndarray):
        return True
    if _bm_failed:
        return False

    if not os.path.exists(_BM_PATH):
        print("Downloading NASA Blue Marble (~2 MB, one-time)…", flush=True)
        downloaded = False
        for url in (_BM_URL, _BM_URL2):
            try:
                _urlreq.urlretrieve(url, _BM_PATH)
                downloaded = True
                break
            except Exception as exc:
                print(f"  URL failed: {exc}", flush=True)
        if not downloaded:
            print("  All Blue Marble URLs failed. Falling back to procedural terrain.", flush=True)
            _bm_failed = True
            return False

    try:
        img    = Image.open(_BM_PATH).convert("RGB").resize((W_TEX, H_TEX), Image.LANCZOS)
        _bm_tex = np.array(img, dtype=np.uint8)
    except Exception as exc:
        print(f"  Blue Marble load error: {exc}", flush=True)
        _bm_failed = True
        return False

    # Cloud layer (separate download, non-fatal if unavailable)
    global _cloud_tex
    if not os.path.exists(_CLOUD_PATH):
        print("Downloading NASA cloud texture (~2 MB, one-time)…", flush=True)
        try:
            _urlreq.urlretrieve(_CLOUD_URL, _CLOUD_PATH)
        except Exception as exc:
            print(f"  Cloud download skipped: {exc}", flush=True)
    if os.path.exists(_CLOUD_PATH):
        try:
            cimg = Image.open(_CLOUD_PATH).convert("L").resize((W_TEX, H_TEX), Image.LANCZOS)
            _cloud_tex = np.array(cimg, dtype=np.uint8)
        except Exception:
            pass

    # Build per-pixel 65 Ma plate-displacement tables (dx, dy in normalised coords).
    # Each pixel is assigned to a tectonic plate using the same heuristics as
    # geo._assign_plate; the offsets come from geo._OFFSET_65MA.
    from geo import _OFFSET_65MA   # type: ignore[import]

    lon2, lat2 = np.meshgrid(
        np.linspace(-180.0, 180.0, W_TEX, dtype=np.float32),
        np.linspace(  90.0, -90.0, H_TEX, dtype=np.float32),
    )

    _bm_dx = np.zeros((H_TEX, W_TEX), dtype=np.float32)
    _bm_dy = np.zeros((H_TEX, W_TEX), dtype=np.float32)

    def _apply(mask, plate):
        pdx, pdy = _OFFSET_65MA.get(plate, (0.0, 0.0))
        _bm_dx[mask] = pdx
        _bm_dy[mask] = pdy

    # Apply lowest → highest priority so the highest-priority plate overwrites.
    _apply(lon2 > 25,                                                       'eurasia')
    _apply((lon2 >= -20) & (lon2 <= 57)  & (lat2 < 42),                    'africa')
    _apply(((lon2 >= -90) & (lon2 < -30) & (lat2 < 12)) |
           ((lon2 < -50) & (lat2 <= 5)),                                    'south_america')
    _apply((lon2 < -50) & (lat2 >  5) & (lat2 <= 56),                      'north_america')
    _apply((lon2 < -50) & (lat2 > 56),                                      'greenland')
    _apply((lon2 >= 90)  & (lat2 >= -12) & (lat2 <= 30),                   'se_asia')
    _apply((lon2 >= 62)  & (lon2 <= 100) & (lat2 >=  5) & (lat2 <= 40),    'india')
    _apply((lon2 >= 108) & (lon2 <= 162) & (lat2 >= -46) & (lat2 <= -8),   'australia')
    _apply(lat2 < -57,                                                       'antarctica')

    return True


# ── Scotese PALEOMAP textures (0 – 750 Ma) ───────────────────────────────────
# Textures courtesy C.R. Scotese / PALEOMAP Project, served by the Ancient Earth
# Globe project (dinosaurpictures.org).  Downloaded on-demand, cached to disk.

_PT_BASE = "https://dinosaurpictures.org/ancient-earth-assets/images/scotese/"
_PT_DIR  = os.path.join(os.path.dirname(os.path.abspath(__file__)), "paleo_textures")

SCOTESE_MAS: list[int] = sorted([
    0, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 66,
    75, 80, 90, 100, 105, 110, 120, 130, 140, 150, 160, 170, 180,
    200, 220, 240, 250, 260, 270, 280, 290, 300, 310, 320, 330, 340,
    350, 360, 370, 380, 390, 400, 410, 420, 430, 440, 450, 460, 470,
    480, 490, 500, 510, 520, 530, 540, 600, 690, 750,
])
_PT_MAX_MA = SCOTESE_MAS[-1]   # 750

_pt_mem: dict[int, "np.ndarray | None"] = {}
_PT_MEM_LIMIT = 24


def _load_paleo_tex(ma: int) -> "np.ndarray | None":
    """Load Scotese texture for an exact Ma key.  Downloads once, caches to disk."""
    if ma in _pt_mem:
        return _pt_mem[ma]
    path = os.path.join(_PT_DIR, f"{ma}.jpg")
    if not os.path.exists(path):
        os.makedirs(_PT_DIR, exist_ok=True)
        try:
            _urlreq.urlretrieve(f"{_PT_BASE}{ma}.jpg", path)
        except Exception as exc:
            print(f"  Paleo tex {ma} Ma download failed: {exc}", flush=True)
            _pt_mem[ma] = None
            return None
    try:
        img = Image.open(path).convert("RGB").resize((W_TEX, H_TEX), Image.LANCZOS)
        arr = np.array(img, dtype=np.uint8)
    except Exception as exc:
        print(f"  Paleo tex {ma} Ma load error: {exc}", flush=True)
        _pt_mem[ma] = None
        return None
    _pt_mem[ma] = arr
    if len(_pt_mem) > _PT_MEM_LIMIT:          # evict oldest entry
        del _pt_mem[next(iter(_pt_mem))]
    return arr


def _scotese_tex(ma: float) -> "np.ndarray | None":
    """Blend between the two surrounding Scotese keyframes for any ma ≤ 750."""
    if ma > _PT_MAX_MA:
        return None
    lo = max((m for m in SCOTESE_MAS if m <= ma), default=SCOTESE_MAS[0])
    hi = min((m for m in SCOTESE_MAS if m >= ma), default=SCOTESE_MAS[-1])
    t_lo = _load_paleo_tex(lo)
    if lo == hi or t_lo is None:
        return t_lo
    t_hi = _load_paleo_tex(hi)
    if t_hi is None:
        return t_lo
    frac = (ma - lo) / (hi - lo)
    return np.clip(
        t_lo.astype(np.float32) * (1.0 - frac) + t_hi.astype(np.float32) * frac,
        0, 255,
    ).astype(np.uint8)


# ── Terrain noise (FBM via sine waves) ───────────────────────────────────────
_NOISE_CACHE: dict[int, np.ndarray] = {}

def _terrain_noise_for(ma: float) -> np.ndarray:
    """Multiplicative noise (H_TEX, W_TEX) in [0.80, 1.20]; stable per 10 Ma group."""
    key = int(ma // 10) * 10
    if key in _NOISE_CACHE:
        return _NOISE_CACHE[key]
    rng   = np.random.default_rng(key + 9999)
    noise = np.zeros((H_TEX, W_TEX), dtype=np.float32)
    amp, freq = 1.0, 3
    for _ in range(5):
        px = float(rng.random() * 6.28318)
        py = float(rng.random() * 6.28318)
        x  = np.linspace(px, px + freq * 6.28318, W_TEX, dtype=np.float32)
        y  = np.linspace(py, py + freq * 6.28318, H_TEX, dtype=np.float32)
        xx, yy = np.meshgrid(x, y)
        noise += amp * np.sin(xx) * np.cos(yy)
        amp  *= 0.55
        freq  = int(freq * 1.9) + 1
    # Smooth then remap to [0.80, 1.20]
    s = Image.fromarray(
        np.clip((noise - noise.min()) / (noise.max() - noise.min() + 1e-8) * 255,
                0, 255).astype(np.uint8), "L")
    smooth = np.array(s.filter(ImageFilter.GaussianBlur(radius=4)),
                      dtype=np.float32) / 255.0
    result = (0.80 + 0.40 * smooth).astype(np.float32)
    _NOISE_CACHE[key] = result
    return result


def _displaced_bm(frac: float) -> np.ndarray:
    """Return Blue Marble with plates displaced to their positions at frac × 65 Ma.
    frac=0 → modern Earth (no shift).  frac=1 → 65 Ma plate positions."""
    assert isinstance(_bm_tex, np.ndarray) and _bm_dx is not None
    if frac < 1e-4:
        return _bm_tex
    ty_i, tx_i = np.mgrid[0:H_TEX, 0:W_TEX]
    # Inverse displacement: sample Blue Marble at (pixel_pos − plate_offset)
    sx = np.clip(tx_i - (_bm_dx * frac * W_TEX).astype(np.int32), 0, W_TEX - 1)
    sy = np.clip(ty_i - (_bm_dy * frac * H_TEX).astype(np.int32), 0, H_TEX - 1)
    return _bm_tex[sy, sx]


def _make_equirect_tex(ma: float) -> np.ndarray:
    """Build a (H_TEX, W_TEX, 4) RGBA equirectangular texture for time ma."""
    shallow, deep = ocean_pair(ma)

    # Latitude-gradient ocean base
    yy  = np.linspace(0, 1, H_TEX, dtype=np.float32)          # 0=N, 1=S
    t   = np.clip(np.abs(yy - 0.5) * 2 * 0.85, 0, 1)          # 0=equator, 1=pole
    col = np.zeros((H_TEX, 3), dtype=np.float32)
    for ch in range(3):
        col[:, ch] = shallow[ch] * (1 - t) + deep[ch] * t
    tex = np.zeros((H_TEX, W_TEX, 4), dtype=np.uint8)
    tex[:, :, :3] = np.clip(col, 0, 255).astype(np.uint8)[:, np.newaxis, :]
    tex[:, :,  3] = 255

    tex_img = Image.fromarray(tex, "RGBA")
    draw    = ImageDraw.Draw(tex_img, "RGBA")

    # Land polygons — draw fading-out first so fading-in land appears on top.
    # Each ring gets its own biome colour based on that ring's latitude centroid,
    # so large continents show natural latitudinal variation.
    conts_sorted = sorted(get_interpolated_continents(ma),
                          key=lambda c: c.get("alpha", 255))
    for c in conts_sorted:
        alpha = int(clamp(c.get("alpha", 255), 0, 255))
        if alpha < 4:
            continue
        for poly in c.get("polys", []):
            if len(poly) < 3:
                continue
            cy   = sum(p[1] for p in poly) / len(poly)   # ring's y-centroid
            lc   = biome_color(cy, ma)
            pts  = [(int(x * W_TEX), int(y * H_TEX)) for x, y in poly]
            draw.polygon(pts, fill=(*lc, alpha))
            # No polygon outlines — softer blended edges look more photorealistic

    # Soften continent/biome boundaries before adding crisp mountain + ice overlays
    # Ancient eras use heavier blur because the polygon shapes are coarser
    blur_r  = 1.5 if ma < 65 else (2.5 if ma < 300 else 3.5)
    tex_img = tex_img.filter(ImageFilter.GaussianBlur(radius=blur_r))
    draw    = ImageDraw.Draw(tex_img, "RGBA")

    # Mountain ranges at tectonic collision zones
    _draw_mountains(draw, ma)

    # ── Ice caps – timed from Scotese PALEOMAP glaciation record ────────────────
    if 2050 <= ma <= 2400:
        # Huronian (Paleoproterozoic) Snowball Earth — peaks ~2300 Ma
        frac  = clamp(1.0 - abs(ma - 2250) / 150.0, 0, 1)
        frac  = max(0.30, frac)              # always some ice in this interval
        cap_h = max(5, int(H_TEX * 0.08 + H_TEX * 0.38 * frac))
        draw.rectangle([0, 0,         W_TEX, cap_h],              fill=(*ICE_BRIGHT, 215))
        draw.rectangle([0, H_TEX - cap_h, W_TEX, H_TEX],         fill=(*ICE_DARK,   210))

    elif 635 <= ma <= 720:
        # Neoproterozoic Snowball Earth — ice grows as Ma decreases 720→635
        frac  = clamp((720 - ma) / 85.0, 0, 1)
        frac  = max(0.28, frac)              # visible from the first moment of Cryogenian
        cap_h = max(5, int(H_TEX * 0.08 + H_TEX * 0.40 * frac))
        draw.rectangle([0, 0,         W_TEX, cap_h],              fill=(*ICE_BRIGHT, 225))
        draw.rectangle([0, H_TEX - cap_h, W_TEX, H_TEX],         fill=(*ICE_DARK,   220))

    elif 435 <= ma <= 450:
        # Late Ordovician (Hirnantian) glaciation – Gondwana over South Pole; brief, intense
        frac  = 1.0 - abs(ma - 442.5) / 7.5   # peaks at 442.5 Ma
        cap_h = max(1, int(H_TEX * 0.02 + H_TEX * 0.08 * frac))
        draw.rectangle([0, H_TEX - cap_h, W_TEX, H_TEX], fill=(*ICE_BRIGHT, 195))

    elif 260 <= ma <= 360:
        # Carboniferous-Permian (Karoo) glaciation – Gondwana centred on S. Pole
        # Onset 360 Ma → peak ~300 Ma → termination 260 Ma (Scotese PALEOMAP)
        frac  = (360 - ma) / 60 if ma >= 300 else (ma - 260) / 40
        frac  = clamp(frac, 0.0, 1.0) ** 0.6   # quick onset, gradual retreat
        cap_h = max(1, int(H_TEX * 0.03 + H_TEX * 0.12 * frac))
        draw.rectangle([0, H_TEX - cap_h, W_TEX, H_TEX], fill=(*ICE_BRIGHT, 205))

    elif ma < 34:
        # Late Cenozoic glaciation (Eocene-Oligocene boundary, ~34 Ma, to present)
        if ma < 2.6:
            # Quaternary: both polar ice sheets
            cap_h = max(1, int(H_TEX * 0.03))
            draw.rectangle([0, 0, W_TEX, cap_h], fill=(*ICE_BRIGHT, 190))
            draw.rectangle([0, H_TEX - cap_h, W_TEX, H_TEX], fill=(*ICE_DARK, 185))
        else:
            # Oligocene–Pliocene: Antarctic ice sheet only (South Pole)
            frac  = clamp(1.0 - ma / 34.0, 0.0, 1.0)
            cap_h = max(1, int(H_TEX * 0.020 + H_TEX * 0.012 * frac))
            draw.rectangle([0, H_TEX - cap_h, W_TEX, H_TEX], fill=(*ICE_DARK, 172))

    raw = np.array(tex_img)

    # ── Scotese PALEOMAP: replaces polygon terrain for 0–750 Ma ─────────────
    # Textures are downloaded on first access and cached to disk.
    # For ma > 750 (deep Precambrian) we fall back to procedural terrain with
    # depth/noise enhancements.
    paleo = _scotese_tex(ma)
    if paleo is not None:
        raw[:, :, :3] = paleo
    else:
        # Deep Precambrian (ma > 750): procedural terrain only — add depth + noise
        r_ch       = raw[:, :, 0].astype(np.int16)
        g_ch       = raw[:, :, 1].astype(np.int16)
        b_ch       = raw[:, :, 2].astype(np.int16)
        ocean_mask = (b_ch - r_ch) > 35
        land_mask  = ~ocean_mask
        ice_mask   = (r_ch + g_ch + b_ch) > 630
        ocean_eff  = ocean_mask & ~ice_mask
        land_eff   = land_mask  & ~ice_mask

        coast_img  = Image.fromarray((land_eff.astype(np.uint8) * 255), "L")
        coast_prox = np.array(
            coast_img.filter(ImageFilter.GaussianBlur(radius=24)), dtype=np.float32
        ) / 255.0
        depth_dim  = np.where(ocean_eff, 0.42 + 0.58 * coast_prox, 1.0).astype(np.float32)
        raw[:, :, :3] = np.clip(
            raw[:, :, :3].astype(np.float32) * depth_dim[:, :, np.newaxis], 0, 255
        ).astype(np.uint8)

        if land_eff.any():
            noise  = _terrain_noise_for(ma)
            factor = np.where(land_eff, noise, 1.0).astype(np.float32)
            raw[:, :, :3] = np.clip(
                raw[:, :, :3].astype(np.float32) * factor[:, :, np.newaxis], 0, 255
            ).astype(np.uint8)

    # ── NASA Blue Marble blend (0–65 Ma) ─────────────────────────────────────
    bm_weight = 0.0
    if ma < 65 and isinstance(_bm_tex, np.ndarray):
        frac      = ma / 65.0
        bm_weight = 1.0 - frac * frac * (3.0 - 2.0 * frac)   # smoothstep 1→0
        if bm_weight > 0.004:
            displaced = _displaced_bm(frac)
            raw[:, :, :3] = np.clip(
                raw[:, :, :3].astype(np.float32) * (1.0 - bm_weight) +
                displaced.astype(np.float32) * bm_weight,
                0, 255,
            ).astype(np.uint8)

    # ── Cloud layer — every era, scrolled so each period has a unique pattern ─
    if isinstance(_cloud_tex, np.ndarray):
        scroll  = int(ma * 2.7) % W_TEX
        cld_arr = np.roll(_cloud_tex, scroll, axis=1)
        # Glaciation periods are cold and dry → much less cloud cover, making ice visible.
        # All other eras use era-appropriate opacity.
        if   635 <= ma <= 720:           cloud_opac = 0.18  # Neoproterozoic Snowball
        elif 2050 <= ma <= 2400:         cloud_opac = 0.20  # Huronian Snowball
        elif 435 <= ma <= 450:           cloud_opac = 0.28  # Ordovician glaciation
        elif 260 <= ma <= 360:           cloud_opac = 0.30  # Carboniferous-Permian glaciation
        elif ma < 2.6:                   cloud_opac = 0.38  # Quaternary ice age (cold/dry)
        elif ma < 65 and bm_weight > 0:  cloud_opac = max(0.48, bm_weight * 0.80)
        elif ma < 300:                   cloud_opac = 0.55  # Paleozoic / Mesozoic
        elif ma < 1000:                  cloud_opac = 0.58  # Proterozoic
        else:                            cloud_opac = 0.63  # Archean/Hadean — very humid
        cloud_alpha = cld_arr.astype(np.float32) / 255.0 * cloud_opac
        raw_f = raw[:, :, :3].astype(np.float32)
        raw[:, :, :3] = np.clip(
            raw_f * (1.0 - cloud_alpha[:, :, np.newaxis]) +
            255.0 * cloud_alpha[:, :, np.newaxis],
            0, 255,
        ).astype(np.uint8)

    return raw


# ── Precomputed projection tables (view-angle fixed, computed once) ────────────
# These are computed lazily on first call and reused for all frames.
_PROJ_TABLES: dict | None = None

def _build_proj_tables(R: int) -> dict:
    """Precompute per-pixel projection lookup tables for the fixed viewing angle."""
    D = R * 2
    yi, xi = np.mgrid[0:D, 0:D]
    nx = ((xi - R) / R).astype(np.float64)
    ny = ((R - yi) / R).astype(np.float64)
    r2 = nx * nx + ny * ny
    inside = r2 <= 1.0

    nxi = nx[inside]
    nyi = ny[inside]
    nzi = np.sqrt(np.maximum(0.0, 1.0 - nxi * nxi - nyi * nyi))

    # Inverse orthographic: pixel → lat/lon
    lat = np.arcsin(np.clip(nyi * _cos_lat0 + nzi * _sin_lat0, -1, 1))
    lon = _lon0_rad + np.arctan2(nxi, nzi * _cos_lat0 - nyi * _sin_lat0)

    # Texture sample indices (fixed since lon0/lat0 are fixed)
    tx = np.clip(((lon / (2 * math.pi) + 0.5) % 1.0 * W_TEX).astype(np.int32), 0, W_TEX - 1)
    ty = np.clip(((0.5 - lat / math.pi) * H_TEX).astype(np.int32), 0, H_TEX - 1)

    # Lambertian shading (also fixed)
    lx, ly, lz = 0.38, 0.52, 0.76
    shade_raw = np.clip(nxi * lx + nyi * ly + nzi * lz, 0, 1)
    # Darker night side (0.10 min) for Google Earth-like day/night contrast
    shade = (0.10 + 0.90 * shade_raw).astype(np.float32)

    # Atmospheric rim weight — start blending at r²=0.84 for a wider, softer limb
    r2_i    = (nxi * nxi + nyi * nyi).astype(np.float32)
    rim_t   = np.clip((r2_i - 0.84) / 0.16, 0, 1).astype(np.float32)

    # Combine shade + rim blend into single-pass coefficients so _ortho_project
    # needs only one float multiply + add over the inside pixels instead of three
    # separate boolean-index passes.
    #   rgb_final = tex_rgb * combined_factor + rim_add
    rim_blend       = rim_t * 0.80   # stronger limb glow (was 0.6)
    combined_factor = (shade * (1.0 - rim_blend)).astype(np.float32)
    atm             = np.array([80.0, 150.0, 255.0], dtype=np.float32)  # vivid blue
    rim_add         = (atm * rim_blend[:, np.newaxis]).astype(np.float32)

    return dict(inside=inside, tx=tx, ty=ty,
                combined_factor=combined_factor, rim_add=rim_add, D=D)


def _get_proj_tables(R: int) -> dict:
    global _PROJ_TABLES
    if _PROJ_TABLES is None:
        _PROJ_TABLES = _build_proj_tables(R)
    return _PROJ_TABLES


def _ortho_project(tex: np.ndarray, R: int) -> np.ndarray:
    """Project equirectangular texture onto sphere using precomputed tables."""
    p = _get_proj_tables(R)
    inside   = p["inside"]
    tx, ty   = p["tx"],  p["ty"]
    comb_f   = p["combined_factor"]
    rim_add  = p["rim_add"]
    D        = p["D"]

    # Sample texture directly into float, apply shade + rim in one pass
    sampled = tex[ty, tx]                              # (N, 4) uint8
    rgb = sampled[:, :3].astype(np.float32)
    rgb = np.clip(rgb * comb_f[:, np.newaxis] + rim_add, 0, 255).astype(np.uint8)

    # Single write to output array
    out = np.zeros((D, D, 4), dtype=np.uint8)
    out[inside, :3] = rgb
    out[inside,  3] = 255
    return out


def _ma_key(ma: float) -> int:
    return int(ma / CACHE_MA_STEP) * CACHE_MA_STEP


def _globe_key(ma: float) -> tuple:
    return (_ma_key(ma), round(GLOBE_LON0 / 5) * 5, round(GLOBE_LAT0 / 5) * 5)


def _get_tex(ma: float) -> np.ndarray:
    """Equirectangular texture for time ma — cached, view-angle independent."""
    key = _ma_key(ma)
    if key not in _tex_cache:
        if len(_tex_cache) >= _TEX_MAX:
            _tex_cache.pop(next(iter(_tex_cache)))
        _tex_cache[key] = _make_equirect_tex(ma)
    return _tex_cache[key]


def get_globe_surf(ma: float) -> pygame.Surface:
    """Projected, shaded globe surface — cached by (ma, view-angle)."""
    key = _globe_key(ma)
    if key not in _globe_cache:
        if len(_globe_cache) >= CACHE_MAX:
            _globe_cache.pop(next(iter(_globe_cache)))
        tex  = _get_tex(ma)
        proj = _ortho_project(tex, RENDER_R)
        base = Image.fromarray(proj, "RGBA")
        base = Image.alpha_composite(base, _get_specular())
        surf = pygame.image.fromstring(base.tobytes(), (GLOBE_D, GLOBE_D), "RGBA")
        _globe_cache[key] = surf.convert_alpha()
    return _globe_cache[key]


def _ll_to_globe_px(x_norm: float, y_norm: float):
    """Convert normalised equirect (0-1) coords to globe pixel (px, py).
    Returns None if the point is on the back hemisphere (not visible).
    """
    lon = x_norm * 2 * math.pi - math.pi
    lat = math.pi * 0.5 - y_norm * math.pi
    d_lon  = lon - _lon0_rad
    c_lat  = math.cos(lat)
    s_lat  = math.sin(lat)
    cos_c  = _sin_lat0 * s_lat + _cos_lat0 * c_lat * math.cos(d_lon)
    if cos_c < 0:
        return None
    sx = c_lat * math.sin(d_lon)
    sy = _cos_lat0 * s_lat - _sin_lat0 * c_lat * math.cos(d_lon)
    return int(GLOBE_R + GLOBE_R * sx), int(GLOBE_R - GLOBE_R * sy)


# ══════════════════════════════════════════════════════════════════════════════
# PYGAME ANIMATED OVERLAYS  (lava, particles — drawn each frame)
# ══════════════════════════════════════════════════════════════════════════════

def _overlay_lava(s, ma, t):
    if ma < 3800:
        return
    alpha = int(clamp((ma - 3800) / 500, 0, 1) * 200)
    if alpha < 8:
        return
    rng = random.Random(int(ma / 40))
    for _ in range(18):
        x1 = rng.randint(GLOBE_D//4, GLOBE_D*3//4)
        y1 = rng.randint(GLOBE_D//4, GLOBE_D*3//4)
        x2 = x1 + rng.randint(-70, 70)
        y2 = y1 + rng.randint(-60, 60)
        pa = int(alpha * (0.55 + 0.45 * math.sin(t * 3 + rng.random() * 6.28)))
        col = (*mix(LAVA_DARK, LAVA_HOT, rng.random()), pa)
        pygame.draw.line(s, col, (x1, y1), (x2, y2), 2)
    for _ in range(8):
        hx = rng.randint(20, GLOBE_D - 20)
        hy = rng.randint(20, GLOBE_D - 20)
        pa = int(alpha * (0.5 + 0.5 * math.sin(t * 2.5 + rng.random() * 5)))
        pygame.draw.circle(s, (*LAVA_HOT, pa), (hx, hy), rng.randint(4, 14))


def _overlay_particles(s, ma, t):
    d = get_diversity_at(ma)
    if d < 5:
        return
    log_frac = math.log10(max(d, 1)) / math.log10(MAX_DIVERSITY)
    n_total  = int(log_frac * 100)
    if n_total < 1:
        return
    continents = get_interpolated_continents(ma)
    if not continents:
        return
    rng = random.Random(int(ma // 12))
    per = max(1, n_total // len(continents))
    for c in continents:
        all_pts = [p for poly in c.get("polys", []) for p in poly]
        if not all_pts:
            continue
        cx_n = sum(p[0] for p in all_pts) / len(all_pts)
        cy_n = sum(p[1] for p in all_pts) / len(all_pts)
        sx_n = max(abs(p[0] - cx_n) for p in all_pts) * 0.80
        sy_n = max(abs(p[1] - cy_n) for p in all_pts) * 0.80
        for i in range(per):
            px = clamp(cx_n + rng.uniform(-sx_n, sx_n), 0.01, 0.99)
            py = clamp(cy_n + rng.uniform(-sy_n, sy_n), 0.01, 0.99)
            px += math.sin(t * 0.4 + i * 1.7) * 0.003
            py += math.cos(t * 0.55 + i * 2.3) * 0.003
            pos = _ll_to_globe_px(px, py)
            if pos is None:
                continue
            gx, gy = pos
            if (gx - GLOBE_R) ** 2 + (gy - GLOBE_R) ** 2 > (GLOBE_R * 0.94) ** 2:
                continue
            pulse = 0.45 + 0.55 * math.sin(t * 1.8 + i * 0.9)
            a  = int(90 + 140 * pulse)
            sz = 1 if d < 100_000 else (2 if d < 2_000_000 else 3)
            pygame.draw.circle(s, (*GREEN, a), (gx, gy), sz)


def _overlay_grid(s):
    lc = (200, 210, 230, 22)
    for frac in [1/6, 2/6, 3/6, 4/6, 5/6]:
        gv = int(frac * GLOBE_D)
        pygame.draw.line(s, lc, (gv, 0), (gv, GLOBE_D))
        pygame.draw.line(s, lc, (0, gv), (GLOBE_D, gv))
    eq = (200, 210, 230, 48)
    pygame.draw.line(s, eq, (0, GLOBE_R), (GLOBE_D, GLOBE_R))
    pygame.draw.line(s, eq, (GLOBE_R, 0), (GLOBE_R, GLOBE_D))


# ── Atmosphere glow ────────────────────────────────────────────────────────────
def draw_atmosphere(surf, ma):
    ac = atm_color(ma)
    R  = GLOBE_R
    # Eight-layer gradient produces a smooth, Google Earth-style limb halo.
    # Layers are ordered outermost→innermost; each alpha is additive because
    # SRCALPHA surfaces stack on the dark background.
    for offset, alpha in [(68, 4), (54, 9), (42, 16), (31, 26),
                          (21, 38), (13, 54), (6, 74), (2, 50)]:
        gr = R + offset
        gs = pygame.Surface((gr * 2, gr * 2), pygame.SRCALPHA)
        pygame.draw.circle(gs, (*ac, alpha), (gr, gr), gr)
        surf.blit(gs, (GLOBE_CX - gr, GLOBE_CY - gr))


# ── Stars ──────────────────────────────────────────────────────────────────────
def draw_stars(surf, t):
    for sx, sy, br, phase in STARS:
        dx, dy = sx - GLOBE_CX, sy - GLOBE_CY
        if dx * dx + dy * dy < (GLOBE_R + 50) ** 2:
            continue
        twinkle = 0.60 + 0.40 * math.sin(t * 1.1 + phase)
        c = int(br * twinkle * 255)
        if br > 0.82:
            pygame.draw.line(surf, (c,c,c), (sx-2, sy), (sx+2, sy))
            pygame.draw.line(surf, (c,c,c), (sx, sy-2), (sx, sy+2))
        else:
            pygame.draw.circle(surf, (c,c,c), (sx, sy), 1 if br < 0.5 else 2)


# ── Diversity graph ────────────────────────────────────────────────────────────
def _build_graph(w, h):
    s = pygame.Surface((w, h), pygame.SRCALPHA)
    s.fill((0, 0, 0, 0))
    ax, ay = 42, 10
    gw = w - ax - 8
    gh = h - ay - 28

    pygame.draw.rect(s, (*PANEL, 210), (ax, ay, gw, gh), border_radius=4)
    for yi in range(5):
        gy = ay + int(gh * yi / 4)
        pygame.draw.line(s, (*BORDER, 90), (ax, gy), (ax + gw, gy))

    pts = []
    ma_s = DIVERSITY[0][0]
    for px in range(gw):
        ma  = ma_s * (1 - px / (gw - 1))
        d   = get_diversity_at(ma)
        ld  = math.log10(max(d, 1)) / math.log10(MAX_DIVERSITY)
        py  = ay + gh - int(gh * ld)
        pts.append((ax + px, clamp(py, ay, ay + gh)))

    if len(pts) > 1:
        pygame.draw.polygon(s, (*GREEN2, 28), [(ax, ay+gh)] + pts + [(ax+gw, ay+gh)])
        pygame.draw.lines(s, (*GREEN, 55), False, pts, 3)
        pygame.draw.lines(s, (*GREEN, 185), False, pts, 1)

    for ext_ma, label in [(444,"O"),(359,"D"),(252,"P"),(201,"Tr"),(66,"K")]:
        frac = 1 - ext_ma / ma_s
        ex   = ax + int(frac * gw)
        pygame.draw.line(s, (*RED, 150), (ex, ay), (ex, ay + gh), 1)
        ls = F_XS.render(label, True, (*RED, 210))
        s.blit(ls, (ex + 2, ay + 3))

    for yi, lab in enumerate(["1","1k","1M","8.7M"]):
        ly = ay + gh - int(gh * yi / 3)
        ls = F_XS.render(lab, True, GRAY)
        s.blit(ls, (2, ly - 6))
    for tick_ma in [4000, 3000, 2000, 1000, 500, 0]:
        frac = 1 - tick_ma / ma_s
        tx   = ax + int(frac * gw)
        pygame.draw.line(s, BORDER, (tx, ay+gh), (tx, ay+gh+5))
        tl = F_XS.render(str(tick_ma), True, GRAY)
        s.blit(tl, (tx - tl.get_width()//2, ay+gh+7))
    pygame.draw.line(s, BORDER2, (ax, ay), (ax, ay+gh), 1)
    pygame.draw.line(s, BORDER2, (ax, ay+gh), (ax+gw, ay+gh), 1)
    return s, ax, ay, gw, gh, DIVERSITY[0][0]


def draw_info_panel(surf, ma):
    gw_p = INFO_W - 4
    gh_p = INFO_H // 2 - 4
    panel(surf, pygame.Rect(INFO_X+2, INFO_Y+2, gw_p, gh_p), color=PANEL2, bcolor=BORDER)

    key = (gw_p, gh_p)
    if key not in _graph_cache:
        _graph_cache[key] = _build_graph(gw_p, gh_p)
    gs, ax, ay, gw, gh, ma_s = _graph_cache[key]
    surf.blit(gs, (INFO_X+2, INFO_Y+2))

    frac = 1 - ma / ma_s
    cxg  = INFO_X + 2 + ax + int(frac * gw)
    pygame.draw.line(surf, GOLD2, (cxg, INFO_Y+2+ay), (cxg, INFO_Y+2+ay+gh), 2)
    d   = get_diversity_at(ma)
    ld  = math.log10(max(d, 1)) / math.log10(MAX_DIVERSITY)
    cyg = INFO_Y + 2 + ay + gh - int(gh * ld)
    pygame.draw.circle(surf, GOLD2, (cxg, cyg), 5)
    pygame.draw.circle(surf, WHITE, (cxg, cyg), 3)
    txt(surf, "SPECIES DIVERSITY  (log scale)", F_SM, LGRAY, INFO_X+2+ax+2, INFO_Y+4)
    txt(surf, f"~{fmt_species(d)}", F_LG, GREEN, INFO_X+INFO_W-6, INFO_Y+4, right=True)

    py0 = INFO_Y + INFO_H // 2 + 2
    panel(surf, pygame.Rect(INFO_X+2, py0, INFO_W-4, INFO_H//2-2), color=PANEL2, bcolor=BORDER)

    p = get_period_at(ma)
    y = py0 + 10

    badge = pygame.Rect(INFO_X+10, y, INFO_W-20, 22)
    pygame.draw.rect(surf, p["color"], badge, border_radius=4)
    bright = tuple(min(255, c+50) for c in p["color"])
    pygame.draw.rect(surf, bright, badge, width=1, border_radius=4)
    eon_lbl = f"{p['eon']}  *  {p['era']}" if p["era"] not in ("-","—") else p["eon"]
    txt(surf, eon_lbl, F_SM, WHITE, INFO_X+INFO_W//2, y+3, center=True)
    y += 30

    txt(surf, p["name"], F_PERIOD, WHITE, INFO_X+INFO_W//2, y, center=True)
    y += 30

    s_str = f"{int(p['start'])} Ma" if p["start"] < 1000 else f"{p['start']/1000:.1f} Ga"
    e_str = f"{int(p['end'])} Ma"   if p["end"] > 0      else "present"
    txt(surf, f"{s_str}  to  {e_str}", F_SM, GRAY, INFO_X+INFO_W//2, y, center=True)
    y += 20

    txt(surf, p["desc"], F_MD, GOLD, INFO_X+INFO_W//2, y, center=True)
    y += 24

    # Climate state badge (Scotese 2021 paleoclimate)
    cs      = _climate_state(ma)
    cs_cols = {"HOTHOUSE": (210,72,28), "GREENHOUSE": (188,122,28),
               "MODERATE": (52,122,58), "COOL": (38,98,172),
               "ICEHOUSE": (68,128,215), "GLACIAL": (148,175,250)}
    cs_col  = cs_cols.get(cs, GRAY)
    pygame.draw.rect(surf, cs_col, pygame.Rect(INFO_X+10, y, INFO_W-20, 16), border_radius=4)
    txt(surf, cs, F_XS, WHITE, INFO_X + INFO_W // 2, y + 2, center=True)
    y += 22

    pygame.draw.line(surf, BORDER, (INFO_X+14, y), (INFO_X+INFO_W-14, y))
    y += 10

    words = p["event"].split()
    lines, line = [], ""
    for w in words:
        if len(line) + len(w) + 1 <= 36:
            line += ("" if not line else " ") + w
        else:
            lines.append(line); line = w
    if line: lines.append(line)
    for ln in lines[:3]:
        txt(surf, ln, F_SM, LGRAY, INFO_X+12, y); y += 17

    y += 8
    bw = INFO_W - 24

    # O2 bar
    txt(surf, "O₂", F_SM, GRAY, INFO_X+12, y)
    o2 = o2_frac(ma)
    oc = mix((28, 88, 200), (110, 210, 255), o2)
    txt(surf, f"{o2*21:.1f}%", F_SM, oc, INFO_X + 34, y)
    pygame.draw.rect(surf, DGRAY, pygame.Rect(INFO_X+10, y+14, bw, 7), border_radius=3)
    fw = max(2, int(bw * o2))
    pygame.draw.rect(surf, oc, pygame.Rect(INFO_X+10, y+14, fw, 7), border_radius=3)
    y += 26

    # CO2 bar (log scale: 240 ppm → 500 000 ppm)
    co2      = co2_ppm(ma)
    co2_norm = clamp((math.log10(max(co2, 1)) - 2.38) / 3.32, 0, 1)
    co2_str  = (f"{co2:.0f} ppm"      if co2 <  10_000 else
                f"{co2/1000:.0f}k ppm" if co2 < 100_000 else
                f"{co2/1000:.0f}k ppm")
    co2_col  = mix((48, 195, 72), (225, 88, 22), co2_norm)   # green → orange
    txt(surf, "CO₂", F_SM, GRAY, INFO_X+12, y)
    txt(surf, co2_str, F_SM, co2_col, INFO_X + 38, y)
    pygame.draw.rect(surf, DGRAY, pygame.Rect(INFO_X+10, y+14, bw, 7), border_radius=3)
    fw_co2 = max(2, int(bw * co2_norm))
    pygame.draw.rect(surf, co2_col, pygame.Rect(INFO_X+10, y+14, fw_co2, 7), border_radius=3)
    y += 26

    # Global temperature
    temp    = global_temp_c(ma)
    t_norm  = clamp((temp + 10) / 115.0, 0, 1)   # −10 °C → 105 °C
    t_col   = mix((60, 140, 255), (255, 55, 18), t_norm)
    txt(surf, "Temp", F_SM, GRAY, INFO_X+12, y)
    txt(surf, f"{temp:.0f}°C", F_SM, t_col, INFO_X + 50, y)
    pygame.draw.rect(surf, DGRAY, pygame.Rect(INFO_X+10, y+14, bw, 7), border_radius=3)
    fw_t = max(2, int(bw * t_norm))
    pygame.draw.rect(surf, t_col, pygame.Rect(INFO_X+10, y+14, fw_t, 7), border_radius=3)
    y += 26

    # Tree of Life button
    global _tol_btn_rect
    y += 4
    _tol_btn_rect = pygame.Rect(INFO_X + 6, y, INFO_W - 12, 24)
    pygame.draw.rect(surf, (18, 55, 36), _tol_btn_rect, border_radius=5)
    pygame.draw.rect(surf, (55, 140, 85), _tol_btn_rect, 1, border_radius=5)
    txt(surf, "TREE OF LIFE  [T]", F_SM, (90, 210, 140),
        INFO_X + INFO_W // 2, y + 4, center=True)
    y += 30

    if event_queue:
        txt(surf, "RECENT EVENTS", F_XS, GRAY, INFO_X+12, y); y += 13
        for et, _ in event_queue[:3]:
            txt(surf, f"> {et[:38]}", F_XS, CYAN, INFO_X+14, y); y += 13


# ── Timeline ───────────────────────────────────────────────────────────────────
def draw_timeline(surf, ma):
    panel(surf, pygame.Rect(TL_X, TL_Y, TL_W, TL_H), color=PANEL, bcolor=BORDER)
    ix, iw = TL_X + 10, TL_W - 20
    bar_y, bar_h = TL_Y + 36, 20

    for p in PERIODS:
        fs = 1 - p["start"] / START_MA
        fe = 1 - p["end"]   / START_MA
        px = ix + int(fs * iw); pw = max(1, int((fe - fs) * iw))
        pygame.draw.rect(surf, p["color"], (px, bar_y, pw, bar_h))
        if pw > 35:
            ls = F_XS.render(p["name"], True, WHITE)
            if ls.get_width() < pw - 4:
                surf.blit(ls, (px + (pw - ls.get_width())//2, bar_y+4))

    for ename, es, ee in [("Hadean",4500,4000),("Archean",4000,2500),
                           ("Proterozoic",2500,538),("Phanerozoic",538,0)]:
        fs = 1 - es/START_MA; fe = 1 - ee/START_MA
        ex = ix+int(fs*iw); ew = max(2, int((fe-fs)*iw))
        pygame.draw.line(surf, BORDER2, (ex, bar_y-2), (ex, bar_y+bar_h+14), 1)
        el = F_XS.render(ename, True, LGRAY)
        if el.get_width() < ew-6:
            surf.blit(el, (ex+(ew-el.get_width())//2, bar_y+bar_h+4))

    for tick_ma in range(0, 4501, 500):
        frac = 1 - tick_ma/START_MA; tx = ix+int(frac*iw)
        pygame.draw.line(surf, BORDER2, (tx, bar_y-10), (tx, bar_y), 1)
        tl = F_XS.render(str(tick_ma) if tick_ma else "0", True, GRAY)
        surf.blit(tl, (tx-tl.get_width()//2, bar_y-22))

    cf = 1 - ma/START_MA; cx = ix+int(cf*iw)
    pygame.draw.line(surf, GOLD2, (cx, TL_Y+5), (cx, TL_Y+TL_H-5), 2)
    pygame.draw.polygon(surf, GOLD2, [(cx,TL_Y+5),(cx-6,TL_Y+16),(cx+6,TL_Y+16)])
    ls = F_SM.render(fmt_ma(ma), True, GOLD2)
    lx = clamp(cx-ls.get_width()//2, TL_X+2, TL_X+TL_W-ls.get_width()-2)
    surf.blit(ls, (lx, TL_Y+4))


# ── Header ─────────────────────────────────────────────────────────────────────
def draw_header(surf, ma):
    surf.fill(PANEL2, pygame.Rect(0, 0, W, HDR_H))
    pygame.draw.line(surf, BORDER, (0, HDR_H-1), (W, HDR_H-1))
    p = get_period_at(ma)
    txt(surf, "EARTH HISTORY SIMULATOR", F_TITLE, WHITE, PAD+4, 12)
    txt(surf, fmt_ma(ma), F_LG, GOLD, W//2, 18, center=True)
    txt(surf, f"{p['eon']}  *  {p['name']}", F_LG, WHITE, W-PAD, 10, right=True)
    spd = "|| PAUSED" if paused else f"Speed: {SPEEDS[speed_idx]} Ma/s"
    txt(surf, spd, F_SM, GRAY, W-PAD, 36, right=True)
    txt(surf, "SPACE=pause   </>=speed   R=reset   G=grid   T=tree of life   drag globe=rotate   click timeline=jump",
        F_XS, GRAY, PAD+4, HDR_H-15)


# ── Event overlay ──────────────────────────────────────────────────────────────
def draw_events(surf):
    ey = SPACE_Y + 12
    for et, ttl in event_queue[:4]:
        a = min(255, ttl * 4)
        s = F_MD.render(f"* {et[:52]}", True, CYAN)
        s.set_alpha(a)
        surf.blit(s, (SPACE_X + SPACE_W - s.get_width() - 14, ey))
        ey += 22


# ── Tree of Life overlay ────────────────────────────────────────────────────────
def _tol_get_layout() -> dict:
    """Compute normalised Y positions (0–1) for all TOL nodes. Cached."""
    global _tol_layout_cache
    if _tol_layout_cache is not None:
        return _tol_layout_cache

    children_map: dict = {n[0]: [] for n in _TOL_DATA}
    for n in _TOL_DATA:
        if n[3] is not None:
            children_map[n[3]].append(n[0])

    def dfs(nid):
        kids = children_map[nid]
        return [nid] if not kids else [x for k in kids for x in dfs(k)]

    leaves = dfs("luca")
    n_leaves = len(leaves)
    leaf_y = {leaf: (i + 0.5) / n_leaves for i, leaf in enumerate(leaves)}

    y_pos: dict = {}

    def compute(nid):
        if nid in leaf_y:
            y_pos[nid] = leaf_y[nid]
            return leaf_y[nid]
        ys = [compute(c) for c in children_map[nid]]
        v = sum(ys) / len(ys) if ys else 0.5
        y_pos[nid] = v
        return v

    compute("luca")
    _tol_layout_cache = y_pos
    return y_pos


def draw_tree_of_life(surf: pygame.Surface, current_ma: float) -> pygame.Rect:
    """Draw full-screen tree-of-life overlay. Returns the close-button Rect."""
    Ws, Hs = surf.get_size()
    surf.fill((5, 8, 16))

    ML, MR, MT, MB = 18, 165, 72, 46
    TW = Ws - ML - MR
    TH = Hs - MT - MB
    MA_RANGE = 4000.0

    def _x(ma: float) -> int:
        return ML + int((MA_RANGE - max(0.0, min(float(ma), MA_RANGE))) / MA_RANGE * TW)

    # Era background bands
    for b_start, b_end, b_col, b_lbl in (
        (4000, 2500, (11, 14, 28), "Archean"),
        (2500,  541, (11, 17, 26), "Proterozoic"),
        ( 541,  252, (13, 19, 27), "Paleozoic"),
        ( 252,   66, (13, 22, 24), "Mesozoic"),
        (  66,    0, (13, 22, 20), "Cenozoic"),
    ):
        bx1, bx2 = _x(b_start), _x(b_end)
        pygame.draw.rect(surf, b_col, (bx1, MT, bx2 - bx1, TH))
        bl = F_XS.render(b_lbl, True, (55, 65, 88))
        surf.blit(bl, (bx1 + 4, MT + 4))

    # Vertical guide lines + Ma axis labels
    for tick in (4000, 3500, 3000, 2500, 2000, 1500, 1000, 500, 250, 100, 0):
        gx = _x(tick)
        pygame.draw.line(surf, (20, 26, 44), (gx, MT), (gx, MT + TH))
        tl = F_XS.render(str(tick), True, (68, 72, 98))
        surf.blit(tl, (gx - tl.get_width() // 2, MT + TH + 4))

    ax = F_SM.render("Million Years Ago (Ma)", True, (85, 95, 125))
    surf.blit(ax, (Ws // 2 - ax.get_width() // 2, MT + TH + 21))

    # Title + subtitle
    ht = F_PERIOD.render("TREE OF LIFE", True, (170, 225, 170))
    surf.blit(ht, (Ws // 2 - ht.get_width() // 2, 12))
    st = F_SM.render(
        "Evolutionary history  |  branches grow as geological time progresses  |  [T] to close",
        True, (90, 110, 90))
    surf.blit(st, (Ws // 2 - st.get_width() // 2, 46))

    # Build look-up tables
    node_dict = {n[0]: n for n in _TOL_DATA}
    children_map: dict = {n[0]: [] for n in _TOL_DATA}
    for n in _TOL_DATA:
        if n[3] is not None:
            children_map[n[3]].append(n[0])

    y_frac = _tol_get_layout()
    label_internal = {"luca", "bacteria", "eukarya", "animalia", "plantae",
                      "amniota", "tetrapoda", "mammalia", "chordata", "archosaur"}

    def draw_node(nid: str) -> None:
        _, label, node_ma, parent_id, color, extinct_ma = node_dict[nid]
        yc = int(MT + y_frac[nid] * TH)
        x0 = _x(node_ma)
        appeared = current_ma <= node_ma

        if not appeared:
            pygame.draw.circle(surf, (28, 32, 48), (x0, yc), 2)
            return

        ext_happened = extinct_ma > 0 and current_ma <= extinct_ma
        if ext_happened:
            x1     = _x(extinct_ma)
            line_c = (color[0] * 2 // 3, color[1] * 2 // 3, color[2] * 2 // 3)
        else:
            x1     = _x(current_ma)
            line_c = color

        if x1 > x0:
            pygame.draw.line(surf, line_c, (x0, yc), (x1, yc), 2)
        pygame.draw.circle(surf, line_c, (x0, yc), 3)

        # Vertical connector to parent branch point
        if parent_id is not None and current_ma <= node_dict[parent_id][2]:
            py = int(MT + y_frac[parent_id] * TH)
            pygame.draw.line(surf, line_c, (x0, py), (x0, yc), 2)

        # Extinction cross marker
        if ext_happened:
            ex = _x(extinct_ma)
            pygame.draw.line(surf, (220, 80, 80), (ex - 4, yc - 4), (ex + 4, yc + 4), 2)
            pygame.draw.line(surf, (220, 80, 80), (ex + 4, yc - 4), (ex - 4, yc + 4), 2)

        # Labels: leaf nodes in right margin; key internal nodes above branch point
        is_leaf = not children_map[nid]
        if is_leaf:
            lx = (ML + TW + 5) if not ext_happened else (_x(extinct_ma) + 6)
            lbl = F_XS.render(label, True, line_c)
            surf.blit(lbl, (lx, yc - lbl.get_height() // 2))
        elif nid in label_internal:
            lbl = F_XS.render(label, True, tuple(min(255, c + 60) for c in color))
            surf.blit(lbl, (x0 - lbl.get_width() - 3, yc - lbl.get_height() - 1))

    for n in _TOL_DATA:
        draw_node(n[0])

    # Current-time cursor line
    cx = _x(current_ma)
    pygame.draw.line(surf, (255, 210, 55), (cx, MT - 12), (cx, MT + TH + 2), 2)
    cl = F_SM.render(f"{int(current_ma):,} Ma", True, (255, 210, 55))
    surf.blit(cl, (clamp(cx - cl.get_width() // 2, ML, Ws - MR - cl.get_width()), MT - 28))

    # Close button
    close_r = pygame.Rect(Ws - 112, 10, 100, 28)
    hover_col = (90, 30, 30) if close_r.collidepoint(pygame.mouse.get_pos()) else (55, 18, 18)
    pygame.draw.rect(surf, hover_col, close_r, border_radius=5)
    pygame.draw.rect(surf, (190, 70, 70), close_r, 1, border_radius=5)
    cl2 = F_SM.render("CLOSE  [T]", True, (220, 110, 110))
    surf.blit(cl2, (close_r.centerx - cl2.get_width() // 2,
                    close_r.centery - cl2.get_height() // 2))
    return close_r


# ── Tick ───────────────────────────────────────────────────────────────────────
def tick(dt):
    global current_ma, prev_period, event_queue, anim_t, _spin_lon, _spin_lat
    if not paused:
        current_ma -= SPEEDS[speed_idx] * dt
        if current_ma < END_MA:
            current_ma = END_MA
    anim_t += dt

    # Globe spin inertia: keep rotating after drag release, decay exponentially
    if not _drag_active and (abs(_spin_lon) > 0.3 or abs(_spin_lat) > 0.3):
        _set_view(GLOBE_LON0 + _spin_lon * dt, GLOBE_LAT0 + _spin_lat * dt)
        decay = math.exp(-3.5 * dt)
        _spin_lon *= decay
        _spin_lat *= decay

    event_queue = [[t, f-1] for t, f in event_queue if f > 1]
    p = get_period_at(current_ma)
    if p["name"] != prev_period:
        prev_period = p["name"]
        event_queue.insert(0, [p["event"][:60], 320])
    return current_ma <= END_MA


# ── Main ───────────────────────────────────────────────────────────────────────
def main():
    global current_ma, paused, speed_idx, last_t, show_grid, event_queue
    global _drag_active, _drag_prev, _spin_lon, _spin_lat
    global _show_tree, _tol_close_rect

    # Show a loading screen while downloading / reading the Blue Marble (~8 MB).
    screen.fill(BG)
    txt(screen, "Earth History Simulator", F_TITLE, WHITE, W // 2, HDR_H // 2, center=True)
    txt(screen, "Loading Earth textures…",  F_PERIOD, LGRAY, W // 2, H // 2 - 12, center=True)
    txt(screen, "First run downloads NASA Blue Marble (~2 MB) + cloud layer (~1 MB)",
        F_SM, GRAY, W // 2, H // 2 + 22, center=True)
    pygame.display.flip()
    pygame.event.pump()
    _init_blue_marble()

    while True:
        now = _time.perf_counter()
        dt  = min(now - last_t, 0.08)
        last_t = now

        for ev in pygame.event.get():
            if ev.type == pygame.QUIT:
                pygame.quit(); sys.exit()
            elif ev.type == pygame.KEYDOWN:
                if ev.key == pygame.K_t:
                    _show_tree = not _show_tree
                elif ev.key == pygame.K_ESCAPE:
                    if _show_tree: _show_tree = False
                    else: pygame.quit(); sys.exit()
                elif not _show_tree:
                    if   ev.key == pygame.K_SPACE:  paused = not paused
                    elif ev.key == pygame.K_RIGHT:  speed_idx = min(speed_idx+1, len(SPEEDS)-1)
                    elif ev.key == pygame.K_LEFT:   speed_idx = max(speed_idx-1, 0)
                    elif ev.key == pygame.K_r:
                        current_ma = START_MA; event_queue.clear()
                        _set_view(_INIT_LON, _INIT_LAT); _spin_lon = _spin_lat = 0.0
                    elif ev.key in (pygame.K_g, pygame.K_SLASH): show_grid = not show_grid
            elif ev.type == pygame.MOUSEBUTTONDOWN and ev.button == 1:
                _px, _py = ev.pos
                if _show_tree:
                    if _tol_close_rect and _tol_close_rect.collidepoint(_px, _py):
                        _show_tree = False
                else:
                    if _tol_btn_rect and _tol_btn_rect.collidepoint(_px, _py):
                        _show_tree = True
                    else:
                        gx, gy = _px - GLOBE_CX, _py - GLOBE_CY
                        if gx * gx + gy * gy <= GLOBE_R * GLOBE_R:
                            _drag_active = True
                            _drag_prev   = (_px, _py)
                            _spin_lon = _spin_lat = 0.0
                        elif TL_Y < _py < TL_Y + TL_H:
                            frac = clamp((_px - TL_X-10) / (TL_W-20), 0, 1)
                            current_ma = START_MA * (1 - frac); event_queue.clear()
            elif ev.type == pygame.MOUSEBUTTONUP and ev.button == 1:
                _drag_active = False
            elif ev.type == pygame.MOUSEMOTION:
                if not _show_tree and _drag_active and ev.buttons[0]:
                    _px, _py = ev.pos
                    dmx = _px - _drag_prev[0]
                    dmy = _py - _drag_prev[1]
                    _drag_prev = (_px, _py)
                    dps = 180.0 / GLOBE_R   # degrees per screen pixel
                    if (dmx or dmy) and dt > 0.001:
                        _spin_lon = -dmx * dps / dt
                        _spin_lat = -dmy * dps / dt
                    _set_view(GLOBE_LON0 - dmx * dps, GLOBE_LAT0 - dmy * dps)

        done = tick(dt)

        # ── Draw ────────────────────────────────────────────────────────────
        screen.fill(BG)
        draw_stars(screen, anim_t)
        draw_atmosphere(screen, current_ma)

        # High-quality PIL globe (cached)
        screen.blit(get_globe_surf(current_ma),
                    (GLOBE_CX - GLOBE_R, GLOBE_CY - GLOBE_R))

        # Animated pygame overlay (lava, particles, grid)
        _overlay_surf.fill((0, 0, 0, 0))
        _overlay_lava(_overlay_surf, current_ma, anim_t)
        _overlay_particles(_overlay_surf, current_ma, anim_t)
        if show_grid:
            _overlay_grid(_overlay_surf)
        _overlay_surf.blit(_overlay_mask, (0, 0), special_flags=pygame.BLEND_RGBA_MIN)
        screen.blit(_overlay_surf, (GLOBE_CX - GLOBE_R, GLOBE_CY - GLOBE_R))

        # Globe border ring
        pygame.draw.circle(screen, BORDER2, (GLOBE_CX, GLOBE_CY), GLOBE_R, 2)
        pygame.draw.rect(screen, BORDER,
                         pygame.Rect(SPACE_X, SPACE_Y, SPACE_W, SPACE_H),
                         width=1, border_radius=8)

        draw_info_panel(screen, current_ma)
        draw_events(screen)
        draw_timeline(screen, current_ma)
        draw_header(screen, current_ma)

        if done:
            s = F_PERIOD.render("-- Reached Present Day --", True, GOLD2)
            s.set_alpha(200)
            screen.blit(s, (W//2 - s.get_width()//2, GLOBE_CY - 14))

        if _show_tree:
            _tol_close_rect = draw_tree_of_life(screen, current_ma)

        pygame.display.flip()
        clock.tick(60)


if __name__ == "__main__":
    main()
