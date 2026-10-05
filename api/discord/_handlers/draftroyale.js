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
  ensureJoueur,
  readAction,
  readPartie,
  initPartie,
  enregistrerChoix,
  previewCloture,
  closeDayAndAdvance,
  getHistoriqueEntry,
  archiveManche,
  listManches,
  isTooSoonSinceLastClosure,
} from "../../../backend/services/draftroyale.js";
import { compterCartes, pointsMain, trierMain, echangeValide } from "../../../backend/services/draftRules.js";
import { getRoleIdByName, buildRolePingFields, MINI_JEUX_ROLE_NAME } from "../../../backend/services/discordRoles.js";
import { formatUtcTimeAsParis } from "../../../backend/services/dateUtils.js";

const DRAFT_COLOR = 0x2f5bd3;
const TRUST_ROYALE_URL = "https://trustroyale.vercel.app";
const TRADE_TEXT = "<:trade:1493849418611294279>";

// Cache-buster dynamique (Discord met en cache l'échec d'un premier fetch,
// voir marioclash.js).
function marcheImageUrl() {
  return `${TRUST_ROYALE_URL}/api/draftroyale/marche?v=${Date.now()}`;
}

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

function groupOptions(keys, catalog, suffixe, selected) {
  return [...compterCartes(keys)]
    .sort((a, b) => cardName(a[0], catalog).localeCompare(cardName(b[0], catalog)))
    .slice(0, 25)
    .map(([k, n]) => ({
      label: cardName(k, catalog).slice(0, 100),
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
    .filter((j) => (j.points || 0) > 0)
    .sort((a, b) => b.points - a.points || (b.carres || 0) - (a.carres || 0) || a.username.localeCompare(b.username))
    .slice(0, limit);
  if (!top.length) return [];
  return ["", "**🏆 Classement**", ...top.map((j, i) => `${MEDALS[i] || `${i + 1}.`} ${j.username} (${plural(j.points, "pt")}${j.carres ? `, ${plural(j.carres, "carré")}` : ""})`)];
}

// Annonce publique des carrés réalisés (la carte du carré est révélée).
function carresLignes(closure, joueurs, config, catalog) {
  if (!closure?.carres?.length) return [];
  const noms = closure.carres.map((id) => {
    const main = closure.scores.find((s) => s.discordId === id)?.main || [];
    const [key] = [...compterCartes(main)].sort((a, b) => b[1] - a[1])[0] || [];
    return `**${joueurs[id]?.username || "?"}** (${cardName(key, catalog)})`;
  });
  return [`🎉 **Carré !** ${noms.join(", ")} : +${config.points_carre} pts. Les autres marquent 1 à 3 pts selon leurs cartes identiques.`];
}

// Résumé public de la veille : carrés, chiffres agrégés des échanges.
function buildResumeLignes(jour, config, closure, joueurs, catalog) {
  const lignes = [];
  if (jour === 1) {
    lignes.push(`Le draft commence ! Clique sur **Jouer** pour recevoir tes ${config.taille_main} cartes.`);
  } else {
    lignes.push(...carresLignes(closure, joueurs, config, catalog));
    if (closure?.redistribution) lignes.push("🔄 Toutes les cartes ont été redistribuées : nouvelle manche !");
    const echanges = closure?.lignes?.length || 0;
    const perdues = closure?.lignes?.filter((l) => l.type === "perdue").length || 0;
    if (echanges) lignes.push(`Hier : ${plural(echanges, "échange")}${perdues ? `, dont ${perdues} carte${perdues > 1 ? "s" : ""} disputée${perdues > 1 ? "s" : ""} perdue${perdues > 1 ? "s" : ""}` : ""}.`);
  }
  lignes.push("", `${TRADE_TEXT} Prends une carte du marché et dépose une carte de ta main. Objectif : ${config.taille_main} cartes identiques.`);
  if (jour === config.duree_jours) lignes.push(`🏁 **Dernier jour** : à la clôture, chacun marque ses points (${config.points_carre} pour un carré, sinon 1 à 3).`);
  lignes.push(...classementLignes(joueurs));
  return lignes;
}

function buildJourEmbed(jour, config, resumeLignes) {
  return {
    title: `🃏 Draft Royale — Jour ${jour}/${config.duree_jours}`,
    description: resumeLignes.join("\n").slice(0, 4096),
    color: DRAFT_COLOR,
    image: { url: marcheImageUrl() },
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

function buildFinEmbed(ranking, closure, config, catalog, manches, currentManche) {
  // Classement déjà départagé (carrés, puis ordre d'arrivée) : un seul vainqueur
  const top = ranking[0];
  const titre = top ? `**${top.username}** l'emporte avec **${top.score} pts** !` : "Personne n'a participé.";
  return {
    title: "🏆 Draft Royale — Draft terminé !",
    description: [
      ...carresLignes(closure, closure.joueursApres, config, catalog),
      `Après ${config.duree_jours} jours de draft, ${titre}`,
      "",
      "**Classement final**",
      ...ranking.slice(0, 10).map((r, i) => `${MEDALS[i] || `${i + 1}.`} **${r.username}** (${plural(r.score, "pt")}${r.carres ? `, ${plural(r.carres, "carré")}` : ""})`),
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
      `Réunis **${config.taille_main} exemplaires d'une même carte** (un carré) ! Chaque carte en jeu existe en ${config.exemplaires} exemplaires. Tu reçois ${config.taille_main} cartes à ton premier clic, le reste est au marché, visible par tous.`,
      "",
      `**Chaque jour** : ${TRADE_TEXT} choisis une carte à prendre au marché et une carte de ta main à y déposer. Tu peux changer d'avis jusqu'à la clôture.`,
      "",
      "**À la clôture**, tous les échanges ont lieu en même temps :",
      "• Une carte voulue par plus de joueurs qu'il n'y a d'exemplaires va au plus populaire (tirage au sort à égalité), dont la popularité retombe à 0.",
      "• Les autres reçoivent une autre carte du marché au hasard et gagnent +1 popularité.",
      "",
      `**Carré** : dès qu'un joueur a ${config.taille_main} cartes identiques, il marque ${config.points_carre} pts. Les autres marquent 1, 2 ou 3 pts selon leur plus grand nombre de cartes identiques. Puis toutes les cartes sont redistribuées.`,
      "",
      `**Dernier jour** (J${config.duree_jours}) : tout le monde marque ses points, même sans carré.`,
      "",
      "Égalité : le nombre de carrés départage, puis l'ordre d'arrivée dans le jeu.",
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
    const embed = buildJourEmbed(1, config, buildResumeLignes(1, config, null, {}, catalog));
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
    const embed = buildFinEmbed(ranking, closure, config, catalog, manches, currentManche);
    const components = [{ type: 1, components: [reglesButton()] }];
    if (dryRun) return { dryRun: true, final: true, embed, closure };
    const result = await publishAndWriteState(channelId, state, { phase: "jour", jour: state.jour, embed, components, noPing, estAnnonce: false, termine: true });
    return { ...result, final: true };
  }

  const embed = buildJourEmbed(closure.jourSuivant, config, buildResumeLignes(closure.jourSuivant, config, closure, closure.joueursApres, catalog));
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

// Bilan personnel de la clôture de la veille.
function bilanPersonnel(veille, discordId, catalog) {
  if (!veille) return [];
  const lignes = [];
  for (const l of veille.lignes.filter((x) => x.discordId === discordId)) {
    if (l.type === "prise") lignes.push(`✅ Tu as pris **${cardName(l.key, catalog)}**${l.disputee ? " face à d'autres joueurs (popularité remise à 0)" : ""}.`);
    if (l.type === "perdue") lignes.push(`❌ ${cardName(l.voulue, catalog)} est allée à un joueur plus populaire : tu reçois **${cardName(l.key, catalog)}** (+1 popularité).`);
  }
  const score = veille.scores?.find((s) => s.discordId === discordId);
  if (score) lignes.push(score.carre ? `🎉 **Carré !** +${score.points} pts.` : `Décompte : +${plural(score.points, "pt")}.`);
  if (veille.redistribution) lignes.push("🔄 Toutes les cartes ont été redistribuées : voici ta nouvelle main.");
  return lignes;
}

function statutEchange(action, joueur, partie, catalog) {
  if (echangeValide(action, joueur.main, partie.marche)) {
    return `${TRADE_TEXT} Échange prévu : tu prends **${cardName(action.prise, catalog)}**, tu déposes **${cardName(action.depot, catalog)}**. Modifiable jusqu'à la clôture.`;
  }
  const prise = action.prise && partie.marche.includes(action.prise) ? action.prise : null;
  const depot = action.depot && joueur.main.includes(action.depot) ? action.depot : null;
  if (prise) return `⚠️ Tu prends **${cardName(prise, catalog)}** : choisis aussi la carte à déposer, sinon pas d'échange.`;
  if (depot) return `⚠️ Tu déposes **${cardName(depot, catalog)}** : choisis aussi la carte à prendre, sinon pas d'échange.`;
  return `${TRADE_TEXT} Choisis une carte à prendre au marché et une carte de ta main à déposer.`;
}

// Vue éphémère du joueur : main, bilan de la veille, échange prévu,
// marché, et les deux menus de l'échange.
async function buildJeuView(jour, discordId, username, entete = null) {
  const [config, catalog, state] = await Promise.all([loadDraftRoyaleConfig(), loadCatalog(), readState()]);
  const { joueur, nouveau } = await ensureJoueur(discordId, username);
  const [partie, action, veille] = await Promise.all([readPartie(), readAction(jour, discordId), jour > 1 ? getHistoriqueEntry(jour - 1) : null]);
  const main = trierMain(joueur.main);
  const bilan = nouveau ? [] : bilanPersonnel(veille, discordId, catalog);
  const lignes = [
    ...(entete ? [entete, ""] : []),
    ...(nouveau ? [`Bienvenue ! Voici tes ${config.taille_main} cartes.`, ""] : []),
    `**Ta main** : ${formatGroupes(main, catalog)}`,
    `Points au prochain décompte : ${plural(pointsMain(main, config), "pt")}`,
    `🏆 Total : ${plural(joueur.points || 0, "pt")} · ⭐ Popularité : ${joueur.popularite || 0}`,
    ...(bilan.length ? ["", "**Hier**", ...bilan] : []),
    "",
    statutEchange(action, joueur, partie, catalog),
  ];
  const marcheTrie = [...partie.marche].sort();
  return {
    embeds: [
      {
        title: `🃏 Ta main — Jour ${state?.jour ?? jour}/${config.duree_jours}`,
        description: lignes.join("\n").slice(0, 4096),
        color: DRAFT_COLOR,
        image: mainImageUrl(main) ? { url: mainImageUrl(main) } : undefined,
      },
      {
        title: "Marché",
        description: formatGroupes(marcheTrie, catalog).slice(0, 4096) || "Le marché est vide.",
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
            options: groupOptions(partie.marche, catalog, "au marché", action.prise),
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

// Menus de l'échange : `champ` = "prise" ou "depot".
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

// ── Bouton [📖 Règles] (éphémère, statique) ──────────────────────────

export async function handleRegles(webhookUrl) {
  try {
    await patchOriginal(webhookUrl, { embeds: [buildReglesEmbed(await loadDraftRoyaleConfig())] });
  } catch (err) {
    console.error("[DraftRoyale] Échec Règles:", err.message);
  }
}
