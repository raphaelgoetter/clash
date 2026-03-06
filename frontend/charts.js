// ============================================================
// charts.js — Chart.js helpers for the Reliability Analyzer
// Each function creates (or replaces) a chart on the page.
// ============================================================

import {
  Chart,
  LineController,
  LineElement,
  PointElement,
  LinearScale,
  CategoryScale,
  BarController,
  BarElement,
  DoughnutController,
  ArcElement,
  PieController,
  Tooltip,
  Legend,
  Filler,
} from 'chart.js';

// Register only the components we use (tree-shaking friendly)
Chart.register(
  LineController, LineElement, PointElement,
  LinearScale, CategoryScale,
  BarController, BarElement,
  DoughnutController, ArcElement,
  PieController,
  Tooltip, Legend, Filler
);

// ── Shared defaults ───────────────────────────────────────────
Chart.defaults.color = '#9090b8';
Chart.defaults.borderColor = 'rgba(255,255,255,0.06)';
Chart.defaults.font.family = "'Segoe UI', system-ui, sans-serif";

/** Destroy an existing chart on a canvas before creating a new one. */
function destroyIfExists(canvasId) {
  const existing = Chart.getChart(canvasId);
  if (existing) existing.destroy();
}

// ── 1. Activity line chart (battles per day) ──────────────────

/**
 * Render a battles-per-day line chart on #chart-activity.
 * @param {{ date: string; count: number }[]} dailyActivity
 */
export function renderActivityChart(dailyActivity) {
  destroyIfExists('chart-activity');
  const ctx = document.getElementById('chart-activity').getContext('2d');

  const labels = dailyActivity.map((d) => {
    const dt = new Date(d.date + 'T00:00:00');
    return dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  });
  const data = dailyActivity.map((d) => d.count);

  // Gradient fill
  const gradient = ctx.createLinearGradient(0, 0, 0, 200);
  gradient.addColorStop(0, 'rgba(124,58,237,0.5)');
  gradient.addColorStop(1, 'rgba(124,58,237,0.02)');

  new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'Battles',
          data,
          borderColor: '#7c3aed',
          backgroundColor: gradient,
          borderWidth: 2,
          pointRadius: 3,
          pointBackgroundColor: '#a78bfa',
          tension: 0.35,
          fill: true,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (ctx) => ` ${ctx.parsed.y} battle${ctx.parsed.y !== 1 ? 's' : ''}`,
          },
        },
      },
      scales: {
        x: {
          ticks: { maxTicksLimit: 10, maxRotation: 0 },
          grid: { display: false },
        },
        y: {
          beginAtZero: true,
          ticks: { stepSize: 1 },
        },
      },
    },
  });
}

// ── 1b. War history bar chart (fame per river-race week) ──────

/**
 * Render a fame-per-week bar chart on #chart-activity (reuses same canvas).
 * Bars above the average are indigo; below are red.
 * A dashed yellow line shows the average.
 *
 * @param {{ label:string; fame:number }[]} weeks  Most-recent-first array
 */
export function renderWarHistoryChart(weeks) {
  destroyIfExists('chart-activity');
  const el = document.getElementById('chart-activity');
  if (!el) return;

  // Display oldest → newest (left → right)
  const ordered = [...weeks].reverse();
  const labels   = ordered.map((w) => w.label);
  const fameData = ordered.map((w) => w.fame);
  const avg      = fameData.reduce((a, b) => a + b, 0) / (fameData.length || 1);

  new Chart(el.getContext('2d'), {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label: 'Fame',
          data: fameData,
          backgroundColor: fameData.map((f) =>
            f >= avg ? 'rgba(99,102,241,0.85)' : 'rgba(239,68,68,0.65)'
          ),
          borderRadius: 6,
          order: 2,
        },
        {
          label: 'Average',
          type: 'line',
          data: fameData.map(() => Math.round(avg)),
          borderColor: 'rgba(234,179,8,0.8)',
          borderDash: [6, 3],
          borderWidth: 2,
          pointRadius: 0,
          fill: false,
          order: 1,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (ctx) => ` ${ctx.dataset.label}: ${ctx.parsed.y.toLocaleString()}`,
          },
        },
      },
      scales: {
        x: {
          ticks: { color: '#94a3b8', font: { size: 11 }, maxRotation: 45 },
          grid: { color: 'rgba(255,255,255,.04)' },
        },
        y: {
          beginAtZero: true,
          ticks: { color: '#94a3b8' },
          grid: { color: 'rgba(255,255,255,.06)' },
        },
      },
    },
  });
}

