// ============================================================
// robinson.js — Handlers Discord de Robinson (survie collaborative,
// 7 jours). Publication quotidienne (postRobinson, appelée uniquement par
// jeux/scripts/postRobinson.js), boutons du message public (Pêcher, Eau,
// Bois, Radeau, Embarquer, Règles). Règles : jeux/CONTRIBUTING.md, section
// « Robinson ».
// ============================================================

import {
  RESSOURCES,
  RECOLTES,
  ACTIONS,
  loadRobinsonConfig,
  loadNarratifs,
  readState,
  writeState,
  isTooSoonSinceLastClosure,
  journeeOuverte,
  tirerMeteo,
  prevoirMeteo,
  rendement,
  planchesRequises,
  radeauPret,
  stocksDuSoir,
  resoudreNuit,
  computeMancheScore,
  recordVote,
  readVote,
  tallyVotes,
  countUniqueVoters,
  clearVotes,
  embarquer,
  readABord,
  readJoursJoues,
  readUsernames,
  groupesBadge,
  estPnj,
  jouerPnj,
  archiveManche,
  listManches,
  resetPartie,
} from "../../services/robinson.js";
import { encodePlateau } from "../../services/robinsonImage.js";
import { getRoleIdByName, MINI_JEUX_ROLE_NAME } from "@clash/commun/discordRoles.js";
import { resolveDisplayName } from "@clash/commun/discordUsers.js";
import { versV2 as versV2Commun } from "../composantsV2.js";
import { formatUtcTimeAsParis } from "../../services/saison.js";
import { URL_JEUX } from "../../services/urlJeux.js";

const ROBINSON_COLOR = 0x1abc9c;
const EMOJI_RESSOURCE = { poisson: "🐟", eau: "💧", bois: "🪵" };
const NOM_RESSOURCE = { poisson: "du poisson", eau: "de l’eau", bois: "du bois" };

export const versV2 = (embeds, components = [], roleId = null) =>
  versV2Commun(embeds, components, roleId, ROBINSON_COLOR);

// Heure de Paris du réveil de l'île : publication du cron (7h08 UTC), soit
// 8h en hiver et 9h en été. « Minuit » reste minuit toute l'année.
const heureReveil = () => formatUtcTimeAsParis(7).replace("h00", " h");

const pluriel = (n, mot) => `${n} ${mot}${n > 1 ? "s" : ""}`;
const listeNoms = (noms) => (noms.length > 1 ? `${noms.slice(0, -1).join(", ")} et ${noms.at(-1)}` : noms[0] ?? "");
// PNJ du salon de test : pseudo stocké, aucun appel Discord
const nomAffiche = (discordId, fallback) =>
  estPnj(discordId) ? Promise.resolve(fallback ?? "PNJ") : resolveDisplayName(discordId, fallback);

// Illustrations (annonce, fin de partie) : frontend/public/images/robinson/
function robinsonImageUrl(numero) {
  return `${URL_JEUX}/images/robinson/rob-${String(numero).padStart(2, "0")}.webp`;
}

// Sélection déterministe (par jour) : le texte ne change pas d'un
// rafraîchissement à l'autre du même message.
const choisir = (pool, graine) => (pool?.length ? pool[((graine % pool.length) + pool.length) % pool.length] : "");

const meteoLabel = (config, id) => `${config.meteos[id].emoji} ${config.meteos[id].nom}`;

// ── Vue du jour ────────────────────────────────────────────────────

function lignesRendement(config, meteoId) {
  return `Chaque joueur rapporte : ${Object.entries(RECOLTES)
    .map(([actionId, r]) => `${EMOJI_RESSOURCE[r]} ${rendement(config, meteoId, actionId)}`)
    .join(" · ")}`;
}

function plateauUrl(config, state, { counts, V, nbABord }) {
  const { apresRecoltes, repas } = stocksDuSoir(state.stocks, counts, state.vVeille ?? 0, state.jour, state.meteo, config);
  const d = encodePlateau({
    jour: state.jour,
    duree: config.duree_jours,
    meteo: state.meteo,
    prevision: state.prevision,
    passees: state.meteosPassees ?? [],
    stocks: apresRecoltes,
    besoin: repas ?? {},
    planches: state.planches + (counts.radeau || 0),
    objectif: planchesRequises(V, config),
    aBord: nbABord,
  });
  return `${URL_JEUX}/api/robinson/plateau?d=${d}`;
}

