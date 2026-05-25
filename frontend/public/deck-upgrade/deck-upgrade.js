const rowsBody = document.getElementById("rows-body");
const rowTemplate = document.getElementById("row-template");
const addRowBtn = document.getElementById("add-row-btn");
const calculateBtn = document.getElementById("calculate-btn");
const resetBtn = document.getElementById("reset-btn");
const globalError = document.getElementById("global-error");
const results = document.getElementById("results");
const summaryGrid = document.getElementById("summary-grid");
const detailsBody = document.getElementById("details-body");

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
      11: 2000,
      12: 5000,
      13: 10000,
      14: 25000,
      15: 50000,
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
      10: 400,
      11: 800,
      12: 1000,
      13: 2000,
      14: 5000,
      15: 10000,
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
      10: 50,
      11: 100,
      12: 200,
      13: 400,
      14: 800,
      15: 1000,
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
      12: 10,
      13: 20,
      14: 40,
      15: 80,
    },
  },
  champion: {
    label: "Champion",
    minLevel: 11,
    maxLevel: 16,
    upgrades: {
      11: 2,
      12: 4,
      13: 8,
      14: 10,
      15: 20,
    },
  },
};

const RARITY_ORDER = ["common", "rare", "epic", "legendary", "champion"];

function createRow(defaultValues = null) {
  const fragment = rowTemplate.content.cloneNode(true);
  const row = fragment.querySelector("tr");

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

function computeMissingCards({ rarity, currentLevel, currentCards, targetLevel }) {
  const conf = RARITY_CONFIG[rarity];
  let total = 0;

  for (let level = currentLevel; level < targetLevel; level += 1) {
    total += conf.upgrades[level] ?? 0;
  }

  const nextLevelRequirement = conf.upgrades[currentLevel] ?? 0;
  const usableCurrentCards = Math.min(Math.max(currentCards, 0), nextLevelRequirement);

  return Math.max(0, total - usableCurrentCards);
}

function validateRow(payload) {
  const conf = RARITY_CONFIG[payload.rarity];

  if (!Number.isInteger(payload.currentLevel) || !Number.isInteger(payload.targetLevel)) {
    return "Les niveaux doivent être des entiers.";
  }

  if (!Number.isInteger(payload.currentCards) || payload.currentCards < 0) {
    return "Le nombre de cartes actuelles doit être un entier positif.";
  }

  if (payload.currentLevel < conf.minLevel || payload.currentLevel > conf.maxLevel) {
    return `Pour ${conf.label}, le niveau actuel doit être entre ${conf.minLevel} et ${conf.maxLevel}.`;
  }

  if (payload.targetLevel < conf.minLevel || payload.targetLevel > conf.maxLevel) {
    return `Pour ${conf.label}, le niveau souhaité doit être entre ${conf.minLevel} et ${conf.maxLevel}.`;
  }

  if (payload.targetLevel <= payload.currentLevel) {
    return "Le niveau souhaité doit être supérieur au niveau actuel.";
  }

  return "";
}

function renderSummary(totalsByRarity) {
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

    card.append(label, value);
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
    `;
    detailsBody.appendChild(tr);
  });
}

function handleCalculate() {
  clearErrors();

  const rowElements = Array.from(rowsBody.querySelectorAll("tr"));
  const totalsByRarity = {
    common: 0,
    rare: 0,
    epic: 0,
    legendary: 0,
    champion: 0,
  };

  let hasError = false;
  const detailRows = [];

  rowElements.forEach((row) => {
    const payload = getRowPayload(row);
    const rowError = validateRow(payload);

    if (rowError) {
      row.querySelector(".row-error").textContent = rowError;
      hasError = true;
      return;
    }

    const missingCards = computeMissingCards(payload);
    totalsByRarity[payload.rarity] += missingCards;
    detailRows.push({ ...payload, missingCards });
  });

  if (hasError) {
    globalError.textContent = "Corrigez les erreurs du tableau avant de calculer.";
    results.classList.add("hidden");
    return;
  }

  renderSummary(totalsByRarity);
  renderDetails(detailRows);
  results.classList.remove("hidden");
}

function handleReset() {
  rowsBody.innerHTML = "";
  clearErrors();
  results.classList.add("hidden");
  createRow({
    rarity: "common",
    currentLevel: 10,
    currentCards: 0,
    targetLevel: 16,
  });
}

addRowBtn.addEventListener("click", () => createRow());
calculateBtn.addEventListener("click", handleCalculate);
resetBtn.addEventListener("click", handleReset);

createRow({
  rarity: "common",
  currentLevel: 10,
  currentCards: 30,
  targetLevel: 16,
});
createRow({
  rarity: "common",
  currentLevel: 10,
  currentCards: 0,
  targetLevel: 16,
});
createRow({
  rarity: "common",
  currentLevel: 10,
  currentCards: 0,
  targetLevel: 16,
});
createRow({
  rarity: "common",
  currentLevel: 10,
  currentCards: 0,
  targetLevel: 16,
});
createRow({
  rarity: "rare",
  currentLevel: 10,
  currentCards: 0,
  targetLevel: 16,
});
createRow({
  rarity: "rare",
  currentLevel: 10,
  currentCards: 0,
  targetLevel: 16,
});
createRow({
  rarity: "epic",
  currentLevel: 10,
  currentCards: 0,
  targetLevel: 16,
});
createRow({
  rarity: "legendary",
  currentLevel: 10,
  currentCards: 0,
  targetLevel: 16,
});
