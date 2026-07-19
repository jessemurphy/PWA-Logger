# Ledger — a Loggr-style tracker PWA

Track any value by date — numbers (weight, blood pressure), money (net worth, savings),
or occurrences (cups of water, cigars, workouts) — and see it progress on a chart.

## Running it

Service workers and installable PWAs require **http/https**, not `file://`. Easiest options:

**Quick local test:**
```
cd loggr-pwa
python3 -m http.server 8080
```
Then open `http://localhost:8080` in Safari/Chrome. On iPhone, use Share → "Add to Home Screen"
to install it like a native app (works fully offline after the first load).

**Permanent hosting (free, gives you a real URL you can install from any device):**
- GitHub Pages: push this folder to a repo, enable Pages in Settings → Pages
- Netlify / Vercel: drag-and-drop the folder in their web dashboard
- Or drop it in any existing static web host you already run

## How it works

- Every tracker has a **type**: Number/Money are "snapshot" trackers (one value per bucket —
  net worth, weight), Occurrence is a "tally" tracker (sums however many times you log it
  within a bucket — cups of water, reps).
- Every tracker also has a **frequency** (Daily/Weekly/Monthly/Yearly) that sets the graph's
  timescale. A yearly net-worth tracker collapses everything you log within a calendar year
  down to one point (the latest entry that year), and the chart's x-axis just shows years —
  instead of a flat daily line with one point a year on it.
- Tap the **✎** on any entry to fix a typo'd date or value; **✕** deletes it outright.
- All data is stored locally in the browser (`localStorage`) — nothing leaves your device.
- Use the **⋯ menu → Export JSON** regularly to back up your data, especially before clearing
  browser data or switching phones. Import merges or replaces.
- Tap a tracker to see its chart, filter by 30D/90D/1Y/All, and see all logged entries.

## Files

- `index.html` / `style.css` / `app.js` — the app
- `manifest.json` / `sw.js` — makes it installable + offline-capable
- `icons/` — app icons
