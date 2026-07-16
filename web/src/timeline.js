// timeline.js -- zoomable/pannable timeline, ported conceptually from the
// pygame app's draw_timeline() but generalized to a windowed (tlLoMa/tlHiMa)
// view model so it can zoom from the full 4.5 Gy span down to individual years.

import { formatMa, CATEGORY_COLOR, maToYear, yearToMa } from "./events.js";

const EON_BANDS = [
  { name: "Hadean", start: 4500, end: 4000 },
  { name: "Archean", start: 4000, end: 2500 },
  { name: "Proterozoic", start: 2500, end: 538 },
  { name: "Phanerozoic", start: 538, end: 0 },
];

const MIN_SPAN_MA = 0.00002;          // floor: ~7 hours, effectively single-day resolution
// Below this span, plot discrete event markers. Deliberately just a few times
// wider than MAP_HANDOFF_SPAN_MA (not, say, 3 Ma/3 million years) -- markers
// are meant to preview the map handoff as you approach it, not render the
// entire multi-thousand-event dataset onto one timeline the moment you're
// merely somewhere inside the Quaternary.
const MARKER_SPAN_THRESHOLD_MA = 0.05;   // ~50,000 years
export const MAP_HANDOFF_SPAN_MA = 0.01; // ~10,000 years: mode auto-switches to map below this
const MAX_MARKERS_DRAWN = 400; // hard cap on per-frame draw calls regardless of dataset size

const ANIM_MS = 260; // duration of eased zoom/pan/drill/reset transitions
const OVERVIEW_H = 10; // height (px) of the "you are here" minimap strip

// Below this span the date axis reads as calendar years/BCE-CE rather than
// Ma/ka -- deliberately the same boundary as MARKER_SPAN_THRESHOLD_MA, since
// that's also where individual years become the natural unit to reason in.
const CALENDAR_TICK_THRESHOLD_MA = MARKER_SPAN_THRESHOLD_MA;
const TARGET_TICK_COUNT = 6; // aim for roughly this many ticks across the visible span

function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }
function lerp(a, b, t) { return a + (b - a) * t; }

/** Standard "nice number" tick-interval chooser (1/2/5 x10^n) so tick
 * spacing always lands on round numbers instead of awkward values like
 * "every 833 years". Works in whatever unit `range` is expressed in --
 * callers pass either Ma or calendar years. */
function niceTickInterval(range, targetCount) {
  const rough = range / targetCount;
  if (!(rough > 0)) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(rough)));
  for (const step of [1, 2, 5]) {
    if (mag * step >= rough) return mag * step;
  }
  return mag * 10;
}

/** Unlike formatMa (which picks ka/Ma/Ga from the value's own magnitude, fine
 * for a single one-off playhead label), tick labels must pick their unit from
 * the *interval* between ticks -- otherwise e.g. 100 Ma-apart ticks at
 * 3600/3700/3800 Ma would all round to the same "4 Ga" and become
 * indistinguishable. */
function formatTickMa(ma, intervalMa) {
  if (intervalMa < 1) return `${Math.round(ma * 1000)} ka`;
  if (intervalMa < 1000) return `${Math.round(ma)} Ma`;
  return `${Math.round(ma / 1000)} Ga`;
}

function formatTickYear(year) {
  return year < 0 ? `${-year} BCE` : `${year} CE`;
}

/** Human-friendly "how much time is on screen" label, e.g. "~500 years",
 * "~2.3 Ma", "~380 million years". Mirrors formatMa's unit choices so the
 * span readout and the playhead label read consistently. */
function formatSpan(spanMa) {
  const years = spanMa * 1_000_000;
  if (years < 2) return "< 1 year";
  if (years < 1_000) return `~${Math.round(years)} years`;
  if (years < 1_000_000) return `~${Math.round(years / 1000).toLocaleString()}k years`;
  if (spanMa < 1000) return `~${spanMa >= 100 ? Math.round(spanMa) : spanMa.toFixed(1)} Ma`;
  return `~${(spanMa / 1000).toFixed(2)} Ga`;
}

export class Timeline {
  constructor(canvas, periods) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.periods = periods;
    this.fullHiMa = periods.length ? periods[0].start : 4500;
    this.loMa = 0;
    this.hiMa = this.fullHiMa;
    this.zoomStack = [];
    this.events = [];
    this.currentMa = this.fullHiMa;

