// ============================================================
// gobeletDuel.js — Handlers Discord pour le Jeu du Gobelet, duel autonome
// (1 ou 2 joueurs, N manches), lancé à la demande via /gobelet.
//
// Développé EN PARALLÈLE du jeu spécial (_handlers/gobelet.js), sans aucun
// impact dessus : custom_id préfixés `gobeletduel_*` (jamais `gobelet_*`),
// état Redis dans jeux/services/gobeletDuel.js (`gobeletduel:*`), aucun
// import d'état du service du jeu spécial (seules ses fonctions pures sont
// réutilisées).
//
// Contrairement au jeu spécial, le message public est ÉDITÉ EN PLACE à
// chaque avancée : il n'y a pas de "jour" qui change, seulement des
// manches qui s'enchaînent en direct. En fin de partie, le récapitulatif
// est reposté dans un nouveau message et l'original supprimé.
// ============================================================

import {
  writeState,
  startGame,
  joinAndDeal,
  toggleKept,
  relance,
  valider,
  choisir,
  checkAndResolveManche,
  listHands,
  readPoints,
  saveHandWebhook,
  readHandWebhooks,
  INACTIVITE_SECONDES,
} from "../../services/gobeletDuel.js";
import {
  computeBestCombination,
  formatBaremeLines,
  listChoices,
  JOKER,
  NO_COMBINATION,
} from "../../services/gobelet.js";
import { encodeFin, encodeMain, encodeManche, meilleureCombinaison } from "../../services/gobeletImage.js";
import {
  getRoleIdByName,
  MINI_JEUX_ROLE_NAME,
} from "@clash/commun/discordRoles.js";
import { resolveDisplayName } from "@clash/commun/discordUsers.js";
import { rangExAequo } from "@clash/commun/classement.js";

const GOBELETDUEL_COLOR = 0x9b59b6;
// « 2 minutes » : délai d'abandon d'une partie sans action
const DELAI_INACTIVITE = `${INACTIVITE_SECONDES / 60} minutes`;
const NO_KEPT = [false, false, false, false, false];

const TRUST_ROYALE_URL = "https://trustroyale.vercel.app";

// Dés en image (gobeletImage.js) : main du joueur, dernière manche (message
// public) et fin de partie. Les boutons de dés gardent la valeur en libellé.

// ── Résolution des rôles/utilisateurs ────────────────────────────────

export function extractMember(body) {
  const discordId = body.member?.user?.id;
  const username =
    body.member?.nick ||
    body.member?.user?.global_name ||
    body.member?.user?.username ||
    "Inconnu";
  return { discordId, username };
}

export async function memberHasMiniJeuxRole(body) {
  const roleId = await getRoleIdByName(MINI_JEUX_ROLE_NAME);
  if (!roleId) return false;
  const roles = body.member?.roles;
  return Array.isArray(roles) && roles.includes(roleId);
}

// ── Édition en place (réponses aux interactions) ──────────────────

