// ============================================================
// draftroyale.js — Handlers Discord du Draft Royale (deck de 8 cartes en
// 7 jours). Embeds, boutons du jour (Piocher / Marché / Contrat), selects
// (dépôt, vœux, contrat), Journal et Règles. La publication/clôture
// quotidienne passe uniquement par scripts/postDraftRoyale.js
// (postDraftRoyale) — les boutons/selects restent gérés par
// api/discord/interactions.js.
//
// Même modèle que Mario Clash : participation libre (joueur créé au premier
// clic), pioche/dépôt/contrat appliqués en direct, vœux résolus à la
// clôture (voir backend/services/draftroyale.js).
//
// ⚠️ Mains et contrats restent secrets jusqu'au bilan final (bluff autour
// du marché et des majorités) : seul le Journal (éphémère) montre au joueur
// sa propre main ; le classement public pendant la partie se limite à la
// popularité.
// ============================================================

import {
  loadDraftRoyaleConfig,
  loadCatalog,
  readState,
  writeState,
  readJoueurs,
  ensureJoueur,
  readAction,
  readMarche,
  piocher,
  deposer,
  enregistrerVoeu,
  signerContrat,
  contratsDisponibles,
  contratBonus,
  multiplicateurDuJour,
  countTheme,
  scoreDeck,
  popularitePoints,
  combinaisonsEnCours,
  lignesCombinaisons,
  formatPions,
  cartesSouhaitables,
  depotDuJour,
  cardsFromKeys,
  previewCloture,
  closeDayAndAdvance,
  getHistoriqueEntry,
  readResultat,
  archiveManche,
  listManches,
  isTooSoonSinceLastClosure,
} from "../../../backend/services/draftroyale.js";
import { getRoleIdByName, buildRolePingFields, MINI_JEUX_ROLE_NAME } from "../../../backend/services/discordRoles.js";
import { formatUtcTimeAsParis } from "../../../backend/services/dateUtils.js";

const DRAFT_COLOR = 0x2f5bd3;
const TRUST_ROYALE_URL = "https://trustroyale.vercel.app";
const TRADE_EMOJI = { name: "trade", id: "1493849418611294279" };
const TRADE_TEXT = "<:trade:1493849418611294279>";

const TYPE_LABELS = { troop: "Troupe", flying: "Volant", spell: "Sort", building: "Bâtiment" };
const FAMILY_LABELS = { goblin: "Gobelin", skeleton: "Squelette", human: "Humain", minion: "Gargouille" };
const RARITY_LABELS = { common: "Commune", rare: "Rare", epic: "Épique", legendary: "Légendaire", champion: "Champion" };

// Cache-buster dynamique (Discord met en cache l'échec d'un premier fetch,
// voir marioclash.js).
function marcheImageUrl(jour) {
  return `${TRUST_ROYALE_URL}/api/draftroyale/marche?jour=${jour}&v=${Date.now()}`;
}

function illustrationUrl() {
  return `${TRUST_ROYALE_URL}/api/draftroyale/illustration?v=${Date.now()}`;
}

function mainImageUrl(keys) {
  if (!keys?.length) return null;
  return `${TRUST_ROYALE_URL}/api/draftroyale/main?${new URLSearchParams({ c: keys.join("|") })}`;
}

// ── Mise en forme des cartes ────────────────────────────────────────

function cardTags(card) {
  const tags = [RARITY_LABELS[card.rarity], TYPE_LABELS[card.type]];
  if (card.family) tags.push(FAMILY_LABELS[card.family]);
  return `${tags.join(" · ")} · ${card.elixir} 💧`;
}

function cardName(key, catalog) {
  return catalog.get(key)?.fr || key;
}

function cardLine(key, catalog) {
  const card = catalog.get(key);
  return card ? `**${card.fr}** (${cardTags(card)})` : key;
}

function cardOption(key, catalog, selected = false) {
  const card = catalog.get(key);
  return {
    label: (card?.fr || key).slice(0, 100),
    description: card ? cardTags(card).slice(0, 100) : undefined,
    value: key,
    default: selected || undefined,
  };
}

function plural(n, mot) {
  return `${n} ${mot}${n > 1 ? "s" : ""}`;
}

