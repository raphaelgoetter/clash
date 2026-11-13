// ============================================================
// bossRng.js — Hasard commun du Boss de fin de saison (boss.js) : un
// générateur déterministe (mulberry32) tiré de la graine de la saison et
// d'une étape de la partie (nombre de coups joués…). Deux joueurs qui
// jouent les mêmes coups voient donc Kévina répondre pareil.
// ============================================================

export function rngBossDe(graine, etape) {
  let h = 2166136261;
  for (const ch of `${graine}:${etape}`) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
