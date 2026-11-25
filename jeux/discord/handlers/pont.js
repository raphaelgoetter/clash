// ============================================================
// pont.js — Handlers Discord du Pont du Troll (jeu spécial de 7 jours).
// Publication deux fois par jour (postPont, appelée uniquement par
// jeux/scripts/postPont.js) : le matin, la question Vrai/Faux (pièce bonus) ;
// l'après-midi, les boutons du message public (Pont de pierre, Pont de
// cordes, Rumeurs ou Indice, Règles) et le menu des rumeurs.
// Règles : jeux/CONTRIBUTING.md, section « Pont du Troll ».
// ============================================================

import {
  PIERRE,
  CORDES,
  REPU,
  FINALE,
  JOUR_DE_VERITE,
  MATIN,
  APRES_MIDI,
  horaires,
  loadPontConfig,
  jourConfig,
  indiceDisponible,
  rumeursDisponibles,
  rumeursPrecedentes,
  readState,
  writeState,
  transitionPrete,
  jourOuvert,
  resoudreJour,
  buildRanking,
  memeRang,
  formatPieces,
  enregistrerChoix,
  readChoix,
  listChoix,
  compterPassants,
  lancerRumeur,
  readRumeur,
  listRumeurs,
  rumeursAnnoncees,
  menteurs,
  VERITE,
  MENSONGE,
  RIEN,
  consulterIndice,
  addPoints,
  addPasse,
  inscrireAuClassement,
  readPoints,
  readPasses,
  readUsernames,
  writeHistoriqueEntry,
  archiveManche,
  listManches,
  resetPartie,
  jouerPnj,
  jouerPnjMatin,
  estPnj,
  loadVraiFaux,
  choisirPartieVraiFaux,
  questionDuJour,
  repondreVraiFaux,
  readVraiFaux,
  porteursBonus,
} from "../../services/pont.js";
import {
  getRoleIdByName,
  MINI_JEUX_ROLE_NAME,
} from "@clash/commun/discordRoles.js";
import { resolveDisplayName } from "@clash/commun/discordUsers.js";
import { rangExAequo } from "@clash/commun/classement.js";
import { versV2 as versV2Commun } from "../composantsV2.js";
import { URL_JEUX } from "../../services/urlJeux.js";

const PONT_COLOR = 0x6b8f3a;
// À incrémenter après remplacement de l'illustration d'annonce (cache Discord)
const ILLUSTRATION_VERSION = 1;
export const PONT_ILLUSTRATION_URL = `${URL_JEUX}/api/pont/illustration?v=${ILLUSTRATION_VERSION}`;

const EMOJI = { [PIERRE]: "🪨", [CORDES]: "🪢" };
const NOM_PONT = { [PIERRE]: "Pont de pierre", [CORDES]: "Pont de cordes" };
const NOM_COURT = { [PIERRE]: "Pierre", [CORDES]: "Cordes" };
const PAR = {
  [PIERRE]: "par le pont de pierre",
  [CORDES]: "par le pont de cordes",
};
const SUR = { [PIERRE]: "sur la pierre", [CORDES]: "sur les cordes" };

const pluriel = (n, mot) => `${n} ${mot}${n > 1 ? "s" : ""}`;
const pieces = (centiemes) =>
  `${formatPieces(centiemes)} pièce${centiemes >= 200 ? "s" : ""}`;
// PNJ du salon de test : pseudo stocké, aucun appel Discord
const nomAffiche = (discordId, fallback) =>
  estPnj(discordId)
    ? Promise.resolve(fallback ?? "PNJ")
    : resolveDisplayName(discordId, fallback);

// ── URLs d'images ─────────────────────────────────────────────────

const urlMatin = (jour, v) =>
  `${URL_JEUX}/api/pont/matin?jour=${jour}&v=${v}`;
const urlResultat = (partieId, jour, v) =>
  `${URL_JEUX}/api/pont/resultat?partie=${encodeURIComponent(partieId)}&jour=${jour}&v=${v}`;

// ── Embeds ────────────────────────────────────────────────────────

function buildAnnonceEmbed(config) {
  return {
    title: "🧌 Pont du Troll : le troll s'installe demain",
    description: [
      `De l'autre côté du ravin, le village tient son grand marché pendant **${config.duree_jours} jours**. Chaque jour, traverse pour aller y faire fortune, par le pont de pierre ou le pont de cordes, en secret.`,
      "",
      "Mais un troll vit sous les ponts. Il attrape le plus chargé : chaque joueur attrapé lâche une pièce, que ceux de l'autre pont ramassent… multipliée par la prime du village affichée à l'entrée de leur pont.",
      "",
      "Chaque matin, une question Vrai ou Faux : bonne réponse = 🪙 1 pièce bonus à emporter au marché.",
      "",
      "Plus d'infos ? Clique sur *Règles* ci-dessous.",
    ].join("\n"),
    color: PONT_COLOR,
    image: { url: PONT_ILLUSTRATION_URL },
    footer: { text: "La partie commence demain matin." },
  };
}

