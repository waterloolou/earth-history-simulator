#!/usr/bin/env python3
"""
Earth History Simulator
========================
Simulates 4.3 billion years of Earth history:
  • Continental drift through geological eons
  • Species diversification and mass extinctions
  • Geological period labels and key events

Controls
--------
  SPACE       - Pause / Resume
  LEFT/RIGHT  - Slow down / Speed up simulation
  R           - Reset to the beginning (4.3 Ga)
  G           - Toggle lat/lon grid
  Mouse click on timeline - Jump to that point in time
"""

import pygame
import sys
import math
import time as _time
import random

from data import (
    PERIODS, DIVERSITY, MAX_DIVERSITY,
    get_period_at, get_diversity_at, get_continents_at,
)

pygame.init()

# ── Window ────────────────────────────────────────────────────────────────────
W, H = 1400, 860
screen = pygame.display.set_mode((W, H), pygame.DOUBLEBUF)
pygame.display.set_caption("Earth History Simulator")
clock = pygame.time.Clock()

# ── Fonts ─────────────────────────────────────────────────────────────────────
def _mfont(size, bold=False):
    for face in ("segoeui", "calibri", "arial", None):
        try:
            f = pygame.font.SysFont(face, size, bold=bold)
            if f:
                return f
        except Exception:
            pass
    return pygame.font.Font(None, size)

F_TITLE  = _mfont(36, bold=True)
F_PERIOD = _mfont(26, bold=True)
F_LG     = _mfont(20, bold=True)
F_MD     = _mfont(16)
F_SM     = _mfont(13)
F_XS     = _mfont(11)

# ── Layout ────────────────────────────────────────────────────────────────────
HDR_H   = 62      # top header
TL_H    = 108     # bottom timeline strip
PAD     = 12

MAP_X   = PAD
MAP_Y   = HDR_H + PAD
MAP_W   = 890
MAP_H   = H - HDR_H - TL_H - 3 * PAD

INFO_X  = MAP_X + MAP_W + PAD
INFO_Y  = MAP_Y
INFO_W  = W - INFO_X - PAD
INFO_H  = MAP_H

TL_X    = PAD
TL_Y    = H - TL_H - PAD
TL_W    = W - 2 * PAD

# ── Palette ───────────────────────────────────────────────────────────────────
BG          = ( 6,  10,  25)
PANEL       = (13,  18,  40)
PANEL2      = (18,  24,  52)
BORDER      = (38,  48,  88)
BORDER2     = (55,  70, 120)
WHITE       = (255, 255, 255)
LGRAY       = (175, 180, 200)
GRAY        = ( 95, 100, 128)
GOLD        = (220, 185,  55)
GOLD2       = (255, 215,  80)
RED         = (235,  65,  55)
GREEN       = ( 68, 208,  95)
BLUE        = ( 68, 142, 232)
CYAN        = ( 55, 215, 225)
OCEAN_DARK  = ( 12,  38,  88)
OCEAN_MID   = ( 18,  58, 118)
OCEAN_LIGHT = ( 26,  82, 152)
LAVA        = (210,  72,  18)
LAVA2       = (255, 140,  20)
ICE         = (195, 222, 252)

# ── Simulation state ──────────────────────────────────────────────────────────
START_MA     = 4300.0
END_MA       = 0.0

