// ============================================================
// coffre.js — Handlers Discord du Coffre (jeu spécial de 7 jours,
// Mastermind quotidien). Publication une fois par jour (postCoffre, appelée
// uniquement par jeux/scripts/postCoffre.js) : résultat de la veille (code
// révélé) et nouveau coffre. Le bouton Jouer ouvre le plateau privé en
// éphémère : image du plateau, 4 menus (un par place) et bouton Essayer.
// Règles : jeux/CONTRIBUTING.md, section « Le Coffre ».
// ============================================================

import {
  SYMBOLES,
  IDS_SYMBOLES,
  symbole,
  loadCoffreConfig,
  readState,
  writeState,
  isTooSoonSinceLastClosure,
  heureOuverture,
  jourOuvert,
  tirerCode,
  essaiValide,
  indiceDuJoueur,
  texteIndice,
  buildRanking,
  memeRang,
  bilanJour,
  writeCode,
  readCode,
  readPartie,
  listParties,
  compterJoueurs,
  jouerEssai,
  jouerPnj,
  estPnj,
  readPoints,
  readEssaisTotal,
  readUsernames,
  writeHistoriqueEntry,
  archiveManche,
  listManches,
  resetPartie,
} from "../../services/coffre.js";
import { encodePlateau } from "../../services/coffreImage.js";
import { jourDeJeu } from "../../services/creneaux.js";
import { getRoleIdByName, MINI_JEUX_ROLE_NAME } from "@clash/commun/discordRoles.js";
import { resolveDisplayName } from "@clash/commun/discordUsers.js";
import { rangExAequo } from "@clash/commun/classement.js";
import { versV2 as versV2Commun } from "../composantsV2.js";
import { URL_JEUX } from "../../services/urlJeux.js";

const COFFRE_COLOR = 0xc9952b;
// À incrémenter après remplacement de l'illustration d'annonce (cache Discord)
const ILLUSTRATION_VERSION = 1;
export const COFFRE_ILLUSTRATION_URL = `${URL_JEUX}/api/coffre/illustration?v=${ILLUSTRATION_VERSION}`;

const pluriel = (n, mot) => `${n} ${mot}${n > 1 ? "s" : ""}`;
const points = (n) => pluriel(n, "point");
const codeEmojis = (code) => code.map((s) => symbole(s)?.emoji ?? "?").join(" ");
const TOUS_SYMBOLES = SYMBOLES.map((s) => s.emoji).join(" ");
// PNJ du salon de test : pseudo stocké, aucun appel Discord
const nomAffiche = (discordId, fallback) =>
  estPnj(discordId) ? Promise.resolve(fallback ?? "PNJ") : resolveDisplayName(discordId, fallback);

// ── URLs d'images ─────────────────────────────────────────────────

const urlJour = (jour, v) => `${URL_JEUX}/api/coffre/jour?jour=${jour}&v=${v}`;
const urlCode = (partieId, jour, v) =>
  `${URL_JEUX}/api/coffre/code?partie=${encodeURIComponent(partieId)}&jour=${jour}&v=${v}`;
const urlPlateau = (plateau) => `${URL_JEUX}/api/coffre/plateau?d=${encodePlateau(plateau)}`;

// ── Embeds publics ────────────────────────────────────────────────

function buildAnnonceEmbed(config) {
  return {
    title: "🔐 Le Coffre : un trésor arrive demain",
    description: [
      `Pendant **${config.duree_jours} jours**, un nouveau coffre chaque matin, fermé par un code secret de ${config.longueur_code} symboles tous différents parmi ${TOUS_SYMBOLES}.`,
      "",
      `Tu as **${config.essais_par_jour} essais** par jour pour l'ouvrir. Après chaque essai, tu sais combien de symboles sont bien placés 🟢 et combien sont mal placés 🟡, mais pas lesquels !`,
      "",
      "Chacun reçoit aussi un indice secret, différent pour chaque joueur. Le garder ou le partager ? À toi de voir.",
      "",
      "Plus d'infos ? Clique sur *Règles* ci-dessous.",
    ].join("\n"),
    color: COFFRE_COLOR,
    image: { url: COFFRE_ILLUSTRATION_URL },
    footer: { text: "La partie commence demain matin." },
  };
}

// Pied du jour : compteurs mis à jour au premier essai et à chaque ouverture
const footerJour = (joueurs, ouverts) => ({
  text: `🔐 ${pluriel(joueurs, "joueur")} · ${pluriel(ouverts, "coffre")} ouvert${ouverts > 1 ? "s" : ""} · Fermeture à minuit`,
});

