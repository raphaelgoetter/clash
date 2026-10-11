// ============================================================
// quiestce.js — Handlers Discord de Qui est-ce ? (jeu spécial de 7 jours).
// Un seul message officiel par jour (questions du jour, classement, tableau
// de chasse, révélations), réédité en direct après chaque action, avec
// quatre boutons, chacun en éphémère : Enquêter (sa carte secrète, sa
// cible, ses indices, la question du jour et l'accusation, édités en
// place), Objets, Journal (ce qui concerne le joueur) et Règles.
// Fenêtre d'inscription (comme Goblin Hunters) : boutons S'inscrire, Se
// désinscrire et Règles, rappel quotidien, prolongation si l'effectif
// minimum n'est pas atteint.
//
// La publication/clôture quotidienne passe uniquement par
// scripts/postQuiEstCe.js (postQuiEstCe).
//
// ⚠️ Les cartes restent secrètes : seul l'éphémère montre au joueur sa
// carte et ses indices. Un démasquage est public (qui a démasqué qui), la
// carte démasquée ne l'est pas ; toutes les cartes sont révélées à la fin.
// ============================================================

import {
  loadQuiEstCeConfig,
  readState,
  writeState,
  readPartie,
  initPartie,
  demarrerPartie,
  agir,
  desinscrireJoueur,
  previewCloture,
  closeDayAndAdvance,
  archiveManche,
  listManches,
  isTooSoonSinceLastClosure,
} from "../../../backend/services/quiestce.js";
import {
  QUESTIONS,
  OBJETS,
  nomCarte,
  chasseurs,
  ciblesDisponibles,
  choisirCible,
  candidats,
  questionsPossibles,
  questionsRestantes,
  poser,
  accuser,
  leaderPrime,
  etatObjet,
  questionsProjecteur,
  utiliserObjet,
  classement,
  texteJournal,
} from "../../../backend/services/quiestceRules.js";
import { encodeGrille } from "../../../backend/services/quiestceImage.js";
import {
  getRoleIdByName,
  buildRolePingFields,
  MINI_JEUX_ROLE_NAME,
} from "../../../backend/services/discordRoles.js";
import { formatUtcTimeAsParis } from "../../../backend/services/dateUtils.js";

const QEC_COLOR = 0x8e44ad;
const TRUST_ROYALE_URL = "https://trustroyale.vercel.app";
const JOURNAL_AFFICHE = 10;
// Heure de la clôture quotidienne (cron quiestce.yml, 8h20 UTC)
const CLOTURE_UTC = [8, 20];

function illustrationUrl() {
  return `${TRUST_ROYALE_URL}/api/quiestce/illustration?v=${Date.now()}`;
}

async function grilleUrl(partie, barrees = []) {
  return `${TRUST_ROYALE_URL}/api/quiestce/grille?d=${await encodeGrille(partie.grille, barrees)}`;
}

// ── Mise en forme ────────────────────────────────────────────────────

function plural(n, mot) {
  return `${n} ${mot}${Math.abs(n) > 1 ? "s" : ""}`;
}

function heureCloture() {
  return formatUtcTimeAsParis(...CLOTURE_UTC);
}

function questionLabel(q) {
  return `${QUESTIONS[q].emoji} ${QUESTIONS[q].nom}`;
}

function objetLabel(o) {
  return `${OBJETS[o].emoji} ${OBJETS[o].nom}`;
}

const MEDALS = ["🥇", "🥈", "🥉"];

// ── Embeds publics ───────────────────────────────────────────────────

function addDays(date, days) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

function formatDateFr(iso) {
  return new Date(iso).toLocaleString("fr-FR", { timeZone: "Europe/Paris", dateStyle: "long", timeStyle: "short" });
}

// Message d'inscription (ouverture, rappel quotidien, prolongation) :
// inscrits, effectif requis, date de clôture.
function buildAnnonceEmbed(config, partie, closingAt, { prolongee = false } = {}) {
  const inscrits = Object.values(partie.joueurs)
    .sort((a, b) => a.arrivee - b.arrivee)
    .map((j) => j.username);
  return {
    title: prolongee ? "🕵️ Qui est-ce ? (inscriptions prolongées)" : "🕵️ Qui est-ce ?",
    description: [
      ...(prolongee
        ? [`Seulement **${inscrits.length}** joueur${inscrits.length > 1 ? "s" : ""} inscrit${inscrits.length > 1 ? "s" : ""}, il en faut au moins **${config.effectif_min}** pour lancer la partie. Les inscriptions sont prolongées, parles-en autour de toi !`, ""]
        : []),
      "Chaque joueur reçoit en secret **une carte Clash Royale**. Démasque celles des autres, une question par jour, avant qu'on ne démasque la tienne !",
      "",
      `📅 **${config.duree_jours} jours de jeu**, 1 question par jour. Effectif requis : **${config.effectif_min} à ${config.effectif_max} joueurs**.`,
      "",
      "Merci de t'inscrire uniquement si tu es sûr de pouvoir participer chaque jour au jeu, pour ne pas pénaliser les autres.",
      ...(inscrits.length ? ["", `**✋ Inscrits (${inscrits.length}/${config.effectif_max})**`, inscrits.join(" · ")] : []),
    ]
      .join("\n")
      .slice(0, 4096),
    color: QEC_COLOR,
    image: { url: illustrationUrl() },
    footer: { text: `${prolongee ? "Nouvelle clôture" : "Clôture des inscriptions"} : ${formatDateFr(closingAt)}.` },
  };
}

