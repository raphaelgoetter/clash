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
const cards = data.cards || [];

// Toutes les cartes avec un champ evo quelconque
const withEvo = cards.filter(
  (c) => c.evolutionLevel !== undefined || c.maxEvolutionLevel !== undefined,
);

console.log(`\n=== CARTES AVEC DONNÉES ÉVOLUTION (${withEvo.length}) ===`);
console.log(
  [
    "name",
    "api_lvl",
    "rarity",
    "maxLvl",
    "evoLvl",
    "maxEvoLvl",
    "count",
    "hasEvoIcon",
  ].join("\t"),
);
for (const c of withEvo) {
  const hasEvoIcon = !!c.iconUrls?.evolutionMedium;
  const evoLvl = c.evolutionLevel ?? "-";
  const maxEvoLvl = c.maxEvolutionLevel ?? "-";
  console.log(
    [
      c.name,
      c.level,
      c.rarity,
      c.maxLevel,
      evoLvl,
      maxEvoLvl,
      c.count ?? "-",
      hasEvoIcon,
    ].join("\t"),
  );
}

// Essayer différents filtres pour trouver celui qui donne 22
console.log("\n=== TESTS DE FILTRES ===");
const f1 = cards.filter((c) => c.evolutionLevel > 0).length;
const f2 = cards.filter(
  (c) => c.evolutionLevel >= (c.maxEvolutionLevel ?? 999),
).length;
const f3 = cards.filter(
  (c) =>
    c.evolutionLevel > 0 &&
    c.evolutionLevel >= c.maxEvolutionLevel &&
    c.maxEvolutionLevel === 1,
).length;
const f4 = cards.filter(
  (c) => c.evolutionLevel > 0 && !!c.iconUrls?.evolutionMedium,
).length;
const f5 = cards.filter(
  (c) =>
    c.evolutionLevel >= (c.maxEvolutionLevel ?? 999) &&
    !!c.iconUrls?.evolutionMedium,
).length;
const f6 = cards.filter((c) => c.evolutionLevel > 0 && c.count === 0).length;
const f7 = cards.filter(
  (c) => c.evolutionLevel > 0 && c.level === c.maxLevel,
).length;

console.log(
  `evolutionLevel > 0                                          → ${f1}`,
);
console.log(
  `evolutionLevel >= maxEvolutionLevel                         → ${f2}`,
);
console.log(
  `evolutionLevel >= maxEvolutionLevel && maxEvoLvl === 1      → ${f3}`,
);
console.log(
  `evolutionLevel > 0 && hasEvoIcon                           → ${f4}`,
);
console.log(
  `evolutionLevel >= maxEvolutionLevel && hasEvoIcon           → ${f5}`,
);
console.log(
  `evolutionLevel > 0 && count === 0                           → ${f6}`,
);
console.log(
  `evolutionLevel > 0 && level === maxLevel                    → ${f7}`,
);

// Voir les cartes avec evo > 0 et leur icone
console.log("\n=== CARTES evo > 0 — présence iconUrls.evolutionMedium ===");
for (const c of cards.filter((c) => c.evolutionLevel > 0)) {
  const hasIcon = !!c.iconUrls?.evolutionMedium;
  const maxed = c.evolutionLevel >= c.maxEvolutionLevel;
  console.log(
    `  ${c.name.padEnd(22)} | evo ${c.evolutionLevel}/${c.maxEvolutionLevel} | lvl ${c.level}/${c.maxLevel} | icon=${hasIcon} | maxed=${maxed}`,
  );
}
