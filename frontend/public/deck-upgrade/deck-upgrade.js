const rowsBody = document.getElementById("rows-body");
const rowTemplate = document.getElementById("row-template");
const addRowBtn = document.getElementById("add-row-btn");
const calculateBtn = document.getElementById("calculate-btn");
const optimizeJokersBtn = document.getElementById("optimize-jokers-btn");
const resetBtn = document.getElementById("reset-btn");
const loadPlayerBtn = document.getElementById("load-player-btn");
const playerTagInput = document.getElementById("player-tag-input");
const modeTabs = Array.from(document.querySelectorAll(".mode-tab"));
const globalError = document.getElementById("global-error");
const results = document.getElementById("results");
const summaryGrid = document.getElementById("summary-grid");
const detailsBody = document.getElementById("details-body");
const totalGoldEl = document.getElementById("total-gold");
const totalJokersUsedEl = document.getElementById("total-jokers-used");
const jokerStrategySelect = document.getElementById("joker-strategy");
const JOKER_PREFS_STORAGE_KEY = "trustroyale_deck_upgrade_joker_prefs_v1";
const PLAYER_TAG_STORAGE_KEY = "trustroyale_deck_upgrade_player_tag_v1";

const jokerInputs = {
  common: document.getElementById("joker-common"),
  rare: document.getElementById("joker-rare"),
  epic: document.getElementById("joker-epic"),
  legendary: document.getElementById("joker-legendary"),
  champion: document.getElementById("joker-champion"),
};

const RARITY_CONFIG = {
  common: {
    label: "Commune",
    minLevel: 1,
    maxLevel: 16,
    upgrades: {
      1: 2,
      2: 4,
      3: 10,
      4: 20,
      5: 50,
      6: 100,
      7: 200,
      8: 400,
      9: 800,
      10: 1000,
      11: 1500,
      12: 2500,
      13: 3500,
      14: 5500,
      15: 7500,
    },
    goldUpgrades: {
      1: 5,
      2: 20,
      3: 50,
      4: 150,
      5: 400,
      6: 1000,
      7: 2000,
      8: 4000,
      9: 8000,
      10: 15000,
      11: 25000,
      12: 40000,
      13: 60000,
      14: 90000,
      15: 120000,
    },
  },
  rare: {
    label: "Rare",
    minLevel: 3,
    maxLevel: 16,
    upgrades: {
      3: 2,
      4: 4,
      5: 10,
      6: 20,
      7: 50,
      8: 100,
      9: 200,
      10: 300,
      11: 400,
      12: 550,
      13: 750,
      14: 1000,
      15: 1400,
    },
    goldUpgrades: {
      3: 50,
      4: 150,
      5: 400,
      6: 1000,
      7: 2000,
      8: 4000,
      9: 8000,
      10: 15000,
      11: 25000,
      12: 40000,
      13: 60000,
      14: 90000,
      15: 120000,
    },
  },
  epic: {
    label: "Épique",
    minLevel: 6,
    maxLevel: 16,
    upgrades: {
      6: 2,
      7: 4,
      8: 10,
      9: 20,
      10: 30,
      11: 50,
      12: 70,
      13: 100,
      14: 130,
      15: 180,
    },
    goldUpgrades: {
      6: 400,
      7: 2000,
      8: 4000,
      9: 8000,
      10: 15000,
      11: 25000,
      12: 40000,
      13: 60000,
      14: 90000,
      15: 120000,
    },
  },
  legendary: {
    label: "Légendaire",
    minLevel: 9,
    maxLevel: 16,
    upgrades: {
      9: 2,
      10: 4,
      11: 6,
      12: 9,
      13: 12,
      14: 14,
      15: 20,
    },
    goldUpgrades: {
      9: 5000,
      10: 15000,
      11: 25000,
      12: 40000,
      13: 60000,
      14: 90000,
      15: 120000,
    },
  },
  champion: {
    label: "Champion",
    minLevel: 11,
    maxLevel: 16,
    upgrades: {
      11: 2,
      12: 5,
      13: 8,
      14: 11,
      15: 15,
    },
    goldUpgrades: {
      11: 25000,
      12: 40000,
      13: 60000,
      14: 90000,
      15: 120000,
    },
  },
};

