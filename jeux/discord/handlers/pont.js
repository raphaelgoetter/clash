// ============================================================
// pont.js — Handlers Discord du Pont du Troll (jeu spécial de 7 jours).
// Publication quotidienne (postPont, appelée uniquement par
// jeux/scripts/postPont.js), boutons du message public (Pont de pierre,
// Pont de cordes, Rumeurs ou Indice, Règles) et menu des rumeurs.
// Règles : jeux/CONTRIBUTING.md, section « Pont du Troll ».
// ============================================================

import {
  PIERRE,
  CORDES,
  REPU,
  FINALE,
  loadPontConfig,
  jourConfig,
  indiceDisponible,
  rumeursDisponibles,
  rumeursPrecedentes,
  readState,
  writeState,
  isTooSoonSinceLastClosure,
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
  estPnj,
} from "../../services/pont.js";
import {
  getRoleIdByName,
  MINI_JEUX_ROLE_NAME,
} from "@clash/commun/discordRoles.js";
import { resolveDisplayName } from "@clash/commun/discordUsers.js";
import { rangExAequo } from "@clash/commun/classement.js";

const PONT_COLOR = 0x6b8f3a;
const TRUST_ROYALE_URL = "https://trustroyale.vercel.app";
// À incrémenter après remplacement de l'illustration d'annonce (cache Discord)
const ILLUSTRATION_VERSION = 1;
export const PONT_ILLUSTRATION_URL = `${TRUST_ROYALE_URL}/api/pont/illustration?v=${ILLUSTRATION_VERSION}`;

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
  `${TRUST_ROYALE_URL}/api/pont/matin?jour=${jour}&v=${v}`;
const urlResultat = (partieId, jour, v) =>
  `${TRUST_ROYALE_URL}/api/pont/resultat?partie=${encodeURIComponent(partieId)}&jour=${jour}&v=${v}`;

// ── Embeds ────────────────────────────────────────────────────────

function buildAnnonceEmbed(config) {
  return {
    title: "🧌 Pont du Troll : le troll s'installe demain",
    description: [
      `De l'autre côté du ravin, le village tient son grand marché pendant **${config.duree_jours} jours**. Chaque jour, traverse pour aller y faire fortune, par le pont de pierre ou le pont de cordes, en secret.`,
      "",
      "Mais un troll vit sous les ponts. Il attrape le plus chargé : chaque joueur attrapé lâche une pièce, que ceux de l'autre pont ramassent… multipliée par la prime du village affichée à l'entrée de leur pont.",
      "",
      "Plus d'infos ? Clique sur *Règles* ci-dessous.",
    ].join("\n"),
    color: PONT_COLOR,
    image: { url: PONT_ILLUSTRATION_URL },
    footer: { text: "La partie commence demain matin." },
  };
}

const footerJour = (n) => ({
  text: `🚶 ${pluriel(n, "joueur")} aujourd'hui · Choix secret et définitif, décompte à 8h`,
});

