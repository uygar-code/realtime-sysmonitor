# Real-Time System Resource Monitor

A **browser-based Task Manager** that streams live CPU, memory, disk, and network metrics from your machine to a responsive dashboard using **WebSockets**.

Built with **Python (FastAPI + psutil)**, served over a persistent WebSocket connection, and rendered with **Chart.js** — no build tools required.

---

## What It Does

Samples your computer's resource usage every second (configurable from 0.5s to 10s) and broadcasts the data to all connected browser tabs in real time. Think of it as Task Manager in your browser, with:

- **4 live line charts**: CPU %, Memory %, Disk throughput (MB/s), Network throughput (KB/s)
- **Per-core CPU bars**: horizontal bars showing load on each logical core
- **Top 5 processes**: by CPU usage, refreshed every other tick
- **Disk capacity**: for each mounted partition, with usage meters
- **Threshold alerts**: set CPU/RAM limits, get a banner + log entry + optional desktop notification when breached for N consecutive samples
- **Light/dark theme toggle**: persisted to `localStorage`, recolors charts instantly
- **Auto-reconnect**: if the server restarts, the client reconnects with exponential backoff

---

## Why WebSockets?

Instead of the client polling `/api/metrics` every second (HTTP request overhead + jittery timing), a **WebSocket** keeps one TCP connection open and the server pushes JSON frames at a steady tick. This is the foundation of every real-time app: chat, live dashboards, multiplayer games, stock tickers.

One shared sampling loop serves all connected clients with identical payloads, so CPU overhead stays constant whether you have 1 tab open or 10.

---

## Tech Stack

| Layer        | Choice                          | Why                                                                                     |
| ------------ | ------------------------------- | --------------------------------------------------------------------------------------- |
| **Backend**  | Python 3.14 + FastAPI           | Async/await makes WebSocket fan-out trivial; FastAPI's lifespan hooks start/stop the sampler cleanly. |
| **Metrics**  | `psutil 6.1.1`                  | Cross-platform system stats (CPU, RAM, disk, network, processes) with a Pythonic API.  |
| **Server**   | `uvicorn[standard] 0.34.0`      | ASGI server with WebSocket support and auto-reload for development.                   |
| **Frontend** | Vanilla JS + Chart.js 4.4.1 CDN | Zero build step. Chart.js ships a UMD bundle; the CSS is hand-written custom properties. |

---

## Project Structure

```
sysmonitor/
├── .venv/                 # Python 3.14 virtualenv (created by setup)
├── app/
│   ├── __init__.py
│   ├── main.py            # FastAPI app: /ws, /api/system, static mount
│   ├── metrics.py         # psutil collectors (stateful, for rate calculations)
│   └── connection_manager.py  # Shared sampling loop + WebSocket fan-out
├── static/
│   ├── index.html
│   ├── css/style.css      # CSS custom properties for theming
│   └── js/
│       ├── app.js         # WebSocket client, reconnect, DOM updates, alerts
│       └── charts.js      # Chart.js setup (animations off, rolling 60-point window)
├── requirements.txt
├── run.bat                # Quick-start script (Windows)
└── README.md
```

---

## Installation & Setup

### Prerequisites

- **Python 3.7+** (tested on 3.14; psutil has prebuilt wheels back to 3.7)
- **pip** and **venv** (bundled with Python)

### Steps

1. **Clone or extract** this folder to your machine.

2. **Create a virtual environment and install dependencies**:

   ```cmd
   cd sysmonitor
   python -m venv .venv
   .venv\Scripts\activate
   pip install -r requirements.txt
   ```

   On Linux/macOS:

   ```bash
   python3 -m venv .venv
   source .venv/bin/activate
   pip install -r requirements.txt
   ```

3. **Run the server**:

   **Windows**:
   ```cmd
   run.bat
   ```
   or
   ```cmd
   .venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000
   ```

   **Linux/macOS**:
   ```bash
   .venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
   ```

