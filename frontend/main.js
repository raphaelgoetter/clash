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
const cacheNote       = document.getElementById('cache-note');
const playerResults   = document.getElementById('player-results');
const clanResults     = document.getElementById('clan-results');
const modeBtns        = document.querySelectorAll('.mode-btn');

// favorites UI elements
const favBtn           = document.getElementById('fav-btn');
const favoritesContainer = document.getElementById('favorites-container');

const overviewGrid    = document.getElementById('overview-grid');
const statsGrid       = document.getElementById('stats-grid');
const verdictBox      = document.getElementById('verdict-box');
const reasonsList     = document.getElementById('reasons-list');
const cardCurrentWar  = document.getElementById('card-current-war');
const warDaysGrid     = document.getElementById('war-days-grid');

const clanOverviewGrid= document.getElementById('clan-overview-grid');
const membersTbody    = document.getElementById('members-tbody');
const filterName      = document.getElementById('filter-name');
const filterVerdict   = document.getElementById('filter-verdict');

// ── State ────────────────────────────────────────────────────
let currentMode = 'player';   // 'player' | 'clan'
let allMembers  = [];          // cache for table filtering / sorting
let sortState   = { col: 'activityScore', dir: 'asc' };
let isWarActive = false;       // true jeu–dim : colonne "This War" visible dans le tableau clan

// Name of the last-result returned by API (used when saving favorite)
let lastResultName = null;

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
  // mettre à jour l'état de l'étoile dès qu'on connaît le tag (même sans recherche)
  lastResultName = null;
  updateFavBtnState(tag);
  // refresh list (mode switch may emphasise a different section)
  renderFavorites();
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
favBtn.classList.remove('hidden');
    } else {
    applyUrlState('player', DEFAULT_TAGS.player);
  }
}

// populate favorites list immediately (may be empty)
renderFavorites();

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
      const { data, fromCache } = await apiFetch(`/api/player/${encodeURIComponent(tag)}/analysis`);
      // store name for favorites
      lastResultName = data.overview?.name || null;
      renderPlayerResults(data);
      updateFavBtnState(tag);
      showCacheNote(fromCache);
    } else {
      const { data, fromCache } = await apiFetch(`/api/clan/${encodeURIComponent(tag)}/analysis`);
      lastResultName = data.clan?.name || null;
      renderClanResults(data);
      updateFavBtnState(tag);
      showCacheNote(fromCache);
    }
    syncUrlState(currentMode, tag);
    // make star available
    favBtn.classList.remove('hidden');
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
  const fromCache = res.headers.get('X-Cache') === 'HIT';
  const data = await res.json();
  return { data, fromCache };
}

// ── Favorites helpers ───────────────────────────────────────
const FAV_STORAGE_KEY = 'trustroyaleFavs';

function getFavorites() {
  try {
    const raw = localStorage.getItem(FAV_STORAGE_KEY);
    return raw ? JSON.parse(raw) : { player: {}, clan: {} };
  } catch (_) {
    return { player: {}, clan: {} };
  }
}

function saveFavorites(obj) {
  localStorage.setItem(FAV_STORAGE_KEY, JSON.stringify(obj));
}

function addFavorite(mode, tag, name) {
  const favs = getFavorites();
  favs[mode] = favs[mode] || {};
  favs[mode][tag] = name;
  saveFavorites(favs);
}

function removeFavorite(mode, tag) {
  const favs = getFavorites();
  if (favs[mode] && favs[mode][tag]) {
    delete favs[mode][tag];
    saveFavorites(favs);
  }
}

function isFavorite(mode, tag) {
  const favs = getFavorites();
  return !!(favs[mode] && favs[mode][tag]);
}

