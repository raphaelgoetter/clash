const rowsBody = document.getElementById("rows-body");
const rowTemplate = document.getElementById("row-template");
const addRowBtn = document.getElementById("add-row-btn");
const calculateBtn = document.getElementById("calculate-btn");
const optimizeJokersBtn = document.getElementById("optimize-jokers-btn");
const resetBtn = document.getElementById("reset-btn");
const globalError = document.getElementById("global-error");
const results = document.getElementById("results");
const summaryGrid = document.getElementById("summary-grid");
const detailsBody = document.getElementById("details-body");
const totalGoldEl = document.getElementById("total-gold");
const totalJokersUsedEl = document.getElementById("total-jokers-used");
const jokerStrategySelect = document.getElementById("joker-strategy");

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

function createRow(defaultValues = null) {
  const fragment = rowTemplate.content.cloneNode(true);
  const row = fragment.querySelector("tr");
  row.dataset.touched = "false";

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

createRow({
  rarity: "common",
  currentLevel: 10,
  currentCards: 0,
  targetLevel: 16,
});
