// ============================================================
// main.js — Clash Royale Clan War Reliability Analyzer
// Frontend orchestration: search, fetch, render, export.
// ============================================================

import {
  renderActivityChart,
  renderGaugeChart,
  renderClanBarChart,
  renderClanPieChart,
} from './charts.js';

// ── DOM references ───────────────────────────────────────────
const searchInput     = document.getElementById('search-input');
const searchBtn       = document.getElementById('search-btn');
const searchBtnLabel  = document.getElementById('search-btn-label');
const searchSpinner   = document.getElementById('search-spinner');
const searchHint      = document.getElementById('search-hint');
const errorBanner     = document.getElementById('error-banner');
const playerResults   = document.getElementById('player-results');
const clanResults     = document.getElementById('clan-results');
const modeBtns        = document.querySelectorAll('.mode-btn');

const overviewGrid    = document.getElementById('overview-grid');
const statsGrid       = document.getElementById('stats-grid');
const stabilityContent= document.getElementById('stability-content');
const verdictBox      = document.getElementById('verdict-box');
const reasonsList     = document.getElementById('reasons-list');

const clanOverviewGrid= document.getElementById('clan-overview-grid');
const membersTbody    = document.getElementById('members-tbody');
const exportBtn       = document.getElementById('export-btn');
const filterName      = document.getElementById('filter-name');
const filterVerdict   = document.getElementById('filter-verdict');

// ── State ────────────────────────────────────────────────────
let currentMode = 'player';   // 'player' | 'clan'
let allMembers  = [];          // cache for table filtering / sorting
let sortState   = { col: null, dir: 'asc' };

// Default tags per mode
const DEFAULT_TAGS = { player: '#YRGJGR8R', clan: '#LRQP20V9' };

// Set initial default
searchInput.value = DEFAULT_TAGS.player;

// ── Mode selector ────────────────────────────────────────────
modeBtns.forEach((btn) => {
  btn.addEventListener('click', () => {
    currentMode = btn.dataset.mode;
    modeBtns.forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    searchInput.value = DEFAULT_TAGS[currentMode];
    searchInput.placeholder =
      currentMode === 'player'
        ? 'Enter player tag (e.g. #ABC123) …'
        : 'Enter clan tag (e.g. #2Y2LJJ) …';
    searchHint.textContent =
      currentMode === 'player'
        ? 'Tags must start with #. You can omit it and we\'ll add it automatically.'
        : 'Clan tags must start with #. You can omit it and we\'ll add it automatically.';
    hideResults();
    hideError();
  });
});

// ── Search trigger ───────────────────────────────────────────
searchBtn.addEventListener('click', handleSearch);
searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') handleSearch();
});

async function handleSearch() {
  const raw = searchInput.value.trim();
  if (!raw) return showError('Please enter a tag.');

  const tag = raw.startsWith('#') ? raw : `#${raw}`;
  hideError();
  hideResults();
  setLoading(true);

  try {
    if (currentMode === 'player') {
      const data = await apiFetch(`/api/player/${encodeURIComponent(tag)}/analysis`);
      renderPlayerResults(data);
    } else {
      const data = await apiFetch(`/api/clan/${encodeURIComponent(tag)}/analysis`);
      renderClanResults(data);
    }
  } catch (err) {
    showError(err.message);
  } finally {
    setLoading(false);
  }
}

// ── API fetch helper ──────────────────────────────────────────
async function apiFetch(path) {
  const res = await fetch(path);
  if (!res.ok) {
    let msg = `Error ${res.status}`;
    try {
      const body = await res.json();
      msg = body.error ?? msg;
    } catch (_) { /* ignore */ }
    throw new Error(msg);
  }
  return res.json();
}

// ── UI helpers ───────────────────────────────────────────────
function setLoading(on) {
  searchBtn.disabled = on;
  searchBtnLabel.classList.toggle('hidden', on);
  searchSpinner.classList.toggle('hidden', !on);
}

function showError(msg) {
  errorBanner.textContent = `⚠️  ${msg}`;
  errorBanner.classList.remove('hidden');
}

function hideError() {
  errorBanner.classList.add('hidden');
}

function hideResults() {
  playerResults.classList.add('hidden');
  clanResults.classList.add('hidden');
}

// ── Player rendering ──────────────────────────────────────────