const footerJour = (n) => ({
  text: `🚶 ${pluriel(n, "joueur")} aujourd'hui · Choix secret et définitif, décompte à minuit`,
});

function ligneEvenement(cfg) {
  if (cfg.evenement === REPU) return "🍖 **Troll repu** : aujourd'hui, il attrape le pont **le moins** chargé !";
  if (cfg.evenement === FINALE) return "🎉 **Fête du village** : le village double ses primes !";
  if (cfg.evenement === JOUR_DE_VERITE) return "📢 **Jour de vérité** : toutes les rumeurs du jour sont vraies !";
  return null;
}

const INTITULE_MATIN = "☀️ Ce matin : vrai ou faux ?";
// Textes horaires calculés à la publication ou au clic (hiver / été)
const footerMatin = () => ({ text: `Une seule réponse, corrigée tout de suite · Ponts ouverts de ${horaires().ponts}h à minuit` });

// Question du matin et ponts de l'après-midi (multiplicateurs, événement)
function lignesMatin(cfg, question) {
  const evenement = ligneEvenement(cfg);
  return [
    `> ### ${question.affirmation}`,
    "Bonne réponse = 🪙 1 pièce bonus à emporter au marché.",
    "",
    `🌉 Cet après-midi : ${EMOJI[PIERRE]} Pierre ×${cfg.pierre} · ${EMOJI[CORDES]} Cordes ×${cfg.cordes}`,
    ...(evenement ? [evenement] : []),
  ];
}

// Matin du Jour 1 (aucun résultat à montrer)
function buildPremierMatinEmbed(config, cfg, question, { v }) {
  return {
    title: `🧌 Pont du Troll (Jour 1/${config.duree_jours})`,
    description: [
      `**Le troll s'est installé sous les ponts !** Les ponts ouvrent à ${horaires().ponts}h.`,
      "",
      `### ${INTITULE_MATIN}`,
      ...lignesMatin(cfg, question),
    ].join("\n"),
    color: PONT_COLOR,
    image: { url: urlMatin(cfg.jour, v) },
    footer: footerMatin(),
  };
}

function buildJourEmbed(config, cfg, { estPremierJour, v }) {
  const lines = [];
  if (estPremierJour)
    lines.push(
      "**Le troll s'est installé sous les ponts !** Choisis ton pont, en secret, avant minuit. Résultat demain matin.",
      "",
    );
  lines.push(
    // Titre ### : plus grand que le texte (multiplicateurs du jour)
    `### ${EMOJI[PIERRE]} Pont de pierre : ×${cfg.pierre} · ${EMOJI[CORDES]} Pont de cordes : ×${cfg.cordes}`,
  );
  // La règle elle-même est dans les Règles : seul l'événement est rappelé
  const evenement = ligneEvenement(cfg);
  if (evenement) lines.push("", evenement);
  // Indice et Rumeurs : pas de mention, leur bouton suffit
  return {
    title: `🧌 Pont du Troll (Jour ${cfg.jour}/${config.duree_jours})`,
    description: lines.join("\n"),
    color: PONT_COLOR,
    image: { url: urlMatin(cfg.jour, v) },
    footer: footerJour(0),
  };
}

async function nommer(ids, usernames) {
  return Promise.all(ids.map((id) => nomAffiche(id, usernames[id])));
}

export async function lignesClassement(ranking, limite) {
  const usernames = await readUsernames();
  const liste = await Promise.all(
    ranking
      .slice(0, limite)
      .map(async (r) => ({
        ...r,
        nom: await nomAffiche(
          r.discordId,
          r.username ?? usernames[r.discordId],
        ),
      })),
  );
  // Passages (départage) affichés pour tout le monde
  return liste.map(
    (r, i, l) =>
      `${rangExAequo(l, i, memeRang)}\\. ${r.nom} (${pieces(r.centiemes)}, ${pluriel(r.passes, "passage")})`,
  );
}

