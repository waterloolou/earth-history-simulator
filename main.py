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
ICE_BRIGHT    = (215, 235, 255)
ICE_DARK      = (155, 190, 235)

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

# Globe render cache (keyed by rounded Ma)
_globe_cache: dict[int, pygame.Surface] = {}
CACHE_MA_STEP = 3    # re-render every N Ma
CACHE_MAX     = 100

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
    return OCEAN_SHALLOW, OCEAN_DEEP

def land_color(base, ma):
    if ma > 430:
        return mix(base, (122, 102, 68), 0.60)
    return base

def o2_frac(ma):
    if ma > 2500: return 0.0
    if ma > 2000: return lerp(0.0, 0.02, (2500-ma)/500) / 0.21
    if ma >  540: return lerp(0.02, 0.10, (2000-ma)/1460) / 0.21
    if ma >  300: return lerp(0.10, 0.35, (540-ma)/240) / 0.21
    if ma >  200: return lerp(0.35, 0.16, (300-ma)/100) / 0.21
    return clamp(lerp(0.16, 0.21, (200-ma)/200), 0, 1)


# ══════════════════════════════════════════════════════════════════════════════
# PILLOW GLOBE RENDERING  (high-quality, cached)
# ══════════════════════════════════════════════════════════════════════════════


# ── Pre-baked static assets (computed once) ────────────────────────────────────
_PIL_CIRC_MASK: Image.Image | None = None   # greyscale circular clip mask
_PIL_SPECULAR:  Image.Image | None = None   # specular highlight RGBA
_OCEAN_CACHE:   dict = {}                   # ocean key → PIL RGBA image (no alpha)

def _get_circ_mask() -> Image.Image:
    global _PIL_CIRC_MASK
    if _PIL_CIRC_MASK is None:
        m = Image.new("L", (RENDER_D, RENDER_D), 0)
        ImageDraw.Draw(m).ellipse((0, 0, RENDER_D - 1, RENDER_D - 1), fill=255)
        _PIL_CIRC_MASK = m
    return _PIL_CIRC_MASK

def _get_specular() -> Image.Image:
    global _PIL_SPECULAR
    if _PIL_SPECULAR is None:
        sz  = RENDER_D; r = RENDER_R
        s   = Image.new("RGBA", (sz, sz), (0, 0, 0, 0))
        sd  = ImageDraw.Draw(s, "RGBA")
        hx, hy = int(r * 0.60), int(r * 0.55)
        mx  = int(r * 0.30)
        for rad in range(mx, 2, -2):
            a = int(26 * (1 - rad / mx) ** 1.6)
            sd.ellipse((hx-rad, hy-rad, hx+rad, hy+rad), fill=(255, 255, 255, a))
        _PIL_SPECULAR = s
    return _PIL_SPECULAR

def _get_ocean(ma: float) -> Image.Image:
    """Numpy radial-gradient ocean, cached per distinct colour."""
    # Ocean colour changes rarely — quantise key coarsely
    s, d = ocean_pair(ma)
    key  = (s, d)
    if key not in _OCEAN_CACHE:
        sz = RENDER_D; r = RENDER_R
        yy, xx = np.ogrid[0:sz, 0:sz]
        dist   = np.sqrt((xx - r) ** 2 + (yy - r) ** 2).astype(np.float32) / r
        t_oc   = np.clip(dist * 0.82, 0, 1)
        arr    = np.zeros((sz, sz, 3), dtype=np.uint8)
        for ch in range(3):
            arr[:, :, ch] = np.clip(s[ch]*(1-t_oc) + d[ch]*t_oc, 0, 255).astype(np.uint8)
        _OCEAN_CACHE[key] = Image.fromarray(arr, "RGB")
    return _OCEAN_CACHE[key].copy()


