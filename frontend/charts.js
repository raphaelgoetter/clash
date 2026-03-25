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

let chartTranslations = {
  members: 'Members',
  memberPlural: 'members',
  memberSingular: 'member',
  highReliability: 'High reliability',
  moderateRisk: 'Moderate risk',
  highRisk: 'High risk',
  extremeRisk: 'Extreme risk',
};

export function setChartTranslations(trans) {
  chartTranslations = { ...chartTranslations, ...trans };
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
  const labels   = ordered.map((w) => {
    const deckInfo = typeof w.decksUsed === 'number' ? ` (${w.decksUsed}/16)` : '';
    // choose a badge emoji like a coloured pastille
    let badge = '';
    if (w.ignored) {
      badge = '⚪ '; // ignored weeks get a neutral white circle
    } else if (typeof w.decksUsed === 'number') {
      badge = w.decksUsed >= 16 ? '✅'
            : w.decksUsed >= 8  ? '⚠️'
            : '❌';
      badge += ' ';
    }
    return `${badge}${w.label}${deckInfo}`;
  });
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
          backgroundColor: fameData.map((f, idx) =>
            // grey out ignored weeks
            ordered[idx].ignored ? 'rgba(128,128,128,0.5)'
              : f >= avg ? 'rgba(99,102,241,0.85)' : 'rgba(239,68,68,0.65)'
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
            label: (ctx) => {
              const row = ordered[ctx.dataIndex];
              const deckInfo = row && row.decksUsed != null ? ` — ${row.decksUsed}/16 decks` : '';
              const ignoreNote = row && row.ignored ? ' (ignored)' : '';
              return ` ${ctx.dataset.label}: ${ctx.parsed.y.toLocaleString()}${deckInfo}${ignoreNote}`;
            },
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
export function renderBattleLogBreakdownChart(breakdown) {
  destroyIfExists('chart-activity');
  const el = document.getElementById('chart-activity');
  if (!el) return;

  const keys = ['gdc', 'ladder', 'challenge', 'friendly', 'other'];
  const labels = ['River Race', 'Ladder', 'Challenges', 'Friendly', 'Other'];
  const values = keys.map((k) => breakdown?.[k] ?? 0);
  const total = values.reduce((s, v) => s + v, 0);

  const colors = [
    'rgba(99,102,241,0.9)',
    'rgba(34,197,94,0.8)',
    'rgba(251,191,36,0.8)',
    'rgba(34,211,238,0.8)',
    'rgba(148,163,184,0.6)',
  ];

  new Chart(el.getContext('2d'), {
    type: 'doughnut',
    data: {
      labels,
      datasets: [{
        data: values,
        backgroundColor: colors,
        borderColor: 'rgba(255,255,255,0.06)',
        borderWidth: 1,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { position: 'bottom', labels: { color: '#cbd5e1' } },
        tooltip: {
          callbacks: {
            label(context) {
              const idx = context.dataIndex;
              const val = values[idx] ?? 0;
              const pct = total ? Math.round((val / total) * 100) : 0;
              return `${labels[idx]}: ${val} (${pct}%)`;
            },
          },
        },
      },
    },
  });
}

export function renderGaugeChart(score, color) {
  destroyIfExists('chart-gauge');
  const ctx = document.getElementById('chart-gauge').getContext('2d');

  const colorMap = {
    green:  '#22c55e',
    yellow: '#eab308',
    orange: '#f97316',
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

  // Build score buckets (0-9, 10-19, … 90-100) and determine worst colour per bucket.
  const buckets = Array(10).fill(0);
  const bucketsByColor = {
    green: Array(10).fill(0),
    yellow: Array(10).fill(0),
    orange: Array(10).fill(0),
    red: Array(10).fill(0),
  };
  function worsen(current, incoming) {
    const order = ['green', 'yellow', 'orange', 'red'];
    if (!current) return incoming;
    return order.indexOf(incoming) > order.indexOf(current) ? incoming : current;
  }
  const bucketWorst = Array(10).fill(null);

  members.forEach((m) => {
    const i = Math.min(9, Math.floor(m.activityScore / 10));
    buckets[i]++;
    const c = m.color || 'green';
    if (bucketsByColor[c]) bucketsByColor[c][i]++;
    bucketWorst[i] = worsen(bucketWorst[i], c);
  });

  const labels = ['0–9','10–19','20–29','30–39','40–49','50–59','60–69','70–79','80–89','90–100'];

  const barColors = bucketWorst.map((c) => {
    if (c === 'red') return 'rgba(239, 68, 68, 0.7)';
    if (c === 'orange') return 'rgba(249, 115, 22, 0.7)';
    if (c === 'yellow') return 'rgba(234, 179, 8, 0.7)';
    return 'rgba(34, 197, 94, 0.7)';
  });

  new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label: chartTranslations.members,
          data: buckets,
          backgroundColor: barColors,
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
            label: (ctx) => {
              const i = ctx.dataIndex;
              const total = buckets[i] || 0;
              const g = bucketsByColor.green[i] || 0;
              const y = bucketsByColor.yellow[i] || 0;
              const o = bucketsByColor.orange[i] || 0;
              const r = bucketsByColor.red[i] || 0;
              const parts = [];
              if (g) parts.push(`${g} ${chartTranslations.highReliability}`);
              if (y) parts.push(`${y} ${chartTranslations.moderateRisk}`);
              if (o) parts.push(`${o} ${chartTranslations.highRisk}`);
              if (r) parts.push(`${r} ${chartTranslations.extremeRisk}`);
              const breakdown = parts.length ? ` (${parts.join(', ')})` : '';
              const memberWord = total === 1 ? chartTranslations.memberSingular : chartTranslations.memberPlural;
              return ` ${total} ${memberWord}${breakdown}`;
            },
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
      labels: [
        chartTranslations.highReliability,
        chartTranslations.moderateRisk,
        chartTranslations.highRisk,
        chartTranslations.extremeRisk,
      ],
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
            label: (ctx) => {
              const memberWord = ctx.parsed === 1 ? chartTranslations.memberSingular : chartTranslations.memberPlural;
              return ` ${ctx.label}: ${ctx.parsed} ${memberWord}`;
            },
          },
        },
      },
    },
  });
}
