import fetch from "node-fetch";

const key = process.env.CLASH_API_KEY?.trim();
const BASE = "https://proxy.royaleapi.dev/v1";
const headers = { Authorization: `Bearer ${key}`, Accept: "application/json" };

// 1. Profil joueur — currentDeckSupportCards + cards
const player = await fetch(`${BASE}/players/%23YRGJGR8R`, { headers }).then(
  (r) => r.json(),
);

console.log("=== currentDeckSupportCards ===");
console.log(JSON.stringify(player.currentDeckSupportCards, null, 2));

console.log(
  "\n=== cards avec rarity 'common' et ID >= 159000000 (tower troops range) ===",
);
const towerRange = (player.cards || []).filter((c) => c.id >= 159000000);
console.log(JSON.stringify(towerRange, null, 2));

// 2. Battle log — chercher des supportCards dans les batailles récentes
const battles = await fetch(`${BASE}/players/%23YRGJGR8R/battlelog`, {
  headers,
}).then((r) => r.json());

console.log(
  "\n=== Battle log — support cards dans les 5 premières batailles ===",
);
const recentBattles = Array.isArray(battles) ? battles.slice(0, 5) : [];
for (const b of recentBattles) {
  console.log(`\n-- ${b.type} | ${b.battleTime} --`);
  for (const participant of [...(b.team || []), ...(b.opponent || [])]) {
    if (participant.supportCards?.length) {
      console.log(
        `  ${participant.name} | supportCards:`,
        JSON.stringify(participant.supportCards),
      );
    } else {
      console.log(`  ${participant.name} | supportCards: (absent)`);
    }
  }
}
