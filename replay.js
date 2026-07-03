// replay.js — vessel track playback for the AIS map, reading history from Neon.
//
// Loaded on demand by replay() in index.html (never imported on a normal visit).
// Queries the Neon `history` table directly over HTTPS with the read-only viewer
// credential — no replay-server, no tunnel, no SQLite in the browser. One day at a
// time in EASTERN local time; pick a vessel to draw its archived positions as
// clickable dots joined by a faint time-ordered line. Big spatial gaps between
// consecutive dots mean we lost coms on that vessel for a while.
//
// Compute strategy (Neon scale-to-zero friendly): on start, ONE wake-up pulls
// everything for the common case — the tracked vessels' tracks AND the full vessel
// roster, both over the last 3 Eastern calendar days. Stepping days within that
// window for a tracked vessel is then pure client-side filtering (no query, so the
// instance can sleep). Neon is only re-queried when you pick a non-tracked vessel
// or step to a day older than the cached window.
//
// Requires:  GRANT SELECT ON history TO neondb_viewer;   (run once in Neon)

const NEON_VERSION = "1.1.0";
const WINDOW_DAYS = 3;
let started = false;

export async function start(ctx) {
  if (started) return;

  // --- connect (same viewer credential the project layers use) ---
  let sql;
  try {
    const mod = await import("https://esm.sh/@neondatabase/serverless@" + NEON_VERSION);
    sql = mod.neon(ctx.conn);
  } catch (e) {
    console.error("replay: driver load failed", e);
    alert("Could not load the database driver — see console.");
    return;
  }

  // run a parameterized query, return rows as plain objects
  async function q(text, params) {
    const res = await sql.query(text, params);
    return numify(res.rows || res);   // normalize bigint-as-string -> number
  }

  // --- upfront: range + tracked tracks + roster, over the 3-day Eastern window ---
  let range, trackedRows, roster;
  const win = windowBounds();   // [startMs, endMs) covering the last 3 Eastern days
  try {
    range = (await q("SELECT MIN(t) AS min, MAX(t) AS max FROM history WHERE t IS NOT NULL"))[0];
    if (!range || range.min == null) { alert("No timestamped rows in history."); return; }
    // MIN/MAX are BIGINT and come back as strings; numify() only touches mmsi/t,
    // so coerce them here. Otherwise new Date("1749…") is an Invalid Date and every
    // day bound downstream becomes NaN.
    range.min = Number(range.min);
    range.max = Number(range.max);

    // tracked vessels' tracks for the whole window (held in memory, filtered per day)
    const ph = ctx.WATCHED.map(function (_, i) { return "$" + (i + 1); }).join(",");
    trackedRows = await q(
      "SELECT mmsi,name,lat,lon,sog,cog,t,ais_source FROM history " +
      "WHERE mmsi IN (" + ph + ") AND t >= $" + (ctx.WATCHED.length + 1) +
      " AND t < $" + (ctx.WATCHED.length + 2) + " ORDER BY mmsi, t",
      ctx.WATCHED.concat([win[0], win[1]])
    );

    // every vessel seen in the window — populates the dropdown once
    roster = await q(
      "SELECT DISTINCT mmsi, name FROM history WHERE t >= $1 AND t < $2 ORDER BY name",
      [win[0], win[1]]
    );
  } catch (e) {
    console.error("replay: initial queries failed", e);
    alert("Replay query failed — see console.\n(Did you GRANT SELECT ON history TO neondb_viewer?)");
    return;
  }

  // index the preloaded tracked rows by mmsi for instant client-side day filtering
  const trackedByMmsi = new Map();
  for (const r of trackedRows) {
    if (!trackedByMmsi.has(r.mmsi)) trackedByMmsi.set(r.mmsi, []);
    trackedByMmsi.get(r.mmsi).push(r);
  }

  const firstDay = midnight(range.min);
  const lastDay = midnight(range.max);
  let currentDay = lastDay;                         // start on the most recent day
  let selectedMmsi = (ctx.WATCHED && ctx.WATCHED.length) ? ctx.WATCHED[0] : null;

  const layer = ctx.L.layerGroup().addTo(ctx.map);
  const ui = buildPanel();
  started = true;

  // dropdown: roster ∪ tracked (so a silent tracked vessel still appears), tracked first
  populateDropdown(ui.select, roster, trackedByMmsi, ctx.WATCHED);
  if (selectedMmsi != null) ui.select.value = String(selectedMmsi);

  // a day is "cached" if it falls inside the preloaded 3-day window
  function dayIsCached(dayMid) { return dayMid.getTime() >= win[0] && dayMid.getTime() < win[1]; }

  async function render() {
    ui.dateLabel.textContent = ymd(currentDay);
    ui.prevBtn.disabled = currentDay.getTime() <= firstDay.getTime();
    ui.nextBtn.disabled = currentDay.getTime() >= lastDay.getTime();
    layer.clearLayers();
    if (selectedMmsi == null) { ui.status.textContent = ""; return; }

    const b = dayBounds(currentDay);
    const isTracked = ctx.WATCHED.indexOf(selectedMmsi) !== -1;

    let pts;
    if (isTracked && dayIsCached(currentDay)) {
      // common case: filter the preloaded data — no Neon query, instance stays asleep
      pts = (trackedByMmsi.get(selectedMmsi) || []).filter(function (r) {
        return r.t != null && r.t >= b[0] && r.t < b[1];
      });
    } else {
      // other vessel, or a day outside the cached window: one on-demand query
      ui.status.textContent = "loading\u2026";
      try {
        pts = await q(
          "SELECT mmsi,name,lat,lon,sog,cog,t,ais_source FROM history " +
          "WHERE mmsi = $1 AND t >= $2 AND t < $3 ORDER BY t",
          [selectedMmsi, b[0], b[1]]
        );
      } catch (e) { console.error(e); ui.status.textContent = "query failed"; return; }
    }
    drawPoints(pts, isTracked);
  }

  function drawPoints(pts, isTracked) {
    pts = pts.filter(function (r) { return r.lat != null && r.lon != null; });
    if (pts.length === 0) { ui.status.textContent = "no positions this day"; return; }

    // faint connecting line in time order — gaps reveal lost coms
    const line = pts.map(function (r) { return [r.lat, r.lon]; });
    ctx.L.polyline(line, { color: isTracked ? "#ff5252" : "#37e8a0", weight: 1, opacity: 0.5 }).addTo(layer);

    // a clickable dot per position message
    for (const r of pts) {
      const fb = r.ais_source && r.ais_source !== "aisstream";
      const clr = fb ? "#8ab4f8" : (isTracked ? "#ff5252" : "#37e8a0");
      ctx.L.circleMarker([r.lat, r.lon], { radius: 3, color: clr, weight: 1, fillColor: clr, fillOpacity: 0.85 })
        .bindPopup(dotPopup(r, ctx)).addTo(layer);
    }
    ui.status.textContent = pts.length + " positions";
    ctx.map.fitBounds(line, { maxZoom: 13, padding: [40, 40] });
  }

  // wire controls
  ui.prevBtn.onclick = function () { currentDay = clampDay(addDays(currentDay, -1), firstDay, lastDay); render(); };
  ui.nextBtn.onclick = function () { currentDay = clampDay(addDays(currentDay, 1), firstDay, lastDay); render(); };
  ui.select.onchange = function () {
    const v = ui.select.value;
    selectedMmsi = v === "" ? null : Number(v);
    render();
  };
  ui.close.onclick = function () { layer.remove(); ui.wrap.remove(); started = false; };

  render();   // draw the default tracked vessel for today, from preloaded data
}