const lignesNouveauCoffre = (config) => [
  `Trouve le code de ${config.longueur_code} symboles différents parmi ${TOUS_SYMBOLES}, en ${config.essais_par_jour} essais au plus.`,
  `Ouvert au 1er essai = ${points(config.essais_par_jour)}, au dernier = 1 point.`,
];

function buildPremierJourEmbed(config, { v }) {
  return {
    title: `🔐 Le Coffre (Jour 1/${config.duree_jours})`,
    description: ["**Le premier coffre est arrivé !**", "", ...lignesNouveauCoffre(config)].join("\n"),
    color: COFFRE_COLOR,
    image: { url: urlJour(1, v) },
    footer: footerJour(0, 0),
  };
}

export async function lignesClassement(ranking, limite) {
  const usernames = await readUsernames();
  const liste = await Promise.all(
    ranking.slice(0, limite).map(async (r) => ({ ...r, nom: await nomAffiche(r.discordId, r.username ?? usernames[r.discordId]) })),
  );
  return liste.map(
    (r, i, l) => `${rangExAequo(l, i, memeRang)}\\. ${r.nom} (${points(r.points)}, ${pluriel(r.essais, "essai")})`,
  );
}

// Résultat d'un jour (`entry` : entrée d'historique)
async function lignesResultat(entry, ranking) {
  const lignes = [`Le code était ${codeEmojis(entry.code)}`];
  if (!entry.joueurs) lignes.push("Personne n'a joué ce jour-là.");
  else {
    lignes.push(
      `🔓 ${entry.ouverts} coffre${entry.ouverts > 1 ? "s" : ""} ouvert${entry.ouverts > 1 ? "s" : ""} sur ${pluriel(entry.joueurs, "joueur")}` +
        (entry.meilleur ? ` (le plus rapide en ${pluriel(entry.meilleur, "essai")})` : "") +
        ".",
    );
  }
  if (ranking?.length) lignes.push("", "**Classement :**", ...(await lignesClassement(ranking, 5)));
  return lignes;
}

// Un seul bloc et une seule image par message : résultat de la veille (image
// du code), puis la suite sous l'image (nouveau coffre ou classement final)
function bloc(title, entry, lignes, suite, { partieId, v, footer }) {
  return {
    title,
    description: [`**📊 Résultat du Jour ${entry.jour}**`, ...lignes].join("\n"),
    color: COFFRE_COLOR,
    image: { url: urlCode(partieId, entry.jour, v) },
    apres: suite.join("\n"),
    footer,
  };
}

async function lignesFinales(ranking, manches) {
  const lignes = ["### 🏁 Classement final"];
  lignes.push(...(ranking.length ? await lignesClassement(ranking, 20) : ["Personne n'a joué cette partie."]));
  const max = ranking[0]?.points ?? 0;
  if (max > 0) {
    const usernames = await readUsernames();
    const vainqueurs = ranking.filter((r) => memeRang(r, ranking[0]));
    const noms = await Promise.all(vainqueurs.map((r) => nomAffiche(r.discordId, usernames[r.discordId])));
    lignes.push("", `🏆 Vainqueur${noms.length > 1 ? "s" : ""} (${points(max)}) : ${noms.join(", ")}`);
  }
  if (manches.length) {
    lignes.push(
      "",
      "**Vainqueurs des parties précédentes :**",
      ...manches.map((m) => `Partie ${m.manche} : 🏆 ${m.winners?.length ? m.winners.join(", ") : "personne"} (${points(m.maxPoints)})`),
    );
  }
  return lignes;
}

// ── Boutons publics ───────────────────────────────────────────────

const boutonRegles = { type: 2, style: 2, label: "Règles", emoji: { name: "📖" }, custom_id: "coffre_regles" };

const buildJourComponents = (jour) => [
  {
    type: 1,
    components: [
      { type: 2, style: 1, label: "Jouer", emoji: { name: "🔐" }, custom_id: `coffre_jouer:${jour}` },
      boutonRegles,
    ],
  },
];

// ── Publication quotidienne ───────────────────────────────────────

async function discordFetch(chemin, options = {}) {
  const token = process.env.DISCORD_TOKEN;
  if (!token) throw new Error("DISCORD_TOKEN manquant.");
  return fetch(`https://discord.com/api/v10${chemin}`, {
    ...options,
    headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json", ...(options.headers || {}) },
  });
}