// ── 2. War reliability gauge (doughnut) ───────────────────────

/**
 * Render a doughnut "gauge" showing the war reliability score.
 * @param {number} score  0–100
 * @param {string} color  'green' | 'yellow' | 'red'
 */
export function renderGaugeChart(score, color) {
  destroyIfExists('chart-gauge');
  const ctx = document.getElementById('chart-gauge').getContext('2d');

  const colorMap = {
    green:  '#22c55e',
    yellow: '#eab308',
    red:    '#ef4444',
  };
  const fillColor = colorMap[color] ?? '#7c3aed';

  new Chart(ctx, {
    type: 'doughnut',
    data: {
      datasets: [
        {
          data: [score, 100 - score],
          backgroundColor: [fillColor, 'rgba(255,255,255,0.06)'],
          borderColor: ['transparent', 'transparent'],
          borderRadius: [8, 0],
          circumference: 270,
          rotation: 225,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '78%',
      plugins: {
        legend: { display: false },
        tooltip: { enabled: false },
      },
    },
    plugins: [
      {
        id: 'gaugeText',
        afterDraw(chart) {
          const { ctx: c, chartArea: { top, bottom, left, right } } = chart;
          const cx = (left + right) / 2;
          const cy = (top + bottom) / 2 + 20;

          c.save();
          c.textAlign = 'center';
          c.textBaseline = 'middle';

          c.font = 'bold 36px Segoe UI, sans-serif';
          c.fillStyle = fillColor;
          c.fillText(`${score}`, cx, cy);

          c.font = '13px Segoe UI, sans-serif';
          c.fillStyle = '#9090b8';
          c.fillText('/ 100', cx, cy + 26);
          c.restore();
        },
      },
    ],
  });
}

// ── 3. Clan score distribution (bar chart) ────────────────────

/**
 * Render a bar chart with the distribution of member activity scores.
 * @param {object[]} members  Analyzed members array
 */
export function renderClanBarChart(members) {
  destroyIfExists('chart-clan-bar');
  const ctx = document.getElementById('chart-clan-bar').getContext('2d');

  // Build score buckets (0-9, 10-19, … 90-100)
  const buckets = Array(10).fill(0);
  members.forEach((m) => {
    const i = Math.min(9, Math.floor(m.activityScore / 10));
    buckets[i]++;
  });
  const labels = ['0–9','10–19','20–29','30–39','40–49','50–59','60–69','70–79','80–89','90–100'];

  const colors = labels.map((_, i) => {
    if (i >= 7) return 'rgba(34, 197, 94, 0.7)';
    if (i >= 4) return 'rgba(234, 179, 8, 0.7)';
    return 'rgba(239, 68, 68, 0.7)';
  });

  new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label: 'Members',
          data: buckets,
          backgroundColor: colors,
          borderRadius: 5,
        },
      ],
    },
    options: {
      responsive: true,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (ctx) => ` ${ctx.parsed.y} member${ctx.parsed.y !== 1 ? 's' : ''}`,
          },
        },
      },
      scales: {
        y: { beginAtZero: true, ticks: { stepSize: 1 } },
        x: { grid: { display: false } },
      },
    },
  });
}

// ── 4. Reliable vs Risky pie chart ────────────────────────────

/**
 * Render a pie chart splitting members by verdict category.
 * @param {{ green: number; yellow: number; red: number }} summary
 */
export function renderClanPieChart(summary) {
  destroyIfExists('chart-clan-pie');
  const ctx = document.getElementById('chart-clan-pie').getContext('2d');

  new Chart(ctx, {
    type: 'pie',
    data: {
      labels: ['High reliability', 'Moderate risk', 'High risk', 'Extreme risk'],
      datasets: [
        {
          data: [summary.green, summary.yellow, summary.orange, summary.red],
          backgroundColor: [
            'rgba(34, 197, 94, 0.8)',
            'rgba(234, 179, 8, 0.8)',
            'rgba(249, 115, 22, 0.8)',
            'rgba(239, 68, 68, 0.8)',
          ],
          borderColor: ['#0e0e1a', '#0e0e1a', '#0e0e1a', '#0e0e1a'],
          borderWidth: 2,
        },
      ],
    },
    options: {
      responsive: true,
      plugins: {
        legend: {
          position: 'bottom',
          labels: { padding: 16, boxWidth: 12 },
        },
        tooltip: {
          callbacks: {
            label: (ctx) => ` ${ctx.label}: ${ctx.parsed} member${ctx.parsed !== 1 ? 's' : ''}`,
          },
        },
      },
    },
  });
}
