import fetch from "node-fetch";

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
const deck = data.currentDeck || [];
const supportCards = data.currentDeckSupportCards || [];

// Évolutions : cartes avec evolutionLevel >= 1
const evolved = cards.filter((c) => c.evolutionLevel > 0);

// Héros champions (rarity === 'champion')
const heroes = cards.filter((c) => c.rarity === "champion");

// Cartes de soutien (Tower heroes, ex. Tower Princess, id >= 159000000)
const towerHeroes = supportCards;

// Distribution niveaux
const levelDist = {};
for (let i = 1; i <= 16; i++) levelDist[i] = 0;
cards.forEach((c) => {
  if (levelDist[c.level] !== undefined) levelDist[c.level]++;
});

// Somme des niveaux (toutes cartes + deck support)
const totalLevelCards = cards.reduce((s, c) => s + c.level, 0);
const totalLevelSupport = supportCards.reduce((s, c) => s + c.level, 0);
const totalLevel = totalLevelCards + totalLevelSupport;

// Niveau de Collection = somme niveaux + 5 par évolution + 5 par héros (champions + tower heroes)
const heroCount = heroes.length + towerHeroes.length;
const collectionLevel = totalLevel + evolved.length * 5 + heroCount * 5;

console.log("=== STATS DISPLAYNONE #YRGJGR8R ===");
console.log(`Nom: ${data.name} | Tag: ${data.tag}`);
console.log(
  `\nCartes: ${cards.length} cartes + ${supportCards.length} cartes de soutien`,
);
console.log(`Total cartes (hors soutien): ${cards.length} / 125`);
console.log(`Somme des niveaux (cartes): ${totalLevelCards}`);
console.log(`Somme des niveaux (soutien): ${totalLevelSupport}`);
console.log(`Somme totale des niveaux: ${totalLevel}`);
console.log(`\nCartes évoluées: ${evolved.length}`);
evolved.forEach((c) =>
  console.log(
    `  - ${c.name} (evo lvl ${c.evolutionLevel}, max ${c.maxEvolutionLevel})`,
  ),
);
console.log(`\nHéros champions: ${heroes.length}`);
heroes.forEach((c) => console.log(`  - ${c.name} (lvl ${c.level})`));
console.log(`\nCartes de soutien (Tower Heroes): ${towerHeroes.length}`);
towerHeroes.forEach((c) => console.log(`  - ${c.name} (lvl ${c.level})`));
console.log(
  `\nNiveau de Collection: ${totalLevel} + ${evolved.length}×5 (évos) + ${heroCount}×5 (héros) = ${collectionLevel}`,
);

console.log("\n=== DISTRIBUTION DES NIVEAUX ===");
for (let i = 1; i <= 16; i++) {
  if (levelDist[i] > 0) console.log(`  Niveau ${i}: ${levelDist[i]} cartes`);
}

console.log("\n=== LISTE COMPLÈTE DES CARTES ===");
console.log("name|level|maxLevel|rarity|evolutionLevel|maxEvolutionLevel");
cards.forEach((c) =>
  console.log(
    `${c.name}|${c.level}|${c.maxLevel}|${c.rarity}|${c.evolutionLevel ?? ""}|${c.maxEvolutionLevel ?? ""}`,
  ),
);
console.log("\n=== CARTES DE SOUTIEN ===");
supportCards.forEach((c) =>
  console.log(`${c.name}|${c.level}|${c.maxLevel}|${c.rarity}`),
);