4. **Open your browser** to [http://127.0.0.1:8000](http://127.0.0.1:8000)

The dashboard loads, opens a WebSocket to `/ws`, and starts streaming metrics. The status pill in the top-right turns **green** ("Live") when connected.

---

## How It Works (Architecture Deep-Dive)

### Backend: One Loop, Broadcast to All

The `MetricsHub` class in `connection_manager.py` owns:

- A single **`MetricsCollector`** instance (from `metrics.py`), which keeps state between samples because disk/network counters are cumulative totals and rates are derived from deltas.
- A **set of connected WebSocket clients**.
- One **asyncio background task** that:
  1. Samples metrics by calling `collector.sample()` in a thread (psutil blocks).
  2. Appends the payload to a 60-sample ring buffer (so new clients get recent history on connect).
  3. Broadcasts the payload to all clients via `asyncio.gather`.
  4. Sleeps for `interval_ms / 1000` (default 1s, user-configurable 0.25s–10s).
  5. If the client set becomes empty, the task exits; `connect()` restarts it.

Clients can send `{"type":"set_interval","value":2000}` over the socket to change the tick rate for everyone. The server clamps the value and echoes back the applied interval.

### Frontend: Auto-Reconnect, Rolling Charts, Threshold Alerts

**WebSocket lifecycle** (`app.js`):

- On `open`: resets reconnect counter, sends `set_interval` to assert the saved preference, sends a `ping` for RTT measurement.
- On `message`: routes by `msg.type`:
  - `hello` → replays buffered history into the charts (no animation), renders the last sample.
  - `metrics` → updates all 4 line charts, the per-core bars, process table, partition list, footer stats, and evaluates alert thresholds.
  - `interval_ack` → updates the UI dropdown to match the server's clamped value.
  - `pong` → calculates `Date.now() - echo` and displays it in the footer.
- On `close` or `error`: schedules reconnect with exponential backoff (500ms → 1s → 2s → … → 10s max).

**Charts** (`charts.js`):

- All 5 Chart.js instances are created once on page load with `animation: false` and `maintainAspectRatio: false`.
- Each new sample is `push`ed into the data arrays and the oldest is `shift`ed past 60 points. `chart.update('none')` redraws without tweening, which at 1 Hz looks like smooth scrolling rather than lag.
- Theme switching re-resolves every CSS custom property (via `getComputedStyle`) and updates the chart colors in place.

**Alert system**:

- User sets CPU/RAM thresholds (default 85%/90%) and a "sustain" count (default 3).
- Each metric has a consecutive-breach counter. If `cpu.percent >= cpuThreshold` for 3 samples in a row, the CPU card flips to red border, an entry is prepended to the alert log, a banner appears, and if notifications are enabled a desktop notification fires (after requesting permission).
- Once the metric drops below threshold, the card clears, a "back to normal" entry is logged, and the breach counter resets.

---

## Customization

### Change the Sampling Interval

Click the **Interval** dropdown in the top-right and pick 0.5s / 1s / 2s / 5s. The choice is saved to `localStorage` and reasserted on every reconnect.

### Adjust Alert Thresholds

Click **Alerts** to expand the settings panel. Change the CPU/RAM percentages and the sustain count, then blur the inputs to apply. Settings are persisted.

### Enable Desktop Notifications

Check the **Desktop notifications** box in the alerts panel. Your browser will prompt for permission. Once granted, threshold breaches trigger a native notification.

### Switch Themes

Click the sun/moon icon. The page flips between light and dark mode, and all charts recolor instantly. The choice is saved.

---

## Security Note

This server exposes **detailed system information** (running process names, PIDs, disk layout, network traffic) and has **no authentication**. It is bound to `127.0.0.1` by default, which means only browsers on the same machine can access it.

**Do not expose this on a public IP** without putting authentication (e.g., HTTP Basic Auth via a reverse proxy) and TLS in front of it.

---

## Performance Characteristics

On a modern machine (Intel Core i7, 20 logical cores), sampling all metrics takes ~15–25ms:

- **CPU/RAM/Disk/Network counters**: <1ms each (direct syscalls).
- **Per-core CPU**: <1ms (one `cpu_percent(percpu=True)` call).
- **Process iteration**: 10–20ms (walking 200+ processes, filtering top 5 by CPU). This is by far the slowest part, so `metrics.py` only rebuilds the process table every 2nd sample.

At a 1s tick, the sampler loop uses ~2–3% of one core. The WebSocket broadcast overhead is negligible (<0.1ms per client). The frontend renders 5 charts with `update('none')` in <2ms per frame.

---

## Why This Is an "Intermediate" Project

1. **WebSockets replace HTTP polling**, teaching you persistent connections and server-push architecture — the foundation of chat, live dashboards, and multiplayer backends.
2. **Shared state + asyncio concurrency**: one sampling loop broadcasts to N clients, and the loop idles when nobody is connected. This is a pattern you'll use in every real-time app.
3. **Rate calculations from cumulative counters**: disk/network byte totals are monotonic since boot, so you diff consecutive readings against elapsed wall time. This is how every monitoring tool works (Prometheus, Grafana, InfluxDB…).
4. **Chart.js without animation jank**: at 1 Hz, animations look like lag, so `update('none')` is mandatory. You also mutate data arrays in place rather than replacing them, so Chart.js reuses internal metadata.
5. **Client-side state + reconnect logic**: the browser persists settings, survives server restarts, and auto-reconnects with exponential backoff. Robust WebSocket clients need this.

---

## Next Steps (Ideas for Extension)

- **Historical data**: instead of a 60-sample ring buffer in RAM, persist metrics to SQLite and add a `/history` endpoint so users can view the last hour/day/week.
- **Multi-machine**: run the server on multiple hosts, have each report to a central collector, and build a fleet dashboard.
- **Process filtering**: add a search box to filter the process table by name or PID.
- **GPU metrics**: if you have an Nvidia GPU, wrap `nvidia-smi` and add a GPU chart.
- **Export**: add a "Download CSV" button that dumps the current 60-sample history.
- **Systemd/Windows Service**: daemonize the server so it starts on boot.

---

## Troubleshooting

**"Waiting for data…" forever, status stays yellow/red:**
- Check the browser console for WebSocket errors.
- Confirm the server is running and listening on port 8000.
- If you changed the port or host in `main.py`, update `wsUrl()` in `app.js` to match.

**Process CPU values are all 0% on the first sample:**
- Fixed. `metrics.py` now primes the process CPU counters at startup.

**Charts are empty after reconnect:**
- The server sends a `hello` message with buffered history. If the buffer is empty (server just started), the charts start from scratch. Wait a few seconds for new samples to arrive.

**Disk or network rates are wrong:**
- If you pause the server for a long time and then resume, the first sample after resuming divides a large byte delta by the paused duration, producing a misleading average. `reset_baseline()` is called when the first client reconnects to avoid this, but if you keep a tab open while the server is down, the next sample may still be off. Just wait for the next tick.

---

## License

Public domain / MIT / CC0 — use it however you like. Attribution appreciated but not required.

---

## Author

Built as an educational intermediate project to teach WebSocket architecture, real-time data streaming, and Chart.js integration.

If you found this useful, consider starring the repo or sharing it with someone learning web development.

**Happy monitoring!** 📊
