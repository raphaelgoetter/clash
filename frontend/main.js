// ============================================================
// main.js — Clash Royale Clan War Reliability Analyzer
// Frontend orchestration: search, fetch, render, export.
// ============================================================

import {
  renderActivityChart,
  renderWarHistoryChart,
  renderBattleLogBreakdownChart,
  renderRaceTimeChart,
  renderGaugeChart,
  renderClanPieChart,
  setChartTranslations,
  destroyIfExists,
} from "./charts.js";
import { renderRaceGroupCard } from "./warGroup.js";

// ── DOM references ───────────────────────────────────────────
const searchInput = document.getElementById("search-input");
const searchSelect = document.getElementById("search-select");
const searchBtn = document.getElementById("search-btn");
const searchBtnLabel = document.getElementById("search-btn-label");
const searchSpinner = document.getElementById("search-spinner");
const searchHint = document.getElementById("search-hint");
const errorBanner = document.getElementById("error-banner");
const cacheNote = document.getElementById("cache-note");
const playerResults = document.getElementById("player-results");
const clanResults = document.getElementById("clan-results");
const modeBtns = document.querySelectorAll(".mode-btn");

// favorites UI elements
const favBtn = document.getElementById("fav-btn");
const favoritesContainer = document.getElementById("favorites-container");

const overviewGrid = document.getElementById("overview-grid");
const statsGrid = document.getElementById("stats-grid");
const verdictBox = document.getElementById("verdict-box");
const reasonsList = document.getElementById("reasons-list");
const cardCurrentWar = document.getElementById("card-current-war");
const warDaysGrid = document.getElementById("war-days-grid");

const clanOverviewGrid = document.getElementById("clan-overview-grid");
const membersTbody = document.getElementById("members-tbody");
const filterName = document.getElementById("filter-name");
const filterVerdict = document.getElementById("filter-verdict");
const clanTagRow = document.getElementById("clan-tag-row");
const clanTagInput = document.getElementById("clan-tag-input");
const clanLiteNotice = document.getElementById("clan-lite-notice");

// ── State ────────────────────────────────────────────────────
let currentMode = "player"; // 'player' | 'clan'
let allMembers = []; // cache for table filtering / sorting
let sortState = { col: "reliability", dir: "asc" };
let isWarActive = false; // true jeu–dim : colonne "This War" visible dans le tableau clan
let currentClanIsLite = false; // true quand le clan affiché est hors-famille (endpoint /lite)

// Name of the last-result returned by API (used when saving favorite)
let lastResultName = null;

// Multi-language support
const LANG_STORAGE_KEY = "trustroyaleLang";
const SUPPORTED_LANGS = ["en", "fr"];
const DEFAULT_LANG = "en";
let currentLang = DEFAULT_LANG;
let translations = {};

/**
 * Retourne la map de traduction des labels de score breakdown.
 * Doit être appelée après chargement de la langue car elle utilise t().
 */
function getScoreLabelMap() {
  return {
    "War Activity": t("warActivity"),
    "General Activity": t("generalActivity"),
    Regularity: t("regularity"),
    "Avg Score": t("avgScore"),
    "Avg fame": t("avgFame"),
    "CW2 Battle Wins": t("cw2BattleWins"),
    "CW2 battle wins": t("cw2BattleWins"),
    "Clan stability": t("clanStability"),
    Stability: t("clanStability"),
    "Last seen": t("lastSeen"),
    "Win Rate (War)": t("winRateFullMode"),
    "Win rate full mode": t("winRateFullMode"),
    Experience: t("experience"),
    Donations: t("donations"),
    Discord: t("discord"),
    "High reliability": t("highReliability"),
    "Moderate risk": t("moderateRisk"),
    "High risk": t("highRisk"),
    "Extreme risk": t("extremeRisk"),
  };
}

function getBasePath() {
  return `/${currentLang}`;
}

/**
 * Retourne l'état courant de l'URL : { lang, mode, tag }.
 * lang est extrait du segment de chemin, mode et tag depuis les query params.
 */
function getUrlState() {
  const seg = window.location.pathname.replace(/\/+$/, "").split("/")[1];
  const params = new URLSearchParams(window.location.search);
  return {
    lang: SUPPORTED_LANGS.includes(seg) ? seg : null,
    mode: params.get("mode"),
    tag: params.get("tag"),
  };
}

/**
 * Met à jour l'URL avec les valeurs fournies. Les valeurs manquantes sont
 * conservées depuis l'URL courante. `replace: true` évite d'ajouter une
 * entrée dans l'historique.
 */
function setUrlState({ lang, mode, tag, replace = false } = {}) {
  const current = getUrlState();
  const finalLang = lang ?? current.lang ?? DEFAULT_LANG;
  const finalMode = mode ?? current.mode;
  const finalTag = tag ?? current.tag;

  const params = new URLSearchParams();
  if (finalMode) params.set("mode", finalMode);
  if (finalTag) params.set("tag", finalTag);

  const url = params.toString()
    ? `/${finalLang}/?${params.toString()}`
    : `/${finalLang}/`;

  const state = {
    mode: finalMode ?? currentMode,
    tag: finalTag ?? "",
    lang: finalLang,
  };
  const shouldReplace = replace || _replaceNextPush;
  if (_replaceNextPush) _replaceNextPush = false;

  if (shouldReplace) {
    history.replaceState(state, "", url);
  } else {
    history.pushState(state, "", url);
  }
}

function loadLanguage(lang) {
  if (!SUPPORTED_LANGS.includes(lang)) lang = DEFAULT_LANG;
  currentLang = lang;
  localStorage.setItem(LANG_STORAGE_KEY, lang);
  document.documentElement.lang = lang;
  // push URL quickly to avoid stuck state when fetch is delayed/fails
  setUrlState({ lang, replace: true });
  return fetch(`/lang/${lang}.json`)
    .then((res) =>
      res.ok
        ? res.json()
        : Promise.reject(new Error("Language file not found")),
    )
    .then((obj) => {
      translations = obj;
      translateUI();
      setChartTranslations({
        members: t("labelMembers"),
        memberPlural: t("entries"),
        memberSingular: t("memberPlayer"),
        highReliability: t("highReliability"),
        moderateRisk: t("moderateRisk"),
        highRisk: t("highRisk"),
        extremeRisk: t("extremeRisk"),
      });
      updateLangButtonUI();
    });
}

function t(key, vars) {
  const fallback = {
    rateLimitedWarning:
      currentLang === "fr"
        ? "Limite de requêtes Clash API dépassée — données partielles affichées, réessayez dans quelques secondes."
        : "Clash API rate limit exceeded — partial data may be displayed, retry in a few seconds.",
    battleLogNoFurtherData:
      currentLang === "fr"
        ? "Aucun historique de clan supplémentaire disponible (Battle Log uniquement)."
        : "No further clan history available (Battle Log only).",
    clanWarSnapshotNote:
      currentLang === "fr"
        ? "Les snapshots sont réalisés chaque heure ; les decks joués à la dernière minute peuvent être comptés sur le jour précédent."
        : "Snapshots are taken every hour; decks played at the last minute may be assigned to the previous day.",
  };

  let val =
    translations && translations[key]
      ? translations[key]
      : fallback[key] || key;
  if (!vars || typeof vars !== "object") return val;
  Object.entries(vars).forEach(([k, v]) => {
    if (k === "plural") {
      const suffix = Number(v) > 1 ? "s" : "";
      val = val.replace("{{plural}}", suffix);
    } else {
      val = val.replace(new RegExp(`{{${k}}}`, "g"), v);
    }
  });
  // if plural placeholder left over, replace with empty
  val = val.replace("{{plural}}", "");
  return val;
}

function initialLang() {
  const pathLang = getUrlState().lang;
  const saved = localStorage.getItem(LANG_STORAGE_KEY);
  if (SUPPORTED_LANGS.includes(pathLang)) return pathLang;
  if (SUPPORTED_LANGS.includes(saved)) return saved;
  return DEFAULT_LANG;
}

function translateUI() {
  document.querySelector(".header-title").textContent = t("headerTitle");
  document.querySelector(".header-subtitle").innerHTML = t("headerSubtitle");
  document.getElementById("btn-player").textContent = `👤 ${t("modePlayer")}`;
  document.getElementById("btn-clan").textContent = `👥 ${t("modeClan")}`;
  searchInput.placeholder = t("searchPlaceholder");
  searchHint.textContent = t("searchHint");
  document.getElementById("search-btn-label").textContent = t("searchButton");
  favBtn.title = t("favButton");
  document
    .getElementById("card-overview")
    .querySelector(".card-title").textContent = `👤 ${t("playerOverview")}`;
  document
    .getElementById("card-activity")
    .querySelector(".card-title").textContent = `📊 ${t("activityIndicators")}`;
  document
    .getElementById("card-current-war")
    .querySelector(".card-title").textContent = `⚔️ ${t("currentClanWar")}`;
  document
    .getElementById("card-war-group")
    .querySelector(".card-title").textContent = `⚔️ ${t("warGroupTitle")}`;
  const warGroupDesc = document.getElementById("war-group-description");
  if (warGroupDesc) warGroupDesc.textContent = t("warGroupDescription");
  document
    .getElementById("card-verdict")
    .querySelector(".card-title").textContent =
    `⚔️ ${t("warReliabilityScore")}`;

  // traductions dynamiques du clan
  translateClanTableHeaders();
  const filterInput = document.getElementById("filter-name");
  if (filterInput) filterInput.placeholder = t("filterByNameTag");
  const filterSelect = document.getElementById("filter-verdict");
  if (filterSelect) {
    filterSelect.innerHTML = `
      <option value="">${t("allVerdicts")}</option>
      <option value="green">✅ ${t("highReliability")}</option>
      <option value="yellow">⚠️ ${t("moderateRisk")}</option>
      <option value="orange">🟠 ${t("highRisk")}</option>
      <option value="red">🔴 ${t("extremeRisk")}</option>
    `;
  }
  document.querySelector(".score-explainer summary").textContent =
    t("scoreExplainer");
  document
    .getElementById("card-clan-overview")
    .querySelector(".card-title").textContent = `🏰 ${t("clanOverview")}`;
  if (clanTagInput) clanTagInput.placeholder = t("clanTagInputPlaceholder");
  const cardTop = document.querySelector("#card-top-players .card-title");
  if (cardTop) {
    const weekSpan = cardTop.querySelector(".card-week-id");
    cardTop.innerHTML = `🏅 ${t("lastWarBest")}`;
    if (weekSpan) cardTop.appendChild(weekSpan);
  }
  const cardTopDesc = document.querySelector("#card-top-players .card-desc");
  if (cardTopDesc) cardTopDesc.textContent = t("lastWarBestDesc") || "";

  const clusterTitle = document.querySelector("#card-clan-table .card-title");
  if (clusterTitle) clusterTitle.textContent = `👥 ${t("memberList")}`;

  const battlelogWeekHeader = document.getElementById("battlelog-week-header");
  const battlelogClanHeader = document.getElementById("battlelog-clan-header");
  const battlelogGdcHeader = document.getElementById("battlelog-gdc-header");
  if (battlelogWeekHeader)
    battlelogWeekHeader.textContent =
      currentLang === "fr" ? "Semaines" : t("week");
  if (battlelogClanHeader) battlelogClanHeader.textContent = t("labelClan");
  if (battlelogGdcHeader)
    battlelogGdcHeader.textContent =
      currentLang === "fr" ? "Decks GDC" : t("riverRaceBattles");

  const scoreExplainerBody = document.querySelector(".score-explainer-body");
  if (scoreExplainerBody) {
    scoreExplainerBody.innerHTML = `
      <p>${t("scoreExplainerFull")}</p>
      <table class="explainer-table">
        <thead>
          <tr><th>${t("criterion")}</th><th>${t("max")}</th><th>${t("cap")}</th></tr>
        </thead>
        <tbody>
          <tr><td>${t("regularity")}</td><td>12</td><td>${t("regularityCap")}</td></tr>
          <tr><td>${t("avgFame")}</td><td>10</td><td>${t("avgFameCap")}</td></tr>
          <tr><td>${t("cw2BattleWins")}</td><td>8</td><td>${t("cw2BattleWinsCap")}</td></tr>
          <tr><td>${t("clanStability")}</td><td>8</td><td>${t("clanStabilityCap")}</td></tr>
          <tr><td>${t("lastSeen")}</td><td>5</td><td>${t("lastSeenCap")}</td></tr>
          <tr><td>${t("winRateFullMode")}</td><td>3</td><td>${t("winRateFullModeCap")}</td></tr>
          <tr><td>${t("experience")}</td><td>3</td><td>${t("experienceCap")}</td></tr>
          <tr><td>${t("donations")}</td><td>2</td><td>${t("donationsCap")}</td></tr>
          <tr><td>${t("discord")}</td><td>2</td><td>${t("discordCap")}</td></tr>
        </tbody>
      </table>
      <p class="explainer-thresholds">${t("thresholds")}</p>
      <p class="explainer-note"><em>${t("fallbackFormulaTitle")}</em>: ${t("fallbackFormulaBody")}</p>
    `;
  }
  const cardUncomplete = document.querySelector("#card-uncomplete .card-title");
  if (cardUncomplete) {
    const weekSpan = cardUncomplete.querySelector(".card-week-id");
    cardUncomplete.innerHTML = `🤷 ${t("lastWarFails")}`;
    if (weekSpan) cardUncomplete.appendChild(weekSpan);
  }
  const cardUncompleteDesc = document.querySelector(
    "#card-uncomplete .card-desc",
  );
  if (cardUncompleteDesc)
    cardUncompleteDesc.textContent = t("lastWarFailsDesc") || "";
  const tabTitleEl = document.querySelector(".tab-title");
  if (tabTitleEl) tabTitleEl.textContent = t("memberList");
}

function translateClanTableHeaders() {
  const headerMap = {
    name: t("memberPlayer"),
    role: t("memberRole"),
    trophies: t("memberTrophies"),
    donations: t("memberDonations"),
    discord: t("memberDiscord"),
    lastSeen: t("memberLastSeen"),
    reliability: t("memberReliability"),
    warDecks: t("memberThisWar"),
    verdict: t("memberVerdict"),
  };
  document.querySelectorAll("#card-clan-table thead th").forEach((th) => {
    const col = th.dataset.col;
    if (!col || !headerMap[col]) return;
    const icon = th.querySelector(".sort-icon");
    if (icon) {
      th.innerHTML = `${headerMap[col]} <span class="sort-icon">${escHtml(icon.textContent)}</span>`;
    } else {
      th.textContent = headerMap[col];
    }
  });
}