// Résultat d'un jour (`entry` : entrée d'historique)
async function buildResultatEmbed(entry, ranking, { partieId, v }) {
  const usernames = await readUsernames();
  const lines = [];
  const total = entry.pierre + entry.cordes;
  if (total === 0) {
    lines.push("Personne n'a traversé ce jour-là.");
  } else {
    lines.push(
      `${EMOJI[PIERRE]} Pierre : **${entry.pierre}** · ${EMOJI[CORDES]} Cordes : **${entry.cordes}**`,
    );
    const nA = entry.attrape ? entry[entry.attrape] : 0;
    const nG = entry.gagnant ? entry[entry.gagnant] : 0;
    if (!entry.attrape || nA === 0) {
      // Personne d'attrapé : chacun gagne le multiplicateur de son pont
      lines.push(entry.attrape ? "🧌 Le troll n'attrape personne." : "🧌 Égalité : le troll se rendort, personne n'est attrapé.");
      const g = entry.gainParCote ?? {};
      lines.push(
        `💰 Tout le monde passe : Pierre **+${pieces(g[PIERRE] ?? 0)}**, Cordes **+${pieces(g[CORDES] ?? 0)}** par joueur.`,
      );
    } else {
      lines.push(
        `🧌 Le troll attrape **${pluriel(nA, "joueur")}** ${SUR[entry.attrape]}${entry.bonusPerdus ? ` (et ${entry.bonusPerdus} pièce${entry.bonusPerdus > 1 ? "s" : ""} bonus)` : ""}.`,
      );
      lines.push(
        nG
          ? `💰 ${NOM_COURT[entry.gagnant]} : **+${pieces(entry.gainBase)}** par joueur.`
          : "💰 Personne en face pour le butin.",
      );
    }
  }
  if (ranking?.length)
    lines.push("", "**Classement :**", ...(await lignesClassement(ranking, 5)));
  return {
    title: `📊 Résultat du Jour ${entry.jour}`,
    description: lines.join("\n"),
    color: PONT_COLOR,
    image: { url: urlResultat(partieId, entry.jour, v) },
  };
}

async function buildFinalEmbed(ranking, manches) {
  const lines = ["**Classement final :**"];
  lines.push(
    ...(ranking.length
      ? await lignesClassement(ranking, 20)
      : ["Personne n'a traversé cette partie."]),
  );
  const max = ranking[0]?.centiemes ?? 0;
  if (max > 0) {
    const usernames = await readUsernames();
    const vainqueurs = ranking.filter((r) => memeRang(r, ranking[0]));
    const noms = await nommer(
      vainqueurs.map((r) => r.discordId),
      usernames,
    );
    lines.push(
      "",
      `🏆 Vainqueur${noms.length > 1 ? "s" : ""} (${pieces(max)}) : ${noms.join(", ")}`,
    );
  }
  if (manches.length) {
    lines.push(
      "",
      "**Vainqueurs des parties précédentes :**",
      ...manches.map(
        (m) =>
          `Partie ${m.manche} : 🏆 ${m.winners?.length ? m.winners.join(", ") : "personne"} (${m.maxPoints} pièces)`,
      ),
    );
  }
  return {
    title: "🏁 Pont du Troll : classement final",
    description: lines.join("\n"),
    color: PONT_COLOR,
    image: { url: PONT_ILLUSTRATION_URL },
  };
}

// Un seul bloc et une seule image par message : résultat de la veille (texte
// + image du résultat), puis la suite en texte sous l'image (jour en cours
// ou classement final), pied et boutons.
function unSeulBloc(title, resultat, suite, { intituleSuite = null } = {}) {
  return {
    title,
    description: `**${resultat.title}**\n${resultat.description}`,
    color: PONT_COLOR,
    image: resultat.image,
    apres: [intituleSuite ? `### ${intituleSuite}` : null, suite.description].filter(Boolean).join("\n"),
    footer: suite.footer,
  };
}


const blocMatin = (config, jour, resultat, cfg, question) =>
  unSeulBloc(`🧌 Pont du Troll (Jour ${jour}/${config.duree_jours})`, resultat, { description: lignesMatin(cfg, question).join("\n"), footer: footerMatin() }, { intituleSuite: INTITULE_MATIN });

const blocFin = (resultat, finalEmbed) => unSeulBloc("🏁 Pont du Troll : fin de partie", resultat, finalEmbed);

// ── Boutons ───────────────────────────────────────────────────────

const boutonRegles = {
  type: 2,
  style: 2,
  label: "Règles",
  emoji: { name: "📖" },
  custom_id: "pont_regles",
};

function buildMatinComponents(jour) {
  return [
    {
      type: 1,
      components: [
        { type: 2, style: 2, label: "Vrai", emoji: { name: "✅" }, custom_id: `pont_vf:${jour}:vrai` },
        { type: 2, style: 2, label: "Faux", emoji: { name: "❌" }, custom_id: `pont_vf:${jour}:faux` },
        boutonRegles,
      ],
    },
  ];
}

function buildJourComponents(config, jour) {
  return [
    {
      type: 1,
      components: [
        {
          type: 2,
          style: 1,
          label: "Pont de pierre",
          emoji: { name: EMOJI[PIERRE] },
          custom_id: `pont_pierre:${jour}`,
        },
        {
          type: 2,
          style: 1,
          label: "Pont de cordes",
          emoji: { name: EMOJI[CORDES] },
          custom_id: `pont_cordes:${jour}`,
        },
        // Rumeurs les jours impairs, Indice les jours pairs
        ...(rumeursDisponibles(config, jour)
          ? [
              {
                type: 2,
                style: 2,
                label: "Rumeurs",
                emoji: { name: "🗣️" },
                custom_id: `pont_rumeurs:${jour}`,
              },
            ]
          : []),
        ...(indiceDisponible(config, jour)
          ? [
              {
                type: 2,
                style: 2,
                label: "Indice",
                emoji: { name: "🔎" },
                custom_id: `pont_indice:${jour}`,
              },
            ]
          : []),
        boutonRegles,
      ],
    },
  ];
}

