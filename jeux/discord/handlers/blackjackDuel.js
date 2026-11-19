// ============================================================
// blackjackDuel.js — Handlers Discord pour le Blackjack duel autonome
// (1 ou 2 joueurs, N manches), lancé à la demande via /blackjack.
//
// Développé EN PARALLÈLE du jeu spécial (_handlers/blackjack.js), sans
// aucun impact dessus : custom_id préfixés `blackjackduel_*` (jamais
// `blackjack_*`), état Redis dans jeux/services/blackjackDuel.js
// (`blackjackduel:*`), aucun import du service du jeu spécial.
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
  drawOrStand,
  checkAndResolveManche,
  listHands,
  canDouble,
  compareToDealer,
  dealerHasNatural,
  pointsForResult,
  saveHandWebhook,
  readHandWebhooks,
  readScores,
  INACTIVITE_SECONDES,
} from "../../services/blackjackDuel.js";
import { encodeFin, encodeMain, encodeManche, meilleureMain } from "../../services/blackjackImage.js";

const TRUST_ROYALE_URL = "https://trustroyale.vercel.app";
import {
  getRoleIdByName,
  MINI_JEUX_ROLE_NAME,
} from "@clash/commun/discordRoles.js";
import { resolveDisplayName } from "@clash/commun/discordUsers.js";
import { rangExAequo } from "@clash/commun/classement.js";

const BLACKJACKDUEL_COLOR = 0x2ecc71;
// « 2 minutes » : délai d'abandon d'une partie sans action
const DELAI_INACTIVITE = `${INACTIVITE_SECONDES / 60} minutes`;

// Cartes : en image (blackjackImage.js), sauf la carte visible du Croupier
// dans le message public.
const formatCard = (card) => `${card.rank}${card.suit}`;
const ptsLabel = (n) => `${n} point${n > 1 ? "s" : ""}`;

// ── Résolution des rôles/utilisateurs ────────────────────────────────

function extractMember(body) {
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
    const res = await fetch(`${webhookUrl}/messages/@original`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) console.error(`[BlackjackDuel] PATCH refusé (${res.status}) :`, (await res.text()).slice(0, 300));
  } catch (err) {
    console.error("[BlackjackDuel] Échec PATCH:", err.message);
  }
}

// Supprime la réponse éphémère différée : une fois la table publiée dans le
// salon, un accusé "Table ouverte" privé ne sert à rien.
async function deleteOriginal(webhookUrl) {
  if (!webhookUrl) return;
  try {
    await fetch(`${webhookUrl}/messages/@original`, { method: "DELETE" });
  } catch (err) {
    console.error("[BlackjackDuel] Échec DELETE:", err.message);
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
        `[BlackjackDuel] Échec édition du message public (${res.status}).`,
      );
    }
  } catch (err) {
    console.warn(
      "[BlackjackDuel] Erreur réseau à l'édition du message public:",
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
      console.warn(`[BlackjackDuel] Échec envoi du récapitulatif (${res.status}).`);
      await patchPublicMessage(state, payload);
      return;
    }
  } catch (err) {
    console.warn("[BlackjackDuel] Erreur réseau à l'envoi du récapitulatif:", err.message);
    await patchPublicMessage(state, payload);
    return;
  }
  await deletePublicMessage(state);
}

// Supprime le message public de la partie (fin de partie, ou partie contre
// le Croupier remplacée par un nouveau /blackjack).
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
      console.warn(`[BlackjackDuel] Échec suppression du message de la partie (${res.status}).`);
    }
  } catch (err) {
    console.warn("[BlackjackDuel] Erreur réseau à la suppression du message de la partie:", err.message);
  }
}

// ── Embed / composants du message public ──────────────────────────