// Default tags per mode
// list of permitted clans; keeps parallel with backend ALLOWED_CLANS
const CLAN_OPTIONS = [
  { tag: "#Y8JUPC9C", name: "La Resistance" },
  { tag: "#LRQP20V9", name: "Les Resistants" },
  { tag: "#QU9UQJRL", name: "Les Revoltes" },
];
const DEFAULT_TAGS = { player: "#YRGJGR8R", clan: CLAN_OPTIONS[0].tag };

// Clé de stockage des favoris
const FAV_STORAGE_KEY = "trustroyaleFavs";

// ── URL helpers ──────────────────────────────────────────────

// When true, le prochain appel setUrlState utilise replaceState (pas de nouvel entrée dans l'historique)
let _replaceNextPush = false;

function applyUrlState(mode, tag) {
  currentMode = mode;
  modeBtns.forEach((b) => {
    b.classList.toggle("active", b.dataset.mode === mode);
  });
  if (mode === "player") {
    searchInput.classList.remove("hidden");
    searchSelect.classList.add("hidden");
    clanTagRow.classList.add("hidden");
    searchInput.placeholder = t("searchPlaceholder");
    searchHint.textContent = t("searchHint");
    searchInput.value = tag;
  } else {
    searchInput.classList.add("hidden");
    clanTagRow.classList.remove("hidden");
    // Toujours afficher le select famille
    searchSelect.classList.remove("hidden");
    searchHint.textContent = t("selectClanHint");
    // Si tag famille : sélectionner dans le select et vider le champ manuel
    if (CLAN_OPTIONS.some((o) => o.tag === tag)) {
      searchSelect.value = tag;
      clanTagInput.value = "";
    } else if (tag) {
      // Tag hors-famille : pré-remplir le champ manuel
      clanTagInput.value = tag;
    }
  }
  // mettre à jour l'état de l'étoile dès qu'on connaît le tag (même sans recherche)
  lastResultName = null;
  updateFavBtnState(tag);
  // refresh list (mode switch may emphasise a different section)
  renderFavorites();
}

// Restore state on browser back/forward
window.addEventListener("popstate", (e) => {
  const { mode, tag, lang } = e.state ?? {};
  const pathLang = getUrlState().lang;
  const selectedLang = lang || pathLang || currentLang;
  if (selectedLang !== currentLang) {
    loadLanguage(selectedLang).catch(() => {});
  }

  if (mode && tag) {
    applyUrlState(mode, tag);
    _replaceNextPush = true; // don't push a new entry when restoring history
    handleSearch();
  } else {
    applyUrlState("player", DEFAULT_TAGS.player);
    hideResults();
    hideError();
  }
});

// ── Mode selector ────────────────────────────────────────────
modeBtns.forEach((btn) => {
  btn.addEventListener("click", () => {
    applyUrlState(btn.dataset.mode, DEFAULT_TAGS[btn.dataset.mode]);
    history.replaceState(null, "", location.pathname);
    hideResults();
    hideError();
  });
});

function updateLangButtonUI() {
  const btnEn = document.getElementById("btn-lang-en");
  const btnFr = document.getElementById("btn-lang-fr");
  if (!btnEn || !btnFr) return;
  btnEn.classList.toggle("active", currentLang === "en");
  btnFr.classList.toggle("active", currentLang === "fr");
}

async function switchLanguage(lang) {
  if (currentLang === lang) return;

  if (!SUPPORTED_LANGS.includes(lang)) lang = DEFAULT_LANG;
  localStorage.setItem(LANG_STORAGE_KEY, lang);

  const { mode, tag } = getUrlState();
  const params = new URLSearchParams();
  if (mode) params.set("mode", mode);
  if (tag) params.set("tag", tag);

  const newUrl = params.toString()
    ? `/${lang}/?${params.toString()}`
    : `/${lang}/`;
  window.location.href = newUrl;
}

const btnLangEn = document.getElementById("btn-lang-en");
const btnLangFr = document.getElementById("btn-lang-fr");
if (btnLangEn)
  btnLangEn.addEventListener("click", async () => {
    await switchLanguage("en");
  });
if (btnLangFr)
  btnLangFr.addEventListener("click", async () => {
    await switchLanguage("fr");
  });

// populate clan select options
function initClanSelect() {
  if (!searchSelect) return;
  searchSelect.innerHTML = CLAN_OPTIONS.map(
    (o) => `<option value="${o.tag}">${escHtml(o.name)} (${o.tag})</option>`,
  ).join("");
}
initClanSelect();

// ── Init from URL ─────────────────────────────────────────────
async function initApp() {
  const lang = initialLang();

  if (!getUrlState().lang) {
    // Pas de locale explicite dans le chemin : normaliser vers la langue sélectionnée
    const params = new URLSearchParams(window.location.search);
    const suffix = params.toString() ? `/?${params.toString()}` : "/";
    history.replaceState(null, "", `/${lang}${suffix}`);
  }

  await loadLanguage(lang);

  const params = new URLSearchParams(window.location.search);
  let urlMode = params.get("mode");
  let urlTag = params.get("tag");

  // Fallback for unescaped # in URL like /en/?mode=clan&tag=#LRQP20V9
  if (!urlTag && window.location.hash) {
    const hashVal = window.location.hash.replace(/^#/, "");
    if (hashVal) {
      urlTag = hashVal.startsWith("#") ? hashVal : `#${hashVal}`;
    }
  }

  if (urlTag) {
    const mode = urlMode === "clan" ? "clan" : "player";
    applyUrlState(mode, urlTag);
    const newParams = new URLSearchParams({ mode, tag: urlTag });
    history.replaceState(
      { mode, tag: urlTag, lang: currentLang },
      "",
      `/${currentLang}/?${newParams.toString()}`,
    );
    _replaceNextPush = true;
    await handleSearch();
  } else {
    applyUrlState("player", DEFAULT_TAGS.player);
  }

  // populate favorites list immediately (may be empty)
  renderFavorites();
}
initApp();

// ── Search trigger ───────────────────────────────────────────
async function loadStaticClan(tag) {
  try {
    const clean = tag.replace(/[^A-Za-z0-9]/g, "");
    const res = await fetch(`/clan-cache/${clean}.json`);
    if (!res.ok) return null;
    return await res.json();
  } catch (_) {
    return null;
  }
}

async function handleSearch(force = false) {
  // En mode clan : si le champ manuel a du contenu, il prend la priorité sur le select
  let raw;
  if (currentMode === "clan") {
    const manualVal = clanTagInput.value.trim();
    raw = manualVal || searchSelect.value.trim();
  } else {
    raw = searchInput.value.trim();
  }
  if (!raw) return showError("Please enter a tag.");

  const tag = raw.startsWith("#") ? raw : `#${raw}`;
  // Détermine si ce clan est hors-famille (endpoint lite) en se basant sur CLAN_OPTIONS
  const isLiteClan =
    currentMode === "clan" && !CLAN_OPTIONS.some((o) => o.tag === tag);

  // Mise à jour immédiate de l'URL pour un état de navigation cohérent même en cas d'erreur API.
  setUrlState({ mode: currentMode, tag });

  hideError();
  hideResults();
  setLoading(true);

  let staticData = null;
  try {
    if (currentMode === "player") {
      const query = force ? "?force=true" : "";
      const { data, fromCache } = await apiFetch(
        `/api/player/${encodeURIComponent(tag)}/analysis${query}`,
      );
      lastResultName = data.overview?.name || null;
      renderPlayerResults(data);
      if (data.rateLimited) {
        showError(t("rateLimitedWarning"));
      }
      updateFavBtnState(tag);
      showCacheNote(fromCache, data?.snapshotDate, {
        source: fromCache ? "cached" : "live",
        updatedAt: data.analysisCacheUpdatedAt || new Date().toISOString(),
        snapshotTakenAt:
          data.snapshotTakenAt ?? data.warSnapshotTakenAt ?? null,
      });
      updateDebugPanel(data, "player");
    } else if (isLiteClan) {
      // Clan hors-famille : endpoint lite (données natives uniquement, sans fiabilité)
      renderClanOverview({
        clan: { name: tag },
        summary: {
          green: 0,
          yellow: 0,
          orange: 0,
          red: 0,
          avgScore: 0,
          total: 0,
        },
        members: [],
        isLite: true,
      });
      renderMembersSkeleton();
      const { data, fromCache } = await apiFetch(
        `/api/clan/${encodeURIComponent(tag)}/lite`,
      );
      lastResultName = data.clan?.name || null;
      renderClanOverview(data);
      renderClanMembers(data);
      updateFavBtnState(tag);
      updateDebugPanel(data, "clan");
      showCacheNote(fromCache, null, {
        source: fromCache ? "cached" : "live",
        updatedAt: new Date().toISOString(),
        snapshotTakenAt: null,
      });
    } else {
      // clan mode: try static file first but always refresh from live API.
      const staticData = await loadStaticClan(tag);
      if (staticData) {
        lastResultName = staticData.clan?.name || null;
        // Display cached clan overview and members instantly, but keep
        // section-heavy parts (topPlayers / uncomplete) in lazy state.
        const cachedOverview = {
          ...staticData,
          topPlayers: null,
          uncomplete: null,
        };
        renderClanOverview(cachedOverview);
        renderClanMembers(staticData);
        updateFavBtnState(tag);
        showCacheNote(true, staticData.snapshotDate, {
          source: "cached",
          updatedAt: staticData.analysisCacheUpdatedAt || "unknown",
          snapshotTakenAt:
            staticData.snapshotTakenAt ?? staticData.warSnapshotTakenAt ?? null,
        });
      } else {
        renderClanOverview({
          clan: { name: t("loading") },
          summary: {
            green: 0,
            yellow: 0,
            orange: 0,
            red: 0,
            avgScore: 0,
            total: 0,
          },
          members: [],
        });
        renderMembersSkeleton();
      }

      const queryParams = new URLSearchParams();
      if (force) queryParams.set("force", "true");
      // lazy load heavy sections (topPlayers/uncomplete) on demand
      queryParams.set("includeTopPlayers", "false");
      queryParams.set("includeUncomplete", "false");
      const { data, fromCache } = await apiFetch(
        `/api/clan/${encodeURIComponent(tag)}/analysis?${queryParams.toString()}`,
      );
      lastResultName = data.clan?.name || null;

      // Conserver les valeurs historiques (p.ex. Thu total) quand le live renvoie 0 :
      // on merge avec le cache statique initial.
      const effectiveData = {
        ...data,
        clanWarSummary: mergeWarSummaries(
          data.clanWarSummary,
          staticData?.clanWarSummary ?? staticData?.lastWarSummary,
        ),
        lastWarSummary: mergeWarSummaries(
          data.lastWarSummary,
          staticData?.lastWarSummary,
        ),
      };

      // Mettre à jour l'overview avec les données fraîches/fusées
      renderClanOverview(effectiveData);
      // Afficher les membres live à jour (synchronisation clan / player)
      renderClanMembers(data);
      const shouldWarn =
        !fromCache &&
        (data.rateLimited ||
          data.fallbackReason === "rateLimited" ||
          data.raceLogUnavailable);
      if (shouldWarn) showError(t("rateLimitedWarning"));
      updateDebugPanel(data, "clan");
      updateFavBtnState(tag);
      showCacheNote(false, data.snapshotDate, {
        source: data.rateLimited ? "live (degraded)" : "live",
        updatedAt: data.analysisCacheUpdatedAt || new Date().toISOString(),
        snapshotTakenAt: data.snapshotTakenAt ?? null,
      });
    }
    favBtn.classList.remove("hidden");
    renderFavorites();
  } catch (err) {
    // keep the static data if available (the first render from cache) instead of wiping UI.
    if (staticData) {
      renderClanOverview(staticData);
      renderClanMembers(staticData);
      showCacheNote(true, staticData.snapshotDate, {
        source: "cached",
        updatedAt: staticData.analysisCacheUpdatedAt || "unknown",
        snapshotTakenAt:
          staticData.snapshotTakenAt ?? staticData.warSnapshotTakenAt ?? null,
      });
    }
    showError(err.message);
  } finally {
    setLoading(false);
  }
}

searchBtn.addEventListener("click", handleSearch);
searchInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") handleSearch();
});
searchSelect.addEventListener("change", () => {
  // quand l'utilisateur choisit dans le select, vider le champ manuel et chercher
  if (currentMode === "clan") {
    clanTagInput.value = "";
    handleSearch();
  }
});
clanTagInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") handleSearch();
});

// ── API fetch helper ──────────────────────────────────────────
async function apiFetch(path) {
  // always bypass browser cache
  const res = await fetch(path, { cache: "no-store" });
  if (!res.ok) {
    let msg = `Error ${res.status}`;
    try {
      const body = await res.json();
      msg = body.error ?? msg;
    } catch (_) {
      /* ignore */
    }
    throw new Error(msg);
  }
  const fromCache = res.headers.get("X-Cache") === "HIT";
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
  const clanKeys = (Object.keys(favs.clan || {}) || []).filter((tag) =>
    CLAN_OPTIONS.some((o) => o.tag === tag),
  );
  if (playerKeys.length === 0 && clanKeys.length === 0) {
    favoritesContainer.innerHTML = `<p class="text-muted">${t("favoritesNone")}</p>`;
    return;
  }

  // build two columns explicitly for players and clans
  let html = "";
  html += '<div class="fav-column" data-mode="player">';
  html += `<h3>${t("favoritesPlayers")}</h3><ul>`;
  playerKeys.forEach((tag) => {
    const nm = favs.player[tag];
    const display = nm && nm !== tag ? `${escHtml(nm)} (${tag})` : escHtml(tag);
    html +=
      `<li><a class="fav-item" href="${getBasePath()}/?mode=player&tag=${encodeURIComponent(tag)}" ` +
      `data-mode="player" data-tag="${tag}">${display}</a></li>`;
  });
  html += "</ul></div>";

  html += '<div class="fav-column" data-mode="clan">';
  html += `<h3>${t("favoritesClans")}</h3><ul>`;
  clanKeys.forEach((tag) => {
    const nm = favs.clan[tag];
    const display = nm && nm !== tag ? `${escHtml(nm)} (${tag})` : escHtml(tag);
    // clan favorites now link to the app (clan view) instead of RoyaleAPI
    html +=
      `<li><a class="fav-item" href="${getBasePath()}/?mode=clan&tag=${encodeURIComponent(tag)}" ` +
      `data-mode="clan" data-tag="${tag}">${display}</a></li>`;
  });
  html += "</ul></div>";
  favoritesContainer.innerHTML = html;
}