    // Eased-transition state: render() lerps loMa/hiMa toward these targets
    // over ANIM_MS instead of jump-cutting, so zoom/pan/drill/reset all feel
    // like one continuous motion instead of a series of abrupt redraws.
    this._animFromLo = this.loMa; this._animFromHi = this.hiMa;
    this._animToLo = this.loMa; this._animToHi = this.hiMa;
    this._animStartT = 0; this._animActive = false;

    this._onSeek = null;
    this._onWindowChange = null;
    this._onHoverEvent = null;

    this._dragging = false;
    this._dragButton = null;
    this._dragStartX = 0;
    this._dragStartWindow = null;
    this._lastClickTime = 0;
    this._markerHitboxes = []; // {x, y, r, event}
    this._hoveringOverview = false;
    this._lastHoverId = null;

    // Touch state: single-finger drag = seek (mirrors mouse left-drag, the
    // primary "scrub through time" gesture); two-finger pinch = zoom (mirrors
    // wheel), anchored at wherever the pinch midpoint currently is so a
    // combined pinch+drag gesture pans and zooms together, same as any map app.
    this._touchMode = null; // "seek" | "pinch" | null
    this._pinchStartDist = 0;
    this._pinchStartWindow = null;

    this._bindEvents();
    this._resizeObserver = new ResizeObserver(() => this._syncCanvasSize());
    this._resizeObserver.observe(canvas);
    this._syncCanvasSize();
  }

  onSeek(cb) { this._onSeek = cb; }
  onWindowChange(cb) { this._onWindowChange = cb; }
  onHoverEvent(cb) { this._onHoverEvent = cb; }

  /** Store events sorted ascending by ma so render()'s hot path (called every
   * animation frame) can binary-search the visible range instead of scanning
   * the whole array -- with several thousand events this was the dominant
   * cost of zooming into the fine-grained (<=3 Ma) marker view. */
  setEvents(events) {
    this.events = events.slice().sort((a, b) => a.time.ma - b.time.ma);
  }

  /** Index of the first event with time.ma >= ma (lower_bound). */
  _lowerBound(ma) {
    let lo = 0, hi = this.events.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.events[mid].time.ma < ma) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  /** Index one past the last event with time.ma <= ma (upper_bound). */
  _upperBound(ma) {
    let lo = 0, hi = this.events.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.events[mid].time.ma <= ma) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  getWindow() { return { loMa: this.loMa, hiMa: this.hiMa }; }
  currentSpanMa() { return this.hiMa - this.loMa; }

  reset() {
    this.zoomStack = [];
    this._animateTo(0, this.fullHiMa);
  }

  /** Jump straight to a "recent history" view centered on the present, at a
   * span comfortably inside the map-handoff threshold -- a direct answer to
   * "how do I get to today" without needing to land a precise scroll-zoom-to-
   * cursor gesture (zoom-to-cursor converges near, not exactly at, whatever
   * point was under the pointer, same as any map app's zoom-to-cursor). */
  jumpToPresent() {
    this.zoomStack.push({ loMa: this.loMa, hiMa: this.hiMa });
    this._animateTo(0, MAP_HANDOFF_SPAN_MA * 0.6);
  }

  /** Zoom in/out by `factor` centered on the current playhead -- used by the
   * +/- buttons (mouse-wheel zoom-to-cursor still works independently). */
  zoomStep(factor) {
    this.zoomAt(factor, this.currentMa);
  }

  _syncCanvasSize() {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.max(1, Math.round(rect.width * dpr));
    this.canvas.height = Math.max(1, Math.round(rect.height * dpr));
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this._cssW = rect.width;
    this._cssH = rect.height;
  }

  // ── coordinate mapping ──────────────────────────────────────────────────
  _padX() { return 10; }
  _plotW() { return Math.max(1, this._cssW - this._padX() * 2); }
  _overviewY() { return 4; }
  _barY() { return this._overviewY() + OVERVIEW_H + 10; }
  _barH() { return 20; }

  maToX(ma) {
    const frac = (this.hiMa - ma) / (this.hiMa - this.loMa);
    return this._padX() + frac * this._plotW();
  }

  xToMa(x) {
    const frac = (x - this._padX()) / this._plotW();
    return this.hiMa - frac * (this.hiMa - this.loMa);
  }

  /** Full-range (not viewport-relative) mapping, used by the overview strip. */
  _overviewMaToX(ma) {
    const frac = (this.fullHiMa - ma) / this.fullHiMa;
    return this._padX() + frac * this._plotW();
  }
  _overviewXToMa(x) {
    const frac = (x - this._padX()) / this._plotW();
    return this.fullHiMa * (1 - frac);
  }

  // ── zoom / pan / drill ──────────────────────────────────────────────────
  zoomAt(factor, pivotMa) {
    let newLo = pivotMa - (pivotMa - this.loMa) / factor;
    let newHi = pivotMa + (this.hiMa - pivotMa) / factor;
    if (newHi - newLo < MIN_SPAN_MA) return;
    [newLo, newHi] = this._clampWindow(newLo, newHi);
    this._animateTo(newLo, newHi);
  }

  /** Keep the window within [0, fullHiMa] -- there's no data before the
   * formation of Earth or after the present, so zooming/panning out can
   * never go further than that full range (the same bounds Reset uses),
   * and never past it into negative ("future") Ma either. */
  _clampWindow(lo, hi) {
    // Never wider than the full 0..fullHiMa range -- that IS "fully zoomed
    // out"; a wheel-tick past that point re-centers on the full range
    // instead of opening up empty space beyond it.
    if (hi - lo >= this.fullHiMa) return [0, this.fullHiMa];
    if (hi > this.fullHiMa) { lo -= hi - this.fullHiMa; hi = this.fullHiMa; }
    if (lo < 0) { hi -= lo; lo = 0; }
    // Re-check after the shift above (a span very close to fullHiMa can
    // overshoot the other edge once shifted back in).
    if (hi > this.fullHiMa) hi = this.fullHiMa;
    return [lo, hi];
  }

  panByMa(deltaMa) {
    const [newLo, newHi] = this._clampWindow(this.loMa + deltaMa, this.hiMa + deltaMa);
    // Panning is a direct-manipulation drag, not a discrete action -- follow
    // the pointer immediately rather than easing (easing here would make the
    // view visibly lag behind the mouse).
    this.loMa = newLo;
    this.hiMa = newHi;
    this._animToLo = newLo; this._animToHi = newHi; this._animActive = false;
    this._fireWindowChange();
  }

  drillInto(period) {
    this.zoomStack.push({ loMa: this.loMa, hiMa: this.hiMa });
    this._animateTo(period.end, period.start);
  }

  /** Jump directly to a specific point in time at a given span (defaults to
   * a span comfortably inside the map-handoff threshold, so a jump lands in
   * map mode the same way jumpToPresent() does). Used by the event search
   * box and by shared-link event focus, where the target is a specific
   * discrete event rather than a period. */
  jumpToEvent(ma, spanMa = MAP_HANDOFF_SPAN_MA * 0.6) {
    this.zoomStack.push({ loMa: this.loMa, hiMa: this.hiMa });
    const half = spanMa / 2;
    let lo = ma - half, hi = ma + half;
    if (lo < 0) { hi -= lo; lo = 0; }
    if (hi > this.fullHiMa) { lo -= hi - this.fullHiMa; hi = this.fullHiMa; }
    this._animateTo(Math.max(0, lo), hi);
  }

  back() {
    const prev = this.zoomStack.pop();
    if (!prev) { this.reset(); return; }
    this._animateTo(prev.loMa, prev.hiMa);
  }

  _animateTo(lo, hi) {
    this._animFromLo = this.loMa; this._animFromHi = this.hiMa;
    this._animToLo = lo; this._animToHi = hi;
    this._animStartT = performance.now();
    this._animActive = true;
  }

  _fireWindowChange() {
    if (this._onWindowChange) this._onWindowChange(this.getWindow());
  }

  // ── interaction ─────────────────────────────────────────────────────────
  _bindEvents() {
    const c = this.canvas;
    c.addEventListener("wheel", (ev) => {
      ev.preventDefault();
      const rect = c.getBoundingClientRect();
      const x = ev.clientX - rect.left;
      const pivotMa = this.xToMa(x);
      const factor = ev.deltaY < 0 ? 1.25 : 1 / 1.25;
      this.zoomAt(factor, pivotMa);
    }, { passive: false });

    c.addEventListener("mousedown", (ev) => {
      const rect = c.getBoundingClientRect();
      const x = ev.clientX - rect.left;
      const y = ev.clientY - rect.top;

      // Overview ("you are here") strip: click-to-recenter at the current
      // zoom span, a quick way to jump elsewhere without losing your zoom level.
      if (y >= this._overviewY() && y <= this._overviewY() + OVERVIEW_H) {
        const centerMa = this._overviewXToMa(x);
        const span = this.currentSpanMa();
        let newLo = centerMa - span / 2, newHi = centerMa + span / 2;
        if (newHi > this.fullHiMa) { newLo -= newHi - this.fullHiMa; newHi = this.fullHiMa; }
        if (newLo < 0) { newHi -= newLo; newLo = 0; }
        this._animateTo(newLo, newHi);
        return;
      }

      const now = performance.now();
      const isDoubleClick = now - this._lastClickTime < 320;
      this._lastClickTime = now;

      if (isDoubleClick && y >= this._barY() && y <= this._barY() + this._barH()) {
        const ma = this.xToMa(x);
        const period = this.periods.find((p) => ma <= p.start && ma >= p.end);
        if (period) this.drillInto(period);
        return;
      }

      this._dragging = true;
      this._dragButton = ev.button;
      this._dragStartX = x;
      this._dragStartWindow = { loMa: this.loMa, hiMa: this.hiMa };

      if (ev.button === 0) {
        const ma = this.xToMa(x);
        this.currentMa = Math.min(this.fullHiMa, Math.max(0, ma));
        if (this._onSeek) this._onSeek(this.currentMa);
      }
    });

    window.addEventListener("mousemove", (ev) => {
      if (!this._dragging) {
        const rect = c.getBoundingClientRect();
        const x = ev.clientX - rect.left, y = ev.clientY - rect.top;
        this._hoveringOverview = y >= this._overviewY() && y <= this._overviewY() + OVERVIEW_H;
        // hover detection for markers -- this listener is on window (so drags
        // that leave the canvas still track), meaning it fires on every mouse
        // movement anywhere on the page. Only fire the callback when the
        // hovered marker actually changes, not on every no-op "still nothing
        // under the cursor" move: callers may do real work (DOM writes, array
        // scans) in response, and firing unconditionally also meant moving the
        // mouse anywhere right after an unrelated selection (e.g. a border-map
        // click) would immediately re-trigger a "hover ended" callback.
        const hit = this._markerHitboxes.find((h) => Math.hypot(h.x - x, h.y - y) <= h.r + 2);
        const hitId = hit ? hit.event.id : null;
        if (hitId !== this._lastHoverId) {
          this._lastHoverId = hitId;
          if (this._onHoverEvent) this._onHoverEvent(hit ? hit.event : null);
        }
        return;
      }
      const rect = c.getBoundingClientRect();
      const x = ev.clientX - rect.left;
      const dxPx = x - this._dragStartX;

      if (this._dragButton === 2 || ev.shiftKey) {
        // pan -- route through _clampWindow so a drag is floored at the present
        // (loMa >= 0) exactly like the wheel/step paths; clamping only the high
        // edge here let a drag toward "now" push loMa negative into empty
        // "future" space.
        const span = this._dragStartWindow.hiMa - this._dragStartWindow.loMa;
        const deltaMa = -(dxPx / this._plotW()) * span;
        const [newLo, newHi] = this._clampWindow(
          this._dragStartWindow.loMa + deltaMa,
          this._dragStartWindow.hiMa + deltaMa,
        );
        this.loMa = newLo; this.hiMa = newHi;
        this._animToLo = newLo; this._animToHi = newHi; this._animActive = false;
        this._fireWindowChange();
      } else {
        const ma = this.xToMa(x);
        this.currentMa = Math.min(this.fullHiMa, Math.max(0, ma));
        if (this._onSeek) this._onSeek(this.currentMa);
      }
    });

    window.addEventListener("mouseup", () => { this._dragging = false; });
    c.addEventListener("contextmenu", (ev) => ev.preventDefault());

    // ── touch: preventDefault (not passive) so a gesture on this canvas never
    // also triggers the browser's own page-pinch-zoom -- scoped to just this
    // element, so pinch-zoom accessibility elsewhere on the page is untouched. ─
    c.addEventListener("touchstart", (ev) => {
      ev.preventDefault();
      const rect = c.getBoundingClientRect();
      if (ev.touches.length === 1) {
        const t = ev.touches[0];
        const x = t.clientX - rect.left, y = t.clientY - rect.top;

        if (y >= this._overviewY() && y <= this._overviewY() + OVERVIEW_H) {
          const centerMa = this._overviewXToMa(x);
          const span = this.currentSpanMa();
          let newLo = centerMa - span / 2, newHi = centerMa + span / 2;
          if (newHi > this.fullHiMa) { newLo -= newHi - this.fullHiMa; newHi = this.fullHiMa; }
          if (newLo < 0) { newHi -= newLo; newLo = 0; }
          this._animateTo(newLo, newHi);
          return;
        }

        const now = performance.now();
        const isDoubleTap = now - this._lastClickTime < 320;
        this._lastClickTime = now;
        if (isDoubleTap && y >= this._barY() && y <= this._barY() + this._barH()) {
          const ma = this.xToMa(x);
          const period = this.periods.find((p) => ma <= p.start && ma >= p.end);
          if (period) this.drillInto(period);
          return;
        }

        this._touchMode = "seek";
        const ma = this.xToMa(x);
        this.currentMa = Math.min(this.fullHiMa, Math.max(0, ma));
        if (this._onSeek) this._onSeek(this.currentMa);
      } else if (ev.touches.length === 2) {
        this._touchMode = "pinch";
        this._pinchStartDist = touchDist(ev.touches);
        this._pinchStartWindow = { loMa: this.loMa, hiMa: this.hiMa };
      }
    }, { passive: false });

    c.addEventListener("touchmove", (ev) => {
      ev.preventDefault();
      const rect = c.getBoundingClientRect();
      if (this._touchMode === "seek" && ev.touches.length === 1) {
        const x = ev.touches[0].clientX - rect.left;
        const ma = this.xToMa(x);
        this.currentMa = Math.min(this.fullHiMa, Math.max(0, ma));
        if (this._onSeek) this._onSeek(this.currentMa);
      } else if (this._touchMode === "pinch" && ev.touches.length === 2) {
        const dist = touchDist(ev.touches);
        const mid = touchMid(ev.touches, rect);
        const factor = dist / (this._pinchStartDist || dist);
        const pivotMa = this.xToMa(mid.x);
        const span = (this._pinchStartWindow.hiMa - this._pinchStartWindow.loMa) / factor;
        const [newLo, newHi] = this._clampWindow(pivotMa - span / 2, pivotMa + span / 2);
        this.loMa = newLo; this.hiMa = newHi;
        this._animToLo = newLo; this._animToHi = newHi; this._animActive = false;
        this._fireWindowChange();
      }
    }, { passive: false });

    window.addEventListener("touchend", (ev) => {
      // Dropping to one remaining finger mid-pinch would otherwise be read as
      // a fresh single-finger "seek" from wherever that finger happens to be
      // -- just end the gesture instead, matching how the mouse path always
      // requires a new mousedown to start a new interaction.
      if (ev.touches.length === 0) this._touchMode = null;
    });
  }

  // ── drawing ──────────────────────────────────────────────────────────────
  render(currentMa) {
    if (currentMa != null) this.currentMa = currentMa;

    // Advance the eased zoom/pan/drill/reset transition, if one is in flight.
    if (this._animActive) {
      const t = Math.min(1, (performance.now() - this._animStartT) / ANIM_MS);
      const eased = easeOutCubic(t);
      this.loMa = lerp(this._animFromLo, this._animToLo, eased);
      this.hiMa = lerp(this._animFromHi, this._animToHi, eased);
      if (t >= 1) this._animActive = false;
      this._fireWindowChange();
    }

    const ctx = this.ctx;
    const w = this._cssW, h = this._cssH;
    ctx.clearRect(0, 0, w, h);

    const barY = this._barY(), barH = this._barH();
    const ix = this._padX(), iw = this._plotW();

    // period segments
    for (const p of this.periods) {
      if (p.end > this.hiMa || p.start < this.loMa) continue;
      const px = this.maToX(Math.min(p.start, this.hiMa));
      const pxEnd = this.maToX(Math.max(p.end, this.loMa));
      const pw = Math.max(1, pxEnd - px);
      ctx.fillStyle = `rgb(${p.color[0]},${p.color[1]},${p.color[2]})`;
      ctx.fillRect(px, barY, pw, barH);
      if (pw > 34) {
        ctx.fillStyle = "#fff";
        ctx.font = "10px Segoe UI, sans-serif";
        const tw = ctx.measureText(p.name).width;
        if (tw < pw - 4) ctx.fillText(p.name, px + (pw - tw) / 2, barY + 14);
      }
    }

    // eon dividers -- extend down through the date-axis ticks below so the
    // divider still reads as one continuous guide line through that row.
    ctx.strokeStyle = "#34447a";
    ctx.fillStyle = "#aaafc3";
    ctx.font = "10px Segoe UI, sans-serif";
    for (const eon of EON_BANDS) {
      if (eon.end > this.hiMa || eon.start < this.loMa) continue;
      const ex = this.maToX(Math.min(eon.start, this.hiMa));
      ctx.beginPath();
      ctx.moveTo(ex, barY - 2); ctx.lineTo(ex, barY + barH + 30);
      ctx.stroke();
    }

    this._drawTicks(ctx);

    // discrete event markers at fine zoom -- binary-search the visible ma
    // range instead of scanning the whole (multi-thousand-event) array, since
    // this runs every animation frame while zoomed in.
    this._markerHitboxes = [];
    const span = this.hiMa - this.loMa;
    if (span <= MARKER_SPAN_THRESHOLD_MA) {
      const markerY = barY + barH + 34;
      // Stems start just below the date-tick label row, not from the top of
      // the bar -- a full-height stem per marker would slice straight
      // through the tick labels above once there are more than a handful of
      // events in view, making the dates unreadable.
      const stemTop = markerY - 12;
      const startIdx = this._lowerBound(this.loMa);
      const endIdx = this._upperBound(this.hiMa);
      const count = endIdx - startIdx;
      // Evenly sub-sample rather than truncate, so a dense cluster doesn't
      // just hide everything after the first MAX_MARKERS_DRAWN.
      const step = Math.max(1, Math.ceil(count / MAX_MARKERS_DRAWN));
      for (let i = startIdx; i < endIdx; i += step) {
        const e = this.events[i];
        if (!(e.category in CATEGORY_COLOR)) continue;
        if (e.category === "geological_period" || e.category === "tree_of_life") continue;
        const x = this.maToX(e.time.ma);
        ctx.strokeStyle = CATEGORY_COLOR[e.category] || "#fff";
        ctx.beginPath();
        ctx.moveTo(x, stemTop); ctx.lineTo(x, markerY);
        ctx.stroke();
        ctx.fillStyle = CATEGORY_COLOR[e.category] || "#fff";
        ctx.beginPath();
        ctx.arc(x, markerY, 3.5, 0, Math.PI * 2);
        ctx.fill();
        this._markerHitboxes.push({ x, y: markerY, r: 5, event: e });
      }
    }

    // playhead cursor -- the vertical line runs the full height (crossing the
    // overview strip too, showing at a glance where "now" sits in both the
    // zoomed-in view and the full-range minimap); the arrowhead marker sits
    // in the gap between the overview strip and the period bar.
    const cx = this.maToX(this.currentMa);
    ctx.strokeStyle = "#ffd54e";
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(cx, this._overviewY()); ctx.lineTo(cx, h - 4); ctx.stroke();
    ctx.lineWidth = 1;
    ctx.fillStyle = "#ffd54e";
    ctx.beginPath();
    ctx.moveTo(cx, barY - 2); ctx.lineTo(cx - 5, barY - 9); ctx.lineTo(cx + 5, barY - 9); ctx.closePath();
    ctx.fill();

    ctx.font = "12px Segoe UI, sans-serif";
    const label = formatMa(this.currentMa);
    const lw = ctx.measureText(label).width;
    let lx = cx - lw / 2;
    lx = Math.max(2, Math.min(w - lw - 2, lx));
    ctx.fillText(label, lx, h - 6);

    // zoom-span readout, right-aligned on the same baseline as the playhead label
    ctx.fillStyle = "#585e7a";
    ctx.font = "11px Segoe UI, sans-serif";
    const spanLabel = `Showing ${formatSpan(span)}`;
    ctx.fillText(spanLabel, w - ix - ctx.measureText(spanLabel).width, h - 6);

    this._drawOverview(ctx, w);
  }

  /** Date axis below the main period bar: "nice" round-number tick spacing
   * (1/2/5 x10^n) that adapts to whatever span is currently visible, from
   * billion-year (Ga) steps zoomed all the way out down to individual
   * calendar years/BCE-CE once zoomed into recent history. This is the only
   * place absolute dates are shown continuously along the timeline (the
   * playhead label only shows the single current instant). */
  _drawTicks(ctx) {
    const barY = this._barY(), barH = this._barH();
    const tickTop = barY + barH;
    const tickBottom = tickTop + 6;
    const labelY = tickBottom + 12;
    const span = this.hiMa - this.loMa;

    ctx.strokeStyle = "#454c76";
    ctx.fillStyle = "#aaafc3";
    ctx.font = "10px Segoe UI, sans-serif";
    ctx.textAlign = "center";

    const ticks = [];
    if (span <= CALENDAR_TICK_THRESHOLD_MA) {
      // Calendar regime: align ticks to round *year* boundaries (e.g. 1900,
      // 1950, 2000), not round Ma fractions -- rounding in Ma near ma=0 would
      // land ticks on odd years like 1994/2044 instead.
      const loYear = maToYear(this.hiMa);
      const hiYear = maToYear(this.loMa);
      const interval = niceTickInterval(hiYear - loYear, TARGET_TICK_COUNT);
      const first = Math.ceil(loYear / interval) * interval;
      for (let y = first; y <= hiYear; y += interval) {
        ticks.push({ ma: yearToMa(y), label: formatTickYear(y) });
      }
    } else {
      const interval = niceTickInterval(span, TARGET_TICK_COUNT);
      const first = Math.ceil(this.loMa / interval) * interval;
      for (let m = first; m <= this.hiMa; m += interval) {
        ticks.push({ ma: m, label: formatTickMa(m, interval) });
      }
    }

    for (const t of ticks) {
      const x = this.maToX(t.ma);
      ctx.beginPath();
      ctx.moveTo(x, tickTop); ctx.lineTo(x, tickBottom);
      ctx.stroke();
      ctx.fillText(t.label, x, labelY);
    }
    ctx.textAlign = "left";
  }

  /** Slim "you are here" strip above the main bar: the full 0..fullHiMa range
   * in miniature, with the current viewport highlighted, so zooming in deep
   * never leaves you wondering where in all of history you actually are.
   * Click-to-recenter is wired in _bindEvents(). */
  _drawOverview(ctx, w) {
    const oy = this._overviewY(), ix = this._padX(), iw = this._plotW();
    ctx.fillStyle = "#181c3a";
    ctx.fillRect(ix, oy, iw, OVERVIEW_H);

    for (const p of this.periods) {
      const px = this._overviewMaToX(p.start);
      const pxEnd = this._overviewMaToX(p.end);
      ctx.fillStyle = `rgb(${p.color[0]},${p.color[1]},${p.color[2]})`;
      ctx.fillRect(px, oy, Math.max(1, pxEnd - px), OVERVIEW_H);
    }

    const vx0 = clampPx(this._overviewMaToX(Math.min(this.hiMa, this.fullHiMa)), ix, ix + iw);
    const vx1 = clampPx(this._overviewMaToX(Math.max(this.loMa, 0)), ix, ix + iw);
    const vw = Math.max(2, vx1 - vx0);
    ctx.strokeStyle = this._hoveringOverview ? "#ffffff" : "#ffd54e";
    ctx.lineWidth = this._hoveringOverview ? 2 : 1.5;
    ctx.strokeRect(vx0, oy - 1, vw, OVERVIEW_H + 2);
  }
}

function touchDist(touches) {
  return Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY);
}

function touchMid(touches, rect) {
  return {
    x: (touches[0].clientX + touches[1].clientX) / 2 - rect.left,
    y: (touches[0].clientY + touches[1].clientY) / 2 - rect.top,
  };
}

function clampPx(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
