// ============================================================
// Script JETABLE de validation manuelle du nouveau moteur de %matchup.
// Ne touche à AUCUN code de production — lit juste le battlelog réel
// du compte de test #YRGJGR8R et affiche les scores calculés en console.
//
// Usage : node temp/matchup-v2/run-engine.mjs [TAG]
// (TAG par défaut : YRGJGR8R)
// ============================================================

import { computeDeckMatchupScore } from "../../backend/services/matchupEngine.js";
import { getWinConditionsCatalog } from "../../backend/services/matchupCatalog.js";

const TRUST_ROYALE_URL = "https://trustroyale.vercel.app";
const tag = process.argv[2] || "YRGJGR8R";

function deckCardsFromBattle(battle) {
  return {
    player: Array.isArray(battle?.team?.[0]?.cards) ? battle.team[0].cards : [],
    opponent: Array.isArray(battle?.opponent?.[0]?.cards)
      ? battle.opponent[0].cards
      : [],
  };
}

async function main() {
  console.log(`Fetching battlelog for #${tag}...`);
  const res = await fetch(
    `${TRUST_ROYALE_URL}/api/player/${encodeURIComponent(`#${tag}`)}/battlelog`,
    { headers: { Accept: "application/json" } },
  );
  if (!res.ok) {
    console.error(`Battlelog fetch failed: ${res.status}`);
    process.exit(1);
  }
  const battleLog = await res.json();
  if (!Array.isArray(battleLog) || battleLog.length === 0) {
    console.error("Empty or invalid battlelog.");
    process.exit(1);
  }

  const catalog = await getWinConditionsCatalog();
  console.log(
    `Catalogue chargé : ${catalog.winConditionsByName.size} win conditions connues.\n`,
  );

  battleLog.forEach((battle, index) => {
    const { player, opponent } = deckCardsFromBattle(battle);
    if (player.length !== 8 || opponent.length !== 8) return;

    const opponentName = battle?.opponent?.[0]?.name ?? "?";
    const { scoreA, breakdown, winConditionsA, winConditionsB } =
      computeDeckMatchupScore(player, opponent, catalog);
    const difficulty = Math.round((100 - scoreA) * 10) / 10;

    console.log(
      `[${index}] vs ${opponentName} — difficulté joueur: ${difficulty}% (scoreA=${scoreA.toFixed(1)})`,
    );
    console.log(
      `    WC joueur: ${winConditionsA.join(", ") || "(aucune connue)"} | WC adverse: ${winConditionsB.join(", ") || "(aucune connue)"}`,
    );
    console.log(
      `    layers: archetype=${breakdown.layer1} counters=${breakdown.layer2} utility=${breakdown.layer3} levels=${breakdown.layer4}`,
    );
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
