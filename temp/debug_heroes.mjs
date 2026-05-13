import fetch from "node-fetch";

async function check(tag, expectedHeroes, expectedEvos) {
  const r = await fetch(
    `https://proxy.royaleapi.dev/v1/players/${encodeURIComponent(tag)}`,
    { headers: { Authorization: `Bearer ${process.env.CLASH_API_KEY}` } },
  );
  const p = await r.json();
  const allCards = [...(p.cards ?? []), ...(p.supportCards ?? [])];

  // Cartes avec les deux systèmes (heroMedium ET evolutionMedium)
  const bothSystems = allCards.filter(
    (c) => !!c.iconUrls?.heroMedium && !!c.iconUrls?.evolutionMedium,
  );
  console.log(
    `\n[${tag}] Cartes avec les 2 systèmes (heroMedium+evoMedium):`,
    bothSystems.map(
      (c) => `${c.name} evoLvl=${c.evolutionLevel ?? 0}/${c.maxEvolutionLevel}`,
    ),
  );

  // Test filtre : evoMedium && maxed && pas (heroMedium && evoLvl=2 non-max)
  const evos = allCards.filter(
    (c) =>
      !!c.iconUrls?.evolutionMedium &&
      (c.evolutionLevel ?? 0) > 0 &&
      !(
        (c.evolutionLevel ?? 0) >= 2 &&
        !!c.iconUrls?.heroMedium &&
        (c.evolutionLevel ?? 0) < c.maxEvolutionLevel
      ),
  );
  const heroes = allCards.filter(
    (c) => !!c.iconUrls?.heroMedium && (c.evolutionLevel ?? 0) >= 2,
  );
  const hOK = heroes.length === expectedHeroes ? "✅" : "❌";
  const eOK = evos.length === expectedEvos ? "✅" : "❌";
  console.log(
    `Héros: ${heroes.length}/${expectedHeroes} ${hOK} | Évolutions: ${evos.length}/${expectedEvos} ${eOK}`,
  );
}

await check("#J008G9CLJ", 4, 6);
await check("#YRGJGR8R", 9, 22);
await check("#8QL2J8PQ", 4, 22);