// Messages en Components V2 (galerie plus grande qu'une image d'embed)
export const versV2 = (embeds, components = [], roleId = null) => versV2Commun(embeds, components, roleId, COFFRE_COLOR);

async function publishAndWriteState(channelId, previousState, { phase = "jour", jour, partieId, embeds, components, ping, termine = false }) {
  if (previousState?.messageId && previousState?.channelId) {
    try {
      const del = await discordFetch(`/channels/${previousState.channelId}/messages/${previousState.messageId}`, { method: "DELETE" });
      if (!del.ok && del.status !== 404) console.warn(`[Coffre] Échec suppression du message de la veille (${del.status}), publication quand même.`);
    } catch (err) {
      console.warn("[Coffre] Erreur réseau à la suppression du message de la veille:", err.message);
    }
  }
  const roleId = ping ? await getRoleIdByName(MINI_JEUX_ROLE_NAME) : null;
  const res = await discordFetch(`/channels/${channelId}/messages`, {
    method: "POST",
    body: JSON.stringify(versV2(embeds, components, roleId)),
  });
  if (!res.ok) throw new Error(`Erreur envoi salon Discord (${res.status}): ${await res.text().catch(() => "")}`);
  const message = await res.json();
  await writeState({
    phase,
    jour,
    partieId,
    channelId,
    messageId: message.id,
    publishedAt: new Date().toISOString(),
    termine,
    embeds,
    components,
  });
  return { jour, embeds, message, termine };
}

// Passage du cron : annonce -> Jour 1 au moins 8 h après l'annonce ; jour N
// -> résultat et jour suivant dès le jour de jeu suivant (après 8 h). Pure.
export function transitionPrete(state, now = Date.now()) {
  if (!state?.publishedAt) return true;
  if (state.phase === "annonce") return !isTooSoonSinceLastClosure(state.publishedAt, now);
  return jourDeJeu(state.publishedAt) !== jourDeJeu(now);
}

// Bilan du jour actif sans rien écrire (cron, dry-run, coffre:status)
export async function projeterJour(state) {
  const parties = await listParties(state.jour);
  const code = await readCode(state.jour);
  return { jour: state.jour, partieId: state.partieId, code: code ?? [], ...bilanJour(parties), resolvedAt: new Date().toISOString() };
}