function renderPlayerResults(data) {
  const { overview, activityIndicators, recentActivity, stability, reliability } = data;

  // 1. Overview (Clan & Role removed)
  overviewGrid.innerHTML = overviewItems([
    { label: 'Name',          value: overview.name, cls: 'gold' },
    { label: 'Tag',           value: overview.tag },
    { label: 'Trophies',      value: `🏆 ${fmt(overview.trophies)}` },
    { label: 'Best Trophies', value: `🏆 ${fmt(overview.bestTrophies)}` },
    { label: 'Exp Level',     value: `⭐ ${overview.expLevel}` },
  ]);

  // 2. Clan Wars Indicators (war battles only)
  statsGrid.innerHTML = statCards([
    { label: 'War Battles (log)', value: fmt(activityIndicators.totalWarBattles) },
    { label: 'Wins',              value: fmt(activityIndicators.wins) },
    { label: 'Losses',            value: fmt(activityIndicators.losses) },
    { label: 'Win Rate',          value: `${activityIndicators.winRate}%` },
    { label: 'Donations',         value: fmt(activityIndicators.donations) },
    { label: '3-Crown Wins',      value: fmt(activityIndicators.threeCrowns) },
  ]);

  // 3. Clan War Activity chart (war battles only)
  renderActivityChart(recentActivity.dailyActivity);

  // 4. Stability
  const stabPct = Math.min(100, stability.score);
  stabilityContent.innerHTML = `
    <div class="stability-meter">
      <div class="stability-bar-bg">
        <div class="stability-bar" style="width: ${stabPct}%"></div>
      </div>
      <div class="stability-meta">Raw score: <strong>${stability.score}</strong> / 100</div>
    </div>
    <div>
      <div class="stability-label">${stabilityIcon(stability.label)} ${stability.label}</div>
    </div>
  `;

  // 5 & 6. Verdict + gauge
  renderGaugeChart(reliability.score, reliability.color);

  const icon = { green: '✅', yellow: '⚠️', red: '🔴' }[reliability.color] ?? '❓';
  verdictBox.innerHTML = `
    <div class="verdict-box ${reliability.color}">
      <div class="verdict-icon">${icon}</div>
      <div class="verdict-text-wrap">
        <div class="verdict-score">${reliability.score}<span style="font-size:1rem;opacity:.6">/100</span></div>
        <div class="verdict-text">${reliability.verdict}</div>
      </div>
    </div>
  `;

  reasonsList.innerHTML = reliability.reasons
    .map((r) => `<li>${r}</li>`)
    .join('');

  playerResults.classList.remove('hidden');
  playerResults.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ── Clan rendering ────────────────────────────────────────────

function renderClanResults(data) {
  const { clan, members, summary } = data;

  // Clan overview card
  clanOverviewGrid.innerHTML = overviewItems([
    { label: 'Name',          value: clan.name, cls: 'gold' },
    { label: 'Tag',           value: clan.tag },
    { label: 'Members',       value: `${clan.members} / 50` },
    { label: 'Clan Score',    value: fmt(clan.clanScore) },
    { label: 'War Trophies',  value: `⚔️ ${fmt(clan.clanWarTrophies ?? 0)}` },
    { label: 'Required',      value: `🏆 ${fmt(clan.requiredTrophies)}` },
    { label: 'Type',          value: capitalize(clan.type ?? '—') },
    { label: 'Avg Score',     value: `${summary.avgScore} / 100` },
  ]);

  // Charts
  renderClanBarChart(members);
  renderClanPieChart(summary);

  // Table
  allMembers = members;
  renderMembersTable(members);

  clanResults.classList.remove('hidden');
  clanResults.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ── Members table ────────────────────────────────────────────

function renderMembersTable(members) {
  if (members.length === 0) {
    membersTbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--text-muted)">No members found.</td></tr>';
    return;
  }

  membersTbody.innerHTML = members
    .map(
      (m) => `
      <tr>
        <td>
          <div style="font-weight:600">${escHtml(m.name)}</div>
          <div style="font-size:.75rem;color:var(--text-muted)">${escHtml(m.tag)}</div>
        </td>
        <td><span class="role-badge ${m.role}">${capitalize(m.role)}</span></td>
        <td>🏆 ${fmt(m.trophies)}</td>
        <td>${fmt(m.donations)}</td>
        <td>
          <div style="display:flex;align-items:center;gap:8px">
            <div style="flex:1;height:6px;background:rgba(255,255,255,.08);border-radius:999px;overflow:hidden;min-width:60px">
              <div style="width:${m.activityScore}%;height:100%;background:${scoreBarColor(m.color)};border-radius:999px"></div>
            </div>
            <span style="font-weight:700;font-size:.88rem">${m.activityScore}</span>
          </div>
        </td>
        <td><span class="verdict-badge ${m.color}">${escHtml(m.verdict)}</span></td>
      </tr>`
    )
    .join('');
}

// Filtering
filterName.addEventListener('input', applyFilters);
filterVerdict.addEventListener('change', applyFilters);

function applyFilters() {
  const nameQ   = filterName.value.toLowerCase();
  const verdictQ = filterVerdict.value;
  let filtered = allMembers.filter((m) => {
    const matchName    = m.name.toLowerCase().includes(nameQ) || m.tag.toLowerCase().includes(nameQ);
    const matchVerdict = !verdictQ || m.color === verdictQ;
    return matchName && matchVerdict;
  });
  if (sortState.col) filtered = sortMembers(filtered, sortState.col, sortState.dir);
  renderMembersTable(filtered);
}

// Sorting
document.querySelectorAll('.members-table th.sortable').forEach((th) => {
  th.addEventListener('click', () => {
    const col = th.dataset.col;
    if (sortState.col === col) {
      sortState.dir = sortState.dir === 'asc' ? 'desc' : 'asc';
    } else {
      sortState.col = col;
      sortState.dir = 'asc';
    }
    // Update header visual
    document.querySelectorAll('.members-table th.sortable').forEach((h) => {
      h.classList.remove('sort-asc', 'sort-desc');
    });
    th.classList.add(`sort-${sortState.dir}`);
    applyFilters();
  });
});

function sortMembers(arr, col, dir) {
  return [...arr].sort((a, b) => {
    let va = a[col], vb = b[col];
    if (typeof va === 'string') va = va.toLowerCase();
    if (typeof vb === 'string') vb = vb.toLowerCase();
    if (va < vb) return dir === 'asc' ? -1 : 1;
    if (va > vb) return dir === 'asc' ? 1 : -1;
    return 0;
  });
}

// ── CSV export ────────────────────────────────────────────────

exportBtn.addEventListener('click', () => {
  if (!allMembers.length) return;

  const headers = ['Name', 'Tag', 'Trophies', 'Donations', 'Activity Score', 'Verdict'];
  const rows = allMembers.map((m) => [
    csvEscape(m.name),
    csvEscape(m.tag),
    m.trophies,
    m.donations,
    m.activityScore,
    csvEscape(m.verdict),
  ]);

  const csv = [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `clan-reliability-report-${Date.now()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
});

// ── Template helpers ─────────────────────────────────────────

function overviewItems(items) {
  return items
    .map(
      ({ label, value, cls = '' }) => `
        <div class="overview-item">
          <div class="oi-label">${label}</div>
          <div class="oi-value ${cls}">${escHtml(String(value))}</div>
        </div>`
    )
    .join('');
}

function statCards(items) {
  return items
    .map(
      ({ label, value }) => `
        <div class="stat-card">
          <div class="sc-value">${escHtml(String(value))}</div>
          <div class="sc-label">${label}</div>
        </div>`
    )
    .join('');
}

function badge(text, type) {
  return `<span class="badge badge-${type}">${text}</span>`;
}

function scoreBarColor(color) {
  return { green: '#22c55e', yellow: '#eab308', red: '#ef4444' }[color] ?? '#7c3aed';
}

function stabilityIcon(label) {
  if (label.includes('High')) return '🟢';
  if (label.includes('Medium')) return '🟡';
  return '🔴';
}

// ── Utility ──────────────────────────────────────────────────

const fmt = (n) => Number(n).toLocaleString();
const pl  = (n) => (n !== 1 ? 's' : '');

function capitalize(s) {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function csvEscape(v) {
  const s = String(v);
  return s.includes(',') || s.includes('"') || s.includes('\n')
    ? `"${s.replace(/"/g, '""')}"`
    : s;
}