// Lignes sous l'image : stocks (récoltes du jour comprises), repas de la
// nuit, Radeau, embarquement
function lignesSituation(config, state, { counts, V, nbABord }) {
  const vRepas = state.vVeille ?? 0;
  const { apresRecoltes, repas, soir } = stocksDuSoir(state.stocks, counts, vRepas, state.jour, state.meteo, config);
  const lignes = [`${RESSOURCES.map((r) => `${EMOJI_RESSOURCE[r]} **${apresRecoltes[r]}**`).join(" · ")} (récoltes du jour comprises)`];
  lignes.push(
    repas
      ? `🍽️ Repas de cette nuit pour ${pluriel(vRepas, "joueur")} d’hier : ${RESSOURCES.map((r) => `−${repas[r]} ${EMOJI_RESSOURCE[r]}`).join(" ")}`
      : "🍞 Cette nuit, les vivres du navire suffisent.",
  );
  const manques = RESSOURCES.filter((r) => soir[r] < 0).map((r) => `${-soir[r]} ${EMOJI_RESSOURCE[r]}`);
  if (manques.length) lignes.push(`⚠️ **Il manque encore ${listeNoms(manques)} pour cette nuit !**`);
  const planchesSoir = state.planches + (counts.radeau || 0);
  lignes.push(
    V > 0
      ? `🛶 Radeau : **${pluriel(planchesSoir, "planche")}** à l’aube, il en faut **${planchesRequises(V, config)}** pour ${pluriel(V, "joueur")}`
      : `🛶 Radeau : **${pluriel(planchesSoir, "planche")}** (${config.planches_par_joueur} par joueur du jour pour partir)`,
  );
  if (radeauPret(planchesSoir, V, config)) {
    lignes.push(
      "✅ **Le Radeau est prêt : embarquez !** Il partira au premier matin ensoleillé.",
      `🚣 ${pluriel(nbABord, "joueur")} à bord`,
    );
  }
  return lignes;
}

async function buildJourEmbed(config, state, { counts, V, nbABord }) {
  const narratifs = await loadNarratifs();
  const lignes = [];
  if (state.jour === 1) {
    lignes.push(narratifs.intro_jour1.replaceAll("{jour_tsunami}", config.duree_jours + 1), "");
  } else if (state.bilan?.length) {
    lignes.push("**🌙 Cette nuit**", ...state.bilan, "");
  }
  lignes.push(
    `### ${meteoLabel(config, state.meteo)} aujourd’hui`,
    lignesRendement(config, state.meteo),
    choisir(narratifs.meteo?.[state.meteo], state.jour),
    state.jour < config.duree_jours
      ? `🔭 Demain : ${meteoLabel(config, state.prevision)} probable`
      : `🔭 Demain à l’aube : ${meteoLabel(config, state.prevision)} probable (dernière chance avant le tsunami)`,
  );
  return {
    title: `🏝️ Robinson (Jour ${state.jour}/${config.duree_jours})`,
    description: lignes.join("\n"),
    color: ROBINSON_COLOR,
    image: { url: plateauUrl(config, state, { counts, V, nbABord }) },
    apres: lignesSituation(config, state, { counts, V, nbABord }).join("\n"),
    footer: {
      text: `🏝️ ${pluriel(V, "joueur")} aujourd’hui · Un choix par jour, définitif · Jusqu’à minuit`,
    },
  };
}

const boutonRegles = { type: 2, style: 2, label: "Règles", emoji: { name: "📖" }, custom_id: "robinson_regles" };

function buildJourComponents(config, state, { counts, V }) {
  const rangees = [
    {
      type: 1,
      components: [
        ...ACTIONS.map((id) => ({
          type: 2,
          style: 2,
          label: `${config.actions[id].label} (${counts[id] || 0})`,
          emoji: { name: config.actions[id].emoji },
          custom_id: `robinson_vote:${state.jour}:${id}`,
        })),
        boutonRegles,
      ],
    },
  ];
  // Seconde rangée (5 boutons au maximum par rangée) dès que le Radeau est prêt
  if (radeauPret(state.planches + (counts.radeau || 0), V, config)) {
    rangees.push({
      type: 1,
      components: [{ type: 2, style: 3, label: "Embarquer", emoji: { name: "🚣" }, custom_id: `robinson_embarquer:${state.jour}` }],
    });
  }
  return rangees;
}