// Publie le jour d'annonce, le Jour 1, puis chaque matin le résultat de la
// veille et le nouveau coffre, ou le classement final après le Jour 7.
// `pnj` : 5 joueurs fictifs jouent chaque coffre (jamais sur le salon
// public). ⚠️ Ping seulement si `isPublic` et sans `noPing` : jamais de ping
// sur le salon de test, quel que soit l'appelant.
export async function postCoffre(
  channelId,
  { dryRun = false, noPing = false, isPublic = false, requireActiveState = false, force = false, pnj = false } = {},
) {
  if (!isPublic) noPing = true;
  const config = await loadCoffreConfig();
  const ping = isPublic && !noPing;
  const avecPnj = pnj && !isPublic;
  const state = await readState();

  if (state?.termine) return { termine: true };
  if (state && !dryRun && !force && !transitionPrete(state)) {
    return { skipped: true, reason: "pasEncore", phase: state.phase, publishedAt: state.publishedAt };
  }
  if (state && state.channelId !== channelId) return { wrongChannel: true, activeChannelId: state.channelId };
  if (!state && requireActiveState) return { skipped: true };

  const v = Date.now();

  // 1) Aucun état : jour d'annonce (jamais le Jour 1 directement), avec ping
  if (!state) {
    const embeds = [buildAnnonceEmbed(config)];
    const components = [{ type: 1, components: [boutonRegles] }];
    if (dryRun) return { dryRun: true, phase: "annonce", embeds, components };
    return publishAndWriteState(channelId, null, { phase: "annonce", jour: null, partieId: v.toString(36), embeds, components, ping });
  }

  // 2) Annonce -> Jour 1 : remise à zéro de la partie, premier code
  if (state.phase === "annonce") {
    const embeds = [buildPremierJourEmbed(config, { v })];
    const components = buildJourComponents(1);
    if (dryRun) return { dryRun: true, phase: "jour", jour: 1, embeds, components };
    await resetPartie();
    const code = tirerCode(config.longueur_code);
    await writeCode(1, code);
    const out = await publishAndWriteState(channelId, state, { jour: 1, partieId: state.partieId, embeds, components, ping });
    if (avecPnj) await faireJouerPnj(config, 1, code, state.partieId);
    return out;
  }

  // 3) Jour N : résultat (code révélé), puis nouveau coffre ou classement final
  const entry = await projeterJour(state);
  const jourSuivant = state.jour + 1;
  const estFin = jourSuivant > config.duree_jours;
  const ranking = buildRanking(await readPoints(), await readEssaisTotal(), await readUsernames());
  const titre = estFin ? "🏁 Le Coffre : fin de partie" : `🔐 Le Coffre (Jour ${jourSuivant}/${config.duree_jours})`;
  const manches = estFin ? await listManches({ limit: 10 }) : [];
  const embeds = [
    bloc(
      titre,
      entry,
      await lignesResultat(entry, estFin ? null : ranking),
      estFin ? await lignesFinales(ranking, manches) : ["### 🔐 Nouveau coffre !", ...lignesNouveauCoffre(config)],
      { partieId: state.partieId, v, footer: estFin ? undefined : footerJour(0, 0) },
    ),
  ];
  if (dryRun) return { dryRun: true, final: estFin, phase: "jour", jour: estFin ? state.jour : jourSuivant, embeds, entry };

  await writeHistoriqueEntry(state.jour, entry);

  if (estFin) {
    if (isPublic) {
      const usernames = await readUsernames();
      const resolu = await Promise.all(
        ranking.map(async (r) => ({
          discordId: r.discordId,
          username: await nomAffiche(r.discordId, usernames[r.discordId]),
          points: r.points,
          essais: r.essais,
        })),
      );
      const max = ranking[0]?.points ?? 0;
      await archiveManche({
        resolvedAt: new Date().toISOString(),
        ranking: resolu,
        winners: max > 0 ? resolu.filter((r) => memeRang(r, ranking[0])).map((r) => r.username) : [],
        maxPoints: max,
      });
    }
    const out = await publishAndWriteState(channelId, state, {
      jour: state.jour,
      partieId: state.partieId,
      embeds,
      components: [],
      ping,
      termine: true,
    });
    return { ...out, final: true };
  }

  const code = tirerCode(config.longueur_code);
  await writeCode(jourSuivant, code);
  const out = await publishAndWriteState(channelId, state, {
    jour: jourSuivant,
    partieId: state.partieId,
    embeds,
    components: buildJourComponents(jourSuivant),
    ping,
  });
  if (avecPnj) await faireJouerPnj(config, jourSuivant, code, state.partieId);
  return out;
}

// PNJ du salon de test : coffre du jour, puis compteur du message public
async function faireJouerPnj(config, jour, code, partieId) {
  await jouerPnj(jour, { code, essaisMax: config.essais_par_jour, partieId });
  await majCompteur(await readState());
}

// ── Interactions ──────────────────────────────────────────────────

