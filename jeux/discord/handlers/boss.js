// ============================================================
// boss.js (handler) — Boss de fin de saison : partie privée contre Kévina,
// dans le MP d'invitation (ou, en secours, en éphémère depuis « 🛂 Mon
// passeport »). Le plateau n'est jamais public : la donne est la même pour
// tous les qualifiés.
//
// custom_id : boss_lancer:<seasonId> (invitation, passeport : ouvre la
// partie dans un nouveau message), boss_pret:<seasonId> (consomme la
// tentative), boss_jouer:<seasonId>:<arg…> (coup ; menus : valeur dans
// data.values), propres à chaque jeu.
//
// Service : jeux/services/boss.js ; règles : jeux/services/boss<Jeu>.js ;
// vues : jeux/discord/handlers/boss/<jeu>.js (interface décrite dans
// boss/quatre.js).
// ============================================================

import { BOSS_JEUX, demarrer, jouer, lireBoss, lireJeu, lireTentative, statutJoueur } from "../../services/boss.js";
import { deMois } from "../../services/saison.js";
import { VUE_QUATRE } from "./boss/quatre.js";
import { VUE_FRISE } from "./boss/frise.js";
import { VUE_PUNTO } from "./boss/punto.js";
import { VUE_GRILLE } from "./boss/grille.js";
import { VUE_POTATO } from "./boss/potato.js";

const VUES = { quatre: VUE_QUATRE, frise: VUE_FRISE, punto: VUE_PUNTO, grille: VUE_GRILLE, potato: VUE_POTATO };

const BOSS_COLOR = 0x8e44ad;
// Réflexion affichée de Kévina (elle joue en quelques millisecondes)
const REFLEXION_MS = { min: 1500, max: 3500 };
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

// Conversion d'un message : celle du duel du Boss (Components V2), sinon
// celle de Quatre à la suite pour les messages sans duel.
const enV2 = (boss, payload) => (VUES[boss?.jeu] ?? VUE_QUATRE).versV2(payload);

// ── Vues ─────────────────────────────────────────────────────────────

const titre = (boss) => `🐉 Boss de la saison ${deMois(boss.seasonId)} · ${BOSS_JEUX[boss.jeu].nom}`;
const horodatage = (iso) => Math.floor(new Date(iso).getTime() / 1000);

function vueTexte(texte) {
  return { embeds: [{ description: texte, color: BOSS_COLOR }], components: [] };
}

export const boutonLancer = (seasonId) => ({
  type: 2,
  style: 1,
  label: "Affronter Kévina",
  emoji: { name: "🐉" },
  custom_id: `boss_lancer:${seasonId}`,
});

/** Message d'invitation (MP du 1er) : bouton « Affronter Kévina ». */
export function vueInvitation(boss) {
  return {
    embeds: [
      {
        title: titre(boss),
        description: [
          `Ton passeport ${deMois(boss.seasonId)} est complet : Kévina t'attend à **${BOSS_JEUX[boss.jeu].nom}** !`,
          "",
          `Une seule tentative, avant le <t:${horodatage(boss.clotureAt)}:f>. Classement le 8.`,
        ].join("\n"),
        color: BOSS_COLOR,
      },
    ],
    components: [{ type: 1, components: [boutonLancer(boss.seasonId)] }],
  };
}

function vueConfirmation(boss) {
  return {
    embeds: [
      {
        title: titre(boss),
        description: [
          VUES[boss.jeu].regle,
          "",
          "⚠️ **Une seule tentative** : elle commence dès que tu cliques sur **Prêt**.",
          "⏰ Sans action pendant 1 h, la partie est perdue.",
        ].join("\n"),
        color: BOSS_COLOR,
      },
    ],
    components: [
      { type: 1, components: [{ type: 2, style: 3, label: "Prêt", custom_id: `boss_pret:${boss.seasonId}` }] },
    ],
  };
}

function vuePartie(boss, etat, texte = null, { attente = false } = {}) {
  return VUES[boss.jeu].partie(etat, { seasonId: boss.seasonId, titre: titre(boss), texte, attente, couleur: BOSS_COLOR });
}

const ISSUES = {
  victoire: "🏆 **Kévina est vaincue !**",
  nul: "🤝 **Match nul** face à Kévina.",
  defaite: "💀 **Kévina l'emporte.**",
};

function vueFin(boss, tentative, etat) {
  const raison = tentative.inactif ? "Partie perdue (1 h sans action)." : etat ? VUES[boss.jeu].raisonFin(etat) : null;
  const texte = [
    ...(raison ? [raison] : []),
    ISSUES[tentative.resultat] ?? ISSUES.defaite,
    `Ton score : **${tentative.score}**. Le classement sera publié le 8.`,
  ].join("\n");
  if (!etat) return vueTexte(texte);
  // Plateau final, sans contrôle
  return { ...vuePartie(boss, etat, texte, { attente: true }), components: [] };
}