async function lireJour(jour) {
  const [counts, V, aBord] = await Promise.all([tallyVotes(jour), countUniqueVoters(jour), readABord()]);
  return { counts, V, nbABord: Object.keys(aBord).length };
}

async function vueJour(config, state, jourLu = null) {
  const lu = jourLu ?? (await lireJour(state.jour));
  return {
    embeds: [await buildJourEmbed(config, state, lu)],
    components: buildJourComponents(config, state, lu),
  };
}

// ── Bilan de la nuit ───────────────────────────────────────────────

function lignesBilan(config, res, { counts, V, nbABord }, vRepas, jour) {
  const lignes = [];
  if (V === 0) lignes.push("Personne n’a travaillé hier.");
  const recoltes = RESSOURCES.filter((r) => res.recoltes[r] > 0).map((r) => `+${res.recoltes[r]} ${EMOJI_RESSOURCE[r]}`);
  if (counts.radeau) recoltes.push(`+${pluriel(counts.radeau, "planche")}`);
  if (recoltes.length) lignes.push(`Travail du jour : ${recoltes.join(" · ")}`);
  lignes.push(
    res.repas
      ? `🍽️ Repas pour ${pluriel(vRepas, "joueur")} : ${RESSOURCES.map((r) => `−${res.repas[r]} ${EMOJI_RESSOURCE[r]}`).join(" ")}`
      : jour === 1 && config.nuit1_gratuite
        ? "🍞 Les vivres du navire ont suffi pour la première nuit."
        : "🍽️ Personne à nourrir cette nuit.",
  );
  if (res.issue === "defaite" && res.cause === "famine") return lignes;
  const aube = config.meteos[res.meteoAube];
  const pret = radeauPret(res.planches, V, config);
  if (aube.depart && !pret) {
    lignes.push(`${aube.emoji} Grand soleil ce matin, mais le Radeau n’est pas prêt (${res.planches}/${planchesRequises(V, config)} planches).`);
  } else if (aube.depart && pret && nbABord === 0) {
    lignes.push(`${aube.emoji} Grand soleil et Radeau prêt ce matin… mais personne n’était à bord !`);
  } else if (!aube.depart && pret) {
    lignes.push(`${aube.emoji} ${aube.nom} ce matin : impossible de prendre la mer, le Radeau attend.`);
  }
  return lignes;
}

// ── Fin de partie ──────────────────────────────────────────────────

export function outcomeLabel(outcome) {
  if (outcome === "victoire_radeau") return "🛶 Victoire (Radeau)";
  // Ancienne victoire par survie (manches archivées avant la refonte)
  if (outcome === "victoire_jour11") return "🚢 Victoire (survie)";
  return "💀 Défaite";
}

function lignesManches(manches, config, currentManche) {
  if (!manches.length) return [];
  const best = manches.reduce((a, b) =>
    computeMancheScore(b.outcome, b.jour, config.duree_jours) > computeMancheScore(a.outcome, a.jour, config.duree_jours) ? b : a,
  );
  return [
    "",
    "**📊 Manches précédentes**",
    ...manches.map((m) => {
      const quand = m.outcome === "victoire_radeau" ? `départ au Jour ${m.jour}` : `jour ${m.jour}`;
      return `${m.manche === best.manche ? "🏆 " : ""}Manche ${m.manche} : ${outcomeLabel(m.outcome)}, ${quand}${m.manche === currentManche ? " *(cette manche)*" : ""}`;
    }),
  ];
}

async function lignesGroupes(groupes, usernames) {
  const lignes = [];
  for (const { jours, ids } of groupes) {
    const noms = await Promise.all(ids.map((id) => nomAffiche(id, usernames[id])));
    lignes.push(`${pluriel(jours, "jour")} : ${listeNoms(noms)}`);
  }
  return lignes;
}