// Jamais désactivé : le bouton "Jouer" (puis "Reprendre ma partie") sert aussi aux joueurs déjà inscrits
// pour recevoir leur main de la manche courante (à chaque manche). Le refus
// d'un NOUVEAU joueur une fois les inscriptions verrouillées est géré
// côté serveur (joinAndDeal) avec un message de rejet éphémère, pas en
// désactivant le bouton pour tout le monde.
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
              custom_id: `blackjackduel_jouer:${state.gid}`,
            }
          : {
              type: 2,
              style: 3,
              label: "Jouer",
              emoji: { name: "🃏" },
              custom_id: `blackjackduel_jouer:${state.gid}`,
            },
        {
          type: 2,
          style: 2,
          label: "Règles",
          emoji: { name: "📖" },
          custom_id: "blackjackduel_regles",
        },
      ],
    },
  ];
}

async function buildPendingLabel(state, hands) {
  const pendingIds = state.players.filter(
    (id) => !hands[id] || hands[id].status === "en_cours",
  );
  const missingSeats = state.maxPlayers - state.players.length;
  const lines = [];
  if (pendingIds.length > 0) {
    const names = await Promise.all(
      pendingIds.map((id) => resolveDisplayName(id, hands[id]?.username)),
    );
    lines.push(
      `⏳ ${names.length > 1 ? "Doivent" : "Doit"} encore jouer cette manche : ${names.join(", ")}`,
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

// Sans bilan explicite (rafraîchissement après un clic Jouer, Piocher…), le
// bilan est relu depuis la dernière manche de l'historique : il reste
// affiché pendant toute la manche suivante au lieu de disparaître au 1ᵉʳ clic.
// Image de la dernière manche terminée (blackjackImage.js) : le Croupier à
// gauche et le joueur à droite, ou les deux joueurs, et l'issue en bandeau.
async function urlImageManche(numero, results, dealer, isSolo, players = []) {
  // Ordre des sièges (gauche, droite), pas celui des mains en Redis
  const rang = (r) => (players.includes(r.discordId) ? players.indexOf(r.discordId) : players.length);
  const nommes = await Promise.all(
    [...results].sort((x, y) => rang(x) - rang(y)).map(async (r) => ({ ...r, nom: await resolveDisplayName(r.discordId, r.username) })),
  );
  const issue = (r) => (r.status === "bust" ? "bust" : r.result);
  const main = (r) => ({ nom: r.nom, cartes: r.cards, score: r.score, issue: issue(r), double: r.double });
  const gain = (r) => `+${pointsForResult(r.result, r.double)}`;
  let titre;
  let mains;
  if (isSolo) {
    const [r] = nommes;
    const croupierNaturel = dealerHasNatural(dealer);
    titre =
      r.status === "bust"
        ? "Dépassement"
        : r.result === "blackjack"
          ? `Blackjack ! ${gain(r)}`
          : r.result === "win"
            ? dealer.score > 21
              ? `Croupier dépasse 21 : ${gain(r)}`
              : `Gagné ${gain(r)}`
            : r.result === "push"
              ? `Égalité ${gain(r)}`
              : croupierNaturel
                ? "Blackjack du Croupier"
                : "Le Croupier gagne";
    const issueCroupier = croupierNaturel ? "blackjack" : dealer.score > 21 ? "bust" : "cache";
    mains = [{ nom: "Croupier", cartes: dealer.cards, score: dealer.score, issue: issueCroupier }, main(r)];
  } else {
    const gagnant = nommes.find((r) => r.result === "win" || r.result === "blackjack");
    titre = gagnant
      ? `${gagnant.result === "blackjack" ? "Blackjack de " : ""}${gagnant.nom}${gagnant.result === "blackjack" ? "," : " gagne"} ${gain(gagnant)}`
      : nommes.some((r) => r.result === "push")
        ? "Égalité"
        : "Personne ne gagne";
    mains = nommes.slice(0, 2).map(main);
  }
  const param = encodeManche({ titre: `Manche ${numero} : ${titre}`, mains });
  return `${TRUST_ROYALE_URL}/api/blackjack/manche?d=${param}`;
}

async function buildTableEmbed(
  state,
  {
    previousResults = state.history?.at(-1)?.results,
    previousDealer = state.history?.at(-1)?.dealer,
  } = {},
) {
  const hands = await listHands(state.gid, state.manche);
  const lines = [];
  const isSolo = state.maxPlayers === 1;

  // Bilan de la manche précédente : en image (mains côte à côte)
  const imageManche = previousResults ? await urlImageManche(state.manche - 1, previousResults, previousDealer, isSolo, state.players) : null;

  // Pas de "Manche X/Y" ici : déjà dans le titre de l'embed (buildTableEmbed
  // est utilisé pour le body) — même principe que buildDealerTargetSection
  // du jeu spécial (_handlers/blackjack.js), qui n'affiche pas non plus le
  // "Jour X/Y" en double dans son propre corps de message.
  const seatsLabel = `${state.players.length}/${state.maxPlayers} joueur${state.maxPlayers > 1 ? "s" : ""} inscrit${state.players.length > 1 ? "s" : ""}`;
  if (!isSolo) {
    // 2 joueurs : pas de Croupier — duel direct, résultat connu dès que
    // tous les joueurs inscrits ont fini leur main.
    lines.push(
      "## 🃏 Duel entre joueurs",
      "La meilleure main l'emporte. Résultat révélé dès que tout le monde a joué.",
      "",
      seatsLabel,
    );
  } else {
    // Contre le Croupier : sa première carte est visible, la seconde cachée ;
    // il joue sa main (pioche jusqu'à 17) après le joueur.
    lines.push(
      `## 🎩 Carte visible du Croupier : ${formatCard(state.dealer.cards[0])}`,
      "Sa seconde carte est cachée. Il jouera après toi (il pioche jusqu'à 17).",
      "",
      seatsLabel,
    );
  }

  if (state.players.length > 0) {
    lines.push(await buildPendingLabel(state, hands));
  } else {
    lines.push("Clique sur **Jouer** pour t'inscrire et jouer ta première main.");
  }

  // Pas de cron : le message d'une partie expirée resterait figé, d'où le
  // rappel du délai (relancé à chaque action). Texte fixe plutôt qu'un
  // horodatage relatif <t:…:R>, affiché dans la langue du client Discord.
  lines.push("", `⏰ Sans action pendant ${DELAI_INACTIVITE}, partie abandonnée.`);

  return {
    title: `🃏 Blackjack Duel${isSolo ? " contre le Croupier" : ""} (Manche ${state.manche}/${state.totalManches})`,
    description: lines.join("\n"),
    ...(imageManche ? { image: { url: imageManche } } : {}),
    color: BLACKJACKDUEL_COLOR,
    footer: {
      text: state.rosterLocked
        ? "Inscriptions closes, la partie a commencé."
        : `Places restantes : ${state.maxPlayers - state.players.length}`,
    },
  };
}

// Image de fin (blackjackImage.js) : pour chaque joueur, son score et
// l'issue de chaque manche, et sa meilleure main de la partie.
async function urlImageFin(state, ranking) {
  const history = state.history || [];
  const points = Object.fromEntries(ranking.map((r) => [r.discordId, r.points]));
  const joueurs = await Promise.all(
    state.players.map(async (discordId) => {
      const mains = history
        .map((h) => h.results.find((r) => r.discordId === discordId))
        .filter(Boolean)
        .map((r) => ({ cartes: r.cards, score: r.score, statut: r.status, issue: r.status === "bust" ? "bust" : r.result }));
      const username = mains.length ? history.flatMap((h) => h.results).find((r) => r.discordId === discordId)?.username : null;
      const best = meilleureMain(mains);
      return {
        nom: await resolveDisplayName(discordId, username),
        points: points[discordId] ?? 0,
        manches: mains.map((m) => ({ score: m.score, issue: m.issue })),
        meilleure: best ? { cartes: best.cartes, score: best.score } : null,
      };
    }),
  );
  const param = encodeFin({ joueurs, totalManches: state.totalManches });
  return `${TRUST_ROYALE_URL}/api/blackjack/fin?d=${param}`;
}

// Le détail des manches est dans l'image : le texte se limite au
// classement (au total contre le Croupier) et au high score.
async function buildFinalEmbed(state, ranking, highScore) {
  // Pseudos de la partie (mains jouées), en repli de l'affichage Discord
  const pseudos = new Map(
    (state.history || []).flatMap((h) => h.results).map((r) => [r.discordId, r.username]),
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
          ? resolvedRanking.map((r, i, list) => `${rangExAequo(list, i)}\\. ${r.username} (${ptsLabel(r.points)})`)
          : ["Personne n'a marqué de point."]),
      ];

  if (highScore) {
    const name = await resolveDisplayName(highScore.discordId, highScore.username);
    lines.push(`<:topplayers:1563107730397601792> High score : ${name} (${ptsLabel(highScore.points)})`);
  }

  // Titre au format des autres duels (« 🃏 Blackjack · Pseudo contre … »),
  // joueurs dans l'ordre des sièges
  const noms = await Promise.all(state.players.map((id) => resolveDisplayName(id, pseudos.get(id))));
  const titre = isSolo ? `${noms[0]} contre le Croupier` : noms.join(" contre ");

  return {
    title: `🃏 Blackjack · ${titre}`,
    description: lines.join("\n"),
    image: { url: await urlImageFin(state, ranking) },
    color: BLACKJACKDUEL_COLOR,
  };
}

// ── Commande /blackjack ──────────────────────────────────────────────

export async function handleBlackjackCommand(webhookUrl, body, { maxPlayers, totalManches }) {
  try {
    const channelId = body.channel_id;
    const { discordId } = extractMember(body);
    const result = await startGame(channelId, discordId, { maxPlayers, totalManches });

    if (result.alreadyActive) {
      await patchOriginal(webhookUrl, {
        content: `Une partie de Blackjack Duel à 2 joueurs est déjà en cours dans <#${result.state.channelId}>, attends qu'elle se termine (ou qu'elle soit abandonnée après ${DELAI_INACTIVITE} sans action).`,
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
    console.error("[BlackjackDuel] Échec lancement:", err.message);
    await patchOriginal(webhookUrl, {
      content: "⚠️ Erreur lors du lancement de la partie.",
      embeds: [],
      components: [],
    });
  }
}

export async function handleBlackjackRoleRejected(webhookUrl) {
  await patchOriginal(webhookUrl, {
    content: "Tu n'as pas le rôle nécessaire (MINI-JEUX) pour lancer une partie.",
    embeds: [],
    components: [],
  });
}

// ── Main du joueur — Jouer / Piocher / Arrêter ─────────────────────

const MESSAGE_EN_COURS = (hand) =>
  canDouble(hand)
    ? "Pioche pour te rapprocher de 21, arrête-toi, ou double (une seule carte de plus, points doublés)."
    : "Pioche pour te rapprocher de 21, ou arrête-toi pour figer ton score.";

function introMain(hand) {
  if (hand.cards.length === 2 && hand.score === 21) return "🎉 Blackjack ! 21 sur deux cartes.";
  if (hand.double) return `💰 Mise doublée : tu t'arrêtes à ${hand.score}.`;
  return `🛑 Tu t'arrêtes à ${hand.score}.`;
}

// Contre le Croupier, la manche se résout dès que la main est finie : sa main et
// le résultat sont dévoilés aussitôt. En 1v1, résultat quand les deux ont
// joué.
function handStatusMessage(hand, dealer, isSolo) {
  if (hand.status === "en_cours") return MESSAGE_EN_COURS(hand);
  if (!isSolo) {
    if (hand.status === "bust") return `💥 Tu dépasses 21${hand.double ? " sur ta mise doublée" : ""}, ta main est perdue pour cette manche.`;
    return `${introMain(hand)} Résultat connu dès que tous les joueurs auront fini leur main.`;
  }

  const result = compareToDealer(hand, dealer);
  const gain = pointsForResult(result, hand.double);
  if (dealerHasNatural(dealer) && hand.cards.length === 2) {
    return result === "push"
      ? "🎩 Le Croupier a un Blackjack, mais toi aussi : égalité, tu gagnes quand même 1 point !"
      : "🎩 Le Croupier a un Blackjack, impossible de le battre cette manche. Pas de point.";
  }
  if (hand.status === "bust") return `💥 Tu dépasses 21${hand.double ? " sur ta mise doublée" : ""}, ta main est perdue pour cette manche.`;
  const croupier = dealer.score > 21 ? `Le Croupier dépasse 21 (${dealer.score})` : `Le Croupier fait ${dealer.score}`;
  if (result === "blackjack") return `${introMain(hand)} ${croupier} : tu gagnes ${ptsLabel(gain)} !`;
  if (result === "win") return `${introMain(hand)} ${croupier} : tu gagnes ${ptsLabel(gain)} !`;
  if (result === "push") return `${introMain(hand)} ${croupier} aussi : égalité, tu gagnes quand même ${ptsLabel(gain)} !`;
  return `${introMain(hand)} ${croupier}, pas de point cette manche.`;
}

// Image de la main (blackjackImage.js) : contre le Croupier, sa carte visible
// et une carte cachée tant que la main est en cours (⚠️ rien d'autre ne
// doit fuiter), sa main entière ensuite ; main du joueur en bas, pastille
// colorée par l'issue quand elle est connue. En 1v1, la main du joueur seule.
function urlImageMain(state, hand) {
  const isSolo = state.maxPlayers === 1;
  const { dealer } = state;
  const devoile = isSolo && hand.status !== "en_cours";
  const croupier = !isSolo
    ? null
    : devoile
      ? { nom: "Croupier", cartes: dealer.cards, score: dealer.score }
      : { nom: "Croupier", cartes: dealer.cards.slice(0, 1), cache: true };
  const param = encodeMain({
    joueur: {
      nom: hand.username ?? "Toi",
      cartes: hand.cards,
      score: hand.score,
      statut: hand.status,
      issue: devoile ? compareToDealer(hand, dealer) : null,
      double: hand.double,
    },
    croupier,
    legende: `Manche ${state.manche}/${state.totalManches}`,
  });
  return `${TRUST_ROYALE_URL}/api/blackjack/main?d=${param}`;
}

// Ligne de score sous le statut de la main : le sien seul contre
// le Croupier, les deux en 1v1 (le joueur d'abord).
async function scoreLine(state, discordId) {
  const scores = await readScores(state);
  const moi = scores.find((s) => s.discordId === discordId)?.points ?? 0;
  const pts = (n) => `${n} pt${n > 1 ? "s" : ""}`;
  if (state.maxPlayers === 1) return `🏆 Score : **${pts(moi)}**`;
  const autres = scores.filter((s) => s.discordId !== discordId).map((s) => `${s.username ?? "Adversaire"} **${s.points}**`);
  return `🏆 Score : toi **${moi}**${autres.length ? `, ${autres.join(", ")}` : ""}`;
}

async function buildHandEmbed(state, hand, message, discordId) {
  return {
    title: `🃏 Ta main (Manche ${state.manche})`,
    description: `${message}\n${await scoreLine(state, discordId)}`,
    image: { url: urlImageMain(state, hand) },
    color: BLACKJACKDUEL_COLOR,
  };
}

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
          emoji: { name: "🃏" },
          custom_id: `blackjackduel_suivante:${manche + 1}:${gid}`,
          disabled: !ready,
        },
      ],
    },
  ];
}

