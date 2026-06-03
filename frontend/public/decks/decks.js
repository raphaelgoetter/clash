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
const showGdcAdaptedBtn = document.getElementById("show-gdc-adapted-btn");
let topDecksPayload = null;
let currentGdcGroups = [];
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
    <div class="deck-card-title">
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

function getDeckCardItems(deck) {
  if (Array.isArray(deck.cardList) && deck.cardList.length > 0) {
    return deck.cardList.map((card) => ({
      name: String(card?.name || "").trim(),
      iconUrl: card?.iconUrl || null,
    }));
  }
  if (Array.isArray(deck.cardNames) && deck.cardNames.length > 0) {
    return deck.cardNames.map((name) => ({
      name: String(name || "").trim(),
      iconUrl: null,
    }));
  }
  return [];
}

function formatWinRate(value) {
  const winRate = Number(value);
  if (!Number.isFinite(winRate)) return "0%";
  return `${Math.round(winRate)}%`;
}

function buildGdcAdaptedGroups(decks, groupSize = 4) {
  const items = decks
    .map((deck, index) => {
      const cardItems = getDeckCardItems(deck);
      const normalized = cardItems.map((card) => card.name.toLowerCase());
      return {
        index,
        deck,
        cardItems,
        normalized,
        cardSet: new Set(normalized),
      };
    })
    .sort((a, b) => (b.deck.plays || 0) - (a.deck.plays || 0));

  const groups = [];
  const used = new Set();

  for (let i = 0; i < items.length; i += 1) {
    if (used.has(items[i].index)) continue;
    const group = [items[i]];
    const cardSet = new Set(items[i].normalized);

    for (let j = i + 1; j < items.length && group.length < groupSize; j += 1) {
      if (used.has(items[j].index)) continue;
      const candidate = items[j];
      const overlap = candidate.normalized.some((name) => cardSet.has(name));
      if (!overlap) {
        candidate.normalized.forEach((name) => cardSet.add(name));
        group.push(candidate);
      }
    }

    if (group.length === groupSize) {
      const avgWinRate =
        group.reduce((sum, item) => sum + (Number(item.deck.winRate) || 0), 0) /
        group.length;
      group.avgWinRate = avgWinRate;
      group.totalPlays = group.reduce(
        (sum, item) => sum + (Number(item.deck.plays) || 0),
        0,
      );
      groups.push(group);
      group.forEach((item) => used.add(item.index));
    }
  }

  return groups.sort((a, b) => {
    if (b.avgWinRate !== a.avgWinRate) return b.avgWinRate - a.avgWinRate;
    return b.totalPlays - a.totalPlays;
  });
}

function renderGdcAdaptedGroups(groups) {
  if (!groups || groups.length === 0) {
    return `
      <div class="deck-card">
        <p>Aucun groupe complet de 4 decks adaptés GDC n'a pu être trouvé parmi les decks chargés.</p>
      </div>
    `;
  }

  return `
    <div id="gdc-adapted-section" class="gdc-adapted-section">
      <div class="deck-card">
        <h3>Decks adaptés GDC</h3>
        <p>${groups.length} groupe${groups.length > 1 ? "s" : ""} complet${groups.length > 1 ? "s" : ""} trouvé${groups.length > 1 ? "s" : ""}.</p>
      </div>
      ${groups
        .map(
          (group, groupIndex) => `
          <div class="gdc-group">
            <div class="gdc-group-title">Groupe ${groupIndex + 1} — Winrate moyen ${formatWinRate(group.avgWinRate)}</div>
            <div class="deck-grid gdc-group-grid">
              ${group
                .map((item) => {
                  const cards = item.cardItems;
                  return `
                    <div class="deck-card">
                      <p>Utilisé ${item.deck.plays} fois • Winrate ${item.deck.winRate}%</p>
                      <ul class="top-decks-list">
                        ${cards.map(renderTopDeckCard).join("")}
                      </ul>
                    </div>
                  `;
                })
                .join("")}
            </div>
          </div>
        `,
        )
        .join("")}
    </div>
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

function renderTopDecks(payload, gdcGroups = []) {
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
  const groupSectionHtml = gdcGroups.length
    ? renderGdcAdaptedGroups(gdcGroups)
    : "";

  const decksSectionHtml = gdcGroups.length
    ? ""
    : `
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

  topDecksContainer.innerHTML = `
    <div class="deck-card">
      <p>Région : <strong>${payload.location.name}</strong> — ${
        selectedTopDeckCard
          ? `${selectedTopDeckCard} — ${decks.length} decks`
          : `${payload.playersSampled} joueurs analysés — ${payload.decks.length} decks`
      }</p>
      ${
        payload.topClans && payload.topClans.length > 0
          ? `<p class="deck-source">Source : données agrégées depuis ${payload.playersSampled} joueurs parmi les ${payload.topClans.length} meilleurs clans GDC de la région.</p>`
          : ""
      }
    </div>
    ${groupSectionHtml}
    ${decksSectionHtml}
  `;
  showSection(topDecksSection);
  if (showGdcAdaptedBtn) {
    showGdcAdaptedBtn.classList.remove("hidden");
  }
  attachTopDeckCardListeners();
  if (gdcGroups.length) {
    currentGdcGroups = gdcGroups;
    const groupSection = document.getElementById("gdc-adapted-section");
    groupSection?.scrollIntoView({ behavior: "smooth", block: "start" });
  } else {
    currentGdcGroups = [];
  }
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
      if (topDecksPayload) renderTopDecks(topDecksPayload, currentGdcGroups);
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
  selectedTopDeckCard = null;
  clearSection(topDecksSection, topDecksContainer);
  const location = topLocationSelect.value;
  setStatus(`Chargement des meilleurs decks pour ${location}...`);
  startTopDecksLoader();
  try {
    const payload = await fetchJson(
      `${API_BASE}/meta/top-war-decks?location=${encodeURIComponent(location)}`,
    );
    currentGdcGroups = [];
    renderTopDecks(payload);
    setStatus(`Top decks ${location} chargés.`);
    stopTopDecksLoader(true);
  } catch (err) {
    setStatus(err.message, true);
    stopTopDecksLoader(false);
  }
}

loadTopDecksBtn.addEventListener("click", handleLoadTopDecks);
if (showGdcAdaptedBtn) {
  showGdcAdaptedBtn.addEventListener("click", () => {
    if (!topDecksPayload) {
      setStatus(
        "Merci de charger les top decks avant de générer des decks adaptés GDC.",
        true,
      );
      return;
    }

    const allDecks = sortTopDecks(topDecksPayload.decks || []);
    const decks = selectedTopDeckCard
      ? allDecks.filter((deck) =>
          (deck.cardList ?? []).some(
            (card) =>
              card.name.toLowerCase() === selectedTopDeckCard.toLowerCase(),
          ),
        )
      : allDecks;

    const groups = buildGdcAdaptedGroups(decks, 4);
    if (groups.length === 0) {
      setStatus(
        "Aucun groupe complet GDC trouvé parmi les decks chargés.",
        true,
      );
    } else {
      setStatus(
        `Decks adaptés GDC générés : ${groups.length} groupe${
          groups.length > 1 ? "s" : ""
        }.`,
      );
    }
    renderTopDecks(topDecksPayload, groups);
  });
}
if (topSortSelect) {
  topSortSelect.addEventListener("change", () => {
    selectedTopDeckCard = null;
    currentGdcGroups = [];
    if (topDecksPayload) renderTopDecks(topDecksPayload);
  });
}