async function lignesBadge(victoire) {
  const [joursJoues, aBord, usernames] = await Promise.all([readJoursJoues(), readABord(), readUsernames()]);
  if (victoire) {
    const { partis, restes } = groupesBadge(joursJoues, aBord);
    const lignes = ["**🚣 Partis en Radeau**", ...(await lignesGroupes(partis, usernames))];
    if (restes.length) lignes.push("", "**🏝️ Restés sur l’île**", ...(await lignesGroupes(restes, usernames)));
    return lignes;
  }
  const { tous } = groupesBadge(joursJoues);
  return tous.length ? ["**🏅 Naufragés de cette aventure**", ...(await lignesGroupes(tous, usernames))] : [];
}

async function buildFinEmbed(config, res, bilan, manches, currentManche) {
  const narratifs = await loadNarratifs();
  const victoire = res.issue === "victoire_radeau";
  const titre = victoire
    ? "🛶 Le Radeau a pris la mer !"
    : res.cause === "famine"
      ? "💀 Naufrage : le camp n’a pas tenu"
      : "🌊 Le tsunami a emporté le camp";
  const recit = victoire
    ? narratifs.fin.victoire_radeau
    : res.cause === "famine"
      ? narratifs.fin.famine.replaceAll("{manque}", listeNoms(res.manque.map((r) => NOM_RESSOURCE[r])))
      : narratifs.fin.pas_de_depart.replaceAll("{jour_tsunami}", config.duree_jours + 1);
  const badge = await lignesBadge(victoire);
  return {
    title: titre,
    description: ["**🌙 Cette nuit**", ...bilan, "", recit].join("\n"),
    color: victoire ? 0xf1c40f : 0x2c3e50,
    image: { url: robinsonImageUrl(victoire ? 10 : 4) },
    apres: [...badge, ...lignesManches(manches, config, currentManche)].join("\n"),
  };
}

// ── Annonce ────────────────────────────────────────────────────────

function buildAnnonceEmbed(config) {
  return {
    title: "🏝️ Robinson : le navire lève l’ancre",
    description: [
      `Le clan embarque pour le prochain tournoi d’Arène… mais la météo s’annonce capricieuse. Naufragés sur une île, sans espoir de secours, vous aurez **${config.duree_jours} jours** pour construire un Radeau et partir avant qu’un tsunami ne frappe l’île.`,
      "",
      "Plus d’infos ? Clique sur *Règles* ci-dessous.",
    ].join("\n"),
    color: ROBINSON_COLOR,
    image: { url: robinsonImageUrl(1) },
    footer: { text: `La partie commence demain à ${heureReveil()}.` },
  };
}

// ── Publication quotidienne ────────────────────────────────────────

async function discordFetch(chemin, options = {}) {
  const token = process.env.DISCORD_TOKEN;
  if (!token) throw new Error("DISCORD_TOKEN manquant.");
  return fetch(`https://discord.com/api/v10${chemin}`, {
    ...options,
    headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json", ...(options.headers || {}) },
  });
}

// Supprime le message de la veille (tolérant), poste le nouveau, écrit l'état
async function publishAndWriteState(channelId, previousState, nouvelEtat, { embeds, components, ping }) {
  if (previousState?.messageId && previousState?.channelId) {
    try {
      const del = await discordFetch(`/channels/${previousState.channelId}/messages/${previousState.messageId}`, { method: "DELETE" });
      if (!del.ok && del.status !== 404) console.warn(`[Robinson] Échec suppression du message de la veille (${del.status}), publication quand même.`);
    } catch (err) {
      console.warn("[Robinson] Erreur réseau à la suppression du message de la veille:", err.message);
    }
  }
  const roleId = ping ? await getRoleIdByName(MINI_JEUX_ROLE_NAME) : null;
  const res = await discordFetch(`/channels/${channelId}/messages`, { method: "POST", body: JSON.stringify(versV2(embeds, components, roleId)) });
  if (!res.ok) throw new Error(`Erreur envoi salon Discord (${res.status}): ${await res.text().catch(() => "")}`);
  const message = await res.json();
  const state = { ...nouvelEtat, channelId, messageId: message.id, publishedAt: new Date().toISOString() };
  await writeState(state);
  return { jour: state.jour, embeds, message, termine: Boolean(state.termine), state };
}

// PNJ du salon de test : choix du jour, embarquement, puis rafraîchissement
async function faireJouerPnj(config, state) {
  await jouerPnj(state.jour, state.planches, config);
  await refreshPublicMessage(state, config, process.env.DISCORD_TOKEN);
}

