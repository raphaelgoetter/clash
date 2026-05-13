import fetch from "node-fetch";

async function checkHeroes(tag) {
  const r = await fetch(
    `https://proxy.royaleapi.dev/v1/players/${encodeURIComponent(tag)}`,
    {
      headers: { Authorization: `Bearer ${process.env.CLASH_API_KEY}` },
    },
  );
  const p = await r.json();
  const heroes = p.cards.filter(
    (c) => !!c.iconUrls?.heroMedium && (c.evolutionLevel ?? 0) > 0,
  );
  console.log(
    `${tag} — Héros débloqués : ${heroes.length}/13 → ${heroes.map((c) => c.name).join(", ")}`,
  );
}

await checkHeroes("#J008G9CLJ");
await checkHeroes("#YRGJGR8R");
