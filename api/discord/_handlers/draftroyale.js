// ============================================================
// draftroyale.js — Handlers Discord du Draft Royale (carré de 4 cartes
// identiques, 7 jours). Embeds, bouton Jouer (main éphémère avec le marché
// et les deux menus de l'échange), Règles. La publication/clôture
// quotidienne passe uniquement par scripts/postDraftRoyale.js
// (postDraftRoyale) — les boutons/selects restent gérés par
// api/discord/interactions.js.
//
// Même modèle que Mario Clash : participation libre (main reçue au premier
// clic), échanges modifiables jusqu'à la clôture, où ils sont résolus tous
// ensemble (voir backend/services/draftroyale.js et draftRules.js).
//
// ⚠️ Les mains restent secrètes : seul l'éphémère montre au joueur sa
// propre main ; le message public affiche le marché, les carrés réalisés
// et le classement.
// ============================================================

import {
  loadDraftRoyaleConfig,
  loadCatalog,
  readState,
  writeState,
  readJoueurs,
  ensureJoueur,
  readAction,
  readPartie,
  initPartie,
  enregistrerChoix,
  enregistrerJoker,
  voirMainJoueur,
  previewCloture,
  closeDayAndAdvance,
  getHistoriqueEntry,
  archiveManche,
  listManches,
  isTooSoonSinceLastClosure,
} from "../../../backend/services/draftroyale.js";
import { compterCartes, trierMain } from "../../../backend/services/draftRules.js";
import { JOKER_EMOJI, ecartLigne, quadruplesEmbed, vedetteLigne, echangeLigne, tourStatutLignes, annulerEchangeButton, jokerRows, jokerPointsLabel, voirLigne, jokerBilanLignes } from "./draftJoker.js";
import { getRoleIdByName, buildRolePingFields, MINI_JEUX_ROLE_NAME } from "../../../backend/services/discordRoles.js";
import { formatUtcTimeAsParis } from "../../../backend/services/dateUtils.js";

const DRAFT_COLOR = 0x2f5bd3;
const TRUST_ROYALE_URL = "https://trustroyale.vercel.app";
const TRADE_TEXT = "<:trade:1493849418611294279>";

// Marché figé au moment de l'affichage (éphémère) : rendu sans état.
function marcheKeysImageUrl(keys) {
  if (!keys?.length) return null;
  return `${TRUST_ROYALE_URL}/api/draft/marche?${new URLSearchParams({ c: keys.join("|") })}`;
}

function illustrationUrl() {
  return `${TRUST_ROYALE_URL}/api/draftroyale/illustration?v=${Date.now()}`;
}

function mainImageUrl(keys) {
  if (!keys?.length) return null;
  return `${TRUST_ROYALE_URL}/api/draftroyale/main?${new URLSearchParams({ c: keys.join("|") })}`;
}

// ── Mise en forme des cartes ────────────────────────────────────────

function cardName(key, catalog) {
  return catalog.get(key)?.fr || key;
}

// « Princesse ×2 · Géant ×1 », les plus gros groupes d'abord.
function formatGroupes(keys, catalog) {
  const groupes = [...compterCartes(keys)].sort((a, b) => b[1] - a[1] || cardName(a[0], catalog).localeCompare(cardName(b[0], catalog)));
  return groupes.map(([k, n]) => `${cardName(k, catalog)} ×${n}`).join(" · ");
}

function groupOptions(keys, catalog, suffixe, selected, vedettes = []) {
  return [...compterCartes(keys)]
    .sort((a, b) => cardName(a[0], catalog).localeCompare(cardName(b[0], catalog)))
    .slice(0, 25)
    .map(([k, n]) => ({
      label: `${vedettes.includes(k) ? "⭐ " : ""}${cardName(k, catalog)}`.slice(0, 100),
      description: `×${n} ${suffixe}`,
      value: k,
      default: k === selected || undefined,
    }));
}

function plural(n, mot) {
  return `${n} ${mot}${n > 1 ? "s" : ""}`;
}