const RARITY_ORDER = ["common", "rare", "epic", "legendary", "champion"];
const RARITY_OFFSET = {
  common: 0,
  rare: 2,
  epic: 5,
  legendary: 8,
  champion: 10,
};
let currentMode = "manual";
const modeRowsCache = {
  manual: null,
  "current-deck": null,
  "war-decks": null,
  collection: null,
};

function normalizeTag(raw) {
  if (!raw) return null;
  const clean = String(raw).trim().toUpperCase().replace(/^#+/, "");
  if (!clean) return null;
  return `#${clean}`;
}

function getNormalizedPlayerTag() {
  return normalizeTag(playerTagInput?.value);
}

function isAutoMode(mode) {
  return (
    mode === "current-deck" || mode === "war-decks" || mode === "collection"
  );
}

function showMissingTagState() {
  rowsBody.innerHTML = "";
  results.classList.add("hidden");
  globalError.textContent =
    "Renseignez votre tag joueur pour charger les données de cet onglet.";
}

function maybeAutoLoadActiveMode() {
  if (!isAutoMode(currentMode)) return;
  if (!getNormalizedPlayerTag()) {
    showMissingTagState();
    return;
  }

  void handleLoadPlayerData();
}

function setActiveMode(mode) {
  if (currentMode) {
    modeRowsCache[currentMode] = getRowsSnapshot();
  }

  currentMode = mode;
  modeTabs.forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.mode === mode);
  });

  addRowBtn.disabled = mode !== "manual";

  if (isAutoMode(mode) && !getNormalizedPlayerTag()) {
    showMissingTagState();
    return;
  }

  if (isAutoMode(mode)) {
    maybeAutoLoadActiveMode();
    return;
  }

  const cachedRows = modeRowsCache[mode];
  if (Array.isArray(cachedRows)) {
    replaceRows(cachedRows);
    return;
  }

  if (mode === "manual" && !rowsBody.children.length) {
    createRow({
      rarity: "common",
      currentLevel: 10,
      currentCards: 0,
      targetLevel: 16,
    });
  }
}

function savePlayerTagToStorage(tag) {
  try {
    if (!tag) {
      localStorage.removeItem(PLAYER_TAG_STORAGE_KEY);
      return;
    }
    localStorage.setItem(PLAYER_TAG_STORAGE_KEY, tag);
  } catch {
    // Ignore storage errors.
  }
}

function loadPlayerTagFromStorage() {
  try {
    const tag = localStorage.getItem(PLAYER_TAG_STORAGE_KEY);
    if (tag && playerTagInput) playerTagInput.value = tag;
  } catch {
    // Ignore storage errors.
  }
}

function encodeTagForApi(tag) {
  return encodeURIComponent(tag);
}

function normalizeCardId(id) {
  if (id === null || id === undefined) return "";
  return String(id);
}

function getRowsSnapshot() {
  return Array.from(rowsBody.querySelectorAll("tr"))
    .filter((row) => row.querySelector(".current-level"))
    .map((row) => {
      const payload = getRowPayload(row);
      return {
        ...payload,
        cardName: row.dataset.cardName || null,
      };
    });
}

async function fetchJsonOrThrow(url) {
  const res = await fetch(url);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error || `Erreur API (${res.status})`;
    throw new Error(msg);
  }
  return data;
}

function cardToRow(card) {
  const rarity = String(card?.rarity || "").toLowerCase();
  const conf = RARITY_CONFIG[rarity];
  if (!conf) return null;

  // Aligné sur /collection: niveau normalisé = level API + offset de rareté.
  const rawLevel = Number.parseInt(card?.level, 10);
  const offset = RARITY_OFFSET[rarity] ?? 0;
  const normalizedLevel = Number.isInteger(rawLevel)
    ? rawLevel + offset
    : conf.minLevel;
  const safeLevel = Math.min(
    conf.maxLevel,
    Math.max(conf.minLevel, normalizedLevel),
  );
  const currentCardsRaw = Number.parseInt(card?.count, 10);
  const currentCards = Number.isInteger(currentCardsRaw) ? currentCardsRaw : 0;
  const targetLevel = conf.maxLevel;

  return {
    cardName: card?.name ?? null,
    rarity,
    currentLevel: safeLevel,
    currentCards,
    targetLevel,
  };
}

