// ============================================================
// main.js — Clash Royale Clan War Reliability Analyzer
// Frontend orchestration: search, fetch, render, export.
// ============================================================

import {
  renderActivityChart,
  renderWarHistoryChart,
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
let sortState   = { col: 'activityScore', dir: 'asc' };

// Default tags per mode
const DEFAULT_TAGS = { player: '#YRGJGR8R', clan: '#LRQP20V9' };

// ── URL helpers ──────────────────────────────────────────────

// When true, the next syncUrlState call uses replaceState (no new history entry)
let _replaceNextPush = false;

function syncUrlState(mode, tag) {
  const params = new URLSearchParams({ mode, tag });
  const url = `?${params}`;
  if (_replaceNextPush) {
    history.replaceState({ mode, tag }, '', url);
    _replaceNextPush = false;
  } else {
    history.pushState({ mode, tag }, '', url);
  }
}

function applyUrlState(mode, tag) {
  currentMode = mode;
  modeBtns.forEach((b) => {
    b.classList.toggle('active', b.dataset.mode === mode);
  });
  searchInput.placeholder =
    mode === 'player'
      ? 'Enter player tag (e.g. #ABC123) …'
      : 'Enter clan tag (e.g. #2Y2LJJ) …';
  searchHint.textContent =
    mode === 'player'
      ? "Tags must start with #. You can omit it and we'll add it automatically."
      : "Clan tags must start with #. You can omit it and we'll add it automatically.";
  searchInput.value = tag;
}

// Restore state on browser back/forward
window.addEventListener('popstate', (e) => {
  const { mode, tag } = e.state ?? {};
  if (mode && tag) {
    applyUrlState(mode, tag);
    _replaceNextPush = true; // don't push a new entry when restoring history
    handleSearch();
  } else {
    applyUrlState('player', DEFAULT_TAGS.player);
    hideResults();
    hideError();
  }
});

// ── Mode selector ────────────────────────────────────────────
modeBtns.forEach((btn) => {
  btn.addEventListener('click', () => {
    applyUrlState(btn.dataset.mode, DEFAULT_TAGS[btn.dataset.mode]);
    history.replaceState(null, '', location.pathname);
    hideResults();
    hideError();
  });
});

// ── Init from URL ─────────────────────────────────────────────
{
  const params  = new URLSearchParams(location.search);
  const urlMode = params.get('mode');
  const urlTag  = params.get('tag');
  if (urlTag) {
    const mode = urlMode === 'clan' ? 'clan' : 'player';
    applyUrlState(mode, urlTag);
    // Replace the current history entry so that pushState later works cleanly
    history.replaceState({ mode, tag: urlTag }, '', location.search);
    // Auto-search on load
    _replaceNextPush = true;
    handleSearch();
  } else {
    applyUrlState('player', DEFAULT_TAGS.player);
  }
}

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
    syncUrlState(currentMode, tag);
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
  const { overview, activityIndicators, recentActivity, warHistory, warScore } = data;
  const ws = warScore ?? data.reliability; // fallback si pas de race log

  // 1. Overview (Clan & Role removed)
  const cw2 = overview.clanWarWins ?? 0;
  overviewGrid.innerHTML = overviewItems([
    { label: 'Name',          value: overview.name, cls: 'gold' },
    { label: 'Tag',           value: overview.tag },
    { label: 'Trophies',      value: `🏆 ${fmt(overview.trophies)}`,
      risk: overview.trophies < 3000 ? 'bad' : overview.trophies < 5000 ? 'warn' : null },
    { label: 'Best Trophies', value: `🏆 ${fmt(overview.bestTrophies)}` },
    { label: 'CW2 Wins',      value: `⚔️ ${fmt(cw2)}`,
      risk: cw2 < 50 ? 'bad' : cw2 < 150 ? 'warn' : null },
  ]);

  // 2. Stats — race log quand il y a des semaines, sinon battlelog breakdown
  if (warHistory && warHistory.weeks.length > 0) {
    const partRatio = warHistory.totalWeeks > 0 ? warHistory.participation / warHistory.totalWeeks : 0;
    statsGrid.innerHTML = statCards([
      { label: 'Participation',   value: `${warHistory.participation} / ${warHistory.totalWeeks}`,
        risk: partRatio < 0.4 ? 'bad' : partRatio < 0.7 ? 'warn' : null },
      { label: 'Total Fame',      value: fmt(warHistory.totalFame) },
      { label: 'Avg Fame / Week', value: fmt(warHistory.avgFame),
        risk: warHistory.avgFame < 800 ? 'bad' : warHistory.avgFame < 1500 ? 'warn' : null },
      { label: 'Best Week',       value: fmt(warHistory.maxFame) },
      { label: 'Win Rate',        value: `${activityIndicators.winRate}%`,
        risk: activityIndicators.winRate < 30 ? 'bad' : activityIndicators.winRate < 50 ? 'warn' : null },
      { label: 'Donations',       value: fmt(activityIndicators.donations),
        risk: activityIndicators.donations < 50 ? 'bad' : activityIndicators.donations < 200 ? 'warn' : null },
    ]);
  } else {
    // Fallback battlelog : répartition des 30 entrées par type
    const bd = activityIndicators.battleLogBreakdown ?? {};
    statsGrid.innerHTML = statCards([
      { label: '⚔️ War Battles',      value: fmt(activityIndicators.totalWarBattles) },
      { label: '🏆 Win Rate (War)',   value: `${activityIndicators.winRate}%` },
      { label: '🔀 Ladder / Ranked',  value: fmt(bd.ladder ?? 0) },
      { label: '🎯 Challenges',        value: fmt(bd.challenge ?? 0) },
      { label: '📦 Donations',         value: fmt(activityIndicators.donations) },
      { label: '📊 Battle Log',        value: `${bd.total ?? '?'} entries` },
    ]);
  }

  // 3. Race history chart or fallback daily activity
  const titleEl = document.getElementById('history-card-title');
  const noteEl  = document.getElementById('api-limit-note');

  if (warHistory) {
    if (warHistory.weeks.length > 0) {
      if (titleEl) titleEl.textContent = `📅 River Race History – ${warHistory.weeks.length} week${warHistory.weeks.length !== 1 ? 's' : ''}`;
      renderWarHistoryChart(warHistory.weeks);
      if (noteEl) noteEl.textContent =
        `ℹ️ Data from ${warHistory.weeks.length} completed river races. Indigo = above average, red = below average. Dashed line = average (${fmt(warHistory.avgFame)} fame).`;
    } else {
      const bd = activityIndicators.battleLogBreakdown ?? {};
      const parts = [
        bd.gdc      != null ? `${activityIndicators.totalWarBattles} War` : null,
        bd.ladder   != null ? `${bd.ladder} Ladder`           : null,
        bd.challenge != null ? `${bd.challenge} Challenges`  : null,
        bd.friendly != null && bd.friendly > 0 ? `${bd.friendly} Friendly` : null,
      ].filter(Boolean).join(' · ');
      if (titleEl) titleEl.textContent = '📅 River Race History – 10 weeks';
      renderWarHistoryChart([]);
      if (noteEl) noteEl.textContent =
        `⚠️ No River Race history found for this player (recent member). `
        + `API log (${bd.total ?? 30} entries): ${parts || 'no data'}.`;
    }
  } else {
    const bd = activityIndicators.battleLogBreakdown ?? {};
    const parts = [
      bd.gdc      != null ? `${activityIndicators.totalWarBattles} War` : null,
      bd.ladder   != null ? `${bd.ladder} Ladder`           : null,
      bd.challenge != null ? `${bd.challenge} Challenges`  : null,
      bd.friendly != null && bd.friendly > 0 ? `${bd.friendly} Friendly` : null,
    ].filter(Boolean).join(' · ');
    if (titleEl) titleEl.textContent = '📅 Clan War Activity – Last 7 days';
    renderActivityChart(recentActivity.dailyActivity);
    if (noteEl) noteEl.textContent =
      `⚠️ No clan — war history unavailable. `
      + `API log (${bd.total ?? 30} entries): ${parts || 'no data'}.`;
  }

  // 4. War Reliability Score avec breakdown
  renderGaugeChart(ws.pct, ws.color);

  const icon = { green: '✅', yellow: '⚠️', orange: '🟠', red: '🔴' }[ws.color] ?? '❓';
  const fallbackBadge = ws.isFallback
    ? `<div class="fallback-badge">⚠️ Estimate based on API battle log (≤ 30 entries) — no war history available</div>`
    : '';
  verdictBox.innerHTML = `
    <div class="verdict-box ${ws.color}">
      <div class="verdict-icon">${icon}</div>
      <div class="verdict-text-wrap">
        <div class="verdict-score">${ws.total}<span style="font-size:1rem;opacity:.6"> / ${ws.maxScore} pts</span></div>
        <div class="verdict-text">${ws.verdict}</div>
      </div>
    </div>
    ${fallbackBadge}
  `;

  reasonsList.innerHTML = (ws.breakdown ?? []).map((b) => {
    const pct   = Math.round((b.score / b.max) * 100);
    const color = pct >= 76 ? 'var(--green)' : pct >= 61 ? 'var(--yellow)' : pct >= 31 ? 'var(--orange)' : 'var(--red)';
    return `
      <li class="score-row">
        <div class="sr-header">
          <span class="sr-label">${escHtml(b.label)}</span>
          <span class="sr-score-val">${b.score}<span class="sr-max"> / ${b.max}</span></span>
        </div>
        <div class="sr-bar-bg">
          <div class="sr-bar-fill" style="width:${pct}%;background:${color}"></div>
        </div>
        <div class="sr-detail">${escHtml(b.detail)}</div>
      </li>`;
  }).join('');

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

  // Table — apply default sort (activityScore asc = most at-risk first)
  allMembers = members;
  // Reflect default sort on header
  document.querySelectorAll('.members-table th.sortable').forEach((h) => {
    h.classList.remove('sort-asc', 'sort-desc');
    if (h.dataset.col === 'activityScore') h.classList.add('sort-asc');
  });
  renderMembersTable(sortMembers(members, 'activityScore', 'asc'));

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
        <td class="member-link" data-tag="${escHtml(m.tag)}" title="Analyze ${escHtml(m.name)}">
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

// Click on a member name → switch to player mode
membersTbody.addEventListener('click', (e) => {
  const cell = e.target.closest('td.member-link');
  if (!cell) return;
  const tag = cell.dataset.tag;
  if (!tag) return;
  applyUrlState('player', tag);
  _replaceNextPush = false;
  handleSearch();
});

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
      ({ label, value, cls = '', risk = null }) => {
        const sym = risk === 'bad'  ? ' <span class="risk-bad">&#10007;</span>'
                  : risk === 'warn' ? ' <span class="risk-warn">&#9888;</span>'
                  : '';
        return `
        <div class="overview-item">
          <div class="oi-label">${label}</div>
          <div class="oi-value ${cls}">${escHtml(String(value))}${sym}</div>
        </div>`;
      }
    )
    .join('');
}

function statCards(items) {
  return items
    .map(
      ({ label, value, risk = null }) => {
        const sym = risk === 'bad'  ? ' <span class="risk-bad">&#10007;</span>'
                  : risk === 'warn' ? ' <span class="risk-warn">&#9888;</span>'
                  : '';
        return `
        <div class="stat-card">
          <div class="sc-value">${escHtml(String(value))}${sym}</div>
          <div class="sc-label">${label}</div>
        </div>`;
      }
    )
    .join('');
}

function badge(text, type) {
  return `<span class="badge badge-${type}">${text}</span>`;
}

function scoreBarColor(color) {
  return { green: '#22c55e', yellow: '#eab308', orange: '#f97316', red: '#ef4444' }[color] ?? '#7c3aed';
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