// ── Embeds ───────────────────────────────────────────────────────────

function buildAnnonceEmbed(config) {
  return {
    title: "🃏 Draft Royale — Les cartes sont mélangées…",
    description: [
      `Pendant ${config.duree_jours} jours, construis le meilleur deck de ${config.taille_deck} cartes : pioche, échange au marché et signe un contrat secret pour viser les meilleures synergies !`,
      "",
      `📅 **${config.duree_jours} jours de draft**, à partir de demain. Chaque jour : 👆 **Piocher**, ${TRADE_TEXT} **Marché** et ✍️ **Contrat**.`,
      "",
      "Plus d'infos ? Clique sur *Règles* ci-dessous.",
    ].join("\n"),
    color: DRAFT_COLOR,
    image: { url: illustrationUrl() },
    footer: { text: `Le draft commence demain à ${formatUtcTimeAsParis(8)}.` },
  };
}

// Résumé public de la veille : uniquement des chiffres agrégés (les mains
// restent secrètes).
function buildResumeLignes(jour, config, lignesVeille, marcheDuJour) {
  const lignes = [];
  if (jour === 1) {
    lignes.push(`Le draft commence ! Tu reçois ${plural(config.cartes_depart, "carte")} à ton premier clic.`);
  } else {
    const exauces = lignesVeille.filter((l) => l.type === "voeu").length;
    const retours = lignesVeille.filter((l) => l.type === "retour").length;
    if (exauces || retours) {
      lignes.push(`Hier au marché : ${plural(exauces, "vœu")} exaucé${exauces > 1 ? "s" : ""}${retours ? `, ${plural(retours, "carte")} rendue${retours > 1 ? "s" : ""} à ${retours > 1 ? "leurs déposants" : "son déposant"}` : ""}.`);
    }
    const nb = marcheDuJour.length;
    lignes.push(
      nb
        ? `${TRADE_TEXT} **${plural(nb, "carte")} au marché** : si tu as déposé une carte hier, fais tes vœux avant la clôture.`
        : `${TRADE_TEXT} Le marché est vide aujourd'hui.`,
    );
  }
  if (jour <= config.jour_dernier_depot) lignes.push(`Les cartes déposées aujourd'hui seront au marché demain (${config.copies_par_depot} joueurs max par carte).`);
  if (!multiplicateurDuJour(config, jour)) lignes.push("✍️ Les contrats sont fermés.");
  if (jour === config.duree_jours) lignes.push(`🏁 **Dernier jour** : plus de dépôt. À la clôture, ton meilleur deck de ${config.taille_deck} cartes est retenu automatiquement.`);
  return lignes;
}

