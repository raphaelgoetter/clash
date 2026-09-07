// ============================================================
// marioclash.js — Handlers Discord pour Mario Clash (course communautaire
// façon Mario Kart sur plateau à 49 cases, thème Clash Royale). Embed,
// boutons du jour (dé/boutique/objet/sort), selects de ciblage, Règles. La
// publication/clôture quotidienne passe uniquement par
// scripts/postMarioClash.js (postMarioClash) — les boutons/selects restent
// gérés par api/discord/interactions.js.
//
// ⚠️ Modèle de référence = Boss Raid, pas Robinson : rien n'est appliqué en
// direct pendant la journée (dé/objet/sort) — tout se résout UNE SEULE FOIS
// à la clôture, dans computeCloture() (backend/services/marioclash.js). Seul
// l'achat en boutique est résolu en direct (action individuelle, sans
// interaction avec les autres joueurs — voir marioclash.js).
//
// ⚠️ Participation libre, comme Robinson/Tamagoshi/Boss Raid : pas
// d'inscription préalable, un joueur rejoint la course au premier clic
// (ensureJoueur()).
// ============================================================

import {
  loadMarioClashConfig,
  readState,
  writeState,
  readJoueurs,
  readJoueur,
  ensureJoueur,
  purchaseItem,
  recordDiceRoll,
  recordItemUse,
  recordSpellCast,
  readActions,
  previewCloture,
  closeDayAndAdvance,
  getHistoriqueEntry,
  archiveManche,
  listManches,
  isTooSoonSinceLastClosure,
} from "../../../backend/services/marioclash.js";
import {
  getRoleIdByName,
  buildRolePingFields,
  MINI_JEUX_ROLE_NAME,
} from "../../../backend/services/discordRoles.js";
import { formatUtcTimeAsParis } from "../../../backend/services/dateUtils.js";

const MARIOCLASH_COLOR = 0xe74c3c;
const TRUST_ROYALE_URL = "https://trustroyale.vercel.app";

function boardImageUrl(jour) {
  return `${TRUST_ROYALE_URL}/api/marioclash/image?jour=${jour}&v=${Date.now()}`;
}

function illustrationUrl() {
  return `${TRUST_ROYALE_URL}/api/marioclash/illustration?v=1`;
}

// ── Classement ───────────────────────────────────────────────────────

function sortedRanking(joueurs) {
  return Object.entries(joueurs)
    .map(([discordId, j]) => ({ discordId, ...j }))
    .sort((a, b) => b.position - a.position || a.username.localeCompare(b.username));
}

function formatRankingLines(joueurs, config, limit = 10) {
  const ranking = sortedRanking(joueurs);
  if (!ranking.length) return ["*Personne n'a encore rejoint la course.*"];
  return ranking.slice(0, limit).map((j, index) => {
    const medal = index === 0 ? "🥇" : index === 1 ? "🥈" : index === 2 ? "🥉" : `${index + 1}.`;
    const objetEmoji = j.objet ? ` ${config.objets[j.objet]?.emoji || ""}` : "";
    const arrivee = j.position >= config.case_arrivee ? " 🏁" : "";
    return `${medal} **${j.username}** — case ${j.position}/${config.case_arrivee}${arrivee}${objetEmoji}`;
  });
}

// ── Bilan de clôture (lignes factuelles, pas de narratif pour l'instant) ──

function formatBilanLignes(lignes, joueurs) {
  if (!lignes.length) return [];
  const nomDe = (id) => joueurs[id]?.username || "?";
  const texte = lignes
    .map((l) => {
      switch (l.type) {
        case "de":
          return `🎲 ${nomDe(l.discordId)} avance de ${l.valeur}`;
        case "objet":
          if (l.effet === "avance") return `🚀 ${nomDe(l.discordId)} avance de ${l.valeur}`;
          if (l.effet === "recul") return `💣 ${nomDe(l.discordId)} fait reculer ${nomDe(l.cibleId)} de ${l.valeur}`;
          if (l.effet === "echange") return `🍌 ${nomDe(l.discordId)} échange sa place avec ${nomDe(l.cibleId)}`;
          if (l.effet === "bloque") return `⭐ ${nomDe(l.cibleId)} est protégé(e) par son Étoile — l'objet de ${nomDe(l.discordId)} n'a aucun effet`;
          return null;
        case "sort":
          if (l.effet === "bloque") return `⭐ ${nomDe(l.cibleId)} est protégé(e) par son Étoile — le sort de ${nomDe(l.discordId)} n'a aucun effet`;
          return `✨ ${nomDe(l.discordId)} lance un sort sur ${nomDe(l.cibleId)} : *${l.sortLabel}*`;
        default:
          return null;
      }
    })
    .filter(Boolean);
  return texte.length ? ["", "**Bilan d'hier**", ...texte] : [];
}