function sortRowsByPriority(rows) {
  return rows.sort((a, b) => {
    const rarityDelta =
      RARITY_ORDER.indexOf(a.rarity) - RARITY_ORDER.indexOf(b.rarity);
    if (rarityDelta !== 0) return rarityDelta;
    return b.currentLevel - a.currentLevel;
  });
}

function sortCollectionRows(rows) {
  return rows.sort((a, b) => {
    if (a.currentLevel !== b.currentLevel) {
      return a.currentLevel - b.currentLevel;
    }

    const rarityDelta =
      RARITY_ORDER.indexOf(a.rarity) - RARITY_ORDER.indexOf(b.rarity);
    if (rarityDelta !== 0) return rarityDelta;

    return String(a.cardName || "").localeCompare(
      String(b.cardName || ""),
      "fr",
    );
  });
}

function chunkArray(items, size) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function appendCollectionLevelTitle(level, count) {
  const titleRow = document.createElement("tr");
  titleRow.className = "level-title-row";

  const titleCell = document.createElement("td");
  titleCell.colSpan = 5;
  titleCell.textContent = `Cartes Niveau ${level}${
    level === 16 ? ` (${count})` : ""
  }`;

  titleRow.appendChild(titleCell);
  rowsBody.appendChild(titleRow);
}

function appendWarDeckTitle(deckNumber) {
  const titleRow = document.createElement("tr");
  titleRow.className = "deck-title-row";

  const titleCell = document.createElement("td");
  titleCell.colSpan = 5;
  titleCell.textContent = `Deck ${deckNumber}`;

  titleRow.appendChild(titleCell);
  rowsBody.appendChild(titleRow);
}

function replaceRowsCollection(rows) {
  const sortedRows = sortCollectionRows(rows);
  const rowsByLevel = new Map();

  sortedRows.forEach((row) => {
    const level = row.currentLevel;
    if (!rowsByLevel.has(level)) rowsByLevel.set(level, []);
    rowsByLevel.get(level).push(row);
  });

  const level16Rows = rowsByLevel.get(16) ?? [];
  const levelsBelow16 = Array.from(rowsByLevel.keys())
    .filter((level) => level < 16)
    .sort((a, b) => a - b);

  levelsBelow16.forEach((level) => {
    const levelRows = rowsByLevel.get(level) ?? [];
    if (!levelRows.length) return;

    appendCollectionLevelTitle(level, levelRows.length);
    levelRows.forEach((row) => {
      createRow(row, {
        touched: true,
        lockType: true,
      });
    });
  });

  appendCollectionLevelTitle(16, level16Rows.length);
}

function replaceRowsWarDecks(groups) {
  const validGroups = Array.isArray(groups) ? groups : [];

  validGroups.forEach((group, index) => {
    const rows = Array.isArray(group?.rows) ? group.rows : [];
    if (!rows.length) return;

    appendWarDeckTitle(index + 1);
    rows.forEach((row) => {
      createRow(row, {
        touched: true,
        lockType: true,
      });
    });
  });
}

function replaceRows(rows) {
  rowsBody.innerHTML = "";
  clearErrors();
  results.classList.add("hidden");

  if (!rows.length) {
    if (currentMode === "manual") {
      createRow({
        rarity: "common",
        currentLevel: 10,
        currentCards: 0,
        targetLevel: 16,
      });
    }
    return;
  }

  if (currentMode === "collection") {
    replaceRowsCollection(rows);
    return;
  }

  rows.forEach((row) => {
    createRow(row, {
      touched: true,
      lockType: currentMode !== "manual",
    });
  });
}

function renderRowsForCurrentMode(rows) {
  modeRowsCache[currentMode] = rows.map((row) => ({ ...row }));
  replaceRows(rows);
}

function renderWarDeckGroupsForCurrentMode(groups) {
  modeRowsCache[currentMode] = Array.isArray(groups)
    ? groups.map((group) => ({
        rows: Array.isArray(group?.rows)
          ? group.rows.map((row) => ({ ...row }))
          : [],
      }))
    : [];

  rowsBody.innerHTML = "";
  clearErrors();
  results.classList.add("hidden");

  const validGroups = Array.isArray(groups) ? groups : [];
  validGroups.forEach((group, index) => {
    const deckRows = Array.isArray(group?.rows) ? group.rows : [];
    if (!deckRows.length) return;

    appendWarDeckTitle(index + 1);
    deckRows.forEach((row) => {
      createRow(row, {
        touched: true,
        lockType: true,
      });
    });
  });
}

