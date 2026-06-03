const API_BASE = "/api/decks";
const statusEl = document.getElementById("status");
const topDecksSection = document.getElementById("top-decks-section");
const topDecksContainer = document.getElementById("top-decks-container");
const loadTopDecksBtn = document.getElementById("load-top-decks-btn");
const topLocationSelect = document.getElementById("top-location-select");
const topSortSelect = document.getElementById("top-sort-select");
const topDecksLoader = document.getElementById("top-decks-loader");
const topDecksLoaderFill = document.getElementById("top-decks-loader-fill");
const topDecksLoaderLabel = document.getElementById("top-decks-loader-label");
let topDecksPayload = null;
let selectedTopDeckCard = null;
let topDecksLoaderInterval = null;
let topDecksLoaderProgress = 0;

function normalizeTag(raw) {
  if (!raw || typeof raw !== "string") return "";
  return raw.trim().replace(/^#/, "").toUpperCase();
}

function setStatus(message, isError = false) {
  statusEl.textContent = message || "";
  statusEl.style.color = isError ? "#ff8a80" : "var(--accent)";
}

function clearSection(section, container) {
  section.classList.add("hidden");
  container.innerHTML = "";
}

function showSection(section) {
  section.classList.remove("hidden");
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Erreur ${res.status}`);
  }
  return res.json();
}

const RARITY_OFFSET = {
  common: 0,
  rare: 2,
  epic: 5,
  legendary: 8,
  champion: 10,
};

const RARITY_MAX = {
  common: 16,
  rare: 16,
  epic: 16,
  legendary: 16,
  champion: 16,
};

function normalizeCardLevel(card) {
  const rarity = String(card?.rarity || "").toLowerCase();
  const rawLevel = Number.parseInt(card?.level, 10);
  if (!Number.isFinite(rawLevel) || !(rarity in RARITY_OFFSET)) return null;
  const normalized = rawLevel + (RARITY_OFFSET[rarity] ?? 0);
  return Math.min(RARITY_MAX[rarity] ?? normalized, Math.max(1, normalized));
}

function selectCardIconUrl(card) {
  if (!card?.iconUrls) return null;
  return (
    card.iconUrls.medium || card.iconUrls.large || card.iconUrls.small || null
  );
}

function renderCardItem(card) {
  const type = card.type || "utility";
  const level = normalizeCardLevel(card);
  const iconUrl = selectCardIconUrl(card);
  return `
    <li class="card-item">
      ${iconUrl ? `<img class="card-icon" src="${iconUrl}" alt="${card.name}" />` : ""}
      <div>
        <strong>${card.name}</strong>
        <div class="card-type">${type}</div>
        ${level ? `<div>Niveau ${level}</div>` : ""}
      </div>
    </li>
  `;
}

function renderCurrentDeck(payload) {
  const current = payload.currentDeck;
  const player = payload.player;
  currentDeckContainer.innerHTML = `
    <div class="deck-card">
      <h3>${player.name} (${player.tag})</h3>
      <p>${current.samplePlays > 0 ? `Winrate estimé (tous combats) : ${current.winRateEstimate}% sur ${current.samplePlays} parties` : "Aucune estimation de winrate disponible."}</p>
      <div class="card-list">
        ${current.cards.map(renderCardItem).join("")}
      </div>
      ${
        current.suggestions?.length > 0
          ? `
      <div class="deck-card-footer">
        <strong>Suggestions :</strong>
        <ul>
          ${current.suggestions.map((line) => `<li>${line}</li>`).join("")}
        </ul>
      </div>
      `
          : ""
      }
    </div>
  `;
  showSection(currentDeckSection);
}

function renderWarDecks(payload) {
  const warDecks = payload.warDecks || [];
  if (warDecks.length === 0) {
    warDecksContainer.innerHTML =
      "<p>Aucun deck GDC récent trouvé dans le battle log.</p>";
    showSection(warDecksSection);
    return;
  }
  warDecksContainer.innerHTML = `
    <div class="deck-grid">
      ${warDecks
        .map(
          (deck) => `
          <div class="deck-card">
            <h3>${deck.label}</h3>
            <p>Joué ${deck.plays} fois • Winrate ${deck.winRate}%</p>
            <ul class="top-decks-list">
              ${deck.cardNames.map((name) => `<li>${name}</li>`).join("")}
            </ul>
          </div>
        `,
        )
        .join("")}
    </div>
  `;
  showSection(warDecksSection);
}

function renderTopDeckCard(card) {
  const isSelected = selectedTopDeckCard
    ? card.name.toLowerCase() === selectedTopDeckCard.toLowerCase()
    : false;
  return `
    <li class="top-deck-card-item${isSelected ? " selected" : ""}" data-card-name="${card.name}">
      ${card.iconUrl ? `<img class="top-deck-card-icon" src="${card.iconUrl}" alt="${card.name}" />` : ""}
      <span>${card.name}</span>
    </li>
  `;
}

function sortTopDecks(decks) {
  const mode = topSortSelect?.value || "usage";
  if (mode === "winrate") {
    return [...decks].sort((a, b) => {
      if (b.winRate !== a.winRate) return b.winRate - a.winRate;
      if (b.plays !== a.plays) return b.plays - a.plays;
      return a.signature.localeCompare(b.signature);
    });
  }
  return [...decks].sort((a, b) => {
    if (b.plays !== a.plays) return b.plays - a.plays;
    if (b.winRate !== a.winRate) return b.winRate - a.winRate;
    return a.signature.localeCompare(b.signature);
  });
}

function startTopDecksLoader() {
  if (!topDecksLoader || !topDecksLoaderFill || !topDecksLoaderLabel) return;
  clearInterval(topDecksLoaderInterval);
  topDecksLoaderProgress = 0;
  topDecksLoaderFill.style.width = "0%";
  topDecksLoaderLabel.textContent = "Chargement des top decks... 0%";
  topDecksLoader.classList.remove("hidden");
  topDecksLoaderInterval = window.setInterval(() => {
    topDecksLoaderProgress = Math.min(
      95,
      topDecksLoaderProgress + Math.random() * 8 + 4,
    );
    topDecksLoaderFill.style.width = `${Math.round(topDecksLoaderProgress)}%`;
    topDecksLoaderLabel.textContent = `Chargement des top decks... ${Math.round(
      topDecksLoaderProgress,
    )}%`;
  }, 350);
}

function stopTopDecksLoader(success = true) {
  if (!topDecksLoader || !topDecksLoaderFill || !topDecksLoaderLabel) return;
  clearInterval(topDecksLoaderInterval);
  topDecksLoaderProgress = 100;
  topDecksLoaderFill.style.width = "100%";
  topDecksLoaderLabel.textContent = success
    ? "Top decks chargés."
    : "Erreur de chargement des top decks.";
  window.setTimeout(() => {
    if (topDecksLoader) topDecksLoader.classList.add("hidden");
  }, 600);
}

function renderTopDecks(payload) {
  topDecksPayload = payload;
  const allDecks = sortTopDecks(payload.decks || []);
  const decks = selectedTopDeckCard
    ? allDecks.filter((deck) =>
        (deck.cardList ?? []).some(
          (card) =>
            card.name.toLowerCase() === selectedTopDeckCard.toLowerCase(),
        ),
      )
    : allDecks;
  if (decks.length === 0) {
    topDecksContainer.innerHTML =
      "<p>Aucun top deck n'a pu être agrégé pour cette région.</p>";
    showSection(topDecksSection);
    return;
  }
  topDecksContainer.innerHTML = `
    <div class="deck-card">
      <p>Région : <strong>${payload.location.name}</strong> — ${
        selectedTopDeckCard
          ? `${selectedTopDeckCard} — ${decks.length} decks`
          : `${payload.playersSampled} joueurs analysés — ${payload.decks.length} decks`
      }</p>
    </div>
    <div class="deck-grid">
      ${decks
        .map((deck, index) => {
          const cards =
            deck.cardList ??
            (Array.isArray(deck.cardNames)
              ? deck.cardNames.map((name) => ({ name }))
              : []);
          return `
          <div class="deck-card">
            <p>Utilisé ${deck.plays} fois • Winrate ${deck.winRate}%</p>
            <ul class="top-decks-list">
              ${cards.map(renderTopDeckCard).join("")}
            </ul>
          </div>
        `;
        })
        .join("")}
    </div>
  `;
  showSection(topDecksSection);
  attachTopDeckCardListeners();
}

function attachTopDeckCardListeners() {
  topDecksContainer.querySelectorAll(".top-deck-card-item").forEach((item) => {
    item.addEventListener("click", () => {
      const cardName = String(item.dataset.cardName || "").trim();
      if (!cardName) return;

      if (
        selectedTopDeckCard &&
        selectedTopDeckCard.toLowerCase() === cardName.toLowerCase()
      ) {
        selectedTopDeckCard = null;
      } else {
        selectedTopDeckCard = cardName;
      }
      if (topDecksPayload) renderTopDecks(topDecksPayload);
    });
  });
}

async function handleLoadCurrentDeck() {
  clearSection(warDecksSection, warDecksContainer);
  clearSection(topDecksSection, topDecksContainer);
  currentDeckContainer.innerHTML = "";
  const tag = normalizeTag(playerTagInput.value);
  if (!tag) {
    setStatus("Merci de saisir un tag joueur valide.", true);
    return;
  }
  setStatus("Chargement du deck actuel...");
  try {
    const payload = await fetchJson(
      `${API_BASE}/player/${encodeURIComponent(tag)}`,
    );
    renderCurrentDeck(payload);
    setStatus("Deck actuel chargé.");
  } catch (err) {
    setStatus(err.message, true);
  }
}

async function handleLoadWarDecks() {
  clearSection(currentDeckSection, currentDeckContainer);
  clearSection(topDecksSection, topDecksContainer);
  const tag = normalizeTag(playerTagInput.value);
  if (!tag) {
    setStatus("Merci de saisir un tag joueur valide.", true);
    return;
  }
  setStatus("Chargement des decks GDC...");
  try {
    const payload = await fetchJson(
      `${API_BASE}/player/${encodeURIComponent(tag)}/war-decks`,
    );
    renderWarDecks(payload);
    setStatus("Decks GDC chargés.");
  } catch (err) {
    setStatus(err.message, true);
  }
}

async function handleLoadTopDecks() {
  clearSection(currentDeckSection, currentDeckContainer);
  clearSection(warDecksSection, warDecksContainer);
  const location = topLocationSelect.value;
  setStatus(`Chargement des meilleurs decks pour ${location}...`);
  startTopDecksLoader();
  try {
    const payload = await fetchJson(
      `${API_BASE}/meta/top-war-decks?location=${encodeURIComponent(location)}`,
    );
    renderTopDecks(payload);
    setStatus(`Top decks ${location} chargés.`);
    stopTopDecksLoader(true);
  } catch (err) {
    setStatus(err.message, true);
    stopTopDecksLoader(false);
  }
}

loadTopDecksBtn.addEventListener("click", handleLoadTopDecks);
if (topSortSelect) {
  topSortSelect.addEventListener("change", () => {
    if (topDecksPayload) renderTopDecks(topDecksPayload);
  });
}
