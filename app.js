/* ===================== Ledger app logic ===================== */

const STORAGE_KEY = "ledger:data:v1";
const COLORS = ["#C9A227", "#4F9E7A", "#5E8FC9", "#C1554B", "#A97BC9", "#5EC9B4", "#C97B5E"];

let state = { trackers: [], entries: [] };
let currentTrackerId = null;
let currentRange = "all";
let currentInterval = "auto"; // chart x-axis bucketing for count trackers: auto|monthly|quarterly|yearly
let editingTrackerId = null; // set when tracker modal is in edit mode
let selectedColor = COLORS[0];
let selectedType = "number";
let selectedFrequency = "daily";
let editingEntryId = null; // set when the entry-edit modal is open
let deferredInstallPrompt = null;

/* ---------- persistence ---------- */
function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) state = JSON.parse(raw);
  } catch (e) {
    console.error("Failed to load ledger data", e);
  }
}
function save() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
function todayStr() {
  const d = new Date();
  return d.toISOString().slice(0, 10);
}

/* ---------- helpers ---------- */
function trackerEntries(trackerId) {
  return state.entries
    .filter((e) => e.trackerId === trackerId)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id.localeCompare(b.id)));
}

function trackerFrequency(tracker) {
  return tracker.frequency || "daily";
}

// Which widget matches a tracker's frequency: Yearly gets a <select> of years
// (iOS renders it as a native scroll wheel), Monthly a month picker, otherwise
// a full date input. Swapping input <-> select replaces the element in the DOM,
// so callers must use the returned element, not the one they passed in.
function configureDateInput(input, frequency) {
  const wantSelect = frequency === "yearly";
  let el = input;
  if (wantSelect !== (input.tagName === "SELECT")) {
    el = document.createElement(wantSelect ? "select" : "input");
    el.id = input.id;
    el.className = input.className;
    const inlineStyle = input.getAttribute("style");
    if (inlineStyle) el.setAttribute("style", inlineStyle);
    input.replaceWith(el);
  }
  if (wantSelect) {
    if (!el.options.length) {
      const thisYear = new Date().getFullYear();
      for (let y = thisYear + 1; y >= 1900; y--) {
        el.add(new Option(String(y), String(y)));
      }
    }
  } else {
    el.type = frequency === "monthly" ? "month" : "date";
  }
  return el;
}

// yyyy-mm-dd -> whatever the widget for this frequency expects ("2026", "2026-07", or "2026-07-19")
function toInputValue(dateStr, frequency) {
  const [y, m] = dateStr.split("-");
  if (frequency === "yearly") return y;
  if (frequency === "monthly") return `${y}-${m}`;
  return dateStr;
}

// Whatever the widget produced -> a full yyyy-mm-dd (defaulting to day/month 01), or null if invalid
function fromInputValue(inputValue, frequency) {
  if (frequency === "yearly") {
    return /^\d{4}$/.test(inputValue) ? `${inputValue}-01-01` : null;
  }
  if (frequency === "monthly") {
    return /^\d{4}-\d{2}$/.test(inputValue) ? `${inputValue}-01` : null;
  }
  return inputValue || null;
}

// Collapses an actual entry date down to the start of its bucket (day/week/month/year).
function bucketKey(dateStr, frequency) {
  const [y, m, d] = dateStr.split("-").map(Number);
  if (frequency === "yearly") return `${y}-01-01`;
  if (frequency === "quarterly") return `${y}-${String(Math.floor((m - 1) / 3) * 3 + 1).padStart(2, "0")}-01`;
  if (frequency === "monthly") return `${y}-${String(m).padStart(2, "0")}-01`;
  if (frequency === "weekly") {
    const dt = new Date(y, m - 1, d);
    const day = dt.getDay(); // 0 Sun .. 6 Sat
    const diff = (day === 0 ? -6 : 1) - day; // back up to Monday
    dt.setDate(dt.getDate() + diff);
    return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
  }
  return dateStr; // daily — no bucketing
}

