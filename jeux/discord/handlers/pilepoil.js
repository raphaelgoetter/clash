// ============================================================
// pilepoil.js — Handlers Discord de Pile Poil (calcul du jour, jeu
// quotidien sans fin). Publication une fois par jour (postPilePoil, appelée
// uniquement par jeux/scripts/postPilePoil.js) : récap de la veille, puis
// égalité du jour. Le bouton Jouer ouvre le plateau privé en éphémère ; le
// bouton Proposer ouvre une modale (6 chiffres).
// Règles : jeux/CONTRIBUTING.md, section « Pile Poil ».
// ============================================================

import {
  loadPilePoilConfig,
  readState,
  writeState,
  writeSolution,
  readSolution,
  readSorties,
  readPartie,
  listParties,
  jouerEssai,
  jouerPnj,
  readSerie,
  readUsernames,
  readPointsMois,
  readJoursMois,
  marquerFinalMois,
  writeHistoriqueEntry,
  codeEspace,
} from "../../services/pilepoil.js";
import {
  tirerEgalite,
  signeDe,
  chiffresDe,
  gabarit,
  egaliteLisible,
  lireSaisie,
  bilanJour,
  classementMois,
  memeRangMois,
  serieAffichee,
  BIEN,
  PRESENT,
} from "../../services/pilepoilRules.js";
import { encodePlateau } from "../../services/pilepoilImage.js";
import { seasonIdForDate, deMois, formatUtcTimeAsParis } from "../../services/saison.js";
import { getRoleIdByName, MINI_JEUX_ROLE_NAME } from "@clash/commun/discordRoles.js";
import { rangExAequo } from "@clash/commun/classement.js";
import { versV2 as versV2Commun } from "../composantsV2.js";
import { URL_JEUX } from "../../services/urlJeux.js";

const PILEPOIL_COLOR = 0x3ecf6a;
const pluriel = (n, mot) => `${n} ${mot}${n > 1 ? "s" : ""}`;
const points = (n) => pluriel(n, "point");
// Grilles du récap (image) : 12 au plus, les meilleures d'abord
const GRILLES_RECAP_MAX = 12;
// Noms listés par ligne du classement du jour (message de 4 000 caractères)
const NOMS_PAR_LIGNE_MAX = 15;
const CLASSEMENT_FINAL_MAX = 20;

// Heure de publication en heure de Paris (cron à 8h02 UTC : 9 h en hiver,
// 10 h en été) : jamais d'heure en dur dans un texte joueur. Pure.
const HEURE_UTC_PUBLICATION = 8;
export const heurePublication = (now = new Date()) => formatUtcTimeAsParis(HEURE_UTC_PUBLICATION, 0, now).replace("h00", "h");

// Garde-fou anti-double-publication : un jour publié depuis moins de 8 h
// n'est pas clos (cron en retard après une relance manuelle)
export const MIN_HOURS_BETWEEN_CLOSURES = 8;
export function isTooSoonSinceLastClosure(publishedAt, now = Date.now()) {
  if (!publishedAt) return false;
  return (now - new Date(publishedAt).getTime()) / 3_600_000 < MIN_HOURS_BETWEEN_CLOSURES;
}

// ── URLs d'images ─────────────────────────────────────────────────

const urlPlateau = (plateau) => `${URL_JEUX}/api/pilepoil/plateau?d=${encodePlateau(plateau)}`;
const urlRecap = (espace, jour, v) => `${URL_JEUX}/api/pilepoil/recap?e=${codeEspace(espace)}&jour=${jour}&v=${v}`;

// ── Textes publics ────────────────────────────────────────────────

// Texte public minimal : le détail est dans les Règles
const lignesEgaliteDuJour = (config) => [`Trouve les 6 chiffres en ${config.essais} essais.`];

const footerJour = (joueurs, trouves) => ({
  text: `🧮 ${pluriel(joueurs, "joueur")} · ${trouves} ${trouves > 1 ? "ont" : "a"} trouvé`,
});

const nomDe = (usernames, id) => usernames[id] || "Joueur";

function listeNoms(ids, usernames) {
  const noms = ids.slice(0, NOMS_PAR_LIGNE_MAX).map((id) => nomDe(usernames, id));
  const reste = ids.length - noms.length;
  return reste > 0 ? `${noms.join(", ")} et ${pluriel(reste, "autre")}` : noms.join(", ");
}