// `pnj` : 5 joueurs fictifs jouent chaque jour (jamais sur le salon public).
// ⚠️ Ping seulement si `isPublic` et sans `noPing` (annonce, chaque jour, fin) :
// jamais de ping sur le salon de test, quel que soit l'appelant.
export async function postRobinson(
  channelId,
  { dryRun = false, noPing = false, isPublic = false, requireActiveState = false, force = false, pnj = false } = {},
) {
  const config = await loadRobinsonConfig();
  const ping = isPublic && !noPing;
  const avecPnj = pnj && !isPublic;
  const state = await readState();

  if (state?.termine) return { termine: true };
  if (state && !dryRun && !force && isTooSoonSinceLastClosure(state.publishedAt)) {
    return { skipped: true, reason: "tooSoonSinceLastClosure", publishedAt: state.publishedAt };
  }
  // Une partie active sur un AUTRE salon n'est jamais reprise ici (état
  // partagé entre salon de test et salon public)
  if (state && state.channelId !== channelId) return { wrongChannel: true, activeChannelId: state.channelId };
  if (!state && requireActiveState) return { skipped: true };

  // 1) Aucun état : jour d'annonce (jamais le Jour 1 directement)
  if (!state) {
    const embeds = [buildAnnonceEmbed(config)];
    const components = [{ type: 1, components: [boutonRegles] }];
    if (dryRun) return { dryRun: true, phase: "annonce", embeds, components };
    return publishAndWriteState(channelId, null, { phase: "annonce", jour: null, termine: false }, { embeds, components, ping });
  }

  // 2) Annonce -> Jour 1 : nouvelle partie
  if (state.phase === "annonce") {
    const meteoSuivante = tirerMeteo(config);
    const jour1 = {
      phase: "jour",
      jour: 1,
      termine: false,
      stocks: { poisson: 0, eau: 0, bois: 0 },
      planches: 0,
      meteo: tirerMeteo(config),
      meteoSuivante,
      prevision: prevoirMeteo(meteoSuivante, config),
      meteosPassees: [],
      vVeille: 0,
      bilan: null,
    };
    const vue = await vueJour(config, jour1, { counts: {}, V: 0, nbABord: 0 });
    if (dryRun) return { dryRun: true, phase: "jour", jour: 1, ...vue };
    await resetPartie();
    const out = await publishAndWriteState(channelId, state, jour1, { ...vue, ping });
    if (avecPnj) await faireJouerPnj(config, out.state);
    return out;
  }

  // 3) Nuit du jour actif, puis aube : jour suivant ou fin de partie
  const lu = await lireJour(state.jour);
  const res = resoudreNuit({
    jour: state.jour,
    stocks: state.stocks,
    planches: state.planches,
    counts: lu.counts,
    V: lu.V,
    vRepas: state.vVeille ?? 0,
    nbABord: lu.nbABord,
    meteo: state.meteo,
    meteoAube: state.meteoSuivante,
    config,
  });
  const bilan = lignesBilan(config, res, lu, state.vVeille ?? 0, state.jour);

  if (res.issue) {
    // Jour de la manche : aube du départ (victoire) ou dernier jour joué
    const jourManche = res.issue === "victoire_radeau" ? state.jour + 1 : state.jour;
    let currentManche = null;
    if (!dryRun && isPublic) {
      const joursJoues = await readJoursJoues();
      currentManche = await archiveManche({
        outcome: res.issue,
        cause: res.cause,
        jour: jourManche,
        planches: res.planches,
        nbJoueurs: Object.values(joursJoues).filter((n) => n > 0).length,
        nbABord: lu.nbABord,
        resolvedAt: new Date().toISOString(),
      });
    }
    const embeds = [await buildFinEmbed(config, res, bilan, await listManches({ limit: 10 }), currentManche)];
    if (dryRun) return { dryRun: true, final: true, outcome: res.issue, cause: res.cause, embeds, res };
    await clearVotes(state.jour);
    const out = await publishAndWriteState(
      channelId,
      state,
      { ...state, jour: state.jour, stocks: res.stocks, planches: res.planches, termine: true, issue: res.issue, cause: res.cause },
      { embeds, components: [], ping },
    );
    return { ...out, final: true, outcome: res.issue };
  }

  const meteoSuivante = tirerMeteo(config);
  const suivant = {
    phase: "jour",
    jour: state.jour + 1,
    termine: false,
    stocks: res.stocks,
    planches: res.planches,
    meteo: state.meteoSuivante,
    meteoSuivante,
    prevision: prevoirMeteo(meteoSuivante, config),
    meteosPassees: [...(state.meteosPassees ?? []), state.meteo],
    vVeille: lu.V,
    bilan,
  };
  const aBord = lu.nbABord;
  const vue = await vueJour(config, suivant, { counts: {}, V: 0, nbABord: aBord });
  // ⚠️ Projection (dry-run, robinson:status) : jamais la vraie météo de demain
  if (dryRun) return { dryRun: true, jour: suivant.jour, ...vue, res, stocks: res.stocks, planches: res.planches };
  await clearVotes(state.jour);
  const out = await publishAndWriteState(channelId, state, suivant, { ...vue, ping });
  if (avecPnj) await faireJouerPnj(config, out.state);
  return out;
}