function updateFavBtnState(tag) {
  if (isFavorite(currentMode, tag)) {
    favBtn.textContent = "★";
    favBtn.classList.add("faved");
    favBtn.title = "Remove from favorites";
  } else {
    favBtn.textContent = "☆";
    favBtn.classList.remove("faved");
    favBtn.title = "Add to favorites";
  }
  favBtn.classList.remove("hidden");
}

// Récupère uniquement le nom d'un tag via l'API, sans déclencher l'analyse complète.
async function fetchTagName(mode, tag) {
  try {
    const path =
      mode === "player"
        ? `/api/player/${encodeURIComponent(tag)}/analysis`
        : `/api/clan/${encodeURIComponent(tag)}/analysis`;
    const { data } = await apiFetch(path);
    return (mode === "player" ? data.overview?.name : data.clan?.name) || tag;
  } catch {
    return tag; // utiliser le tag comme nom de secours
  }
}

async function toggleFavorite() {
  const raw =
    currentMode === "clan"
      ? searchSelect.value.trim()
      : searchInput.value.trim();
  if (!raw) return;
  let tag = raw.startsWith("#") ? raw : `#${raw}`;
  if (currentMode === "clan" && !CLAN_OPTIONS.some((o) => o.tag === tag)) {
    return; // not allowed
  }
  if (isFavorite(currentMode, tag)) {
    removeFavorite(currentMode, tag);
  } else {
    const name = lastResultName || (await fetchTagName(currentMode, tag));
    addFavorite(currentMode, tag, name);
  }
  updateFavBtnState(tag);
  renderFavorites();
}

// attach handlers for favorite UI
favBtn.addEventListener("click", toggleFavorite);
// The links already have href so normal navigation works; we still intercept to
// avoid full page reload and keep single‑page app behavior when clicked normally.
favoritesContainer.addEventListener("click", (e) => {
  const link = e.target.closest(".fav-item");
  if (!link) return;
  const mode = link.dataset.mode;
  const tag = link.dataset.tag;
  if (mode && tag) {
    e.preventDefault();
    applyUrlState(mode, tag);
    if (mode === "clan") {
      searchSelect.value = tag;
    } else {
      searchInput.value = tag;
    }
    setUrlState({ mode, tag });
    handleSearch();
  }
});

// ── UI helpers ───────────────────────────────────────────────
function setLoading(on) {
  searchBtn.disabled = on;
  searchBtnLabel.classList.toggle("hidden", on);
  searchSpinner.classList.toggle("hidden", !on);
}

function showError(msg) {
  errorBanner.textContent = `⚠️  ${msg}`;
  errorBanner.classList.remove("hidden");
}

function hideError() {
  errorBanner.classList.add("hidden");
}

function hideResults() {
  playerResults.classList.add("hidden");
  clanResults.classList.add("hidden");
  cacheNote.classList.add("hidden");
  cardCurrentWar.classList.add("hidden");
}

function showCacheNote(fromCache, snapshotDate = null, sourceMeta = null) {
  cacheNote.classList.remove("hidden");

  // decide human‑friendly snapshot text
  let snapshotText;
  if (!snapshotDate) {
    snapshotText = t("snapshotNone");
  } else {
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86400000)
      .toISOString()
      .slice(0, 10);
    const d = new Date(snapshotDate);
    const dayName = Number.isNaN(d.getTime())
      ? null
      : d.toLocaleDateString("en-US", { weekday: "long" });

    if (snapshotDate === today) {
      snapshotText = `war day : ${t("snapshotToday")} ${dayName ? `(${dayName})` : ""}`;
    } else if (snapshotDate === yesterday) {
      snapshotText = `war day : ${t("snapshotYesterday")} ${dayName ? `(${dayName})` : ""}`;
    } else if (!Number.isNaN(d.getTime())) {
      const dateString = d.toLocaleDateString(undefined, {
        month: "long",
        day: "numeric",
      });
      snapshotText = `war day : ${dateString} ${dayName ? `(${dayName})` : ""}`;
    } else {
      snapshotText = `war day : ${snapshotDate}`;
    }
  }

  const takenAt =
    sourceMeta &&
    (sourceMeta.snapshotTakenAt ||
      sourceMeta.warSnapshotTakenAt ||
      sourceMeta.analysisCacheUpdatedAt)
      ? sourceMeta.snapshotTakenAt ||
        sourceMeta.warSnapshotTakenAt ||
        sourceMeta.analysisCacheUpdatedAt
      : null;
  if (takenAt) {
    const taken = new Date(takenAt);
    if (!Number.isNaN(taken.getTime())) {
      const time = taken.toISOString().slice(11, 16);
      snapshotText = `time : ${time} UTC · ${snapshotText}`;
    }
  }

  const sourceInfo =
    sourceMeta && sourceMeta.source && sourceMeta.source !== "cached"
      ? ` · source: ${sourceMeta.source}`
      : "";

  const ageInfo =
    sourceMeta && sourceMeta.updatedAt
      ? (() => {
          const now = Date.now();
          const updated = Date.parse(sourceMeta.updatedAt);
          if (Number.isNaN(updated)) return "";
          const diffSec = Math.max(0, Math.round((now - updated) / 1000));
          if (diffSec < 60) return ` · fresh ${diffSec}s`;
          const diffMin = Math.round(diffSec / 60);
          return ` · cached ${diffMin}m`;
        })()
      : "";

  cacheNote.textContent = fromCache
    ? `${t("searchHintCached")} ${snapshotText}${sourceInfo}${ageInfo}`
    : `${t("searchHintNoDate")} ${snapshotText}${sourceInfo}${ageInfo}`;
}

// ── Player rendering ──────────────────────────────────────────