async function patchOriginal(webhookUrl, payload) {
  if (!webhookUrl) return;
  try {
    await fetch(`${webhookUrl}/messages/@original`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    console.error("[Coffre] Échec PATCH:", err.message);
  }
}

const messageSeul = (content) => ({ content, embeds: [], components: [] });

// Coffre du jour encore ouvert : renvoie l'état, ou null après avoir
// répondu au joueur
async function etatJouable(webhookUrl, jour) {
  const state = await readState();
  if (!state || state.termine || state.phase !== "jour" || String(state.jour) !== String(jour)) {
    await patchOriginal(webhookUrl, messageSeul("Ce coffre est fermé, regarde le nouveau message !"));
    return null;
  }
  if (!jourOuvert(state.publishedAt)) {
    await patchOriginal(
      webhookUrl,
      messageSeul(`Le coffre est fermé depuis minuit. Code révélé et nouveau coffre vers ${heureOuverture()}h30.`),
    );
    return null;
  }
  return state;
}

// Compteurs du message public (pied du dernier embed)
async function majCompteur(state) {
  if (!state?.embeds?.length || !state.messageId) return;
  const parties = await listParties(state.jour);
  const { joueurs, ouverts } = bilanJour(parties);
  const embeds = state.embeds.map((e, i) => (i === state.embeds.length - 1 ? { ...e, footer: footerJour(joueurs, ouverts) } : e));
  try {
    const res = await discordFetch(`/channels/${state.channelId}/messages/${state.messageId}`, {
      method: "PATCH",
      body: JSON.stringify(versV2(embeds, state.components ?? [])),
    });
    if (!res.ok) console.warn(`[Coffre] Échec mise à jour du compteur (${res.status}).`);
  } catch (err) {
    console.warn("[Coffre] Erreur réseau à la mise à jour du compteur:", err.message);
  }
}

// Position du joueur au classement : « 📊 Tu es 3e : 9 points, 11 essais. »
export async function maPosition(discordId) {
  const ranking = buildRanking(await readPoints(), await readEssaisTotal());
  const i = ranking.findIndex((r) => r.discordId === discordId);
  if (i === -1) return null;
  const rang = rangExAequo(ranking, i, memeRang);
  const r = ranking[i];
  return `📊 Tu es ${rang === 1 ? "1er" : `${rang}e`} : ${points(r.points)}, ${pluriel(r.essais, "essai")}.`;
}

// ── Plateau privé (éphémère) ──────────────────────────────────────

// Brouillon de l'essai en cours : 4 caractères, index du symbole ou « x »
// (place vide), porté par le custom_id du bouton Essayer
const BROUILLON_VIDE = "xxxx";
export const lireBrouillon = (texte) =>
  [...String(texte ?? BROUILLON_VIDE).padEnd(4, "x").slice(0, 4)].map((c) => (/[0-5]/.test(c) ? IDS_SYMBOLES[Number(c)] : null));
export const ecrireBrouillon = (symboles) =>
  symboles.map((s) => (s ? String(IDS_SYMBOLES.indexOf(s)) : "x")).join("");

const NOM_PLACE = ["1re place", "2e place", "3e place", "4e place"];

// 4 menus (un par place) et la rangée de boutons. Essayer désactivé tant
// que les 4 places ne portent pas 4 symboles différents.
export function composantsPlateau(jour, brouillon) {
  const menus = brouillon.map((choisi, k) => ({
    type: 1,
    components: [
      {
        type: 3,
        custom_id: `coffre_place:${jour}:${k}`,
        placeholder: NOM_PLACE[k],
        options: SYMBOLES.map((s) => ({
          label: `${NOM_PLACE[k]} : ${s.nom}`,
          value: s.id,
          emoji: { name: s.emoji },
          default: s.id === choisi,
        })),
      },
    ],
  }));
  const complet = essaiValide(brouillon, 4);
  return [
    ...menus,
    {
      type: 1,
      components: [
        {
          type: 2,
          style: 3,
          label: "Essayer",
          emoji: { name: "🔑" },
          custom_id: `coffre_essai:${jour}:${ecrireBrouillon(brouillon)}`,
          disabled: !complet,
        },
      ],
    },
  ];
}

const LEGENDE = "🟢 bien placés · 🟡 dans le code mais mal placés";

// Vue éphémère du joueur : image du plateau, indice, menus (s'il lui reste
// des essais). `message` : ligne d'en-tête (résultat du dernier essai…).
async function vuePlateau(state, config, discordId, { message = null, brouillon = null } = {}) {
  const code = await readCode(state.jour);
  if (!code) return messageSeul("Ce coffre est introuvable, regarde le nouveau message !");
  const partie = await readPartie(state.jour, discordId);
  const indice = indiceDuJoueur(code, state.partieId, state.jour, discordId);
  const restants = config.essais_par_jour - partie.essais.length;
  const fini = partie.ouvert || restants <= 0;
  const lignes = [];
  if (message) lignes.push(message, "");
  lignes.push(`🔎 Ton indice secret : ${texteIndice(indice)}.`, LEGENDE);
  if (!fini) lignes.push("", `Choisis un symbole par place, puis **Essayer** (${pluriel(restants, "essai")} restant${restants > 1 ? "s" : ""}).`);
  else if (partie.ouvert) lignes.push("", (await maPosition(discordId)) ?? "");
  else lignes.push("", "Le code sera révélé demain matin.");
  const derniers = partie.essais.at(-1)?.symboles ?? [null, null, null, null];
  return {
    content: "",
    embeds: [
      {
        title: `🔐 Ton coffre (Jour ${state.jour})`,
        description: lignes.join("\n").trim(),
        color: COFFRE_COLOR,
        image: {
          url: urlPlateau({
            jour: state.jour,
            duree: config.duree_jours,
            essaisMax: config.essais_par_jour,
            essais: partie.essais,
            ouvert: partie.ouvert,
            points: partie.points,
            indice,
          }),
        },
      },
    ],
    // Menus pré-remplis avec le dernier essai (on change un ou deux symboles)
    components: fini ? [] : composantsPlateau(state.jour, brouillon ?? (partie.essais.length ? derniers : [null, null, null, null])),
  };
}

export async function handleJouer(webhookUrl, jour, discordId) {
  try {
    const state = await etatJouable(webhookUrl, jour);
    if (!state) return;
    await patchOriginal(webhookUrl, await vuePlateau(state, await loadCoffreConfig(), discordId));
  } catch (err) {
    console.error("[Coffre] Échec Jouer:", err.message);
  }
}

// Choix d'un symbole dans un menu : pure, réponse immédiate (type 7) qui
// remplace les composants. Le brouillon courant est lu dans le bouton
// Essayer du message.
export function majBrouillon(message, jour, place, symboleId) {
  const bouton = (message?.components ?? [])
    .flatMap((row) => row.components ?? [])
    .find((c) => String(c.custom_id ?? "").startsWith("coffre_essai:"));
  const brouillon = lireBrouillon(bouton?.custom_id.split(":")[2]);
  if (Number.isInteger(place) && place >= 0 && place < 4 && IDS_SYMBOLES.includes(symboleId)) {
    // Un symbole ne peut occuper qu'une place : il quitte son ancienne place
    for (let k = 0; k < 4; k++) if (brouillon[k] === symboleId) brouillon[k] = null;
    brouillon[place] = symboleId;
  }
  return composantsPlateau(jour, brouillon);
}

export async function handleEssai(webhookUrl, jour, brouillonTexte, discordId, username) {
  try {
    const state = await etatJouable(webhookUrl, jour);
    if (!state) return;
    const config = await loadCoffreConfig();
    const essai = lireBrouillon(brouillonTexte);
    const code = await readCode(state.jour);
    if (!code) return;
    const r = await jouerEssai(state.jour, discordId, essai, { code, essaisMax: config.essais_par_jour, username });
    let message;
    if (r.statut === "invalide") message = "Il faut 4 symboles différents, un par place.";
    else if (r.statut === "occupe") message = "Un essai est déjà en cours, patiente une seconde.";
    else if (r.statut === "termine") message = r.partie.ouvert ? "Tu as déjà ouvert ce coffre !" : "Plus d'essai aujourd'hui.";
    else if (r.partie.ouvert) {
      message = `🎉 **Coffre ouvert en ${pluriel(r.partie.essais.length, "essai")} : +${points(r.partie.points)} !**`;
    } else {
      const { bien, mal } = r.reponse;
      message = `${codeEmojis(essai)} : 🟢 ${bien} bien placé${bien > 1 ? "s" : ""} · 🟡 ${mal} mal placé${mal > 1 ? "s" : ""}`;
    }
    await patchOriginal(webhookUrl, await vuePlateau(state, config, discordId, { message, brouillon: r.statut === "invalide" ? essai : null }));
    // Compteurs publics : premier essai du joueur, ou coffre ouvert
    if (r.statut === "ok" && (r.partie.essais.length === 1 || r.partie.ouvert)) await majCompteur(state);
  } catch (err) {
    console.error("[Coffre] Échec Essai:", err.message);
  }
}

// ── Règles ────────────────────────────────────────────────────────

function buildReglesEmbed(config) {
  return {
    title: "📖 Règles du Coffre",
    description: [
      `Pendant ${config.duree_jours} jours, un nouveau coffre chaque matin (vers ${heureOuverture()}h30), ouvert jusqu'à minuit.`,
      "",
      `🔐 **Le code** : ${config.longueur_code} symboles tous différents parmi ${TOUS_SYMBOLES}.`,
      `🔑 **Tes essais** : ${config.essais_par_jour} par jour. Après chaque essai, tu vois combien de symboles sont 🟢 bien placés et combien sont 🟡 dans le code mais mal placés. Le jeu ne dit pas lesquels !`,
      "🔎 **Ton indice** : chaque joueur reçoit un indice secret, différent pour chacun. Tu peux le garder pour toi ou en parler dans le salon.",
      "",
      `🏆 **Points** : coffre ouvert au 1er essai = ${points(config.essais_par_jour)}, au 2e = ${points(config.essais_par_jour - 1)}… au dernier = 1 point. Pas de bonus de rapidité : jouer le matin ou le soir ne change rien.`,
      "",
      "Classement : points cumulés, puis le moins d'essais utilisés. Le code de chaque jour est révélé le lendemain matin.",
    ].join("\n"),
    color: COFFRE_COLOR,
  };
}

export async function handleRegles(webhookUrl) {
  try {
    await patchOriginal(webhookUrl, { embeds: [buildReglesEmbed(await loadCoffreConfig())], components: [] });
  } catch (err) {
    console.error("[Coffre] Échec Règles:", err.message);
  }
}