const INTRO_J1 =
  "Les cartes secrètes sont distribuées et chacun a reçu une première cible. Clique sur *Enquêter* pour découvrir ta carte et poser ta première question !";

function bilanVeilleLignes(partie) {
  const v = partie.veille;
  const n = (id) => `**${partie.joueurs[id]?.username ?? "?"}**`;
  const lignes = v.demasquages.length
    ? v.demasquages.map((d) => `🎯 ${n(d.s)} a démasqué ${n(d.v)}.`)
    : ["🎯 Personne n'a été démasqué."];
  if (v.projecteurs) lignes.push(`🔦 ${plural(v.projecteurs, "Projecteur")} braqué${v.projecteurs > 1 ? "s" : ""}.`);
  if (v.vols) lignes.push(`🕵️ ${plural(v.vols, "piste")} volée${v.vols > 1 ? "s" : ""}.`);
  if (v.erreurs) lignes.push(`❌ ${plural(v.erreurs, "accusation")} ratée${v.erreurs > 1 ? "s" : ""}.`);
  return lignes;
}

// Tableau de chasse : chaque joueur chassé (prime décroissante) et ses
// chasseurs, avec le nombre de questions déjà posées sur lui.
function tableauChasseLignes(partie) {
  const joueurs = Object.entries(partie.joueurs).filter(([, j]) => j.carte);
  const parPrime = [...joueurs].sort(([, a], [, b]) => b.prime - a.prime || a.username.localeCompare(b.username));
  const lignes = [];
  const libres = [];
  for (const [id, j] of parPrime) {
    const hs = chasseurs(partie, id);
    if (!hs.length) {
      libres.push(`${j.username} (${j.prime})`);
      continue;
    }
    const detail = hs.map((h) => `${partie.joueurs[h].username} (${partie.joueurs[h].enquete.posees} ❓)`).join(", ");
    lignes.push(`**${j.username}** (prime ${j.prime}) ← ${detail}`);
  }
  if (libres.length) lignes.push(`Sans chasseur : ${libres.join(", ")}`);
  return lignes;
}

function revelationsLignes(partie) {
  return Object.entries(partie.reveles ?? {}).map(
    ([id, infos]) => `**${partie.joueurs[id]?.username ?? "?"}** : ${Object.entries(infos).map(([q, v]) => `${QUESTIONS[q].nom.toLowerCase()} ${v}`).join(", ")}`,
  );
}

// Message officiel du jour : intro (J1) ou bilan de la veille, questions
// du jour, classement, tableau de chasse, révélations, faits du jour.
async function buildTableEmbed(jour, config, partie) {
  const lignes = jour === 1 || !partie.veille ? [INTRO_J1] : ["**📰 Hier**", ...bilanVeilleLignes(partie)];
  const pool = config.pool[String(jour)] ?? [];
  lignes.push("", `**❓ Questions du jour** : ${pool.map(questionLabel).join(" · ")}`);
  const ranking = classement(partie).filter((r) => r.score !== 0);
  if (ranking.length) {
    lignes.push(
      "",
      "**🏆 Classement**",
      ...ranking.slice(0, 10).map((r, i) => `${MEDALS[i] || `${i + 1}.`} **${r.username}** : ${plural(r.score, "pt")}`),
    );
  }
  const chasse = tableauChasseLignes(partie);
  if (chasse.length) lignes.push("", "**🎯 Tableau de chasse**", ...chasse);
  const reveles = revelationsLignes(partie);
  if (reveles.length) lignes.push("", "**🔦 Révélations**", ...reveles);
  const cruciaux = partie.journal.filter((e) => e.c && e.j === (partie.numeroJour ?? jour)).slice(-JOURNAL_AFFICHE);
  if (cruciaux.length) lignes.push("", "**💥 Aujourd'hui**", ...cruciaux.map((e) => texteJournal(partie, e)));
  return {
    title: `🕵️ Qui est-ce ? (Jour ${jour}/${config.duree_jours})`,
    description: lignes.join("\n").slice(0, 4096),
    color: QEC_COLOR,
    image: partie.grille.length ? { url: await grilleUrl(partie) } : undefined,
    footer: {
      text: `Nouvelles questions chaque jour à ${heureCloture()} (+${config.prime_par_jour} de prime pour qui n'a pas été démasqué).`,
    },
  };
}

function formatMancheLine(record, isCurrent) {
  const suffix = isCurrent ? " *(cette manche)*" : "";
  return `Manche ${record.manche} : vainqueur **${record.vainqueur}** (${plural(record.scoreGagnant, "pt")}, ${plural(record.nbJoueurs, "joueur")})${suffix}`;
}

async function buildFinEmbed(ranking, partie, manches, currentManche) {
  const top = ranking[0];
  const titre = top ? `👑 **${top.username}** remporte la partie avec ${plural(top.score, "pt")} !` : "Personne n'a participé.";
  return {
    title: "🏆 Qui est-ce ? Partie terminée !",
    description: [
      titre,
      "",
      "**Classement final**",
      ...ranking.slice(0, 15).map((r, i) => `${MEDALS[i] || `${i + 1}.`} **${r.username}** (${plural(r.score, "pt")}, ${r.demasques} 🎯)`),
      "",
      "**🃏 Les cartes secrètes**",
      ranking.map((r) => `${r.username} : ${nomCarte(partie, r.carte)}`).join(" · "),
      ...(manches.length ? ["", "**📊 Manches précédentes**", ...manches.map((m) => formatMancheLine(m, m.manche === currentManche))] : []),
    ]
      .join("\n")
      .slice(0, 4096),
    color: 0xf1c40f,
    image: partie.grille.length ? { url: await grilleUrl(partie) } : undefined,
  };
}