async function patchOriginal(webhookUrl, payload) {
  if (!webhookUrl) return;
  try {
    await fetch(`${webhookUrl}/messages/@original`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    console.error("[GobeletDuel] Échec PATCH:", err.message);
  }
}

// Supprime la réponse éphémère différée : une fois la table publiée dans le
// salon, un accusé "Table ouverte" privé ne sert à rien.
async function deleteOriginal(webhookUrl) {
  if (!webhookUrl) return;
  try {
    await fetch(`${webhookUrl}/messages/@original`, { method: "DELETE" });
  } catch (err) {
    console.error("[GobeletDuel] Échec DELETE:", err.message);
  }
}

async function patchPublicMessage(state, payload) {
  const token = process.env.DISCORD_TOKEN;
  if (!token || !state?.channelId || !state?.messageId) return;
  try {
    const res = await fetch(
      `https://discord.com/api/v10/channels/${state.channelId}/messages/${state.messageId}`,
      {
        method: "PATCH",
        headers: {
          Authorization: `Bot ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      },
    );
    if (!res.ok) {
      console.warn(
        `[GobeletDuel] Échec édition du message public (${res.status}).`,
      );
    }
  } catch (err) {
    console.warn(
      "[GobeletDuel] Erreur réseau à l'édition du message public:",
      err.message,
    );
  }
}

// Fin de partie : le récapitulatif complet est publié dans un NOUVEAU post
// (visible en bas du salon), puis le message de la partie est supprimé.
// Repli : si le nouveau post échoue, on édite l'ancien plutôt que de perdre
// le récapitulatif.
async function postFinalMessage(state, payload) {
  const token = process.env.DISCORD_TOKEN;
  if (!token || !state?.channelId) return;
  const headers = { Authorization: `Bot ${token}` };
  try {
    const res = await fetch(
      `https://discord.com/api/v10/channels/${state.channelId}/messages`,
      {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      },
    );
    if (!res.ok) {
      console.warn(`[GobeletDuel] Échec envoi du récapitulatif (${res.status}).`);
      await patchPublicMessage(state, payload);
      return;
    }
  } catch (err) {
    console.warn("[GobeletDuel] Erreur réseau à l'envoi du récapitulatif:", err.message);
    await patchPublicMessage(state, payload);
    return;
  }
  await deletePublicMessage(state);
}

// Supprime le message public de la partie (fin de partie, ou partie solo
// remplacée par un nouveau /gobelet).
async function deletePublicMessage(state) {
  const token = process.env.DISCORD_TOKEN;
  if (!token || !state?.channelId || !state?.messageId) return;
  const headers = { Authorization: `Bot ${token}` };
  try {
    const res = await fetch(
      `https://discord.com/api/v10/channels/${state.channelId}/messages/${state.messageId}`,
      { method: "DELETE", headers },
    );
    if (!res.ok && res.status !== 404) {
      console.warn(`[GobeletDuel] Échec suppression du message de la partie (${res.status}).`);
    }
  } catch (err) {
    console.warn("[GobeletDuel] Erreur réseau à la suppression du message de la partie:", err.message);
  }
}

// ── Embed / composants du message public ──────────────────────────

// Jamais désactivé : le bouton "Jouer" (puis "Reprendre ma partie") sert aussi aux joueurs déjà inscrits
// pour recevoir leur main de la manche courante (à chaque manche). Le refus
// d'un NOUVEAU joueur une fois les inscriptions verrouillées est géré
// côté serveur (joinAndDeal) avec un message de rejet éphémère, pas en
// désactivant le bouton pour tout le monde.
const REGLES_BUTTON = {
  type: 2,
  style: 2,
  label: "Règles",
  emoji: { name: "📖" },
  custom_id: "gobeletduel_regles",
};

// Libellé du bouton de la partie : Jouer tant qu'une place est libre, puis
// Reprendre ma partie (règle commune des duels), même action.
function nomBoutonJouer(state) {
  return state?.rosterLocked ? "Reprendre ma partie" : "Jouer";
}

function buildJoinComponents(state) {
  return [
    {
      type: 1,
      components: [
        state.rosterLocked
          ? {
              type: 2,
              style: 2,
              label: "Reprendre ma partie",
              emoji: { name: "🎮" },
              custom_id: `gobeletduel_jouer:${state.gid}`,
            }
          : {
              type: 2,
              style: 3,
              label: "Jouer",
              emoji: { name: "🎲" },
              custom_id: `gobeletduel_jouer:${state.gid}`,
            },
        REGLES_BUTTON,
      ],
    },
  ];
}

// Récapitulatif de fin de partie : seul le bouton Règles reste utile.
function buildFinalComponents() {
  return [{ type: 1, components: [REGLES_BUTTON] }];
}

async function buildPendingLabel(state, hands) {
  const pendingIds = state.players.filter(
    (id) => !hands[id] || hands[id].status !== "termine",
  );
  const missingSeats = state.maxPlayers - state.players.length;
  const lines = [];
  if (pendingIds.length > 0) {
    const names = await Promise.all(
      pendingIds.map((id) => resolveDisplayName(id, hands[id]?.username)),
    );
    lines.push(
      `⏳ ${names.length > 1 ? "Doivent" : "Doit"} encore jouer cette manche (bouton **${nomBoutonJouer(state)}**) : ${names.join(", ")}`,
    );
  }
  // Roster incomplet : la manche attend les places libres avant d'être
  // résolue (voir isMancheReady côté service).
  if (missingSeats > 0) {
    lines.push(
      `⏳ En attente de ${missingSeats} joueur${missingSeats > 1 ? "s" : ""} supplémentaire${missingSeats > 1 ? "s" : ""}`,
    );
  }
  if (lines.length === 0) return "Tout le monde a joué, résolution en cours…";
  return lines.join("\n");
}

// Image de la dernière manche terminée (gobeletImage.js) : dés finaux,
// combinaison et total de chaque joueur, dans l'ordre des sièges. Titre :
// les points en solo, le meilleur score de la manche à 2.
async function urlImageManche(state, results) {
  const totaux = await readPoints(state.gid);
  const rang = (r) => (state.players.includes(r.discordId) ? state.players.indexOf(r.discordId) : state.players.length);
  const joueurs = await Promise.all(
    [...results]
      .sort((x, y) => rang(x) - rang(y))
      .map(async (r) => ({
        nom: await resolveDisplayName(r.discordId, r.username),
        des: r.dice,
        category: r.category,
        points: r.points,
        total: totaux[r.discordId] ?? 0,
      })),
  );
  const numero = state.manche - 1;
  let titre;
  if (joueurs.length === 1) {
    titre = `Manche ${numero} : ${joueurs[0].points > 0 ? `+${joueurs[0].points}` : "0 pt"}`;
  } else {
    const max = Math.max(...joueurs.map((j) => j.points));
    const tete = joueurs.filter((j) => j.points === max);
    titre = tete.length > 1 ? `Manche ${numero} : égalité à ${max}` : `Manche ${numero} : ${tete[0].nom} +${max}`;
  }
  return `${TRUST_ROYALE_URL}/api/gobelet/manche?d=${encodeManche({ titre, joueurs })}`;
}

// Sans `previousResults` explicite (rafraîchissement après un clic Jouer,
// Relancer…), le bilan est relu depuis l'état : il reste affiché pendant
// toute la manche suivante au lieu de disparaître au premier clic.
async function buildTableEmbed(
  state,
  { previousResults = state.lastResults } = {},
) {
  const hands = await listHands(state.gid, state.manche);
  const lines = [];

  // Bilan de la manche précédente : en image (pas d'image en manche 1)
  const imageManche = previousResults?.length ? await urlImageManche(state, previousResults) : null;

  // Pas de "Manche X/Y" ici : déjà dans le titre de l'embed (buildTableEmbed
  // est utilisé pour le body) — même principe que buildTodaySection du jeu
  // spécial (_handlers/gobelet.js).
  const seatsLabel = `${state.players.length}/${state.maxPlayers} joueur${state.maxPlayers > 1 ? "s" : ""} inscrit${state.players.length > 1 ? "s" : ""}`;
  // Inscriptions closes : pas d'appel générique (il laisserait croire qu'on
  // peut encore rejoindre), la ligne d'attente nomme les joueurs concernés.
  lines.push(
    "## 🎲 À vos dés !",
    ...(state.rosterLocked ? [] : ["Clique sur **Jouer** pour lancer tes 5 dés."]),
    "",
    seatsLabel,
  );

  if (state.players.length > 0) {
    lines.push(await buildPendingLabel(state, hands));
  } else {
    lines.push(
      "Clique sur **Jouer** pour t'inscrire et lancer ta première main.",
    );
  }

  // Pas de cron : le message d'une partie expirée resterait figé, d'où le
  // rappel du délai (relancé à chaque action). Texte fixe plutôt qu'un
  // horodatage relatif <t:…:R>, affiché dans la langue du client Discord.
  lines.push("", `⏰ Sans action pendant ${DELAI_INACTIVITE}, partie abandonnée.`);

  return {
    title: `🎲 Gobelet Duel (Manche ${state.manche}/${state.totalManches})`,
    description: lines.join("\n"),
    ...(imageManche ? { image: { url: imageManche } } : {}),
    color: GOBELETDUEL_COLOR,
    footer: {
      text: state.rosterLocked
        ? "Inscriptions closes, la partie a commencé."
        : `Places restantes : ${state.maxPlayers - state.players.length}`,
    },
  };
}

// Image de fin (gobeletImage.js) : pour chaque joueur, son total, les
// points de chaque manche et sa meilleure combinaison avec ses dés.
async function urlImageFin(state, ranking, pseudos) {
  const history = state.history || [];
  const points = Object.fromEntries(ranking.map((r) => [r.discordId, r.points]));
  const joueurs = await Promise.all(
    state.players.map(async (discordId) => {
      const manches = history
        .map((h) => h.results.find((r) => r.discordId === discordId))
        .filter(Boolean)
        .map((r) => ({ points: r.points, category: r.category, des: r.dice }));
      const best = meilleureCombinaison(manches);
      return {
        nom: await resolveDisplayName(discordId, pseudos.get(discordId)),
        points: points[discordId] ?? 0,
        manches,
        meilleure: best ? { des: best.des, category: best.category, points: best.points } : null,
      };
    }),
  );
  return `${TRUST_ROYALE_URL}/api/gobelet/fin?d=${encodeFin({ joueurs, totalManches: state.totalManches })}`;
}

// Le détail des manches est dans l'image : le texte se limite au total
// (solo) ou au classement (1v1) et au high score.
async function buildFinalEmbed(state, results, ranking, highScore) {
  // Pseudos de la partie (mains jouées), en repli de l'affichage Discord
  const pseudos = new Map(
    [...(state.history || []).flatMap((h) => h.results), ...results].map((r) => [r.discordId, r.username]),
  );
  const resolvedRanking = await Promise.all(
    ranking.map(async (r) => ({
      ...r,
      username: await resolveDisplayName(r.discordId, r.username ?? pseudos.get(r.discordId)),
    })),
  );
  const ptsLabel = (n) => `${n} pt${n > 1 ? "s" : ""}`;
  const isSolo = state.maxPlayers === 1;
  const partie = `Partie en ${state.totalManches} manches.`;
  const lines = isSolo
    ? [`${partie} Total : **${ptsLabel(resolvedRanking[0]?.points ?? 0)}**`]
    : [
        partie,
        ...(resolvedRanking.length
          ? resolvedRanking.map((r, i, list) => `${rangExAequo(list, i)}. ${r.username} (${ptsLabel(r.points)})`)
          : ["Personne n'a marqué de point."]),
      ];

  if (highScore) {
    const name = await resolveDisplayName(highScore.discordId, highScore.username);
    lines.push(`<:topplayers:1563107730397601792> High score : ${name} (${ptsLabel(highScore.points)})`);
  }

  // Titre au format des autres duels, joueurs dans l'ordre des sièges
  const noms = await Promise.all(state.players.map((id) => resolveDisplayName(id, pseudos.get(id))));
  const titre = isSolo ? `${noms[0]} en solo` : noms.join(" contre ");

  return {
    title: `🎲 Gobelet · ${titre}`,
    description: lines.join("\n"),
    image: { url: await urlImageFin(state, ranking, pseudos) },
    color: GOBELETDUEL_COLOR,
  };
}

// ── Commande /gobelet ──────────────────────────────────────────────

export async function handleGobeletCommand(
  webhookUrl,
  body,
  { maxPlayers, totalManches },
) {
  try {
    const channelId = body.channel_id;
    const { discordId } = extractMember(body);
    const result = await startGame(channelId, discordId, { maxPlayers, totalManches });

    if (result.alreadyActive) {
      await patchOriginal(webhookUrl, {
        content: `Une partie du Jeu du Gobelet Duel à 2 joueurs est déjà en cours dans <#${result.state.channelId}>, attends qu'elle se termine (ou qu'elle soit abandonnée après ${DELAI_INACTIVITE} sans action).`,
        embeds: [],
        components: [],
      });
      return;
    }
    if (result.replaced) await deletePublicMessage(result.replaced);

    const embed = await buildTableEmbed(result.state);
    const components = buildJoinComponents(result.state);

    const token = process.env.DISCORD_TOKEN;
    const res = await fetch(
      `https://discord.com/api/v10/channels/${channelId}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bot ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ embeds: [embed], components }),
      },
    );
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`Erreur envoi salon Discord (${res.status}): ${errText}`);
    }
    const message = await res.json();
    await writeState(result.state.gid, { ...result.state, messageId: message.id });

    await deleteOriginal(webhookUrl);
  } catch (err) {
    console.error("[GobeletDuel] Échec lancement:", err.message);
    await patchOriginal(webhookUrl, {
      content: "⚠️ Erreur lors du lancement de la partie.",
      embeds: [],
      components: [],
    });
  }
}

export async function handleGobeletRoleRejected(webhookUrl) {
  await patchOriginal(webhookUrl, {
    content:
      "Tu n'as pas le rôle nécessaire (MINI-JEUX) pour lancer une partie.",
    embeds: [],
    components: [],
  });
}

// ── Main du joueur — Jouer / conserver un dé / Relancer ─────────────

function buildHandStatusMessage(hand, kept, manche) {
  if (hand.status === "termine") {
    return `🎯 Combinaison retenue : **${hand.category}**.\nTu gagnes **${hand.points} point${hand.points > 1 ? "s" : ""}** cette manche !`;
  }
  if (hand.status === "choix") {
    return "🎯 Plusieurs combinaisons possibles : choisis celle à retenir dans la liste pour terminer ta main.";
  }
  const toReroll = kept.filter((k) => !k).length;
  const rerollsLeft = 3 - hand.tirage;
  // Consigne détaillée à la première manche seulement, ensuite le joueur sait quoi faire
  if (manche > 1) {
    return `Tirage ${hand.tirage}/3. Il te reste ${rerollsLeft} lancer${rerollsLeft > 1 ? "s" : ""}.`;
  }
  return `Tirage ${hand.tirage}/3 : sélectionne les dés à conserver (🔒) puis clique sur **Relancer** pour relancer les ${toReroll} dé${toReroll > 1 ? "s" : ""} restant${toReroll > 1 ? "s" : ""}. Il te reste ${rerollsLeft} relance${rerollsLeft > 1 ? "s" : ""}.`;
}

// Image de la main (gobeletImage.js) : dés (gardés cadenassés), tirages,
// combinaison retenue, grille des combinaisons (réalisées barrées, celles
// de l'adversaire marquées : chacune ne rapporte qu'une fois par partie).
function urlImageMain(state, hand, kept, used, opponents = []) {
  const adv = opponents[0];
  const param = encodeMain({
    nom: hand.username ?? "Toi",
    des: hand.dice,
    gardes: kept,
    tirage: hand.tirage,
    statut: hand.status,
    category: hand.category,
    points: hand.points,
    used: used ?? [],
    adversaire: adv ? { nom: adv.username || "Adversaire", used: adv.used } : null,
    legende: `Manche ${state.manche}/${state.totalManches}`,
  });
  return `${TRUST_ROYALE_URL}/api/gobelet/main?d=${param}`;
}

function buildHandEmbed(state, hand, kept, used, opponents) {
  return {
    title: `🎲 Ta main (Manche ${state.manche})`,
    description: buildHandStatusMessage(hand, kept, state.manche),
    image: { url: urlImageMain(state, hand, kept, used, opponents) },
    color: GOBELETDUEL_COLOR,
  };
}

function relancerLabel(kept) {
  const count = kept.filter((k) => !k).length;
  return count === 0
    ? "Passer au tirage suivant"
    : `Relancer (${count} dé${count > 1 ? "s" : ""})`;
}

// Bouton de dé : 🔒 gardé / 🎲 relancé, la valeur en libellé.
function buildDieEmoji(kept) {
  return { name: kept ? "🔒" : "🎲" };
}

// Le bouton Valider n'apparaît que si les dés COURANTS forment déjà une
// combinaison pas encore réalisée, dès le 1ᵉʳ tirage — même règle que le
// jeu spécial (_handlers/gobelet.js). Le libellé ne nomme volontairement
// pas la combinaison : à chacun de la repérer.
// Main terminée : « Manche suivante » reste grisé jusqu'à la résolution de
// la manche (activé ensuite par activateNextButtons), pour enchaîner depuis
// l'éphémère sans remonter jusqu'au message public. Rien après la dernière
// manche.
function buildNextComponents(gid, manche, totalManches, ready) {
  if (manche >= totalManches) return [];
  return [
    {
      type: 1,
      components: [
        {
          type: 2,
          style: 3,
          label: "Manche suivante",
          emoji: { name: "🎲" },
          custom_id: `gobeletduel_suivante:${manche + 1}:${gid}`,
          disabled: !ready,
        },
      ],
    },
  ];
}

// Main en attente de choix : un select avec chaque combinaison possible
// (Joker compris s'il est libre), la plus payante en premier — même rendu
// que le jeu spécial (dupliqué, voir _handlers/gobelet.js).
function buildChoiceComponents(customId, hand, used) {
  const choices = listChoices(hand.dice, used);
  return [
    {
      type: 1,
      components: [
        {
          type: 3,
          custom_id: customId,
          placeholder: "Choisis ta combinaison",
          options: choices.map((c, i) => ({
            label: `${c.category} (${c.points} pt${c.points > 1 ? "s" : ""})`,
            value: c.category,
            emoji: { name: c.category === JOKER ? "🃏" : "🎯" },
            ...(i === 0 ? { description: "Le plus de points" } : {}),
          })),
        },
      ],
    },
  ];
}

function buildHandComponents(state, hand, kept, used) {
  const manche = state.manche;
  if (hand.status === "choix") {
    return buildChoiceComponents(`gobeletduel_choix:${manche}:${state.gid}`, hand, used);
  }
  if (hand.status !== "en_cours") return buildNextComponents(state.gid, manche, state.totalManches, false);
  const { category } = computeBestCombination(hand.dice, used, {
    allowJoker: false,
  });
  const canValider = category !== NO_COMBINATION;
  const secondRow = [
    {
      type: 2,
      style: 1,
      label: relancerLabel(kept),
      emoji: { name: kept.every(Boolean) ? "➡️" : "🔁" },
      custom_id: `gobeletduel_relancer:${manche}:${state.gid}`,
    },
  ];
  if (canValider) {
    secondRow.push({
      type: 2,
      style: 3,
      label: "Valider",
      emoji: { name: "👍" },
      custom_id: `gobeletduel_valider:${manche}:${state.gid}`,
    });
  }
  return [
    {
      type: 1,
      components: hand.dice.map((value, i) => ({
        type: 2,
        style: kept[i] ? 3 : 2,
        label: String(value),
        emoji: buildDieEmoji(kept[i]),
        custom_id: `gobeletduel_toggle:${manche}:${i}:${state.gid}`,
      })),
    },
    { type: 1, components: secondRow },
  ];
}

// Après une relance qui peut terminer une main (3ᵉ tirage atteint) : vérifie
// si la manche (ou la partie) doit se résoudre, puis rafraîchit le message
// public en place. Seule la fin de partie est repostée (postFinalMessage).
async function refreshPublicMessage(gid) {
  const outcome = await checkAndResolveManche(gid);
  if (outcome.inactive) return outcome;

  if (!outcome.resolved) {
    // Rien à résoudre pour l'instant (ou résolution déjà prise par un autre
    // clic concurrent) : on rafraîchit juste le compteur "en attente de".
    const embed = await buildTableEmbed(outcome.state);
    await patchPublicMessage(outcome.state, {
      embeds: [embed],
      components: buildJoinComponents(outcome.state),
    });
    return outcome;
  }

  if (outcome.final) {
    const embed = await buildFinalEmbed(
      outcome.state,
      outcome.results,
      outcome.ranking,
      outcome.highScore,
    );
    await postFinalMessage(outcome.state, {
      embeds: [embed],
      components: buildFinalComponents(),
    });
    return outcome;
  }

  const embed = await buildTableEmbed(outcome.state, {
    previousResults: outcome.results,
  });
  await patchPublicMessage(outcome.state, {
    embeds: [embed],
    components: buildJoinComponents(outcome.state),
  });
  return outcome;
}

// Après une action sur la main : mémorise le webhook de l'éphémère si la
// main est terminée, rafraîchit le message public puis, si la manche vient
// d'être résolue, active « Manche suivante » sur l'éphémère de chaque joueur.
async function afterHandAction(webhookUrl, discordId, state, hand) {
  const done = hand.status === "termine";
  if (done) await saveHandWebhook(state.gid, state.manche, discordId, webhookUrl);
  const outcome = await refreshPublicMessage(state.gid);
  if (!done || outcome.inactive || outcome.final) return;
  if (outcome.resolved) {
    const webhooks = await readHandWebhooks(state.gid, state.manche);
    await activateNextButtons(state, Object.values({ ...webhooks, [discordId]: webhookUrl }));
  } else if (outcome.alreadyResolving) {
    // Résolution prise par un clic concurrent qui a pu lire les webhooks
    // avant l'enregistrement du nôtre.
    await activateNextButtons(state, [webhookUrl]);
  }
}

// PATCH des seuls composants : l'embed de la main reste affiché.
async function activateNextButtons(state, webhookUrls) {
  const components = buildNextComponents(state.gid, state.manche, state.totalManches, true);
  await Promise.all(webhookUrls.map((url) => patchOriginal(url, { components })));
}

const MESSAGE_INACTIVE = `⏰ Aucune partie en cours (abandonnée après ${DELAI_INACTIVITE} sans action). Relance \`/gobelet\` !`;

export async function handleJouer(webhookUrl, gid, discordId, username) {
  try {
    const result = await joinAndDeal(gid, discordId, username);
    // Clic simultané d'un même joueur : le clic en cours repeint le message.
    if (result.busy) return;

    if (result.inactive) {
      await patchOriginal(webhookUrl, { content: MESSAGE_INACTIVE, embeds: [], components: [] });
      return;
    }
    if (result.notYours) {
      await patchOriginal(webhookUrl, {
        content: "Cette partie solo n'est pas la tienne : lance la tienne avec `/gobelet` !",
        embeds: [],
        components: [],
      });
      return;
    }
    if (result.rosterLocked) {
      await patchOriginal(webhookUrl, {
        content:
          "Cette partie a déjà commencé (ou les sièges sont tous pris), tu ne peux pas rejoindre.",
        embeds: [],
        components: [],
      });
      return;
    }

    const state = result.state;
    await patchOriginal(webhookUrl, {
      embeds: [buildHandEmbed(state, result.hand, result.kept, result.used, result.opponents)],
      components: buildHandComponents(state, result.hand, result.kept, result.used),
    });

    if (result.isNew || result.hand.status !== "en_cours") {
      await afterHandAction(webhookUrl, discordId, state, result.hand);
    }
  } catch (err) {
    console.error("[GobeletDuel] Échec Jouer:", err.message);
  }
}

export async function handleToggle(webhookUrl, gid, discordId, index) {
  try {
    const result = await toggleKept(gid, discordId, Number(index));

    if (result.inactive) {
      await patchOriginal(webhookUrl, { content: MESSAGE_INACTIVE, embeds: [], components: [] });
      return;
    }
    if (result.noHand) {
      await patchOriginal(webhookUrl, {
        content: `Clique d'abord sur **${nomBoutonJouer(result.state)}** pour lancer tes 5 dés !`,
        embeds: [],
        components: [],
      });
      return;
    }
    if (result.alreadyDone) {
      await patchOriginal(webhookUrl, {
        embeds: [buildHandEmbed(result.state, result.hand, NO_KEPT, result.used, result.opponents)],
        components: result.hand.status === "choix" ? buildHandComponents(result.state, result.hand, NO_KEPT, result.used) : [],
      });
      return;
    }

    await patchOriginal(webhookUrl, {
      embeds: [buildHandEmbed(result.state, result.hand, result.kept, result.used, result.opponents)],
      components: buildHandComponents(result.state, result.hand, result.kept, result.used),
    });
  } catch (err) {
    console.error("[GobeletDuel] Échec sélection de dé:", err.message);
  }
}

export async function handleRelancer(webhookUrl, gid, discordId) {
  try {
    const result = await relance(gid, discordId);
    // Clic simultané d'un même joueur : le clic en cours repeint le message.
    if (result.busy) return;

    if (result.inactive) {
      await patchOriginal(webhookUrl, { content: MESSAGE_INACTIVE, embeds: [], components: [] });
      return;
    }
    if (result.noHand) {
      await patchOriginal(webhookUrl, {
        content: `Clique d'abord sur **${nomBoutonJouer(result.state)}** pour lancer tes 5 dés !`,
        embeds: [],
        components: [],
      });
      return;
    }
    if (result.alreadyDone) {
      await patchOriginal(webhookUrl, {
        embeds: [buildHandEmbed(result.state, result.hand, NO_KEPT, result.used, result.opponents)],
        components: result.hand.status === "choix" ? buildHandComponents(result.state, result.hand, NO_KEPT, result.used) : [],
      });
      return;
    }

    await patchOriginal(webhookUrl, {
      embeds: [buildHandEmbed(result.state, result.hand, result.kept, result.used, result.opponents)],
      components: buildHandComponents(result.state, result.hand, result.kept, result.used),
    });

    await afterHandAction(webhookUrl, discordId, result.state, result.hand);
  } catch (err) {
    console.error("[GobeletDuel] Échec Relancer:", err.message);
  }
}

export async function handleValider(webhookUrl, gid, discordId) {
  try {
    const result = await valider(gid, discordId);
    // Clic simultané d'un même joueur : le clic en cours repeint le message.
    if (result.busy) return;

    if (result.inactive) {
      await patchOriginal(webhookUrl, { content: MESSAGE_INACTIVE, embeds: [], components: [] });
      return;
    }
    if (result.noHand) {
      await patchOriginal(webhookUrl, {
        content: `Clique d'abord sur **${nomBoutonJouer(result.state)}** pour lancer tes 5 dés !`,
        embeds: [],
        components: [],
      });
      return;
    }
    if (result.alreadyDone) {
      await patchOriginal(webhookUrl, {
        embeds: [buildHandEmbed(result.state, result.hand, NO_KEPT, result.used, result.opponents)],
        components: result.hand.status === "choix" ? buildHandComponents(result.state, result.hand, NO_KEPT, result.used) : [],
      });
      return;
    }

    if (result.notEligible) {
      // Garde-fou : le bouton ne devrait normalement pas être cliquable
      // dans ce cas (voir buildHandComponents) — on repeint juste l'état réel.
      await patchOriginal(webhookUrl, {
        embeds: [buildHandEmbed(result.state, result.hand, result.kept, result.used, result.opponents)],
        components: buildHandComponents(result.state, result.hand, result.kept, result.used),
      });
      return;
    }

    await patchOriginal(webhookUrl, {
      embeds: [buildHandEmbed(result.state, result.hand, result.kept, result.used, result.opponents)],
      components: buildHandComponents(result.state, result.hand, result.kept, result.used),
    });

    await afterHandAction(webhookUrl, discordId, result.state, result.hand);
  } catch (err) {
    console.error("[GobeletDuel] Échec Valider:", err.message);
  }
}

// Select de fin de main : fige la combinaison choisie par le joueur.
export async function handleChoisir(webhookUrl, gid, discordId, category) {
  try {
    const result = await choisir(gid, discordId, category);
    // Clic simultané d'un même joueur : le clic en cours repeint le message.
    if (result.busy) return;

    if (result.inactive) {
      await patchOriginal(webhookUrl, { content: MESSAGE_INACTIVE, embeds: [], components: [] });
      return;
    }
    if (result.noHand) {
      await patchOriginal(webhookUrl, {
        content: `Clique d'abord sur **${nomBoutonJouer(result.state)}** pour lancer tes 5 dés !`,
        embeds: [],
        components: [],
      });
      return;
    }

    await patchOriginal(webhookUrl, {
      embeds: [buildHandEmbed(result.state, result.hand, NO_KEPT, result.used, result.opponents)],
      components: buildHandComponents(result.state, result.hand, NO_KEPT, result.used),
    });

    if (!result.alreadyDone) {
      await afterHandAction(webhookUrl, discordId, result.state, result.hand);
    }
  } catch (err) {
    console.error("[GobeletDuel] Échec choix de combinaison:", err.message);
  }
}

// ── Bouton [📖 Règles] — éphémère, statique ────────────────────────

function buildReglesEmbed() {
  return {
    title: "📖 Règles du Jeu du Gobelet Duel",
    description: [
      "En solo (défi de score) ou à 2 joueurs, sur plusieurs manches.",
      "",
      "**Inscription :** clique sur **Jouer** pour rejoindre. Dès que tous les sièges sont pris, les inscriptions sont définitivement closes. En solo, seul celui qui a lancé la partie peut jouer.",
      "",
      "**Déroulement (1 main par manche) :**",
      "🎲 **Jouer** (puis **Reprendre ma partie**) : lance tes 5 dés.",
      "🔒 **Clique sur un dé** pour le conserver (ou le relâcher) avant la relance.",
      "🔁 **Relancer** : relance tous les dés non conservés. Possible 2 fois, donc 3 tirages au total.",
      "👍 **Valider** : dès que tes dés forment une combinaison encore libre (hors Joker), arrête tes relances immédiatement.",
      "🎯 **Choix de la combinaison** : si tes dés en forment plusieurs encore libres (Joker compris), choisis celle à retenir dans la liste, par exemple pour garder la plus payante pour une autre manche.",
      "",
      "**Une combinaison différente à chaque manche :** chaque combinaison ne rapporte des points qu'une seule fois par partie. Les combinaisons déjà réalisées ne sont plus proposées ; s'il n'en reste aucune dans tes dés : 0 pt. Ta main affiche aussi celles déjà réalisées par tes adversaires.",
      "",
      "**Barème :**",
      ...formatBaremeLines(),
      "",
      `Une manche se termine dès que toutes les places sont prises et que chaque joueur a fini sa main (combinaison choisie). Le classement cumulé à la fin de la dernière manche désigne le(s) vainqueur(s) de la partie. Sans action pendant ${DELAI_INACTIVITE}, la partie est abandonnée.`,
    ].join("\n"),
    color: GOBELETDUEL_COLOR,
  };
}

export async function handleRegles(webhookUrl) {
  try {
    await patchOriginal(webhookUrl, {
      embeds: [buildReglesEmbed()],
      components: [],
    });
  } catch (err) {
    console.error("[GobeletDuel] Échec Règles:", err.message);
  }
}