function buildJourEmbed(config, cfg, { estPremierJour, v }) {
  const lines = [];
  if (estPremierJour)
    lines.push(
      "**Le troll s'est installé sous les ponts !** Choisis ton pont, en secret. Résultat demain matin.",
      "",
    );
  lines.push(
    // Titre ### : plus grand que le texte (multiplicateurs du jour)
    `### ${EMOJI[PIERRE]} Pont de pierre : ×${cfg.pierre} · ${EMOJI[CORDES]} Pont de cordes : ×${cfg.cordes}`,
  );
  // La règle elle-même est dans les Règles : seul l'événement est rappelé
  if (cfg.evenement === REPU)
    lines.push("", "🍖 **Troll repu** : aujourd'hui, il attrape le pont **le moins** chargé !");
  if (cfg.evenement === FINALE)
    lines.push("", "🏆 **Grande finale** : gains doublés !");
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

async function lignesClassement(ranking, limite) {
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
  return liste.map(
    (r, i, l) =>
      `${rangExAequo(l, i, memeRang)}\\. ${r.nom} (${pieces(r.centiemes)})`,
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
      lines.push(entry.attrape ? "🧌 Le troll n'attrape personne." : "🧌 Égalité : le troll hésite, personne n'est attrapé.");
      const g = entry.gainParCote ?? {};
      lines.push(
        `💰 Tout le monde passe : Pierre **+${pieces(g[PIERRE] ?? 0)}**, Cordes **+${pieces(g[CORDES] ?? 0)}** par joueur.`,
      );
    } else {
      lines.push(
        `🧌 Le troll attrape **${pluriel(nA, "joueur")}** ${SUR[entry.attrape]}.`,
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

const blocJour = (config, jour, resultat, jourEmbed) =>
  unSeulBloc(`🧌 Pont du Troll (Jour ${jour}/${config.duree_jours})`, resultat, jourEmbed, { intituleSuite: `🌉 Aujourd'hui · Jour ${jour}/${config.duree_jours}` });

const blocFin = (resultat, finalEmbed) => unSeulBloc("🏁 Pont du Troll : fin de partie", resultat, finalEmbed);

// ── Boutons ───────────────────────────────────────────────────────

const boutonRegles = {
  type: 2,
  style: 2,
  label: "Règles",
  emoji: { name: "📖" },
  custom_id: "pont_regles",
};

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

// Messages en Components V2 : Discord limite la hauteur d'une image d'embed
// (~300 px sur ordinateur), une galerie (type 12) l'affiche bien plus grande.
// Les vues sont écrites comme des embeds, converties ici à l'envoi : un
// conteneur à liseré par embed (titre ###, texte, galerie, texte `apres`
// sous l'image, pied en petit),
// boutons dans le dernier conteneur. ⚠️ Ni `content` ni `embeds` en V2 : le
// ping éventuel est un bloc texte en tête, avec `allowed_mentions`.
const IS_COMPONENTS_V2 = 1 << 15;
const TEXTE_MAX = 4000;

export function versV2(embeds, components = [], roleId = null) {
  const blocs = [];
  if (roleId) blocs.push({ type: 10, content: `<@&${roleId}>` });
  embeds.forEach((embed, i) => {
    const texte = [embed.title ? `### ${embed.title}` : null, embed.description].filter(Boolean).join("\n");
    blocs.push({
      type: 17,
      accent_color: embed.color ?? PONT_COLOR,
      components: [
        { type: 10, content: texte.slice(0, TEXTE_MAX) },
        ...(embed.image?.url ? [{ type: 12, items: [{ media: { url: embed.image.url } }] }] : []),
        ...(embed.apres ? [{ type: 10, content: embed.apres.slice(0, TEXTE_MAX) }] : []),
        ...(embed.footer?.text ? [{ type: 10, content: `-# ${embed.footer.text}` }] : []),
        ...(i === embeds.length - 1 ? components : []),
      ],
    });
  });
  return {
    flags: IS_COMPONENTS_V2,
    components: blocs,
    ...(roleId ? { allowed_mentions: { parse: [], roles: [roleId] } } : {}),
  };
}

async function publishAndWriteState(
  channelId,
  previousState,
  { phase = "jour", jour, partieId, embeds, components, ping, termine = false },
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
  const res = resoudreJour(await listChoix(state.jour), cfg);
  const entry = entreeHistorique(state.jour, cfg, res, await listRumeurs(state.jour));
  const ranking = classementProjete(
    await readPoints(),
    await readPasses(),
    res.resultats,
  );
  return { cfg, res, entry, ranking };
}

// `pnj` : 5 joueurs fictifs traversent chaque jour (jamais sur le salon
// public). ⚠️ Ping seulement si `isPublic` et sans `noPing` : jamais de
// ping sur le salon de test, quel que soit l'appelant.
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
  const ping = isPublic && !noPing;
  const avecPnj = pnj && !isPublic;
  const state = await readState();

  if (state?.termine) return { termine: true };
  if (
    state &&
    !dryRun &&
    !force &&
    isTooSoonSinceLastClosure(state.publishedAt)
  ) {
    return {
      skipped: true,
      reason: "tooSoonSinceLastClosure",
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

  // 2) Annonce -> Jour 1 : remise à zéro de la partie, avec ping
  if (state.phase === "annonce") {
    const cfg = jourConfig(config, 1);
    const embeds = [buildJourEmbed(config, cfg, { estPremierJour: true, v })];
    const components = buildJourComponents(config, 1);
    if (dryRun)
      return { dryRun: true, phase: "jour", jour: 1, embeds, components };
    await resetPartie();
    const out = await publishAndWriteState(channelId, state, {
      jour: 1,
      partieId: state.partieId,
      embeds,
      components,
      ping,
    });
    if (avecPnj) await faireJouerPnj(config, 1);
    return out;
  }

  // 3) Résolution du jour actif, puis jour suivant ou classement final
  const { res, entry, ranking } = await projeterJour(state, config);
  const jourSuivant = state.jour + 1;
  const estFin = jourSuivant > config.duree_jours;
  const manches = estFin ? await listManches({ limit: 10 }) : [];
  const resultatEmbed = await buildResultatEmbed(
    entry,
    estFin ? null : ranking,
    { partieId: state.partieId, v },
  );

  if (dryRun) {
    const embeds = estFin
      ? [blocFin(resultatEmbed, await buildFinalEmbed(ranking, manches))]
      : [
          blocJour(
            config,
            jourSuivant,
            resultatEmbed,
            buildJourEmbed(config, jourConfig(config, jourSuivant), { estPremierJour: false, v }),
          ),
        ];
    return {
      dryRun: true,
      final: estFin,
      jour: estFin ? state.jour : jourSuivant,
      embeds,
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
    const embeds = [blocFin(resultatEmbed, await buildFinalEmbed(finalRanking, manches))];
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

  const embeds = [
    blocJour(
      config,
      jourSuivant,
      resultatEmbed,
      buildJourEmbed(config, jourConfig(config, jourSuivant), { estPremierJour: false, v }),
    ),
  ];
  const out = await publishAndWriteState(channelId, state, {
    jour: jourSuivant,
    partieId: state.partieId,
    embeds,
    components: buildJourComponents(config, jourSuivant),
    ping: false,
  });
  if (avecPnj) await faireJouerPnj(config, jourSuivant);
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

// Jour cliquable : renvoie l'état, ou null après avoir répondu au joueur
async function etatJouable(webhookUrl, jour) {
  const state = await readState();
  if (
    !state ||
    state.termine ||
    state.phase === "annonce" ||
    String(state.jour) !== String(jour)
  ) {
    await patchOriginal(
      webhookUrl,
      messageSeul("La journée a changé, regarde le nouveau message !"),
    );
    return null;
  }
  if (!jourOuvert(state.publishedAt)) {
    await patchOriginal(
      webhookUrl,
      messageSeul(
        "Le troll compte les joueurs (décompte à 8h), le jour suivant arrive vers 8h30.",
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
          `${EMOJI[r.cote] ?? ""} Tu as déjà traversé ${PAR[r.cote] ?? ""} aujourd'hui, ton choix est définitif.`,
        ),
      );
      return;
    }
    await patchOriginal(
      webhookUrl,
      messageSeul(
        `${EMOJI[cote]} Tu traverses ${PAR[cote]}. Résultat demain matin !`,
      ),
    );
    await majCompteur(state);
  } catch (err) {
    console.error("[Pont] Échec Traverser:", err.message);
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
  const annonces = rumeursAnnoncees(choix, rumeurs);
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
    const ids = menteurs(await listChoix(precedent), await listRumeurs(precedent));
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
  lignes.push(`📣 Ta rumeur du jour : ${LIBELLE_RUMEUR[maRumeur]}.`);
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
  return {
    title: "📖 Règles du Pont du Troll",
    description: [
      `De l'autre côté du ravin, le village tient son grand marché. Chaque jour pendant ${config.duree_jours} jours, traverse par l'un des deux ponts pour aller y faire fortune. Un seul clic par jour, secret et définitif (jour de jeu de 8h à 8h).`,
      "",
      "🧌 **Le troll** attrape le pont qui compte le plus de joueurs : chacun lâche 1 pièce. Les joueurs de l'autre pont ramassent ce butin et se le partagent, multiplié par la prime du village (le multiplicateur de leur pont, affiché chaque matin).",
      "Égalité : le troll hésite, personne n'est attrapé, et chacun touche la prime de son pont.",
      "",
      "🗣️ **Rumeurs** (jours impairs) : vois quel pont chacun annonce, et lance ta propre rumeur une fois par jour (vérité, mensonge ou rien), avant ou après avoir choisi ton pont. Le détecteur de fake-news dévoile les menteurs des rumeurs précédentes.",
      "",
      "🔎 **Indice** (jours pairs, une fois par jour) : la répartition du moment, exacte le matin, de plus en plus floue au fil de la journée. Une fois ton pont choisi, il ne te sert plus à rien !",
      "",
      "**Deux jours spéciaux** : 🍖 Troll repu au Jour 3 (il attrape le pont le moins chargé) et 🏆 Grande finale au Jour 7 (gains doublés).",
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
