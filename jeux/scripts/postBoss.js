#!/usr/bin/env node
// postBoss.js — Boss de fin de saison (jeux/services/boss.js), lancé chaque
// jour par le cron (.github/workflows/boss.yml). Idempotent :
//
//   1. Du 1er au 7 : ouvre le Boss de la saison écoulée s'il ne l'est pas
//      (duel, graine, qualifiés), puis, une seule fois, l'annonce dans le
//      salon public et invite chaque qualifié en MP.
//   2. À partir du 8 (clôture passée) : clôt le Boss (parties en cours
//      perdues, compteurs permanents) et publie le classement.
//
// Hors --public, rien n'est ouvert ni clos pour de vrai : le script montre
// ce qu'il ferait (annonce et classement provisoire postés sur le salon de
// test, MP seulement aux identifiants passés par --mp).
//
// Usage :
//   node jeux/scripts/postBoss.js                    — salon de test, aucun MP
//   node jeux/scripts/postBoss.js --mp <discordId>   — salon de test + MP à ce joueur
//   node jeux/scripts/postBoss.js --public           — production
//   node jeux/scripts/postBoss.js --dry-run          — affiche seulement, sans écrire ni poster

import "../env.js";

import {
  BOSS_JEUX,
  PREMIERE_SAISON_BOSS,
  classer,
  clotureDe,
  jeuDeSaison,
  cloturerBoss,
  lireBoss,
  listerTentatives,
  ouvrirBoss,
} from "../services/boss.js";
import { lirePasseport, listerJoueursSaison } from "../services/passeport.js";
import { deMois, seasonIdForDate } from "../services/saison.js";
import { envoyerMp, vueInvitation } from "../discord/handlers/boss.js";
import { resolveDisplayName } from "@clash/commun/discordUsers.js";
import { Redis } from "@upstash/redis";

const DRY_RUN = process.argv.includes("--dry-run");
const PUBLIC = process.argv.includes("--public");
const MP_TEST = process.argv.flatMap((a, i, all) => (a === "--mp" && all[i + 1] ? [all[i + 1]] : []));

const BOSS_COLOR = 0x8e44ad;
const channelId = PUBLIC ? process.env.DISCORD_CHANNEL_FRAME_PUBLIC : process.env.DISCORD_CHANNEL_FRAME_TEST;
if (!channelId && !DRY_RUN) {
  console.error(`Variable d'environnement manquante : ${PUBLIC ? "DISCORD_CHANNEL_FRAME_PUBLIC" : "DISCORD_CHANNEL_FRAME_TEST"}`);
  process.exit(1);
}

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
  automaticDeserialization: false,
});
// Annonce publique faite (marqueur distinct du Boss : un essai hors
// --public ne doit pas l'empêcher)
const cleAnnonce = (seasonId) => `boss:${seasonId}:annonce`;

async function posterSalon(embed) {
  if (DRY_RUN) {
    console.log(`\n[dry-run] ${embed.title}\n${embed.description}\n`);
    return true;
  }
  const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bot ${process.env.DISCORD_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ embeds: [embed], allowed_mentions: { parse: [] } }),
  });
  if (!res.ok) console.error(`Échec du post (${res.status}) :`, (await res.text()).slice(0, 300));
  return res.ok;
}

const listeNoms = async (ids) => (await Promise.all(ids.map((id) => resolveDisplayName(id, null)))).map((n) => n ?? "?");

function embedAnnonce(boss, noms) {
  const fin = Math.floor(new Date(boss.clotureAt).getTime() / 1000);
  const lignes = noms.length
    ? [
        `Kévina vous attend à **${BOSS_JEUX[boss.jeu].nom}** ! Une seule tentative, jusqu'au <t:${fin}:f> : invitation en MP, ou bouton 🐉 dans 🛂 Mon passeport (\`/mini-jeux\`).`,
        "",
        `**Qualifiés (${noms.length})** : ${noms.join(", ")}`,
      ]
    : ["Personne n'a complété son passeport ce mois-ci : Kévina attendra le mois prochain."];
  return { title: `🐉 Boss de la saison ${deMois(boss.seasonId)}`, description: lignes.join("\n").slice(0, 4096), color: BOSS_COLOR };
}

const ISSUE = { victoire: "🏆", nul: "🤝", defaite: "💀" };