function buildHandComponents(state, hand) {
  const manche = state.manche;
  if (hand.status !== "en_cours") return buildNextComponents(state.gid, manche, state.totalManches, false);
  return [
    {
      type: 1,
      components: [
        {
          type: 2,
          style: 2,
          label: "Piocher",
          emoji: { name: "👆" },
          custom_id: `blackjackduel_piocher:${manche}:${state.gid}`,
        },
        {
          type: 2,
          style: 1,
          label: "Arrêter",
          emoji: { name: "🛑" },
          custom_id: `blackjackduel_arreter:${manche}:${state.gid}`,
        },
        ...(canDouble(hand)
          ? [
              {
                type: 2,
                style: 2,
                label: "Doubler",
                emoji: { name: "💰" },
                custom_id: `blackjackduel_doubler:${manche}:${state.gid}`,
              },
            ]
          : []),
      ],
    },
  ];
}

// Après chaque action (Jouer, Piocher, Arrêter) qui peut terminer une main :
// vérifie si la manche (ou la partie) doit se résoudre, puis rafraîchit le
// message public en place. Seule la fin de partie est repostée
// (postFinalMessage).
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
    const embed = await buildFinalEmbed(outcome.state, outcome.ranking, outcome.highScore);
    await postFinalMessage(outcome.state, { embeds: [embed], components: [] });
    return outcome;
  }

  const embed = await buildTableEmbed(outcome.state, {
    previousResults: outcome.results,
    previousDealer: outcome.dealer,
  });
  await patchPublicMessage(outcome.state, {
    embeds: [embed],
    components: buildJoinComponents(outcome.state),
  });
  return outcome;
}