// ── Publication quotidienne ───────────────────────────────────────

async function discordFetch(chemin, options = {}) {
  const token = process.env.DISCORD_TOKEN;
  if (!token) throw new Error("DISCORD_TOKEN manquant.");
  return fetch(`https://discord.com/api/v10${chemin}`, {
    ...options,
    headers: {
      Authorization: `Bot ${token}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
}

// Messages en Components V2 (galerie plus grande qu'une image d'embed),
// voir jeux/discord/composantsV2.js
export const versV2 = (embeds, components = [], roleId = null) =>
  versV2Commun(embeds, components, roleId, PONT_COLOR);

async function publishAndWriteState(
  channelId,
  previousState,
  { phase = APRES_MIDI, jour, partieId, vfPartie = null, embeds, components, ping, termine = false },
) {
  if (previousState?.messageId && previousState?.channelId) {
    try {
      const del = await discordFetch(
        `/channels/${previousState.channelId}/messages/${previousState.messageId}`,
        { method: "DELETE" },
      );
      if (!del.ok && del.status !== 404)
        console.warn(
          `[Pont] Échec suppression du message de la veille (${del.status}), publication quand même.`,
        );
    } catch (err) {
      console.warn(
        "[Pont] Erreur réseau à la suppression du message de la veille:",
        err.message,
      );
    }
  }
  const roleId = ping ? await getRoleIdByName(MINI_JEUX_ROLE_NAME) : null;
  const res = await discordFetch(`/channels/${channelId}/messages`, {
    method: "POST",
    body: JSON.stringify(versV2(embeds, components, roleId)),
  });
  if (!res.ok)
    throw new Error(
      `Erreur envoi salon Discord (${res.status}): ${await res.text().catch(() => "")}`,
    );
  const message = await res.json();
  await writeState({
    phase,
    jour,
    partieId,
    vfPartie,
    channelId,
    messageId: message.id,
    publishedAt: new Date().toISOString(),
    termine,
    embeds,
    components,
  });
  return { jour, embeds, message, termine };
}

// Applique le résultat d'un jour : pièces, jours passés, historique.
// Renvoie l'entrée d'historique (aussi utilisée en projection dry-run).
function entreeHistorique(jour, cfg, res, rumeurs = {}) {
  return {
    jour,
    multiplicateurs: { pierre: cfg.pierre, cordes: cfg.cordes },
    evenement: cfg.evenement ?? null,
    pierre: res.pierre,
    cordes: res.cordes,
    attrape: res.attrape,
    gagnant: res.gagnant,
    gainBase: res.gainBase,
    gainParCote: res.gainParCote,
    // Pièces du matin tombées dans le butin, porteurs qui ont traversé
    bonusPerdus: res.bonusPerdus,
    bonus: res.resultats.filter((r) => r.bonus).map((r) => r.discordId),
    passants: res.passants,
    // Rumeurs lancées ce jour-là (compte-rendu)
    rumeurs: {
      verite: Object.keys(rumeurs).filter((id) => rumeurs[id]?.mode === VERITE),
      mensonge: Object.keys(rumeurs).filter((id) => rumeurs[id]?.mode === MENSONGE),
    },
    resolvedAt: new Date().toISOString(),
  };
}

// Classement après application (réelle ou projetée) des résultats
function classementProjete(points, passes, resultats) {
  const p = { ...points };
  const pa = { ...passes };
  for (const r of resultats) {
    p[r.discordId] = (p[r.discordId] || 0) + r.gain;
    if (r.passe) pa[r.discordId] = (pa[r.discordId] || 0) + 1;
  }
  return buildRanking(p, pa);
}

// Résout le jour actif sans rien écrire (cron, dry-run, pont:status)
export async function projeterJour(state, config) {
  const cfg = jourConfig(config, state.jour);
  const res = resoudreJour(await listChoix(state.jour), cfg, await porteursBonus(state.jour));
  const entry = entreeHistorique(state.jour, cfg, res, await listRumeurs(state.jour));
  const ranking = classementProjete(
    await readPoints(),
    await readPasses(),
    res.resultats,
  );
  return { cfg, res, entry, ranking };
}

// Jour de jeu en deux phases, un message chacune : le matin (vers 8h), le
// résultat de la veille et la question Vrai/Faux ; l'après-midi (vers 14h,
// 15h en été), le troll endormi et les ponts du jour. Chaque passage du cron fait la transition
// prête (transitionPrete()), sinon rien.
// `pnj` : 5 joueurs fictifs répondent et traversent chaque jour (jamais sur
// le salon public). ⚠️ Ping seulement si `isPublic` et sans `noPing` :
// jamais de ping sur le salon de test, quel que soit l'appelant.
export async function postPont(
  channelId,
  {
    dryRun = false,
    noPing = false,
    isPublic = false,
    requireActiveState = false,
    force = false,
    pnj = false,
  } = {},
) {
  const config = await loadPontConfig();
  const vraiFaux = await loadVraiFaux();
  const ping = isPublic && !noPing;
  const avecPnj = pnj && !isPublic;
  const state = await readState();

  if (state?.termine) return { termine: true };
  if (state && !dryRun && !force && !transitionPrete(state)) {
    return {
      skipped: true,
      reason: "pasEncore",
      phase: state.phase,
      publishedAt: state.publishedAt,
    };
  }
  if (state && state.channelId !== channelId)
    return { wrongChannel: true, activeChannelId: state.channelId };
  if (!state && requireActiveState) return { skipped: true };

  const v = Date.now();

  // 1) Aucun état : jour d'annonce (jamais le Jour 1 directement), avec ping
  if (!state) {
    const embeds = [buildAnnonceEmbed(config)];
    const components = [{ type: 1, components: [boutonRegles] }];
    if (dryRun) return { dryRun: true, phase: "annonce", embeds, components };
    const partieId = v.toString(36);
    return publishAndWriteState(channelId, null, {
      phase: "annonce",
      jour: null,
      partieId,
      embeds,
      components,
      ping,
    });
  }

  // 2) Annonce -> matin du Jour 1 : remise à zéro de la partie, partie de
  // questions suivante, avec ping
  if (state.phase === "annonce") {
    const cfg = jourConfig(config, 1);
    const vfPartie = dryRun ? 0 : await choisirPartieVraiFaux();
    const question = questionDuJour(vraiFaux, vfPartie, 1);
    const embeds = [buildPremierMatinEmbed(config, cfg, question, { v })];
    const components = buildMatinComponents(1);
    if (dryRun)
      return { dryRun: true, phase: MATIN, jour: 1, embeds, components };
    await resetPartie();
    const out = await publishAndWriteState(channelId, state, {
      phase: MATIN,
      jour: 1,
      partieId: state.partieId,
      vfPartie,
      embeds,
      components,
      ping,
    });
    if (avecPnj) await jouerPnjMatin(1, question);
    return out;
  }

  // 3) Matin -> après-midi : les ponts ouvrent. Le résultat de la veille a
  // été montré le matin : image du troll endormi et ponts du jour seulement.
  if (state.phase === MATIN) {
    const cfg = jourConfig(config, state.jour);
    const embeds = [buildJourEmbed(config, cfg, { estPremierJour: state.jour === 1, v })];
    const components = buildJourComponents(config, state.jour);
    if (dryRun)
      return { dryRun: true, phase: APRES_MIDI, jour: state.jour, embeds, components };
    const out = await publishAndWriteState(channelId, state, {
      phase: APRES_MIDI,
      jour: state.jour,
      partieId: state.partieId,
      vfPartie: state.vfPartie ?? null,
      embeds,
      components,
      ping: false,
    });
    if (avecPnj) await faireJouerPnj(config, state.jour);
    return out;
  }

  // 4) Après-midi : résolution du jour, puis matin suivant ou classement final
  const { res, entry, ranking } = await projeterJour(state, config);
  const jourSuivant = state.jour + 1;
  const estFin = jourSuivant > config.duree_jours;
  const manches = estFin ? await listManches({ limit: 10 }) : [];
  const resultatEmbed = await buildResultatEmbed(
    entry,
    estFin ? null : ranking,
    { partieId: state.partieId, v },
  );
  const question = estFin ? null : questionDuJour(vraiFaux, state.vfPartie, jourSuivant);
  const embedsSuite = async (finalRanking) =>
    estFin
      ? [blocFin(resultatEmbed, await buildFinalEmbed(finalRanking, manches))]
      : [blocMatin(config, jourSuivant, resultatEmbed, jourConfig(config, jourSuivant), question)];

  if (dryRun) {
    return {
      dryRun: true,
      final: estFin,
      phase: estFin ? null : MATIN,
      jour: estFin ? state.jour : jourSuivant,
      embeds: await embedsSuite(ranking),
      entry,
    };
  }

  for (const r of res.resultats) {
    await inscrireAuClassement(r.discordId);
    await addPoints(r.discordId, r.gain);
    if (r.passe) await addPasse(r.discordId);
  }
  await writeHistoriqueEntry(state.jour, {
    ...entry,
    partieId: state.partieId,
  });

  if (estFin) {
    const finalRanking = buildRanking(
      await readPoints(),
      await readPasses(),
      await readUsernames(),
    );
    if (isPublic) {
      const usernames = await readUsernames();
      const resolu = await Promise.all(
        finalRanking.map(async (r) => ({
          discordId: r.discordId,
          username: await nomAffiche(r.discordId, usernames[r.discordId]),
          points: Math.round(r.centiemes / 100),
          centiemes: r.centiemes,
          passes: r.passes,
        })),
      );
      const max = finalRanking[0]?.centiemes ?? 0;
      await archiveManche({
        resolvedAt: new Date().toISOString(),
        ranking: resolu,
        winners:
          max > 0
            ? resolu
                .filter(
                  (r) =>
                    r.centiemes === max && r.passes === finalRanking[0].passes,
                )
                .map((r) => r.username)
            : [],
        maxPoints: formatPieces(max),
      });
    }
    const out = await publishAndWriteState(channelId, state, {
      jour: state.jour,
      partieId: state.partieId,
      vfPartie: state.vfPartie ?? null,
      embeds: await embedsSuite(finalRanking),
      components: [],
      ping,
      termine: true,
    });
    return { ...out, final: true };
  }

  const out = await publishAndWriteState(channelId, state, {
    phase: MATIN,
    jour: jourSuivant,
    partieId: state.partieId,
    vfPartie: state.vfPartie ?? null,
    embeds: await embedsSuite(ranking),
    components: buildMatinComponents(jourSuivant),
    ping,
  });
  if (avecPnj) await jouerPnjMatin(jourSuivant, question);
  return out;
}

// PNJ du salon de test : choix du jour, puis compteur du message public
async function faireJouerPnj(config, jour) {
  await jouerPnj(jour, { rumeurs: rumeursDisponibles(config, jour) });
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
    console.error("[Pont] Échec PATCH:", err.message);
  }
}

const messageSeul = (content) => ({ content, embeds: [], components: [] });

// Phase cliquable (`MATIN` : Vrai/Faux, `APRES_MIDI` : ponts) : renvoie
// l'état, ou null après avoir répondu au joueur
async function etatJouable(webhookUrl, jour, phase = APRES_MIDI) {
  const state = await readState();
  if (
    !state ||
    state.termine ||
    state.phase !== phase ||
    String(state.jour) !== String(jour)
  ) {
    await patchOriginal(
      webhookUrl,
      messageSeul(
        phase === MATIN && state?.phase === APRES_MIDI && String(state.jour) === String(jour)
          ? "Le Vrai/Faux du matin est terminé : les ponts sont ouverts, regarde le nouveau message !"
          : "La journée a changé, regarde le nouveau message !",
      ),
    );
    return null;
  }
  if (phase === APRES_MIDI && !jourOuvert(state.publishedAt)) {
    await patchOriginal(
      webhookUrl,
      messageSeul(
        `Les ponts sont fermés depuis minuit : le troll compte les joueurs, résultat vers ${horaires().matin}h30.`,
      ),
    );
    return null;
  }
  return state;
}

// Compteur de passants du message public (pied du dernier embed)
async function majCompteur(state) {
  if (!state.embeds?.length || !state.messageId) return;
  const n = await compterPassants(state.jour);
  const embeds = state.embeds.map((e, i) =>
    i === state.embeds.length - 1 ? { ...e, footer: footerJour(n) } : e,
  );
  try {
    const res = await discordFetch(
      `/channels/${state.channelId}/messages/${state.messageId}`,
      {
        method: "PATCH",
        body: JSON.stringify(versV2(embeds, state.components ?? [])),
      },
    );
    if (!res.ok)
      console.warn(`[Pont] Échec mise à jour du compteur (${res.status}).`);
  } catch (err) {
    console.warn(
      "[Pont] Erreur réseau à la mise à jour du compteur:",
      err.message,
    );
  }
}

// Position du joueur au classement (jours déjà résolus), pour la
// confirmation éphémère : « 📊 Tu es 12e : 6,4 pièces, 3 passages. ».
// Rien tant qu'il n'est pas classé (Jour 1, nouveau joueur).
export async function maPosition(discordId) {
  const ranking = buildRanking(await readPoints(), await readPasses());
  const i = ranking.findIndex((r) => r.discordId === discordId);
  if (i === -1) return null;
  const rang = rangExAequo(ranking, i, memeRang);
  const r = ranking[i];
  return `📊 Tu es ${rang === 1 ? "1er" : `${rang}e`} : ${pieces(r.centiemes)}, ${pluriel(r.passes, "passage")}.`;
}

export async function handleTraverser(
  webhookUrl,
  jour,
  cote,
  discordId,
  username,
  avatar,
) {
  try {
    const state = await etatJouable(webhookUrl, jour);
    if (!state) return;
    const r = await enregistrerChoix(jour, discordId, cote, {
      username,
      avatar,
    });
    if (!r.ok) {
      await patchOriginal(
        webhookUrl,
        messageSeul(
          [
            `${EMOJI[r.cote] ?? ""} Tu as déjà traversé ${PAR[r.cote] ?? ""} aujourd'hui, ton choix est définitif.`,
            await maPosition(discordId),
          ].filter(Boolean).join("\n"),
        ),
      );
      return;
    }
    const avecPiece = (await readVraiFaux(jour, discordId))?.correct
      ? " avec ta pièce du matin 🪙"
      : "";
    await patchOriginal(
      webhookUrl,
      messageSeul(
        [`${EMOJI[cote]} Tu traverses ${PAR[cote]}${avecPiece}. Résultat demain matin !`, await maPosition(discordId)]
          .filter(Boolean)
          .join("\n"),
      ),
    );
    await majCompteur(state);
  } catch (err) {
    console.error("[Pont] Échec Traverser:", err.message);
  }
}

