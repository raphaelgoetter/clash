const API_BASE = "/api/matchup";
const statusEl = document.getElementById("status");
const winconGrid = document.getElementById("wincon-grid");
const detailSection = document.getElementById("matchup-detail");
const detailTitle = document.getElementById("detail-title");
const detailArchetype = document.getElementById("detail-archetype");
const detailHard = document.getElementById("detail-hard");
const detailSoft = document.getElementById("detail-soft");

let selectedCardEl = null;

const RARITY_LABEL = {
  common: "Commune",
  rare: "Rare",
  epic: "Épique",
  legendary: "Légendaire",
  champion: "Champion",
};

function setStatus(message, isError = false) {
  statusEl.textContent = message || "";
  statusEl.style.color = isError ? "#ff8a80" : "var(--accent)";
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Erreur ${res.status}`);
  }
  return res.json();
}

function rarityLabel(rarity) {
  if (!rarity) return null;
  return RARITY_LABEL[rarity] || rarity;
}

function renderWinConCard(wc) {
  const el = document.createElement("button");
  el.type = "button";
  el.className = "wincon-card";
  el.innerHTML = `
    ${
      wc.icon?.url
        ? `<img class="wincon-card-icon" src="${wc.icon.url}" alt="${wc.name}" />`
        : `<div class="wincon-card-icon wincon-card-placeholder"></div>`
    }
    <span class="wincon-card-name">${wc.name}</span>
  `;
  el.addEventListener("click", () => selectWinCondition(wc, el));
  return el;
}

function renderCounterItem(counter) {
  const label = rarityLabel(counter.icon?.rarity);
  return `
    <li class="matchup-card-item">
      ${
        counter.icon?.url
          ? `<img class="matchup-card-icon" src="${counter.icon.url}" alt="${counter.name}" />`
          : ""
      }
      <div>
        <strong>${counter.name}</strong>
        ${label ? `<div class="matchup-card-type">${label}</div>` : ""}
      </div>
    </li>
  `;
}

function selectWinCondition(wc, cardEl) {
  if (selectedCardEl) selectedCardEl.classList.remove("selected");
  cardEl.classList.add("selected");
  selectedCardEl = cardEl;

  detailTitle.textContent = wc.name;
  detailArchetype.textContent = wc.archetype || "?";
  detailHard.innerHTML = wc.hardCounters.length
    ? wc.hardCounters.map(renderCounterItem).join("")
    : `<li class="matchup-card-item"><div>Aucun hard-counter recensé.</div></li>`;
  detailSoft.innerHTML = wc.softCounters.length
    ? wc.softCounters.map(renderCounterItem).join("")
    : `<li class="matchup-card-item"><div>Aucun soft-counter recensé.</div></li>`;
  detailSection.classList.remove("matchup-hidden");
  detailSection.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

async function init() {
  setStatus("Chargement du catalogue…");
  try {
    const payload = await fetchJson(`${API_BASE}/catalog`);
    const winConditions = Array.isArray(payload.winConditions)
      ? payload.winConditions
      : [];
    winconGrid.innerHTML = "";
    for (const wc of winConditions) {
      winconGrid.appendChild(renderWinConCard(wc));
    }
    setStatus(`${winConditions.length} win conditions chargées.`);
  } catch (err) {
    setStatus(err.message || "Erreur de chargement.", true);
  }
}

init();