function extractWarDeckGroupsFromBattlelog(battleLog, cardById) {
  const gdcTypes = new Set([
    "riverracepvp",
    "riverraceduel",
    "riverraceduelscolosseum",
    "riverraceboat",
    "clanwarbattle",
  ]);
  const groups = [];

  (Array.isArray(battleLog) ? battleLog : []).forEach((battle) => {
    const type = String(battle?.type || "").toLowerCase();
    if (!gdcTypes.has(type)) return;

    const cards = Array.isArray(battle?.team?.[0]?.cards)
      ? battle.team[0].cards
      : [];

    chunkArray(cards, 8).forEach((deckCards) => {
      const rows = deckCards
        .map((card) => {
          const normalizedId = normalizeCardId(card?.id);
          return cardById.get(normalizedId) || card;
        })
        .map(cardToRow)
        .filter(Boolean);

      if (rows.length) {
        groups.push({ rows: sortRowsByPriority(rows) });
      }
    });
  });

  return groups;
}

function extractLatestPvpDeckCardIds(battleLog) {
  const gdcTypes = new Set([
    "riverracepvp",
    "riverraceduel",
    "riverraceduelscolosseum",
    "riverraceboat",
    "clanwarbattle",
  ]);

  const battles = Array.isArray(battleLog) ? battleLog : [];
  for (const battle of battles) {
    const type = String(battle?.type || "").toLowerCase();
    if (gdcTypes.has(type)) continue;

    const cards = Array.isArray(battle?.team?.[0]?.cards)
      ? battle.team[0].cards
      : [];
    const ids = cards.map((card) => normalizeCardId(card?.id)).filter(Boolean);

    if (ids.length >= 8) {
      return ids;
    }
  }

  return [];
}

function createRow(defaultValues = null, options = {}) {
  const fragment = rowTemplate.content.cloneNode(true);
  const row = fragment.querySelector("tr");
  row.dataset.touched = options.touched ? "true" : "false";
  row.dataset.lockType = options.lockType ? "true" : "false";

  row.querySelectorAll(".field").forEach((field) => {
    field.addEventListener("input", () => {
      row.dataset.touched = "true";
    });
    field.addEventListener("change", () => {
      row.dataset.touched = "true";
    });
  });

  if (defaultValues) {
    row.querySelector(".rarity").value = defaultValues.rarity;
    row.querySelector(".current-level").value = defaultValues.currentLevel;
    row.querySelector(".current-cards").value = defaultValues.currentCards;
    row.querySelector(".target-level").value = defaultValues.targetLevel;

    if (options.lockType) {
      row.dataset.rarity = defaultValues.rarity;
      row.dataset.cardName = defaultValues.cardName || "";
      const staticType = row.querySelector(".type-static");
      const rarityLabel = RARITY_CONFIG[defaultValues.rarity]?.label ?? "";
      const cardName = defaultValues.cardName || rarityLabel;

      staticType.innerHTML = "";
      const nameEl = document.createElement("span");
      nameEl.className = "type-card-name";
      nameEl.textContent = cardName;

      const rarityEl = document.createElement("span");
      rarityEl.className = "type-card-rarity";
      rarityEl.textContent = rarityLabel;

      staticType.append(nameEl, rarityEl);
    }
  }

  const raritySelect = row.querySelector(".rarity");
  const staticType = row.querySelector(".type-static");
  if (options.lockType) {
    raritySelect.classList.add("hidden");
    raritySelect.disabled = true;
    staticType.classList.remove("hidden");
  }

  row.querySelector(".remove-row").addEventListener("click", () => {
    row.remove();
    if (!rowsBody.children.length && currentMode === "manual") createRow();
  });

  rowsBody.appendChild(fragment);
}

function clearErrors() {
  globalError.textContent = "";
  rowsBody.querySelectorAll(".row-error").forEach((err) => {
    err.textContent = "";
  });
}