def _pil_build_globe(ma: float) -> pygame.Surface:
    """Render the globe to a pygame Surface using numpy + Pillow."""
    sz   = RENDER_D

    # ── Ocean (cached numpy gradient) ────────────────────────────────────────
    base = _get_ocean(ma).convert("RGBA")   # adds alpha channel (all 255)
    draw = ImageDraw.Draw(base, "RGBA")

    # ── Continents ───────────────────────────────────────────────────────────
    for c in get_interpolated_continents(ma):
        poly = c["poly"]
        if len(poly) < 3:
            continue
        alpha = int(clamp(c.get("alpha", 255), 0, 255))
        lc    = land_color(c["color"], ma)
        pts   = [(x * sz, y * sz) for x, y in poly]
        draw.polygon(pts, fill=(*lc, alpha))
        edge  = tuple(max(0, lc[i] - 30) for i in range(3))
        draw.line(pts + [pts[0]], fill=(*edge, min(alpha, 200)),
                  width=max(2, sz // 200))

    # ── Ice caps ─────────────────────────────────────────────────────────────
    if 720 <= ma <= 635:
        frac  = clamp((720 - ma) / 85, 0, 1)
        cap_h = int(sz * 0.10 + sz * 0.84 * frac)
        if cap_h > 0:
            _paste_rect(base, ICE_BRIGHT, 220, 0, 0, sz, cap_h)
            _paste_rect(base, ICE_DARK,   215, 0, sz - cap_h, sz, cap_h)
    elif ma < 2.6:
        cap_h = max(2, int(sz * 0.05))
        _paste_rect(base, ICE_BRIGHT, 190, 0, 0, sz, cap_h)
        _paste_rect(base, ICE_DARK,   185, 0, sz - cap_h, sz, cap_h)

    # ── Circular clip ─────────────────────────────────────────────────────────
    _, _, _, a_ch = base.split()
    a_ch = ImageChops.multiply(a_ch, _get_circ_mask())
    base.putalpha(a_ch)

    # ── Specular highlight (pre-baked) ────────────────────────────────────────
    base = Image.alpha_composite(base, _get_specular())

    # ── Convert to pygame Surface ─────────────────────────────────────────────
    surf = pygame.image.fromstring(base.tobytes(), (GLOBE_D, GLOBE_D), "RGBA")
    return surf.convert_alpha()


def _paste_rect(img, color, alpha, x, y, w, h):
    """Paste a solid-colour RGBA rectangle onto img in-place."""
    patch = Image.new("RGBA", (w, h), (*color, alpha))
    img.paste(patch, (x, y), patch)


def _cache_key(ma: float) -> int:
    return int(ma / CACHE_MA_STEP) * CACHE_MA_STEP


def get_globe_surf(ma: float) -> pygame.Surface:
    """Return a cached (or freshly rendered) Pillow-based globe surface."""
    key = _cache_key(ma)
    if key not in _globe_cache:
        if len(_globe_cache) >= CACHE_MAX:
            _globe_cache.pop(next(iter(_globe_cache)))
        _globe_cache[key] = _pil_build_globe(ma)
    return _globe_cache[key]


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
        poly = c["poly"]
        if not poly:
            continue
        cx_n = sum(p[0] for p in poly) / len(poly)
        cy_n = sum(p[1] for p in poly) / len(poly)
        sx_n = max(abs(p[0] - cx_n) for p in poly) * 0.85
        sy_n = max(abs(p[1] - cy_n) for p in poly) * 0.85
        for i in range(per):
            px = clamp(cx_n + rng.uniform(-sx_n, sx_n), 0.02, 0.98)
            py = clamp(cy_n + rng.uniform(-sy_n, sy_n), 0.02, 0.98)
            px += math.sin(t * 0.4 + i * 1.7) * 0.004
            py += math.cos(t * 0.55 + i * 2.3) * 0.004
            gx = int(px * GLOBE_D)
            gy = int(py * GLOBE_D)
            if (gx - GLOBE_R) ** 2 + (gy - GLOBE_R) ** 2 > (GLOBE_R * 0.96) ** 2:
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
    for offset, alpha in [(44, 22), (28, 42), (16, 62), (8, 88)]:
        gr = GLOBE_R + offset
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
    txt(surf, "Atmospheric O2", F_SM, GRAY, INFO_X+12, y)
    y += 16
    bw = INFO_W - 24
    pygame.draw.rect(surf, DGRAY, pygame.Rect(INFO_X+10, y, bw, 10), border_radius=4)
    o2 = o2_frac(ma)
    fw = max(2, int(bw * o2))
    oc = mix((28, 88, 200), (110, 210, 255), o2)
    pygame.draw.rect(surf, oc, pygame.Rect(INFO_X+10, y, fw, 10), border_radius=4)
    txt(surf, f"{o2*21:.1f}%", F_XS, LGRAY, INFO_X+12+bw+4, y)
    y += 18

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
    txt(surf, "SPACE=pause   </>=speed   R=reset   G=grid   click timeline=jump",
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


# ── Tick ───────────────────────────────────────────────────────────────────────
def tick(dt):
    global current_ma, prev_period, event_queue, anim_t
    if not paused:
        current_ma -= SPEEDS[speed_idx] * dt
        if current_ma < END_MA:
            current_ma = END_MA
    anim_t += dt
    event_queue = [[t, f-1] for t, f in event_queue if f > 1]
    p = get_period_at(current_ma)
    if p["name"] != prev_period:
        prev_period = p["name"]
        event_queue.insert(0, [p["event"][:60], 320])
    return current_ma <= END_MA


# ── Main ───────────────────────────────────────────────────────────────────────
def main():
    global current_ma, paused, speed_idx, last_t, show_grid, event_queue

    while True:
        now = _time.perf_counter()
        dt  = min(now - last_t, 0.08)
        last_t = now

        for ev in pygame.event.get():
            if ev.type == pygame.QUIT:
                pygame.quit(); sys.exit()
            elif ev.type == pygame.KEYDOWN:
                if   ev.key == pygame.K_SPACE:  paused = not paused
                elif ev.key == pygame.K_RIGHT:  speed_idx = min(speed_idx+1, len(SPEEDS)-1)
                elif ev.key == pygame.K_LEFT:   speed_idx = max(speed_idx-1, 0)
                elif ev.key == pygame.K_r:      current_ma = START_MA; event_queue.clear()
                elif ev.key in (pygame.K_g, pygame.K_SLASH): show_grid = not show_grid
                elif ev.key == pygame.K_ESCAPE: pygame.quit(); sys.exit()
            elif ev.type == pygame.MOUSEBUTTONDOWN:
                mx, my = ev.pos
                if TL_Y < my < TL_Y + TL_H:
                    frac = clamp((mx - TL_X-10) / (TL_W-20), 0, 1)
                    current_ma = START_MA * (1 - frac); event_queue.clear()

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

        pygame.display.flip()
        clock.tick(60)


if __name__ == "__main__":
    main()
