import fetch from "node-fetch";

// Offsets de normalisation : niveau affiché = api_level + offset
// Débloquer une carte : Common=1pt, Rare=3pts, Epic=6pts, Legendary=9pts, Champion=11pts
// → offset = niveau_debut - 1 : Common +0, Rare +2, Epic +5, Legendary +8, Champion +10
const RARITY_OFFSET = {
  common: 0,
  rare: 2,
  epic: 5,
  legendary: 8,
  champion: 10,
};
const normLevel = (c) => c.level + (RARITY_OFFSET[c.rarity] ?? 0);

const key = process.env.CLASH_API_KEY?.trim();
if (!key) {
  console.error("CLASH_API_KEY manquant");
  process.exit(1);
}

const res = await fetch("https://proxy.royaleapi.dev/v1/players/%23YRGJGR8R", {
  headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
});
const data = await res.json();

if (data.reason) {
  console.error("Erreur API:", data.reason, data.message);
  process.exit(1);
}

const cards = data.cards || [];
const supportCards = data.currentDeckSupportCards || [];
const allCards = [...cards, ...supportCards];

// Niveaux normalisés
const normDist = {};
for (let i = 1; i <= 16; i++) normDist[i] = 0;
allCards.forEach((c) => {
  const nl = normLevel(c);
  if (normDist[nl] !== undefined) normDist[nl]++;
  else normDist[nl] = 1;
});

// Cartes à niveau normalisé 16 et 15
const at16 = allCards.filter((c) => normLevel(c) === 16);
const at15 = allCards.filter((c) => normLevel(c) === 15);

// Cartes avec evolutionLevel dans l'API (30 trouvées)
const evolvedApi = cards.filter((c) => c.evolutionLevel > 0);

// Héros = champions + support cards
const heroes = cards.filter((c) => c.rarity === "champion");
const towerHeroes = supportCards;

// Somme niveaux normalisés
const totalNorm = allCards.reduce((s, c) => s + normLevel(c), 0);

// Somme niveaux bruts (ancienne méthode)
const totalRaw = allCards.reduce((s, c) => s + c.level, 0);

// Niveaux de collection (deux scénarios pour les évolutions)
const heroCount = heroes.length + towerHeroes.length;
const clWith30 = totalNorm + 30 * 5 + heroCount * 5; // 30 évos API
const clWith22 = totalNorm + 22 * 5 + heroCount * 5; // 22 évos jeu

console.log("=== NIVEAUX NORMALISÉS ===");
console.log(`Somme niveaux RAW (ancienne méthode): ${totalRaw}`);
console.log(`Somme niveaux NORMALISÉS:              ${totalNorm}`);
console.log(`Différence (gains normalisat°):        ${totalNorm - totalRaw}`);

console.log("\n=== DISTRIBUTION NIVEAUX NORMALISÉS ===");
for (let i = 16; i >= 1; i--) {
  if (normDist[i] > 0) console.log(`  Niveau ${i}: ${normDist[i]} cartes`);
}

console.log(`\n=== CARTES AU NIVEAU 16 NORMALISÉ (${at16.length}) ===`);
at16.forEach((c) =>
  console.log(
    `  ${c.name} | api_lvl ${c.level} | ${c.rarity} | +${RARITY_OFFSET[c.rarity] ?? 0} = ${normLevel(c)}`,
  ),
);

console.log(`\n=== CARTES AU NIVEAU 15 NORMALISÉ (${at15.length}) ===`);
at15.forEach((c) =>
  console.log(
    `  ${c.name} | api_lvl ${c.level} | ${c.rarity} | +${RARITY_OFFSET[c.rarity] ?? 0} = ${normLevel(c)}`,
  ),
);

console.log(
  `\n=== ÉVOLUTIONS (API: ${evolvedApi.length} cartes avec evolutionLevel > 0) ===`,
);
evolvedApi.forEach((c) =>
  console.log(
    `  ${c.name} | evo ${c.evolutionLevel}/${c.maxEvolutionLevel} | api_lvl ${c.level}`,
  ),
);

console.log("\n=== HÉROS ===");
console.log(
  `Champions (${heroes.length}):`,
  heroes.map((c) => `${c.name} lvl${c.level}`).join(", "),
);
console.log(
  `Tower Heroes (${towerHeroes.length}):`,
  towerHeroes.map((c) => `${c.name} lvl${c.level}`).join(", "),
);
console.log(`Total héros: ${heroCount}`);

console.log("\n=== NIVEAU DE COLLECTION ===");
console.log(`Formule : Σ niveaux normalisés + 5×évos + 5×héros`);
console.log(`Σ niveaux normalisés = ${totalNorm}`);
console.log(
  `[Scénario 30 évos API]  : ${totalNorm} + ${30 * 5} + ${heroCount * 5} = ${clWith30}`,
);
console.log(
  `[Scénario 22 évos jeu]  : ${totalNorm} + ${22 * 5} + ${heroCount * 5} = ${clWith22}`,
);

console.log("\n=== TOUTES LES CARTES AVEC NIVEAU NORMALISÉ ===");
console.log("name|api_level|rarity|offset|norm_level|evolutionLevel");
allCards
  .slice()
  .sort((a, b) => normLevel(b) - normLevel(a))
  .forEach((c) =>
    console.log(
      `${c.name}|${c.level}|${c.rarity}|+${RARITY_OFFSET[c.rarity] ?? 0}|${normLevel(c)}|${c.evolutionLevel ?? ""}`,
    ),
  );