// ── Vrai/Faux du matin ────────────────────────────────────────────

// Réponse définitive, corrigée tout de suite (`reponse` : booléen)
export async function handleVraiFaux(webhookUrl, jour, reponse, discordId, username) {
  try {
    const state = await etatJouable(webhookUrl, jour, MATIN);
    if (!state) return;
    const question = questionDuJour(await loadVraiFaux(), state.vfPartie, jour);
    if (!question) return;
    const r = await repondreVraiFaux(jour, discordId, reponse, question, { username });
    const verdict = r.correct
      ? "✅ Bonne réponse ! Tu gagnes 🪙 1 pièce bonus à emporter au marché."
      : `❌ Raté, c'était ${question.reponse ? "vrai" : "faux"}.`;
    const lignes = [r.ok ? verdict : `Tu as déjà répondu ce matin. ${verdict}`];
    if (question.explication) lignes.push(question.explication);
    await patchOriginal(webhookUrl, messageSeul(lignes.join("\n")));
  } catch (err) {
    console.error("[Pont] Échec Vrai/Faux:", err.message);
  }
}

// ── Rumeurs (jours impairs) ───────────────────────────────────────

// « A, B, C et D »
function listeNoms(noms) {
  return noms.length < 2 ? noms.join("") : `${noms.slice(0, -1).join(", ")} et ${noms.at(-1)}`;
}