function renderFavorites() {
  const favs = getFavorites();
  const playerKeys = Object.keys(favs.player || {});
  const clanKeys   = Object.keys(favs.clan || {});
  if (playerKeys.length === 0 && clanKeys.length === 0) {
    favoritesContainer.innerHTML = '<p class="text-muted">No favorites yet.</p>';
    return;
  }

  // build two columns explicitly for players and clans
  let html = '';
  html += '<div class="fav-column" data-mode="player">';
  html += '<h3>Players</h3><ul>';
  playerKeys.forEach((tag) => {
    const nm = favs.player[tag];
    html += `<li><a class="fav-item" href="?mode=player&tag=${encodeURIComponent(tag)}" ` +
            `data-mode="player" data-tag="${tag}">` +
            `${escHtml(nm)} (${tag})</a></li>`;
  });
  html += '</ul></div>';
  
  html += '<div class="fav-column" data-mode="clan">';
  html += '<h3>Clans</h3><ul>';
  clanKeys.forEach((tag) => {
    const nm = favs.clan[tag];
    html += `<li><a class="fav-item" href="?mode=clan&tag=${encodeURIComponent(tag)}" ` +
            `data-mode="clan" data-tag="${tag}">` +
            `${escHtml(nm)} (${tag})</a></li>`;
  });
  html += '</ul></div>';
  favoritesContainer.innerHTML = html;
}

function updateFavBtnState(tag) {
  if (isFavorite(currentMode, tag)) {
    favBtn.textContent = '★';
    favBtn.classList.add('faved');
    favBtn.title = 'Remove from favorites';
  } else {
    favBtn.textContent = '☆';
    favBtn.classList.remove('faved');
    favBtn.title = 'Add to favorites';
  }
  favBtn.classList.remove('hidden');
}

function toggleFavorite() {
  const raw = searchInput.value.trim();
  if (!raw) return;
  const tag = raw.startsWith('#') ? raw : `#${raw}`;
  if (isFavorite(currentMode, tag)) {
    // toujours possible de retirer (le nom est déjà dans la liste)
    removeFavorite(currentMode, tag);
  } else {
    // on a besoin du nom pour ajouter : disponible après une recherche
    if (!lastResultName) return;
    addFavorite(currentMode, tag, lastResultName);
  }
  updateFavBtnState(tag);
  renderFavorites();
}

// attach handlers for favorite UI
favBtn.addEventListener('click', toggleFavorite);
// The links already have href so normal navigation works; we still intercept to
// avoid full page reload and keep single‑page app behavior when clicked normally.
favoritesContainer.addEventListener('click', (e) => {
  const link = e.target.closest('.fav-item');
  if (!link) return;
  const mode = link.dataset.mode;
  const tag = link.dataset.tag;
  if (mode && tag) {
    e.preventDefault();
    applyUrlState(mode, tag);
    searchInput.value = tag;
    handleSearch();
  }
});

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
  cacheNote.classList.add('hidden');
  cardCurrentWar.classList.add('hidden');
}

function showCacheNote(fromCache) {
  cacheNote.classList.remove('hidden');
  cacheNote.textContent = fromCache
    ? '🔃 Cached result — refreshes every 15 min'
    : '✅ Live data';
}

// ── Player rendering ──────────────────────────────────────────