const MEDALS = ["🥇", "🥈", "🥉"];

// ── Embeds ───────────────────────────────────────────────────────────

function buildAnnonceEmbed(config) {
  return {
    title: "🃏 Draft Royale — Les cartes sont mélangées…",
    description: [
      `Pendant ${config.duree_jours} jours, échange des cartes au marché pour réunir **${config.taille_main} exemplaires d'une même carte** !`,
      "",
      `📅 **${config.duree_jours} jours de draft**, à partir de demain. Chaque jour, ${TRADE_TEXT} prends une carte du marché et dépose une carte de ta main.`,
      "",
      "Plus d'infos ? Clique sur *Règles* ci-dessous.",
    ].join("\n"),
    color: DRAFT_COLOR,
    image: { url: illustrationUrl() },
    footer: { text: `Le draft commence demain à ${formatUtcTimeAsParis(8)}.` },
  };
}

function classementLignes(joueurs, limit = 10) {
  const top = Object.values(joueurs)
    .filter((j) => (j.points || 0) > 0 || (j.joker || 0) > 0)
    .sort((a, b) => b.points - a.points || (b.carres || 0) - (a.carres || 0) || a.username.localeCompare(b.username))
    .slice(0, limit);
  if (!top.length) return [];
  return ["", "**🏆 Classement**", ...top.map((j, i) => `${MEDALS[i] || `${i + 1}.`} ${j.username} (${plural(j.points || 0, "pt")}, ${jokerPointsLabel(j.joker || 0)}${j.carres ? `, ${plural(j.carres, "quadruplé")}` : ""})`)];
}

// Message du jour : infos générales uniquement (la journée en cours, le
// marché et le bilan de la veille sont dans l'éphémère Jouer).
function buildResumeLignes(jour, config, joueurs) {
  const nb = Object.keys(joueurs).length;
  const lignes = [
    `${TRADE_TEXT} Réunis ${config.taille_main} cartes identiques ! Clique sur **Jouer** pour voir ta main, le marché et les échanges de la veille.`,
  ];
  if (jour === 1) lignes.push(`Tu reçois tes ${config.taille_main} cartes à ton premier clic.`);
  if (nb) lignes.push(`👥 ${plural(nb, "joueur")} dans la partie.`);
  if (jour === config.duree_jours) lignes.push("🏁 **Dernier jour** : à la clôture, chacun marque 1 à 3 pts selon ses cartes identiques.");
  lignes.push(...classementLignes(joueurs));
  return lignes;
}

function buildJourEmbed(jour, config, resumeLignes) {
  return {
    title: `🃏 Draft Royale — Jour ${jour}/${config.duree_jours}`,
    description: resumeLignes.join("\n").slice(0, 4096),
    color: DRAFT_COLOR,
    image: { url: illustrationUrl() },
    footer: { text: `Échange modifiable jusqu'à ${formatUtcTimeAsParis(8)} demain.` },
  };
}

function formatMancheLine(record, isCurrent, isBest) {
  const marker = isBest ? "🏆 " : "";
  const suffix = isCurrent ? " *(cette manche)*" : "";
  return `${marker}Manche ${record.manche} : vainqueur **${record.vainqueur}** (${record.scoreGagnant} pts)${suffix}`;
}

function buildManchesSection(manches, currentManche) {
  if (!manches.length) return [];
  const best = manches.reduce((a, b) => (b.scoreGagnant > a.scoreGagnant ? b : a));
  return ["", "**📊 Manches précédentes**", ...manches.map((m) => formatMancheLine(m, m.manche === currentManche, m.manche === best.manche))];
}

