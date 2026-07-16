// urlState.js -- encode/decode app state (current time, mode, selected event)
// into the URL query string so a specific view is bookmarkable/shareable.
// Uses history.replaceState (never pushState) so scrubbing/mode-switching
// never pollutes back-button history -- only an explicit "Share" click, a
// search result pick, or a mode change produces a URL worth copying, and
// even those just overwrite the current entry.

export function readUrlState() {
  const params = new URLSearchParams(window.location.search);
  const ma = params.has("ma") ? Number(params.get("ma")) : null;
  return {
    ma: Number.isFinite(ma) ? ma : null,
    modeId: params.get("mode") || null,
    eventId: params.get("event") || null,
  };
}

export function writeUrlState({ ma, modeId, eventId }) {
  const params = new URLSearchParams();
  if (Number.isFinite(ma)) params.set("ma", ma.toPrecision(8));
  if (modeId) params.set("mode", modeId);
  if (eventId) params.set("event", eventId);
  const url = `${window.location.pathname}?${params.toString()}${window.location.hash}`;
  window.history.replaceState(null, "", url);
}