function buildReglesEmbed(config) {
  const o = config.objets;
  return {
    title: "📖 Règles : Qui est-ce ?",
    description: [
      "Démasque les cartes secrètes des autres joueurs, avant qu'on ne démasque la tienne !",
      "",
      `**🔎 Chaque jour** : ${plural(config.questions_par_jour, "question")} sur ta cible, parmi les 3 questions du jour (si tu les as déjà toutes posées sur elle, n'importe quelle autre). Puis, si tu veux, 1 accusation.`,
      `**🎯 Démasquer** : ${config.gain_base} pts moins le numéro du jour, plus la **prime** de ta cible. Accusation ratée : -${config.penalite_erreur} pt.`,
      `**💰 Prime** : +${config.prime_par_jour} par jour sans être démasqué, +${config.prime_par_demasquage} par cible démasquée, remise à 0 quand on te démasque.`,
      `**👀 Cibles** : la première est tirée au sort. Ensuite, tu choisis (${config.chasseurs_max} chasseurs au plus par joueur, jamais un joueur que tu as déjà démasqué).`,
      "**🗂️ Indice de départ** : à chaque nouvelle cible, tu reçois une caractéristique de sa carte, tirée au hasard.",
      `**🪙 Or** : ${config.or_par_jour} par jour joué, +${config.or_par_demasquage} par démasquage.`,
      `**🎒 Objets** (1 par jour, ${config.objets_max} par partie) :`,
      `${objetLabel("projecteur")} (${o.projecteur.cout} Or) : ${OBJETS.projecteur.effet}`,
      `${objetLabel("vol")} (${o.vol.cout} Or) : ${OBJETS.vol.effet}`,
      `${objetLabel("double")} (${o.double.cout} Or) : ${OBJETS.double.effet}`,
      "",
      "**❓ Questions** : 💎 Rareté (commune, rare, épique, légendaire ou champion), 💧 Élixir (1 ou 2, 3, 4, 5 ou plus), 🧩 Type (troupe terrestre, troupe aérienne, sort, bâtiment), 👪 Famille, 🏹 Portée et ❤️ Points de vie (troupes seulement).",
      "",
      `**🏁 Fin** au jour ${config.duree_jours} : classement aux points, puis le moins d'accusations ratées, puis le premier à avoir atteint son score.`,
    ].join("\n"),
    color: QEC_COLOR,
  };
}

// ── Composants publics ───────────────────────────────────────────────

function bouton(label, emoji, custom_id, style = 2) {
  return { type: 2, style, label, emoji: { name: emoji }, custom_id };
}

function reglesButton() {
  return bouton("Règles", "📖", "quiestce_regles");
}

function buildAnnonceComponents(config, partie) {
  const n = Object.keys(partie.joueurs).length;
  return [
    {
      type: 1,
      components: [
        bouton(`S'inscrire (${n}/${config.effectif_max})`, "✅", "quiestce_participer", 3),
        bouton("Se désinscrire", "✖️", "quiestce_desinscrire", 4),
        reglesButton(),
      ],
    },
  ];
}

function buildTableComponents() {
  return [
    {
      type: 1,
      components: [
        bouton("Enquêter", "🔎", "quiestce_enqueter", 1),
        bouton("Objets", "🎒", "quiestce_objets", 3),
        bouton("Journal", "📜", "quiestce_journal"),
        reglesButton(),
      ],
    },
  ];
}

// ── Messages Discord du salon ────────────────────────────────────────

async function discordFetch(url, init) {
  const token = process.env.DISCORD_TOKEN;
  if (!token) throw new Error("DISCORD_TOKEN manquant.");
  const multipart = init?.body instanceof FormData;
  return fetch(`https://discord.com/api/v10${url}`, {
    ...init,
    headers: {
      Authorization: `Bot ${token}`,
      ...(multipart ? {} : { "Content-Type": "application/json" }),
    },
  });
}

// Image de la grille jointe au message (`attachment://`), comme le plateau
// de Bang! : confiée par URL, le proxy de Discord dépasse parfois son délai
// et affiche le message sans image. Repli sur l'URL si le téléchargement échoue.
const GRILLE_FILENAME = "grille.png";

async function joindreImage(embed) {
  const url = embed?.image?.url;
  if (!url?.includes("/api/quiestce/grille")) return null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    embed.image = { url: `attachment://${GRILLE_FILENAME}` };
    return buffer;
  } catch (err) {
    console.warn("[QuiEstCe] Image de la grille non jointe:", err.message);
    return null;
  }
}

function corpsMessage(payload, image) {
  if (!image) return JSON.stringify({ ...payload, attachments: [] });
  const form = new FormData();
  form.append("payload_json", JSON.stringify({ ...payload, attachments: [{ id: 0, filename: GRILLE_FILENAME }] }));
  form.append("files[0]", new Blob([image], { type: "image/png" }), GRILLE_FILENAME);
  return form;
}

async function supprimerMessage(state) {
  if (!state?.messageId || !state?.channelId) return;
  try {
    const res = await discordFetch(`/channels/${state.channelId}/messages/${state.messageId}`, { method: "DELETE" });
    if (!res.ok && res.status !== 404) console.warn(`[QuiEstCe] Échec suppression du message officiel (${res.status}), publication quand même.`);
  } catch (err) {
    console.warn("[QuiEstCe] Erreur réseau à la suppression du message officiel:", err.message);
  }
}