// ── Embeds ───────────────────────────────────────────────────────────

function buildAnnonceEmbed(config) {
  return {
    title: "🏁 Mario Clash — Les moteurs chauffent…",
    description: [
      "Une course pas comme les autres s'annonce sur l'Arène : dés, objets spéciaux et sorts capricieux décideront qui franchira la ligne d'arrivée en tête !",
      "",
      `📅 **${config.duree_jours} jours de course**, à partir de demain — chaque jour tu peux lancer le dé, aller à la boutique, utiliser ton objet et lancer un sort.`,
      "",
      "Plus d'infos ? Clique sur *Règles* ci-dessous.",
    ].join("\n"),
    color: MARIOCLASH_COLOR,
    image: { url: illustrationUrl() },
    footer: { text: `La course commence demain à ${formatUtcTimeAsParis(8)}.` },
  };
}

// Classement et bilan de clôture vivent dans le bouton [📜 Journal] (voir
// buildJournalEmbed) — le message public reste sobre, centré sur le
// plateau et les actions du jour.
function buildJourEmbed(jour, config) {
  return {
    title: `🏁 Mario Clash — Jour ${jour}/${config.duree_jours}`,
    description: `Chaque jour : dé 🎲, boutique 🛍️, objet 🎒, sort ✨ — un point de boutique offert chaque matin. Consulte le classement et le bilan de la veille dans *Journal*.`,
    color: MARIOCLASH_COLOR,
    image: { url: boardImageUrl(jour) },
    footer: { text: `Actions avant ${formatUtcTimeAsParis(8)} demain. Une seule fois chacune par jour, modifiable jusqu'à la clôture.` },
  };
}

// ── Bouton [📜 Journal] — éphémère : classement courant + bilan de la
// veille (si un jour a déjà été clôturé).
function buildJournalEmbed(jour, config, joueurs, bilanLignes) {
  const lines = [...formatRankingLines(joueurs, config)];
  if (bilanLignes?.length) lines.push(...formatBilanLignes(bilanLignes, joueurs));
  return {
    title: `📜 Journal — Jour ${jour}/${config.duree_jours}`,
    description: lines.join("\n"),
    color: MARIOCLASH_COLOR,
  };
}

function formatMancheLine(record, isCurrent, isBest) {
  const marker = isBest ? "🏆 " : "";
  const suffix = isCurrent ? " *(cette manche)*" : "";
  return `${marker}Manche ${record.manche} — vainqueur **${record.vainqueur}** (case ${record.positionFinale})${suffix}`;
}

function buildManchesSection(manches, currentManche) {
  if (!manches.length) return [];
  const best = manches.reduce((a, b) => (b.positionFinale > a.positionFinale ? b : a));
  return ["", "**📊 Manches précédentes**", ...manches.map((m) => formatMancheLine(m, m.manche === currentManche, m.manche === best.manche))];
}

function buildFinEmbed(joueurs, config, manches, currentManche) {
  const ranking = sortedRanking(joueurs);
  const meilleurePosition = ranking[0]?.position ?? 0;
  const vainqueurs = ranking.filter((j) => j.position === meilleurePosition);
  const titreVainqueur =
    vainqueurs.length > 1
      ? `Égalité entre ${vainqueurs.map((j) => j.username).join(", ")} !`
      : `**${vainqueurs[0]?.username || "Personne"}** l'emporte !`;

  return {
    title: "🏆 Mario Clash — Course terminée !",
    description: [
      `Après ${config.duree_jours} jours de course effrénée, le drapeau à damier tombe — ${titreVainqueur}`,
      "",
      "**Classement final**",
      ...formatRankingLines(joueurs, config, 10),
      ...buildManchesSection(manches, currentManche),
      "",
      "Merci à tous les pilotes qui ont participé à cette course !",
    ].join("\n"),
    color: 0xf1c40f,
    image: { url: illustrationUrl() },
  };
}

