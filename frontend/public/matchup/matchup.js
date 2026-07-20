const API_BASE = "/api/matchup";
const statusEl = document.getElementById("status");
const winconGrid = document.getElementById("wincon-grid");
const detailSection = document.getElementById("matchup-detail");
const detailTitle = document.getElementById("detail-title");
const detailArchetype = document.getElementById("detail-archetype");
const detailVariants = document.getElementById("detail-variants");
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

// Affiche archetype + hard/soft-counters d'un "profil" — soit la win
// condition seule (base), soit l'une de ses variantes (ex. Balloon + Lava
// Hound = "LavaLoon") — sans re-fetch, tout est déjà chargé en mémoire.
function applyProfile(profile) {
  detailArchetype.textContent = profile.archetype || "?";
  detailHard.innerHTML = profile.hardCounters.length
    ? profile.hardCounters.map(renderCounterItem).join("")
    : `<li class="matchup-card-item"><div>Aucun hard-counter recensé.</div></li>`;
  detailSoft.innerHTML = profile.softCounters.length
    ? profile.softCounters.map(renderCounterItem).join("")
    : `<li class="matchup-card-item"><div>Aucun soft-counter recensé.</div></li>`;
}

function companionLabel(companion) {
  return (companion || []).map((c) => c.name).join(" / ");
}

// Boutons "Seul" + un par variante (compagnon présent dans le même deck) —
// cliquer change le profil affiché (archetype + counters) sans recharger la
// grille. cf. resolveWinConditionVariant côté moteur (matchupEngine.js).
function renderVariantSelector(wc) {
  const variants = Array.isArray(wc.variants) ? wc.variants : [];
  if (variants.length === 0) {
    detailVariants.classList.add("matchup-hidden");
    detailVariants.innerHTML = "";
    return;
  }

  const options = [
    { label: "Seul", profile: wc },
    ...variants.map((variant) => ({
      label: `+ ${companionLabel(variant.companion)}`,
      profile: variant,
    })),
  ];

  detailVariants.innerHTML = "";
  options.forEach((option, index) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "matchup-variant-btn";
    if (index === 0) btn.classList.add("selected");
    btn.textContent = option.label;
    btn.addEventListener("click", () => {
      detailVariants
        .querySelectorAll(".matchup-variant-btn")
        .forEach((el) => el.classList.remove("selected"));
      btn.classList.add("selected");
      applyProfile(option.profile);
    });
    detailVariants.appendChild(btn);
  });
  detailVariants.classList.remove("matchup-hidden");
}

function selectWinCondition(wc, cardEl) {
  if (selectedCardEl) selectedCardEl.classList.remove("selected");
  cardEl.classList.add("selected");
  selectedCardEl = cardEl;

  detailTitle.textContent = wc.name;
  renderVariantSelector(wc);
  applyProfile(wc);
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