SPEEDS       = [5, 15, 40, 100, 250, 600, 1500]   # Ma per real second
speed_idx    = 3
current_ma   = float(START_MA)
paused       = False
last_t       = _time.perf_counter()
wave_t       = 0.0
star_seed    = random.Random(99)
stars        = [(star_seed.randint(0, W), star_seed.randint(0, H // 4),
                 star_seed.random()) for _ in range(180)]

# Recent geological events displayed on screen
event_queue  = []           # list of [text, ttl_frames]
prev_period  = ""


# ── Utility ───────────────────────────────────────────────────────────────────
def lerp(a, b, t):
    return a + (b - a) * t

def clamp(v, lo, hi):
    return max(lo, min(hi, v))

def mix(c1, c2, t):
    return tuple(int(lerp(c1[i], c2[i], t)) for i in range(3))

def panel(surf, rect, color=PANEL, bcolor=BORDER, r=8):
    pygame.draw.rect(surf, color, rect, border_radius=r)
    pygame.draw.rect(surf, bcolor, rect, width=1, border_radius=r)

def txt(surf, text, fnt, color, x, y, center=False, right=False):
    s = fnt.render(str(text), True, color)
    if center:
        x -= s.get_width() // 2
    elif right:
        x -= s.get_width()
    surf.blit(s, (x, y))
    return s.get_width(), s.get_height()

def fmt_ma(ma):
    if ma < 0.001:
        return "Present Day"
    if ma < 1:
        return f"{ma * 1000:.0f} thousand years ago"
    if ma < 10:
        return f"{ma:.2f} Ma ago"
    if ma < 100:
        return f"{ma:.1f} Ma ago"
    if ma < 1000:
        return f"{ma:.0f} Ma ago"
    return f"{ma / 1000:.3f} Ga ago"

def fmt_species(n):
    if n < 1000:
        return str(n)
    if n < 1_000_000:
        return f"{n / 1000:.1f}k"
    return f"{n / 1_000_000:.2f}M"

def atmosphere_color(ma):
    """Sky/atmosphere color evolves with O2 level."""
    if ma > 4000:       # Hadean magma ocean
        return (60, 25, 12)
    if ma > 3500:       # Early archean — CO2/N2 sky
        return (40, 28, 18)
    if ma > 2400:       # Archean murky
        return (28, 32, 42)
    if ma > 1800:       # GOE happening
        return (22, 38, 62)
    if ma > 700:        # Proterozoic pale blue
        return (18, 48, 85)
    if ma > 350:        # Phanerozoic, low O2
        return (15, 52, 100)
    # Modern-ish deep blue
    return (12, 55, 110)


# ── Stars (for Hadean/early epochs) ───────────────────────────────────────────
def draw_stars(surf, ma):
    alpha = clamp(int((ma - 2000) / 2000 * 255), 0, 255)
    if alpha < 4:
        return
    for sx, sy, br in stars:
        if sy < HDR_H + MAP_H + PAD:
            c = int(br * alpha)
            pygame.draw.circle(surf, (c, c, c), (sx, sy), 1)


# ── Map rendering ─────────────────────────────────────────────────────────────
def map_rect():
    return pygame.Rect(MAP_X, MAP_Y, MAP_W, MAP_H)

def draw_ocean(surf, ma):
    mr = map_rect()
    # Ocean color evolves — early Earth is lava/dark, then brightens
    if ma > 4200:
        oc = mix(LAVA, (80, 20, 10), 0.5)
    elif ma > 3800:
        t = (4200 - ma) / 400
        oc = mix(LAVA, OCEAN_DARK, t)
    else:
        t = clamp((3800 - ma) / 3800, 0, 1)
        oc = mix(OCEAN_DARK, OCEAN_MID, t * 0.6)

    # Background fill
    surf.fill(oc, mr)

    # Animated wave shimmer (for post-Hadean)
    if ma < 3800:
        for row in range(0, MAP_H, 8):
            phase = (row * 0.04 + wave_t * 2) % (2 * math.pi)
            intensity = int(12 + 8 * math.sin(phase))
            col = tuple(clamp(oc[i] + intensity - 6, 0, 255) for i in range(3))
            pygame.draw.line(surf, col,
                             (MAP_X, MAP_Y + row),
                             (MAP_X + MAP_W - 1, MAP_Y + row))

    # Lava glow overlay for Hadean
    if ma > 3500:
        lava_alpha = clamp(int((ma - 3500) / 800 * 200), 0, 200)
        lava_surf = pygame.Surface((MAP_W, MAP_H), pygame.SRCALPHA)
        # Draw lava "cracks" as random bright lines
        rng = random.Random(int(ma / 50))
        for _ in range(12):
            x1 = rng.randint(0, MAP_W)
            y1 = rng.randint(0, MAP_H)
            x2 = x1 + rng.randint(-80, 80)
            y2 = y1 + rng.randint(-60, 60)
            pygame.draw.line(lava_surf, (*LAVA2, lava_alpha), (x1, y1), (x2, y2), 2)
        surf.blit(lava_surf, (MAP_X, MAP_Y))


def draw_continents(surf, ma):
    continents = get_continents_at(ma)
    mr = map_rect()

    for c in continents:
        raw = c["poly"]
        if len(raw) < 3:
            continue
        # Scale poly to map rect
        pts = [(int(MAP_X + x * MAP_W), int(MAP_Y + y * MAP_H)) for x, y in raw]

        # Land color: greener in Phanerozoic, bare rock before land plants
        land_col = c["color"]
        if ma > 430:  # before land plants — brown/grey rock
            land_col = tuple(int(land_col[i] * 0.75 + 40) for i in range(3))

        pygame.draw.polygon(surf, land_col, pts)
        # Subtle border
        border_col = tuple(max(0, land_col[i] - 30) for i in range(3))
        pygame.draw.polygon(surf, border_col, pts, 2)

    # Ice caps during glaciations
    if 720 <= ma <= 635:   # Snowball Earth
        cov = clamp((720 - ma) / 85, 0, 1)
        ice_h = int(MAP_H * 0.15 + MAP_H * 0.38 * cov)
        ice_surf = pygame.Surface((MAP_W, ice_h), pygame.SRCALPHA)
        ice_surf.fill((*ICE, 190))
        surf.blit(ice_surf, (MAP_X, MAP_Y))                         # north
        surf.blit(ice_surf, (MAP_X, MAP_Y + MAP_H - ice_h))         # south

    # Polar ice for modern-ish times
    if ma < 2.6:
        ice_surf = pygame.Surface((MAP_W, 28), pygame.SRCALPHA)
        ice_surf.fill((*ICE, 160))
        surf.blit(ice_surf, (MAP_X, MAP_Y))
        surf.blit(ice_surf, (MAP_X, MAP_Y + MAP_H - 28))


def draw_grid(surf):
    g_col = (*LGRAY, 28)
    gs = pygame.Surface((MAP_W, MAP_H), pygame.SRCALPHA)
    for lx in range(0, MAP_W, MAP_W // 12):
        pygame.draw.line(gs, g_col, (lx, 0), (lx, MAP_H))
    for ly in range(0, MAP_H, MAP_H // 6):
        pygame.draw.line(gs, g_col, (0, ly), (MAP_W, ly))
    surf.blit(gs, (MAP_X, MAP_Y))


def draw_atmosphere_glow(surf, ma):
    """Soft atmosphere halo around the map edges."""
    ac = atmosphere_color(ma)
    mr = map_rect()
    for depth in range(12, 0, -1):
        alpha = int(70 * (1 - depth / 12))
        s = pygame.Surface((MAP_W + depth * 2, MAP_H + depth * 2), pygame.SRCALPHA)
        pygame.draw.rect(s, (*ac, alpha),
                         (0, 0, MAP_W + depth * 2, MAP_H + depth * 2),
                         border_radius=10)
        surf.blit(s, (MAP_X - depth, MAP_Y - depth))


def draw_map_panel(surf, ma, show_grid_flag):
    draw_atmosphere_glow(surf, ma)
    panel(surf, map_rect(), color=(0, 0, 0), bcolor=BORDER2)
    draw_ocean(surf, ma)
    draw_continents(surf, ma)
    if show_grid_flag:
        draw_grid(surf)
    # Panel border on top
    pygame.draw.rect(surf, BORDER2, map_rect(), width=1, border_radius=8)


# ── Species diversity graph ───────────────────────────────────────────────────
_GRAPH_CACHE = {}

def _build_graph_surf():
    w, h = INFO_W - 4, INFO_H // 2 - 6
    s = pygame.Surface((w, h), pygame.SRCALPHA)
    s.fill((0, 0, 0, 0))

    # Axes
    ax, ay = 36, 8
    gw, gh = w - ax - 8, h - ay - 24

    # Background
    pygame.draw.rect(s, (*PANEL, 220), (ax, ay, gw, gh))

    # Grid lines
    for yi in range(5):
        gy = ay + int(gh * yi / 4)
        pygame.draw.line(s, (*BORDER, 120), (ax, gy), (ax + gw, gy))

    # Diversity curve
    pts = []
    steps = gw
    ma_start, ma_end = DIVERSITY[0][0], DIVERSITY[-1][0]
    for px in range(steps):
        frac = px / (steps - 1)
        ma = ma_start * (1 - frac)  # 4300→0
        d = get_diversity_at(ma)
        log_d = math.log10(max(d, 1)) / math.log10(MAX_DIVERSITY)
        py = ay + gh - int(gh * log_d)
        pts.append((ax + px, py))

    if len(pts) > 1:
        # Fill under curve
        fill_pts = [(ax, ay + gh)] + pts + [(ax + gw, ay + gh)]
        pygame.draw.polygon(s, (*GREEN, 35), fill_pts)
        pygame.draw.lines(s, (*GREEN, 200), False, pts, 2)

    # Mass extinction markers
    extinctions = [
        (444, "O"),  # Ordovician
        (359, "D"),  # Devonian
        (252, "P"),  # Permian
        (201, "Tr"), # Triassic-Jurassic
        (66,  "K"),  # K-Pg
    ]
    for ext_ma, label in extinctions:
        frac = 1 - ext_ma / ma_start
        ex = ax + int(frac * gw)
        pygame.draw.line(s, (*RED, 180), (ex, ay), (ex, ay + gh), 1)
        ls = F_XS.render(label, True, (*RED, 200))
        s.blit(ls, (ex + 2, ay + 2))

    # Y-axis label
    for yi, lab in enumerate(["1", "1k", "1M", "8.7M"]):
        ly = ay + gh - int(gh * yi / 3)
        ls = F_XS.render(lab, True, GRAY)
        s.blit(ls, (2, ly - 6))

    # X-axis ticks
    for tick_ma in [4000, 3000, 2000, 1000, 500, 200, 0]:
        frac = 1 - tick_ma / ma_start
        tx = ax + int(frac * gw)
        pygame.draw.line(s, BORDER, (tx, ay + gh), (tx, ay + gh + 4))
        tl = F_XS.render(f"{tick_ma}" if tick_ma > 0 else "0", True, GRAY)
        s.blit(tl, (tx - tl.get_width() // 2, ay + gh + 5))

    # Axis lines
    pygame.draw.line(s, BORDER2, (ax, ay), (ax, ay + gh), 1)
    pygame.draw.line(s, BORDER2, (ax, ay + gh), (ax + gw, ay + gh), 1)

    return s, ax, ay, gw, gh, ma_start


def draw_diversity_graph(surf, ma):
    gx, gy = INFO_X + 2, INFO_Y + 2
    gh_rect = pygame.Rect(gx, gy, INFO_W - 4, INFO_H // 2 - 6)
    panel(surf, gh_rect, color=PANEL2, bcolor=BORDER)

    if "graph" not in _GRAPH_CACHE:
        _GRAPH_CACHE["graph"] = _build_graph_surf()
    gs, ax, _ay, gw, gh_px, ma_start = _GRAPH_CACHE["graph"]
    surf.blit(gs, (gx, gy))

    # Current position marker
    frac = 1 - ma / ma_start
    cx = gx + ax + int(frac * gw)
    pygame.draw.line(surf, GOLD2,
                     (cx, gy + _ay), (cx, gy + _ay + gh_px), 2)
    d = get_diversity_at(ma)
    log_d = math.log10(max(d, 1)) / math.log10(MAX_DIVERSITY)
    cy = gy + _ay + gh_px - int(gh_px * log_d)
    pygame.draw.circle(surf, GOLD2, (cx, cy), 5)
    pygame.draw.circle(surf, WHITE, (cx, cy), 3)

    # Title + current count
    txt(surf, "SPECIES DIVERSITY (log scale)", F_SM, LGRAY, gx + ax + 2, gy + 2)
    d_label = f"~{fmt_species(d)} species"
    txt(surf, d_label, F_MD, GREEN, gx + INFO_W - 6, gy + 2, right=True)
    txt(surf, "Ma", F_XS, GRAY, gx + ax + gw - 4, gy + _ay + gh_px + 15)


# ── Info panel ────────────────────────────────────────────────────────────────
def draw_info_panel(surf, ma):
    period = get_period_at(ma)

    base_y = INFO_Y + INFO_H // 2 + 2
    rect = pygame.Rect(INFO_X + 2, base_y, INFO_W - 4, INFO_H // 2 - 2)
    panel(surf, rect, color=PANEL2, bcolor=BORDER)

    y = base_y + 10
    # Eon badge
    eon_col = tuple(clamp(c + 40, 0, 255) for c in period["color"])
    eon_rect = pygame.Rect(INFO_X + 10, y, INFO_W - 20, 24)
    pygame.draw.rect(surf, period["color"], eon_rect, border_radius=4)
    pygame.draw.rect(surf, eon_col, eon_rect, width=1, border_radius=4)
    eon_text = period["eon"] if period["era"] == "—" else f"{period['eon']}  ·  {period['era']}"
    txt(surf, eon_text, F_SM, WHITE, INFO_X + INFO_W // 2, y + 4, center=True)
    y += 32

    # Period name
    txt(surf, period["name"], F_PERIOD, WHITE, INFO_X + INFO_W // 2, y, center=True)
    y += 34

    # Time range
    s_str = f"{period['start']} Ma" if period["start"] < 1000 else f"{period['start']/1000:.1f} Ga"
    e_str = f"{period['end']} Ma" if period["end"] > 0 else "present"
    range_txt = f"{s_str}  →  {e_str}"
    txt(surf, range_txt, F_SM, GRAY, INFO_X + INFO_W // 2, y, center=True)
    y += 22

    # Description
    txt(surf, period["desc"], F_MD, GOLD, INFO_X + INFO_W // 2, y, center=True)
    y += 24

    # Divider
    pygame.draw.line(surf, BORDER, (INFO_X + 12, y), (INFO_X + INFO_W - 12, y))
    y += 10

    # Key event (word-wrapped at 32 chars)
    ev = period["event"]
    words = ev.split()
    lines, line = [], ""
    for w in words:
        if len(line) + len(w) + 1 <= 34:
            line += ("" if not line else " ") + w
        else:
            lines.append(line)
            line = w
    if line:
        lines.append(line)
    for ln in lines[:3]:
        txt(surf, ln, F_SM, LGRAY, INFO_X + 10, y)
        y += 18

    y += 8
    # Atmospheric O2 bar
    o2_frac = _o2_fraction(ma)
    txt(surf, "Atmospheric O2", F_SM, GRAY, INFO_X + 10, y)
    y += 16
    bar_w = INFO_W - 24
    bar_rect = pygame.Rect(INFO_X + 10, y, bar_w, 10)
    pygame.draw.rect(surf, BORDER, bar_rect, border_radius=3)
    fill_w = max(2, int(bar_w * o2_frac))
    o2_col = mix((30, 100, 200), (120, 220, 255), o2_frac)
    pygame.draw.rect(surf, o2_col,
                     pygame.Rect(INFO_X + 10, y, fill_w, 10), border_radius=3)
    txt(surf, f"{o2_frac * 21:.1f}%", F_XS, LGRAY, INFO_X + 10 + bar_w + 2, y)
    y += 18

    # Scroll event log
    if event_queue:
        txt(surf, "RECENT EVENTS", F_XS, GRAY, INFO_X + 10, y)
        y += 14
        for ev_txt, _ in event_queue[:3]:
            txt(surf, f"> {ev_txt}", F_XS, CYAN, INFO_X + 12, y)
            y += 14


def _o2_fraction(ma):
    """Rough atmospheric O2 as a fraction of modern (21%)."""
    if ma > 2500:
        return 0.0
    if ma > 2000:
        return lerp(0.0, 0.02, (2500 - ma) / 500) / 0.21
    if ma > 540:
        return lerp(0.02, 0.10, (2000 - ma) / 1460) / 0.21
    if ma > 300:
        return lerp(0.10, 0.35, (540 - ma) / 240) / 0.21
    if ma > 200:
        return lerp(0.35, 0.16, (300 - ma) / 100) / 0.21
    return clamp(lerp(0.16, 0.21, (200 - ma) / 200), 0, 1)


# ── Timeline ─────────────────────────────────────────────────────────────────
def draw_timeline(surf, ma):
    tr = pygame.Rect(TL_X, TL_Y, TL_W, TL_H)
    panel(surf, tr, color=PANEL, bcolor=BORDER)

    inner_x = TL_X + 8
    inner_w = TL_W - 16
    bar_y   = TL_Y + 30
    bar_h   = 18

    # Draw each period as a colored segment
    for p in PERIODS:
        frac_s = 1 - p["start"] / START_MA
        frac_e = 1 - p["end"]   / START_MA
        px = inner_x + int(frac_s * inner_w)
        pw = max(1, int((frac_e - frac_s) * inner_w))
        seg_rect = pygame.Rect(px, bar_y, pw, bar_h)
        pygame.draw.rect(surf, p["color"], seg_rect)
        # Name label if wide enough
        if pw > 30:
            ls = F_XS.render(p["name"], True, WHITE)
            if ls.get_width() < pw - 4:
                surf.blit(ls, (px + (pw - ls.get_width()) // 2, bar_y + 3))

    # Period borders
    for p in PERIODS:
        frac_s = 1 - p["start"] / START_MA
        px = inner_x + int(frac_s * inner_w)
        pygame.draw.line(surf, PANEL, (px, bar_y), (px, bar_y + bar_h), 1)

    # Eon separators + labels
    eons = [
        ("Hadean",       4500, 4000),
        ("Archean",      4000, 2500),
        ("Proterozoic",  2500, 538),
        ("Phanerozoic",  538,  0),
    ]
    eon_y = bar_y + bar_h + 3
    for ename, es, ee in eons:
        fs = 1 - es / START_MA
        fe = 1 - ee / START_MA
        ex = inner_x + int(fs * inner_w)
        ew = max(2, int((fe - fs) * inner_w))
        label = F_XS.render(ename, True, LGRAY)
        if label.get_width() < ew - 4:
            surf.blit(label, (ex + (ew - label.get_width()) // 2, eon_y))
        pygame.draw.line(surf, BORDER2, (ex, bar_y), (ex, bar_y + bar_h + 12), 1)

    # Time tick marks
    tick_y = bar_y - 10
    for tick_ma in range(0, 4501, 500):
        frac = 1 - tick_ma / START_MA
        tx = inner_x + int(frac * inner_w)
        pygame.draw.line(surf, BORDER2, (tx, tick_y + 6), (tx, bar_y), 1)
        label = f"{tick_ma}" if tick_ma > 0 else "0"
        ls = F_XS.render(label, True, GRAY)
        surf.blit(ls, (tx - ls.get_width() // 2, tick_y - 2))

    # Current time marker
    cur_frac = 1 - ma / START_MA
    cx = inner_x + int(cur_frac * inner_w)
    pygame.draw.line(surf, GOLD2, (cx, TL_Y + 4), (cx, TL_Y + TL_H - 4), 2)
    # Triangle pointer
    tri = [(cx, TL_Y + 4), (cx - 6, TL_Y + 14), (cx + 6, TL_Y + 14)]
    pygame.draw.polygon(surf, GOLD2, tri)
    # Time label above pointer
    tl_label = fmt_ma(ma)
    ls = F_SM.render(tl_label, True, GOLD2)
    lx = clamp(cx - ls.get_width() // 2, TL_X + 2, TL_X + TL_W - ls.get_width() - 2)
    surf.blit(ls, (lx, TL_Y + 4))


# ── Header ────────────────────────────────────────────────────────────────────
def draw_header(surf, ma):
    hr = pygame.Rect(0, 0, W, HDR_H)
    surf.fill(PANEL2, hr)
    pygame.draw.line(surf, BORDER, (0, HDR_H - 1), (W, HDR_H - 1))

    period = get_period_at(ma)

    # Title
    txt(surf, "EARTH HISTORY SIMULATOR", F_TITLE, WHITE, PAD + 4, 12)

    # Current time (large, centered)
    time_s = fmt_ma(ma)
    txt(surf, time_s, F_LG, GOLD, W // 2, 18, center=True)

    # Period badge (right)
    badge_s = f"{period['eon']}  ·  {period['name']}"
    bw, _ = txt(surf, badge_s, F_LG, WHITE, W - PAD, 10, right=True)
    # Speed indicator
    speed_s = f"Speed: {SPEEDS[speed_idx]} Ma/s"
    if paused:
        speed_s = "|| PAUSED"
    txt(surf, speed_s, F_SM, GRAY, W - PAD, 36, right=True)

    # Control hints
    hints = "SPACE: pause   </> : speed   R: reset   G: grid   click timeline: jump"
    txt(surf, hints, F_XS, GRAY, PAD + 4, HDR_H - 16)


# ── Event notification overlay ────────────────────────────────────────────────
def draw_events(surf):
    y = MAP_Y + 10
    for ev_txt, ttl in event_queue:
        alpha = min(255, ttl * 3)
        s = F_MD.render(f"* {ev_txt}", True, CYAN)
        s.set_alpha(alpha)
        surf.blit(s, (MAP_X + MAP_W - s.get_width() - 12, y))
        y += 22


# ── Main simulation tick ──────────────────────────────────────────────────────
def tick(dt):
    global current_ma, prev_period, event_queue, wave_t
    if not paused:
        current_ma -= SPEEDS[speed_idx] * dt
        if current_ma < END_MA:
            current_ma = END_MA

    wave_t += dt

    # Advance event TTL
    event_queue = [[t, f - 1] for t, f in event_queue if f > 1]

    # Detect period change → push event
    period = get_period_at(current_ma)
    if period["name"] != prev_period:
        prev_period = period["name"]
        event_queue.insert(0, [period["event"][:60], 300])

    return current_ma <= END_MA


# ── Main loop ─────────────────────────────────────────────────────────────────
def main():
    global current_ma, paused, speed_idx, last_t, show_grid

    running = True
    while running:
        now = _time.perf_counter()
        dt = min(now - last_t, 0.1)
        last_t = now

        # ── Events ────────────────────────────────────────────────────────────
        for ev in pygame.event.get():
            if ev.type == pygame.QUIT:
                running = False

            elif ev.type == pygame.KEYDOWN:
                if ev.key == pygame.K_SPACE:
                    paused = not paused
                elif ev.key == pygame.K_RIGHT:
                    speed_idx = min(speed_idx + 1, len(SPEEDS) - 1)
                elif ev.key == pygame.K_LEFT:
                    speed_idx = max(speed_idx - 1, 0)
                elif ev.key == pygame.K_r:
                    current_ma = START_MA
                    event_queue.clear()
                elif ev.key in (pygame.K_g, pygame.K_SLASH):
                    show_grid = not show_grid
                elif ev.key == pygame.K_ESCAPE:
                    running = False

            elif ev.type == pygame.MOUSEBUTTONDOWN:
                mx, my = ev.pos
                # Click on timeline to scrub
                if TL_Y < my < TL_Y + TL_H:
                    inner_x = TL_X + 8
                    inner_w = TL_W - 16
                    frac = clamp((mx - inner_x) / inner_w, 0, 1)
                    current_ma = START_MA * (1 - frac)
                    event_queue.clear()

        # ── Simulate ──────────────────────────────────────────────────────────
        done = tick(dt)

        # ── Draw ──────────────────────────────────────────────────────────────
        screen.fill(BG)
        draw_stars(screen, current_ma)
        draw_map_panel(screen, current_ma, show_grid)
        draw_diversity_graph(screen, current_ma)
        draw_info_panel(screen, current_ma)
        draw_timeline(screen, current_ma)
        draw_header(screen, current_ma)
        draw_events(screen)

        # "REACHED PRESENT" banner
        if done:
            s = F_PERIOD.render("— Reached Present Day —", True, GOLD2)
            screen.blit(s, (W // 2 - s.get_width() // 2, H // 2 - 20))

        pygame.display.flip()
        clock.tick(60)

    pygame.quit()
    sys.exit(0)


if __name__ == "__main__":
    main()