const LIBELLE_RUMEUR = {
  [VERITE]: "vérité (tu annonces ton pont)",
  [MENSONGE]: "mensonge (tu annonces l'autre pont)",
  [RIEN]: "aucune annonce",
};

function menuRumeur(jour) {
  return [
    {
      type: 1,
      components: [
        {
          type: 3,
          custom_id: `pont_rumeur:${jour}`,
          placeholder: "Lancer une rumeur…",
          options: [
            { label: "Vérité", value: VERITE, description: "J'annonce le pont que je choisis aujourd'hui", emoji: { name: "✅" } },
            { label: "Mensonge", value: MENSONGE, description: "J'annonce l'autre pont", emoji: { name: "🤥" } },
            { label: "Rien", value: RIEN, description: "Je n'annonce rien du tout", emoji: { name: "🤐" } },
          ],
        },
      ],
    },
  ];
}

// Vue éphémère : rumeurs du jour (pont annoncé, d'après le pont réellement
// choisi), menteurs des rumeurs précédentes, puis menu ou rumeur lancée.
async function vueRumeurs(config, jour, discordId) {
  const [choix, rumeurs, usernames, maRumeur, monChoix] = await Promise.all([
    listChoix(jour),
    listRumeurs(jour),
    readUsernames(),
    readRumeur(jour, discordId),
    readChoix(jour, discordId),
  ]);
  const estVerite = (j) => jourConfig(config, j).evenement === JOUR_DE_VERITE;
  const annonces = rumeursAnnoncees(choix, rumeurs, { verite: estVerite(jour) });
  const lignes = ["🗣️ **Selon les rumeurs du jour :**"];
  if (!annonces[PIERRE].length && !annonces[CORDES].length) {
    lignes.push("- Aucune rumeur pour l'instant.");
  } else {
    for (const cote of [PIERRE, CORDES]) {
      const ids = annonces[cote];
      if (!ids.length) {
        lignes.push(`- Personne n'annonce le pont de ${NOM_COURT[cote].toLowerCase()}`);
        continue;
      }
      const noms = await nommer(ids, usernames);
      lignes.push(
        `- ${pluriel(ids.length, "joueur")} ${ids.length > 1 ? "ont" : "a"} pris le pont de ${NOM_COURT[cote].toLowerCase()} : ${listeNoms(noms)}`,
      );
    }
  }

  const precedent = rumeursPrecedentes(config, jour);
  if (precedent != null) {
    const ids = menteurs(await listChoix(precedent), await listRumeurs(precedent), { verite: estVerite(precedent) });
    lignes.push("", `🤥 **Détecteur de fake-news (Jour ${precedent}) :**`);
    lignes.push(
      ids.length
        ? `- ${pluriel(ids.length, "joueur")} ${ids.length > 1 ? "ont" : "a"} menti : ${listeNoms(await nommer(ids, usernames))}`
        : "- Personne n'a menti.",
    );
  }

  lignes.push("");
  if (!maRumeur) {
    lignes.push("📣 **Lance une rumeur si tu le souhaites !**");
    return { content: lignes.join("\n"), embeds: [], components: menuRumeur(jour) };
  }
  lignes.push(
    maRumeur === MENSONGE && estVerite(jour)
      ? "📣 Ta rumeur du jour : mensonge… mais c'est le Jour de vérité, tu annonces ton vrai pont !"
      : `📣 Ta rumeur du jour : ${LIBELLE_RUMEUR[maRumeur]}.`,
  );
  if (maRumeur !== RIEN && !monChoix) lignes.push("Elle apparaîtra dès que tu auras choisi ton pont.");
  return { content: lignes.join("\n"), embeds: [], components: [] };
}