function embedClassement(boss, classement, provisoire) {
  const lignes = classement.map((t) => `${t.rang}. ${ISSUE[t.resultat] ?? "💀"} ${t.pseudo ?? "?"} · ${t.score} pts`);
  const vainqueurs = classement.filter((t) => t.resultat === "victoire").length;
  const champion = classement[0]?.resultat === "victoire" ? classement.filter((t) => t.rang === 1) : [];
  return {
    title: `🐉 Boss de la saison ${deMois(boss.seasonId)} : résultats${provisoire ? " (provisoires)" : ""}`,
    description: [
      classement.length
        ? `Kévina (${BOSS_JEUX[boss.jeu].nom}) a été vaincue par **${vainqueurs}** joueur${vainqueurs > 1 ? "s" : ""} sur ${classement.length}.`
        : "Personne n'a affronté Kévina.",
      ...(champion.length ? [`👑 Champion${champion.length > 1 ? "s" : ""} : **${champion.map((t) => t.pseudo).join(", ")}**`] : []),
      ...(lignes.length ? ["", ...lignes] : []),
    ]
      .join("\n")
      .slice(0, 4096),
    color: BOSS_COLOR,
  };
}

// ── 1. Ouverture et annonce (du 1er au 7) ───────────────────────────

async function ouvrir(seasonId, now) {
  if (!PUBLIC || DRY_RUN) {
    // Aperçu : qualifiés calculés sans rien écrire
    const existant = await lireBoss(seasonId);
    const qualifies = existant?.qualifies ?? [];
    if (!existant) {
      for (const id of await listerJoueursSaison(seasonId)) {
        if ((await lirePasseport(id, { now, seasonId })).complet) qualifies.push(id);
      }
    }
    const apercu = existant ?? { seasonId, jeu: jeuDeSaison(seasonId), clotureAt: clotureDe(seasonId).toISOString(), qualifies };
    console.log(`Aperçu : Boss ${existant ? "déjà ouvert" : "non ouvert"}, ${qualifies.length} qualifié(s).`);
    await posterSalon(embedAnnonce(apercu, await listeNoms(qualifies)));
    if (!DRY_RUN && existant) {
      for (const id of MP_TEST) console.log(`MP de test à ${id} : ${(await envoyerMp(id, vueInvitation(existant), existant)) ? "envoyé" : "échec"}`);
    } else if (MP_TEST.length) {
      console.log("MP de test seulement quand le Boss est ouvert (--public le 1er).");
    }
    return;
  }

  const { boss, deja } = await ouvrirBoss(seasonId, { now });
  console.log(`Boss ${deja ? "déjà ouvert" : "ouvert"} : ${boss.jeu}, ${boss.qualifies.length} qualifié(s).`);
  if (!Number(await redis.hsetnx(cleAnnonce(seasonId), "fait", now.toISOString()))) {
    console.log("Annonce déjà faite.");
    return;
  }
  await redis.expire(cleAnnonce(seasonId), 120 * 24 * 3600);
  await posterSalon(embedAnnonce(boss, await listeNoms(boss.qualifies)));
  let envoyes = 0;
  for (const id of boss.qualifies) if (await envoyerMp(id, vueInvitation(boss), boss)) envoyes++;
  console.log(`Invitations envoyées : ${envoyes}/${boss.qualifies.length} (MP fermés : bouton du passeport).`);
}

// ── 2. Clôture et classement (à partir du 8) ────────────────────────

async function clore(seasonId, now) {
  const boss = await lireBoss(seasonId);
  if (!boss) {
    console.log("Aucun Boss pour cette saison.");
    return;
  }
  if (boss.cloture) {
    console.log("Boss déjà clos.");
    return;
  }
  if (!PUBLIC || DRY_RUN) {
    await posterSalon(embedClassement(boss, classer(await listerTentatives(seasonId)), true));
    return;
  }
  const { classement, deja } = await cloturerBoss(seasonId, { now });
  if (deja) {
    console.log("Clôture déjà faite.");
    return;
  }
  await posterSalon(embedClassement(boss, classement, false));
}

const now = new Date();
const seasonId = seasonIdForDate(now) - 1;
console.log(`Boss de la saison ${seasonId} (${deMois(seasonId)})${DRY_RUN ? " [dry-run]" : ""}${PUBLIC ? " [public]" : " [test]"}`);
if (seasonId < PREMIERE_SAISON_BOSS) console.log(`Pas de Boss avant la saison ${PREMIERE_SAISON_BOSS} (le passeport arrive en novembre 2026).`);
else if (now < clotureDe(seasonId)) await ouvrir(seasonId, now);
else await clore(seasonId, now);