// --- helpers --------------------------------------------------------------------

// Neon returns BIGINT (mmsi, t) as strings; coerce the ones we compare/key on.
function numify(rows) {
  for (const r of rows) {
    if (r.mmsi != null) r.mmsi = Number(r.mmsi);
    if (r.t != null) r.t = Number(r.t);
  }
  return rows;
}

// last 3 Eastern calendar days: [midnight(today-2), midnight(today+1))
function windowBounds() {
  const n = new Date();
  const start = new Date(n.getFullYear(), n.getMonth(), n.getDate() - (WINDOW_DAYS - 1)).getTime();
  const end = new Date(n.getFullYear(), n.getMonth(), n.getDate() + 1).getTime();
  return [start, end];
}

function addDays(d, n) { return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n); }
function dayBounds(d) {
  return [new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(),
          new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime()];
}
function midnight(ms) { const d = new Date(ms); return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
function clampDay(d, lo, hi) {
  if (d.getTime() < lo.getTime()) return lo;
  if (d.getTime() > hi.getTime()) return hi;
  return d;
}
function ymd(d) {
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}

function populateDropdown(select, roster, trackedByMmsi, watched) {
  // merge roster with watched vessels (so a silent tracked boat still shows)
  const byMmsi = new Map();
  for (const r of roster) byMmsi.set(r.mmsi, r.name);
  for (const m of watched) {
    if (!byMmsi.has(m)) {
      const rows = trackedByMmsi.get(m);
      byMmsi.set(m, rows && rows.length ? rows[0].name : null);
    }
  }
  const list = Array.from(byMmsi.entries()).map(function (e) { return { mmsi: e[0], name: e[1] }; });

  // watched first, then alphabetical
  list.sort(function (a, b) {
    const aw = watched.indexOf(a.mmsi) !== -1 ? 0 : 1;
    const bw = watched.indexOf(b.mmsi) !== -1 ? 0 : 1;
    if (aw !== bw) return aw - bw;
    return String(a.name || a.mmsi).localeCompare(String(b.name || b.mmsi));
  });

  select.innerHTML = "";
  const blank = document.createElement("option");
  blank.value = ""; blank.textContent = "\u2014 pick a vessel (" + list.length + ") \u2014";
  select.appendChild(blank);
  for (const v of list) {
    const opt = document.createElement("option");
    opt.value = String(v.mmsi);
    const mark = watched.indexOf(v.mmsi) !== -1 ? "\u2605 " : "";
    opt.textContent = mark + (v.name ? v.name + " (" + v.mmsi + ")" : String(v.mmsi));
    select.appendChild(opt);
  }
}

function dotPopup(r, ctx) {
  const when = r.t != null ? new Date(r.t).toLocaleString() : "\u2014";
  const src = r.ais_source && r.ais_source !== "aisstream" ? "<br>Source: " + ctx.esc(String(r.ais_source)) : "";
  return "<b>" + ctx.esc(String(r.name || "UNKNOWN")) + "</b><br>"
    + "MMSI: " + r.mmsi + "<br>"
    + "Speed: " + (r.sog != null ? r.sog + " kn" : "\u2014") + "<br>"
    + "Course: " + (r.cog != null ? Math.round(r.cog) + "\u00B0" : "\u2014") + "<br>"
    + "Time: " + ctx.esc(String(when)) + src;
}

// --- floating control panel (bottom-left, matches the map theme) ----------------
function buildPanel() {
  const wrap = document.createElement("div");
  wrap.style.cssText =
    "position:absolute;bottom:12px;left:12px;z-index:1000;background:rgba(8,18,22,.92);" +
    "color:#cfeee2;border:1px solid #2c4a42;border-radius:6px;padding:10px 12px;" +
    "font-family:monospace;font-size:12px;min-width:240px;";

  const head = document.createElement("div");
  head.style.cssText = "display:flex;align-items:center;gap:8px;margin-bottom:8px;";
  const prevBtn = mkBtn("\u2039");
  const dateLabel = document.createElement("b");
  dateLabel.style.cssText = "color:#37e8a0;flex:1;text-align:center;";
  const nextBtn = mkBtn("\u203a");
  const close = mkBtn("\u2715");
  head.appendChild(prevBtn); head.appendChild(dateLabel); head.appendChild(nextBtn); head.appendChild(close);

  const select = document.createElement("select");
  select.style.cssText =
    "width:100%;box-sizing:border-box;background:#050d10;color:#cfeee2;" +
    "border:1px solid #2c4a42;border-radius:4px;padding:5px;font-family:monospace;font-size:12px;";

  const status = document.createElement("div");
  status.style.cssText = "margin-top:6px;color:#9fdfc8;min-height:1em;";

  wrap.appendChild(head); wrap.appendChild(select); wrap.appendChild(status);
  document.body.appendChild(wrap);
  return { wrap: wrap, prevBtn: prevBtn, nextBtn: nextBtn, dateLabel: dateLabel, select: select, status: status, close: close };
}

function mkBtn(label) {
  const b = document.createElement("button");
  b.textContent = label;
  b.style.cssText =
    "background:#1d3b34;color:#cfeee2;border:1px solid #2c4a42;border-radius:4px;" +
    "padding:4px 9px;font-family:monospace;font-size:13px;cursor:pointer;";
  return b;
}