function buildReglesEmbed(config) {
  const objetsLines = Object.values(config.objets).map(
    (o) => `${o.emoji} **${o.label}** (${o.cout} pts) — ${o.cible === "soi" ? "sur soi" : "sur un adversaire choisi"}`,
  );
  return {
    title: "📖 Règles — Mario Clash",
    description: [
      "Chaque jour, choisis librement parmi :",
      "🎲 **Lancer le dé** — avance de 1 à 6 cases (déterminé à la clôture).",
      "🛍️ **Boutique** — gagne 1 point/jour, achète 1 objet max/jour (1 seul objet possédé à la fois).",
      "🎒 **Utiliser l'objet** — active l'objet possédé (soi ou un adversaire selon l'objet), effet 1 journée.",
      "✨ **Lancer un sort** — effet aléatoire sur soi ou un adversaire, 50% de chances que ce soit négatif.",
      "",
      "**Objets spéciaux**",
      ...objetsLines,
      "",
      `Toutes les actions se résolvent une fois par jour à ${formatUtcTimeAsParis(8)}, dans l'ordre : objets actifs (Étoile) → objets utilisés → sorts → dé. L'Étoile protège de tout le reste de la journée.`,
    ].join("\n"),
    color: MARIOCLASH_COLOR,
  };
}

// ── Composants ───────────────────────────────────────────────────────

function buildUtilityRow() {
  return {
    type: 1,
    components: [{ type: 2, style: 3, label: "Règles", emoji: { name: "📖" }, custom_id: "marioclash_regles" }],
  };
}

function buildJourComponents(jour) {
  const actionRow = {
    type: 1,
    components: [
      { type: 2, style: 2, label: "Lancer le dé", emoji: { name: "🎲" }, custom_id: `marioclash_dice:${jour}` },
      { type: 2, style: 2, label: "Boutique", emoji: { name: "🛍️" }, custom_id: `marioclash_boutique:${jour}` },
      { type: 2, style: 2, label: "Utiliser objet", emoji: { name: "🎒" }, custom_id: `marioclash_item:${jour}` },
      { type: 2, style: 2, label: "Lancer un sort", emoji: { name: "✨" }, custom_id: `marioclash_spell:${jour}` },
    ],
  };
  const utilityRow = {
    type: 1,
    components: [
      { type: 2, style: 3, label: "Règles", emoji: { name: "📖" }, custom_id: "marioclash_regles" },
      { type: 2, style: 2, label: "Journal", emoji: { name: "📜" }, custom_id: "marioclash_journal" },
    ],
  };
  return [actionRow, utilityRow];
}

function buildBoutiqueSelect(jour, config, joueur) {
  return [
    {
      type: 1,
      components: [
        {
          type: 3,
          custom_id: `marioclash_boutique_select:${jour}`,
          placeholder: `Tu as ${joueur.points} point(s) de boutique`,
          options: Object.entries(config.objets).map(([id, o]) => ({
            label: `${o.label} — ${o.cout} pts`.slice(0, 100),
            value: id,
            emoji: { name: o.emoji },
          })),
        },
      ],
    },
  ];
}

function buildTargetSelectRow(customId, candidats, { includeSelf = false } = {}) {
  const options = [];
  if (includeSelf) options.push({ label: "Moi-même", value: "__self__", emoji: { name: "🙋" } });
  for (const j of candidats.slice(0, includeSelf ? 24 : 25)) {
    options.push({ label: j.username.slice(0, 100), value: j.discordId });
  }
  return [{ type: 1, components: [{ type: 3, custom_id: customId, placeholder: "Choisis une cible", options }] }];
}

// ── Publication quotidienne (appelée uniquement par scripts/postMarioClash.js) ──