function renderPlayerResults(data) {
  const {
    overview,
    activityIndicators,
    recentActivity,
    warHistory,
    warScore,
    battleLog = [],
  } = data;
  const ws = warScore ?? data.reliability; // fallback si pas de race log

  // Forcer la traduction des labels de breakdown si reçus en anglais
  if (ws && Array.isArray(ws.breakdown)) {
    const scoreLabelMap = getScoreLabelMap();
    ws.breakdown = ws.breakdown.map((item) => ({
      ...item,
      label: scoreLabelMap[item.label] || item.label,
    }));
  }

  // 1. Overview (Clan & Role removed)
  const cw2 = overview.clanWarWins ?? 0;
  // build clan link if available (external RoyaleAPI page)
  const clanTag = overview.clan?.tag ?? null;
  const clanLink = clanTag
    ? `https://royaleapi.com/clan/${clanTag.replace("#", "")}/`
    : null;
  const clanValue = clanTag ? clanTag : "No clan";

  const playerTag = overview.tag ?? null;
  const playerLink = playerTag
    ? `https://royaleapi.com/player/${playerTag.replace("#", "")}`
    : null;

  // Ce calcul doit rester synchronisé avec la card historique BattleLog/RaceHistory.
  const hasCompletedWarWeeks = warHistory?.weeks?.some(
    (w) => !w.isCurrent && (w.decksUsed ?? 0) > 0,
  );
  const hasOnlyCurrentWeek =
    warHistory?.weeks?.length === 1 && warHistory?.weeks?.[0]?.isCurrent;
  const isNewClanArrivee =
    (warHistory?.streakInCurrentClan ?? 0) < 2 &&
    (warHistory?.totalWeeks ?? 0) > 1;
  const isBattleLogMode =
    ws?.isFallback === true ||
    !hasCompletedWarWeeks ||
    hasOnlyCurrentWeek ||
    isNewClanArrivee;
  const playerBadge = isNewClanArrivee ? "new" : isBattleLogMode ? "new" : null;

  const MS_PER_DAY = 24 * 60 * 60 * 1000;

  const computeBattlesPerDay = () => {
    // Baseline from battle log entries (all types, max 30 entries from API)
    if (Array.isArray(battleLog) && battleLog.length > 0) {
      const times = battleLog
        .map((b) => parseBattleTimestamp(b?.battleTime))
        .filter((d) => d instanceof Date && !Number.isNaN(d.getTime()))
        .map((d) => d.getTime());
      if (times.length > 0) {
        const min = Math.min(...times);
        const max = Math.max(...times);
        const spanDays = Math.max(1, Math.ceil((max - min + 1) / MS_PER_DAY));
        return activityIndicators.totalBattles > 0
          ? Number((activityIndicators.totalBattles / spanDays).toFixed(1))
          : 0;
      }
    }
    // Fallback using recentActivity bucketed days
    const dailyActivity = recentActivity?.dailyActivity ?? [];
    const dailyTotal = dailyActivity.reduce(
      (sum, d) => sum + (d?.count ?? 0),
      0,
    );
    const dailyCount = dailyActivity.length > 0 ? dailyActivity.length : 7;
    return dailyCount > 0 ? Number((dailyTotal / dailyCount).toFixed(1)) : 0;
  };

  const battlesPerDay = computeBattlesPerDay();

  const activityTitleEl = document
    .getElementById("card-activity")
    ?.querySelector(".card-title");
  if (activityTitleEl) {
    activityTitleEl.textContent = `📊 ${isBattleLogMode ? t("battleLogIndicators") : t("activityIndicators")}`;
  }

  overviewGrid.innerHTML = overviewItems([
    {
      label: t("labelName"),
      value: overview.name,
      cls: "gold",
      badge: playerBadge,
    },
    { label: t("labelTag"), value: overview.tag, link: playerLink },
    { label: t("labelClan"), value: clanValue, link: clanLink },
    {
      label: t("labelTrophies"),
      value: `🏆 ${fmt(overview.trophies)}`,
      risk:
        overview.trophies < 3000
          ? "bad"
          : overview.trophies < 5000
            ? "warn"
            : null,
    },
    {
      label: t("labelCW2Wins"),
      value: `⚔️ ${fmt(cw2)}`,
      risk: cw2 < 50 ? "bad" : cw2 < 150 ? "warn" : null,
    },
    {
      label: t("labelDiscord"),
      value: data.overview?.discord
        ? t("discordLinked")
        : t("discordNotLinked"),
      cls: data.overview?.discord ? "c-green" : "c-red",
    },
  ]);

  // 2. Stats — Battle Log indicators for battle log mode, else river race history
  if (isBattleLogMode) {
    const bd = activityIndicators?.battleLogBreakdown ?? {};
    const total =
      activityIndicators?.totalBattles ??
      activityIndicators?.totalWarBattles ??
      0;
    const gdc = bd.gdc || 0;
    const ratioPercent = total > 0 ? Math.round((gdc / total) * 100) : 0;

    statsGrid.innerHTML = statCards([
      {
        label: t("statTotalBattles"),
        value: fmt(total),
        risk: total < 10 ? "bad" : total < 20 ? "warn" : null,
      },
      {
        label: t("statBattlesPerDay"),
        value: fmt(battlesPerDay),
        risk: battlesPerDay < 2 ? "bad" : battlesPerDay < 4 ? "warn" : null,
      },
      {
        label: t("statRiverRaceRatio"),
        value: `${gdc}/${total} (${ratioPercent}%)`,
        risk: ratioPercent < 25 ? "bad" : ratioPercent < 50 ? "warn" : null,
      },
    ]);
  } else if (warHistory && warHistory.weeks.length > 0) {
    // For display we prefer completed weeks only; current (possibly partial) week is excluded
    const hasCurrent = warHistory.weeks.some((w) => w.isCurrent);
    const totalVisible = warHistory.totalWeeks + (hasCurrent ? 1 : 0); // include current week if present
    // cap to 10 weeks for display
    const displayDen = Math.min(totalVisible, 10);
    // numerator is simply participation, clamped not to exceed displayDen
    let dispPart = Math.min(warHistory.participation, displayDen);
    const partRatio = displayDen > 0 ? dispPart / displayDen : 0;

    statsGrid.innerHTML = statCards([
      {
        label: t("statParticipation"),
        value: `${dispPart} / ${displayDen}`,
        risk: partRatio < 0.4 ? "bad" : partRatio < 0.7 ? "warn" : null,
      },
      { label: t("statTotalFame"), value: fmt(warHistory.totalFame) },
      {
        label: t("statAvgFame"),
        value: fmt(warHistory.avgFame),
        risk:
          warHistory.avgFame < 800
            ? "bad"
            : warHistory.avgFame < 1500
              ? "warn"
              : null,
      },
      { label: t("statBestWeek"), value: fmt(warHistory.maxFame) },
      {
        label: t("statWinRate"),
        value:
          warHistory.historicalWinRate !== null &&
          warHistory.historicalWinRate !== undefined
            ? `${Math.round(warHistory.historicalWinRate * 100)}%`
            : `${activityIndicators.winRate}%`,
        risk: (() => {
          const wr =
            warHistory.historicalWinRate !== null &&
            warHistory.historicalWinRate !== undefined
              ? Math.round(warHistory.historicalWinRate * 100)
              : activityIndicators.winRate;
          return wr < 30 ? "bad" : wr < 50 ? "warn" : null;
        })(),
      },
      {
        label: t("statBattlesPerDay"),
        value: fmt(battlesPerDay),
        risk: battlesPerDay < 2 ? "bad" : battlesPerDay < 4 ? "warn" : null,
      },
    ]);
  } else {
    // Fallback battlelog : répartition des 30 entrées par type
    const bd = activityIndicators?.battleLogBreakdown ?? {};
    const total =
      activityIndicators?.totalBattles ??
      activityIndicators?.totalWarBattles ??
      0;
    const gdc = bd.gdc || 0;
    const ratioPercent = total > 0 ? Math.round((gdc / total) * 100) : 0;
    const dailyActivity = recentActivity?.dailyActivity ?? [];
    const dailyTotal = dailyActivity.reduce(
      (sum, d) => sum + (d?.count ?? 0),
      0,
    );
    const dailyCount = dailyActivity.length > 0 ? dailyActivity.length : 7;
    const battlesPerDay =
      dailyCount > 0 ? Number((dailyTotal / dailyCount).toFixed(1)) : 0;

    statsGrid.innerHTML = statCards([
      {
        label: t("statTotalBattles"),
        value: fmt(total),
        risk: total < 10 ? "bad" : total < 20 ? "warn" : null,
      },
      {
        label: t("statBattlesPerDay"),
        value: fmt(battlesPerDay),
        risk: battlesPerDay < 2 ? "bad" : battlesPerDay < 4 ? "warn" : null,
      },
      {
        label: t("statRiverRaceRatio"),
        value: `${gdc}/${total} (${ratioPercent}%)`,
        risk: ratioPercent < 25 ? "bad" : ratioPercent < 50 ? "warn" : null,
      },
    ]);
  }

  // 3. Battle Log card for new arrivals or River Race chart for historical players
  const titleEl = document.getElementById("history-card-title");
  const noteEl = document.getElementById("api-limit-note");
  const battlelogSection = document.getElementById("battlelog-table-section");
  const battlelogDesc = document.getElementById("battlelog-description");

  const defaultCurrentWeekLabel =
    currentLang === "fr" ? "Semaine en cours" : "Current week";

  function isRiverRaceBattle(type) {
    const t = (type ?? "").toLowerCase();
    return [
      "riverracepvp",
      "riverraceduel",
      "riverraceduelscolosseum",
      "riverraceboat",
      "clanwarbattle",
    ].includes(t);
  }

  function formatBattleLogWeekLabel(timestamp) {
    // on ne peut pas déduire précisément la saison/section depuis battleTime seul,
    // donc on retourne un texte générique lisible.
    return "Semaine en cours";
  }

  function parseBattleTimestamp(value) {
    if (!value) return null;
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return d;
    // Try clash format fallback: 20240315T123456.000Z
    const m = /^(.{8}T.{6}\.\d{3}Z)$/.exec(value);
    if (m) {
      const iso = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T${value.slice(9, 11)}:${value.slice(11, 13)}:${value.slice(13, 15)}.${value.slice(16, 19)}Z`;
      const d2 = new Date(iso);
      if (!Number.isNaN(d2.getTime())) return d2;
    }
    return null;
  }

  function aggregateBattleLogByWeek(entries) {
    const map = new Map();
    entries.forEach((b) => {
      const clanName =
        b.team?.[0]?.clan?.name || b.team?.[0]?.clan?.tag || "No Clan";
      const clanTag = b.team?.[0]?.clan?.tag?.toLowerCase() || null;
      const isGdc = isRiverRaceBattle(b.type);
      const parsed = parseBattleTimestamp(
        b.battleTime ||
          b.battleTimeStamp ||
          b.battle_time ||
          b.battleTimeStampLocal,
      );
      const weekLabel = parsed
        ? formatBattleLogWeekLabel(parsed.toISOString())
        : "S?·W?";
      const key = `${weekLabel}::${clanName}`;

      if (!map.has(key)) {
        map.set(key, {
          week: weekLabel,
          clan: clanName,
          clanTag,
          gdc: 0,
          total: 0,
          firstBattleTime: parsed?.toISOString(),
        });
      }
      const entry = map.get(key);
      entry.total += 1;
      if (isGdc) entry.gdc += 1;

      if (parsed) {
        const existing = entry.firstBattleTime
          ? new Date(entry.firstBattleTime)
          : null;
        if (!existing || parsed < existing) {
          entry.firstBattleTime = parsed.toISOString();
        }
      }
    });

    return [...map.values()].sort((a, b) => {
      if (a.week === b.week) return a.clan.localeCompare(b.clan);
      return a.week.localeCompare(b.week);
    });
  }

  function buildRaceTimeHistogram(entries, resetUtcMinutes = 580) {
    const counts = Array(24).fill(0);
    let totalGdc = 0;

    entries.forEach((b) => {
      if (!isRiverRaceBattle(b.type)) return;
      const parsed = parseBattleTimestamp(
        b.battleTime ||
          b.battleTimeStamp ||
          b.battle_time ||
          b.battleTimeStampLocal,
      );
      if (!parsed || Number.isNaN(parsed.getTime())) return;

      const minutes = parsed.getUTCHours() * 60 + parsed.getUTCMinutes();
      const offset = (((minutes - resetUtcMinutes) % 1440) + 1440) % 1440;
      const bin = Math.floor(offset / 60);
      counts[bin] += 1;
      totalGdc += 1;
    });

    return { counts, totalGdc };
  }

  const battleLogSummary = aggregateBattleLogByWeek(battleLog);

  if (isBattleLogMode) {
    if (titleEl)
      titleEl.textContent =
        currentLang === "fr"
          ? "📅 Données Battle Log"
          : `📅 ${t("battleLogDataTitle")}`;
    if (noteEl) noteEl.textContent = t("battleLogDataDescription");

    const bd = activityIndicators.battleLogBreakdown ?? {};
    renderBattleLogBreakdownChart(bd);

    if (battlelogSection) battlelogSection.classList.remove("hidden");
    if (battlelogDesc) {
      battlelogDesc.textContent = t("battleLogDataTableDesc");
    }

    const currentClanName = overview.clan?.name || "No Clan";
    const currentClanTag = (overview.clan?.tag || "")
      .replace("#", "")
      .toLowerCase();

    const currentWarWeek = (warHistory?.weeks ?? []).find(
      (w) =>
        w.isCurrent &&
        (w.clanTag || "").replace("#", "").toLowerCase() === currentClanTag,
    );
    const currentWeekLabel =
      t("battleLogCurrentWeek") !== "battleLogCurrentWeek"
        ? t("battleLogCurrentWeek")
        : defaultCurrentWeekLabel;

    let rows = [];
    if (Array.isArray(warHistory?.weeks) && warHistory.weeks.length > 0) {
      let prevIndex = 0;
      rows = warHistory.weeks.map((w) => {
        const isCurrentRow = !!w.isCurrent;
        const weekIndex = isCurrentRow ? 0 : ++prevIndex;
        const clanName = w.clanName || w.clanTag || "No Clan";
        const gdcCount = Number(w.decksUsed) || 0;
        const weekLabel = isCurrentRow ? currentWeekLabel : w.label || `S?·W?`;

        return {
          week: weekLabel,
          clan: clanName,
          clanTag: w.clanTag || null,
          gdc: gdcCount,
          style:
            gdcCount === 0
              ? "empty-week"
              : gdcCount < 16
                ? "quasi-empty-week"
                : gdcCount > 16
                  ? "overfull-week"
                  : "",
          isCurrentClan: isCurrentRow,
          weekIndex,
        };
      });
    } else {
      const clansWeeks = new Map();
      (warHistory?.weeks ?? []).forEach((w) => {
        if (w.clanTag) {
          const normalizedTag = w.clanTag.replace("#", "").toLowerCase();
          if (!clansWeeks.has(normalizedTag)) {
            clansWeeks.set(normalizedTag, w.label);
          }
        }
      });

      rows = battleLogSummary.map((item) => {
        const normalizedItemClanTag = item.clanTag
          ? item.clanTag.replace("#", "").toLowerCase()
          : null;
        const normalizedItemClanName = item.clan.replace("#", "").toLowerCase();
        const itemWeekLabel =
          normalizedItemClanTag && clansWeeks.has(normalizedItemClanTag)
            ? clansWeeks.get(normalizedItemClanTag)
            : clansWeeks.has(normalizedItemClanName)
              ? clansWeeks.get(normalizedItemClanName)
              : "S?·W?";
        const isCurrentClan = item.clan === currentClanName;
        const weekLabel = isCurrentClan ? currentWeekLabel : itemWeekLabel;
        const gdcCount = Number(item.gdc) || 0;
        return {
          week: weekLabel,
          clan: item.clan,
          gdc: gdcCount,
          firstBattleTime: item.firstBattleTime,
          style:
            gdcCount === 0
              ? "empty-week"
              : gdcCount < 16
                ? "quasi-empty-week"
                : gdcCount > 16
                  ? "overfull-week"
                  : "",
          isCurrentClan,
        };
      });

      rows.sort((a, b) => {
        const aTime = a.firstBattleTime
          ? new Date(a.firstBattleTime).getTime()
          : 0;
        const bTime = b.firstBattleTime
          ? new Date(b.firstBattleTime).getTime()
          : 0;
        return bTime - aTime;
      });

      rows = rows.map((r, idx) => ({ ...r, weekIndex: idx + 1 }));
    }

    const sortedRows = rows.sort((a, b) => {
      if (a.isCurrentClan && !b.isCurrentClan) return -1;
      if (b.isCurrentClan && !a.isCurrentClan) return 1;
      return (a.weekIndex || 0) - (b.weekIndex || 0);
    });

    // Split any row with gdc > 16 into multiple weeks
    const expandedRows = [];
    let weekOffset = 0; // additional weeks inserted due overflow

    sortedRows.forEach((row) => {
      const adjustedWeekIndex = (row.weekIndex ?? 0) + weekOffset;
      const rowClone = { ...row, weekIndex: adjustedWeekIndex };

      let remaining = Number(rowClone.gdc) || 0;
      if (remaining <= 16) {
        expandedRows.push({ ...rowClone, gdc: remaining });
        return;
      }

      // first week capped
      expandedRows.push({ ...rowClone, gdc: 16, style: rowClone.style || "" });
      remaining -= 16;
      weekOffset += 1;

      // subsequent weeks from overflow
      while (remaining > 0) {
        const overflowValue = Math.min(16, remaining);
        expandedRows.push({
          weekIndex: adjustedWeekIndex + weekOffset,
          clan: rowClone.clan,
          gdc: overflowValue,
          style: "overfull-week",
          isCurrentClan: false,
        });
        remaining -= overflowValue;
        if (remaining > 0) weekOffset += 1;
      }
    });

    const finalRows = expandedRows.length
      ? expandedRows
      : [
          {
            week: currentWeekLabel,
            clan: currentClanName,
            gdc: 0,
            style: "empty-week",
          },
        ];

    const tbody = document.getElementById("battlelog-table-body");
    if (tbody) {
      tbody.innerHTML = finalRows
        .map((r, idx) => {
          const rawGdc = Number(r.gdc) || 0;
          const weekLabel = r.week || currentWeekLabel;
          let badge = rawGdc === 0 ? "❌" : rawGdc < 16 ? "⚠️" : "✅";
          if (r.isCurrentClan) {
            badge = "";
          } else if (idx === finalRows.length - 1) {
            badge = "❓";
          }
          const extraNote = rawGdc > 16 ? ` (+${rawGdc - 16})` : "";

          // Lien vers la page Clan réduite si le tag est disponible
          const clanCell = r.clanTag
            ? `<a class="battlelog-clan-link" href="${getBasePath()}/?${new URLSearchParams({ mode: "clan", tag: r.clanTag.startsWith("#") ? r.clanTag : "#" + r.clanTag })}">${escHtml(r.clan)}</a>`
            : escHtml(r.clan);

          return `
          <tr class="${r.style}${r.isCurrentClan ? " current-week" : ""}">
            <td>${weekLabel}</td>
            <td>${clanCell}</td>
            <td>${rawGdc}${extraNote}${badge ? " " + badge : ""}</td>
          </tr>
        `;
        })
        .join("");
    }

    const noDataNote = document.getElementById("battlelog-no-data-note");
    const hasNoFurtherData =
      warHistory?.noFurtherData === true ||
      (isBattleLogMode &&
        (warHistory?.weeks?.length || 0) === 1 &&
        warHistory?.weeks?.[0]?.isCurrent);
    if (noDataNote) {
      noDataNote.textContent = hasNoFurtherData
        ? t("battleLogNoFurtherData")
        : "";
      noDataNote.classList.toggle("hidden", !hasNoFurtherData);
    }
  } else {
    if (battlelogSection) battlelogSection.classList.add("hidden");

    if (warHistory) {
      if (warHistory.weeks.length > 0) {
        if (titleEl)
          titleEl.textContent = t("riverRaceHistoryTitle", {
            count: warHistory.weeks.length,
          });
        renderWarHistoryChart(warHistory.weeks);
        if (noteEl) {
          let note = t("riverRaceHistoryNote", {
            count: warHistory.weeks.length,
            avgFame: fmt(warHistory.avgFame),
          });
          if (warHistory.weeks.some((w) => w.ignored)) {
            note += ` ${t("riverRaceHistoryIgnored")}`;
          }
          noteEl.textContent = note;
        }
      } else {
        const bd = activityIndicators.battleLogBreakdown ?? {};
        const parts = [
          bd.gdc != null
            ? `${activityIndicators.totalWarBattles} ${t("statWarBattles")}`
            : null,
          bd.ladder != null ? `${bd.ladder} ${t("statLadder")}` : null,
          bd.challenge != null
            ? `${bd.challenge} ${t("statChallenges")}`
            : null,
          bd.friendly != null && bd.friendly > 0
            ? `${bd.friendly} ${t("friendly") || "Friendly"}`
            : null,
        ]
          .filter(Boolean)
          .join(" · ");
        if (titleEl) titleEl.textContent = t("noRiverRaceHistoryTitle");
        renderWarHistoryChart([]);
        if (noteEl)
          noteEl.innerHTML =
            `<span>⚠️ ${t("noRiverRaceHistoryNote1")} ` +
            `${t("apiLogEntries", { count: bd.total ?? 30 })}: ${parts || t("noData")}.</span>` +
            `<details class="note-disclosure">` +
            `<summary>${t("noRiverRaceHistoryWhySummary")}</summary>` +
            `<p>${t("noRiverRaceHistoryWhyDetail")}</p>` +
            `</details>`;
      }
    } else {
      const bd = activityIndicators.battleLogBreakdown ?? {};
      const parts = [
        bd.gdc != null
          ? `${activityIndicators.totalWarBattles} ${t("statWarBattles")}`
          : null,
        bd.ladder != null ? `${bd.ladder} ${t("statLadder")}` : null,
        bd.challenge != null ? `${bd.challenge} ${t("statChallenges")}` : null,
        bd.friendly != null && bd.friendly > 0
          ? `${bd.friendly} ${t("friendly") || "Friendly"}`
          : null,
      ]
        .filter(Boolean)
        .join(" · ");
      if (titleEl) titleEl.textContent = t("clanWarActivityTitle");
      renderActivityChart(recentActivity.dailyActivity);
      if (noteEl)
        noteEl.textContent =
          `⚠️ ${t("noClanWarHistoryWarning")} ` +
          `${t("apiLogEntries", { count: bd.total ?? 30 })}: ${parts || t("noData")}.`;
    }
  }

  // 3c. River Race Time card (BattleLog MVP)
  const cardRaceTime = document.getElementById("card-race-time");
  const raceTimeNote = document.getElementById("race-time-note");
  const raceTimeChartWrapper = cardRaceTime
    ? cardRaceTime.querySelector(".chart-wrapper")
    : null;
  const showRaceTimeGraph = !!(warHistory?.totalWeeks >= 2);

  if (showRaceTimeGraph) {
    // Reset UTC en minutes selon le clan du joueur (ex. Y8JUPC9C → 590, autres → 580)
    const CLAN_RESETS_UTC = { Y8JUPC9C: 590 };
    const cleanClanTag = (clanTag || "").replace("#", "").toUpperCase();
    const resetUtcMinutes = CLAN_RESETS_UTC[cleanClanTag] ?? 580;
    const { counts, totalGdc } = buildRaceTimeHistogram(
      battleLog || [],
      resetUtcMinutes,
    );
    if (cardRaceTime) {
      cardRaceTime.classList.remove("hidden");
      const cardTitle = cardRaceTime.querySelector(".card-title");
      if (cardTitle) cardTitle.textContent = t("raceTimeTitle");
    }

    const rawLateBucketWarning = t("raceTimeLateBucketWarning");
    const defaultLateBucketWarning =
      currentLang === "fr"
        ? " ⚠️ risque (dernier créneau)"
        : " ⚠️ risk (last bucket)";
    const lateBucketWarning =
      rawLateBucketWarning &&
      rawLateBucketWarning !== "raceTimeLateBucketWarning"
        ? rawLateBucketWarning
        : defaultLateBucketWarning;

    if (totalGdc > 0) {
      if (raceTimeNote) raceTimeNote.textContent = t("raceTimeDesc");
      if (raceTimeChartWrapper) raceTimeChartWrapper.classList.remove("hidden");
      renderRaceTimeChart(counts, lateBucketWarning, resetUtcMinutes);
    } else {
      if (raceTimeNote) raceTimeNote.textContent = t("raceTimeNoGdc");
      destroyIfExists("chart-race-time");
      if (raceTimeChartWrapper) raceTimeChartWrapper.classList.add("hidden");
    }
  } else {
    if (cardRaceTime) cardRaceTime.classList.add("hidden");
    if (raceTimeNote) raceTimeNote.textContent = t("raceTimeNoHistory");
  }

  // 3b. Actual Clan War (visible jeudi–dimanche)
  const isFamilyWarPlayer = Boolean(
    overview.clan?.tag && CLAN_OPTIONS.some((o) => o.tag === overview.clan.tag),
  );

  renderCurrentWarCard(
    data.currentWarDays,
    data.warSnapshotDays,
    data.warCurrentWeekId,
    data.warSnapshotTakenAt,
    data.warResetUtcMinutes,
    data.decksYesterdayAtThisHour ?? null,
    isFamilyWarPlayer,
  );

  // 4. War Reliability Score avec breakdown
  // gauge supprimé — plus de canvas chart-gauge dans le DOM

  const icon =
    { green: "✅", yellow: "⚠️", orange: "🟠", red: "🔴" }[ws.color] ?? "❓";
  const verdictMap = {
    "High reliability": t("highReliability"),
    "Moderate risk": t("moderateRisk"),
    "High risk": t("highRisk"),
    "Extreme risk": t("extremeRisk"),
  };
  const verdictText = verdictMap[ws.verdict] || ws.verdict;
  ws.verdict = verdictText; // override to use translation everywhere

  const fallbackBadge = ws.isFallback
    ? `<div class="fallback-badge">⚠️ ${t("fallbackBadge")}</div>`
    : "";

  verdictBox.innerHTML = `
    <div class="verdict-box ${ws.color}">
      <div class="verdict-icon">${icon}</div>
      <div class="verdict-text-wrap">
        <div class="verdict-score">${ws.pct}%<span class="verdict-score-detail"> (${ws.total} / ${ws.maxScore} pts)</span></div>
        <div class="verdict-text">${verdictText}</div>
      </div>
    </div>
    ${fallbackBadge}
  `;

  const scoreLabelMap = getScoreLabelMap();

  function translateDetail(label, text) {
    if (!text) return text;
    if (currentLang !== "fr") return text;

    // Generic phrase-level FR translation when the source detail is still in English.
    let normalized = text
      .replace(/decks across/gi, "decks sur")
      .replace(/incomplete weeks?/gi, (m) =>
        m.toLowerCase().startsWith("incomplete")
          ? m.replace(/incomplete/i, "incomplète")
          : m,
      )
      .replace(
        /member for\s*(\d+)\s*weeks?/i,
        (_, n) =>
          `membre depuis ${n} ${Number(n) > 1 ? "semaines" : "semaine"}`,
      )
      .replace(
        /([0-9.,]+)\s*weeks?/gi,
        (_, n) => `${n} ${Number(n) > 1 ? "semaines" : "semaine"}`,
      )
      .replace(
        /consecutive weeks in this clan/gi,
        "semaines consécutives dans le clan",
      )
      .replace(
        /points \/ week \(average weekly fame, 1,000–3,000\)/gi,
        "points / semaine (gloire hebdomadaire moyenne, 1 000–3 000)",
      )
      .replace(/fame \/ week \(cap 3,000\)/gi, t("avgFameCap"))
      .replace(
        /in recent\s+(\d+)-day window:/gi,
        (_, n) => `Sur les ${n} derniers jours :`,
      )
      .replace(
        /(\d+)\s*full days?/gi,
        (_, n) => `${n} ${Number(n) > 1 ? "jours complets" : "jour complet"}`,
      )
      .replace(
        /(\d+)\s*short days?/gi,
        (_, n) => `${n} ${Number(n) > 1 ? "jours courts" : "jour court"}`,
      )
      .replace(
        /(\d+)\s*inactive days?/gi,
        (_, n) => `${n} ${Number(n) > 1 ? "jours inactifs" : "jour inactif"}`,
      )
      .replace(/last war: (\d{4}-\d{2}-\d{2})/gi, "dernière guerre : $1")
      .replace(
        /\((\d+) day\(s\) ago\)/gi,
        (_, n) => `(il y a ${n} ${Number(n) > 1 ? "jours" : "jour"})`,
      )
      .replace(/competitive battles/gi, "combats compétitifs")
      .replace(/([0-9]+)\s*War/gi, "$1 Guerre")
      .replace(/([0-9]+)\s*Challenges/gi, "$1 Défis")
      .replace(
        /(\d+)% wins \((\d+)W \/ (\d+)L\)/gi,
        "$1% victoires ($2W / $3L)",
      )
      .replace(
        /not counted \(10 battles required\)/gi,
        "non compté (10 combats requis)",
      )
      .replace(
        /No data — no war battles found/gi,
        "Aucune donnée — aucun combat de guerre trouvé",
      )
      .replace(/total cw2 wins \(cap 250\)/gi, t("cw2BattleWinsCap"))
      .replace(/victories in river race/gi, "victoires en River Race")
      .replace(/trophies \(range 4000–14000\)/gi, "trophées (plage 4000–14000)")
      .replace(/trophies/gi, "trophées")
      .replace(/battles required/gi, "combats requis")
      .replace(
        /total cards donated \(cap 100000\)/gi,
        "cartes totales données (cap 100000)",
      );

    if (normalized !== text) {
      text = normalized;
    }

    const lowercaseLabel = label.toLowerCase();
    if (
      lowercaseLabel.includes("regularity") ||
      lowercaseLabel.includes("régularité")
    ) {
      return text;
    }
    if (lowercaseLabel.includes("avg")) {
      return text;
    }
    if (lowercaseLabel.includes("cw2")) {
      return text;
    }
    if (
      lowercaseLabel.includes("stability") ||
      lowercaseLabel.includes("stabilité")
    ) {
      return text;
    }
    if (
      lowercaseLabel.includes("last seen") ||
      lowercaseLabel.includes("dernière connexion")
    ) {
      return text
        .replace(/today/i, t("today"))
        .replace(/1 day/i, t("oneDayAgo"))
        .replace(/(\d+) days?/i, (_, n) => `${n} ${t("days")}`);
    }
    if (lowercaseLabel.includes("win rate")) {
      return text;
    }
    if (
      lowercaseLabel.includes("experience") ||
      lowercaseLabel.includes("expérience")
    ) {
      return text;
    }
    if (
      lowercaseLabel.includes("donations") ||
      lowercaseLabel.includes("dons")
    ) {
      return text;
    }
    if (lowercaseLabel.includes("discord")) {
      return text
        .replace(
          "Discord account linked to the server",
          "Compte Discord lié au serveur",
        )
        .replace(
          "Discord account not linked (/discord-link)",
          "Compte Discord non lié (/discord-link)",
        );
    }
    return text;
  }
  reasonsList.innerHTML = (ws.breakdown ?? [])
    .map((b) => {
      const labelText = scoreLabelMap[b.label] || b.label;
      const detailText = translateDetail(b.label, b.detail);
      if (b.excluded) {
        return `
      <li class="score-row score-row-excluded">
        <div class="sr-header">
          <span class="sr-label">${escHtml(labelText)}</span>
          <span class="sr-excluded-badge">${t("notCounted") || "not counted"}</span>
        </div>
        <div class="sr-bar-bg"></div>
        <div class="sr-detail">${escHtml(detailText)}</div>
        ${b.explanation ? `<div class="sr-explanation">${escHtml(b.explanation)}</div>` : ""}
      </li>`;
      }
      const pct = Math.round((b.score / b.max) * 100);
      const color =
        pct >= 75
          ? "var(--green)"
          : pct >= 56
            ? "var(--yellow)"
            : pct >= 31
              ? "var(--orange)"
              : "var(--red)";
      const label =
        b.label === "Discord"
          ? `${t("discord")} (${b.score > 0 ? t("yes") : t("no")})`
          : escHtml(b.label);
      return `
      <li class="score-row">
        <div class="sr-header">
          <span class="sr-label">${escHtml(labelText)}</span>
          <span class="sr-score-val">${b.score}<span class="sr-max"> / ${b.max}</span></span>
        </div>
        <div class="sr-bar-bg">
          <div class="sr-bar-fill" style="width:${pct}%;background:${color}"></div>
        </div>
        <div class="sr-detail">${escHtml(detailText)}</div>
        ${b.explanation ? `<div class="sr-explanation">${escHtml(b.explanation)}</div>` : ""}
      </li>`;
    })
    .join("");

  // Ensure any rendered labels are updated after player content is rendered
  translateUI();
  updateLangButtonUI();
  playerResults.classList.remove("hidden");
}