// Après une action sur la main : PATCH de l'éphémère du joueur et
// rafraîchissement du message public. Main terminée : la manche est d'abord
// résolue si possible, puis l'éphémère n'est édité qu'UNE fois, avec
// « Manche suivante » déjà dans son état final (deux PATCH rapprochés sur le
// même jeton d'interaction : le second, celui qui activait le bouton, était
// refusé par Discord). Les éphémères des autres joueurs sont activés ensuite.
async function afterHandAction(webhookUrl, discordId, state, hand, { refresh = true } = {}) {
  const message = handStatusMessage(hand, state.dealer, state.maxPlayers === 1);
  if (hand.status === "en_cours") {
    const embeds = [await buildHandEmbed(state, hand, message, discordId)];
    await patchOriginal(webhookUrl, { embeds, components: buildHandComponents(state, hand) });
    if (refresh) await refreshPublicMessage(state.gid);
    return;
  }
  await saveHandWebhook(state.gid, state.manche, discordId, webhookUrl);
  const outcome = await refreshPublicMessage(state.gid);
  // Résolution prise par un clic concurrent : la manche est close aussi.
  const ready = !outcome.inactive && (outcome.resolved || Boolean(outcome.alreadyResolving));
  // Après la résolution : le score inclut la manche qui vient de finir.
  const embeds = [await buildHandEmbed(state, hand, message, discordId)];
  await patchOriginal(webhookUrl, {
    embeds,
    components: buildNextComponents(state.gid, state.manche, state.totalManches, ready),
  });
  if (!outcome.resolved || outcome.final) return;
  const webhooks = await readHandWebhooks(state.gid, state.manche);
  delete webhooks[discordId];
  await activateNextButtons(state, Object.values(webhooks));
}