// Aggregate entries into one point per bucket, per tracker aggregation mode + frequency.
// freqOverride lets the chart re-bucket at a coarser interval than the tracker's own.
function aggregate(tracker, freqOverride) {
  const entries = trackerEntries(tracker.id); // ascending by date
  const freq = freqOverride || trackerFrequency(tracker);
  const byBucket = new Map();
  for (const e of entries) {
    const key = bucketKey(e.date, freq);
    if (tracker.type === "count") {
      byBucket.set(key, (byBucket.get(key) || 0) + Number(e.value));
    } else {
      byBucket.set(key, Number(e.value)); // latest entry in the bucket wins (list is sorted)
    }
  }
  return Array.from(byBucket.entries())
    .map(([date, value]) => ({ date, value }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
}

function formatValue(tracker, v) {
  if (v === null || v === undefined || isNaN(v)) return "—";
  if (tracker.type === "money") {
    const sign = v < 0 ? "-" : "";
    return sign + "$" + Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  const rounded = Math.round(v * 100) / 100;
  const s = rounded.toLocaleString(undefined, { maximumFractionDigits: 2 });
  return tracker.unit ? `${s} ${tracker.unit}` : s;
}

// Money for summary surfaces (stat strip, list rows): never show cents, and
// compact to $405K / $1.2M at high amounts so more stats fit on screen.
// The entries log keeps full formatValue precision — that's the raw record.
function formatMoneyCompact(v) {
  const sign = v < 0 ? "-" : "";
  const abs = Math.abs(v);
  if (abs >= 1000000) {
    const m = abs / 1000000;
    return sign + "$" + (m >= 10 ? Math.round(m) : Math.round(m * 10) / 10) + "M";
  }
  if (abs >= 100000) return sign + "$" + Math.round(abs / 1000) + "K";
  return sign + "$" + Math.round(abs).toLocaleString();
}

function formatSummaryValue(tracker, v) {
  if (v === null || v === undefined || isNaN(v)) return "—";
  if (tracker.type === "money") return formatMoneyCompact(v);
  return formatValue(tracker, v);
}

function formatDate(dstr) {
  const [y, m, d] = dstr.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

// Entry-list date display respecting frequency: yearly trackers just show "2026",
// monthly show "Jul 2026" — matching what was actually entered.
function formatEntryDate(dstr, frequency) {
  const [y, m, d] = dstr.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  if (frequency === "yearly") return String(y);
  if (frequency === "monthly") return dt.toLocaleDateString(undefined, { month: "short", year: "numeric" });
  return formatDate(dstr);
}
function formatDateShort(dstr) {
  const [y, m, d] = dstr.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// Like formatDateShort, but respects the tracker's logging frequency
// (e.g. a yearly net-worth tracker just shows "2024", not "Jan 1").
function formatBucketLabel(dstr, frequency) {
  const [y, m, d] = dstr.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  if (frequency === "yearly") return String(y);
  if (frequency === "quarterly") return `Q${Math.floor((m - 1) / 3) + 1} ${y}`;
  if (frequency === "monthly") return dt.toLocaleDateString(undefined, { month: "short", year: "numeric" });
  return dt.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// What the chart buckets by: the tracker's own frequency, unless a count
// tracker has a coarser interval selected.
function chartFrequency(tracker) {
  if (tracker.type !== "count" || currentInterval === "auto") return trackerFrequency(tracker);
  return currentInterval;
}

function toast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => t.classList.remove("show"), 1800);
}

/* ---------- rendering: list view ---------- */
function renderList() {
  const list = document.getElementById("tracker-list");
  const empty = document.getElementById("empty-state");
  list.innerHTML = "";

  if (state.trackers.length === 0) {
    empty.classList.remove("hidden");
    return;
  }
  empty.classList.add("hidden");

  for (const tracker of state.trackers) {
    const points = aggregate(tracker);
    const last = points[points.length - 1];
    const prev = points[points.length - 2];

    const row = document.createElement("div");
    row.className = "row";
    row.addEventListener("click", () => openDetail(tracker.id));

    const dot = document.createElement("div");
    dot.className = "row-dot";
    dot.style.background = tracker.color;

    const main = document.createElement("div");
    main.className = "row-main";
    const name = document.createElement("div");
    name.className = "row-name";
    name.textContent = tracker.name;
    const sub = document.createElement("div");
    sub.className = "row-sub";
    sub.textContent = last
      ? (tracker.type === "count" ? `today · ${points.length} logged` : `as of ${formatBucketLabel(last.date, trackerFrequency(tracker))}`)
      : "no entries yet";
    main.appendChild(name);
    main.appendChild(sub);

    const spark = document.createElement("canvas");
    spark.className = "row-spark";
    spark.width = 140; spark.height = 56;

    const valWrap = document.createElement("div");
    const val = document.createElement("div");
    val.className = "row-value";
    val.textContent = last ? formatSummaryValue(tracker, last.value) : "—";
    const delta = document.createElement("div");
    delta.className = "row-delta";
    if (last && prev !== undefined) {
      const d = last.value - prev.value;
      if (Math.abs(d) < 1e-9) {
        delta.textContent = "—";
        delta.classList.add("delta-flat");
      } else {
        delta.textContent = (d > 0 ? "▲ " : "▼ ") + formatSummaryValue(tracker, Math.abs(d));
        delta.classList.add(d > 0 ? "delta-up" : "delta-down");
      }
    } else {
      delta.textContent = "";
    }
    valWrap.appendChild(val);
    valWrap.appendChild(delta);

    row.appendChild(dot);
    row.appendChild(main);
    row.appendChild(spark);
    row.appendChild(valWrap);
    list.appendChild(row);

    drawSparkline(spark, points, tracker.color);
  }
}

function drawSparkline(canvas, points, color) {
  const ctx = canvas.getContext("2d");
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  if (points.length < 2) return;
  const vals = points.map((p) => p.value);
  const min = Math.min(...vals), max = Math.max(...vals);
  const range = max - min || 1;
  const pad = 6;
  ctx.beginPath();
  points.forEach((p, i) => {
    const x = pad + (i / (points.length - 1)) * (w - pad * 2);
    const y = h - pad - ((p.value - min) / range) * (h - pad * 2);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.stroke();
}

/* ---------- rendering: detail view ---------- */
function openDetail(trackerId) {
  currentTrackerId = trackerId;
  currentRange = "all";
  currentInterval = "auto";
  location.hash = "#/tracker/" + trackerId;
  showDetailView();
}

function showDetailView() {
  const tracker = state.trackers.find((t) => t.id === currentTrackerId);
  if (!tracker) { showListView(); return; }

  document.getElementById("view-list").classList.add("hidden");
  document.getElementById("view-detail").classList.remove("hidden");
  document.getElementById("detail-title").textContent = tracker.name;

  document.querySelectorAll("#chart-range .range-btn").forEach((b) =>
    b.classList.toggle("active", b.dataset.range === currentRange)
  );

  const intervalRow = document.getElementById("chart-interval");
  intervalRow.classList.toggle("hidden", tracker.type !== "count");
  if (tracker.type === "count") {
    const freqLabel = { daily: "DAY", weekly: "WK", monthly: "MO", yearly: "YR" };
    document.getElementById("interval-auto-btn").textContent = freqLabel[trackerFrequency(tracker)] || "DAY";
    intervalRow.querySelectorAll(".range-btn").forEach((b) =>
      b.classList.toggle("active", b.dataset.interval === currentInterval)
    );
  }

  renderStats(tracker);
  renderChart(tracker);
  renderQuickAdd(tracker);
  renderEntries(tracker);
}

function showListView() {
  currentTrackerId = null;
  if (location.hash) history.pushState("", document.title, location.pathname + location.search);
  document.getElementById("view-detail").classList.add("hidden");
  document.getElementById("view-list").classList.remove("hidden");
  renderList();
}

// Whole days between two yyyy-mm-dd dates.
function dateDiffDays(a, b) {
  const [y1, m1, d1] = a.split("-").map(Number);
  const [y2, m2, d2] = b.split("-").map(Number);
  return Math.round((new Date(y2, m2 - 1, d2) - new Date(y1, m1 - 1, d1)) / 86400000);
}

// Round a rate to something readable: 12, 3.4, 0.8
function roundRate(n) {
  return n >= 10 ? Math.round(n) : Math.round(n * 10) / 10;
}

const FREQ_DAYS = { daily: 1, weekly: 7, monthly: 30.44, yearly: 365.25 };
const FREQ_UNIT = { daily: "day", weekly: "wk", monthly: "mo", yearly: "yr" };
const FREQ_BUCKET_NAME = { daily: "day", weekly: "week", monthly: "month", yearly: "year" };

function rangeStatLabel() {
  return { 30: "30D", 90: "90D", 180: "180D", 365: "1Y", 1095: "3Y", 1825: "5Y" }[currentRange] || "ALL";
}

// Stats follow the chart's selected range: with 1Y active, every stat is
// computed over the last year only (ALL behaves as before).
function renderStats(tracker) {
  const allPoints = aggregate(tracker);
  const ranged = currentRange !== "all";
  const n = Number(currentRange);
  const inRange = (d) => !ranged || daysAgo(d) <= n;
  const points = allPoints.filter((p) => inRange(p.date));
  const strip = document.getElementById("stat-strip");
  strip.innerHTML = "";

  const addStat = (label, value, sub) => {
    const s = document.createElement("div");
    s.className = "stat";
    s.innerHTML = `<div class="stat-label">${label}</div><div class="stat-val">${value}</div>` +
      (sub ? `<div class="stat-sub">${sub}</div>` : "");
    strip.appendChild(s);
  };

  if (allPoints.length === 0) {
    addStat("STATUS", "no data yet");
    return;
  }
  if (points.length === 0) {
    addStat("STATUS", `nothing in last ${rangeStatLabel()}`);
    return;
  }

  const freq = trackerFrequency(tracker);
  const suffix = ranged ? " " + rangeStatLabel() : "";

  if (tracker.type === "count") {
    const allEntries = trackerEntries(tracker.id); // ascending by date
    const entries = allEntries.filter((e) => inRange(e.date));
    const total = points.reduce((s, p) => s + p.value, 0);
    addStat("TOTAL" + suffix, formatSummaryValue(tracker, total));
    if (!ranged || n > 30) {
      const last30 = points.filter((p) => daysAgo(p.date) <= 30).reduce((s, p) => s + p.value, 0);
      addStat("LAST 30D", formatSummaryValue(tracker, last30));
    }

    // Rate over the window (first in-range entry through today), expressed in
    // the tracker's own timescale; a daily tracker slower than 1/day flips to
    // the more natural "every N days".
    let spanDays = Math.max(1, daysAgo(entries[0].date) + 1);
    if (ranged) spanDays = Math.min(spanDays, n);
    const perDay = total / spanDays;
    if (freq === "daily" && perDay < 1 && total > 0) {
      addStat("FREQUENCY" + suffix, `every ${Math.round(spanDays / total)}d`);
    } else {
      addStat("RATE" + suffix, `${roundRate(perDay * FREQ_DAYS[freq])} / ${FREQ_UNIT[freq]}`);
    }

    const best = points.reduce((a, b) => (b.value > a.value ? b : a));
    addStat("BEST " + FREQ_BUCKET_NAME[freq].toUpperCase() + suffix, formatSummaryValue(tracker, best.value),
      formatBucketLabel(best.date, freq));

    const dates = [...new Set(entries.map((e) => e.date))];
    if (dates.length >= 2) {
      let maxGap = 0;
      for (let i = 1; i < dates.length; i++) {
        maxGap = Math.max(maxGap, dateDiffDays(dates[i - 1], dates[i]));
      }
      addStat("LONGEST GAP" + suffix, `${maxGap}d`);
    }

    const ago = daysAgo(allEntries[allEntries.length - 1].date);
    addStat("LAST LOGGED", ago <= 0 ? "today" : `${ago}d ago`);
  } else {
    const first = points[0], last = points[points.length - 1];
    const change = last.value - first.value;
    addStat("CURRENT", formatSummaryValue(tracker, allPoints[allPoints.length - 1].value));
    addStat(ranged ? "Δ " + rangeStatLabel() : "SINCE START",
      (change >= 0 ? "+" : "") + formatSummaryValue(tracker, change));

    const high = points.reduce((a, b) => (b.value > a.value ? b : a));
    const low = points.reduce((a, b) => (b.value < a.value ? b : a));
    addStat("HIGH" + suffix, formatSummaryValue(tracker, high.value), formatBucketLabel(high.date, freq));
    addStat("LOW" + suffix, formatSummaryValue(tracker, low.value), formatBucketLabel(low.date, freq));

    // Average movement per day/week/month/year across the windowed span.
    const spanDays = dateDiffDays(first.date, last.date);
    if (points.length >= 2 && spanDays > 0) {
      const perUnit = change / (spanDays / FREQ_DAYS[freq]);
      addStat("AVG Δ / " + FREQ_UNIT[freq].toUpperCase() + suffix,
        (perUnit >= 0 ? "+" : "") + formatSummaryValue(tracker, perUnit));
    }

    addStat("LOGGED" + suffix, points.length + (points.length === 1 ? " entry" : " entries"));
  }
}

function daysAgo(dstr) {
  const [y, m, d] = dstr.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  return Math.round((Date.now() - dt.getTime()) / 86400000);
}

// Start of the bucket after the given one, per bucketing frequency.
function nextBucketStart(dateStr, freq) {
  const [y, m, d] = dateStr.split("-").map(Number);
  if (freq === "yearly") return `${y + 1}-01-01`;
  if (freq === "quarterly" || freq === "monthly") {
    const total = (m - 1) + (freq === "monthly" ? 1 : 3);
    return `${y + Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, "0")}-01`;
  }
  const dt = new Date(y, m - 1, d + (freq === "weekly" ? 7 : 1));
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
}

// A tally tracker's quiet buckets are real zeros: fill every bucket between
// the first logged one and today, so the trend line drops to 0 on days with
// no occurrences instead of connecting logged days directly.
function zeroFill(points, freq) {
  if (points.length === 0) return points;
  const byDate = new Map(points.map((p) => [p.date, p.value]));
  const filled = [];
  const end = bucketKey(todayStr(), freq);
  let cur = points[0].date;
  let guard = 40000; // ~100 years of daily buckets
  while (cur <= end && guard-- > 0) {
    filled.push({ date: cur, value: byDate.get(cur) || 0 });
    cur = nextBucketStart(cur, freq);
  }
  return filled;
}

function filteredPoints(tracker) {
  const freq = chartFrequency(tracker);
  let points = aggregate(tracker, freq);
  if (tracker.type === "count") points = zeroFill(points, freq);
  if (currentRange === "all") return points;
  const n = Number(currentRange);
  return points.filter((p) => daysAgo(p.date) <= n);
}

function renderChart(tracker) {
  const canvas = document.getElementById("chart");
  const points = filteredPoints(tracker);
  drawChart(canvas, points, tracker);
}

function drawChart(canvas, points, tracker) {
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.parentElement.clientWidth - 16;
  const cssH = 200;
  canvas.style.width = cssW + "px";
  canvas.style.height = cssH + "px";
  canvas.width = cssW * dpr;
  canvas.height = cssH * dpr;
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  if (points.length === 0) {
    ctx.fillStyle = "#7B818C";
    ctx.font = "13px Inter, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("No entries in this range", cssW / 2, cssH / 2);
    return;
  }

  const vals = points.map((p) => p.value);
  let min = Math.min(...vals), max = Math.max(...vals);
  let ySteps = 4;
  if (tracker.type === "count") {
    // Tallies are whole numbers: baseline at 0 and use integer gridlines only.
    min = 0;
    const step = Math.max(1, Math.ceil(max / 4));
    ySteps = Math.max(1, Math.ceil(max / step));
    max = step * ySteps;
  } else {
    if (min === max) { min -= 1; max += 1; }
    const spread = max - min;
    min -= spread * 0.08;
    max += spread * 0.08;
  }

  // Size the left gutter to the widest y label, so long values (e.g. a
  // negative "-391.8k") don't get their leading characters clipped.
  ctx.font = "10px 'IBM Plex Mono', monospace";
  const yLabels = [];
  for (let i = 0; i <= ySteps; i++) {
    yLabels.push(String(shortNum(min + ((max - min) * i) / ySteps, tracker)));
  }
  const labelW = Math.max(...yLabels.map((l) => ctx.measureText(l).width));
  const padL = Math.max(46, Math.ceil(labelW) + 14), padR = 12, padT = 14, padB = 24;
  const plotW = cssW - padL - padR;
  const plotH = cssH - padT - padB;

  // gridlines + y labels
  ctx.strokeStyle = "rgba(255,255,255,0.07)";
  ctx.fillStyle = "#7B818C";
  ctx.textAlign = "right";
  for (let i = 0; i <= ySteps; i++) {
    const v = min + ((max - min) * i) / ySteps;
    const y = padT + plotH - (i / ySteps) * plotH;
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(padL + plotW, y);
    ctx.stroke();
    ctx.fillText(shortNum(v, tracker), padL - 8, y + 3);
  }

  // x labels (start, mid, end)
  ctx.textAlign = "center";
  const xIdxs = points.length === 1 ? [0] : [0, Math.floor((points.length - 1) / 2), points.length - 1];
  const freq = chartFrequency(tracker);
  xIdxs.forEach((idx) => {
    const x = padL + (points.length === 1 ? plotW / 2 : (idx / (points.length - 1)) * plotW);
    ctx.fillText(formatBucketLabel(points[idx].date, freq), x, cssH - 6);
  });

  const xFor = (i) => padL + (points.length === 1 ? plotW / 2 : (i / (points.length - 1)) * plotW);
  const yFor = (v) => padT + plotH - ((v - min) / (max - min)) * plotH;

  // area fill
  if (points.length > 1) {
    ctx.beginPath();
    points.forEach((p, i) => {
      const x = xFor(i), y = yFor(p.value);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.lineTo(xFor(points.length - 1), padT + plotH);
    ctx.lineTo(xFor(0), padT + plotH);
    ctx.closePath();
    const grad = ctx.createLinearGradient(0, padT, 0, padT + plotH);
    grad.addColorStop(0, hexAlpha(tracker.color, 0.28));
    grad.addColorStop(1, hexAlpha(tracker.color, 0));
    ctx.fillStyle = grad;
    ctx.fill();
  }

  // line
  ctx.beginPath();
  points.forEach((p, i) => {
    const x = xFor(i), y = yFor(p.value);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = tracker.color;
  ctx.lineWidth = 2.2;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.stroke();

  // points (zero-filled buckets get the line dip but no dot marker)
  points.forEach((p, i) => {
    if (tracker.type === "count" && p.value === 0) return;
    const x = xFor(i), y = yFor(p.value);
    ctx.beginPath();
    ctx.arc(x, y, points.length > 60 ? 0 : 3, 0, Math.PI * 2);
    ctx.fillStyle = "#12151A";
    ctx.fill();
    ctx.lineWidth = 1.6;
    ctx.strokeStyle = tracker.color;
    ctx.stroke();
  });
}

function shortNum(v, tracker) {
  if (tracker.type === "money") {
    const abs = Math.abs(v);
    if (abs >= 1000000) return (v / 1000000).toFixed(1) + "M";
    if (abs >= 1000) return (v / 1000).toFixed(1) + "k";
    return "$" + Math.round(v);
  }
  const abs = Math.abs(v);
  if (abs >= 1000) return (v / 1000).toFixed(1) + "k";
  return Math.round(v * 10) / 10;
}

function hexAlpha(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function renderQuickAdd(tracker) {
  const numWrap = document.getElementById("quickadd-number");
  const countWrap = document.getElementById("quickadd-count");
  const freq = trackerFrequency(tracker);
  if (tracker.type === "count") {
    numWrap.classList.add("hidden");
    countWrap.classList.remove("hidden");
    const countDateEl = configureDateInput(document.getElementById("qa-count-date"), freq);
    countDateEl.value = toInputValue(todayStr(), freq);
    document.getElementById("qa-count-value").value = "";
  } else {
    countWrap.classList.add("hidden");
    numWrap.classList.remove("hidden");
    const dateEl = configureDateInput(document.getElementById("qa-date"), freq);
    dateEl.value = toInputValue(todayStr(), freq);
    document.getElementById("qa-value").value = "";
    document.getElementById("qa-value").placeholder = tracker.unit ? `value (${tracker.unit})` : "value";
  }
}

function renderEntries(tracker) {
  const wrap = document.getElementById("entries-list");
  const label = document.getElementById("entries-label");
  const entries = trackerEntries(tracker.id).slice().reverse();
  label.textContent = tracker.type === "count" ? `Log (${entries.length} entries)` : `Entries (${entries.length})`;
  wrap.innerHTML = "";

  if (entries.length === 0) {
    const p = document.createElement("div");
    p.style.cssText = "padding:24px 4px;color:var(--muted);font-size:13px;";
    p.textContent = "No entries yet — add one below.";
    wrap.appendChild(p);
    return;
  }

  for (const e of entries) {
    const row = document.createElement("div");
    row.className = "entry-row";
    const date = document.createElement("div");
    date.className = "entry-date";
    date.textContent = formatEntryDate(e.date, trackerFrequency(tracker));
    const note = document.createElement("div");
    note.className = "entry-note";
    note.textContent = "";
    const val = document.createElement("div");
    val.className = "entry-val";
    val.textContent = formatValue(tracker, e.value);
    const edit = document.createElement("button");
    edit.className = "entry-del";
    edit.textContent = "✎";
    edit.title = "Edit entry";
    edit.addEventListener("click", () => openEntryModal(e.id));
    const del = document.createElement("button");
    del.className = "entry-del";
    del.textContent = "✕";
    del.title = "Delete entry";
    del.addEventListener("click", () => {
      state.entries = state.entries.filter((x) => x.id !== e.id);
      save();
      showDetailView();
    });
    row.appendChild(date);
    row.appendChild(note);
    row.appendChild(val);
    row.appendChild(edit);
    row.appendChild(del);
    wrap.appendChild(row);
  }
}

/* ---------- entry edit modal ---------- */
function openEntryModal(entryId) {
  const entry = state.entries.find((e) => e.id === entryId);
  if (!entry) return;
  const tracker = state.trackers.find((t) => t.id === entry.trackerId) || {};
  const freq = trackerFrequency(tracker);
  editingEntryId = entryId;
  const dateEl = configureDateInput(document.getElementById("ee-date"), freq);
  dateEl.value = toInputValue(entry.date, freq);
  document.getElementById("ee-value").value = entry.value;
  document.getElementById("entry-modal-overlay").classList.remove("hidden");
}

function closeEntryModal() {
  editingEntryId = null;
  document.getElementById("entry-modal-overlay").classList.add("hidden");
}

function saveEntryFromModal() {
  const entry = state.entries.find((e) => e.id === editingEntryId);
  if (!entry) return;
  const tracker = state.trackers.find((t) => t.id === entry.trackerId) || {};
  const freq = trackerFrequency(tracker);
  const date = fromInputValue(document.getElementById("ee-date").value, freq);
  const raw = document.getElementById("ee-value").value;
  if (!date) { toast(freq === "yearly" ? "Enter a valid year" : freq === "monthly" ? "Pick a month" : "Pick a date"); return; }
  if (raw === "") { toast("Enter a value"); return; }
  const value = Number(raw);
  if (isNaN(value)) { toast("That's not a number"); return; }
  entry.date = date;
  entry.value = value;
  save();
  closeEntryModal();
  showDetailView();
  toast("Entry updated");
}

function deleteEntryFromModal() {
  if (!editingEntryId) return;
  state.entries = state.entries.filter((e) => e.id !== editingEntryId);
  save();
  closeEntryModal();
  showDetailView();
  toast("Deleted");
}

/* ---------- tracker modal ---------- */
function openTrackerModal(editId) {
  editingTrackerId = editId || null;
  const overlay = document.getElementById("tracker-modal-overlay");
  const title = document.getElementById("tracker-modal-title");
  const nameInput = document.getElementById("tk-name");
  const unitInput = document.getElementById("tk-unit");

  if (editId) {
    const tracker = state.trackers.find((t) => t.id === editId);
    title.textContent = "Edit tracker";
    nameInput.value = tracker.name;
    unitInput.value = tracker.unit || "";
    selectedType = tracker.type;
    selectedColor = tracker.color;
    selectedFrequency = tracker.frequency || "daily";
  } else {
    title.textContent = "New tracker";
    nameInput.value = "";
    unitInput.value = "";
    selectedType = "number";
    selectedColor = COLORS[state.trackers.length % COLORS.length];
    selectedFrequency = "daily";
  }

  document.querySelectorAll(".type-choice[data-type]").forEach((el) =>
    el.classList.toggle("selected", el.dataset.type === selectedType)
  );
  document.querySelectorAll(".type-choice[data-freq]").forEach((el) =>
    el.classList.toggle("selected", el.dataset.freq === selectedFrequency)
  );
  renderColorChoices();
  overlay.classList.remove("hidden");
  setTimeout(() => nameInput.focus(), 50);
}

function renderColorChoices() {
  const wrap = document.getElementById("color-choices");
  wrap.innerHTML = "";
  COLORS.forEach((c) => {
    const dot = document.createElement("div");
    dot.className = "color-dot" + (c === selectedColor ? " selected" : "");
    dot.style.background = c;
    dot.addEventListener("click", () => {
      selectedColor = c;
      renderColorChoices();
    });
    wrap.appendChild(dot);
  });
}

function closeTrackerModal() {
  document.getElementById("tracker-modal-overlay").classList.add("hidden");
}

function saveTrackerFromModal() {
  const name = document.getElementById("tk-name").value.trim();
  const unit = document.getElementById("tk-unit").value.trim();
  if (!name) { toast("Give it a name first"); return; }

  if (editingTrackerId) {
    const tracker = state.trackers.find((t) => t.id === editingTrackerId);
    tracker.name = name;
    tracker.unit = unit;
    tracker.type = selectedType;
    tracker.color = selectedColor;
    tracker.frequency = selectedFrequency;
  } else {
    state.trackers.push({
      id: uid(),
      name,
      type: selectedType,
      unit,
      color: selectedColor,
      frequency: selectedFrequency,
      createdAt: todayStr(),
    });
  }
  save();
  closeTrackerModal();
  if (currentTrackerId) showDetailView(); else renderList();
  toast("Saved");
}

/* ---------- entry add ---------- */
function addNumberEntry() {
  const tracker = state.trackers.find((t) => t.id === currentTrackerId);
  const freq = trackerFrequency(tracker);
  const dateInput = document.getElementById("qa-date");
  const date = fromInputValue(dateInput.value, freq);
  if (!date) {
    toast(freq === "yearly" ? "Enter a valid year" : freq === "monthly" ? "Pick a month" : "Pick a date");
    return;
  }
  const raw = document.getElementById("qa-value").value;
  if (raw === "") { toast("Enter a value"); return; }
  const value = Number(raw);
  if (isNaN(value)) { toast("That's not a number"); return; }

  // replace existing entry for same date+tracker so "snapshot" semantics hold cleanly
  const existing = state.entries.find((e) => e.trackerId === tracker.id && e.date === date);
  if (existing) existing.value = value;
  else state.entries.push({ id: uid(), trackerId: tracker.id, date, value });

  save();
  showDetailView();
  toast("Logged " + formatValue(tracker, value));
}

function addCountEntry(amount, date) {
  const tracker = state.trackers.find((t) => t.id === currentTrackerId);
  state.entries.push({ id: uid(), trackerId: tracker.id, date: date || todayStr(), value: amount });
  save();
  showDetailView();
  toast(`Logged +${amount}`);
}

/* ---------- delete tracker ---------- */
function deleteCurrentTracker() {
  const tracker = state.trackers.find((t) => t.id === currentTrackerId);
  if (!tracker) return;
  if (!confirm(`Delete "${tracker.name}" and all its entries? This can't be undone.`)) return;
  state.trackers = state.trackers.filter((t) => t.id !== tracker.id);
  state.entries = state.entries.filter((e) => e.trackerId !== tracker.id);
  save();
  showListView();
  toast("Deleted");
}

/* ---------- import / export ---------- */
function exportData() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `ledger-backup-${todayStr()}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  toast("Exported");
}

function importData(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsed = JSON.parse(reader.result);
      if (!parsed.trackers || !parsed.entries) throw new Error("bad shape");
      const merge = confirm("Merge with existing data? Cancel to replace everything instead.");
      if (merge) {
        const existingIds = new Set(state.trackers.map((t) => t.id));
        parsed.trackers.forEach((t) => { if (!existingIds.has(t.id)) state.trackers.push(t); });
        const existingEntryIds = new Set(state.entries.map((e) => e.id));
        parsed.entries.forEach((e) => { if (!existingEntryIds.has(e.id)) state.entries.push(e); });
      } else {
        state = parsed;
      }
      save();
      renderList();
      toast("Imported");
    } catch (e) {
      toast("Couldn't read that file");
    }
  };
  reader.readAsText(file);
}

/* ---------- routing ---------- */
function handleRoute() {
  const m = location.hash.match(/^#\/tracker\/(.+)$/);
  if (m && state.trackers.find((t) => t.id === m[1])) {
    currentTrackerId = m[1];
    currentInterval = "auto";
    currentRange = "all";
    showDetailView();
  } else {
    showListView();
  }
}

/* ---------- wire up events ---------- */
function init() {
  load();

  document.getElementById("menu-btn").addEventListener("click", () =>
    document.getElementById("menu-modal-overlay").classList.remove("hidden")
  );
  document.getElementById("menu-close").addEventListener("click", () =>
    document.getElementById("menu-modal-overlay").classList.add("hidden")
  );
  document.getElementById("export-btn").addEventListener("click", exportData);
  document.getElementById("import-btn").addEventListener("click", () =>
    document.getElementById("import-file").click()
  );
  document.getElementById("import-file").addEventListener("change", (e) => {
    if (e.target.files[0]) importData(e.target.files[0]);
    e.target.value = "";
  });

  document.querySelectorAll(".fab-placeholder"); // no-op guard
  const fab = document.createElement("button");
  fab.className = "fab";
  fab.textContent = "+";
  fab.addEventListener("click", () => openTrackerModal(null));
  document.body.appendChild(fab);

  document.getElementById("back-btn").addEventListener("click", showListView);
  document.getElementById("edit-tracker-btn").addEventListener("click", () => openTrackerModal(currentTrackerId));
  document.getElementById("delete-tracker-btn").addEventListener("click", deleteCurrentTracker);

  document.getElementById("tracker-cancel").addEventListener("click", closeTrackerModal);
  document.getElementById("tracker-save").addEventListener("click", saveTrackerFromModal);
  document.querySelectorAll(".type-choice[data-type]").forEach((el) =>
    el.addEventListener("click", () => {
      selectedType = el.dataset.type;
      document.querySelectorAll(".type-choice[data-type]").forEach((x) => x.classList.toggle("selected", x === el));
    })
  );
  document.querySelectorAll(".type-choice[data-freq]").forEach((el) =>
    el.addEventListener("click", () => {
      selectedFrequency = el.dataset.freq;
      document.querySelectorAll(".type-choice[data-freq]").forEach((x) => x.classList.toggle("selected", x === el));
    })
  );

  document.getElementById("ee-cancel").addEventListener("click", closeEntryModal);
  document.getElementById("ee-save").addEventListener("click", saveEntryFromModal);
  document.getElementById("ee-delete").addEventListener("click", deleteEntryFromModal);

  document.getElementById("qa-add").addEventListener("click", addNumberEntry);
  document.getElementById("qa-value").addEventListener("keydown", (e) => { if (e.key === "Enter") addNumberEntry(); });

  document.getElementById("qa-tally").addEventListener("click", () => addCountEntry(1, todayStr()));
  document.getElementById("qa-count-add").addEventListener("click", () => {
    const tracker = state.trackers.find((t) => t.id === currentTrackerId);
    const freq = trackerFrequency(tracker);
    const date = fromInputValue(document.getElementById("qa-count-date").value, freq) || todayStr();
    const amt = Number(document.getElementById("qa-count-value").value || "1");
    if (isNaN(amt) || amt === 0) { toast("Enter an amount"); return; }
    addCountEntry(amt, date);
  });

  document.getElementById("chart-range").addEventListener("click", (e) => {
    const btn = e.target.closest(".range-btn");
    if (!btn) return;
    currentRange = btn.dataset.range;
    document.querySelectorAll("#chart-range .range-btn").forEach((b) => b.classList.toggle("active", b === btn));
    const tracker = state.trackers.find((t) => t.id === currentTrackerId);
    if (tracker) { renderChart(tracker); renderStats(tracker); }
  });

  document.getElementById("chart-interval").addEventListener("click", (e) => {
    const btn = e.target.closest(".range-btn");
    if (!btn) return;
    currentInterval = btn.dataset.interval;
    document.querySelectorAll("#chart-interval .range-btn").forEach((b) => b.classList.toggle("active", b === btn));
    const tracker = state.trackers.find((t) => t.id === currentTrackerId);
    if (tracker) renderChart(tracker);
  });

  window.addEventListener("hashchange", handleRoute);
  window.addEventListener("resize", () => {
    if (currentTrackerId) {
      const tracker = state.trackers.find((t) => t.id === currentTrackerId);
      if (tracker) renderChart(tracker);
    }
  });

  // install prompt
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    document.getElementById("install-banner").classList.remove("hidden");
  });
  document.getElementById("install-btn").addEventListener("click", async () => {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    document.getElementById("install-banner").classList.add("hidden");
  });
  window.addEventListener("appinstalled", () => {
    document.getElementById("install-banner").classList.add("hidden");
  });

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch((err) => console.warn("SW registration failed", err));
  }

  handleRoute();
}

document.addEventListener("DOMContentLoaded", init);