// ── Actual Clan War card (player view) ────────────────────────────

const DAY_NAMES = [
  t("dayThu") || "Thu",
  t("dayFri") || "Fri",
  t("daySat") || "Sat",
  t("daySun") || "Sun",
];

function renderCurrentWarCard(
  warData,
  warSnapshotDays = null,
  weekId = null,
  snapshotTakenAt = null,
  warResetUtcMinutes = null,
  decksYesterdayAtThisHour = null,
  showWarDayDetails = true,
) {
  if (!warData) {
    cardCurrentWar.classList.add("hidden");
    return;
  }
  cardCurrentWar.classList.remove("hidden");

  const weekLabel = weekId
    ? ` <span class="card-week-id">(${weekId.toLowerCase()})</span>`
    : "";
  cardCurrentWar.querySelector(".card-title").innerHTML =
    `⚔️ ${t("currentClanWar")} ${weekLabel}`;

  const showDetails = showWarDayDetails === true;

  // If we have snapshot data, prefer it for totals/daily counts (because battle log can be incomplete).
  const snapDays = Array.isArray(warSnapshotDays) ? warSnapshotDays : null;
  const snapHasData =
    snapDays && snapDays.some((v) => v !== null && v !== undefined);

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

  const pctFill = Math.min(
    100,
    Math.round((totalDecksUsed / computedMaxElapsed) * 100),
  );

  // Special case: player joined mid-war
  if (arrivedMidWar) {
    const arrivalDayName =
      DAY_NAMES[(arrivedOnDay ?? 1) - 1] ?? `day ${arrivedOnDay}`;
    const chipsHtml = days
      .map((d) => {
        const cls = d.isFuture ? "future" : d.isToday ? "today" : "past";
        const icon = d.isFuture ? "—" : d.isToday ? "▶" : "✔";
        return `<span class="war-day-chip ${cls}">${translateWarDayLabel(d.label)} ${icon}</span>`;
      })
      .join("");
    warDaysGrid.innerHTML =
      `<div class="war-summary">` +
      `<div class="war-progress-row">` +
      `<span class="war-decks-count">0 <span class="war-decks-max">/ ${computedMaxWeek}</span></span>` +
      `<span class="war-decks-label">${t("warDecksThisWeek") || "decks this week"}</span>` +
      `<span class="war-data-source arrived">${t("warArrived") || "Arrived"} ${arrivalDayName} ⚠️</span>` +
      `</div>` +
      `<div class="war-progress-track"><div class="war-progress-fill bad" style="width:0%"></div></div>` +
      `<div class="war-progress-meta war-arrived-note">` +
      `${t("warJoinedDuringWeekNote") || "Joined during the war week — can't count battles this week"}` +
      `</div>` +
      `<div class="war-day-chips">${chipsHtml}</div>` +
      `</div>`;
    return;
  }

  const snapshotTakenAtLabel = snapshotTakenAt
    ? ` (snapshot ${new Date(snapshotTakenAt).toISOString().slice(11, 16)} UTC)`
    : "";

  // Status based on expected vs actual decks
  let statusIcon, statusText, statusCls;
  if (totalDecksUsed >= computedMaxElapsed) {
    statusIcon = "✅";
    statusText = t("warStatusOnTrack") || "On track";
    statusCls = "good";
  } else if (totalDecksUsed >= Math.ceil(computedMaxElapsed / 2)) {
    statusIcon = "⚠️";
    statusText = t("warStatusBehindSchedule") || "Behind schedule";
    statusCls = "partial";
  } else {
    statusIcon = "🔴";
    statusText = t("warStatusVeryBehind") || "Very behind";
    statusCls = "bad";
  }

  const snapshotMismatch =
    snapHasData &&
    days.some((d, i) => {
      const snap = snapDays?.[i];
      return snap != null && snap !== d.count;
    });

  const sourceNote = snapHasData
    ? `<span class="war-data-source reliable">Snapshot ✓${snapshotTakenAtLabel}${snapshotMismatch ? " ⚠️" : ""}</span>`
    : isReliableTotal
      ? '<span class="war-data-source reliable">Race log ✓</span>'
      : '<span class="war-data-source fallback">Battle log (approx.)</span>';

  const sourceHint = t("sourceHint");
  // Unique message : use the single snapshot note translation key.
  let snapshotWarning = t("clanWarSnapshotNote");
  if (snapshotWarning === "clanWarSnapshotNote") {
    snapshotWarning =
      currentLang === "fr"
        ? "Les snapshots sont réalisés chaque heure ; les decks joués à la dernière minute peuvent être comptés sur le jour précédent."
        : "Snapshots are taken every hour; decks played at the last minute may be assigned to the previous day.";
  }

  const snapshotDataInvalid = days.some((d) => d.isPast && d.totalCount === 0);

  const chipsHtml = days
    .map((d, i) => {
      const cls = d.isFuture ? "future" : d.isToday ? "today" : "past";
      const icon = d.isFuture ? " —" : d.isToday ? " ▶" : "";

      const snapshotVal = snapDays?.[i];
      const liveVal = d.liveCount ?? null;
      let battleVal;
      let daySource;

      if (d.source === "live") {
        battleVal = d.count;
        daySource = "live";
      } else if (snapshotVal != null) {
        battleVal = snapshotVal;
        daySource = "snapshot";
      } else {
        battleVal = d.count;
        daySource = d.source || "fallback";
      }

      let label = d.label;
      let snap = "";

      if (daySource === "live") {
        const note = `[live ${liveVal ?? d.count}/4]`;
        snap = ` <span class="chip-snap chip-snap-live">${battleVal}/4 ${note}</span>`;
      } else if (daySource === "snapshot") {
        const warn = battleVal < 4 ? " ⚠️" : "";
        const snapCls =
          battleVal <= 1
            ? "chip-snap chip-snap-red"
            : battleVal <= 3
              ? "chip-snap chip-snap-orange"
              : "chip-snap";
        const note = battleVal !== d.count ? ` (snap ${battleVal}/4)` : "";
        snap = ` <span class="${snapCls}">${battleVal}/4${warn}${note}</span>`;
      } else {
        // no snapshot: mark as missing rather than guessing based on incomplete log
        label += " (no data)";
        snap = ` <span class="chip-snap chip-snap-fallback">${battleVal}/4</span>`;
      }

      return `<span class="war-day-chip ${cls}">${translateWarDayLabel(label)}${icon}${snap}</span>`;
    })
    .join("");

  const sourceNoteHtml = showDetails ? sourceNote : "";
  const progressNoteHtml = showDetails
    ? `<div class="war-progress-note">⚠ ${snapshotWarning}</div>`
    : "";
  const sourceHintHtml = showDetails
    ? `<div class="war-progress-source">${sourceHint}</div>`
    : "";
  const dayChipsHtml = showDetails
    ? `<div class="war-day-chips">${chipsHtml}</div>`
    : "";

  warDaysGrid.innerHTML =
    `<div class="war-summary">` +
    `<div class="war-progress-row">` +
    `<span class="war-decks-count">${totalDecksUsed} <span class="war-decks-max">/ ${computedMaxElapsed}</span></span>` +
    `<span class="war-decks-label">${t("warDecksSoFar") || "decks so far"} ${getRemainingTimeHtml(warResetUtcMinutes)}</span>` +
    sourceNoteHtml +
    `</div>` +
    `<div class="war-progress-track">` +
    `<div class="war-progress-fill ${statusCls}" style="width:${pctFill}%"></div>` +
    `</div>` +
    `<div class="war-progress-meta">` +
    `${t("warProgressDayOf", { day: dayNum, total: 4 })}` +
    `</div>` +
    `${daysFromThu > 0 && decksYesterdayAtThisHour != null ? `<div class="war-yesterday-hint">${t("warDecksYesterdayHour").replace("{{decks}}", decksYesterdayAtThisHour)}</div>` : ""}` +
    `${progressNoteHtml}` +
    `${showDetails && snapshotDataInvalid ? `<div class="war-progress-warning">⚠ ${t("warSnapshotDataInvalid")}</div>` : ""}` +
    `${sourceHintHtml}` +
    `${dayChipsHtml}` +
    `</div>`;
}