function buildFinEmbed(ranking, config, manches, currentManche, derniers = []) {
  // Classement déjà départagé (carrés, puis ordre d'arrivée) : un seul vainqueur
  const top = ranking[0];
  const titre = top ? `**${top.username}** l'emporte avec **${top.score} pts** !` : "Personne n'a participé.";
  return {
    title: "🏆 Draft Royale — Draft terminé !",
    description: [
      `Après ${config.duree_jours} jours de draft, ${titre}`,
      "",
      "**Classement final**",
      ...ranking.slice(0, 10).map((r, i) => `${MEDALS[i] || `${i + 1}.`} **${r.username}** (${plural(r.score, "pt")}${r.joker ? ` dont ${r.joker} Joker` : ""}${r.carres ? `, ${plural(r.carres, "quadruplé")}` : ""})`),
      ...(derniers.length ? ["", `🏁 Dernier quadruplé : ${derniers.map((n) => `**${n}**`).join(", ")} (+${config.bonus_dernier_quadruple} pts)`] : []),
      ...buildManchesSection(manches, currentManche),
    ]
      .join("\n")
      .slice(0, 4096),
    color: 0xf1c40f,
    image: { url: illustrationUrl() },
  };
}

function buildReglesEmbed(config) {
  return {
    title: "📖 Règles — Draft Royale",
    description: [
      `Réunis **${config.taille_main} cartes identiques** (un quadruplé) !`,
      "",
      `**Chaque jour** : ${TRADE_TEXT} prends une carte au marché et dépose une carte de ta main, utilise une action ${JOKER_EMOJI} Joker, ou les deux.`,
      `**Carte disputée** : elle va au joueur qui a le plus de points Joker. Les autres gardent leur carte (+${config.joker.gain_perte} pts Joker).`,
      `**Quadruplé** : ${config.points_rarete.common} à ${config.points_rarete.legendary} pts selon la rareté (+${config.bonus_vedette} pour une ⭐ carte vedette). Tu reçois ensuite une nouvelle main.`,
      "",
      `**${JOKER_EMOJI} Points Joker** : +${config.joker.gain_tour} par jour joué.`,
      `• **Priorité** (${config.joker.couts.priorite} pt) : servi en premier si ta carte est disputée`,
      `• **Geler** une carte (${config.joker.couts.geler} pts) : personne ne peut la prendre ce jour-là, même toi`,
      `• **Puiser** une carte à l'écart (${config.joker.couts.puiser} pts) : ta carte déposée part à l'écart à sa place`,
      `• **Espionner** (${config.joker.couts.espionner} pt) : vois tout de suite la main d'un joueur`,
      "",
      `**Fin** (J${config.duree_jours}) : chacun marque 1 à 3 pts selon ses cartes identiques, plus ses points Joker restants. Le dernier quadruplé de la partie rapporte +${config.bonus_dernier_quadruple} pts.`,
    ].join("\n"),
    color: DRAFT_COLOR,
  };
}

// ── Composants ───────────────────────────────────────────────────────

function reglesButton() {
  return { type: 2, style: 2, label: "Règles", emoji: { name: "📖" }, custom_id: "draftroyale_regles" };
}

function buildJourComponents(jour) {
  return [
    {
      type: 1,
      components: [{ type: 2, style: 3, label: "Jouer", emoji: { name: "🃏" }, custom_id: `draftroyale_jouer:${jour}` }, reglesButton()],
    },
  ];
}

// ── Publication quotidienne (appelée uniquement par scripts/postDraftRoyale.js) ──

