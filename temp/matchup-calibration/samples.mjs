// Extraction des échantillons de calibration depuis le fichier de collect.mjs
// (partagé par analyze.mjs et audit.mjs).
import { normLevel } from "../../backend/services/collectionConstants.js";

// Modes 1v1 aux règles standard (élixir, decks du joueur) uniquement
export const MODE_GROUPS = {
  Ladder: "Ladder",
  Ranked1v1_NewArena: "Ligue",
  Ranked1v1_NewArena2: "Ligue",
  CW_Battle_1v1: "GDC",
  CW_Duel_1v1: "GDC",
  Friendly: "Amical",
};

// ── Extraction des échantillons (1 par combat, ou 1 par manche de duel) ──

// Orientation pseudo-aléatoire mais déterministe : le joueur dont on a lu le
// battle log (team[0]) n'est pas toujours "A", sinon un éventuel biais de
// niveau de la famille se confondrait avec l'ordonnée à l'origine.
function hashFlip(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
  return (h & 1) === 1;
}

export function loadSamples(raw) {
  const samples = [];
  for (const b of raw) {
    const mode = MODE_GROUPS[b.gameMode];
    if (!mode || b.team?.length !== 1 || b.opponent?.length !== 1) continue;
    let A = b.team[0];
    let B = b.opponent[0];
    if (hashFlip(b.battleTime + A.tag + B.tag)) [A, B] = [B, A];
    const trophyDiff =
      mode === "Ladder" &&
      Number.isFinite(A.startingTrophies) &&
      Number.isFinite(B.startingTrophies)
        ? A.startingTrophies - B.startingTrophies
        : null;
    const towerDiff =
      normLevel(A.supportCards?.[0]) - normLevel(B.supportCards?.[0]);

    const rounds =
      Array.isArray(A.rounds) && A.rounds.length > 0 && A.cards.length > 8
        ? A.rounds.map((r, i) => ({
            cardsA: A.cards.slice(i * 8, i * 8 + 8),
            cardsB: B.cards.slice(i * 8, i * 8 + 8),
            crownsA: r.crowns,
            crownsB: B.rounds?.[i]?.crowns,
          }))
        : [
            {
              cardsA: A.cards,
              cardsB: B.cards,
              crownsA: A.crowns,
              crownsB: B.crowns,
            },
          ];

    for (const r of rounds) {
      if (r.cardsA.length !== 8 || r.cardsB.length !== 8) continue;
      if (!Number.isFinite(r.crownsA) || !Number.isFinite(r.crownsB)) continue;
      if (r.crownsA === r.crownsB) continue; // égalité : exclue
      samples.push({
        mode,
        win: r.crownsA > r.crownsB ? 1 : 0,
        cardsA: r.cardsA,
        cardsB: r.cardsB,
        trophyDiff,
        towerDiff,
      });
    }
  }
  return samples;
}
