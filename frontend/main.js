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
const searchSelect    = document.getElementById('search-select');
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
// list of permitted clans; keeps parallel with backend ALLOWED_CLANS
const CLAN_OPTIONS = [
  { tag: '#Y8JUPC9C', name: 'La Resistance' },
  { tag: '#LRQP20V9', name: 'Les Resistants' },
  { tag: '#QU9UQJRL', name: 'Les Revoltes' },
];
const DEFAULT_TAGS = { player: '#YRGJGR8R', clan: CLAN_OPTIONS[0].tag };

// Clé de stockage des favoris
const FAV_STORAGE_KEY = 'trustroyaleFavs';

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
  if (mode === 'clan') {
    // ensure tag is in our allowed list
    if (!CLAN_OPTIONS.some((o) => o.tag === tag)) {
      tag = CLAN_OPTIONS[0].tag;
    }
  }
  currentMode = mode;
  modeBtns.forEach((b) => {
    b.classList.toggle('active', b.dataset.mode === mode);
  });
  if (mode === 'player') {
    searchInput.classList.remove('hidden');
    searchSelect.classList.add('hidden');
    searchInput.placeholder = 'Enter player tag (e.g. #ABC123) …';
    searchHint.textContent = "Tags must start with #. You can omit it and we'll add it automatically.";
    searchInput.value = tag;
  } else {
    searchInput.classList.add('hidden');
    searchSelect.classList.remove('hidden');
    searchHint.textContent = "Select a clan (restricted to Resistance family clans)";
    // set select value
    searchSelect.value = tag;
  }
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
// populate clan select options
function initClanSelect() {
  if (!searchSelect) return;
  searchSelect.innerHTML = CLAN_OPTIONS
    .map(o => `<option value="${o.tag}">${escHtml(o.name)} (${o.tag})</option>`)
    .join('');
}
initClanSelect();

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

// populate favorites list immediately (may be empty)
renderFavorites();

// ── Search trigger ───────────────────────────────────────────
async function loadStaticClan(tag) {
  try {
    const clean = tag.replace(/[^A-Za-z0-9]/g, '');
    const res = await fetch(`/clan-cache/${clean}.json`);
    if (!res.ok) return null;
    return await res.json();
  } catch (_) {
    return null;
  }
}

async function handleSearch() {
  const raw = currentMode === 'clan' ? searchSelect.value.trim() : searchInput.value.trim();
  if (!raw) return showError('Please enter a tag.');

  const tag = raw.startsWith('#') ? raw : `#${raw}`;
  hideError();
  hideResults();
  setLoading(true);

  try {
    if (currentMode === 'player') {
      const { data, fromCache } = await apiFetch(`/api/player/${encodeURIComponent(tag)}/analysis`);
      lastResultName = data.overview?.name || null;
      renderPlayerResults(data);
      updateFavBtnState(tag);
      showCacheNote(fromCache, data?.snapshotDate);
      updateDebugPanel(data, 'player');
    } else {
      // clan mode: try static file first
      // Afficher overview + charts depuis le cache statique instantanément
      const staticData = await loadStaticClan(tag);
      if (staticData) {
        lastResultName = staticData.clan?.name || null;
        renderClanOverview(staticData);
        renderMembersSkeleton();
        updateFavBtnState(tag);
        showCacheNote(true, staticData.snapshotDate);
      }

      const { data, fromCache } = await apiFetch(`/api/clan/${encodeURIComponent(tag)}/analysis`);
      lastResultName = data.clan?.name || null;
      // Mettre à jour l'overview avec les données fraîches
      renderClanOverview(data);
      // Afficher les membres uniquement depuis les données live (une seule fois)
      renderClanMembers(data);
      updateDebugPanel(data, 'clan');
      updateFavBtnState(tag);
      showCacheNote(fromCache, data.snapshotDate);
    }
    syncUrlState(currentMode, tag);
    favBtn.classList.remove('hidden');
    renderFavorites();
  } catch (err) {
    showError(err.message);
  } finally {
    setLoading(false);
  }
}

searchBtn.addEventListener('click', handleSearch);
searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') handleSearch();
});
searchSelect.addEventListener('change', () => {
  // immediately search when user picks a clan
  if (currentMode === 'clan') handleSearch();
});