// Classement du jour, regroupé par nombre d'essais (jamais de mention)
export function lignesClassementJour(entry, usernames) {
  if (!entry.joueurs) return ["Personne n'a joué."];
  const lignes = [`🧮 ${entry.trouves} sur ${pluriel(entry.joueurs, "joueur")} ${entry.trouves > 1 ? "ont" : "a"} trouvé.`];
  const essais = Object.keys(entry.parEssais).map(Number).sort((a, b) => a - b);
  essais.forEach((n, i) => {
    lignes.push(`${i === 0 ? "🎯" : "✅"} **${pluriel(n, "essai")}** : ${listeNoms(entry.parEssais[n], usernames)}`);
  });
  if (entry.rates.length) lignes.push(`❌ **Pas trouvé** : ${listeNoms(entry.rates, usernames)}`);
  return lignes;
}

async function classementDuMois(espace, seasonId) {
  const [pts, jours, usernames] = await Promise.all([readPointsMois(espace, seasonId), readJoursMois(espace, seasonId), readUsernames(espace)]);
  return classementMois(pts, jours, usernames);
}

// « 1\. Pseudo (12 points, 3 jours) » : point échappé (ex aequo conservés)
export function lignesClassementMois(ranking, limite) {
  return ranking
    .slice(0, limite)
    .map((r, i, l) => `${rangExAequo(l, i, memeRangMois)}\\. ${r.username || "Joueur"} (${points(r.points)}, ${pluriel(r.jours, "jour")})`);
}

function lignesFinalMois(ranking, seasonId) {
  const lignes = [`### 🏁 Classement final du mois ${deMois(seasonId)}`];
  if (!ranking.length) return [...lignes, "Personne n'a joué ce mois-ci."];
  lignes.push(...lignesClassementMois(ranking, CLASSEMENT_FINAL_MAX));
  const max = ranking[0].points;
  if (max > 0) {
    const vainqueurs = ranking.filter((r) => memeRangMois(r, ranking[0])).map((r) => r.username || "Joueur");
    lignes.push("", `🏆 Bravo ${vainqueurs.join(", ")} (${points(max)}) !`);
  }
  return lignes;
}

// ── Boutons publics ───────────────────────────────────────────────

const boutonRegles = { type: 2, style: 2, label: "Règles", emoji: { name: "📖" }, custom_id: "pilepoil_regles" };

