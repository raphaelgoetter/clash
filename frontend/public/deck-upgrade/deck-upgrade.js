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
let currentMode = "manual";

function normalizeTag(raw) {
  if (!raw) return null;
  const clean = String(raw).trim().toUpperCase().replace(/^#+/, "");
  if (!clean) return null;
  return `#${clean}`;
}

function setActiveMode(mode) {
  currentMode = mode;
  modeTabs.forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.mode === mode);
  });
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

  const currentLevel = Number.parseInt(card?.level, 10);
  const safeLevel = Number.isInteger(currentLevel)
    ? currentLevel
    : conf.minLevel;
  const currentCardsRaw = Number.parseInt(card?.count, 10);
  const currentCards = Number.isInteger(currentCardsRaw) ? currentCardsRaw : 0;
  const targetLevel = conf.maxLevel;

  if (safeLevel >= targetLevel) return null;

  return {
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

function replaceRows(rows) {
  rowsBody.innerHTML = "";
  clearErrors();
  results.classList.add("hidden");

  if (!rows.length) {
    createRow({
      rarity: "common",
      currentLevel: 10,
      currentCards: 0,
      targetLevel: 16,
    });
    return;
  }

  rows.forEach((row) => {
    createRow(row, { touched: true });
  });
}

function extractWarDeckCardsFromBattlelog(battleLog, cardById) {
  const gdcTypes = new Set([
    "riverracepvp",
    "riverraceduel",
    "riverraceduelscolosseum",
    "riverraceboat",
    "clanwarbattle",
  ]);
  const uniqueCardIds = new Set();

  (Array.isArray(battleLog) ? battleLog : []).forEach((battle) => {
    const type = String(battle?.type || "").toLowerCase();
    if (!gdcTypes.has(type)) return;

    const cards = Array.isArray(battle?.team?.[0]?.cards)
      ? battle.team[0].cards
      : [];
    cards.forEach((card) => {
      if (card?.id) uniqueCardIds.add(card.id);
    });
  });

  const rows = [];
  uniqueCardIds.forEach((id) => {
    const card = cardById.get(id);
    if (!card) return;
    const row = cardToRow(card);
    if (row) rows.push(row);
  });
  return sortRowsByPriority(rows);
}

function createRow(defaultValues = null, options = {}) {
  const fragment = rowTemplate.content.cloneNode(true);
  const row = fragment.querySelector("tr");
  row.dataset.touched = options.touched ? "true" : "false";

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
  }

  row.querySelector(".remove-row").addEventListener("click", () => {
    row.remove();
    if (!rowsBody.children.length) createRow();
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
    globalError.textContent =
      "Sélectionnez un onglet auto (Deck actuel, Decks GDC, Collection entière) pour charger des données joueur.";
    return;
  }

  const normalizedTag = normalizeTag(playerTagInput?.value);
  if (!normalizedTag) {
    globalError.textContent =
      "Renseignez un tag joueur valide (ex: #YRGJGR8R).";
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
      if (card?.id) cardById.set(card.id, card);
    });

    let rows = [];

    if (currentMode === "current-deck") {
      const deckCards = Array.isArray(player.currentDeck)
        ? player.currentDeck
        : [];
      rows = sortRowsByPriority(
        deckCards
          .map((deckCard) => cardById.get(deckCard.id) || deckCard)
          .map(cardToRow)
          .filter(Boolean),
      );
    } else if (currentMode === "collection") {
      rows = sortRowsByPriority(allCards.map(cardToRow).filter(Boolean));
    } else if (currentMode === "war-decks") {
      const analysis = await fetchJsonOrThrow(
        `/api/player/${encodedTag}/analysis?fast=true`,
      );
      rows = extractWarDeckCardsFromBattlelog(analysis?.battleLog, cardById);
      if (!rows.length) {
        globalError.textContent =
          "Aucune carte GDC trouvée dans la fenêtre du battlelog (données API limitées).";
      }
    }

    replaceRows(rows);
  } catch (err) {
    globalError.textContent =
      err?.message || "Impossible de charger les données joueur.";
  } finally {
    loadPlayerBtn.disabled = false;
    loadPlayerBtn.textContent = previousLabel;
  }
}

function getRowPayload(row) {
  const rarity = row.querySelector(".rarity").value;
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

function validateRow(payload) {
  const conf = RARITY_CONFIG[payload.rarity];

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
    const rowError = validateRow(payload);

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