// PATCH des seuls composants : l'embed de la main reste affiché.
async function activateNextButtons(state, webhookUrls) {
  const components = buildNextComponents(state.gid, state.manche, state.totalManches, true);
  await Promise.all(webhookUrls.map((url) => patchOriginal(url, { components })));
}

const MESSAGE_INACTIVE = `⏰ Aucune partie en cours (abandonnée après ${DELAI_INACTIVITE} sans action). Relance \`/blackjack\` !`;

export async function handleJouer(webhookUrl, gid, discordId, username) {
  try {
    const result = await joinAndDeal(gid, discordId, username);

    if (result.inactive) {
      await patchOriginal(webhookUrl, { content: MESSAGE_INACTIVE, embeds: [], components: [] });
      return;
    }
    if (result.notYours) {
      await patchOriginal(webhookUrl, {
        content: "Cette partie contre le Croupier n'est pas la tienne : lance la tienne avec `/blackjack` !",
        embeds: [],
        components: [],
      });
      return;
    }
    if (result.rosterLocked) {
      await patchOriginal(webhookUrl, {
        content: "Cette partie a déjà commencé (ou les sièges sont tous pris), tu ne peux pas rejoindre.",
        embeds: [],
        components: [],
      });
      return;
    }

    // Main déjà en cours : rien à rafraîchir côté public.
    await afterHandAction(webhookUrl, discordId, result.state, result.hand, {
      refresh: result.isNew || result.hand.status !== "en_cours",
    });
  } catch (err) {
    console.error("[BlackjackDuel] Échec Jouer:", err.message);
  }
}