// ── API fetch helper ──────────────────────────────────────────
async function apiFetch(path) {
  // always bypass browser cache
  const res = await fetch(path, { cache: 'no-store' });
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
  const clanKeys   = (Object.keys(favs.clan || {}) || [])
    .filter((tag) => CLAN_OPTIONS.some((o) => o.tag === tag));
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
    const display = (nm && nm !== tag) ? `${escHtml(nm)} (${tag})` : escHtml(tag);
    html += `<li><a class="fav-item" href="?mode=player&tag=${encodeURIComponent(tag)}" ` +
            `data-mode="player" data-tag="${tag}">${display}</a></li>`;
  });
  html += '</ul></div>';

  html += '<div class="fav-column" data-mode="clan">';
  html += '<h3>Clans</h3><ul>';
  clanKeys.forEach((tag) => {
    const nm = favs.clan[tag];
    const display = (nm && nm !== tag) ? `${escHtml(nm)} (${tag})` : escHtml(tag);
    // clan favorites now link to the app (clan view) instead of RoyaleAPI
    html += `<li><a class="fav-item" href="?mode=clan&tag=${encodeURIComponent(tag)}" ` +
            `data-mode="clan" data-tag="${tag}">${display}</a></li>`;
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

// Récupère uniquement le nom d'un tag via l'API, sans déclencher l'analyse complète.
async function fetchTagName(mode, tag) {
  try {
    const path = mode === 'player'
      ? `/api/player/${encodeURIComponent(tag)}/analysis`
      : `/api/clan/${encodeURIComponent(tag)}/analysis`;
    const { data } = await apiFetch(path);
    return (mode === 'player' ? data.overview?.name : data.clan?.name) || tag;
  } catch {
    return tag; // utiliser le tag comme nom de secours
  }
}

async function toggleFavorite() {
  const raw = currentMode === 'clan' ? searchSelect.value.trim() : searchInput.value.trim();
  if (!raw) return;
  let tag = raw.startsWith('#') ? raw : `#${raw}`;
  if (currentMode === 'clan' && !CLAN_OPTIONS.some((o) => o.tag === tag)) {
    return; // not allowed
  }
  if (isFavorite(currentMode, tag)) {
    removeFavorite(currentMode, tag);
  } else {
    const name = lastResultName || await fetchTagName(currentMode, tag);
    addFavorite(currentMode, tag, name);
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

function showCacheNote(fromCache, snapshotDate = null) {
  cacheNote.classList.remove('hidden');

  // decide human‑friendly snapshot text
  let snapshotText;
  if (!snapshotDate) {
    // no snapshot file could be found/loaded for this clan
    snapshotText = 'none (no data) ❌';
  } else {
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    if (snapshotDate === today) {
      snapshotText = 'today ✅';
    } else if (snapshotDate === yesterday) {
      snapshotText = 'yesterday ⚠️';
    } else {
      const d = new Date(snapshotDate);
      const opts = { month: 'long', day: 'numeric' };
      snapshotText = `${d.toLocaleDateString(undefined, opts)} ❌`;
    }
  }

  cacheNote.textContent = fromCache
    ? `Cached content 🔃 · Snapshot : ${snapshotText}`
    : `Live data ✅ · Snapshot : ${snapshotText}`;
}

// ── Player rendering ──────────────────────────────────────────

function renderPlayerResults(data) {
  const { overview, activityIndicators, recentActivity, warHistory, warScore } = data;
  const ws = warScore ?? data.reliability; // fallback si pas de race log

  // 1. Overview (Clan & Role removed)
  const cw2 = overview.clanWarWins ?? 0;
  // build clan link if available (external RoyaleAPI page)
  const clanTag = overview.clan?.tag ?? null;
  const clanLink = clanTag
    ? `https://royaleapi.com/clan/${clanTag.replace('#', '')}/`
    : null;
  const clanValue = clanTag ? clanTag : 'No clan';
  const playerBadge = warHistory?.isFamilyTransfer ? 'transfer' : (ws.isFallback ? 'new' : null);
  overviewGrid.innerHTML = overviewItems([
    { label: 'Name',          value: overview.name, cls: 'gold', badge: playerBadge },
    { label: 'Tag',           value: overview.tag,
      link: `https://royaleapi.com/player/${overview.tag.replace('#', '')}` },
    { label: 'Clan',          value: clanValue,
      link: clanLink },
    { label: 'Trophies',      value: `🏆 ${fmt(overview.trophies)}`,
      risk: overview.trophies < 3000 ? 'bad' : overview.trophies < 5000 ? 'warn' : null },
    { label: 'CW2 Wins',      value: `⚔️ ${fmt(cw2)}`,
      risk: cw2 < 50 ? 'bad' : cw2 < 150 ? 'warn' : null },
    { label: 'Discord',       value: data.overview?.discord ? 'Linked' : 'Not linked',
      cls: data.overview?.discord ? 'c-green' : 'c-red' },
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
      { label: 'Donations', value: fmt(activityIndicators.donations),
        risk: activityIndicators.donations < 2000 ? 'bad' : activityIndicators.donations < 30000 ? 'warn' : null },
    ]);
  } else {
    // Fallback battlelog : répartition des 30 entrées par type
    const bd = activityIndicators.battleLogBreakdown ?? {};
    statsGrid.innerHTML = statCards([
      { label: '⚔️ War Battles',      value: fmt(activityIndicators.totalWarBattles) },
      { label: '🏆 Win Rate (War)',   value: `${activityIndicators.winRate}%` },
      { label: '🔀 Ladder / Ranked',  value: fmt(bd.ladder ?? 0) },
      { label: '🎯 Challenges',        value: fmt(bd.challenge ?? 0) },
      { label: '📦 Total Donations',   value: fmt(activityIndicators.donations) },
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
      if (noteEl) {
        let note = `ℹ️ Data from ${warHistory.weeks.length} completed river races. Indigo = above average, red = below average. Dashed line = average (${fmt(warHistory.avgFame)} fame).`;
        if (warHistory.weeks.some((w) => w.ignored)) {
          note += ' Grey bar indicates a week ignored for scoring (likely joined mid‑race).';
        }
        noteEl.textContent = note;
      }
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
  renderCurrentWarCard(
    data.currentWarDays ?? null,
    data.warSnapshotDays ?? null,
    data.warCurrentWeekId ?? null,
    data.snapshotTakenAt ?? null,
  );

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
    if (b.excluded) {
      return `
      <li class="score-row score-row-excluded">
        <div class="sr-header">
          <span class="sr-label">${escHtml(b.label)}</span>
          <span class="sr-excluded-badge">not counted</span>
        </div>
        <div class="sr-bar-bg"></div>
        <div class="sr-detail">${escHtml(b.detail)}</div>
      </li>`;
    }
    const pct   = Math.round((b.score / b.max) * 100);
    const color = pct >= 75 ? 'var(--green)' : pct >= 56 ? 'var(--yellow)' : pct >= 31 ? 'var(--orange)' : 'var(--red)';
    const label = b.label === 'Discord'
      ? `Discord (${b.score > 0 ? 'yes' : 'no'})`
      : escHtml(b.label);
    return `
      <li class="score-row">
        <div class="sr-header">
          <span class="sr-label">${label}</span>
          <span class="sr-score-val">${b.score}<span class="sr-max"> / ${b.max}</span></span>
        </div>
        <div class="sr-bar-bg">
          <div class="sr-bar-fill" style="width:${pct}%;background:${color}"></div>
        </div>
        <div class="sr-detail">${escHtml(b.detail)}</div>
      </li>`;
  }).join('');

  playerResults.classList.remove('hidden');
}

// ── Actual Clan War card (player view) ────────────────────────────

const DAY_NAMES = ['Thu', 'Fri', 'Sat', 'Sun'];

function renderCurrentWarCard(warData, warSnapshotDays = null, weekId = null, snapshotTakenAt = null) {
  if (!warData) { cardCurrentWar.classList.add('hidden'); return; }
  cardCurrentWar.classList.remove('hidden');

  const weekLabel = weekId ? ` <span class="card-week-id">(${weekId.toLowerCase()})</span>` : '';
  cardCurrentWar.querySelector('.card-title').innerHTML = `⚔️ Current Clan War${weekLabel}`;

  // If we have snapshot data, prefer it for totals/daily counts (because battle log can be incomplete).
  const snapDays = Array.isArray(warSnapshotDays) ? warSnapshotDays : null;
  const snapHasData = snapDays && snapDays.some((v) => v !== null && v !== undefined);

  const {
    totalDecksUsed: rawTotal,
    maxDecksElapsed: rawMaxElapsed,
    maxDecksWeek: rawMaxWeek,
    isReliableTotal,
    days,
    arrivedMidWar,
    arrivedOnDay,
  } = warData;

  // Determine current war day index (0=Thu, 1=Fri, 2=Sat, 3=Sun)
  const daysFromThu = days.findIndex((d) => d.isToday);
  const dayNum = daysFromThu + 1;

  // Total decks used: prefer battle/race log total (rawTotal), but still show
  // per-day snapshot when available.
  const totalDecksUsed = rawTotal;

  const computedMaxElapsed = (daysFromThu + 1) * 4;
  const computedMaxWeek = 16;

  const pctFill = Math.min(100, Math.round((totalDecksUsed / computedMaxElapsed) * 100));

  // Special case: player joined mid-war
  if (arrivedMidWar) {
    const arrivalDayName = DAY_NAMES[(arrivedOnDay ?? 1) - 1] ?? `day ${arrivedOnDay}`;
    const chipsHtml = days.map((d) => {
      const cls = d.isFuture ? 'future' : d.isToday ? 'today' : 'past';
      const icon = d.isFuture ? '—' : d.isToday ? '▶' : '✔';
      return `<span class="war-day-chip ${cls}">${d.label} ${icon}</span>`;
    }).join('');
    warDaysGrid.innerHTML =
      `<div class="war-summary">` +
        `<div class="war-progress-row">` +
          `<span class="war-decks-count">0 <span class="war-decks-max">/ ${computedMaxWeek}</span></span>` +
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

  // Status based on expected vs actual decks
  let statusIcon, statusText, statusCls;
  if (totalDecksUsed >= computedMaxElapsed)                     { statusIcon = '✅'; statusText = 'On track';          statusCls = 'good'; }
  else if (totalDecksUsed >= Math.ceil(computedMaxElapsed / 2)) { statusIcon = '⚠️'; statusText = 'Behind schedule'; statusCls = 'partial'; }
  else                                                         { statusIcon = '🔴'; statusText = 'Very behind';       statusCls = 'bad'; }

  const snapshotTakenAtLabel = snapshotTakenAt
    ? ` (snapshot ${new Date(snapshotTakenAt).toISOString().slice(11,16)} UTC)`
    : '';

  const snapshotMismatch = snapHasData && days.some((d, i) => {
    const snap = snapDays?.[i];
    return snap != null && snap !== d.count;
  });

  const sourceNote = snapHasData
    ? `<span class="war-data-source reliable">Snapshot ✓${snapshotTakenAtLabel}${snapshotMismatch ? ' ⚠️' : ''}</span>`
    : isReliableTotal
      ? '<span class="war-data-source reliable">Race log ✓</span>'
      : '<span class="war-data-source fallback">Battle log (approx.)</span>';

  const chipsHtml = days.map((d, i) => {
    const cls  = d.isFuture ? 'future' : d.isToday ? 'today' : 'past';
    const icon = d.isFuture ? ' —' : d.isToday ? ' ▶' : '';

    const snapshotVal = snapDays?.[i];
    const battleVal = d.count;

    let label = d.label;
    let snap = '';

    if (snapshotVal != null) {
      const warn = snapshotVal < 4 ? ' ⚠️' : '';
      const snapCls = snapshotVal <= 1 ? 'chip-snap chip-snap-red' : snapshotVal <= 3 ? 'chip-snap chip-snap-orange' : 'chip-snap';
      const note = snapshotVal !== battleVal ? ` (snap ${snapshotVal}/4)` : '';
      snap = ` <span class="${snapCls}">${battleVal}/4${warn}${note}</span>`;
    } else {
      // no snapshot: mark as missing rather than guessing based on incomplete log
      label += ' (no data)';
      snap = ` <span class="chip-snap chip-snap-fallback">${battleVal}/4</span>`;
    }

    return `<span class="war-day-chip ${cls}">${label}${icon}${snap}</span>`;
  }).join('');

  warDaysGrid.innerHTML =
    `<div class="war-summary">` +
      `<div class="war-progress-row">` +
        `<span class="war-decks-count">${totalDecksUsed} <span class="war-decks-max">/ ${computedMaxElapsed}</span></span>` +
        `<span class="war-decks-label">decks so far</span>` +
        sourceNote +
      `</div>` +
      `<div class="war-progress-track">` +
        `<div class="war-progress-fill ${statusCls}" style="width:${pctFill}%"></div>` +
      `</div>` +
      `<div class="war-progress-meta">` +
        `Day ${dayNum} of 4 · ${statusIcon} ${statusText}` +
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
// ── Top players card renderer ─────────────────────────────────

function renderTopPlayersCard(topPlayers, prevWeekId = null) {
  const card = document.getElementById('card-top-players');
  const listEl = document.getElementById('top-players-list');
  if (!topPlayers || !topPlayers.quotas) {
    card.classList.add('hidden');
    return;
  }
  const weekLabel = prevWeekId ? ` <span class="card-week-id">(${prevWeekId.toLowerCase()})</span>` : '';
  card.querySelector('.card-title').innerHTML = `🏅 Last War Best${weekLabel}`;

  // ensure quotas match the radio buttons; if dynamic, we'd rebuild them
  // but here we assume the static 2400/2600/2800 set.
  const quotas = topPlayers.quotas.map(String);

  function updateList(quota) {
    let players = topPlayers.playersByQuota[quota] || [];
    // sort by fame descending
    players = players.slice().sort((a, b) => b.fame - a.fame);
    if (players.length === 0) {
      listEl.innerHTML = '<li class="text-muted">No players reached this quota.</li>';
    } else {
      listEl.innerHTML = players
        .map((p) =>
          `<li>` +
            `<span class="tp-name">${escHtml(p.name)} ` +
              `<span class="tp-tag">${escHtml(p.tag)}</span>` +
            `</span>` +
            `<span class="tp-meta">` +
              `<span class="role-badge ${p.role}">${capitalize(p.role)}</span>` +
              `<span class="tp-fame">${fmt(p.fame)} fame</span>` +
            `</span>` +
          `</li>`
        )
        .join('');
    }
  }

  const radios = card.querySelectorAll('input[name="quota"]');
  radios.forEach((r) => {
    r.addEventListener('change', () => updateList(r.value));
  });
  // initialize list with default checked radio
  const checked = card.querySelector('input[name="quota"]:checked');
  updateList(checked ? checked.value : quotas[0]);

  card.classList.remove('hidden');
}

// ── Uncomplete decks card renderer ───────────────────────────

function renderUncompleteCard(uncomplete, prevWeekId = null) {
  const card = document.getElementById('card-uncomplete');
  const listEl = document.getElementById('uncomplete-list');
  if (!uncomplete || !Array.isArray(uncomplete.players)) {
    card.classList.add('hidden');
    return;
  }
  const weekLabel = prevWeekId ? ` <span class="card-week-id">(${prevWeekId.toLowerCase()})</span>` : '';
  card.querySelector('.card-title').innerHTML = `🤷 Last War fails${weekLabel}`;
  const players = uncomplete.players.slice().sort((a,b)=> b.decks - a.decks);

  // show a global warning if any player is still using warlog data (not snapshot)
  // or if snapshots do not cover all 4 GDC days.
  const missingDays = uncomplete.snapshotComplete === false;
  const needWarning = missingDays || players.some(p => p.dailySource !== 'snapshot' || (p.dailySource === 'snapshot' && !p.dailySnapshotComplete));
  const existing = card.querySelector('.uncomplete-warning');
  if (needWarning) {
    if (!existing) {
      const desc = card.querySelector('.card-desc');
      const html = '<div class="uncomplete-warning">⚠ Some GDC data has not yet been collected</div>';
      if (desc) {
        desc.insertAdjacentHTML('afterend', html);
      } else {
        card.insertAdjacentHTML('afterbegin', html);
      }
    }
  } else if (existing) {
    existing.remove();
  }

  function formatDaily(counts) {
    if (!counts) return '';
    if (Array.isArray(counts)) {
      const labels = ['thu', 'fri', 'sat', 'sun'];
      const parts = [];
      for (let i = 0; i < labels.length; i += 1) {
        const val = counts[i];
        if (val == null) {
          // missing snapshot (we don't know if the player played or not)
          parts.push(`<span class="daily-missing">❓× ${labels[i]}</span>`);
          continue;
        }
        const cls = val >= 4 ? 'daily-green' : val >= 3 ? 'daily-orange' : 'daily-red';
        parts.push(`<span class="${cls}">${val}× ${labels[i]}</span>`);
      }
      return parts.join(' - ');
    }
    const keys = Object.keys(counts).sort();
    const entries = keys.map((k) => ({ k, num: counts[k] })).filter((e) => e.num > 0);
    if (entries.length === 0) return '';
    const n = entries.length;
    const labels = ['Thu', 'Fri', 'Sat', 'Sun'].slice(-n);
    return entries
      .map((e, i) => {
        const num = e.num;
        const cls = num >= 4 ? 'daily-green' : num >= 3 ? 'daily-orange' : 'daily-red';
        return `<span class="${cls}">${num}× ${labels[i].toLowerCase()}</span>`;
      })
      .join(' - ');
  }

  // Supprimer l'éventuelle section "partis" précédente pour éviter les doublons
  const existingDeparted = card.querySelector('.uncomplete-departed');
  if (existingDeparted) existingDeparted.remove();

  function renderPlayerItem(p) {
    const dailyStr = formatDaily(p.daily);
    let warnAfter = '';
    if (p.dailySource !== 'snapshot') {
      warnAfter = ' ⚠';
    } else if (p.dailySource === 'snapshot' && !p.dailySnapshotComplete) {
      warnAfter = ' ⚠';
    }
    const transferBadge = p.isFamilyTransfer ? '<span class="transfer-badge">transfer</span>' : '';
    const newBadge = !p.isFamilyTransfer && p.isNew ? '<span class="new-badge">new</span>' : '';
    return `<li><span class="tp-name">${escHtml(p.name)} ` +
      `<span class="tp-tag">${escHtml(p.tag)}</span>${transferBadge}${newBadge}</span>` +
      `<span class="tp-meta">` +
        `<span class="role-badge ${p.role}">${capitalize(p.role)}</span>` +
        `<span class="tp-fame">${fmt(p.decks)} decks${dailyStr ? ' (' + dailyStr + ')' : ''}${warnAfter}</span>` +
      `</span></li>`;
  }

  const present  = players.filter(p => p.inClan);
  const departed = players.filter(p => !p.inClan);

  if (present.length === 0 && departed.length === 0) {
    listEl.innerHTML = '<li class="text-muted">Everyone completed 16 decks 👍</li>';
  } else {
    listEl.innerHTML = present.length > 0
      ? present.map(renderPlayerItem).join('')
      : '<li class="text-muted">Everyone still in clan completed 16 decks 👍</li>';
  }

  // Section séparée pour les joueurs qui ont quitté le clan
  if (departed.length > 0) {
    const departedHtml =
      `<div class="uncomplete-departed">` +
        `<p class="uncomplete-departed-title">🚪 Left the clan</p>` +
        `<ol class="top-players-list uncomplete-departed-list">` +
          departed.map(renderPlayerItem).join('') +
        `</ol>` +
      `</div>`;
    listEl.insertAdjacentHTML('afterend', departedHtml);
  }

  card.classList.remove('hidden');
}

// ── Clan war card (vue clan) ──────────────────────────────────────────

function renderClanWarCard(clanWarSummary) {
  const card = document.getElementById('card-clan-war');
  if (!clanWarSummary) { card.classList.add('hidden'); return; }
  card.classList.remove('hidden');

  const { totalDecksUsed, maxDecksElapsed, maxDecksWeek, participantCount, daysFromThu, days, weekId } = clanWarSummary;
  const weekLabel = weekId ? ` <span class="card-week-id">(${weekId.toLowerCase()})</span>` : '';
  card.querySelector('.card-title').innerHTML = `⚔️ Current Clan War${weekLabel}`;
  const dayNum   = daysFromThu + 1;
  const pctFill  = Math.min(100, Math.round((totalDecksUsed / maxDecksElapsed) * 100));

  let statusIcon, statusText, statusCls;
  if (totalDecksUsed >= maxDecksElapsed)                     { statusIcon = '✅'; statusText = 'On track';          statusCls = 'good'; }
  else if (totalDecksUsed >= Math.ceil(maxDecksElapsed / 2)) { statusIcon = '⚠️'; statusText = 'Behind schedule'; statusCls = 'partial'; }
  else                                                       { statusIcon = '🔴'; statusText = 'Very behind';       statusCls = 'bad'; }

  const chipsHtml = days.map((d) => {
    const cls  = d.isFuture ? 'future' : d.isToday ? 'today' : 'past';
    const icon = d.isFuture ? ' —' : d.isToday ? ' ▶' : '';
    let detail = '';
    if (!d.isFuture && d.totalCount !== null) {
      const ratio = d.maxCount > 0 ? d.totalCount / d.maxCount : 0;
      const snapCls = ratio >= 1 ? '' : ratio >= 0.75 ? 'chip-snap chip-snap-orange' : 'chip-snap chip-snap-red';
      detail = ` <span class="${snapCls || 'chip-snap'}">${d.totalCount}/${d.maxCount}</span>`;
    }
    return `<span class="war-day-chip ${cls}">${d.label}${icon}${detail}</span>`;
  }).join('');

  document.getElementById('clan-war-grid').innerHTML =
    `<div class="war-summary">` +
      `<div class="war-progress-row">` +
        `<span class="war-decks-count">${totalDecksUsed} <span class="war-decks-max">/ ${maxDecksElapsed}</span></span>` +
        `<span class="war-decks-label">decks so far</span>` +
        `<span class="war-data-source reliable">Race log ✓</span>` +
      `</div>` +
      `<div class="war-progress-track">` +
        `<div class="war-progress-fill ${statusCls}" style="width:${pctFill}%"></div>` +
      `</div>` +
      `<div class="war-progress-meta">` +
        `Day ${dayNum} of 4 · ${statusIcon} ${statusText}` +
      `</div>` +
      `<div class="war-day-chips">${chipsHtml}</div>` +
    `</div>`;
}

// ── Clan rendering ──────────────────────────────────────────

// Affiche l'overview du clan, les charts et les cards top/uncomplete.
// Peut être appelé depuis le cache statique ET depuis les données live.
function renderClanOverview(data) {
  const { clan, members, summary } = data;

  // Colonne "This War" visible uniquement en période de guerre (jeu–dim)
  isWarActive = !!data.isWarPeriod;
  renderTopPlayersCard(data.topPlayers, data.prevWeekId ?? null);
  renderUncompleteCard(data.uncomplete, data.prevWeekId ?? null);
  document.getElementById('th-this-war').classList.toggle('hidden', !isWarActive);

  // Clan overview card
  clanOverviewGrid.innerHTML = overviewItems([
    { label: 'Name',          value: clan.name },
    { label: 'Tag',           value: clan.tag,
      link: `https://royaleapi.com/clan/${clan.tag.replace('#', '')}/` },
    { label: 'Members',       value: `${clan.members} / 50`,
      cls: clan.members < 45 ? 'c-red' : clan.members < 48 ? 'c-orange' : clan.members < 50 ? 'c-yellow' : '' },
    { label: 'Clan Score',    value: fmt(clan.clanScore) },
    { label: 'War Trophies',  value: `⚔️ ${fmt(clan.clanWarTrophies ?? 0)}` },
    { label: 'Required',      value: `🏆 ${fmt(clan.requiredTrophies)}` },
    { label: 'Type',          value: capitalize(clan.type ?? '—') },
    { label: 'Avg Score',     value: `${summary.avgScore} / 100`,
      cls: summary.avgScore < 60 ? 'c-red' : summary.avgScore < 70 ? 'c-orange' : summary.avgScore < 80 ? 'c-yellow' : '' },
  ]);

  // Charts
  renderClanBarChart(members);
  renderClanPieChart(summary);
  // Card guerre courante clan
  renderClanWarCard(data.clanWarSummary ?? null);

  clanResults.classList.remove('hidden');
}

// Affiche la liste des membres — appelé uniquement depuis les données live.
function renderClanMembers(data) {
  const { members } = data;
  allMembers = members;
  // Réinitialiser les filtres et le tri par défaut
  filterName.value = '';
  filterVerdict.value = '';
  document.querySelectorAll('.members-table th.sortable').forEach((h) => {
    h.classList.remove('sort-asc', 'sort-desc');
    if (h.dataset.col === 'activityScore') h.classList.add('sort-asc');
  });
  renderMembersTable(sortMembers(members, 'activityScore', 'asc'));
  updateDebugPanel(data, 'clan');
}

// Affiche un skeleton dans le tableau membres pendant le chargement live.
function renderMembersSkeleton() {
  const cols = isWarActive ? 9 : 8;
  membersTbody.innerHTML =
    `<tr><td colspan="${cols}" class="members-skeleton">Members list loading…</td></tr>`;
}

// ── Members table ────────────────────────────────────────────

function renderMembersTable(members) {
  if (members.length === 0) {
    membersTbody.innerHTML = `<tr><td colspan="${isWarActive ? 9 : 8}" style="text-align:center;color:var(--text-muted)">No members found.</td></tr>`;
    return;
  }

  membersTbody.innerHTML = members
    .map(
      (m) => {
        // Indicateur de dernière connexion dans sa propre cellule
        let lastSeenCell = '<td class="last-seen-col">—</td>';
        let daysFrac = Infinity;
        if (m.lastSeen) {
          daysFrac = (Date.now() - new Date(m.lastSeen.replace(
            /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})\.(\d{3})Z$/,
            '$1-$2-$3T$4:$5:$6.$7Z'
          )).getTime()) / (1000 * 60 * 60 * 24);
          const days = Math.round(daysFrac);
          const cls  = days <= 1 ? 'c-green' : days <= 3 ? 'c-yellow' : days <= 7 ? 'c-red' : 'c-red';
          const label = daysFrac < 1 ? 'Today'
                      : days < 2 ? '1d ago'
                      : `${days}d ago`;
          lastSeenCell = `<td class="last-seen-col"><span class="last-seen-badge ${cls}">${label}</span></td>`;
        }
        const displayTransfer = m.isFamilyTransfer;
        const displayNew = !displayTransfer && m.isNew && daysFrac <= 7;
        return `
      <tr>
        <td>
          <a class="member-link" href="?${new URLSearchParams({ mode: 'player', tag: m.tag })}" title="Analyze ${escHtml(m.name)}">
            <div style="font-weight:600">${escHtml(m.name)}${displayTransfer ? ' <span class="transfer-badge">transfer</span>' : ''}${displayNew ? ' <span class="new-badge">new</span>' : ''}</div>
            <div style="font-size:.75rem;color:var(--text-muted)">${escHtml(m.tag)}</div>
          </a>
        </td>
        <td><span class="role-badge ${m.role}">${capitalize(m.role)}</span></td>
        <td>🏆 ${fmt(m.trophies)}</td>
        <td>${fmt(m.totalDonations ?? m.donations)}</td>
        <td class="discord-col">${m.discord ? '✅' : '❓'}</td>
        ${lastSeenCell}
        <td>
          <div style="display:flex;align-items:center;gap:8px">
            <div style="flex:1;height:6px;background:rgba(255,255,255,.08);border-radius:999px;overflow:hidden;min-width:60px">
              <div style="width:${m.activityScore}%;height:100%;background:${scoreBarColor(m.color)};border-radius:999px"></div>
            </div>
            <span style="font-weight:700;font-size:.88rem">${m.activityScore}%</span>
          </div>
        </td>
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

// ── Debug / log panel (dev mode) ──────────────────────────────────
const DEBUG_STORAGE_KEY = 'trustroyale-debug';
let debugEnabled = localStorage.getItem(DEBUG_STORAGE_KEY) === 'true';

function initDebugUI() {
  const toggle = document.getElementById('debug-toggle');
  const panel  = document.getElementById('debug-panel');
  if (!toggle || !panel) return;

  toggle.addEventListener('click', () => {
    debugEnabled = !debugEnabled;
    localStorage.setItem(DEBUG_STORAGE_KEY, debugEnabled ? 'true' : 'false');
    setDebugPanelVisible(debugEnabled);
    updateDebugPanel(null, 'none');
  });

  setDebugPanelVisible(debugEnabled);
  updateDebugPanel(null, 'none');
}

function setDebugPanelVisible(on) {
  const panel = document.getElementById('debug-panel');
  const toggle = document.getElementById('debug-toggle');
  if (!panel || !toggle) return;
  panel.classList.toggle('hidden', !on);
  toggle.classList.toggle('active', on);
}

function updateDebugPanel(data, mode) {
  const panel = document.getElementById('debug-panel');
  if (!panel) return;

  if (!debugEnabled) {
    panel.innerHTML = `
      <h3>Debug mode</h3>
      <p style="margin:0;opacity:.8">Click the 🐞 button to enable debug output.</p>
    `;
    return;
  }

  const payload = {
    mode,
    now: new Date().toISOString(),
    snapshotDate: data?.snapshotDate ?? null,
    snapshotTakenAt: data?.snapshotTakenAt ?? null,
    warCurrentWeekId: data?.warCurrentWeekId ?? null,
    warSnapshotDays: data?.warSnapshotDays ?? null,
    currentWarDays: data?.currentWarDays ?? null,
  };

  const text = JSON.stringify(payload, null, 2);
  panel.innerHTML = `
    <h3>Debug info (${mode})</h3>
    <pre>${escHtml(text)}</pre>
  `;
}

// Initialize debug UI once the DOM is ready
window.addEventListener('DOMContentLoaded', () => initDebugUI());