async function publishAndWriteState(channelId, previousState, { phase, jour, embed, components, ping, termine = false, isPublic, noPing, closingAt = null, prolongee = false }) {
  const image = await joindreImage(embed);
  await supprimerMessage(previousState);
  const roleId = ping && !noPing ? await getRoleIdByName(MINI_JEUX_ROLE_NAME) : null;
  const res = await discordFetch(`/channels/${channelId}/messages`, {
    method: "POST",
    body: corpsMessage({ embeds: [embed], components, ...buildRolePingFields(roleId) }, image),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Erreur envoi salon Discord (${res.status}): ${errText}`);
  }
  const message = await res.json();
  await writeState({ phase, jour, channelId, messageId: message.id, publishedAt: new Date().toISOString(), termine, isPublic, noPing, ...(closingAt ? { closingAt } : {}), ...(prolongee ? { prolongee } : {}) });
  return { jour, embed, message, termine };
}

// Réédite le message officiel (après chaque action) : liste des inscrits
// le jour de présentation, sinon le message du jour.
async function rafraichirMessage(state, partie) {
  if (!state?.messageId || state.termine) return;
  try {
    const config = await loadQuiEstCeConfig();
    const annonce = state.phase === "annonce";
    const embed = annonce ? buildAnnonceEmbed(config, partie, state.closingAt, { prolongee: state.prolongee }) : await buildTableEmbed(state.jour, config, partie);
    const image = await joindreImage(embed);
    const res = await discordFetch(`/channels/${state.channelId}/messages/${state.messageId}`, {
      method: "PATCH",
      body: corpsMessage({ embeds: [embed], components: annonce ? buildAnnonceComponents(config, partie) : buildTableComponents() }, image),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    console.error("[QuiEstCe] Échec rafraîchissement du message officiel:", err.message);
  }
}

// Fin de partie : manche archivée (salon public), message final avec ping.
async function terminerPartie(state, partie, final, { dryRun = false } = {}) {
  let currentManche = null;
  if (!dryRun && state.isPublic && final.length) {
    currentManche = await archiveManche({
      vainqueur: final[0].username,
      scoreGagnant: final[0].score,
      nbJoueurs: final.length,
      ranking: final.map((r) => ({ discordId: r.discordId, username: r.username, score: r.score })),
      resolvedAt: new Date().toISOString(),
    });
  }
  const manches = await listManches({ limit: 10 });
  const embed = await buildFinEmbed(final, partie, manches, currentManche);
  const components = [{ type: 1, components: [reglesButton()] }];
  if (dryRun) return { dryRun: true, final: true, embed };
  const result = await publishAndWriteState(state.channelId, state, {
    phase: "jour",
    jour: state.jour,
    embed,
    components,
    ping: true,
    termine: true,
    isPublic: state.isPublic,
    noPing: state.noPing,
  });
  return { ...result, final: true };
}

// ── Publication quotidienne (appelée uniquement par scripts/postQuiEstCe.js) ──

// Joueurs fictifs du salon de test (6 ou 7 tirés au sort), voir demarrerPartie.
const PNJ = ["Kévina", "Josette", "Gérard", "Ginette", "Jean-Mi", "Bernadette", "Régis", "Huguette"];

function tirerPnj() {
  const noms = [...PNJ].sort(() => Math.random() - 0.5);
  return noms.slice(0, 6 + Math.floor(Math.random() * 2));
}

export async function postQuiEstCe(
  channelId,
  { dryRun = false, noPing = false, isPublic = false, requireActiveState = false, force = false, forceClose = false, pnj = !isPublic } = {},
) {
  const config = await loadQuiEstCeConfig();
  const state = await readState();

  if (state?.termine) return { termine: true };
  if (state && !dryRun && !force && isTooSoonSinceLastClosure(state.publishedAt)) {
    return { skipped: true, reason: "tooSoonSinceLastClosure", publishedAt: state.publishedAt };
  }
  if (state && state.channelId !== channelId) return { wrongChannel: true, activeChannelId: state.channelId };
  if (!state && requireActiveState) return { skipped: true };

  // 1) Aucun état → ouverture de la fenêtre d'inscription (ping)
  if (!state) {
    const partie = dryRun ? await readPartie() : await initPartie();
    const closingAt = addDays(new Date(), config.fenetre_inscription_jours).toISOString();
    const embed = buildAnnonceEmbed(config, partie, closingAt);
    const components = buildAnnonceComponents(config, partie);
    if (dryRun) return { dryRun: true, phase: "annonce", embed, components };
    return publishAndWriteState(channelId, null, { phase: "annonce", jour: null, embed, components, ping: true, isPublic, noPing, closingAt });
  }

  // 2) Fenêtre d'inscription : rappel tant qu'elle n'est pas close (sauf
  // effectif maximum atteint : lancement anticipé), prolongation de la
  // même durée si l'effectif minimum n'est pas atteint (PNJ du salon de
  // test compris), sinon Jour 1. `forceClose` (tests uniquement) : ignore
  // la date de clôture.
  if (state.phase === "annonce") {
    const now = new Date();
    const partieInscrits = await readPartie();
    const count = Object.keys(partieInscrits.joueurs).length;
    const pnjs = pnj && !isPublic ? tirerPnj() : [];
    if (!forceClose && count < config.effectif_max && new Date(state.closingAt) > now) {
      const embed = buildAnnonceEmbed(config, partieInscrits, state.closingAt, { prolongee: state.prolongee });
      const components = buildAnnonceComponents(config, partieInscrits);
      if (dryRun) return { dryRun: true, phase: "annonce", rappel: true, embed, components };
      return publishAndWriteState(channelId, state, { phase: "annonce", jour: null, embed, components, ping: false, isPublic, noPing, closingAt: state.closingAt, prolongee: state.prolongee });
    }
    if (count + pnjs.length < config.effectif_min) {
      const closingAt = addDays(now, config.fenetre_inscription_jours).toISOString();
      const embed = buildAnnonceEmbed(config, partieInscrits, closingAt, { prolongee: true });
      const components = buildAnnonceComponents(config, partieInscrits);
      if (dryRun) return { dryRun: true, phase: "annonce", prolongation: true, embed, components };
      const r = await publishAndWriteState(channelId, state, { phase: "annonce", jour: null, embed, components, ping: true, isPublic, noPing, closingAt, prolongee: true });
      return { ...r, prolongation: true };
    }
    const partie = dryRun ? partieInscrits : await demarrerPartie({ pnj: pnjs });
    const embed = await buildTableEmbed(1, config, partie);
    const components = buildTableComponents();
    if (dryRun) return { dryRun: true, phase: "jour", jour: 1, embed, components };
    return publishAndWriteState(channelId, state, { phase: "jour", jour: 1, embed, components, ping: false, isPublic, noPing });
  }

  // 3) Clôture d'un jour (lecture seule en dry-run)
  const closure = dryRun ? await previewCloture(state.jour) : await closeDayAndAdvance(state.jour);
  if (closure.termine) {
    return terminerPartie({ ...state, isPublic, noPing }, closure.partie, closure.final, { dryRun });
  }
  const embed = await buildTableEmbed(closure.jourSuivant, config, closure.partie);
  const components = buildTableComponents();
  if (dryRun) return { dryRun: true, jour: closure.jourSuivant, embed, components };
  return publishAndWriteState(channelId, state, { phase: "jour", jour: closure.jourSuivant, embed, components, ping: false, isPublic, noPing });
}

// ── Réponses éphémères ───────────────────────────────────────────────

async function patchOriginal(webhookUrl, payload) {
  if (!webhookUrl) return;
  try {
    await fetch(`${webhookUrl}/messages/@original`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "", embeds: [], components: [], ...payload }),
    });
  } catch (err) {
    console.error("[QuiEstCe] Échec PATCH:", err.message);
  }
}

const ERREURS = {
  termine: "La partie est terminée.",
  pasInscrit: "Tu n'es pas inscrit.",
  inconnu: "Tu ne participes pas à cette partie.",
  sansCible: "Choisis d'abord une cible.",
  dejaCible: "Tu as déjà une cible : démasque-la d'abord.",
  cible: "Cette cible n'est plus disponible.",
  plafondQuestion: "Tu as déjà posé ta question du jour.",
  question: "Cette question n'est pas disponible aujourd'hui.",
  plafondAccusation: "Tu as déjà accusé aujourd'hui.",
  carte: "Cette carte n'est plus possible.",
  objet: "Objet inconnu.",
  objetJour: "Tu as déjà utilisé un objet aujourd'hui.",
  objetsMax: "Tu as déjà utilisé tous tes objets.",
  or: "Pas assez d'Or.",
  doubleUtilise: "Double enquête déjà utilisée.",
  leader: "Tu es toi-même le leader en prime.",
  rienAReveler: "Rien à révéler aujourd'hui sur le leader.",
  pasDePiste: "Aucun rival à copier sur ta cible.",
};

function avertissement(code) {
  return `⚠️ ${ERREURS[code] || "Action impossible."}`;
}

// Raison courte affichée à côté d'un objet indisponible.
const RAISONS_OBJET = {
  objetJour: "déjà un objet aujourd'hui",
  objetsMax: "plus d'objet disponible",
  or: "pas assez d'Or",
  doubleUtilise: "déjà utilisée",
  leader: "tu es le leader",
  rienAReveler: "rien à révéler aujourd'hui",
  pasDePiste: "aucun rival à copier",
};

function statutLigne(j, config) {
  return `💰 Prime : **${j.prime}** · 🏆 **${plural(j.score, "pt")}** · 🪙 **${j.or} Or** · 🎒 Objets : ${j.objets}/${config.objets_max}`;
}

const SOURCES = { projecteur: " (Projecteur)", vol: " (piste volée)", depart: " (indice de départ)" };

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

// [🔎 Enquêter] : carte secrète, statut, cible (ou choix de la cible),
// indices, question du jour et accusation ; fiche d'enquête en image.
async function buildEnqueteView(config, partie, discordId, { entete = null, nouveau = false } = {}) {
  const j = partie.joueurs[discordId];
  if (!partie.demarree) {
    return {
      embeds: [
        {
          description: `${nouveau ? "✅ Inscription confirmée !" : "✅ Tu es déjà inscrit."} À la clôture des inscriptions, tu recevras ta carte secrète et ta première cible.`,
          color: QEC_COLOR,
        },
      ],
    };
  }
  if (partie.termine) return { embeds: [{ description: "🏁 La partie est terminée.", color: QEC_COLOR }] };
  const lignes = [
    ...(nouveau ? ["Bienvenue dans la partie !", ""] : []),
    ...(entete ? [entete, ""] : []),
    `🃏 Ta carte secrète : **${nomCarte(partie, j.carte)}**`,
    statutLigne(j, config),
    "",
  ];
  const components = [];
  let barrees = [j.carte, ...j.demasques.map((d) => partie.joueurs[d]?.carte)];

  if (!j.cible) {
    const dispo = ciblesDisponibles(partie, discordId, { config });
    if (!dispo.length) {
      lignes.push("🎯 Aucune cible disponible pour l'instant, reviens plus tard.");
    } else {
      const [top, ...autres] = dispo;
      lignes.push("🎯 **Choisis ta prochaine cible.** La plus grosse prime disponible t'est proposée, ou choisis quelqu'un d'autre.");
      components.push({
        type: 1,
        components: [bouton(`Viser ${partie.joueurs[top].username} (prime ${partie.joueurs[top].prime})`.slice(0, 80), "🎯", `quiestce_cible:${top}`, 1)],
      });
      if (autres.length) {
        components.push({
          type: 1,
          components: [
            {
              type: 3,
              custom_id: "quiestce_cible_menu",
              placeholder: "Ou choisis une autre cible",
              options: autres.slice(0, 25).map((id) => {
                const c = partie.joueurs[id];
                return { label: c.username.slice(0, 100), value: id, description: `Prime ${c.prime} · ${plural(chasseurs(partie, id).length, "chasseur")}` };
              }),
            },
          ],
        });
      }
    }
  } else {
    const cible = partie.joueurs[j.cible];
    const rivaux = chasseurs(partie, j.cible).filter((id) => id !== discordId);
    lignes.push(`🎯 Ta cible : **${cible.username}** (prime ${cible.prime})${rivaux.length ? ` · 👥 autre chasseur : ${rivaux.map((id) => partie.joueurs[id].username).join(", ")}` : ""}`);
    const infos = j.enquete.ordre.map((q) => `${questionLabel(q)} : **${j.enquete.infos[q]}**${SOURCES[j.enquete.sources[q]] ?? ""}`);
    lignes.push("", "**Ce que tu sais**", ...(infos.length ? infos : ["Rien pour l'instant."]));
    const cs = candidats(partie, discordId);
    barrees = partie.grille.filter((k) => !cs.includes(k));
    lignes.push("", `🃏 Cartes encore possibles : **${cs.length}**`);
    const possibles = questionsPossibles(partie, discordId, { config });
    if (questionsRestantes(j, config) > 0 && possibles.length) {
      components.push({
        type: 1,
        components: [
          {
            type: 3,
            custom_id: "quiestce_question",
            placeholder: "🔎 Pose ta question du jour",
            options: possibles.map((q) => ({ label: QUESTIONS[q].nom, value: q, emoji: { name: QUESTIONS[q].emoji } })),
          },
        ],
      });
    } else {
      lignes.push("✅ Question du jour posée.");
    }
    if (!j.accuseJour && cs.length) {
      const groupes = chunk(cs, 25).slice(0, 4 - (components.length - 1));
      groupes.forEach((groupe, n) => {
        components.push({
          type: 1,
          components: [
            {
              type: 3,
              custom_id: `quiestce_accuser:${n}`,
              placeholder: `🎯 Accuser : la carte de ${cible.username} est…${groupes.length > 1 ? ` (${n + 1}/${groupes.length})` : ""}`.slice(0, 150),
              options: groupe.map((k) => ({ label: nomCarte(partie, k).slice(0, 100), value: k })),
            },
          ],
        });
      });
    } else if (j.accuseJour) {
      lignes.push("✅ Accusation du jour faite.");
    }
  }
  return {
    embeds: [
      {
        title: "🔎 Enquête",
        description: lignes.join("\n").slice(0, 4096),
        color: QEC_COLOR,
        image: { url: await grilleUrl(partie, barrees.filter(Boolean)) },
        footer: { text: "Cartes barrées : impossibles pour ta cible (ou déjà connues)." },
      },
    ],
    components,
  };
}

// [🎒 Objets] : Or, objets disponibles (ou raison du refus) ; `projecteur` :
// choix de la question à révéler sur le leader.
function buildObjetsView(config, partie, discordId, { entete = null, nouveau = false, projecteur = false } = {}) {
  const j = partie.joueurs[discordId];
  if (!partie.demarree) return { embeds: [{ description: "La partie n'a pas encore commencé.", color: QEC_COLOR }] };
  if (partie.termine) return { embeds: [{ description: "🏁 La partie est terminée.", color: QEC_COLOR }] };
  const lignes = [...(nouveau ? ["Bienvenue dans la partie !", ""] : []), ...(entete ? [entete, ""] : []), statutLigne(j, config)];
  const etats = Object.fromEntries(Object.keys(OBJETS).map((o) => [o, etatObjet(partie, discordId, o, { config })]));
  const components = [];
  if (projecteur && etats.projecteur.ok) {
    const leader = partie.joueurs[leaderPrime(partie)];
    lignes.push("", `🔦 Leader en prime : **${leader.username}** (prime ${leader.prime}). Quelle caractéristique révéler à tous ?`);
    components.push({
      type: 1,
      components: [
        {
          type: 3,
          custom_id: "quiestce_projecteur",
          placeholder: "🔦 Caractéristique à révéler",
          options: questionsProjecteur(partie, { config }).map((q) => ({ label: QUESTIONS[q].nom, value: q, emoji: { name: QUESTIONS[q].emoji } })),
        },
      ],
    });
  } else {
    // Tous les objets dans le menu (Discord ne permet pas de griser une
    // option) : effet si utilisable, sinon 🔒 et la raison.
    components.push({
      type: 1,
      components: [
        {
          type: 3,
          custom_id: "quiestce_objet",
          placeholder: "🎒 Utiliser un objet (1 par jour)",
          options: Object.keys(OBJETS).map((o) => ({
            label: `${OBJETS[o].nom} (${config.objets[o].cout} Or)`,
            value: o,
            emoji: { name: etats[o].ok ? OBJETS[o].emoji : "🔒" },
            description: (etats[o].ok ? OBJETS[o].effet : `Indisponible : ${RAISONS_OBJET[etats[o].raison]}`).slice(0, 100),
          })),
        },
      ],
    });
  }
  return { embeds: [{ title: "🎒 Objets", description: lignes.join("\n").slice(0, 4096), color: QEC_COLOR }], components };
}

// État requis pour toute action ; null (et message) sinon. `annonce` :
// action permise pendant la fenêtre d'inscription (S'inscrire).
async function guardActive(webhookUrl, { annonce = false } = {}) {
  const state = await readState();
  const ok = state && !state.termine && (state.phase === "jour" || (annonce && state.phase === "annonce"));
  if (!ok) {
    await patchOriginal(webhookUrl, { content: state?.phase === "annonce" ? "La partie n'a pas encore commencé : inscris-toi avec le bouton *S'inscrire*." : "Aucune partie de Qui est-ce ? en cours." });
    return null;
  }
  return state;
}

// Action commune : sous verrou (quiestce.js), puis vue éphémère (`vue`,
// éventuellement asynchrone) et message officiel réédité.
async function executer(webhookUrl, discordId, username, action, vue, { rafraichir = true, annonce = false, inscription = false } = {}) {
  const state = await guardActive(webhookUrl, { annonce });
  if (!state) return;
  const config = await loadQuiEstCeConfig();
  const r = await agir(discordId, username, action, { inscription });
  const refus = {
    inscriptions: "🔒 Les inscriptions sont closes : tu ne participes pas à cette partie. Rendez-vous à la prochaine !",
    complet: `🔒 Désolé, l'effectif maximum (${config.effectif_max} joueurs) est atteint.`,
    pasInscrit: "Tu n'es pas inscrit : clique sur *S'inscrire*.",
  };
  if (refus[r.erreur]) {
    await patchOriginal(webhookUrl, { content: refus[r.erreur] });
    return;
  }
  await patchOriginal(webhookUrl, await vue(config, r.partie, discordId, { ...(r.resultat || {}), nouveau: r.nouveau }));
  if (rafraichir || r.nouveau) await rafraichirMessage(state, await readPartie());
}

function texteAccusation(r, partie, cibleId, cardKey) {
  const nom = partie.joueurs[cibleId]?.username ?? "?";
  if (r.erreur) return avertissement(r.erreur);
  if (!r.correct) return `❌ Raté : **${nom}** n'a pas la carte ${nomCarte(partie, cardKey)} (-1 pt).`;
  return `🎯 **Bravo !** **${nom}** avait bien la carte ${nomCarte(partie, cardKey)} : **+${plural(r.gain, "pt")}**${r.prime ? ` (dont ${r.prime} de prime)` : ""}.`;
}

// ── Boutons du message officiel (nouvel éphémère) ────────────────────

// [✅ S'inscrire] (fenêtre d'inscription).
export async function handleParticiper(webhookUrl, discordId, username) {
  try {
    await executer(webhookUrl, discordId, username, () => ({}), buildEnqueteView, { rafraichir: false, annonce: true, inscription: true });
  } catch (err) {
    console.error("[QuiEstCe] Échec inscription:", err.message);
  }
}

// [✖️ Se désinscrire] (fenêtre d'inscription).
export async function handleDesinscrire(webhookUrl, discordId) {
  try {
    const state = await guardActive(webhookUrl, { annonce: true });
    if (!state) return;
    if (state.phase !== "annonce") {
      await patchOriginal(webhookUrl, { content: "🔒 La partie est lancée, il n'est plus possible de se désinscrire." });
      return;
    }
    const r = await desinscrireJoueur(discordId);
    await patchOriginal(webhookUrl, { content: r.erreur ? "Tu n'étais pas inscrit." : "✖️ Désinscription confirmée." });
    if (!r.erreur) await rafraichirMessage(state, r.partie);
  } catch (err) {
    console.error("[QuiEstCe] Échec désinscription:", err.message);
  }
}

// [🔎 Enquêter].
export async function handleEnqueter(webhookUrl, discordId, username) {
  try {
    await executer(webhookUrl, discordId, username, () => ({}), buildEnqueteView, { rafraichir: false });
  } catch (err) {
    console.error("[QuiEstCe] Échec enquêter:", err.message);
  }
}

// [🎒 Objets].
export async function handleObjets(webhookUrl, discordId, username) {
  try {
    await executer(webhookUrl, discordId, username, () => ({}), buildObjetsView, { rafraichir: false });
  } catch (err) {
    console.error("[QuiEstCe] Échec objets:", err.message);
  }
}

// ── Composants de l'éphémère (édition en place) ──────────────────────

// Menu « Pose ta question du jour ».
export async function handleQuestion(webhookUrl, discordId, username, q) {
  try {
    await executer(
      webhookUrl,
      discordId,
      username,
      (partie, config) => {
        const r = poser(partie, discordId, q, { config });
        const cible = partie.joueurs[partie.joueurs[discordId]?.cible];
        return { entete: r.erreur ? avertissement(r.erreur) : `🔎 ${QUESTIONS[q].nom} de la carte de **${cible?.username}** : **${r.valeur}**.` };
      },
      buildEnqueteView,
    );
  } catch (err) {
    console.error("[QuiEstCe] Échec question:", err.message);
  }
}

// Menu(s) « Accuser ».
export async function handleAccuser(webhookUrl, discordId, username, cardKey) {
  try {
    await executer(
      webhookUrl,
      discordId,
      username,
      (partie, config) => {
        const cibleId = partie.joueurs[discordId]?.cible;
        const r = accuser(partie, discordId, cardKey, { config });
        return { entete: texteAccusation(r, partie, cibleId, cardKey) };
      },
      buildEnqueteView,
    );
  } catch (err) {
    console.error("[QuiEstCe] Échec accusation:", err.message);
  }
}

// Bouton « Viser X » et menu « Ou choisis une autre cible ».
export async function handleCible(webhookUrl, discordId, username, cibleId) {
  try {
    await executer(
      webhookUrl,
      discordId,
      username,
      (partie, config) => {
        const r = choisirCible(partie, discordId, cibleId, { config });
        if (r.erreur) return { entete: avertissement(r.erreur) };
        const indice = r.depart ? ` Indice de départ : ${QUESTIONS[r.depart.q].nom.toLowerCase()} **${r.depart.valeur}**.` : "";
        return { entete: `🎯 Nouvelle cible : **${partie.joueurs[cibleId].username}**.${indice}` };
      },
      buildEnqueteView,
    );
  } catch (err) {
    console.error("[QuiEstCe] Échec cible:", err.message);
  }
}

function texteObjet(r, partie) {
  if (r.erreur) return avertissement(r.erreur);
  if (r.objet === "double") return "🔁 Double enquête : tu peux poser une 2e question aujourd'hui (bouton Enquêter).";
  if (r.objet === "vol") return `🕵️ Piste volée à **${partie.joueurs[r.rival].username}** : ${QUESTIONS[r.q].nom.toLowerCase()} **${r.valeur}**.`;
  return `🔦 Projecteur braqué sur **${partie.joueurs[r.leader].username}** : ${QUESTIONS[r.q].nom.toLowerCase()} **${r.valeur}** (révélé à tous).`;
}

// Menu « Utiliser un objet » : Projecteur → choix de la question ; autres
// objets utilisés tout de suite.
export async function handleObjet(webhookUrl, discordId, username, objet) {
  try {
    if (objet === "projecteur") {
      await executer(
        webhookUrl,
        discordId,
        username,
        (partie, config) => {
          const etat = etatObjet(partie, discordId, "projecteur", { config });
          return etat.ok ? { projecteur: true } : { entete: avertissement(etat.raison) };
        },
        buildObjetsView,
        { rafraichir: false },
      );
      return;
    }
    await executer(
      webhookUrl,
      discordId,
      username,
      (partie, config) => ({ entete: texteObjet(utiliserObjet(partie, discordId, objet, { config }), partie) }),
      buildObjetsView,
    );
  } catch (err) {
    console.error("[QuiEstCe] Échec objet:", err.message);
  }
}

// Menu « Caractéristique à révéler » (Projecteur).
export async function handleProjecteur(webhookUrl, discordId, username, q) {
  try {
    await executer(
      webhookUrl,
      discordId,
      username,
      (partie, config) => ({ entete: texteObjet(utiliserObjet(partie, discordId, "projecteur", { config, q }), partie) }),
      buildObjetsView,
    );
  } catch (err) {
    console.error("[QuiEstCe] Échec projecteur:", err.message);
  }
}

// ── Bouton [📜 Journal] (éphémère) ───────────────────────────────────

// Ce qui concerne le joueur (ses actions, celles qui le visent, ses notes
// privées : réponses, accusations), regroupé par jour, du plus récent au
// plus ancien (jours anciens coupés au-delà de 4096 caractères).
export async function handleJournal(webhookUrl, discordId) {
  try {
    const [state, partie] = await Promise.all([readState(), readPartie()]);
    if (!state || state.phase !== "jour") {
      await patchOriginal(webhookUrl, { content: "Aucune partie de Qui est-ce ? en cours." });
      return;
    }
    if (!partie.joueurs[discordId]) {
      await patchOriginal(webhookUrl, { content: "Tu ne participes pas à cette partie." });
      return;
    }
    const jours = new Map();
    for (const e of partie.journal) {
      if (e.p !== discordId && !e.ids?.includes(discordId) && e.k !== "projecteur") continue;
      if (!jours.has(e.j)) jours.set(e.j, []);
      jours.get(e.j).push(texteJournal(partie, e, discordId));
    }
    let description = "";
    for (const [j, lignes] of [...jours.entries()].sort((a, b) => b[0] - a[0])) {
      const bloc = [`**Jour ${j}**`, ...lignes, ""].join("\n");
      if (description.length + bloc.length > 4000) {
        description += "*(jours précédents non affichés)*";
        break;
      }
      description += `${bloc}\n`;
    }
    await patchOriginal(webhookUrl, {
      embeds: [{ title: "📜 Ton journal", description: description.trim() || "Rien à signaler pour l'instant.", color: QEC_COLOR }],
    });
  } catch (err) {
    console.error("[QuiEstCe] Échec Journal:", err.message);
  }
}

// ── Bouton [📖 Règles] (éphémère, statique) ──────────────────────────

export async function handleRegles(webhookUrl) {
  try {
    await patchOriginal(webhookUrl, { embeds: [buildReglesEmbed(await loadQuiEstCeConfig())] });
  } catch (err) {
    console.error("[QuiEstCe] Échec Règles:", err.message);
  }
}