export async function handleRumeurs(webhookUrl, jour, discordId) {
  try {
    const state = await etatJouable(webhookUrl, jour);
    if (!state) return;
    const config = await loadPontConfig();
    if (!rumeursDisponibles(config, jour)) {
      await patchOriginal(webhookUrl, messageSeul("🗣️ Pas de rumeurs aujourd'hui (jours impairs seulement)."));
      return;
    }
    await patchOriginal(webhookUrl, await vueRumeurs(config, jour, discordId));
  } catch (err) {
    console.error("[Pont] Échec Rumeurs:", err.message);
  }
}

// Choix dans le menu (édition en place de l'éphémère), définitif
export async function handleRumeurChoix(webhookUrl, jour, discordId, mode) {
  try {
    const state = await etatJouable(webhookUrl, jour);
    if (!state) return;
    const config = await loadPontConfig();
    if (!rumeursDisponibles(config, jour)) return;
    await lancerRumeur(jour, discordId, mode);
    await patchOriginal(webhookUrl, await vueRumeurs(config, jour, discordId));
  } catch (err) {
    console.error("[Pont] Échec choix de rumeur:", err.message);
  }
}

export async function handleIndice(webhookUrl, jour, discordId) {
  try {
    const state = await etatJouable(webhookUrl, jour);
    if (!state) return;
    const config = await loadPontConfig();
    if (!indiceDisponible(config, jour)) {
      await patchOriginal(
        webhookUrl,
        messageSeul("🔎 Pas d'indice aujourd'hui (jours pairs seulement)."),
      );
      return;
    }
    const { nouveau, texte } = await consulterIndice(jour, discordId);
    await patchOriginal(
      webhookUrl,
      messageSeul(
        nouveau
          ? `🔎 ${texte}`
          : `🔎 Tu as déjà consulté l'indice aujourd'hui : ${texte}`,
      ),
    );
  } catch (err) {
    console.error("[Pont] Échec Indice:", err.message);
  }
}