const buildJourComponents = (espace, jour) => [
  {
    type: 1,
    components: [
      { type: 2, style: 1, label: "Jouer", emoji: { name: "🧮" }, custom_id: `pilepoil_jouer:${codeEspace(espace)}:${jour}` },
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

export const versV2 = (embeds, components = [], roleId = null) => versV2Commun(embeds, components, roleId, PILEPOIL_COLOR);

async function publishAndWriteState(espace, channelId, previousState, { jour, seasonId, embeds, components, ping }) {
  if (previousState?.messageId && previousState?.channelId) {
    try {
      const del = await discordFetch(`/channels/${previousState.channelId}/messages/${previousState.messageId}`, { method: "DELETE" });
      if (!del.ok && del.status !== 404) console.warn(`[Pile Poil] Échec suppression du message de la veille (${del.status}), publication quand même.`);
    } catch (err) {
      console.warn("[Pile Poil] Erreur réseau à la suppression du message de la veille:", err.message);
    }
  }
  const roleId = ping ? await getRoleIdByName(MINI_JEUX_ROLE_NAME) : null;
  const res = await discordFetch(`/channels/${channelId}/messages`, {
    method: "POST",
    body: JSON.stringify(versV2(embeds, components, roleId)),
  });
  if (!res.ok) throw new Error(`Erreur envoi salon Discord (${res.status}): ${await res.text().catch(() => "")}`);
  const message = await res.json();
  await writeState(espace, {
    jour,
    seasonId,
    channelId,
    messageId: message.id,
    publishedAt: new Date().toISOString(),
    pause: false,
    embeds,
    components,
  });
  return { jour, embeds, message };
}

// Bilan du jour actif sans rien écrire (cron, dry-run, pilepoil:status)
export async function projeterJour(espace, state) {
  const parties = await listParties(espace, state.jour);
  const usernames = await readUsernames(espace);
  const bilan = bilanJour(parties);
  // Grilles de l'image du récap : trouvés au moins d'essais d'abord, puis ratés
  const grilles = Object.entries(parties)
    .filter(([, p]) => p?.essais?.length)
    .sort(([, a], [, b]) => (b.trouve - a.trouve) || a.essais.length - b.essais.length)
    .slice(0, GRILLES_RECAP_MAX)
    .map(([id, p]) => ({ nom: nomDe(usernames, id), trouve: p.trouve, retours: p.essais.map((e) => e.retour) }));
  return {
    jour: state.jour,
    seasonId: state.seasonId,
    solution: await readSolution(espace, state.jour),
    ...bilan,
    grilles,
    resolvedAt: new Date().toISOString(),
  };
}

// Publie la présentation et la première égalité (premier lancement), puis
// chaque matin le récap de la veille et l'égalité du jour (+ classement
// final du mois écoulé le 1er du mois). Jeu sans fin : `pause` (pilepoil:
// pause) suspend le cron, un lancement manuel le relance.
// Hors salon public : espace de clés `pilepoil:test:*`, 5 PNJ si `pnj`.
// ⚠️ Ping seulement au lancement, si `isPublic` et sans `noPing` : jamais
// de ping sur le salon de test, quel que soit l'appelant.
export async function postPilePoil(
  channelId,
  { dryRun = false, noPing = false, isPublic = false, requireActiveState = false, force = false, pnj = false, now = new Date() } = {},
) {
  if (!isPublic) noPing = true;
  const espace = isPublic ? "public" : "test";
  const config = await loadPilePoilConfig();
  const state = await readState(espace);

  if (!state && requireActiveState) return { skipped: true };
  if (state?.pause && requireActiveState) return { skipped: true, reason: "pause" };
  if (state && state.channelId !== channelId) return { wrongChannel: true, activeChannelId: state.channelId };
  if (state && !dryRun && !force && isTooSoonSinceLastClosure(state.publishedAt, now.getTime())) {
    return { skipped: true, reason: "pasEncore", publishedAt: state.publishedAt };
  }

  const v = now.getTime();
  const seasonId = seasonIdForDate(now);
  const solution = tirerEgalite(await readSorties(espace));
  const signe = signeDe(solution);
  const avecPnj = pnj && !isPublic;

  // 1) Premier lancement : présentation et première égalité, avec ping
  if (!state) {
    const embeds = [
      {
        title: "🧮 Pile Poil n°1 : le calcul du jour",
        description: ["**Nouveau jeu quotidien !** Une égalité secrète par jour, la même pour tous.", ...lignesEgaliteDuJour(config)].join("\n"),
        color: PILEPOIL_COLOR,
        image: { url: urlPlateau({ jour: 1, signe, essaisMax: config.essais, essais: [], trouve: false }) },
        footer: footerJour(0, 0),
      },
    ];
    const components = buildJourComponents(espace, 1);
    if (dryRun) return { dryRun: true, jour: 1, embeds, components };
    await writeSolution(espace, 1, solution);
    const out = await publishAndWriteState(espace, channelId, null, { jour: 1, seasonId, embeds, components, ping: isPublic && !noPing });
    if (avecPnj) await faireJouerPnj(espace, config, 1, solution, seasonId);
    return out;
  }

  // 2) Jour N : récap de la veille, puis égalité du jour N+1
  const entry = await projeterJour(espace, state);
  const jour = state.jour + 1;
  const usernames = await readUsernames(espace);
  const sol = entry.solution ?? "";
  const description = [
    `**📊 Résultat d'hier (n°${state.jour})**`,
    `La solution était **${egaliteLisible(signeDe(sol), chiffresDe(sol))}**`,
    ...lignesClassementJour(entry, usernames),
  ];
  // Mois du jour clos : son classement, final si le nouveau jour change de mois
  const finDeMois = state.seasonId !== seasonId;
  const rankingMois = await classementDuMois(espace, state.seasonId);
  if (!finDeMois && rankingMois.length) {
    description.push("", `**🏆 Classement du mois ${deMois(state.seasonId)}**`, ...lignesClassementMois(rankingMois, config.top_mois_recap));
  }
  // Classement final publié une seule fois par mois (relance manuelle)
  const avecFinal = finDeMois && (dryRun || (await marquerFinalMois(espace, state.seasonId)));
  const apres = [];
  if (avecFinal) apres.push(...lignesFinalMois(rankingMois, state.seasonId), "");
  apres.push(`### 🧮 Égalité du jour : \`${gabarit(signe)}\``, ...lignesEgaliteDuJour(config));
  const embeds = [
    {
      title: `🧮 Pile Poil n°${jour}`,
      description: description.join("\n"),
      color: PILEPOIL_COLOR,
      image: { url: urlRecap(espace, state.jour, v) },
      apres: apres.join("\n"),
      footer: footerJour(0, 0),
    },
  ];
  const components = buildJourComponents(espace, jour);
  if (dryRun) return { dryRun: true, jour, embeds, components, entry };

  await writeHistoriqueEntry(espace, state.jour, entry);
  await writeSolution(espace, jour, solution);
  const out = await publishAndWriteState(espace, channelId, state, { jour, seasonId, embeds, components, ping: false });
  if (avecPnj) await faireJouerPnj(espace, config, jour, solution, seasonId);
  return { ...out, finDeMois };
}

// PNJ du salon de test : égalité du jour, puis compteur du message public
async function faireJouerPnj(espace, config, jour, solution, seasonId) {
  await jouerPnj(espace, jour, { solution, essaisMax: config.essais, seasonId });
  await majCompteur(espace, await readState(espace));
}

// Met le jeu en pause : le cron ne publie plus, rien n'est effacé
export async function mettreEnPause(espace = "public") {
  const state = await readState(espace);
  if (!state) return false;
  await writeState(espace, { ...state, pause: true });
  return true;
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
    console.error("[Pile Poil] Échec PATCH:", err.message);
  }
}

const messageSeul = (content) => ({ content, embeds: [], components: [] });

// Égalité du jour encore en cours : renvoie l'état, ou null après avoir
// répondu au joueur
async function etatJouable(webhookUrl, espace, jour) {
  const state = await readState(espace);
  if (!state || String(state.jour) !== String(jour)) {
    await patchOriginal(webhookUrl, messageSeul("Cette égalité est terminée, regarde le nouveau message !"));
    return null;
  }
  return state;
}

// Compteurs du message public (pied du dernier embed)
async function majCompteur(espace, state) {
  if (!state?.embeds?.length || !state.messageId) return;
  const { joueurs, trouves } = bilanJour(await listParties(espace, state.jour));
  const embeds = state.embeds.map((e, i) => (i === state.embeds.length - 1 ? { ...e, footer: footerJour(joueurs, trouves) } : e));
  try {
    const res = await discordFetch(`/channels/${state.channelId}/messages/${state.messageId}`, {
      method: "PATCH",
      body: JSON.stringify(versV2(embeds, state.components ?? [])),
    });
    if (!res.ok) console.warn(`[Pile Poil] Échec mise à jour du compteur (${res.status}).`);
  } catch (err) {
    console.warn("[Pile Poil] Erreur réseau à la mise à jour du compteur:", err.message);
  }
}

// Position du joueur au classement du mois : « 📊 Novembre : tu es 3e avec 12 points. »
export async function maPositionMois(espace, seasonId, discordId) {
  const ranking = await classementDuMois(espace, seasonId);
  const i = ranking.findIndex((r) => r.discordId === discordId);
  if (i === -1) return null;
  const rang = rangExAequo(ranking, i, memeRangMois);
  return `📊 Classement du mois : tu es ${rang === 1 ? "1er" : `${rang}e`} avec ${points(ranking[i].points)}.`;
}

// ── Plateau privé (éphémère) ──────────────────────────────────────

const carre = { [BIEN]: "🟩", [PRESENT]: "🟨" };
export const ligneRetour = (r) => r.map((x) => carre[x] ?? "⬛").join("");

async function vuePlateau(espace, state, config, discordId, { message = null } = {}) {
  const solution = await readSolution(espace, state.jour);
  if (!solution) return messageSeul("Cette égalité est introuvable, regarde le nouveau message !");
  const signe = signeDe(solution);
  const partie = await readPartie(espace, state.jour, discordId);
  const restants = config.essais - partie.essais.length;
  const fini = partie.trouve || restants <= 0;
  const lignes = [];
  if (message) lignes.push(message, "");
  // Texte minimal : le détail est dans les Règles
  if (!fini) {
    lignes.push(`${pluriel(restants, "essai")} restant${restants > 1 ? "s" : ""}.`);
  } else if (partie.trouve) {
    const serie = serieAffichee(await readSerie(espace, discordId), state.jour);
    lignes.push(`🔥 Série : ${pluriel(serie, "jour")} d'affilée.`);
    const position = await maPositionMois(espace, state.seasonId, discordId);
    if (position) lignes.push(position);
  } else {
    lignes.push("Raté ! Solution demain matin.");
  }
  return {
    content: "",
    embeds: [
      {
        title: `🧮 Pile Poil n°${state.jour}`,
        description: lignes.join("\n").trim(),
        color: PILEPOIL_COLOR,
        image: {
          url: urlPlateau({ jour: state.jour, signe, essaisMax: config.essais, essais: partie.essais, trouve: partie.trouve }),
        },
      },
    ],
    components: fini
      ? []
      : [
          {
            type: 1,
            components: [
              {
                type: 2,
                style: 3,
                label: "Proposer",
                emoji: { name: "✏️" },
                custom_id: `pilepoil_proposer:${codeEspace(espace)}:${state.jour}`,
              },
            ],
          },
        ],
  };
}

export async function handleJouer(webhookUrl, espace, jour, discordId) {
  try {
    const state = await etatJouable(webhookUrl, espace, jour);
    if (!state) return;
    await patchOriginal(webhookUrl, await vuePlateau(espace, state, await loadPilePoilConfig(), discordId));
  } catch (err) {
    console.error("[Pile Poil] Échec Jouer:", err.message);
  }
}

// Modale de saisie (réponse synchrone type 9 au bouton Proposer)
export function buildProposerModal(codeEsp, jour) {
  return {
    custom_id: `pilepoil_modal:${codeEsp}:${jour}`,
    title: `Pile Poil n°${jour}`,
    components: [
      {
        type: 1,
        components: [
          {
            type: 4,
            custom_id: "pilepoil_saisie",
            style: 1,
            label: "Tes 6 chiffres",
            placeholder: "Ex. 47+38=85 ou 473885",
            required: true,
            min_length: 6,
            max_length: 20,
          },
        ],
      },
    ],
  };
}

export async function handleProposition(webhookUrl, espace, jour, discordId, username, saisie) {
  try {
    const state = await etatJouable(webhookUrl, espace, jour);
    if (!state) return;
    const config = await loadPilePoilConfig();
    const solution = await readSolution(espace, state.jour);
    if (!solution) return;
    const chiffres = lireSaisie(saisie);
    const r = chiffres
      ? await jouerEssai(espace, state.jour, discordId, chiffres, { solution, essaisMax: config.essais, seasonId: state.seasonId, username })
      : { statut: "invalide" };
    let message;
    if (r.statut === "invalide") message = "Il faut exactement 6 chiffres. Cet essai ne compte pas.";
    else if (r.statut === "occupe") message = "Un essai est déjà en cours, patiente une seconde.";
    else if (r.statut === "termine") message = r.partie.trouve ? "Tu as déjà trouvé l'égalité du jour !" : "Plus d'essai aujourd'hui.";
    else if (r.partie.trouve) message = `🎉 **Pile poil ! Trouvé en ${pluriel(r.partie.essais.length, "essai")} : +${points(r.partie.points)}**`;
    // Essai raté : l'image du plateau suffit
    else message = null;
    await patchOriginal(webhookUrl, await vuePlateau(espace, state, config, discordId, { message }));
    // Compteurs publics : premier essai du joueur, ou égalité trouvée
    if (r.statut === "ok" && (r.partie.essais.length === 1 || r.partie.trouve)) await majCompteur(espace, state);
  } catch (err) {
    console.error("[Pile Poil] Échec Proposer:", err.message);
  }
}

// ── Règles ────────────────────────────────────────────────────────

function buildReglesEmbed(config) {
  return {
    title: "📖 Règles de Pile Poil",
    description: [
      `Chaque matin vers ${heurePublication()}, une nouvelle égalité secrète, la même pour tout le monde, du type \`47+38=85\` ou \`92-57=35\`. Elle reste jouable jusqu'à la suivante.`,
      "",
      "🧮 **L'égalité** : deux nombres à 2 chiffres, une addition ou une soustraction, et un résultat à 2 chiffres. Le signe et le `=` sont affichés dès le départ.",
      `✏️ **Tes essais** : ${config.essais} par jour. Propose 6 chiffres, ton calcul n'a pas besoin d'être juste.`,
      "🟩 bien placé · 🟨 présent ailleurs · ⬛ absent. Il faut l'égalité exacte, dans l'ordre.",
      "",
      `🏆 **Points** : trouvé au 1er essai = ${points(config.essais)}, au 2e = ${points(config.essais - 1)}… au dernier = 1 point. Jouer le matin ou le soir ne change rien.`,
      "",
      "Classement du jour dans le récap du lendemain, classement du mois cumulé (vainqueur annoncé le 1er du mois). 🔥 Ta série compte les jours trouvés d'affilée.",
    ].join("\n"),
    color: PILEPOIL_COLOR,
  };
}

export async function handleRegles(webhookUrl) {
  try {
    await patchOriginal(webhookUrl, { embeds: [buildReglesEmbed(await loadPilePoilConfig())], components: [] });
  } catch (err) {
    console.error("[Pile Poil] Échec Règles:", err.message);
  }
}
