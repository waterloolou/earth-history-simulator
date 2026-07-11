// events.js -- lookup helpers over the flattened events.json, mirroring the
// Python events.py interface (get_events_in_range / events_near / get_event).

export function getEventsInRange(events, loMa, hiMa, categories = null) {
  return events
    .filter((e) => (!categories || categories.includes(e.category)))
    .filter((e) => e.time.ma >= loMa && e.time.ma <= hiMa)
    .sort((a, b) => b.time.ma - a.time.ma);
}

export function eventsNear(events, ma, windowMa, categories = null) {
  return getEventsInRange(events, ma - windowMa, ma + windowMa, categories);
}

export function getEvent(events, id) {
  return events.find((e) => e.id === id) || null;
}

export function getPeriodAt(periods, ma) {
  for (const p of periods) {
    if (ma <= p.start && ma >= p.end) return p;
  }
  if (periods.length === 0) return null;
  return ma > periods[0].start ? periods[0] : periods[periods.length - 1];
}

export function formatMa(ma) {
  if (ma < 0.001) return "Present Day";
  if (ma < 1) return `${Math.round(ma * 1000)} ka ago`;
  if (ma < 10) return `${ma.toFixed(2)} Ma ago`;
  if (ma < 100) return `${ma.toFixed(1)} Ma ago`;
  if (ma < 1000) return `${Math.round(ma)} Ma ago`;
  return `${(ma / 1000).toFixed(3)} Ga ago`;
}

export function formatEventDate(time) {
  if (time.year == null) return formatMa(time.ma);
  const y = time.year;
  const yStr = y < 0 ? `${-y} BCE` : `${y} CE`;
  if (time.precision === "day" && time.month && time.day) {
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    return `${months[time.month - 1]} ${time.day}, ${yStr}`;
  }
  if ((time.precision === "month") && time.month) {
    const months = ["January", "February", "March", "April", "May", "June",
      "July", "August", "September", "October", "November", "December"];
    return `${months[time.month - 1]} ${yStr}`;
  }
  if (time.precision === "century") return `c. ${yStr} (approx.)`;
  if (time.precision === "decade") return `c. ${yStr}`;
  return yStr;
}

export const CATEGORY_COLOR = {
  historical: "#e8574a",
  scientific: "#3ec7de",
  cultural: "#c98be0",
  geological_period: "#dcb734",
  tree_of_life: "#42d25a",
};

export const CATEGORY_LABEL = {
  historical: "Historical",
  scientific: "Scientific",
  cultural: "Cultural",
};