async function handleDrawOrStand(webhookUrl, gid, discordId, { draw, double = false }) {
  try {
    const result = await drawOrStand(gid, discordId, { draw, double });

    if (result.inactive) {
      await patchOriginal(webhookUrl, { content: MESSAGE_INACTIVE, embeds: [], components: [] });
      return;
    }
    if (result.noHand) {
      await patchOriginal(webhookUrl, {
        content: `Clique d'abord sur **${nomBoutonJouer(result.state)}** pour recevoir tes 2 premières cartes !`,
        embeds: [],
        components: [],
      });
      return;
    }
    if (result.cannotDouble) {
      await patchOriginal(webhookUrl, {
        embeds: [await buildHandEmbed(result.state, result.hand, "On ne peut doubler que sur ses 2 premières cartes.", discordId)],
        components: buildHandComponents(result.state, result.hand),
      });
      return;
    }
    if (result.alreadyDone) {
      await patchOriginal(webhookUrl, {
        embeds: [await buildHandEmbed(result.state, result.hand, "Ta main est déjà terminée pour cette manche.", discordId)],
        components: [],
      });
      return;
    }

    await afterHandAction(webhookUrl, discordId, result.state, result.hand);
  } catch (err) {
    console.error(`[BlackjackDuel] Échec ${double ? "Doubler" : draw ? "Piocher" : "Arrêter"}:`, err.message);
  }
}