function buildReglesEmbed(config) {
  const h = horaires();
  return {
    title: "📖 Règles du Pont du Troll",
    description: [
      `De l'autre côté du ravin, le village tient son grand marché pendant ${config.duree_jours} jours. Chaque jour :`,
      `☀️ **Le matin (${h.matin}h-${h.ponts}h)** : réponds à la question Vrai ou Faux. Bonne réponse = 🪙 1 pièce bonus à emporter au marché.`,
      `🌉 **L'après-midi (${h.ponts}h-minuit)** : traverse par l'un des deux ponts. Un seul clic, secret et définitif.`,
      "",
      "🧌 **Le troll** attrape le pont qui compte le plus de joueurs : chacun lâche 1 pièce, et sa pièce du matin s'il l'a. Les joueurs de l'autre pont ramassent ce butin et se le partagent, multiplié par la prime du village (le multiplicateur de leur pont).",
      "Égalité : le troll se rendort, personne n'est attrapé, et chacun touche la prime de son pont.",
      "",
      "🗣️ **Rumeurs** (jours impairs) : vois quel pont chacun annonce, et lance ta propre rumeur une fois par jour (vérité, mensonge ou rien), avant ou après avoir choisi ton pont. Le détecteur de fake-news dévoile les menteurs des rumeurs précédentes.",
      "",
      `🔎 **Indice** (jours pairs, une fois par jour) : la répartition du moment, exacte jusqu'à ${h.indiceExact}h, de plus en plus floue ensuite. Une fois ton pont choisi, il ne te sert plus à rien !`,
      "",
      "**Trois jours spéciaux** : 🍖 Troll repu au Jour 3 (il attrape le pont le moins chargé), 📢 Jour de vérité au Jour 5 (toutes les rumeurs sont vraies, mensonges compris) et 🎉 Fête du village au Jour 7 (primes doublées).",
      "",
      "Classement : pièces cumulées, puis nombre de jours passés sans être attrapé.",
    ].join("\n"),
    color: PONT_COLOR,
  };
}

export async function handleRegles(webhookUrl) {
  try {
    await patchOriginal(webhookUrl, {
      embeds: [buildReglesEmbed(await loadPontConfig())],
      components: [],
    });
  } catch (err) {
    console.error("[Pont] Échec Règles:", err.message);
  }
}