// ── Interactions ───────────────────────────────────────────────────

async function patchOriginal(webhookUrl, payload) {
  if (!webhookUrl) return;
  try {
    await fetch(`${webhookUrl}/messages/@original`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    console.error("[Robinson] Échec PATCH:", err.message);
  }
}

const messageSeul = (content) => ({ content, embeds: [], components: [] });

// Réaffiche le message public (compteurs, projection, bouton Embarquer).
// Exportée pour jeux/scripts/robinsonRefresh.js : corrige un texte sans
// avancer le jour.
export async function refreshPublicMessage(state, config, botToken) {
  if (!state?.messageId || state.phase !== "jour" || state.termine) return;
  const vue = await vueJour(config, state);
  try {
    const res = await fetch(`https://discord.com/api/v10/channels/${state.channelId}/messages/${state.messageId}`, {
      method: "PATCH",
      headers: { Authorization: `Bot ${botToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(versV2(vue.embeds, vue.components)),
    });
    if (!res.ok) console.warn(`[Robinson] Échec rafraîchissement du message (${res.status}).`);
  } catch (err) {
    console.warn("[Robinson] Erreur réseau au rafraîchissement du message:", err.message);
  }
}

// Jour cliquable : renvoie l'état, ou null après avoir répondu au joueur
async function etatJouable(webhookUrl, jour) {
  const state = await readState();
  if (!state || state.termine || state.phase !== "jour" || String(state.jour) !== String(jour)) {
    await patchOriginal(webhookUrl, messageSeul("La journée a changé, regarde le nouveau message !"));
    return null;
  }
  if (!journeeOuverte(state.publishedAt)) {
    await patchOriginal(webhookUrl, messageSeul(`🌙 Toute l’île dort : le nouveau jour arrive vers ${heureReveil()}.`));
    return null;
  }
  return state;
}

function confirmation(config, state, actionId) {
  const action = config.actions[actionId];
  if (actionId === "radeau") return `${action.emoji} Tu travailles au Radeau : +1 planche.`;
  const r = RECOLTES[actionId];
  const verbe = { peche: "Tu pars pêcher", eau: "Tu vas chercher de l’eau", bois: "Tu coupes du bois" }[actionId];
  return `${action.emoji} ${verbe} : +${rendement(config, state.meteo, actionId)} ${EMOJI_RESSOURCE[r]} pour le camp cette nuit (${meteoLabel(config, state.meteo)}).`;
}

export async function handleVoteButton(webhookUrl, jour, actionId, discordId, username, botToken) {
  try {
    const state = await etatJouable(webhookUrl, jour);
    if (!state) return;
    const config = await loadRobinsonConfig();
    if (!ACTIONS.includes(actionId)) {
      await patchOriginal(webhookUrl, messageSeul("Ce bouton n’est plus valable, utilise le message du jour !"));
      return;
    }
    const result = await recordVote(state.jour, discordId, actionId, username);
    if (result.status === "rejected") {
      const choisi = config.actions[result.existing]?.label ?? "une autre action";
      await patchOriginal(webhookUrl, messageSeul(`Tu as déjà choisi aujourd’hui (${choisi}) : ton choix est définitif jusqu’à demain !`));
      return;
    }
    if (result.status === "already_recorded") {
      await patchOriginal(webhookUrl, messageSeul(`${confirmation(config, state, actionId)}\nC’est déjà noté pour aujourd’hui !`));
      return;
    }
    const lu = await lireJour(state.jour);
    const aBord = (await readABord())[discordId] != null;
    const pret = radeauPret(state.planches + (lu.counts.radeau || 0), lu.V, config);
    const suite = pret && !aBord ? "\n✅ Le Radeau est prêt : tu peux embarquer !" : "";
    await patchOriginal(webhookUrl, messageSeul(`${confirmation(config, state, actionId)}${suite}`));
    await refreshPublicMessage(state, config, botToken);
  } catch (err) {
    console.error("[Robinson] Échec traitement du vote:", err.message);
  }
}

// Embarquement : geste gratuit en plus de l'action du jour, durable
export async function handleEmbarquer(webhookUrl, jour, discordId, botToken) {
  try {
    const state = await etatJouable(webhookUrl, jour);
    if (!state) return;
    const config = await loadRobinsonConfig();
    if ((await readABord())[discordId] != null) {
      await patchOriginal(webhookUrl, messageSeul("🚣 Tu es déjà à bord ! Le Radeau partira au premier matin ensoleillé."));
      return;
    }
    if (!(await readVote(state.jour, discordId))) {
      await patchOriginal(webhookUrl, messageSeul("Choisis d’abord ton action du jour, puis embarque !"));
      return;
    }
    const lu = await lireJour(state.jour);
    if (!radeauPret(state.planches + (lu.counts.radeau || 0), lu.V, config)) {
      await patchOriginal(
        webhookUrl,
        messageSeul(`Le Radeau n’est pas encore prêt : il faut ${config.planches_par_joueur} planches par joueur du jour.`),
      );
      return;
    }
    await embarquer(discordId, state.jour);
    await patchOriginal(webhookUrl, messageSeul("🚣 Tu es à bord ! Le Radeau partira au premier matin ensoleillé."));
    await refreshPublicMessage(state, config, botToken);
  } catch (err) {
    console.error("[Robinson] Échec embarquement:", err.message);
  }
}

// ── Règles (éphémère, statique) ────────────────────────────────────

function buildReglesEmbed(config) {
  const meteos = Object.values(config.meteos).map(
    (m) =>
      `${m.emoji} **${m.nom}** : ${RESSOURCES.map((r) => `${EMOJI_RESSOURCE[r]} ${m.rendements[r]}`).join(" · ")}${m.depart ? " (départ possible)" : ""}`,
  );
  return {
    title: "📖 Règles du jeu Robinson",
    description: [
      `Naufragés sur une île, personne ne viendra vous chercher : vous avez **${config.duree_jours} jours** pour construire un Radeau et partir avant le tsunami.`,
      "",
      `**Chaque jour, de ${heureReveil()} à minuit**, choisis une action : 🎣 Pêcher, 💧 Eau, 🪵 Bois ou 🛶 Radeau (un choix par jour, définitif). De minuit à ${heureReveil()}, toute l’île dort.`,
      "",
      "**La météo du jour** décide de ce que rapporte chaque joueur. La prévision pour demain se trompe une fois sur quatre.",
      ...meteos,
      "",
      "**Chaque nuit**, le camp mange 1 🐟 et boit 1 💧 par joueur de la veille, et le feu brûle 1 🪵 pour 2 (la première nuit, les vivres du navire suffisent). Le repas est donc connu dès le matin. S’il manque quoi que ce soit, c’est perdu.",
      "",
      `**Le Radeau** : chaque vote 🛶 ajoute 1 planche. Avec ${config.planches_par_joueur} planches par joueur du jour, le bouton 🚣 Embarquer apparaît (en plus de ton action du jour). Le Radeau part à l’aube s’il fait ☀️ et qu’au moins un joueur est à bord. Ceux qui n’ont pas embarqué restent sur l’île.`,
      "",
      `🌊 Un tsunami frappe l’île à l’aube du Jour ${config.duree_jours + 1} : si le Radeau n’est pas parti avant, c’est perdu.`,
    ].join("\n"),
    color: ROBINSON_COLOR,
  };
}

export async function handleRegles(webhookUrl) {
  try {
    await patchOriginal(webhookUrl, { embeds: [buildReglesEmbed(await loadRobinsonConfig())], components: [] });
  } catch (err) {
    console.error("[Robinson] Échec Règles du jeu:", err.message);
  }
}