// ── Clan war mini-colonne (clan table) ───────────────────────────────

function warMiniBarHtml(warData) {
  if (!warData) return '<span class="war-mini-na">—</span>';
  const {
    totalDecksUsed,
    maxDecksWeek,
    maxDecksElapsed,
    arrivedMidWar,
    arrivedOnDay,
  } = warData;

  const pct = Math.round((totalDecksUsed / maxDecksWeek) * 100);
  const cls =
    totalDecksUsed >= maxDecksElapsed
      ? "good"
      : totalDecksUsed >= Math.ceil(maxDecksElapsed / 2)
        ? "partial"
        : "bad";

  let title = `${totalDecksUsed}/${maxDecksElapsed} decks`;
  if (arrivedMidWar) {
    const dayName = DAY_NAMES[(arrivedOnDay ?? 1) - 1] ?? `day ${arrivedOnDay}`;
    title += ` — ${t("warArrived") || "Arrived"} ${dayName}`;
  }

  return (
    `<div class="war-mini-total" title="${title}">` +
    `<div class="war-mini-track"><div class="war-mini-fill ${cls}" style="width:${pct}%"></div></div>` +
    `<span class="war-mini-text ${cls}">${totalDecksUsed}/${maxDecksElapsed}</span>` +
    `</div>`
  );
}
// ── Clan lite : performances dernière guerre ──────────────────

function renderClanLiteBest(lastWarBest, members, prevWeekId = null) {
  const card = document.getElementById("card-top-players");
  const listEl = document.getElementById("top-players-list");
  if (!card) return;

  const weekLabel = prevWeekId
    ? ` <span class="card-week-id">(${prevWeekId.toUpperCase()})</span>`
    : "";
  card.querySelector(".card-title").innerHTML =
    `🏅 ${t("lastWarBest")}${weekLabel}`;
  card.querySelector(".card-desc").textContent = t("lastWarBestDesc") || "";

  if (!Array.isArray(lastWarBest) || lastWarBest.length === 0) {
    card.classList.add("hidden");
    return;
  }

  const memberByTag = (members || []).reduce((acc, m) => {
    if (m?.tag) acc[m.tag] = m;
    return acc;
  }, {});

  card.classList.remove("hidden");

  if (listEl) {
    listEl.innerHTML = lastWarBest
      .map((p) => {
        const member = memberByTag[p.tag] || {};
        const role = member.role ? capitalize(member.role) : null;
        return (
          `<li class="lite-best-list-item">` +
          `<span class="lite-best-name">` +
          `${escHtml(p.name)} <span class="lite-best-tag">${escHtml(p.tag)}</span>` +
          `${role ? ` <span class="role-badge ${member.role}">${role}</span>` : ""}` +
          `</span>` +
          `<span class="lite-best-fame">${fmt(p.fame)} ${t("clanLiteLastWarFame")}</span>` +
          `</li>`
        );
      })
      .join("");
  }
}

// ── Top players card renderer ─────────────────────────────────

function renderTopPlayersCard(topPlayers, prevWeekId = null) {
  const card = document.getElementById("card-top-players");
  const listEl = document.getElementById("top-players-list");
  const weekLabel = prevWeekId
    ? ` <span class="card-week-id">(${prevWeekId.toUpperCase()})</span>`
    : "";
  card.querySelector(".card-title").innerHTML =
    `🏅 ${t("lastWarBest")}${weekLabel}`;
  card.querySelector(".card-desc").textContent = t("lastWarBestDesc") || "";

  if (!topPlayers || !topPlayers.playersByQuota) {
    card.classList.remove("hidden");
    if (listEl) {
      listEl.innerHTML = `<li class="text-muted">${t("clickToLoadTopPlayers") || "Open the section to load data on demand."}</li>`;
    }
    return;
  }

  card.classList.remove("hidden");
  loadedClanSections.topPlayers = true;

  const threshold = "2600";
  let players = topPlayers.playersByQuota[threshold] || [];
  players = players.slice().sort((a, b) => b.fame - a.fame);

  if (players.length === 0) {
    listEl.innerHTML = `<li class="text-muted">${t("noPlayersReachedQuota")}</li>`;
  } else {
    listEl.innerHTML = players
      .map(
        (p) =>
          `<li>` +
          `<span class="tp-name">${escHtml(p.name)} ` +
          `<span class="tp-tag">${escHtml(p.tag)}</span>` +
          `</span>` +
          `<span class="tp-meta">` +
          `<span class="role-badge ${p.role}">${capitalize(p.role)}</span>` +
          `<span class="tp-fame">${fmt(p.fame)} pts</span>` +
          `</span>` +
          `</li>`,
      )
      .join("");
  }
}

// ── Uncomplete decks card renderer ───────────────────────────

function renderUncompleteCard(uncomplete, prevWeekId = null) {
  const card = document.getElementById("card-uncomplete");
  const listEl = document.getElementById("uncomplete-list");
  const weekLabel = prevWeekId
    ? ` <span class="card-week-id">(${prevWeekId.toUpperCase()})</span>`
    : "";
  card.querySelector(".card-title").innerHTML =
    `🤷 ${t("lastWarFails")}${weekLabel}`;

  if (!uncomplete || !Array.isArray(uncomplete.players)) {
    card.classList.remove("hidden");
    if (listEl) {
      listEl.innerHTML = `<li class="text-muted">${t("clickToLoadUncomplete") || "Open the section to load data on demand."}</li>`;
    }
    return;
  }

  card.classList.remove("hidden");
  loadedClanSections.uncomplete = true;
  const players = uncomplete.players.slice().sort((a, b) => a.decks - b.decks);

  // show a global warning if any player is still using warlog data (not snapshot)
  // or if snapshots do not cover all 4 GDC days.
  const missingDays = uncomplete.snapshotComplete === false;
  const mismatchedDays = players.some((p) => p.dailyMismatch === true);
  const needWarning =
    missingDays ||
    mismatchedDays ||
    players.some(
      (p) =>
        p.dailySource !== "snapshot" ||
        (p.dailySource === "snapshot" && !p.dailySnapshotComplete),
    );
  const existing = card.querySelector(".uncomplete-warning");
  if (needWarning) {
    if (!existing) {
      const desc = card.querySelector(".card-desc");
      const html =
        '<div class="uncomplete-warning">⚠ Some GDC data has not yet been collected</div>';
      if (desc) {
        desc.insertAdjacentHTML("afterend", html);
      } else {
        card.insertAdjacentHTML("afterbegin", html);
      }
    }
  } else if (existing) {
    existing.remove();
  }

  function formatDaily(counts) {
    if (!counts) return "";
    if (Array.isArray(counts)) {
      const labels = ["thu", "fri", "sat", "sun"];
      const parts = [];
      for (let i = 0; i < labels.length; i += 1) {
        const val = counts[i];
        if (val == null) {
          // missing snapshot (we don't know if the player played or not)
          parts.push(`<span class="daily-missing">❓× ${labels[i]}</span>`);
          continue;
        }
        const cls =
          val >= 4 ? "daily-green" : val >= 3 ? "daily-orange" : "daily-red";
        parts.push(`<span class="${cls}">${val}× ${labels[i]}</span>`);
      }
      return parts.join(" - ");
    }
    const keys = Object.keys(counts).sort();
    const entries = keys
      .map((k) => ({ k, num: counts[k] }))
      .filter((e) => e.num > 0);
    if (entries.length === 0) return "";
    const n = entries.length;
    const labels = ["Thu", "Fri", "Sat", "Sun"].slice(-n);
    return entries
      .map((e, i) => {
        const num = e.num;
        const cls =
          num >= 4 ? "daily-green" : num >= 3 ? "daily-orange" : "daily-red";
        return `<span class="${cls}">${num}× ${labels[i].toLowerCase()}</span>`;
      })
      .join(" - ");
  }

  // Supprimer l'éventuelle section "partis" précédente pour éviter les doublons
  const existingDeparted = card.querySelector(".uncomplete-departed");
  if (existingDeparted) existingDeparted.remove();

  function formatDailyTooltip(counts) {
    if (!counts || !Array.isArray(counts)) return "";
    const labels = ["thu", "fri", "sat", "sun"];
    return counts
      .map((val, i) =>
        val == null ? `?× ${labels[i]}` : `${val}× ${labels[i]}`,
      )
      .join(" - ");
  }

  function renderPlayerItem(p) {
    const dailyStr = formatDaily(p.daily);
    const dailyPlain = formatDailyTooltip(p.daily);
    const mismatchText = p.dailyMismatch ? "⚠ snapshot mismatch" : "";
    const tooltipText = [dailyPlain || "no daily data", mismatchText]
      .filter(Boolean)
      .join(" · ");

    const newBadge = p.isNew ? '<span class="new-badge">new</span>' : "";

    const dailyBadge = `<span class="daily-tooltip" title="${escHtml(tooltipText)}">📅</span>`;

    return (
      `<li><span class="tp-name">${escHtml(p.name)} ` +
      `<span class="tp-tag">${escHtml(p.tag)}</span>${newBadge}</span>` +
      `<span class="tp-meta">` +
      `<span class="role-badge ${p.role}">${capitalize(p.role)}</span>` +
      `<span class="tp-fame">${fmt(p.decks)} decks ${dailyBadge}</span>` +
      `</span></li>`
    );
  }

  const present = players.filter((p) => p.inClan);
  const departed = players.filter((p) => !p.inClan);

  if (present.length === 0 && departed.length === 0) {
    listEl.innerHTML = `<li class="text-muted">${t("everyoneCompleted16")}</li>`;
  } else {
    listEl.innerHTML =
      present.length > 0
        ? present.map(renderPlayerItem).join("")
        : `<li class="text-muted">${t("everyoneInClanCompleted16")}</li>`;
  }

  card.classList.remove("hidden");
}

// ── Clan war card (vue clan) ──────────────────────────────────────────

function mergeWarSummaries(clanWarSummary, lastWarSummary) {
  if (!clanWarSummary) return lastWarSummary || null;
  if (!lastWarSummary) return clanWarSummary;

  const days = (clanWarSummary.days ?? []).map((day, idx) => {
    if (!day || typeof day !== "object") return day;

    const backupDay = (lastWarSummary.days ?? [])[idx] ?? null;
    const hasDayValue = day.totalCount != null && day.totalCount > 0;
    const backupValue = backupDay?.totalCount ?? null;

    if (!hasDayValue && backupValue != null && backupValue > 0 && day.isPast) {
      return {
        ...day,
        totalCount: backupValue,
        snapshotCount: backupValue,
        source: "snapshot",
      };
    }
    return day;
  });

  const totalDecksUsed = days.reduce((sum, d) => sum + (d?.totalCount ?? 0), 0);

  return {
    ...clanWarSummary,
    totalDecksUsed,
    days,
    snapshotWarnings:
      clanWarSummary.snapshotWarnings || lastWarSummary.snapshotWarnings || [],
  };
}

function getRemainingTimeHtml(resetUtcMinutes) {
  if (resetUtcMinutes == null) return "";
  const now = new Date();
  const nowUtcMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  let diff = resetUtcMinutes - nowUtcMinutes;

  // Si le reset de la journée est déjà passé, on parle du reset de demain
  if (diff <= 0) diff += 1440;

  const h = Math.floor(diff / 60);
  const m = diff % 60;
  const timeStr = `${h}h${m.toString().padStart(2, "0")}`;

  return `<span class="war-time-remaining">${t("warDayRemaining").replace("{{time}}", timeStr)}</span>`;
}

