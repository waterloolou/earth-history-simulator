// timeline.js -- zoomable/pannable timeline, ported conceptually from the
// pygame app's draw_timeline() but generalized to a windowed (tlLoMa/tlHiMa)
// view model so it can zoom from the full 4.5 Gy span down to individual years.

import { formatMa, CATEGORY_COLOR } from "./events.js";

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

    this._onSeek = null;
    this._onWindowChange = null;
    this._onHoverEvent = null;

    this._dragging = false;
    this._dragButton = null;
    this._dragStartX = 0;
    this._dragStartWindow = null;
    this._lastClickTime = 0;
    this._markerHitboxes = []; // {x, y, r, event}

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

  reset() {
    this.zoomStack = [];
    this.loMa = 0;
    this.hiMa = this.fullHiMa;
    this._fireWindowChange();
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
  _barY() { return 36; }
  _barH() { return 20; }

  maToX(ma) {
    const frac = (this.hiMa - ma) / (this.hiMa - this.loMa);
    return this._padX() + frac * this._plotW();
  }

  xToMa(x) {
    const frac = (x - this._padX()) / this._plotW();
    return this.hiMa - frac * (this.hiMa - this.loMa);
  }

  // ── zoom / pan / drill ──────────────────────────────────────────────────
  zoomAt(factor, pivotMa) {
    let newLo = pivotMa - (pivotMa - this.loMa) / factor;
    let newHi = pivotMa + (this.hiMa - pivotMa) / factor;
    if (newHi - newLo < MIN_SPAN_MA) return;
    if (newHi > this.fullHiMa) newHi = this.fullHiMa;
    newLo = Math.max(newLo, -1e12); // allow future dates in principle; no hard floor
    this.loMa = newLo;
    this.hiMa = newHi;
    this._fireWindowChange();
  }

  panByMa(deltaMa) {
    this.loMa += deltaMa;
    this.hiMa += deltaMa;
    if (this.hiMa > this.fullHiMa) {
      const overshoot = this.hiMa - this.fullHiMa;
      this.hiMa -= overshoot;
      this.loMa -= overshoot;
    }
    this._fireWindowChange();
  }

  drillInto(period) {
    this.zoomStack.push({ loMa: this.loMa, hiMa: this.hiMa });
    this.loMa = period.end;
    this.hiMa = period.start;
    this._fireWindowChange();
  }

  back() {
    const prev = this.zoomStack.pop();
    if (!prev) { this.reset(); return; }
    this.loMa = prev.loMa;
    this.hiMa = prev.hiMa;
    this._fireWindowChange();
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
        // hover detection for markers
        const rect = c.getBoundingClientRect();
        const x = ev.clientX - rect.left, y = ev.clientY - rect.top;
        const hit = this._markerHitboxes.find((h) => Math.hypot(h.x - x, h.y - y) <= h.r + 2);
        if (this._onHoverEvent) this._onHoverEvent(hit ? hit.event : null);
        return;
      }
      const rect = c.getBoundingClientRect();
      const x = ev.clientX - rect.left;
      const dxPx = x - this._dragStartX;

      if (this._dragButton === 2 || ev.shiftKey) {
        // pan
        const span = this._dragStartWindow.hiMa - this._dragStartWindow.loMa;
        const deltaMa = -(dxPx / this._plotW()) * span;
        this.loMa = this._dragStartWindow.loMa + deltaMa;
        this.hiMa = this._dragStartWindow.hiMa + deltaMa;
        if (this.hiMa > this.fullHiMa) {
          const over = this.hiMa - this.fullHiMa;
          this.hiMa -= over; this.loMa -= over;
        }
        this._fireWindowChange();
      } else {
        const ma = this.xToMa(x);
        this.currentMa = Math.min(this.fullHiMa, Math.max(0, ma));
        if (this._onSeek) this._onSeek(this.currentMa);
      }
    });

    window.addEventListener("mouseup", () => { this._dragging = false; });
    c.addEventListener("contextmenu", (ev) => ev.preventDefault());
  }

  // ── drawing ──────────────────────────────────────────────────────────────
  render(currentMa) {
    if (currentMa != null) this.currentMa = currentMa;
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

    // eon dividers
    ctx.strokeStyle = "#34447a";
    ctx.fillStyle = "#aaafc3";
    ctx.font = "10px Segoe UI, sans-serif";
    for (const eon of EON_BANDS) {
      if (eon.end > this.hiMa || eon.start < this.loMa) continue;
      const ex = this.maToX(Math.min(eon.start, this.hiMa));
      ctx.beginPath();
      ctx.moveTo(ex, barY - 2); ctx.lineTo(ex, barY + barH + 14);
      ctx.stroke();
    }

    // discrete event markers at fine zoom -- binary-search the visible ma
    // range instead of scanning the whole (multi-thousand-event) array, since
    // this runs every animation frame while zoomed in.
    this._markerHitboxes = [];
    const span = this.hiMa - this.loMa;
    if (span <= MARKER_SPAN_THRESHOLD_MA) {
      const markerY = barY + barH + 22;
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
        ctx.moveTo(x, barY); ctx.lineTo(x, markerY);
        ctx.stroke();
        ctx.fillStyle = CATEGORY_COLOR[e.category] || "#fff";
        ctx.beginPath();
        ctx.arc(x, markerY, 3.5, 0, Math.PI * 2);
        ctx.fill();
        this._markerHitboxes.push({ x, y: markerY, r: 5, event: e });
      }
    }

    // playhead cursor
    const cx = this.maToX(this.currentMa);
    ctx.strokeStyle = "#ffd54e";
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(cx, 4); ctx.lineTo(cx, h - 4); ctx.stroke();
    ctx.lineWidth = 1;
    ctx.fillStyle = "#ffd54e";
    ctx.beginPath();
    ctx.moveTo(cx, 4); ctx.lineTo(cx - 6, 14); ctx.lineTo(cx + 6, 14); ctx.closePath();
    ctx.fill();

    ctx.font = "12px Segoe UI, sans-serif";
    const label = formatMa(this.currentMa);
    const lw = ctx.measureText(label).width;
    let lx = cx - lw / 2;
    lx = Math.max(2, Math.min(w - lw - 2, lx));
    ctx.fillText(label, lx, h - 6);
  }
}