async function handleLoadPlayerData() {
  clearErrors();

  if (currentMode === "manual") {
    const normalizedTag = normalizeTag(playerTagInput?.value);
    if (normalizedTag && playerTagInput) {
      playerTagInput.value = normalizedTag;
      savePlayerTagToStorage(normalizedTag);
    }
    return;
  }

  const normalizedTag = normalizeTag(playerTagInput?.value);
  if (!normalizedTag) {
    showMissingTagState();
    return;
  }

  if (playerTagInput) playerTagInput.value = normalizedTag;
  savePlayerTagToStorage(normalizedTag);

  loadPlayerBtn.disabled = true;
  const previousLabel = loadPlayerBtn.textContent;
  loadPlayerBtn.textContent = "Chargement...";

  try {
    const encodedTag = encodeTagForApi(normalizedTag);
    const player = await fetchJsonOrThrow(`/api/player/${encodedTag}`);
    const allCards = [
      ...(Array.isArray(player.cards) ? player.cards : []),
      ...(Array.isArray(player.supportCards) ? player.supportCards : []),
    ];

    const cardById = new Map();
    allCards.forEach((card) => {
      const normalizedId = normalizeCardId(card?.id);
      if (normalizedId) cardById.set(normalizedId, card);
    });

    let rows = [];

    if (currentMode === "current-deck") {
      const deckCards = Array.isArray(player.currentDeck)
        ? player.currentDeck
        : [];

      let resolvedDeckCards = deckCards.map((deckCard) => {
        const normalizedId = normalizeCardId(deckCard?.id);
        return cardById.get(normalizedId) || deckCard;
      });

      if (resolvedDeckCards.length < 8) {
        try {
          const analysis = await fetchJsonOrThrow(
            `/api/player/${encodedTag}/analysis?fast=true`,
          );
          const fallbackIds = extractLatestPvpDeckCardIds(analysis?.battleLog);
          if (fallbackIds.length) {
            const existingIds = new Set(
              resolvedDeckCards
                .map((card) => normalizeCardId(card?.id))
                .filter(Boolean),
            );

            fallbackIds.forEach((id) => {
              if (existingIds.has(id) || resolvedDeckCards.length >= 8) return;
              const fallbackCard = cardById.get(id);
              if (!fallbackCard) return;
              resolvedDeckCards.push(fallbackCard);
              existingIds.add(id);
            });
          }
        } catch {
          // Ignore fallback error: keep currentDeck as-is.
        }
      }

      rows = sortRowsByPriority(
        resolvedDeckCards.map(cardToRow).filter(Boolean),
      );
    } else if (currentMode === "collection") {
      rows = allCards.map(cardToRow).filter(Boolean);
    } else if (currentMode === "war-decks") {
      const analysis = await fetchJsonOrThrow(
        `/api/player/${encodedTag}/analysis?fast=true`,
      );
      const groups = extractWarDeckGroupsFromBattlelog(
        analysis?.battleLog,
        cardById,
      );
      renderWarDeckGroupsForCurrentMode(groups);

      if (!groups.length) {
        globalError.textContent =
          "Aucun deck GDC trouvé dans l'historique des 30 derniers combats.";
      }
      return;
    }

    renderRowsForCurrentMode(rows);
  } catch (err) {
    globalError.textContent =
      err?.message || "Impossible de charger les données joueur.";
  } finally {
    loadPlayerBtn.disabled = false;
    loadPlayerBtn.textContent = previousLabel;
  }
}

function getRowPayload(row) {
  const rarity =
    row.dataset.lockType === "true"
      ? row.dataset.rarity
      : row.querySelector(".rarity").value;
  const currentLevel = Number.parseInt(
    row.querySelector(".current-level").value,
    10,
  );
  const currentCards = Number.parseInt(
    row.querySelector(".current-cards").value,
    10,
  );
  const targetLevel = Number.parseInt(
    row.querySelector(".target-level").value,
    10,
  );

  return { rarity, currentLevel, currentCards, targetLevel };
}

