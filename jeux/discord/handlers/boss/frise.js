// ============================================================
// boss/frise.js — Vue de Frise en Boss de fin de saison (handler boss.js),
// interface décrite dans boss/quatre.js. Même rendu que le duel contre
// Kévina (friseDuel.js : image de la frise, menus de jeu), custom_id du
// Boss :
// - boss_jouer:<seasonId>:c:<vue> (menu : carte de sa main à placer) ;
// - boss_jouer:<seasonId>:p:<vue>:<k> (menu : créneau, <k> = numéro du
//   menu au-delà de 25 créneaux).
// La valeur choisie arrive dans `values`. L'image est rendue sans état par
// /api/frise/image (frise encodée dans l'URL) : rien à lire en Redis.
// ============================================================

import { imageFrise, legende, lignesErreurs, menusJeu, versV2 } from "../friseDuel.js";

const KEVINA = "🐉 Kévina";

// custom_id du duel (friseduel_carte / friseduel_placer) → custom_id du Boss
function versBoss(rangees, seasonId) {
  return rangees.map((r) => ({
    ...r,
    components: r.components.map((c) => ({
      ...c,
      custom_id: c.custom_id
        .replace(/^friseduel_carte:/, `boss_jouer:${seasonId}:c:`)
        .replace(/^friseduel_placer:/, `boss_jouer:${seasonId}:p:`),
    })),
  }));
}

export const VUE_FRISE = {
  regle:
    "Place les événements de ta main (années cachées) au bon endroit sur la frise commune. Erreur : la carte est rangée à sa place et tu en pioches une. Vide ta main avant Kévina. Tu commences.",
  partie(d, { seasonId, titre, texte, attente, couleur }) {
    const monTour = !d.termine && !attente && d.actif === "joueur";
    const lignes = [
      legende("**Toi**", `**${KEVINA}**`),
      ...(texte ? ["", texte] : []),
      "",
      `Cartes en main : **Toi** ${d.mains.joueur.length} · **${KEVINA}** ${d.mains.bot.length}`,
      ...(d.termine
        ? lignesErreurs(d, (s) => (s === "bot" ? KEVINA : "Toi"))
        : monTour
          ? [`👉 À toi : choisis une carte puis son créneau${d.dernierTour ? " (dernier tour !)" : ""}.`]
          : attente
            ? []
            : ["⏳ Au tour de Kévina."]),
    ];
    return {
      embeds: [{ title: titre, description: lignes.join("\n").slice(0, 4096), color: couleur, image: imageFrise(d, "joueur") }],
      components: monTour ? versBoss(menusJeu(d, "joueur", ""), seasonId) : [],
    };
  },
  action([type, vue], values) {
    const valeur = Number(values?.[0]);
    if (type === "c") return { type: "carte", index: valeur, vue: Number(vue) };
    return { type: "placer", creneau: valeur, vue: Number(vue) };
  },
  raisonFin(d) {
    const n = (k) => `${k} carte${k > 1 ? "s" : ""}`;
    if (d.gagnant === "joueur") return `Tu vides ta main avant Kévina (il lui restait ${n(d.mains.bot.length)}) !`;
    if (d.gagnant === "nul") return "Vous videz vos mains au même tour.";
    return `Kévina vide sa main avant toi (il te restait ${n(d.mains.joueur.length)}).`;
  },
  versV2,
};