export async function postDraftRoyale(channelId, { dryRun = false, noPing = false, isPublic = false, requireActiveState = false, force = false } = {}) {
  const [config, catalog] = await Promise.all([loadDraftRoyaleConfig(), loadCatalog()]);
  const state = await readState();

  if (state?.termine) return { termine: true };
  if (state && !dryRun && !force && isTooSoonSinceLastClosure(state.publishedAt)) {
    return { skipped: true, reason: "tooSoonSinceLastClosure", publishedAt: state.publishedAt };
  }
  if (state && state.channelId !== channelId) return { wrongChannel: true, activeChannelId: state.channelId };
  if (!state && requireActiveState) return { skipped: true };

  // 1) Aucun état → jour de présentation
  if (!state) {
    const embed = buildAnnonceEmbed(config);
    const components = [{ type: 1, components: [reglesButton()] }];
    if (dryRun) return { dryRun: true, phase: "annonce", embed, components };
    return publishAndWriteState(channelId, null, { phase: "annonce", jour: null, embed, components, noPing, estAnnonce: true });
  }

  // 2) Présentation → Jour 1 : les cartes entrent en jeu, rien à clôturer
  if (state.phase === "annonce") {
    const embed = buildJourEmbed(1, config, buildResumeLignes(1, config, {}));
    const components = buildJourComponents(1);
    if (dryRun) return { dryRun: true, phase: "jour", jour: 1, embed, components };
    await initPartie();
    return publishAndWriteState(channelId, state, { phase: "jour", jour: 1, embed, components, noPing: true, estAnnonce: false });
  }

  // 3) Clôture d'un jour de draft (lecture seule en dry-run)
  const closure = dryRun ? await previewCloture(state.jour) : await closeDayAndAdvance(state.jour);

  if (closure.termine) {
    let currentManche = null;
    const ranking = closure.final;
    if (!dryRun && isPublic && ranking.length) {
      currentManche = await archiveManche({
        vainqueur: ranking[0].username,
        scoreGagnant: ranking[0].score,
        ranking: ranking.map((r) => ({ discordId: r.discordId, username: r.username, score: r.score })),
        resolvedAt: new Date().toISOString(),
      });
    }
    const manches = await listManches({ limit: 10 });
    const derniers = closure.scores.filter((s) => s.dernierQuadruple).map((s) => closure.joueursApres[s.discordId]?.username || "?");
    const embed = buildFinEmbed(ranking, config, manches, currentManche, derniers);
    const components = [{ type: 1, components: [reglesButton()] }];
    if (dryRun) return { dryRun: true, final: true, embed, closure };
    const result = await publishAndWriteState(channelId, state, { phase: "jour", jour: state.jour, embed, components, noPing, estAnnonce: false, termine: true });
    return { ...result, final: true };
  }

  const embed = buildJourEmbed(closure.jourSuivant, config, buildResumeLignes(closure.jourSuivant, config, closure.joueursApres));
  const components = buildJourComponents(closure.jourSuivant);
  if (dryRun) return { dryRun: true, jour: closure.jourSuivant, embed, components, closure };
  return publishAndWriteState(channelId, state, { phase: "jour", jour: closure.jourSuivant, embed, components, noPing: true, estAnnonce: false });
}