const MESSAGES = {
  ferme: "Aucun Boss en cours : il ouvre le 1er du mois, pour les passeports complets du mois écoulé.",
  nonQualifie: "Le Boss est réservé aux passeports complets du mois écoulé. Remplis tes tampons ce mois-ci pour l'affronter le mois prochain !",
  aucunePartie: "Aucune partie en cours.",
};

// ── Envoi ────────────────────────────────────────────────────────────

async function patchOriginal(webhookUrl, boss, payload) {
  if (!webhookUrl) return;
  try {
    const res = await fetch(`${webhookUrl}/messages/@original`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ allowed_mentions: { parse: [] }, ...enV2(boss, payload) }),
    });
    if (!res.ok) console.error(`[Boss] PATCH refusé (${res.status}) :`, (await res.text()).slice(0, 300));
  } catch (err) {
    console.error("[Boss] Échec PATCH:", err.message);
  }
}

/** MP d'un joueur (jeton du bot). Vrai si envoyé : faux si ses MP sont
 * fermés ou en cas d'erreur. */
export async function envoyerMp(discordId, payload, boss = null) {
  const token = process.env.DISCORD_TOKEN;
  if (!token) return false;
  const headers = { Authorization: `Bot ${token}`, "Content-Type": "application/json" };
  try {
    const canal = await fetch("https://discord.com/api/v10/users/@me/channels", {
      method: "POST",
      headers,
      body: JSON.stringify({ recipient_id: discordId }),
    });
    if (!canal.ok) return false;
    const { id } = await canal.json();
    const res = await fetch(`https://discord.com/api/v10/channels/${id}/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({ allowed_mentions: { parse: [] }, ...enV2(boss, payload) }),
    });
    return res.ok;
  } catch (err) {
    console.error("[Boss] Échec MP:", err.message);
    return false;
  }
}

// ── Boutons ──────────────────────────────────────────────────────────

/** Identité de l'auteur du clic, en MP (`body.user`) comme sur le serveur. */
export function auteur(body) {
  const user = body.member?.user ?? body.user ?? {};
  return { discordId: user.id, pseudo: body.member?.nick || user.global_name || user.username || "Inconnu" };
}

async function vueSelonStatut(boss, discordId, now) {
  const statut = statutJoueur(boss, await lireTentative(boss.seasonId, discordId), discordId, now);
  if (statut === "disponible") return vueConfirmation(boss);
  if (statut === "enCours" || statut === "fini") {
    const jeu = await lireJeu(boss, discordId, { now });
    if (jeu.tentative.statut === "fini") return vueFin(boss, jeu.tentative, jeu.etat);
    return vuePartie(boss, jeu.etat, "Ta partie reprend.");
  }
  return vueTexte(MESSAGES[statut]);
}

export async function handleBossBouton(webhookUrl, body, now = new Date()) {
  const [action, seasonArg, ...args] = body.data.custom_id.split(":");
  const { discordId, pseudo } = auteur(body);
  let boss = null;
  const envoyer = (payload) => patchOriginal(webhookUrl, boss, payload);
  try {
    boss = await lireBoss(Number(seasonArg));
    if (!boss) return envoyer(vueTexte(MESSAGES.ferme));

    if (action === "boss_lancer") return envoyer(await vueSelonStatut(boss, discordId, now));

    if (action === "boss_pret") {
      const r = await demarrer(boss, discordId, pseudo, { now });
      if (r.erreur === "dejaJoue") return envoyer(await vueSelonStatut(boss, discordId, now));
      if (r.erreur) return envoyer(vueTexte(MESSAGES[r.erreur]));
      return envoyer(vuePartie(boss, r.etat, "C'est parti ! Tu commences."));
    }

    if (action === "boss_jouer") {
      const r = await jouer(boss, discordId, VUES[boss.jeu].action(args, body.data.values ?? []), { now });
      if (r.erreur) return envoyer(vueTexte(MESSAGES[r.erreur] ?? MESSAGES.aucunePartie));
      const { etat, tentative, resultat } = r;
      if (resultat.erreur) {
        if (tentative.statut === "fini") return envoyer(vueFin(boss, tentative, etat));
        return envoyer(vuePartie(boss, etat, `⚠️ ${resultat.message ?? "Coup impossible."}`));
      }
      if (resultat.inactif) return envoyer(vueFin(boss, tentative, etat));
      if (resultat.avantKevina) {
        // Coup du joueur d'abord, celui de Kévina après sa réflexion
        await envoyer(vuePartie(boss, resultat.avantKevina, `${resultat.texte}\n⏳ Kévina réfléchit…`, { attente: true }));
        await pause(REFLEXION_MS.min + Math.random() * (REFLEXION_MS.max - REFLEXION_MS.min));
      }
      if (tentative.statut === "fini") return envoyer(vueFin(boss, tentative, etat));
      return envoyer(vuePartie(boss, etat, [resultat.texte, resultat.texteKevina].filter(Boolean).join("\n")));
    }
  } catch (err) {
    console.error("[Boss] Erreur bouton:", err);
    await envoyer(vueTexte("⚠️ Erreur, réessaie dans un instant."));
  }
}