function buildJourEmbed(jour, config, resumeLignes) {
  return {
    title: `🃏 Draft Royale — Jour ${jour}/${config.duree_jours}`,
    description: resumeLignes.join("\n"),
    color: DRAFT_COLOR,
    image: { url: jour === 1 ? illustrationUrl() : marcheImageUrl(jour) },
    footer: { text: `Actions avant ${formatUtcTimeAsParis(8)} demain. Une seule fois chacune par jour.` },
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

const MEDALS = ["🥇", "🥈", "🥉"];

function buildFinEmbed(ranking, config, manches, currentManche) {
  // Classement déjà départagé (popularité, puis ordre d'arrivée) : un seul vainqueur
  const top = ranking[0];
  const titre = top ? `**${top.username}** l'emporte avec **${top.score} pts** !` : "Personne n'a participé.";
  return {
    title: "🏆 Draft Royale — Draft terminé !",
    description: [
      `Après ${config.duree_jours} jours de draft, les decks sont révélés. ${titre}`,
      "",
      "**Classement final**",
      ...ranking.slice(0, 10).map((r, i) => `${MEDALS[i] || `${i + 1}.`} **${r.username}** (${r.score} pts)`),
      ...(top ? ["", `**Deck du vainqueur** : ${top.details.map((d) => `${d.label} +${d.points}`).join(", ")}`] : []),
      ...buildManchesSection(manches, currentManche),
      "",
      "Consulte ton *Journal* pour le détail de ton score.",
    ].join("\n"),
    color: 0xf1c40f,
    image: { url: mainImageUrl(top?.deck) || illustrationUrl() },
  };
}

function buildReglesEmbed(config) {
  const mults = Object.entries(config.contrat_multiplicateurs).map(([j, m]) => `J${j} ×${m}`).join(", ");
  return {
    title: "📖 Règles — Draft Royale",
    description: [
      `Construis en ${config.duree_jours} jours le deck de ${config.taille_deck} cartes qui marque le plus de points. Tu reçois ${plural(config.cartes_depart, "carte")} au départ (une de plus par jour manqué si tu arrives en cours de partie), jamais deux fois la même.`,
      "",
      "**Chaque jour, une fois chacune :**",
      "👆 **Piocher** : une carte au hasard, ajoutée tout de suite à ta main.",
      `${TRADE_TEXT} **Marché** :`,
      `• *Déposer* (J1 à J${config.jour_dernier_depot}, facultatif) : une carte de ta main part au marché, définitivement. Elle y sera disponible le lendemain.`,
      `• *Vœux* (le lendemain d'un dépôt) : classe jusqu'à ${config.nb_voeux} cartes du marché. À la clôture, tu reçois ton premier vœu encore disponible, sinon ta carte te revient.`,
      `• Chaque carte déposée peut être prise par ${config.copies_par_depot} joueurs maximum. Les joueurs les plus populaires sont servis en premier, puis au hasard.`,
      `✍️ **Contrat** (J1 à J4) : signe en secret un objectif de thème. S'il est atteint au J${config.duree_jours}, il rapporte en plus ses points × (multiplicateur − 1), selon le jour de signature (${mults}). Raté : aucun bonus. Tu peux en changer, au multiplicateur du jour.`,
      "",
      `**Score final** : meilleur deck de ${config.taille_deck} retenu automatiquement au J${config.duree_jours}. Le barème est détaillé sous *Combinaisons*.`,
      "",
      "Égalité : la popularité totale départage, puis l'ordre d'arrivée dans le jeu.",
    ].join("\n"),
    color: DRAFT_COLOR,
  };
}

function buildCombinaisonsEmbed(config, catalog) {
  return {
    title: "🧩 Combinaisons — Draft Royale",
    description: lignesCombinaisons(config, catalog).join("\n").slice(0, 4096),
    color: DRAFT_COLOR,
  };
}

// ── Composants ───────────────────────────────────────────────────────

function utilityButtons() {
  return [
    { type: 2, style: 3, label: "Règles", emoji: { name: "📖" }, custom_id: "draftroyale_regles" },
    { type: 2, style: 2, label: "Combinaisons", emoji: { name: "🧩" }, custom_id: "draftroyale_combinaisons" },
    { type: 2, style: 2, label: "Journal", emoji: { name: "📜" }, custom_id: "draftroyale_journal" },
  ];
}

function buildJourComponents(jour) {
  return [
    {
      type: 1,
      components: [
        { type: 2, style: 2, label: "Piocher", emoji: { name: "👆" }, custom_id: `draftroyale_pioche:${jour}` },
        { type: 2, style: 2, label: "Marché", emoji: TRADE_EMOJI, custom_id: `draftroyale_marche:${jour}` },
        { type: 2, style: 2, label: "Contrat", emoji: { name: "✍️" }, custom_id: `draftroyale_contrat:${jour}` },
      ],
    },
    { type: 1, components: utilityButtons() },
  ];
}

// ── Publication quotidienne (appelée uniquement par scripts/postDraftRoyale.js) ──

export async function postDraftRoyale(channelId, { dryRun = false, noPing = false, isPublic = false, requireActiveState = false, force = false } = {}) {
  const config = await loadDraftRoyaleConfig();
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
    const components = [{ type: 1, components: [utilityButtons()[0]] }];
    if (dryRun) return { dryRun: true, phase: "annonce", embed, components };
    return publishAndWriteState(channelId, null, { phase: "annonce", jour: null, embed, components, noPing, estAnnonce: true });
  }

  // 2) Présentation → Jour 1 : rien à clôturer
  if (state.phase === "annonce") {
    const embed = buildJourEmbed(1, config, buildResumeLignes(1, config, [], []));
    const components = buildJourComponents(1);
    if (dryRun) return { dryRun: true, phase: "jour", jour: 1, embed, components };
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
    const embed = buildFinEmbed(ranking, config, manches, currentManche);
    const components = [{ type: 1, components: [utilityButtons()[1]] }];
    if (dryRun) return { dryRun: true, final: true, embed, closure };
    const result = await publishAndWriteState(channelId, state, { phase: "jour", jour: state.jour, embed, components, noPing, estAnnonce: false, termine: true });
    return { ...result, final: true };
  }

  const embed = buildJourEmbed(closure.jourSuivant, config, buildResumeLignes(closure.jourSuivant, config, closure.lignes, closure.marcheJour));
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
      body: JSON.stringify({ embeds: [], components: [], ...payload }),
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

// ── Bouton [👆 Piocher] ──────────────────────────────────────────────

export async function handlePiocheButton(webhookUrl, jour, discordId, username) {
  try {
    if (!(await guardActiveDay(webhookUrl, jour))) return;
    const [catalog, result] = await Promise.all([loadCatalog(), piocher(Number(jour), discordId, username)]);
    if (result.status === "alreadyDrawn") {
      await patchOriginal(webhookUrl, { content: `👆 Tu as déjà pioché aujourd'hui (${cardName(result.key, catalog)}).` });
      return;
    }
    if (result.status !== "ok") {
      await patchOriginal(webhookUrl, { content: "👆 Plus aucune carte à piocher." });
      return;
    }
    const main = result.joueur.main;
    await patchOriginal(webhookUrl, {
      content: `👆 Tu pioches ${cardLine(result.key, catalog)} !\nTa main : ${plural(main.length, "carte")}.`,
      embeds: [{ color: DRAFT_COLOR, image: { url: mainImageUrl(main) } }],
    });
  } catch (err) {
    console.error("[DraftRoyale] Échec pioche:", err.message);
  }
}

// ── Bouton [Marché] : dépôt du jour + vœux sur le marché de la veille ──

async function buildMarcheView(jour, discordId, username, entete = null) {
  const config = await loadDraftRoyaleConfig();
  const [catalog, joueur, action] = await Promise.all([loadCatalog(), ensureJoueur(discordId, username, jour), readAction(jour, discordId)]);
  const lignes = entete ? [entete, ""] : [];
  const components = [];

  // Vœux : seulement le lendemain d'un dépôt
  const depotVeille = depotDuJour(joueur, jour - 1);
  if (depotVeille) {
    const marche = await readMarche(jour - 1);
    const souhaitables = cartesSouhaitables(marche, joueur, jour).slice(0, 25);
    const voeux = action.voeux || [];
    if (souhaitables.length) {
      lignes.push(`**Tes vœux** (tu as déposé ${cardName(depotVeille.key, catalog)} hier). Résolus à la clôture, sinon ta carte te revient.`);
      for (let rang = 1; rang <= config.nb_voeux; rang++) {
        components.push({
          type: 1,
          components: [
            {
              type: 3,
              custom_id: `draftroyale_voeu:${jour}:${rang}`,
              placeholder: `${rang === 1 ? "1er" : `${rang}e`} vœu`,
              options: souhaitables.map((k) => cardOption(k, catalog, voeux[rang - 1] === k)),
            },
          ],
        });
      }
    } else if (marche.every((m) => m.key === depotVeille.key)) {
      lignes.push(`Le marché ne contient que ta carte (${cardName(depotVeille.key, catalog)}) : elle te reviendra à la clôture.`);
    } else {
      lignes.push(`Tu possèdes déjà toutes les cartes du marché : ${cardName(depotVeille.key, catalog)} te reviendra à la clôture.`);
    }
  } else if (jour > 1) {
    lignes.push("Pas de vœux aujourd'hui : il faut avoir déposé une carte hier.");
  }

  // Dépôt du jour
  const depotJour = depotDuJour(joueur, jour);
  if (depotJour) {
    lignes.push(`Déposé aujourd'hui : **${cardName(depotJour.key, catalog)}** (au marché demain).`);
  } else if (jour > config.jour_dernier_depot) {
    lignes.push("Plus de dépôt possible aujourd'hui.");
  } else if (!joueur.main.length) {
    lignes.push("Ta main est vide, rien à déposer.");
  } else {
    lignes.push(`**Déposer une carte** (facultatif, définitif) : elle sera au marché demain et te permettra de faire des vœux.`);
    components.push({
      type: 1,
      components: [
        {
          type: 3,
          custom_id: `draftroyale_depot:${jour}`,
          placeholder: "Carte à déposer",
          options: joueur.main.slice(0, 25).map((k) => cardOption(k, catalog)),
        },
      ],
    });
  }
  return { content: lignes.join("\n"), components };
}

export async function handleMarcheButton(webhookUrl, jour, discordId, username) {
  try {
    if (!(await guardActiveDay(webhookUrl, jour))) return;
    await patchOriginal(webhookUrl, await buildMarcheView(Number(jour), discordId, username));
  } catch (err) {
    console.error("[DraftRoyale] Échec marché:", err.message);
  }
}

const DEPOT_ERREURS = {
  tooLate: "Plus de dépôt possible aujourd'hui.",
  alreadyDeposited: "Tu as déjà déposé une carte aujourd'hui.",
  notInHand: "Cette carte n'est plus dans ta main.",
  unknownPlayer: "Joueur introuvable.",
};

export async function handleDepotSelect(webhookUrl, jour, discordId, username, key) {
  try {
    if (!(await guardActiveDay(webhookUrl, jour))) return;
    const [config, catalog] = await Promise.all([loadDraftRoyaleConfig(), loadCatalog()]);
    const result = await deposer(Number(jour), discordId, key, config);
    const entete = result.status === "ok" ? `${TRADE_TEXT} **${cardName(key, catalog)}** déposée au marché !` : `⚠️ ${DEPOT_ERREURS[result.status] || "Dépôt impossible."}`;
    await patchOriginal(webhookUrl, await buildMarcheView(Number(jour), discordId, username, entete));
  } catch (err) {
    console.error("[DraftRoyale] Échec dépôt:", err.message);
  }
}

export async function handleVoeuSelect(webhookUrl, jour, rang, discordId, username, key) {
  try {
    if (!(await guardActiveDay(webhookUrl, jour))) return;
    const [config, catalog] = await Promise.all([loadDraftRoyaleConfig(), loadCatalog()]);
    const result = await enregistrerVoeu(Number(jour), discordId, Number(rang), key, config);
    const entete =
      result.status === "ok"
        ? `✅ Vœux : ${result.voeux.map((k, i) => `${i + 1}. ${k ? cardName(k, catalog) : "(vide)"}`).join(", ")}`
        : "⚠️ Ce vœu n'est pas possible.";
    await patchOriginal(webhookUrl, await buildMarcheView(Number(jour), discordId, username, entete));
  } catch (err) {
    console.error("[DraftRoyale] Échec vœu:", err.message);
  }
}

// ── Bouton [✍️ Contrat] ───────────────────────────────────────────────

function contratLigne(contrat, cards, config) {
  if (!contrat) return "Aucun contrat signé.";
  const theme = config.themes.find((t) => t.id === contrat.themeId);
  const count = theme ? countTheme(cards, theme) : 0;
  return `Contrat : **${contrat.label}** (×${contrat.multiplicateur}, +${contratBonus(contrat)} pts si réussi) · ${Math.min(count, contrat.palier)}/${contrat.palier}`;
}

export async function handleContratButton(webhookUrl, jour, discordId, username) {
  try {
    if (!(await guardActiveDay(webhookUrl, jour))) return;
    const config = await loadDraftRoyaleConfig();
    const [catalog, joueur, action] = await Promise.all([loadCatalog(), ensureJoueur(discordId, username, Number(jour)), readAction(Number(jour), discordId)]);
    const cards = cardsFromKeys(joueur.main, catalog);
    const mult = multiplicateurDuJour(config, jour);
    const lignes = [`✍️ ${contratLigne(joueur.contrat, cards, config)}`];
    if (!mult) {
      lignes.push(`Les contrats se signent du J1 au J${Object.keys(config.contrat_multiplicateurs).length}.`);
      await patchOriginal(webhookUrl, { content: lignes.join("\n") });
      return;
    }
    if (action.contrat) {
      lignes.push("Tu as déjà signé un contrat aujourd'hui.");
      await patchOriginal(webhookUrl, { content: lignes.join("\n") });
      return;
    }
    lignes.push(`Signé aujourd'hui : **×${mult}**.${joueur.contrat ? " Un nouveau contrat remplace l'actuel." : ""} Rien n'est perdu en cas d'échec.`);
    const options = contratsDisponibles(config)
      .filter((c) => c.id !== joueur.contrat?.id)
      .map((c) => {
        const theme = config.themes.find((t) => t.id === c.themeId);
        return {
          label: `${c.palier} ${theme.label}`,
          description: `+${contratBonus({ ...c, multiplicateur: mult })} pts si réussi · tu en as ${countTheme(cards, theme)}`,
          value: c.id,
        };
      });
    await patchOriginal(webhookUrl, {
      content: lignes.join("\n"),
      components: [{ type: 1, components: [{ type: 3, custom_id: `draftroyale_contrat_select:${jour}`, placeholder: "Choisis ton contrat", options }] }],
    });
  } catch (err) {
    console.error("[DraftRoyale] Échec bouton contrat:", err.message);
  }
}

const CONTRAT_ERREURS = {
  tooLate: "Les contrats sont fermés.",
  unknown: "Contrat inconnu.",
  alreadySigned: "Tu as déjà signé un contrat aujourd'hui.",
  same: "C'est déjà ton contrat.",
};

export async function handleContratSelect(webhookUrl, jour, discordId, username, contratId) {
  try {
    if (!(await guardActiveDay(webhookUrl, jour))) return;
    const config = await loadDraftRoyaleConfig();
    const result = await signerContrat(Number(jour), discordId, username, contratId, config);
    await patchOriginal(webhookUrl, {
      content:
        result.status === "ok"
          ? `✍️ Contrat signé : **${result.contrat.label}** (×${result.contrat.multiplicateur}, +${contratBonus(result.contrat)} pts si réussi au J${config.duree_jours}). Il reste secret jusqu'au bilan final.`
          : `⚠️ ${CONTRAT_ERREURS[result.status] || "Signature impossible."}`,
    });
  } catch (err) {
    console.error("[DraftRoyale] Échec select contrat:", err.message);
  }
}

// ── Bouton [📜 Journal] (éphémère) ────────────────────────────────────

function bilanPersonnel(lignes, discordId, catalog) {
  return lignes
    .filter((l) => l.discordId === discordId)
    .map((l) => {
      if (l.type === "voeu") return `✅ Vœu n°${l.rang} exaucé : tu reçois **${cardName(l.key, catalog)}**.`;
      if (l.type === "retour") return `↩️ ${l.sansVoeu ? "Sans vœu" : "Aucun vœu disponible"} : **${cardName(l.key, catalog)}** te revient.`;
      if (l.type === "popularite") return `⭐ ${plural(l.nb, "joueur")} ${l.nb > 1 ? "ont" : "a"} pris ta carte ${cardName(l.key, catalog)} (+${l.nb} popularité).`;
      return null;
    })
    .filter(Boolean);
}

function popularitesLignes(joueurs) {
  const top = Object.values(joueurs)
    .filter((j) => (j.popularite || 0) > 0)
    .sort((a, b) => b.popularite - a.popularite || a.username.localeCompare(b.username))
    .slice(0, 5);
  if (!top.length) return [];
  return ["", "**⭐ Joueurs les plus populaires**", ...top.map((j, i) => `${MEDALS[i] || `${i + 1}.`} ${j.username} (${j.popularite})`)];
}

async function buildJournalFinal(discordId, config, catalog) {
  const ranking = (await readResultat()) || [];
  const index = ranking.findIndex((r) => r.discordId === discordId);
  if (index < 0) return { content: "Tu n'as pas participé à ce draft." };
  const r = ranking[index];
  return {
    embeds: [
      {
        title: "📜 Journal — Bilan final",
        description: [
          `**${index + 1}e place** sur ${ranking.length} avec **${r.score} pts**.`,
          "",
          ...(r.details.length ? r.details.map((d) => `• ${d.label} : +${d.points}`) : ["Aucun point marqué."]),
          r.contrat ? `${r.details.some((d) => d.id === "contrat") ? "✅" : "❌"} Contrat ${r.contrat.label}` : null,
          "",
          `**Ton deck** (${r.deck.length} cartes)`,
          ...r.deck.map((k) => `• ${cardLine(k, catalog)}`),
        ]
          .filter((l) => l !== null)
          .join("\n"),
        color: DRAFT_COLOR,
        image: mainImageUrl(r.deck) ? { url: mainImageUrl(r.deck) } : undefined,
      },
    ],
  };
}

export async function handleJournal(webhookUrl, discordId) {
  try {
    const state = await readState();
    if (!state || state.phase !== "jour") {
      await patchOriginal(webhookUrl, { content: "Aucun journal disponible pour l'instant." });
      return;
    }
    const [config, catalog] = await Promise.all([loadDraftRoyaleConfig(), loadCatalog()]);
    if (state.termine) {
      await patchOriginal(webhookUrl, await buildJournalFinal(discordId, config, catalog));
      return;
    }
    const [joueurs, veille] = await Promise.all([readJoueurs(), state.jour > 1 ? getHistoriqueEntry(state.jour - 1) : null]);
    const joueur = joueurs[discordId];
    if (!joueur) {
      await patchOriginal(webhookUrl, { content: "Tu n'as pas encore rejoint le draft : clique sur 👆 Piocher pour recevoir tes premières cartes !", embeds: [{ color: DRAFT_COLOR, description: popularitesLignes(joueurs).join("\n") || "Aucun joueur populaire pour l'instant." }] });
      return;
    }
    const cards = cardsFromKeys(joueur.main, catalog);
    const { total } = scoreDeck(cards, joueur.contrat, config);
    const pop = popularitePoints(joueur, config);
    const depots = (joueur.depots || []).map((d) => `${cardName(d.key, catalog)} (déposée J${d.jour})`);
    const bilan = bilanPersonnel(veille?.lignes || [], discordId, catalog);
    // Cartes encore obtenables : pioche + vœu par jour restant, plus la
    // pioche du jour si elle n'est pas faite et le vœu en attente.
    const action = await readAction(state.jour, discordId);
    const cartesRestantes =
      (config.duree_jours - state.jour) * 2 + (action.pioche ? 0 : 1) + (depotDuJour(joueur, state.jour - 1) ? 1 : 0);
    const pistes = combinaisonsEnCours(cards, config, cartesRestantes, catalog).slice(0, 10);
    const lignes = [
      `**Ta main** (${plural(joueur.main.length, "carte")})`,
      ...joueur.main.map((k) => `• ${cardLine(k, catalog)}`),
      ...(depots.length ? [`Au marché : ${depots.join(", ")}`] : []),
      "",
      `✍️ ${contratLigne(joueur.contrat, cards, config)}`,
      `⭐ Popularité : ${joueur.popularite || 0} (${pop} pt${pop > 1 ? "s" : ""} compté${pop > 1 ? "s" : ""}, ${config.popularite_max} max)`,
      "",
      `**Score provisoire : ${total + pop} pts** (hors majorités)`,
      ...(pistes.length ? ["", "**Combinaisons**", ...pistes.map((p) => `${formatPions(p)} ${p.label} (+${p.points})`)] : []),
      ...(bilan.length ? ["", "**Hier**", ...bilan] : []),
      ...popularitesLignes(joueurs),
    ];
    await patchOriginal(webhookUrl, {
      embeds: [
        {
          title: `📜 Journal — Jour ${state.jour}/${config.duree_jours}`,
          description: lignes.join("\n").slice(0, 4096),
          color: DRAFT_COLOR,
          image: mainImageUrl(joueur.main) ? { url: mainImageUrl(joueur.main) } : undefined,
        },
      ],
    });
  } catch (err) {
    console.error("[DraftRoyale] Échec Journal:", err.message);
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

// ── Bouton [🧩 Combinaisons] (éphémère, statique) ─────────────────────

export async function handleCombinaisons(webhookUrl) {
  try {
    const [config, catalog] = await Promise.all([loadDraftRoyaleConfig(), loadCatalog()]);
    await patchOriginal(webhookUrl, { embeds: [buildCombinaisonsEmbed(config, catalog)] });
  } catch (err) {
    console.error("[DraftRoyale] Échec Combinaisons:", err.message);
  }
}