function renderPlayerResults(data) {
  const { overview, activityIndicators, recentActivity, warHistory, warScore } = data;
  const ws = warScore ?? data.reliability; // fallback si pas de race log

  // 1. Overview (Clan & Role removed)
  const cw2 = overview.clanWarWins ?? 0;
  overviewGrid.innerHTML = overviewItems([
    { label: 'Name',          value: overview.name, cls: 'gold', badge: ws.isFallback ? 'new' : null },
    { label: 'Tag',           value: overview.tag,
      link: `https://royaleapi.com/player/${overview.tag.replace('#', '')}` },
    { label: 'Trophies',      value: `🏆 ${fmt(overview.trophies)}`,
      risk: overview.trophies < 3000 ? 'bad' : overview.trophies < 5000 ? 'warn' : null },
    { label: 'Best Trophies', value: `🏆 ${fmt(overview.bestTrophies)}` },
    { label: 'CW2 Wins',      value: `⚔️ ${fmt(cw2)}`,
      risk: cw2 < 50 ? 'bad' : cw2 < 150 ? 'warn' : null },
  ]);

  // 2. Stats — race log quand il y a des semaines, sinon battlelog breakdown
  if (warHistory && warHistory.weeks.length > 0) {
    // For display we prefer completed weeks only; current (possibly partial) week is excluded
    const hasCurrent = warHistory.weeks.some((w) => w.isCurrent);
    const totalVisible = warHistory.totalWeeks + (hasCurrent ? 1 : 0); // include current week if present
    // cap to 10 weeks for display
    const displayDen = Math.min(totalVisible, 10);
    // numerator is simply participation, clamped not to exceed displayDen
    let dispPart = Math.min(warHistory.participation, displayDen);
    const partRatio = displayDen > 0 ? dispPart / displayDen : 0;
    statsGrid.innerHTML = statCards([
      { label: 'Participation',   value: `${dispPart} / ${displayDen}`,
        risk: partRatio < 0.4 ? 'bad' : partRatio < 0.7 ? 'warn' : null },
      { label: 'Total Fame',      value: fmt(warHistory.totalFame) },
      { label: 'Avg Fame / Week', value: fmt(warHistory.avgFame),
        risk: warHistory.avgFame < 800 ? 'bad' : warHistory.avgFame < 1500 ? 'warn' : null },
      { label: 'Best Week',       value: fmt(warHistory.maxFame) },
      { label: 'Win Rate',        value: warHistory.historicalWinRate !== null && warHistory.historicalWinRate !== undefined
          ? `${Math.round(warHistory.historicalWinRate * 100)}%`
          : `${activityIndicators.winRate}%`,
        risk: (() => { const wr = warHistory.historicalWinRate !== null && warHistory.historicalWinRate !== undefined ? Math.round(warHistory.historicalWinRate * 100) : activityIndicators.winRate; return wr < 30 ? 'bad' : wr < 50 ? 'warn' : null; })() },
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
      if (noteEl) noteEl.innerHTML =
        `<span>⚠️ No River Race history found for this player (recent member). `
        + `API log (${bd.total ?? 30} entries): ${parts || 'no data'}.</span>`
        + `<details class="note-disclosure">`
        + `<summary>Why might this score be less accurate?</summary>`
        + `<p>The RoyaleAPI battle log covers at most 30 entries (war or non-war). `
        + `For a long-standing member this is reliable, but for a <strong>recent recruit</strong> `
        + `who just joined a clan, their previous clan's war history is lost — only these last 30 battles carry over. `
        + `The reliability estimate may therefore be less precise than for an established member.</p>`
        + `</details>`;
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

  // 3b. Actual Clan War (visible jeudi–dimanche)
  renderCurrentWarCard(data.currentWarDays ?? null);

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
    const color = pct >= 76 ? 'var(--green)' : pct >= 56 ? 'var(--yellow)' : pct >= 31 ? 'var(--orange)' : 'var(--red)';
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

// ── Actual Clan War card (player view) ────────────────────────────

const DAY_NAMES = ['Thu', 'Fri', 'Sat', 'Sun'];

function renderCurrentWarCard(warData) {
  if (!warData) { cardCurrentWar.classList.add('hidden'); return; }
  cardCurrentWar.classList.remove('hidden');

  const { totalDecksUsed, maxDecksElapsed, maxDecksWeek, isReliableTotal, days, arrivedMidWar, arrivedOnDay } = warData;
  const dayNum   = days.findIndex((d) => d.isToday) + 1;

  // Cas spécial : joueur arrivé pendant la GDC
  if (arrivedMidWar) {
    const arrivalDayName = DAY_NAMES[(arrivedOnDay ?? 1) - 1] ?? `day ${arrivedOnDay}`;
    const chipsHtml = days.map((d) => {
      const cls  = d.isFuture ? 'future' : d.isToday ? 'today' : 'past';
      const icon = d.isFuture ? '—' : d.isToday ? '▶' : '✔';
      return `<span class="war-day-chip ${cls}">${d.label} ${icon}</span>`;
    }).join('');
    warDaysGrid.innerHTML =
      `<div class="war-summary">` +
        `<div class="war-progress-row">` +
          `<span class="war-decks-count">0 <span class="war-decks-max">/ ${maxDecksWeek}</span></span>` +
          `<span class="war-decks-label">decks this week</span>` +
          `<span class="war-data-source arrived">Arrived ${arrivalDayName} ⚠️</span>` +
        `</div>` +
        `<div class="war-progress-track"><div class="war-progress-fill bad" style="width:0%"></div></div>` +
        `<div class="war-progress-meta war-arrived-note">` +
          `Joined during the war week — can't count battles this week` +
        `</div>` +
        `<div class="war-day-chips">${chipsHtml}</div>` +
      `</div>`;
    return;
  }

  const pctFill  = Math.round((totalDecksUsed / maxDecksWeek) * 100);
  const pctMark  = Math.round((maxDecksElapsed / maxDecksWeek) * 100);

  // Statut par rapport aux combats attendus jusqu'à aujourd'hui inclus
  let statusIcon, statusText, statusCls;
  if (totalDecksUsed >= maxDecksElapsed)                     { statusIcon = '✅'; statusText = 'On track';          statusCls = 'good'; }
  else if (totalDecksUsed >= Math.ceil(maxDecksElapsed / 2)) { statusIcon = '⚠️'; statusText = 'Behind schedule'; statusCls = 'partial'; }
  else                                                       { statusIcon = '🔴'; statusText = 'Very behind';       statusCls = 'bad'; }

  const sourceNote = isReliableTotal
    ? '<span class="war-data-source reliable">Race log ✓</span>'
    : '<span class="war-data-source fallback">Battle log (approx.)</span>';

  const chipsHtml = days.map((d) => {
    const cls  = d.isFuture ? 'future' : d.isToday ? 'today' : 'past';
    const icon = d.isFuture ? '—' : d.isToday ? '▶' : '✔';
    return `<span class="war-day-chip ${cls}">${d.label} ${icon}</span>`;
  }).join('');

  warDaysGrid.innerHTML =
    `<div class="war-summary">` +
      `<div class="war-progress-row">` +
        `<span class="war-decks-count">${totalDecksUsed} <span class="war-decks-max">/ ${maxDecksWeek}</span></span>` +
        `<span class="war-decks-label">decks this week</span>` +
        sourceNote +
      `</div>` +
      `<div class="war-progress-track">` +
        `<div class="war-progress-fill ${statusCls}" style="width:${pctFill}%"></div>` +
        `<div class="war-progress-marker" style="left:${pctMark}%" title="Expected so far: ${maxDecksElapsed}"></div>` +
      `</div>` +
      `<div class="war-progress-meta">` +
        `Day ${dayNum} of 4 · Expected so far: ${maxDecksElapsed} · ${statusIcon} ${statusText}` +
      `</div>` +
      `<div class="war-day-chips">${chipsHtml}</div>` +
    `</div>`;
}

// ── Clan war mini-colonne (clan table) ───────────────────────────────

function warMiniBarHtml(warData) {
  if (!warData) return '<span class="war-mini-na">—</span>';
  const { totalDecksUsed, maxDecksWeek, maxDecksElapsed, arrivedMidWar, arrivedOnDay } = warData;
  // Joueur arrivé en cours de semaine : icône distincte
  if (arrivedMidWar) {
    const dayName = DAY_NAMES[(arrivedOnDay ?? 1) - 1] ?? `day ${arrivedOnDay}`;
    return `<div class="war-mini-arrived" title="Arrived ${dayName} — can't count battles this week">⚠</div>`;
  }
  const pct = Math.round((totalDecksUsed / maxDecksWeek) * 100);
  const cls = totalDecksUsed >= maxDecksElapsed                   ? 'good'
            : totalDecksUsed >= Math.ceil(maxDecksElapsed / 2)   ? 'partial'
            :                                                        'bad';
  return `<div class="war-mini-total" title="${totalDecksUsed}/${maxDecksElapsed} decks">` +
    `<div class="war-mini-track"><div class="war-mini-fill ${cls}" style="width:${pct}%"></div></div>` +
    `<span class="war-mini-text ${cls}">${totalDecksUsed}/${maxDecksElapsed}</span>` +
  `</div>`;
}
// ── Clan rendering ──────────────────────────────────────────

function renderClanResults(data) {
  const { clan, members, summary } = data;

  // Colonne "This War" visible uniquement en période de guerre (jeu–dim)
  isWarActive = !!data.isWarPeriod;
  document.getElementById('th-this-war').classList.toggle('hidden', !isWarActive);

  // Clan overview card
  clanOverviewGrid.innerHTML = overviewItems([
    { label: 'Name',          value: clan.name, cls: 'gold' },
    { label: 'Tag',           value: clan.tag,
      link: `https://royaleapi.com/clan/${clan.tag.replace('#', '')}/` },
    { label: 'Members',       value: `${clan.members} / 50` },
    { label: 'Clan Score',    value: fmt(clan.clanScore) },
    { label: 'War Trophies',  value: `⚔️ ${fmt(clan.clanWarTrophies ?? 0)}` },
    { label: 'Required',      value: `🏆 ${fmt(clan.requiredTrophies)}` },
    { label: 'Type',          value: capitalize(clan.type ?? '—') },
    { label: 'Avg Score',     value: `${summary.avgScore} / 100` },
  ]);

  // Current Clan War card (jeu–dim)

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
    membersTbody.innerHTML = `<tr><td colspan="${isWarActive ? 8 : 7}" style="text-align:center;color:var(--text-muted)">No members found.</td></tr>`;
    return;
  }

  membersTbody.innerHTML = members
    .map(
      (m) => {
        // Indicateur de dernière connexion dans sa propre cellule
        let lastSeenCell = '<td class="last-seen-col">—</td>';
        if (m.lastSeen) {
          const days = (Date.now() - new Date(m.lastSeen.replace(
            /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})\.(\d{3})Z$/,
            '$1-$2-$3T$4:$5:$6.$7Z'
          )).getTime()) / (1000 * 60 * 60 * 24);
          const cls  = days <= 1 ? 'c-green' : days <= 3 ? 'c-yellow' : days <= 7 ? '' : 'c-red';
          const label = days < 1 ? 'Today'
                      : days < 2 ? '1d ago'
                      : `${Math.round(days)}d ago`;
          lastSeenCell = `<td class="last-seen-col"><span class="last-seen-badge ${cls}">${label}</span></td>`;
        }
        return `
      <tr>
        <td>
          <a class="member-link" href="?${new URLSearchParams({ mode: 'player', tag: m.tag })}" title="Analyze ${escHtml(m.name)}">
            <div style="font-weight:600">${escHtml(m.name)}${m.isNew ? ' <span class="new-badge">new</span>' : ''}</div>
            <div style="font-size:.75rem;color:var(--text-muted)">${escHtml(m.tag)}</div>
          </a>
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
        ${lastSeenCell}
        ${isWarActive ? `<td class="war-col">${warMiniBarHtml(m.warDays)}</td>` : ''}
        <td><span class="verdict-badge ${m.color}">${escHtml(m.verdict)}</span></td>
      </tr>`;
      }
    )
    .join('');
}

// Injecte la cellule Last Seen juste avant la colonne This War / Verdict
// (template string dans renderMembersTable — injection via replace)
membersTbody.addEventListener('click', (e) => {
  const link = e.target.closest('a.member-link');
  if (!link) return;
  e.preventDefault();
  const params = new URLSearchParams(link.search);
  const tag = params.get('tag');
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
    // Les valeurs null vont toujours en dernier, quel que soit le sens du tri
    if (va === null && vb === null) return 0;
    if (va === null) return 1;
    if (vb === null) return -1;
    if (typeof va === 'string') va = va.toLowerCase();
    if (typeof vb === 'string') vb = vb.toLowerCase();
    if (va < vb) return dir === 'asc' ? -1 : 1;
    if (va > vb) return dir === 'asc' ? 1 : -1;
    return 0;
  });
}

// ── Template helpers ─────────────────────────────────────────

function overviewItems(items) {
  return items
    .map(
      ({ label, value, cls = '', risk = null, badge = null, link = null }) => {
        const sym = risk === 'bad'  ? ' <span class="risk-bad">&#10007;</span>'
                  : risk === 'warn' ? ' <span class="risk-warn">&#9888;</span>'
                  : '';
        const bdg = badge ? ` <span class="new-badge">${escHtml(badge)}</span>` : '';
        const val = escHtml(String(value));
        const inner = link ? `<a href="${link}" target="_blank" rel="noopener" class="oi-ext-link">${val}</a>` : val;
        return `
        <div class="overview-item">
          <div class="oi-label">${label}</div>
          <div class="oi-value ${cls}">${inner}${sym}${bdg}</div>
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