function translateWarDayLabel(label) {
  switch ((label || "").toLowerCase()) {
    case "thu":
    case "thursday":
      return t("dayThu") || "Thu";
    case "fri":
    case "friday":
      return t("dayFri") || "Fri";
    case "sat":
    case "saturday":
      return t("daySat") || "Sat";
    case "sun":
    case "sunday":
      return t("daySun") || "Sun";
    default:
      return label || "";
  }
}

function renderClanWarCard(clanWarSummary, warResetUtcMinutes = null) {
  const card = document.getElementById("card-clan-war");
  if (!clanWarSummary || clanWarSummary.ended) {
    card.classList.add("hidden");
    return;
  }
  card.classList.remove("hidden");

  const {
    totalDecksUsed,
    maxDecksElapsed,
    maxDecksWeek,
    participantCount,
    daysFromThu,
    days,
    weekId,
    ended,
  } = clanWarSummary;
  const weekLabel = weekId
    ? ` <span class="card-week-id">(${weekId.toLowerCase()})</span>`
    : "";
  const endedLabel = ended ? t("warEndedSuffix") || " (ended)" : "";
  card.querySelector(".card-title").innerHTML =
    `⚔️ ${t("currentClanWar")}${weekLabel}${endedLabel}`;
  const dayNum = ended ? 4 : daysFromThu + 1;
  const pctFill = Math.min(
    100,
    Math.round((totalDecksUsed / maxDecksElapsed) * 100),
  );

  let statusIcon, statusText, statusCls;
  if (totalDecksUsed >= maxDecksElapsed) {
    statusIcon = "✅";
    statusText = t("warStatusOnTrack") || "On track";
    statusCls = "good";
  } else if (totalDecksUsed >= Math.ceil(maxDecksElapsed / 2)) {
    statusIcon = "⚠️";
    statusText = t("warStatusBehindSchedule") || "Behind schedule";
    statusCls = "partial";
  } else {
    statusIcon = "🔴";
    statusText = t("warStatusVeryBehind") || "Very behind";
    statusCls = "bad";
  }

  const chipsHtml = days
    .map((d) => {
      const cls = d.isFuture ? "future" : d.isToday ? "today" : "past";
      const icon = d.isFuture ? " —" : d.isToday ? " ▶" : "";
      let detail = "";
      if (!d.isFuture && d.totalCount !== null) {
        const ratio = d.maxCount > 0 ? d.totalCount / d.maxCount : 0;
        const snapCls =
          ratio >= 1
            ? ""
            : ratio >= 0.75
              ? "chip-snap chip-snap-orange"
              : "chip-snap chip-snap-red";
        detail = ` <span class="${snapCls || "chip-snap"}">${d.totalCount}/${d.maxCount}</span>`;
      }
      return `<span class="war-day-chip ${cls}">${translateWarDayLabel(d.label)}${icon}${detail}</span>`;
    })
    .join("");

  let snapshotWarning = t("clanWarSnapshotNote");
  if (snapshotWarning === "clanWarSnapshotNote") {
    snapshotWarning =
      currentLang === "fr"
        ? "Les snapshots sont réalisés chaque heure ; les decks joués à la dernière minute peuvent être comptés sur le jour précédent."
        : "Snapshots are taken every hour; decks played at the last minute may be assigned to the previous day.";
  }

  const snapshotDataInvalid = days.some((d) => d.isPast && d.totalCount === 0);

  document.getElementById("clan-war-grid").innerHTML =
    `<div class="war-summary">` +
    `<div class="war-progress-row">` +
    `<span class="war-decks-count">${totalDecksUsed} <span class="war-decks-max">/ ${maxDecksElapsed}</span></span>` +
    `<span class="war-decks-label">${t("warDecksSoFar") || "decks so far"} ${getRemainingTimeHtml(warResetUtcMinutes)}</span>` +
    `<span class="war-data-source reliable">Race log ✓</span>` +
    `</div>` +
    `<div class="war-progress-track">` +
    `<div class="war-progress-fill ${statusCls}" style="width:${pctFill}%"></div>` +
    `</div>` +
    `<div class="war-progress-meta">` +
    `${t("warProgressDayOf", { day: dayNum, total: 4 })}` +
    `</div>` +
    `<div class="war-progress-note">⚠ ${snapshotWarning}</div>` +
    `${snapshotDataInvalid ? `<div class="war-progress-warning">⚠ ${t("warSnapshotDataInvalid")}</div>` : ""}` +
    `<div class="war-day-chips">${chipsHtml}</div>` +
    `</div>`;
}

// ── Clan rendering ──────────────────────────────────────────

// Affiche l'overview du clan, les charts et les cards top/uncomplete.
// Peut être appelé depuis le cache statique ET depuis les données live.
let activeClanTag = null;
let loadedClanSections = {
  topPlayers: false,
  uncomplete: false,
  raceGroup: false,
};

function computeClanLeague(clanWarTrophies) {
  if (clanWarTrophies == null || Number.isNaN(Number(clanWarTrophies))) {
    return null;
  }
  const trophies = Number(clanWarTrophies);
  if (trophies < 200) return "Bronze 1";
  if (trophies < 400) return "Bronze 2";
  if (trophies < 600) return "Bronze 3";
  if (trophies < 900) return "Silver 1";
  if (trophies < 1200) return "Silver 2";
  if (trophies < 1500) return "Silver 3";
  if (trophies < 2000) return "Gold 1";
  if (trophies < 2500) return "Gold 2";
  if (trophies < 3000) return "Gold 3";
  if (trophies < 4000) return "Legendary 1";
  if (trophies < 5000) return "Legendary 2";
  return "Legendary 3";
}

function renderClanOverview(data) {
  const { clan, members } = data;
  const summary = data.summary ?? {
    avgScore: 0,
    green: 0,
    yellow: 0,
    orange: 0,
    red: 0,
    total: 0,
  };
  const isLite = !!data.isLite;
  activeClanTag = clan?.tag || null;
  currentClanIsLite = isLite;

  // Notice clan hors-famille
  if (clanLiteNotice) {
    clanLiteNotice.textContent = t("clanLiteNotice");
    clanLiteNotice.classList.toggle("hidden", !isLite);
  }

  // Colonne "This War" visible uniquement en période de guerre (jeu–dim)
  isWarActive = !isLite && !!data.isWarPeriod; // pas de colonne This War en mode lite
  const weekId =
    data.prevWeekId ||
    data.clanWarSummary?.weekId ||
    data.lastWarSummary?.weekId ||
    (data.lastWarSummary?.weekId &&
      data.lastWarSummary?.weekId.toUpperCase()) ||
    null;

  if (isLite) {
    // Mode lite : afficher top-fame brut de la dernière guerre, masquer uncomplete
    loadedClanSections.topPlayers = true;
    loadedClanSections.uncomplete = true;
    renderClanLiteBest(data.lastWarBest, data.members, data.lastWarWeekId);
    const uncompleteCard = document.getElementById("card-uncomplete");
    if (uncompleteCard) uncompleteCard.classList.add("hidden");
  } else {
    loadedClanSections.topPlayers = Boolean(data.topPlayers);
    loadedClanSections.uncomplete = Boolean(data.uncomplete);
    renderTopPlayersCard(data.topPlayers, weekId);
    renderUncompleteCard(data.uncomplete, weekId);
    const uncompleteCard = document.getElementById("card-uncomplete");
    if (uncompleteCard) uncompleteCard.classList.remove("hidden");
  }
  document
    .getElementById("th-this-war")
    .classList.toggle("hidden", !isWarActive);

  // Masquer/afficher le camembert selon le mode
  const reliableRiskyCard = document.getElementById("card-reliable-risky");
  if (reliableRiskyCard) reliableRiskyCard.classList.toggle("hidden", isLite);
  const clanOverviewCard = document.getElementById("card-clan-overview");
  if (clanOverviewCard) clanOverviewCard.classList.toggle("lite-mode", isLite);
  const clanOverviewRow = document.querySelector(".clan-overview-row");
  if (clanOverviewRow) clanOverviewRow.classList.toggle("lite-mode", isLite);

  // Clan basic description
  const clanDescription = (clan.description || "").trim();
  const clanOverviewDescription = document.getElementById(
    "clan-overview-description",
  );
  if (clanOverviewDescription) {
    if (clanDescription) {
      clanOverviewDescription.textContent = clanDescription;
      clanOverviewDescription.classList.remove("hidden");
    } else {
      clanOverviewDescription.textContent = "";
      clanOverviewDescription.classList.add("hidden");
    }
  }

  // Clan overview card
  const clanTag = clan.tag ?? null;
  const clanLink = clanTag
    ? `https://royaleapi.com/clan/${clanTag.replace("#", "")}/`
    : null;

  // En mode lite : pas de "Reset (Paris)" ni "Avg Score"
  const baseItems = [
    { label: t("labelName"), value: clan.name },
    { label: t("labelTag"), value: clan.tag, link: clanLink },
    {
      label: t("labelMembers"),
      value: `${clan.members} / 50`,
      cls:
        clan.members < 45
          ? "c-red"
          : clan.members < 48
            ? "c-orange"
            : clan.members < 50
              ? "c-yellow"
              : "",
    },
    { label: t("labelClanScore"), value: fmt(clan.clanScore) },
    {
      label: t("labelWarTrophies"),
      value: `⚔️ ${fmt(clan.clanWarTrophies ?? 0)}`,
    },
    {
      label: t("labelLeague"),
      value: computeClanLeague(clan.clanWarTrophies) || "—",
    },
    { label: t("labelRequired"), value: `🏆 ${fmt(clan.requiredTrophies)}` },
    { label: t("labelType"), value: capitalize(clan.type ?? "—") },
  ];
  const fullItems = [
    ...baseItems,
    {
      label: t("labelWarReset"),
      value: (() => {
        const utcMinutes = clan.warResetUtcMinutes ?? 9 * 60 + 40;
        const utcMs = utcMinutes * 60 * 1000;
        const ref = new Date(new Date().toDateString() + " UTC");
        return new Date(ref.getTime() + utcMs).toLocaleTimeString("fr-FR", {
          timeZone: "Europe/Paris",
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        });
      })(),
    },
    {
      label: t("labelAvgScore"),
      value: `${summary.avgScore} / 100`,
      cls:
        summary.avgScore < 60
          ? "c-red"
          : summary.avgScore < 70
            ? "c-orange"
            : summary.avgScore < 80
              ? "c-yellow"
              : "",
    },
  ];
  clanOverviewGrid.innerHTML = overviewItems(isLite ? baseItems : fullItems);

  if (!isLite) {
    // Charts
    renderClanPieChart(summary);
    // Card groupe de course
    const cardGroup = document.getElementById("card-war-group");
    const detailsGroup = document.getElementById("details-war-group");
    const groupListEl = document.getElementById("war-group-list");
    if (data.raceGroup) {
      cardGroup.classList.remove("hidden");
      if (!loadedClanSections.raceGroup) {
        if (groupListEl) {
          groupListEl.innerHTML = `<tr class="text-muted"><td colspan="6" style="padding:15px;text-align:center;">${t("clickToLoadRaceGroup") || "Open the section to load rival data."}</td></tr>`;
        }
        detailsGroup.open = false;
      } else {
        renderRaceGroupCard(data, t, getRemainingTimeHtml);
      }
    } else {
      cardGroup.classList.add("hidden");
    }
    // Card guerre courante clan
    const effectiveClanWarSummary = mergeWarSummaries(
      data.clanWarSummary,
      data.lastWarSummary,
    );
    if (effectiveClanWarSummary)
      effectiveClanWarSummary.warResetUtcMinutes =
        data.clan?.warResetUtcMinutes;
    renderClanWarCard(effectiveClanWarSummary, data.clan?.warResetUtcMinutes);

    // card title (chart label)
  }

  // members table headers
  translateClanTableHeaders();

  // Ensure any rendered labels are updated after dynamic clan content is rendered
  translateUI();
  updateLangButtonUI();
  if (!isLite) setupClanLazySectionHandlers(weekId);
  clanResults.classList.remove("hidden");
}

function setupClanLazySectionHandlers(weekId) {
  if (!activeClanTag) return;

  const topCard = document.getElementById("card-top-players");
  if (topCard && !topCard.dataset.lazyInit) {
    const topDetails = topCard.querySelector("details");
    if (topDetails) {
      topDetails.addEventListener("toggle", async () => {
        if (!topDetails.open || loadedClanSections.topPlayers) return;
        topCard.querySelector("#top-players-list").innerHTML =
          `<li class="text-muted">${t("loading") || "Loading..."}</li>`;
        try {
          await loadClanSection(activeClanTag, "topPlayers", weekId);
        } catch (err) {
          topCard.querySelector("#top-players-list").innerHTML =
            `<li class="text-muted">${t("errorLoadingSection") || "Failed to load top players."}</li>`;
        }
      });
    }
    topCard.dataset.lazyInit = "1";
  }

  const uncompleteCard = document.getElementById("card-uncomplete");
  if (uncompleteCard && !uncompleteCard.dataset.lazyInit) {
    const uncompleteDetails = uncompleteCard.querySelector("details");
    if (uncompleteDetails) {
      uncompleteDetails.addEventListener("toggle", async () => {
        if (!uncompleteDetails.open || loadedClanSections.uncomplete) return;
        uncompleteCard.querySelector("#uncomplete-list").innerHTML =
          `<li class="text-muted">${t("loading") || "Loading..."}</li>`;
        try {
          await loadClanSection(activeClanTag, "uncomplete", weekId);
        } catch (err) {
          uncompleteCard.querySelector("#uncomplete-list").innerHTML =
            `<li class="text-muted">${t("errorLoadingSection") || "Failed to load uncomplete list."}</li>`;
        }
      });
    }
    uncompleteCard.dataset.lazyInit = "1";
  }

  const groupCard = document.getElementById("card-war-group");
  if (groupCard && !groupCard.dataset.lazyInit) {
    const groupDetails = groupCard.querySelector("details");
    if (groupDetails) {
      groupDetails.addEventListener("toggle", async () => {
        if (!groupDetails.open || loadedClanSections.raceGroup) return;
        document.getElementById("war-group-spinner").classList.remove("hidden");
        try {
          await loadClanSection(activeClanTag, "raceGroup", weekId);
        } catch (err) {
          document.getElementById("war-group-list").innerHTML =
            `<tr class="text-muted"><td colspan="6" style="padding:15px;text-align:center;">${t("errorLoadingSection") || "Failed to load group data."}</td></tr>`;
        } finally {
          document.getElementById("war-group-spinner").classList.add("hidden");
        }
      });
    }
    groupCard.dataset.lazyInit = "1";
  }
}