export async function handlePiocher(webhookUrl, gid, discordId) {
  return handleDrawOrStand(webhookUrl, gid, discordId, { draw: true });
}

export async function handleArreter(webhookUrl, gid, discordId) {
  return handleDrawOrStand(webhookUrl, gid, discordId, { draw: false });
}

export async function handleDoubler(webhookUrl, gid, discordId) {
  return handleDrawOrStand(webhookUrl, gid, discordId, { draw: true, double: true });
}

// ── Bouton [📖 Règles] — éphémère, statique ────────────────────────

function buildReglesEmbed() {
  return {
    title: "📖 Règles du Blackjack Duel",
    description: [
      "Contre le Croupier ou à 2 joueurs, sur plusieurs manches.",
      "",
      "**Valeur des cartes :** 2 à 10 = leur valeur, Valet/Dame/Roi = 10, As = 11 ou 1 (ramené à 1 si besoin pour éviter de dépasser 21).",
      "",
      "**Inscription :** clique sur **Jouer** pour rejoindre. Dès que tous les sièges sont pris, les inscriptions sont définitivement closes. Contre le Croupier, seul celui qui a lancé la partie peut jouer.",
      "",
      "**Déroulement (1 main par manche) :**",
      "🃏 **Jouer** (puis **Reprendre ma partie**) : reçois 2 cartes.",
      "👆 **Piocher** : reçois une carte de plus (autant de fois que tu veux).",
      "🛑 **Arrêter** : fige ton score pour cette manche.",
      "💰 **Doubler** : sur tes 2 premières cartes seulement, une seule carte de plus puis ta main s'arrête, points doublés.",
      "Dépasser 21 = main perdue immédiatement pour la manche.",
      "",
      "**Contre le Croupier :** une de ses deux cartes est visible, l'autre est cachée. Il joue après toi : il pioche jusqu'à 17 et peut dépasser 21. Si elle a un Blackjack, ta main s'arrête tout de suite.",
      "",
      "**À 2 joueurs :** pas de Croupier, vous vous affrontez directement. La meilleure main non dépassée l'emporte, résultat révélé dès que tout le monde a joué sa main.",
      "",
      "**Résultat d'une manche :** le vainqueur gagne **2 points** (si le Croupier dépasse 21, toute main valide gagne). Égalité = **1 point**. **Blackjack** (21 avec tes 2 premières cartes) = **3 points**, et il bat un 21 en 3 cartes ou plus. Main doublée = points doublés. Une manche se termine dès que toutes les places sont prises et que chaque joueur a joué.",
      "",
      `Le classement cumulé à la fin de la dernière manche désigne le(s) vainqueur(s) de la partie. Sans action pendant ${DELAI_INACTIVITE}, la partie est abandonnée.`,
    ].join("\n"),
    color: BLACKJACKDUEL_COLOR,
  };
}

export async function handleRegles(webhookUrl) {
  try {
    await patchOriginal(webhookUrl, { embeds: [buildReglesEmbed()], components: [] });
  } catch (err) {
    console.error("[BlackjackDuel] Échec Règles:", err.message);
  }
}

export { extractMember };