export async function postMarioClash(channelId, { dryRun = false, noPing = false, isPublic = false, requireActiveState = false, force = false } = {}) {
  const config = await loadMarioClashConfig();
  const state = await readState();

  if (state?.termine) return { termine: true };

  if (state && !dryRun && !force && isTooSoonSinceLastClosure(state.publishedAt)) {
    return { skipped: true, reason: "tooSoonSinceLastClosure", publishedAt: state.publishedAt };
  }
  if (state && state.channelId !== channelId) {
    return { wrongChannel: true, activeChannelId: state.channelId };
  }
  if (!state && requireActiveState) {
    return { skipped: true };
  }

  // 1) Aucun état -> jour de présentation
  if (!state) {
    const embed = buildAnnonceEmbed(config);
    const components = [buildUtilityRow()];
    if (dryRun) {
      const pingRoleId = !noPing ? await getRoleIdByName(MINI_JEUX_ROLE_NAME) : null;
      return { dryRun: true, phase: "annonce", embed, components, pingRoleId };
    }
    return publishAndWriteState(channelId, null, { phase: "annonce", jour: null, embed, components, noPing, estAnnonce: true });
  }

  // 2) Transition présentation -> Jour 1 : rien à clôturer
  if (state.phase === "annonce") {
    const jour = 1;
    const embed = buildJourEmbed(jour, config);
    const components = buildJourComponents(jour);
    if (dryRun) return { dryRun: true, phase: "jour", jour, embed, components };
    return publishAndWriteState(channelId, state, { phase: "jour", jour, embed, components, noPing: true, estAnnonce: false });
  }

  // 3) Clôture normale d'un jour de course — previewCloture() (lecture
  // seule) en dry-run, closeDayAndAdvance() (persiste) sinon ; même forme
  // de retour dans les deux cas (voir marioclash.js).
  const closure = dryRun ? await previewCloture(state.jour, config) : await closeDayAndAdvance(state.jour, config);

  if (closure.termine) {
    let currentManche = null;
    const ranking = sortedRanking(closure.joueurs);
    if (!dryRun && isPublic) {
      currentManche = await archiveManche({
        vainqueur: ranking[0]?.username || "Personne",
        positionFinale: ranking[0]?.position || 0,
        resolvedAt: new Date().toISOString(),
      });
    }
    const manches = await listManches({ limit: 10 });
    const embed = buildFinEmbed(closure.joueurs, config, manches, currentManche);
    if (dryRun) return { dryRun: true, final: true, embed, closure };
    const result = await publishAndWriteState(channelId, state, {
      phase: "jour",
      jour: state.jour,
      embed,
      components: [],
      noPing,
      estAnnonce: false,
      termine: true,
    });
    return { ...result, final: true };
  }

  const embed = buildJourEmbed(closure.jourSuivant, config);
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
        console.warn(`[MarioClash] Échec suppression du message de la veille (${delRes.status}), publication quand même.`);
      }
    } catch (err) {
      console.warn("[MarioClash] Erreur réseau à la suppression du message de la veille:", err.message);
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

// ── Édition en place (réponses éphémères) ───────────────────────────

async function patchOriginal(webhookUrl, payload) {
  if (!webhookUrl) return;
  try {
    await fetch(`${webhookUrl}/messages/@original`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  } catch (err) {
    console.error("[MarioClash] Échec PATCH:", err.message);
  }
}

async function guardActiveDay(webhookUrl, jour) {
  const state = await readState();
  if (!state || state.phase !== "jour" || state.termine || String(state.jour) !== String(jour)) {
    await patchOriginal(webhookUrl, { content: "La journée a changé entre-temps — regarde le nouveau message !", embeds: [], components: [] });
    return null;
  }
  return state;
}

// ── Bouton [🎲 Lancer le dé] ─────────────────────────────────────────

export async function handleDiceButton(webhookUrl, jour, discordId, username) {
  try {
    if (!(await guardActiveDay(webhookUrl, jour))) return;
    await ensureJoueur(discordId, username);
    const actions = await readActions(jour);
    if (actions[discordId]?.dice) {
      await patchOriginal(webhookUrl, { content: "🎲 Tu as déjà lancé le dé aujourd'hui — résultat à la clôture !", embeds: [], components: [] });
      return;
    }
    await recordDiceRoll(jour, discordId);
    await patchOriginal(webhookUrl, { content: "🎲 Dé lancé — résultat révélé à la clôture du jour !", embeds: [], components: [] });
  } catch (err) {
    console.error("[MarioClash] Échec bouton dé:", err.message);
  }
}

// ── Bouton [🛍️ Boutique] + select d'achat ───────────────────────────

export async function handleBoutiqueButton(webhookUrl, jour, discordId, username) {
  try {
    if (!(await guardActiveDay(webhookUrl, jour))) return;
    const config = await loadMarioClashConfig();
    const joueur = await ensureJoueur(discordId, username);
    if (joueur.objet) {
      await patchOriginal(webhookUrl, {
        content: `🛍️ Tu possèdes déjà ${config.objets[joueur.objet]?.emoji || ""} **${config.objets[joueur.objet]?.label}** — utilise-le ou attends qu'il soit consommé avant d'en racheter un.`,
        embeds: [],
        components: [],
      });
      return;
    }
    if (joueur.dernierAchatJour === Number(jour)) {
      await patchOriginal(webhookUrl, { content: "🛍️ Tu as déjà acheté un objet aujourd'hui — un seul achat par jour.", embeds: [], components: [] });
      return;
    }
    await patchOriginal(webhookUrl, { content: "🛍️ Choisis ton objet :", embeds: [], components: buildBoutiqueSelect(jour, config, joueur) });
  } catch (err) {
    console.error("[MarioClash] Échec bouton boutique:", err.message);
  }
}

export async function handleBoutiqueSelect(webhookUrl, jour, discordId, username, itemId) {
  try {
    if (!(await guardActiveDay(webhookUrl, jour))) return;
    const config = await loadMarioClashConfig();
    const result = await purchaseItem(discordId, username, itemId, Number(jour), config);
    const item = config.objets[itemId];
    if (result.status === "ok") {
      await patchOriginal(webhookUrl, { content: `🛍️ Acheté : ${item.emoji} **${item.label}** ! Utilise-le avec le bouton *Utiliser objet*.`, embeds: [], components: [] });
    } else if (result.status === "insufficientPoints") {
      await patchOriginal(webhookUrl, { content: `🛍️ Pas assez de points (tu as ${result.joueur.points}, il en faut ${item.cout}).`, embeds: [], components: [] });
    } else if (result.status === "alreadyHasItem") {
      await patchOriginal(webhookUrl, { content: "🛍️ Tu possèdes déjà un objet.", embeds: [], components: [] });
    } else if (result.status === "alreadyPurchasedToday") {
      await patchOriginal(webhookUrl, { content: "🛍️ Tu as déjà acheté un objet aujourd'hui.", embeds: [], components: [] });
    } else {
      await patchOriginal(webhookUrl, { content: "🛍️ Achat impossible.", embeds: [], components: [] });
    }
  } catch (err) {
    console.error("[MarioClash] Échec select boutique:", err.message);
  }
}

// ── Bouton [🎒 Utiliser objet] + select de cible ────────────────────

export async function handleItemButton(webhookUrl, jour, discordId, username) {
  try {
    if (!(await guardActiveDay(webhookUrl, jour))) return;
    const config = await loadMarioClashConfig();
    const joueur = await ensureJoueur(discordId, username);
    if (!joueur.objet) {
      await patchOriginal(webhookUrl, { content: "🎒 Tu ne possèdes aucun objet spécial — achète-en un à la boutique !", embeds: [], components: [] });
      return;
    }
    const actions = await readActions(jour);
    if (actions[discordId]?.item) {
      await patchOriginal(webhookUrl, { content: "🎒 Tu as déjà activé ton objet aujourd'hui.", embeds: [], components: [] });
      return;
    }
    const item = config.objets[joueur.objet];
    if (item.cible === "soi") {
      await recordItemUse(jour, discordId, null);
      await patchOriginal(webhookUrl, { content: `${item.emoji} ${item.label} activé pour aujourd'hui !`, embeds: [], components: [] });
      return;
    }
    const joueurs = await readJoueurs();
    const candidats = Object.entries(joueurs)
      .filter(([id]) => id !== discordId)
      .map(([id, j]) => ({ discordId: id, username: j.username }));
    if (!candidats.length) {
      await patchOriginal(webhookUrl, { content: "🎒 Aucun autre joueur à cibler pour l'instant.", embeds: [], components: [] });
      return;
    }
    const components = buildTargetSelectRow(`marioclash_item_target:${jour}`, candidats);
    await patchOriginal(webhookUrl, { content: `${item.emoji} Choisis ta cible pour ${item.label} :`, embeds: [], components });
  } catch (err) {
    console.error("[MarioClash] Échec bouton objet:", err.message);
  }
}

export async function handleItemTargetSelect(webhookUrl, jour, discordId, targetId) {
  try {
    if (!(await guardActiveDay(webhookUrl, jour))) return;
    const config = await loadMarioClashConfig();
    const joueur = await readJoueur(discordId);
    if (!joueur?.objet) {
      await patchOriginal(webhookUrl, { content: "🎒 Tu ne possèdes plus d'objet.", embeds: [], components: [] });
      return;
    }
    const actions = await readActions(jour);
    if (actions[discordId]?.item) {
      await patchOriginal(webhookUrl, { content: "🎒 Tu as déjà activé ton objet aujourd'hui.", embeds: [], components: [] });
      return;
    }
    await recordItemUse(jour, discordId, targetId);
    const cible = await readJoueur(targetId);
    const item = config.objets[joueur.objet];
    await patchOriginal(webhookUrl, { content: `${item.emoji} ${item.label} activé sur **${cible?.username || "?"}** — effet révélé à la clôture !`, embeds: [], components: [] });
  } catch (err) {
    console.error("[MarioClash] Échec select cible objet:", err.message);
  }
}

// ── Bouton [✨ Lancer un sort] + select de cible ─────────────────────

export async function handleSpellButton(webhookUrl, jour, discordId, username) {
  try {
    if (!(await guardActiveDay(webhookUrl, jour))) return;
    await ensureJoueur(discordId, username);
    const actions = await readActions(jour);
    if (actions[discordId]?.spell) {
      await patchOriginal(webhookUrl, { content: "✨ Tu as déjà lancé un sort aujourd'hui.", embeds: [], components: [] });
      return;
    }
    const joueurs = await readJoueurs();
    const candidats = Object.entries(joueurs)
      .filter(([id]) => id !== discordId)
      .map(([id, j]) => ({ discordId: id, username: j.username }));
    const components = buildTargetSelectRow(`marioclash_spell_target:${jour}`, candidats, { includeSelf: true });
    await patchOriginal(webhookUrl, { content: "✨ Choisis la cible de ton sort (toi-même ou un adversaire) :", embeds: [], components });
  } catch (err) {
    console.error("[MarioClash] Échec bouton sort:", err.message);
  }
}

export async function handleSpellTargetSelect(webhookUrl, jour, discordId, selectedValue) {
  try {
    if (!(await guardActiveDay(webhookUrl, jour))) return;
    const actions = await readActions(jour);
    if (actions[discordId]?.spell) {
      await patchOriginal(webhookUrl, { content: "✨ Tu as déjà lancé un sort aujourd'hui.", embeds: [], components: [] });
      return;
    }
    const targetId = selectedValue === "__self__" ? discordId : selectedValue;
    await recordSpellCast(jour, discordId, targetId);
    const cibleLabel = targetId === discordId ? "toi-même" : `**${(await readJoueur(targetId))?.username || "?"}**`;
    await patchOriginal(webhookUrl, { content: `✨ Sort lancé sur ${cibleLabel} — effet révélé à la clôture !`, embeds: [], components: [] });
  } catch (err) {
    console.error("[MarioClash] Échec select cible sort:", err.message);
  }
}

// ── Bouton [📜 Journal] (éphémère) — classement courant + bilan de la veille ──

export async function handleJournal(webhookUrl) {
  try {
    const state = await readState();
    if (!state || state.phase !== "jour") {
      await patchOriginal(webhookUrl, { content: "Aucun journal disponible pour l'instant.", embeds: [], components: [] });
      return;
    }
    const config = await loadMarioClashConfig();
    const joueurs = await readJoueurs();
    const veille = state.jour > 1 ? await getHistoriqueEntry(state.jour - 1) : null;
    const embed = buildJournalEmbed(state.jour, config, joueurs, veille?.lignes);
    await patchOriginal(webhookUrl, { embeds: [embed], components: [] });
  } catch (err) {
    console.error("[MarioClash] Échec Journal:", err.message);
  }
}

// ── Bouton [📖 Règles] (éphémère, statique) ──────────────────────────

export async function handleRegles(webhookUrl) {
  try {
    const config = await loadMarioClashConfig();
    await patchOriginal(webhookUrl, { embeds: [buildReglesEmbed(config)], components: [] });
  } catch (err) {
    console.error("[MarioClash] Échec Règles:", err.message);
  }
}
