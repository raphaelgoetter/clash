// ============================================================
// boss/potato.js — Vue de Potato en Boss de fin de saison (handler
// boss.js ; interface décrite dans boss/quatre.js). Même rendu que la vue
// du duel contre Kévina (handlers/potatoDuel.js) : manche et score, récit,
// ligne de l'événement du joueur au trait, consigne, image (thermomètre,
// repères, patate ; jamais la température d'explosion), boutons de chauffe.
// Pas de bouton Règles ni d'abandon.
//
// custom_id : boss_jouer:<seasonId>:<0|1|2>:<vue> (`vue` = d.vue affiché :
// un clic sur une vue dépassée est refusé).
// ============================================================

import { CHAUFFES, MANCHES_GAGNANTES, SEUIL_MAX, SEUIL_MIN, chauffePermise, chauffesDe, evenementDe } from "../../../services/potatoRules.js";
import { LIGNES_EVENEMENT, ligneManche, score, urlVue, versV2 } from "../potatoDuel.js";

const KEVINA = { Sujet: "🐉 Kévina" };

export const VUE_POTATO = {
  regle: [
    `Chauffe la patate de ${CHAUFFES.map((c) => `+${c}`).join(", ").replace(/, ([^,]*)$/, " ou $1")} °C à ton tour, puis elle passe à Kévina.`,
    `Elle explose à une température secrète (entre ${SEUIL_MIN} et ${SEUIL_MAX} °C) : celui qui la fait exploser perd la manche.`,
    "Indices (la patate fume, puis siffle) et événements comme dans `/potato`.",
    `Premier à ${MANCHES_GAGNANTES} manches. Tu commences.`,
  ].join("\n"),
  partie(d, { seasonId, titre, texte, attente, couleur }) {
    const monTour = !attente && !d.termine && d.actif === "joueur";
    const ev = monTour ? evenementDe(d, "joueur") : null;
    const lignes = [
      `Manche **${d.numero}** · premier à ${MANCHES_GAGNANTES} · ${score(d, "joueur", KEVINA)}`,
      ...(texte ? ["", texte] : []),
      ...(ev ? ["", LIGNES_EVENEMENT[ev.type](d)] : []),
      ...(monTour ? ["", "À toi : chauffe la patate, puis elle passe."] : []),
    ];
    const embed = { title: titre, description: lignes.join("\n").slice(0, 4096), image: { url: urlVue(d, "joueur") }, color: couleur };
    const chauffes = monTour
      ? chauffesDe(d, "joueur").map((c, k) => ({
          type: 2,
          style: 2,
          label: `+${c} °C`,
          emoji: { name: "🔥" },
          custom_id: `boss_jouer:${seasonId}:${k}:${d.vue}`,
          disabled: !chauffePermise(d, "joueur", k),
        }))
      : [];
    return { embeds: [embed], components: chauffes.length ? [{ type: 1, components: chauffes }] : [] };
  },
  action: ([k, vue]) => ({ k: Number(k), vue: Number(vue) }),
  raisonFin(d) {
    const h = d.historique.at(-1);
    const derniere = h ? ligneManche(h, d.historique.length, (id) => (id === "joueur" ? null : "Kévina")) : null;
    const { joueur, bot } = d.manches;
    const bilan = d.gagnant === "joueur" ? `Tu gagnes ${joueur} manches à ${bot} !` : `Kévina gagne ${bot} manches à ${joueur}.`;
    return [derniere, bilan].filter(Boolean).join("\n");
  },
  versV2,
};
