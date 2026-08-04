/* ---------------------------------------------------------------------------
   Dashboard client: WebSocket lifecycle, DOM rendering, threshold alerts.

   All rendered values come from the server, and process names in particular are
   arbitrary strings from the OS. Everything is written with textContent (never
   innerHTML) so a process named `<img onerror=...>` stays inert text.
--------------------------------------------------------------------------- */

(() => {
  'use strict';

  // --------------------------------------------------------------- constants

  const STORE_KEY = 'sysmonitor.settings';
  const RECONNECT_BASE_MS = 500;
  const RECONNECT_MAX_MS = 10000;
  const ALERT_LOG_MAX = 50;

  const DEFAULTS = {
    theme: 'dark',
    intervalMs: 1000,
    cpuThreshold: 85,
    ramThreshold: 90,
    sustain: 3,
    notify: false,
  };

  // ------------------------------------------------------------------- state

  let socket = null;
  let reconnectAttempts = 0;
  let reconnectTimer = null;
  let latencyMs = null;
  let sampleCount = 0;

  /** Consecutive-breach counters, so a single spike doesn't fire an alert. */
  const breach = { cpu: 0, ram: 0 };
  const alerting = { cpu: false, ram: false };

  const settings = loadSettings();

  const el = (id) => document.getElementById(id);

  const dom = {
    status: el('status'),
    statusText: el('status-text'),
    machineLine: el('machine-line'),
    intervalSelect: el('interval-select'),
    themeToggle: el('theme-toggle'),
    themeIcon: el('theme-icon'),
    settingsToggle: el('settings-toggle'),
    settingsPanel: el('settings-panel'),
    cpuThreshold: el('cpu-threshold'),
    ramThreshold: el('ram-threshold'),
    sustainCount: el('sustain-count'),
    notifyToggle: el('notify-toggle'),
    clearAlerts: el('clear-alerts'),
    alertBanner: el('alert-banner'),
    alertLog: el('alert-log'),
    cpuValue: el('cpu-value'),
    cpuSub: el('cpu-sub'),
    cpuMeter: el('cpu-meter'),
    ramValue: el('ram-value'),
    ramSub: el('ram-sub'),
    ramMeter: el('ram-meter'),
    diskValue: el('disk-value'),
    diskSub: el('disk-sub'),
    diskRead: el('disk-read'),
    diskWrite: el('disk-write'),
    netValue: el('net-value'),
    netSub: el('net-sub'),
    netDown: el('net-down'),
    netUp: el('net-up'),
    cardCpu: el('card-cpu'),
    cardRam: el('card-ram'),
    coreCountLabel: el('core-count-label'),
    procBody: el('proc-body'),
    partitions: el('partitions'),
    footerStats: el('footer-stats'),
  };

  // -------------------------------------------------------------- settings io

  function loadSettings() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      // Spread over defaults so a stored object from an older version, missing
      // newer keys, still yields a complete settings object.
      return raw ? { ...DEFAULTS, ...JSON.parse(raw) } : { ...DEFAULTS };
    } catch {
      return { ...DEFAULTS };
    }
  }

  function saveSettings() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(settings));
    } catch {
      /* Private browsing / quota exceeded: settings just won't persist. */
    }
  }

  function clampInt(value, min, max, fallback) {
    const n = parseInt(value, 10);
    if (Number.isNaN(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  }

  // ------------------------------------------------------------------- theme

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    // Show the icon for the mode you'd switch *to*.
    dom.themeIcon.textContent = theme === 'dark' ? '\u263C' : '\u263D';
    dom.themeToggle.setAttribute(
      'aria-label',
      theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme',
    );
  }

  // ------------------------------------------------------------ formatting

  const fmt = (n, digits = 1) => (n === null || n === undefined ? '\u2014' : n.toFixed(digits));

  function formatUptime(seconds) {
    if (!seconds && seconds !== 0) return '\u2014';
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    if (d > 0) return `${d}d ${h}h ${m}m`;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
  }

  /** KB/s gets unwieldy fast; promote to MB/s past 1024. */
  function formatRate(kbs) {
    return kbs >= 1024 ? `${(kbs / 1024).toFixed(2)} MB/s` : `${kbs.toFixed(1)} KB/s`;
  }

  function meterColor(percent) {
    if (percent >= 85) return 'var(--danger)';
    if (percent >= 60) return 'var(--warn)';
    return 'var(--ok)';
  }

  // ------------------------------------------------------------ status pill

  function setStatus(state, text) {
    dom.status.dataset.state = state;
    dom.statusText.textContent = text;
  }

  // ---------------------------------------------------------------- socket

  function wsUrl() {
    // wss:// when the page itself is served over HTTPS, so this keeps working
    // unchanged behind a TLS-terminating reverse proxy.
    const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${scheme}//${window.location.host}/ws`;
  }

  function connect() {
    clearTimeout(reconnectTimer);
    setStatus('connecting', reconnectAttempts ? 'Reconnecting' : 'Connecting');

    socket = new WebSocket(wsUrl());

    socket.addEventListener('open', () => {
      reconnectAttempts = 0;
      setStatus('live', 'Live');
      // Re-assert the saved interval: a fresh server process starts at its own
      // default, and other clients may have changed it.
      send({ type: 'set_interval', value: settings.intervalMs });
      measureLatency();
    });

    socket.addEventListener('message', (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      handleMessage(msg);
    });

    socket.addEventListener('close', () => {
      setStatus('offline', 'Disconnected');
      scheduleReconnect();
    });

    socket.addEventListener('error', () => {
      // 'close' always follows, so reconnect scheduling is handled there.
      setStatus('offline', 'Connection error');
    });
  }

  function scheduleReconnect() {
    // Exponential backoff, capped: a server that is down for a while shouldn't
    // get hammered, but a quick restart should reconnect almost instantly.
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** reconnectAttempts, RECONNECT_MAX_MS);
    reconnectAttempts += 1;
    reconnectTimer = setTimeout(connect, delay);
  }

  function send(payload) {
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(payload));
    }
  }

  function measureLatency() {
    send({ type: 'ping', value: Date.now() });
  }

  function handleMessage(msg) {
    switch (msg.type) {
      case 'hello':
        dom.intervalSelect.value = String(msg.interval_ms);
        SysCharts.seed(msg.history);
        if (msg.history && msg.history.length) {
          renderSample(msg.history[msg.history.length - 1], false);
        }
        break;

      case 'metrics':
        sampleCount += 1;
        SysCharts.push(msg);
        renderSample(msg, true);
        break;

      case 'interval_ack':
        // The server clamps out-of-range values, so trust its answer.
        settings.intervalMs = msg.interval_ms;
        dom.intervalSelect.value = String(msg.interval_ms);
        saveSettings();
        break;

      case 'pong':
        latencyMs = Date.now() - msg.echo;
        break;

      default:
        break;
    }
  }

  // --------------------------------------------------------------- rendering

  function renderSample(sample, checkAlerts) {
    const { cpu, memory, disk, network } = sample;

    // CPU card
    dom.cpuValue.textContent = fmt(cpu.percent);
    dom.cpuMeter.style.width = `${Math.min(cpu.percent, 100)}%`;
    dom.cpuMeter.style.background = meterColor(cpu.percent);
    dom.cpuSub.textContent = cpu.freq_mhz
      ? `${cpu.core_count} cores \u00b7 ${(cpu.freq_mhz / 1000).toFixed(1)} GHz`
      : `${cpu.core_count} cores`;

    // Memory card
    dom.ramValue.textContent = fmt(memory.percent);
    dom.ramMeter.style.width = `${Math.min(memory.percent, 100)}%`;
    dom.ramMeter.style.background = meterColor(memory.percent);
    dom.ramSub.textContent = `${memory.used_gb.toFixed(1)} / ${memory.total_gb.toFixed(1)} GB`;

    // Disk card: headline number is combined throughput.
    const diskTotal = disk.read_mbs + disk.write_mbs;
    dom.diskValue.textContent = diskTotal.toFixed(2);
    dom.diskRead.textContent = disk.read_mbs.toFixed(2);
    dom.diskWrite.textContent = disk.write_mbs.toFixed(2);
    dom.diskSub.textContent =
      disk.read_total_gb !== null
        ? `${disk.read_total_gb.toFixed(0)} GB read since boot`
        : '\u2014';

    // Network card
    const netTotal = network.down_kbs + network.up_kbs;
    dom.netValue.textContent = netTotal >= 1024 ? (netTotal / 1024).toFixed(2) : netTotal.toFixed(1);
    dom.netValue.nextElementSibling.textContent = netTotal >= 1024 ? 'MB/s' : 'KB/s';
    dom.netDown.textContent = formatRate(network.down_kbs);
    dom.netUp.textContent = formatRate(network.up_kbs);
    dom.netSub.textContent =
      network.recv_total_mb !== null
        ? `${(network.recv_total_mb / 1024).toFixed(2)} GB received`
        : '\u2014';

    SysCharts.pushCores(cpu.per_core);
    dom.coreCountLabel.textContent = `${cpu.core_count} logical cores`;

    renderProcesses(sample.processes);
    renderPartitions(disk.partitions);
    renderFooter(sample);

    if (checkAlerts) {
      evaluateAlert('cpu', cpu.percent, settings.cpuThreshold, 'CPU', dom.cardCpu);
      evaluateAlert('ram', memory.percent, settings.ramThreshold, 'Memory', dom.cardRam);
      updateBanner();
    }
  }

  function renderProcesses(processes) {
    dom.procBody.replaceChildren();

    if (!processes || !processes.length) {
      const row = document.createElement('tr');
      row.className = 'empty';
      const cell = document.createElement('td');
      cell.colSpan = 4;
      cell.textContent = 'No process data available.';
      row.append(cell);
      dom.procBody.append(row);
      return;
    }

    processes.forEach((proc) => {
      const row = document.createElement('tr');

      const pid = document.createElement('td');
      pid.textContent = proc.pid;

      const name = document.createElement('td');
      name.className = 'name';
      // textContent, not innerHTML: process names are untrusted input.
      name.textContent = proc.name;
      name.title = proc.name;

      const cpu = document.createElement('td');
      cpu.className = 'num';
      cpu.textContent = proc.cpu.toFixed(1);

      const mem = document.createElement('td');
      mem.className = 'num';
      mem.textContent =
        proc.memory_mb >= 1024
          ? `${(proc.memory_mb / 1024).toFixed(2)} GB`
          : `${proc.memory_mb.toFixed(0)} MB`;

      row.append(pid, name, cpu, mem);
      dom.procBody.append(row);
    });
  }

  function renderPartitions(partitions) {
    dom.partitions.replaceChildren();

    if (!partitions || !partitions.length) {
      const p = document.createElement('p');
      p.className = 'muted';
      p.textContent = 'No partition data available.';
      dom.partitions.append(p);
      return;
    }

    partitions.forEach((part) => {
      const wrap = document.createElement('div');

      const label = document.createElement('div');
      label.className = 'partition-label';

      const mount = document.createElement('span');
      mount.className = 'mount';
      mount.textContent = `${part.mountpoint} (${part.fstype})`;

      const size = document.createElement('span');
      size.className = 'size';
      size.textContent = `${part.used_gb} / ${part.total_gb} GB \u00b7 ${part.percent}%`;

      label.append(mount, size);

      const meter = document.createElement('div');
      meter.className = 'meter';
      const fill = document.createElement('div');
      fill.className = 'meter-fill';
      fill.style.width = `${part.percent}%`;
      fill.style.background = meterColor(part.percent);
      meter.append(fill);

      wrap.append(label, meter);
      dom.partitions.append(wrap);
    });
  }

  function renderFooter(sample) {
    const parts = [
      `uptime ${formatUptime(sample.uptime_seconds)}`,
      `${sampleCount} samples`,
      `${settings.intervalMs} ms tick`,
    ];
    if (latencyMs !== null) parts.push(`${latencyMs} ms rtt`);
    if (sample.cpu.ctx_switches_per_s) {
      parts.push(`${sample.cpu.ctx_switches_per_s.toLocaleString()} ctx/s`);
    }
    dom.footerStats.textContent = parts.join('  \u00b7  ');
  }

  // ------------------------------------------------------------------ alerts

  /**
   * Track a metric against its threshold and flip alert state on sustained
   * breaches. Requiring N consecutive samples filters out the single-sample
   * spikes that are normal on any busy machine.
   */
  function evaluateAlert(key, value, threshold, label, card) {
    if (value >= threshold) {
      breach[key] += 1;
      if (!alerting[key] && breach[key] >= settings.sustain) {
        alerting[key] = true;
        card.classList.add('alerting');
        logAlert('danger', `${label} above ${threshold}% (${value.toFixed(1)}%)`);
        notify(`${label} alert`, `${label} at ${value.toFixed(1)}% on this machine.`);
      }
    } else {
      if (alerting[key]) {
        alerting[key] = false;
        card.classList.remove('alerting');
        logAlert('ok', `${label} back to normal (${value.toFixed(1)}%)`);
      }
      breach[key] = 0;
    }
  }

  function updateBanner() {
    const active = Object.entries(alerting)
      .filter(([, on]) => on)
      .map(([key]) => (key === 'cpu' ? 'CPU' : 'Memory'));

    if (!active.length) {
      dom.alertBanner.hidden = true;
      dom.alertBanner.textContent = '';
      return;
    }
    dom.alertBanner.hidden = false;
    dom.alertBanner.textContent = `\u26a0 High usage: ${active.join(' and ')}`;
  }

  function logAlert(level, message) {
    // Drop the "No alerts yet" placeholder on the first real entry.
    const placeholder = dom.alertLog.querySelector('.muted');
    if (placeholder) placeholder.remove();

    const li = document.createElement('li');

    const time = document.createElement('time');
    time.textContent = new Date().toLocaleTimeString();

    const text = document.createElement('span');
    text.className = `lvl-${level}`;
    text.textContent = message;

    li.append(time, text);
    dom.alertLog.prepend(li);

    while (dom.alertLog.children.length > ALERT_LOG_MAX) {
      dom.alertLog.lastElementChild.remove();
    }
  }

  function notify(title, body) {
    if (!settings.notify) return;
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    try {
      new Notification(title, { body });
    } catch {
      /* Some browsers block constructor-based notifications; ignore. */
    }
  }

  function resetAlertState() {
    breach.cpu = 0;
    breach.ram = 0;
    alerting.cpu = false;
    alerting.ram = false;
    dom.cardCpu.classList.remove('alerting');
    dom.cardRam.classList.remove('alerting');
    updateBanner();
  }

  // ------------------------------------------------------------------- wiring

  function bindControls() {
    dom.intervalSelect.addEventListener('change', (e) => {
      const value = clampInt(e.target.value, 250, 10000, DEFAULTS.intervalMs);
      settings.intervalMs = value;
      saveSettings();
      send({ type: 'set_interval', value });
    });

    dom.themeToggle.addEventListener('click', () => {
      settings.theme = settings.theme === 'dark' ? 'light' : 'dark';
      applyTheme(settings.theme);
      SysCharts.applyTheme();
      saveSettings();
    });

    dom.settingsToggle.addEventListener('click', () => {
      const open = dom.settingsPanel.hidden;
      dom.settingsPanel.hidden = !open;
      dom.settingsToggle.setAttribute('aria-expanded', String(open));
    });

    dom.cpuThreshold.addEventListener('change', (e) => {
      settings.cpuThreshold = clampInt(e.target.value, 1, 100, DEFAULTS.cpuThreshold);
      e.target.value = settings.cpuThreshold;
      resetAlertState();
      saveSettings();
    });

    dom.ramThreshold.addEventListener('change', (e) => {
      settings.ramThreshold = clampInt(e.target.value, 1, 100, DEFAULTS.ramThreshold);
      e.target.value = settings.ramThreshold;
      resetAlertState();
      saveSettings();
    });

    dom.sustainCount.addEventListener('change', (e) => {
      settings.sustain = clampInt(e.target.value, 1, 30, DEFAULTS.sustain);
      e.target.value = settings.sustain;
      resetAlertState();
      saveSettings();
    });

    dom.notifyToggle.addEventListener('change', async (e) => {
      if (e.target.checked && 'Notification' in window) {
        // Permission must be requested from a user gesture, which this is.
        const permission = await Notification.requestPermission();
        if (permission !== 'granted') {
          e.target.checked = false;
          logAlert('ok', 'Desktop notifications denied by the browser.');
        }
      }
      settings.notify = e.target.checked;
      saveSettings();
    });

    dom.clearAlerts.addEventListener('click', () => {
      dom.alertLog.replaceChildren();
      const li = document.createElement('li');
      li.className = 'muted';
      li.textContent = 'No alerts yet.';
      dom.alertLog.append(li);
    });
  }

  async function loadSystemInfo() {
    try {
      const res = await fetch('/api/system');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const info = await res.json();
      dom.machineLine.textContent =
        `${info.hostname} \u00b7 ${info.platform} \u00b7 ${info.cpu_cores_physical}C/` +
        `${info.cpu_cores_logical}T \u00b7 ${info.memory_total_gb} GB RAM`;
      dom.machineLine.title = `${info.cpu_model}\nBooted ${info.boot_time_iso}`;
    } catch {
      dom.machineLine.textContent = 'Machine info unavailable';
    }
  }

  function init() {
    applyTheme(settings.theme);
    dom.intervalSelect.value = String(settings.intervalMs);
    dom.cpuThreshold.value = settings.cpuThreshold;
    dom.ramThreshold.value = settings.ramThreshold;
    dom.sustainCount.value = settings.sustain;
    dom.notifyToggle.checked =
      settings.notify && 'Notification' in window && Notification.permission === 'granted';

    SysCharts.init();
    bindControls();
    loadSystemInfo();
    connect();

    // Refresh the round-trip estimate occasionally for the footer readout.
    setInterval(measureLatency, 15000);
  }

  document.addEventListener('DOMContentLoaded', init);
})();