async function publishAndWriteState(channelId, previousState, { phase, jour, embed, components, noPing, estAnnonce, termine = false }) {
  const token = process.env.DISCORD_TOKEN;
  if (!token) throw new Error("DISCORD_TOKEN manquant.");

  if (previousState?.messageId && previousState?.channelId) {
    try {
      const delRes = await fetch(`https://discord.com/api/v10/channels/${previousState.channelId}/messages/${previousState.messageId}`, {
        method: "DELETE",
        headers: { Authorization: `Bot ${token}` },
      });
      if (!delRes.ok && delRes.status !== 404) {
        console.warn(`[DraftRoyale] Échec suppression du message de la veille (${delRes.status}), publication quand même.`);
      }
    } catch (err) {
      console.warn("[DraftRoyale] Erreur réseau à la suppression du message de la veille:", err.message);
    }
  }

  const roleId = (estAnnonce || termine) && !noPing ? await getRoleIdByName(MINI_JEUX_ROLE_NAME) : null;
  const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ embeds: [embed], components, ...buildRolePingFields(roleId) }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Erreur envoi salon Discord (${res.status}): ${errText}`);
  }
  const message = await res.json();
  await writeState({ phase, jour, channelId, messageId: message.id, publishedAt: new Date().toISOString(), termine });
  return { jour, embed, message, termine };
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
    console.error("[DraftRoyale] Échec PATCH:", err.message);
  }
}

async function guardActiveDay(webhookUrl, jour) {
  const state = await readState();
  if (!state || state.phase !== "jour" || state.termine || String(state.jour) !== String(jour)) {
    await patchOriginal(webhookUrl, { content: "La journée a changé entre-temps, regarde le nouveau message !" });
    return null;
  }
  return state;
}

// Bilan de la clôture de la veille : échanges de chacun (prise et dépôt),
// carrés et décompte.
function bilanVeille(veille, joueurs, discordId, config, catalog) {
  if (!veille) return [];
  const noms = nomsJoueurs(joueurs, discordId);
  const nom = (id) => noms[id];
  const lignes = [];
  for (const l of veille.lignes.filter((x) => x.type === "prise" || x.type === "perdue")) {
    lignes.push(`• ${echangeLigne(l, nom(l.discordId), (k) => cardName(k, catalog), config)}`);
  }
  if (!lignes.length) lignes.push("Aucun échange.");
  lignes.push(...jokerBilanLignes(veille.lignes, discordId, noms, (k) => cardName(k, catalog)));
  // Quadruplés et nouvelles vedettes : encadré à part (quadruplesEmbed)
  const mien = veille.scores?.find((x) => x.discordId === discordId && !x.carre && !x.dernierQuadruple);
  if (mien) lignes.push(`Ton décompte : +${plural(mien.points, "pt")}`);
  return lignes;
}

// Noms des joueurs, « Toi » pour le joueur qui regarde.
function nomsJoueurs(joueurs, discordId) {
  return Object.fromEntries(Object.entries(joueurs).map(([id, j]) => [id, id === discordId ? "Toi" : j.username || "?"]));
}


// Vue éphémère du joueur : main, bilan de la veille, échange prévu,
// marché, et les deux menus de l'échange.
async function buildJeuView(jour, discordId, username, entete = null) {
  const [config, catalog, state] = await Promise.all([loadDraftRoyaleConfig(), loadCatalog(), readState()]);
  const { joueur, nouveau } = await ensureJoueur(discordId, username);
  const [partie, action, joueurs, veille] = await Promise.all([
    readPartie(),
    readAction(jour, discordId),
    readJoueurs(),
    jour > 1 ? getHistoriqueEntry(jour - 1) : null,
  ]);
  const main = trierMain(joueur.main);
  const bilan = bilanVeille(veille, joueurs, discordId, config, catalog);
  const lignes = [
    ...(entete ? [entete, ""] : []),
    ...(nouveau ? [`Bienvenue ! Voici tes ${config.taille_main} cartes.`, ""] : []),
    ...(bilan.length ? ["**Hier**", ...bilan, ""] : []),
    vedetteLigne(partie.vedettes, (k) => cardName(k, catalog)),
    jokerPointsLabel(joueur.joker || 0),
    `**Ta main** : ${formatGroupes(main, catalog)}`,
    "",
    ...tourStatutLignes({
      action,
      id: discordId,
      joueurs,
      marche: partie.marche,
      reserve: partie.reserve,
      config,
      cardName: (k) => cardName(k, catalog),
      trade: TRADE_TEXT,
      suite: "Modifiable jusqu'à la clôture.",
    }),
    voirLigne(action.vu, nomsJoueurs(joueurs, discordId), (keys) => formatGroupes(keys, catalog)),
  ].filter((l) => l !== null);
  const marcheTrie = [...partie.marche].sort();
  const quads = nouveau ? null : quadruplesEmbed(veille, nomsJoueurs(joueurs, discordId), (k) => cardName(k, catalog));
  return {
    embeds: [
      ...(quads ? [quads] : []),
      {
        title: `🃏 Ta main — Jour ${state?.jour ?? jour}/${config.duree_jours}`,
        description: lignes.join("\n").slice(0, 4096),
        color: DRAFT_COLOR,
        image: mainImageUrl(main) ? { url: mainImageUrl(main) } : undefined,
      },
      {
        title: "Marché",
        description: [formatGroupes(marcheTrie, catalog) || "Le marché est vide.", "", ecartLigne(partie.reserve, (keys) => formatGroupes(keys, catalog))].join("\n").slice(0, 4096),
        color: DRAFT_COLOR,
        image: marcheKeysImageUrl(marcheTrie) ? { url: marcheKeysImageUrl(marcheTrie) } : undefined,
      },
    ],
    components: [
      {
        type: 1,
        components: [
          {
            type: 3,
            custom_id: `draftroyale_prise:${jour}`,
            placeholder: "Carte à prendre au marché",
            options: groupOptions(partie.marche, catalog, "au marché", action.prise, partie.vedettes || []),
          },
        ],
      },
      {
        type: 1,
        components: [
          {
            type: 3,
            custom_id: `draftroyale_depot:${jour}`,
            placeholder: "Carte de ta main à déposer",
            options: groupOptions(joueur.main, catalog, "dans ta main", action.depot),
          },
        ],
      },
      ...jokerRows({
        prefixe: "draftroyale",
        tour: jour,
        points: joueur.joker || 0,
        action,
        marche: partie.marche,
        reserve: partie.reserve,
        adversaires: Object.entries(nomsJoueurs(joueurs, discordId))
          .filter(([id]) => id !== discordId)
          .map(([id, nom]) => ({ id, nom }))
          .sort((a, b) => a.nom.localeCompare(b.nom)),
        config,
        cardName: (k) => cardName(k, catalog),
      }),
      { type: 1, components: [annulerEchangeButton("draftroyale", jour, action)] },
    ],
  };
}

// ── Bouton [🃏 Jouer] ────────────────────────────────────────────────

export async function handleJouer(webhookUrl, jour, discordId, username) {
  try {
    if (!(await guardActiveDay(webhookUrl, jour))) return;
    await patchOriginal(webhookUrl, await buildJeuView(Number(jour), discordId, username));
  } catch (err) {
    console.error("[DraftRoyale] Échec Jouer:", err.message);
  }
}

const CHOIX_ERREURS = {
  unavailable: "Cette carte n'est plus au marché.",
  notInHand: "Cette carte n'est plus dans ta main.",
  unknownPlayer: "Joueur introuvable.",
};

// Menus de l'échange : `champ` = "prise", "depot" ou "annuler" (bouton).
export async function handleChoixSelect(webhookUrl, jour, champ, discordId, username, key) {
  try {
    if (!(await guardActiveDay(webhookUrl, jour))) return;
    const result = await enregistrerChoix(Number(jour), discordId, champ, key);
    const entete = result.status === "ok" ? null : `⚠️ ${CHOIX_ERREURS[result.status] || "Choix impossible."}`;
    await patchOriginal(webhookUrl, await buildJeuView(Number(jour), discordId, username, entete));
  } catch (err) {
    console.error("[DraftRoyale] Échec choix:", err.message);
  }
}

const JOKER_ERREURS = {
  points: "Pas assez de points Joker.",
  cible: "Joueur impossible à espionner.",
  carte: "Cette carte n'est plus au marché.",
  inconnue: "Bonus inconnu.",
  deja: "Tu as déjà espionné un joueur ce tour-ci.",
  unknownPlayer: "Clique d'abord sur Jouer.",
};

// Menus Joker de la main : `champ` = "bonus" (bonus du tour) ou
// "espion" (Espionner, instantané).
export async function handleJoker(webhookUrl, jour, champ, discordId, username, value) {
  try {
    if (!(await guardActiveDay(webhookUrl, jour))) return;
    const result = champ === "espion" ? await voirMainJoueur(Number(jour), discordId, value) : await enregistrerJoker(Number(jour), discordId, value);
    const entete = result.status === "ok" ? null : `⚠️ ${JOKER_ERREURS[result.status] || "Choix impossible."}`;
    await patchOriginal(webhookUrl, await buildJeuView(Number(jour), discordId, username, entete));
  } catch (err) {
    console.error("[DraftRoyale] Échec Joker:", err.message);
  }
}

// ── Bouton [📖 Règles] (éphémère, statique) ──────────────────────────

export async function handleRegles(webhookUrl) {
  try {
    await patchOriginal(webhookUrl, { embeds: [buildReglesEmbed(await loadDraftRoyaleConfig())] });
  } catch (err) {
    console.error("[DraftRoyale] Échec Règles:", err.message);
  }
}