function computeMissingCards({
  rarity,
  currentLevel,
  currentCards,
  targetLevel,
}) {
  const conf = RARITY_CONFIG[rarity];
  let total = 0;

  for (let level = currentLevel; level < targetLevel; level += 1) {
    total += conf.upgrades[level] ?? 0;
  }

  const nextLevelRequirement = conf.upgrades[currentLevel] ?? 0;
  const usableCurrentCards = Math.min(
    Math.max(currentCards, 0),
    nextLevelRequirement,
  );

  return Math.max(0, total - usableCurrentCards);
}

function computeMissingGold({ rarity, currentLevel, targetLevel }) {
  const conf = RARITY_CONFIG[rarity];
  let total = 0;

  for (let level = currentLevel; level < targetLevel; level += 1) {
    total += conf.goldUpgrades[level] ?? 0;
  }

  return total;
}

function getJokersByRarity() {
  const jokers = {};
  RARITY_ORDER.forEach((rarity) => {
    const raw = Number.parseInt(jokerInputs[rarity]?.value ?? "0", 10);
    jokers[rarity] = Number.isInteger(raw) && raw > 0 ? raw : 0;
  });
  return jokers;
}

function saveJokerPrefsToStorage() {
  try {
    const payload = {
      strategy: getJokerStrategy(),
      jokers: getJokersByRarity(),
    };
    localStorage.setItem(JOKER_PREFS_STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // Ignore storage errors (private mode, quota, etc.)
  }
}

function loadJokerPrefsFromStorage() {
  try {
    const raw = localStorage.getItem(JOKER_PREFS_STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);

    if (
      parsed?.strategy === "max-completed" ||
      parsed?.strategy === "priority-max-level"
    ) {
      jokerStrategySelect.value = parsed.strategy;
    }

    RARITY_ORDER.forEach((rarity) => {
      const value = Number.parseInt(parsed?.jokers?.[rarity], 10);
      if (jokerInputs[rarity]) {
        jokerInputs[rarity].value =
          Number.isInteger(value) && value >= 0 ? String(value) : "0";
      }
    });
  } catch {
    // Ignore malformed JSON or storage errors.
  }
}

function clearJokerPrefsFromStorage() {
  try {
    localStorage.removeItem(JOKER_PREFS_STORAGE_KEY);
  } catch {
    // Ignore storage errors.
  }
}

function getJokerStrategy() {
  const strategy = jokerStrategySelect?.value;
  return strategy === "priority-max-level"
    ? "priority-max-level"
    : "max-completed";
}

function allocateJokers(detailRows, jokersByRarity, strategy) {
  const jokersUsedByRarity = {
    common: 0,
    rare: 0,
    epic: 0,
    legendary: 0,
    champion: 0,
  };

  const byRarity = {
    common: [],
    rare: [],
    epic: [],
    legendary: [],
    champion: [],
  };

  detailRows.forEach((row) => {
    if (row.missingCards > 0) byRarity[row.rarity].push(row);
  });

  RARITY_ORDER.forEach((rarity) => {
    let available = jokersByRarity[rarity] ?? 0;
    if (available <= 0) return;

    if (strategy === "priority-max-level") {
      // Favorise les cartes déjà proches du niveau max (niveau courant élevé),
      // puis celles qui demandent le moins de jokers restants.
      byRarity[rarity].sort((a, b) => {
        if (b.currentLevel !== a.currentLevel) {
          return b.currentLevel - a.currentLevel;
        }
        if (b.targetLevel !== a.targetLevel) {
          return b.targetLevel - a.targetLevel;
        }
        return a.remainingCards - b.remainingCards;
      });
    } else {
      // Stratégie par défaut: compléter le plus de cartes possible.
      byRarity[rarity].sort((a, b) => {
        if (a.remainingCards !== b.remainingCards) {
          return a.remainingCards - b.remainingCards;
        }
        return b.currentLevel - a.currentLevel;
      });
    }

    byRarity[rarity].forEach((row) => {
      if (available <= 0) return;
      const use = Math.min(available, row.remainingCards);
      row.jokersUsed += use;
      row.remainingCards -= use;
      available -= use;
      jokersUsedByRarity[rarity] += use;
    });
  });

  return jokersUsedByRarity;
}

function validateRow(payload, options = {}) {
  const conf = RARITY_CONFIG[payload.rarity];
  const allowSameLevel = options.allowSameLevel === true;

  if (
    !Number.isInteger(payload.currentLevel) ||
    !Number.isInteger(payload.targetLevel)
  ) {
    return "Les niveaux doivent être des entiers.";
  }

  if (!Number.isInteger(payload.currentCards) || payload.currentCards < 0) {
    return "Le nombre de cartes actuelles doit être un entier positif.";
  }

  if (
    payload.currentLevel < conf.minLevel ||
    payload.currentLevel > conf.maxLevel
  ) {
    return `Pour ${conf.label}, le niveau actuel doit être entre ${conf.minLevel} et ${conf.maxLevel}.`;
  }

  if (
    payload.targetLevel < conf.minLevel ||
    payload.targetLevel > conf.maxLevel
  ) {
    return `Pour ${conf.label}, le niveau souhaité doit être entre ${conf.minLevel} et ${conf.maxLevel}.`;
  }

  if (allowSameLevel) {
    if (payload.targetLevel < payload.currentLevel) {
      return "Le niveau souhaité ne peut pas être inférieur au niveau actuel.";
    }
    return "";
  }

  if (payload.targetLevel <= payload.currentLevel) {
    return "Le niveau souhaité doit être supérieur au niveau actuel.";
  }

  return "";
}

function renderSummary(totalsByRarity, goldByRarity, jokersUsedByRarity) {
  summaryGrid.innerHTML = "";

  RARITY_ORDER.forEach((rarity) => {
    const card = document.createElement("article");
    card.className = "summary-card";

    const label = document.createElement("p");
    label.className = "label";
    label.textContent = RARITY_CONFIG[rarity].label;

    const value = document.createElement("p");
    value.className = "value";
    value.textContent = `${totalsByRarity[rarity].toLocaleString("fr-FR")} cartes`;

    const goldValue = document.createElement("p");
    goldValue.className = "gold-value";
    goldValue.textContent = `${goldByRarity[rarity].toLocaleString("fr-FR")} or`;

    const jokerValue = document.createElement("p");
    jokerValue.className = "joker-value";
    jokerValue.textContent = `Jokers utilisés : ${jokersUsedByRarity[rarity].toLocaleString("fr-FR")}`;

    card.append(label, value, goldValue, jokerValue);
    summaryGrid.appendChild(card);
  });
}

function renderDetails(detailRows) {
  detailsBody.innerHTML = "";

  detailRows.forEach((rowData, idx) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${idx + 1}</td>
      <td>${RARITY_CONFIG[rowData.rarity].label}</td>
      <td>${rowData.currentLevel}</td>
      <td>${rowData.targetLevel}</td>
      <td>${rowData.currentCards.toLocaleString("fr-FR")}</td>
      <td>${rowData.missingCards.toLocaleString("fr-FR")}</td>
      <td>${rowData.jokersUsed.toLocaleString("fr-FR")}</td>
      <td>${rowData.remainingCards.toLocaleString("fr-FR")}</td>
      <td>${rowData.missingGold.toLocaleString("fr-FR")}</td>
    `;
    detailsBody.appendChild(tr);
  });
}

function runCalculation({ useJokers = false } = {}) {
  clearErrors();

  const rowElements = Array.from(rowsBody.querySelectorAll("tr"));
  const activeRows = rowElements.filter(
    (row) => row.dataset.touched === "true",
  );

  if (!activeRows.length) {
    globalError.textContent =
      "Aucune carte active. Modifiez au moins une ligne avant de calculer.";
    results.classList.add("hidden");
    return;
  }

  const totalsByRarity = {
    common: 0,
    rare: 0,
    epic: 0,
    legendary: 0,
    champion: 0,
  };
  const goldByRarity = {
    common: 0,
    rare: 0,
    epic: 0,
    legendary: 0,
    champion: 0,
  };

  let hasError = false;
  const detailRows = [];

  activeRows.forEach((row) => {
    const payload = getRowPayload(row);
    const rowError = validateRow(payload, {
      allowSameLevel: row.dataset.lockType === "true",
    });

    if (rowError) {
      row.querySelector(".row-error").textContent = rowError;
      hasError = true;
      return;
    }

    const missingCards = computeMissingCards(payload);
    const missingGold = computeMissingGold(payload);
    totalsByRarity[payload.rarity] += missingCards;
    goldByRarity[payload.rarity] += missingGold;
    detailRows.push({
      ...payload,
      missingCards,
      missingGold,
      jokersUsed: 0,
      remainingCards: missingCards,
    });
  });

  if (hasError) {
    globalError.textContent =
      "Corrigez les erreurs du tableau avant de calculer.";
    results.classList.add("hidden");
    return;
  }

  const jokersUsedByRarity = {
    common: 0,
    rare: 0,
    epic: 0,
    legendary: 0,
    champion: 0,
  };

  if (useJokers) {
    const jokersByRarity = getJokersByRarity();
    const strategy = getJokerStrategy();
    const allocated = allocateJokers(detailRows, jokersByRarity, strategy);
    RARITY_ORDER.forEach((rarity) => {
      jokersUsedByRarity[rarity] = allocated[rarity];
    });

    RARITY_ORDER.forEach((rarity) => {
      totalsByRarity[rarity] = detailRows
        .filter((row) => row.rarity === rarity)
        .reduce((sum, row) => sum + row.remainingCards, 0);
    });
  }

  const totalGold = Object.values(goldByRarity).reduce(
    (sum, value) => sum + value,
    0,
  );
  if (totalGoldEl) {
    totalGoldEl.textContent = `${totalGold.toLocaleString("fr-FR")} or`;
  }

  const totalJokersUsed = Object.values(jokersUsedByRarity).reduce(
    (sum, value) => sum + value,
    0,
  );
  if (totalJokersUsedEl) {
    totalJokersUsedEl.textContent = totalJokersUsed.toLocaleString("fr-FR");
  }

  renderSummary(totalsByRarity, goldByRarity, jokersUsedByRarity);
  renderDetails(detailRows);
  results.classList.remove("hidden");
}

function handleCalculate() {
  runCalculation({ useJokers: false });
}

function handleOptimizeJokers() {
  runCalculation({ useJokers: true });
}

function handleReset() {
  rowsBody.innerHTML = "";
  clearErrors();
  results.classList.add("hidden");
  modeRowsCache.manual = null;
  modeRowsCache["current-deck"] = null;
  modeRowsCache["war-decks"] = null;
  modeRowsCache.collection = null;
  if (totalGoldEl) {
    totalGoldEl.textContent = "0 or";
  }
  if (totalJokersUsedEl) {
    totalJokersUsedEl.textContent = "0";
  }
  RARITY_ORDER.forEach((rarity) => {
    if (jokerInputs[rarity]) jokerInputs[rarity].value = "0";
  });
  if (jokerStrategySelect) {
    jokerStrategySelect.value = "max-completed";
  }
  clearJokerPrefsFromStorage();
  createRow({
    rarity: "common",
    currentLevel: 10,
    currentCards: 0,
    targetLevel: 16,
  });
}

addRowBtn.addEventListener("click", () => createRow());
calculateBtn.addEventListener("click", handleCalculate);
optimizeJokersBtn.addEventListener("click", handleOptimizeJokers);
resetBtn.addEventListener("click", handleReset);
loadPlayerBtn.addEventListener("click", handleLoadPlayerData);

modeTabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    setActiveMode(tab.dataset.mode);
  });
});

if (playerTagInput) {
  playerTagInput.addEventListener("change", () => {
    const normalized = normalizeTag(playerTagInput.value);
    if (normalized) {
      playerTagInput.value = normalized;
      savePlayerTagToStorage(normalized);
      maybeAutoLoadActiveMode();
    } else if (isAutoMode(currentMode)) {
      showMissingTagState();
    }
  });
}

if (jokerStrategySelect) {
  jokerStrategySelect.addEventListener("change", saveJokerPrefsToStorage);
}

RARITY_ORDER.forEach((rarity) => {
  if (jokerInputs[rarity]) {
    jokerInputs[rarity].addEventListener("input", saveJokerPrefsToStorage);
    jokerInputs[rarity].addEventListener("change", saveJokerPrefsToStorage);
  }
});

loadJokerPrefsFromStorage();
loadPlayerTagFromStorage();
setActiveMode("manual");

createRow({
  rarity: "common",
  currentLevel: 10,
  currentCards: 0,
  targetLevel: 16,
});
