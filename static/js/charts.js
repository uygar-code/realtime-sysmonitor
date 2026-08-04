/* ---------------------------------------------------------------------------
   Chart.js setup and updates.

   Exposes a single global `SysCharts` so app.js can stay focused on the socket
   and the DOM. Two details matter for a chart that redraws every second:

   1. Animations are disabled and updates use `update('none')`. Chart.js would
      otherwise try to tween between frames, which at a 1s tick looks like lag
      and burns CPU on the very machine we are measuring.
   2. Data arrays are mutated in place with push/shift rather than being
      replaced, so Chart.js reuses its internal metadata instead of rebuilding
      the scales on every frame.
--------------------------------------------------------------------------- */

const SysCharts = (() => {
  const MAX_POINTS = 60;

  /** Chart.js needs concrete colour strings, so read the CSS tokens at runtime. */
  function token(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  /** rgba() version of a hex token, for the area fill under a line. */
  function fade(hex, alpha) {
    const clean = hex.replace('#', '');
    const full = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean;
    const num = parseInt(full, 16);
    /* eslint-disable no-bitwise */
    return `rgba(${(num >> 16) & 255}, ${(num >> 8) & 255}, ${num & 255}, ${alpha})`;
    /* eslint-enable no-bitwise */
  }

  const charts = {};
  /** Which CSS token each dataset draws with, so themes can be re-applied. */
  const datasetTokens = {
    cpu: ['--accent-cpu'],
    memory: ['--accent-ram'],
    disk: ['--accent-disk', '--accent-cpu'],
    network: ['--accent-net', '--accent-ram'],
  };

  function baseLineOptions({ maxY = null, unit = '' } = {}) {
    return {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      // Skip the hover hit-test work on a chart that changes every second.
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          display: true,
          position: 'top',
          align: 'end',
          labels: {
            boxWidth: 9,
            boxHeight: 9,
            usePointStyle: true,
            pointStyle: 'circle',
            color: token('--text-muted'),
            font: { size: 11 },
          },
        },
        tooltip: {
          backgroundColor: token('--bg-inset'),
          titleColor: token('--text'),
          bodyColor: token('--text'),
          borderColor: token('--border'),
          borderWidth: 1,
          padding: 9,
          displayColors: true,
          callbacks: {
            label: (ctx) => ` ${ctx.dataset.label}: ${ctx.parsed.y}${unit}`,
          },
        },
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: {
            color: token('--text-muted'),
            font: { size: 10 },
            maxRotation: 0,
            autoSkip: true,
            maxTicksLimit: 6,
          },
        },
        y: {
          beginAtZero: true,
          max: maxY,
          grid: { color: token('--grid'), drawTicks: false },
          border: { display: false },
          ticks: {
            color: token('--text-muted'),
            font: { size: 10 },
            maxTicksLimit: 5,
            padding: 6,
          },
        },
      },
      elements: {
        line: { borderWidth: 2, tension: 0.3 },
        point: { radius: 0, hitRadius: 8 },
      },
    };
  }

  function makeLineChart(canvasId, seriesNames, tokens, opts) {
    const ctx = document.getElementById(canvasId);
    return new Chart(ctx, {
      type: 'line',
      data: {
        labels: [],
        datasets: seriesNames.map((label, i) => {
          const color = token(tokens[i]);
          return {
            label,
            data: [],
            borderColor: color,
            backgroundColor: fade(color, 0.13),
            fill: seriesNames.length === 1,
            pointRadius: 0,
          };
        }),
      },
      options: baseLineOptions(opts),
    });
  }

  /** Green below 60%, amber to 85%, red above: matches the alert mental model. */
  function loadColor(value) {
    if (value >= 85) return token('--danger');
    if (value >= 60) return token('--warn');
    return token('--ok');
  }

  function init() {
    charts.cpu = makeLineChart('chart-cpu', ['CPU'], datasetTokens.cpu, { maxY: 100, unit: '%' });
    charts.memory = makeLineChart('chart-memory', ['Memory'], datasetTokens.memory, { maxY: 100, unit: '%' });
    charts.disk = makeLineChart('chart-disk', ['Read', 'Write'], datasetTokens.disk, { unit: ' MB/s' });
    charts.network = makeLineChart('chart-network', ['Down', 'Up'], datasetTokens.network, { unit: ' KB/s' });

    charts.cores = new Chart(document.getElementById('chart-cores'), {
      type: 'bar',
      data: {
        labels: [],
        datasets: [{
          label: 'Load',
          data: [],
          // Scriptable colour: each bar is tinted by its own value.
          backgroundColor: (c) => loadColor(c.raw ?? 0),
          borderRadius: 3,
          borderSkipped: false,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        indexAxis: 'y',
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: token('--bg-inset'),
            titleColor: token('--text'),
            bodyColor: token('--text'),
            borderColor: token('--border'),
            borderWidth: 1,
            callbacks: { label: (ctx) => ` ${ctx.parsed.x}%` },
          },
        },
        scales: {
          x: {
            beginAtZero: true,
            max: 100,
            grid: { color: token('--grid'), drawTicks: false },
            border: { display: false },
            ticks: { color: token('--text-muted'), font: { size: 10 }, maxTicksLimit: 5, callback: (v) => `${v}%` },
          },
          y: {
            grid: { display: false },
            border: { display: false },
            ticks: { color: token('--text-muted'), font: { size: 9 }, autoSkip: false },
          },
        },
      },
    });
  }

  function timeLabel(ts) {
    return new Date(ts).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  }

  /** Append one point to a chart, dropping the oldest past MAX_POINTS. */
  function pushSeries(chart, label, values, redraw = true) {
    chart.data.labels.push(label);
    values.forEach((value, i) => chart.data.datasets[i].data.push(value));

    if (chart.data.labels.length > MAX_POINTS) {
      chart.data.labels.shift();
      chart.data.datasets.forEach((ds) => ds.data.shift());
    }
    if (redraw) chart.update('none');
  }

  /**
   * Feed one metrics sample into every time-series chart.
   * @param {object} sample - a `metrics` payload from the server
   * @param {boolean} redraw - false while bulk-loading history
   */
  function push(sample, redraw = true) {
    const label = timeLabel(sample.ts);
    pushSeries(charts.cpu, label, [sample.cpu.percent], redraw);
    pushSeries(charts.memory, label, [sample.memory.percent], redraw);
    pushSeries(charts.disk, label, [sample.disk.read_mbs, sample.disk.write_mbs], redraw);
    pushSeries(charts.network, label, [sample.network.down_kbs, sample.network.up_kbs], redraw);
  }

  /** Update the per-core bar chart, adding core labels the first time. */
  function pushCores(perCore) {
    const bars = charts.cores;
    if (bars.data.labels.length !== perCore.length) {
      bars.data.labels = perCore.map((_, i) => `Core ${i}`);
    }
    bars.data.datasets[0].data = perCore;
    bars.update('none');
  }

  /** Replay buffered history on connect, drawing only once at the end. */
  function seed(history) {
    if (!history || !history.length) return;
    history.forEach((sample) => push(sample, false));
    ['cpu', 'memory', 'disk', 'network'].forEach((key) => charts[key].update('none'));
  }

  /** Re-resolve every colour after a theme switch. */
  function applyTheme() {
    Object.entries(datasetTokens).forEach(([key, tokens]) => {
      const chart = charts[key];
      chart.data.datasets.forEach((ds, i) => {
        const color = token(tokens[i]);
        ds.borderColor = color;
        ds.backgroundColor = fade(color, 0.13);
      });
      applyAxisTheme(chart);
      chart.update('none');
    });

    applyAxisTheme(charts.cores);
    charts.cores.update('none');
  }

  function applyAxisTheme(chart) {
    const muted = token('--text-muted');
    const grid = token('--grid');
    Object.values(chart.options.scales).forEach((scale) => {
      if (scale.ticks) scale.ticks.color = muted;
      if (scale.grid && scale.grid.color) scale.grid.color = grid;
    });
    if (chart.options.plugins.legend.labels) {
      chart.options.plugins.legend.labels.color = muted;
    }
    Object.assign(chart.options.plugins.tooltip, {
      backgroundColor: token('--bg-inset'),
      titleColor: token('--text'),
      bodyColor: token('--text'),
      borderColor: token('--border'),
    });
  }

  return { init, push, pushCores, seed, applyTheme, loadColor, MAX_POINTS };
})();