async function loadClanSection(tag, section, weekId) {
  const params = new URLSearchParams();
  params.set("includeTopPlayers", section === "topPlayers" ? "1" : "0");
  params.set("includeUncomplete", section === "uncomplete" ? "1" : "0");
  params.set("includeRaceGroup", section === "raceGroup" ? "true" : "false");
  const { data } = await apiFetch(
    `/api/clan/${encodeURIComponent(tag)}/analysis?${params.toString()}`,
  );

  if (section === "topPlayers") {
    loadedClanSections.topPlayers = true;
    renderTopPlayersCard(data.topPlayers, weekId);
  }
  if (section === "uncomplete") {
    loadedClanSections.uncomplete = true;
    renderUncompleteCard(data.uncomplete, weekId);
  }
  if (section === "raceGroup") {
    loadedClanSections.raceGroup = true;
    renderRaceGroupCard(data, t, getRemainingTimeHtml);
  }
}

// Affiche la liste des membres — appelé uniquement depuis les données live.
function renderClanMembers(data) {
  const { members } = data;
  const isLite = !!data.isLite;
  allMembers = members;

  // Filtre verdict : désactivé en mode lite (pas de verdict disponible)
  if (filterVerdict) filterVerdict.classList.toggle("lite-hidden", isLite);

  // Réinitialiser les filtres et le tri par défaut
  filterName.value = "";
  filterVerdict.value = "";

  if (isLite) {
    // Mode lite : tri par trophées décroissant
    sortState = { col: "trophies", dir: "desc" };
    document.querySelectorAll(".members-table th.sortable").forEach((h) => {
      h.classList.remove("sort-asc", "sort-desc");
      if (h.dataset.col === "trophies") h.classList.add("sort-desc");
    });
    renderMembersTable(sortMembers(members, "trophies", "desc"));
  } else {
    sortState = { col: "reliability", dir: "asc" };
    document.querySelectorAll(".members-table th.sortable").forEach((h) => {
      h.classList.remove("sort-asc", "sort-desc");
      if (h.dataset.col === "reliability") h.classList.add("sort-asc");
    });
    renderMembersTable(sortMembers(members, "reliability", "asc"));
  }
  updateDebugPanel(data, "clan");
}

// Affiche un skeleton dans le tableau membres pendant le chargement live.
function renderMembersSkeleton() {
  const cols = isWarActive ? 9 : 8;
  membersTbody.innerHTML = `<tr><td colspan="${cols}" class="members-skeleton">${t("membersLoading")}</td></tr>`;
}

// ── Members table ────────────────────────────────────────────

function renderMembersTable(members) {
  // Nombre de colonnes : base 6 (name, role, trophies, donations, lastSeen + 1 variable)
  // Full mode : +discord +reliability +verdict = 9 (+ warDecks si guerre active)
  // Lite mode : 6 (name, role, trophies, donations, lastSeen) → pas discord/reliability/verdict
  const liteColCount = 5;
  const fullColCount = isWarActive ? 9 : 8;
  const colCount = currentClanIsLite ? liteColCount : fullColCount;

  if (members.length === 0) {
    membersTbody.innerHTML = `<tr><td colspan="${colCount}" style="text-align:center;color:var(--text-muted)">${t("noMembersFound")}</td></tr>`;
    return;
  }

  // Masquer/afficher les colonnes discord/reliability/verdict dans le header
  document
    .querySelectorAll(
      '#card-clan-table thead th[data-col="discord"], #card-clan-table thead th[data-col="reliability"], #card-clan-table thead th[data-col="verdict"]',
    )
    .forEach((th) => {
      th.classList.toggle("lite-hidden", currentClanIsLite);
    });

  // translate member table headers on each render to avoid sticky labels across language switch
  translateClanTableHeaders();

  membersTbody.innerHTML = members
    .map((m) => {
      // Indicateur de dernière connexion dans sa propre cellule
      let lastSeenCell = '<td class="last-seen-col">—</td>';
      let daysFrac = Infinity;
      const score = Number(m.reliability ?? 0) || 0;
      m.reliability = Math.max(0, Math.min(100, score));
      if (m.lastSeen) {
        daysFrac =
          (Date.now() -
            new Date(
              m.lastSeen.replace(
                /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})\.(\d{3})Z$/,
                "$1-$2-$3T$4:$5:$6.$7Z",
              ),
            ).getTime()) /
          (1000 * 60 * 60 * 24);
        const days = Math.round(daysFrac);
        const cls =
          days <= 1
            ? "c-green"
            : days <= 3
              ? "c-yellow"
              : days <= 7
                ? "c-red"
                : "c-red";
        const label =
          daysFrac < 1
            ? t("today")
            : days < 2
              ? t("oneDayAgo")
              : currentLang === "fr"
                ? `${t("ago")} ${days} ${t("days")}`
                : `${days} ${t("days")} ${t("ago")}`;
        lastSeenCell = `<td class="last-seen-col"><span class="last-seen-badge ${cls}">${label}</span></td>`;
      }
      // New players are marked via backend war history/fallback analysis.
      const displayNew = m.isNew;
      const memberVerdict =
        {
          "High reliability": t("highReliability"),
          "Moderate risk": t("moderateRisk"),
          "High risk": t("highRisk"),
          "Extreme risk": t("extremeRisk"),
        }[m.verdict] || m.verdict;

      const discordCell = currentClanIsLite
        ? ""
        : `<td class="discord-col">${m.discord ? "✅" : "-"}</td>`;
      const reliabilityCell = currentClanIsLite
        ? ""
        : `<td>
          <div style="display:flex;align-items:center;gap:8px">
            <div style="flex:1;height:6px;background:rgba(255,255,255,.08);border-radius:999px;overflow:hidden;min-width:60px">
              <div style="width:${m.reliability}%;height:100%;background:${scoreBarColor(m.color)};border-radius:999px"></div>
            </div>
            <span style="font-weight:700;font-size:.88rem">${Math.round(m.reliability)}%</span>
          </div>
        </td>`;
      const verdictCell = currentClanIsLite
        ? ""
        : `<td><span class="verdict-badge ${m.color}">${escHtml(memberVerdict)}</span></td>`;

      return `
      <tr>
        <td>
          <a class="member-link" href="?${new URLSearchParams({ mode: "player", tag: m.tag })}" title="${t("analyze")} ${escHtml(m.name)}">
            <div style="font-weight:600">${escHtml(m.name)}${displayNew ? ` <span class="new-badge">${t("newBadge")}</span>` : ""}</div>
            <div style="font-size:.75rem;color:var(--text-muted)">${escHtml(m.tag)}</div>
          </a>
        </td>
        <td><span class="role-badge ${m.role}">${capitalize(m.role)}</span></td>
        <td>🏆 ${fmt(m.trophies)}</td>
        <td>${fmt(m.totalDonations ?? m.donations)}</td>
        ${discordCell}
        ${lastSeenCell}
        ${isWarActive ? `<td class="war-col">${warMiniBarHtml(m.warDays)}</td>` : ""}
        ${reliabilityCell}
        ${verdictCell}
      </tr>`;
    })
    .join("");
}

// Injecte la cellule Last Seen juste avant la colonne This War / Verdict
// (template string dans renderMembersTable — injection via replace)
membersTbody.addEventListener("click", (e) => {
  const link = e.target.closest("a.member-link");
  if (!link) return;
  e.preventDefault();
  const params = new URLSearchParams(link.search);
  const tag = params.get("tag");
  if (!tag) return;
  applyUrlState("player", tag);
  _replaceNextPush = false;
  handleSearch();
});

// Filtering
let _filterDebounceTimer = null;
filterName.addEventListener("input", () => {
  clearTimeout(_filterDebounceTimer);
  _filterDebounceTimer = setTimeout(applyFilters, 150);
});
filterVerdict.addEventListener("change", applyFilters);

function applyFilters() {
  const nameQ = filterName.value.toLowerCase();
  const verdictQ = filterVerdict.value;
  let filtered = allMembers.filter((m) => {
    const matchName =
      m.name.toLowerCase().includes(nameQ) ||
      m.tag.toLowerCase().includes(nameQ);
    const matchVerdict = !verdictQ || m.color === verdictQ;
    return matchName && matchVerdict;
  });
  if (sortState.col)
    filtered = sortMembers(filtered, sortState.col, sortState.dir);
  renderMembersTable(filtered);
}

// Sorting
document.querySelectorAll(".members-table th.sortable").forEach((th) => {
  th.addEventListener("click", () => {
    const col = th.dataset.col;
    if (sortState.col === col) {
      sortState.dir = sortState.dir === "asc" ? "desc" : "asc";
    } else {
      sortState.col = col;
      sortState.dir = "asc";
    }
    // Update header visual
    document.querySelectorAll(".members-table th.sortable").forEach((h) => {
      h.classList.remove("sort-asc", "sort-desc");
    });
    th.classList.add(`sort-${sortState.dir}`);
    applyFilters();
  });
});

function sortMembers(arr, col, dir) {
  return [...arr].sort((a, b) => {
    let va = a[col],
      vb = b[col];
    // Les valeurs null vont toujours en dernier, quel que soit le sens du tri
    if (va === null && vb === null) return 0;
    if (va === null) return 1;
    if (vb === null) return -1;
    if (typeof va === "string") va = va.toLowerCase();
    if (typeof vb === "string") vb = vb.toLowerCase();
    if (va < vb) return dir === "asc" ? -1 : 1;
    if (va > vb) return dir === "asc" ? 1 : -1;
    return 0;
  });
}

// ── Template helpers ─────────────────────────────────────────

function overviewItems(items) {
  return items
    .map(
      ({ label, value, cls = "", risk = null, badge = null, link = null }) => {
        const sym =
          risk === "bad"
            ? ' <span class="risk-bad">&#10007;</span>'
            : risk === "warn"
              ? ' <span class="risk-warn">&#9888;</span>'
              : "";
        const bdg = badge
          ? ` <span class="new-badge">${escHtml(badge)}</span>`
          : "";
        const val = escHtml(String(value));
        const inner = link
          ? `<a href="${link}" target="_blank" rel="noopener" class="oi-ext-link">${val}</a>`
          : val;
        return `
        <div class="overview-item">
          <div class="oi-label">${label}</div>
          <div class="oi-value ${cls}">${inner}${sym}${bdg}</div>
        </div>`;
      },
    )
    .join("");
}

function statCards(items) {
  return items
    .map(({ label, value, risk = null }) => {
      const sym =
        risk === "bad"
          ? ' <span class="risk-bad">&#10007;</span>'
          : risk === "warn"
            ? ' <span class="risk-warn">&#9888;</span>'
            : "";
      return `
        <div class="stat-card">
          <div class="sc-value">${escHtml(String(value))}${sym}</div>
          <div class="sc-label">${label}</div>
        </div>`;
    })
    .join("");
}

function badge(text, type) {
  return `<span class="badge badge-${type}">${text}</span>`;
}

function scoreBarColor(color) {
  return (
    { green: "#22c55e", yellow: "#eab308", orange: "#f97316", red: "#ef4444" }[
      color
    ] ?? "#7c3aed"
  );
}

// ── Utility ──────────────────────────────────────────────────

const fmt = (n) => Number(n).toLocaleString();
const pl = (n) => (n !== 1 ? "s" : "");

function capitalize(s) {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function escHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ── Debug / log panel (dev mode) ──────────────────────────────────
const DEBUG_STORAGE_KEY = "trustroyale-debug";
let debugEnabled = localStorage.getItem(DEBUG_STORAGE_KEY) === "true";

function initDebugUI() {
  const toggle = document.getElementById("debug-toggle");
  const panel = document.getElementById("debug-panel");
  if (!toggle || !panel) return;

  toggle.addEventListener("click", () => {
    debugEnabled = !debugEnabled;
    localStorage.setItem(DEBUG_STORAGE_KEY, debugEnabled ? "true" : "false");
    setDebugPanelVisible(debugEnabled);
    updateDebugPanel(null, "none");
  });

  setDebugPanelVisible(debugEnabled);
  updateDebugPanel(null, "none");
}

function setDebugPanelVisible(on) {
  const panel = document.getElementById("debug-panel");
  const toggle = document.getElementById("debug-toggle");
  if (!panel || !toggle) return;
  panel.classList.toggle("hidden", !on);
  toggle.classList.toggle("active", on);
}

function updateDebugPanel(data, mode) {
  const panel = document.getElementById("debug-panel");
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
    warCurrentWeekId:
      data?.warCurrentWeekId ?? data?.clanWarSummary?.weekId ?? null,
    source:
      data?.fromCache != null ? (data.fromCache ? "cache" : "api") : "live",
    warSnapshotDays: data?.warSnapshotDays ?? null,
    currentWarDays: data?.currentWarDays ?? null,
    clanWarSummary: data?.clanWarSummary ?? null,
  };

  const text = JSON.stringify(payload, null, 2);
  panel.innerHTML = `
    <h3>Debug info (${mode})</h3>
    <button id="debug-refresh-now" class="btn btn-small" style="margin-bottom:.5rem;">🔄 ${t("refreshNow") || "Refresh now"}</button>
    <div style="font-size:.88rem;line-height:1.35;">
      <div><strong>mode :</strong> ${escHtml(payload.mode)}</div>
      <div><strong>source :</strong> ${escHtml(payload.source)}</div>
      <div><strong>now :</strong> ${escHtml(payload.now)}</div>
      <div><strong>snapshotDate :</strong> ${escHtml(payload.snapshotDate ?? "—")}</div>
      <div><strong>warCurrentWeekId :</strong> ${escHtml(payload.warCurrentWeekId ?? "—")}</div>
      <div><strong>warSnapshotDays :</strong> ${payload.warSnapshotDays ? JSON.stringify(payload.warSnapshotDays) : "—"}</div>
      <div><strong>currentWarDays :</strong> ${payload.currentWarDays ? payload.currentWarDays.length + " jours" : "—"}</div>
      <div><strong>clanWarSummary :</strong> ${payload.clanWarSummary ? "ok" : "—"}</div>
    </div>
    <details style="margin-top:.75rem;">
      <summary>Full debug payload</summary>
      <pre>${escHtml(text)}</pre>
    </details>
  `;

  const refreshBtn = document.getElementById("debug-refresh-now");
  if (refreshBtn) {
    refreshBtn.addEventListener("click", () => {
      handleSearch(true);
    });
  }
}

// Initialize debug UI once the DOM is ready
window.addEventListener("DOMContentLoaded", () => {
  initDebugUI();

  // If the page has a query tag/mode, run search immediately to populate debug and data.
  const { mode, tag } = getUrlState();
  if (mode && tag) {
    applyUrlState(mode, tag);
    handleSearch();
  }
});
