// ============================================================
// bossraid.js — Handlers Discord pour Boss Raid (jeu de combinaison
// stratégique communautaire contre un Boss Colossal). Embed, boutons de
// vote, bouton Espionne (projection live + indice de note), Règles &
// Rôles, Journal. La publication/suppression quotidienne passe uniquement
// par scripts/postBossRaid.js (postBossRaid) — les boutons restent gérés
// par api/discord/interactions.js.
//
// ⚠️ Refonte stratégique (voir CONTRIBUTING.md) : plus aucun aléatoire
// nulle part, plus de régénération nocturne. Chaque jour repart de la même
// posture de base (aucune progressbar : juste "5/10"). L'objectif devient
// de faire coïncider la répartition des votes du jour avec la MEILLEURE
// combinaison possible pour l'événement du jour (computeBestCombo() dans
// backend/services/bossraid.js) — noté SS/S/A/B/C/D. Les anciennes
// "Ultimes" déclenchées par vote (All-In) ont disparu, remplacées par un
// bonus/malus de dégâts basé sur la PERFORMANCE des 1-2 jours précédents
// (resolveUltimateMultiplier() — voir buildUltimateLine()).
// ============================================================

import {
  loadBossRaidConfig,
  loadNarratifs,
  readState,
  writeState,
  recordVote,
  tallyVotes,
  listHistorique,
  readDernierRole,
  isChevalierVoteAllowed,
  activeEventForDay,
  resolveDayParams,
  previewCloture,
  closeDayAndAdvance,
  archiveManche,
  listManches,
  isTooSoonSinceLastClosure,
  cumulativeScore,
  resolveUltimateMultiplier,
  ACTION_ROLES,
} from "../../../backend/services/bossraid.js";
import {
  getRoleIdByName,
  buildRolePingFields,
  MINI_JEUX_ROLE_NAME,
} from "../../../backend/services/discordRoles.js";
import { formatUtcTimeAsParis } from "../../../backend/services/dateUtils.js";

const BOSSRAID_COLOR = 0xc0392b;
const TRUST_ROYALE_URL = "https://trustroyale.vercel.app";

// Libellés pluriels pour la phrase "rôle dominant de la veille" (le label
// singulier de la config, ex. "Voleuse", ne convient pas au pluriel).
const ROLE_LABEL_PLURAL = {
  voleuse: "Voleuses",
  sorcier: "Sorciers",
  archeres: "Archères",
};

// Illustration du jour — fichiers statiques frontend/public/images/boss/
// (boss-01.webp à boss-10.webp), servis tels quels par Vercel, même
// principe que robinsonImageUrl() dans api/discord/_handlers/robinson.js.
// Affichée uniquement à partir du Jour 1 (jamais au jour d'annonce).
function bossRaidImageUrl(jour) {
  return `${TRUST_ROYALE_URL}/images/boss/boss-${String(jour).padStart(2, "0")}.webp`;
}

// ── Formatage d'une combinaison (répartition de votes sur les 4 rôles
// d'action, dans l'ordre 🛡️🗡️🔮🏹) ─────────────────────────────────────

function formatCombo(counts, config) {
  return ACTION_ROLES.map((roleId) => `${counts[roleId] || 0}${config.roles[roleId].emoji}`).join(" ");
}

function formatScore(score) {
  return score ?? "—";
}

// ── Texte narratif ────────────────────────────────────────────────
// Les variantes de phrases vivent dans data/bossraid/narratifs.json (pas
// dans le code), même principe que Robinson/Tamagoshi. La sélection est
// déterministe (indexée par le jour, pas Math.random()) : le narratif ne
// doit jamais changer entre deux ré-affichages du MÊME jour (ex. après
// chaque clic de vote qui repatch l'embed), seulement d'un jour à l'autre.

function pickFlavor(pool, seed) {
  if (!pool?.length) return "";
  return pool[((seed % pool.length) + pool.length) % pool.length];
}

// Rôle ayant porté le plus de dégâts la veille (Chevalier/Espion exclus,
// toujours à 0) — remplace l'ancien "combattants les plus offensifs
// nommément" : les dégâts étant désormais fixes par rôle, distinguer des
// individus n'aurait plus de sens, seul le rôle choisi compte.
function pickDominantRole(breakdown) {
  if (!breakdown) return null;
  const entries = Object.entries(breakdown).filter(([, v]) => v > 0);
  if (!entries.length) return null;
  entries.sort((a, b) => b[1] - a[1]);
  return entries[0][0];
}

async function buildNarrative(jour, closure) {
  const narratifs = await loadNarratifs();
  const intro = pickFlavor(narratifs.intro_cocasse, jour);
  if (!closure) return intro; // Jour 1 : pas de bilan de la veille, juste le mot d'ambiance

  const lines = [];
  const dominantRole = pickDominantRole(closure.breakdown);
  if (dominantRole) {
    const template = pickFlavor(narratifs.role_dominant, jour + 3);
    const phrase = template.replaceAll("{role}", ROLE_LABEL_PLURAL[dominantRole] || dominantRole);
    if (lines.length) {
      lines[lines.length - 1] += ` ${phrase}`;
    } else {
      lines.push(phrase);
    }
  }

  if (!lines.length) return intro;
  return `${intro}\n\n${lines.join("\n")}`;
}

// ── Bilan du jour clos (combinaison optimale vs combinaison réelle) ──
// Partagé entre l'embed de combat (bilan de la veille, condensé) et le
// bouton Journal (même bilan, plus l'historique complet) — jamais deux
// formats différents pour la même information.

// ── Ultime — bonus/malus de dégâts basé sur les scores des 1-2 jours
// précédents (resolveUltimateMultiplier() dans backend/services/bossraid.js).
// `null` (donc aucune ligne) tant que le multiplicateur est neutre (1) —
// Jour 1/2, ou score A/B hier.

function buildUltimateLine(ultimate) {
  if (ultimate.multiplier === 1.3) {
    return "⚡ Vous avez atteint un score de S ou plus deux jours de suite, vos dégâts sont augmentés de 30% aujourd’hui !";
  }
  if (ultimate.multiplier === 1.1) {
    return "⚡ Hier vous avez atteint un score de S ou plus, vos dégâts sont augmentés de 10% aujourd’hui !";
  }
  if (ultimate.multiplier === 0.9) {
    return "⚡ Hier vous avez atteint un score de C ou moins, vos dégâts sont diminués de 10% aujourd’hui !";
  }
  return null;
}

function buildBilanLines(jourClos, closure, config) {
  return [
    `**Bilan du Jour ${jourClos}**`,
    "Hier, la meilleure combinaison était :",
    `- ${formatCombo(closure.bestCombo, config)} *(dégâts ${closure.bestDamage}pts)*`,
    "Votre combinaison était :",
    `- ${formatCombo(closure.actionCounts, config)} *(dégâts ${closure.totalDamageDuJour}pts)*`,
    `- score : **${formatScore(closure.score)}**`,
  ];
}

function buildAnnonceEmbed(config) {
  return {
    title: "⚔️ Boss Raid — Kiki le P.E.K.K.A. approche…",
    description: [
      `Un P.E.K.K.A. répondant au doux nom de **Kiki** s’apprête à fondre sur le clan ! Rassemblez vos forces : ${config.duree_jours} jours de combat commencent dès demain.`,
      "",
      `🛡️ Défense de base : **${config.boss_stats_base.defense}/10** — 🔮 Résistance de base : **${config.boss_stats_base.resistance}/10**, chaque jour (sauf événement contraire).`,
      "",
      "Chevaliers, Voleuses, Sorciers, Archères, Espionnes — chaque jour impose sa propre combinaison gagnante. Besoin d’un rappel des règles ? Clique sur *Règles* ci-dessous.",
    ].join("\n"),
    color: BOSSRAID_COLOR,
    // ?v=2 : casse le cache Discord (qui met en cache par URL l'échec d'un
    // premier fetch raté juste après déploiement) — changer ce numéro si
    // l'image ne réapparaît toujours pas après un nouveau post.
    image: { url: `${TRUST_ROYALE_URL}/images/boss/boss-start.webp?v=2` },
    footer: {
      text: `Le combat commence demain à ${formatUtcTimeAsParis(8)}.`,
    },
  };
}

async function buildCombatEmbed(jour, jourClos, closure, event, config, state) {
  const dayParams = resolveDayParams(jour, config);
  const narrative = await buildNarrative(jour, closure);
  const lines = [narrative, ""];

  if (closure) {
    lines.push(...buildBilanLines(jourClos, closure, config), "");
  }

  const ultimate = await resolveUltimateMultiplier(jour);
  const ultimateLine = buildUltimateLine(ultimate);
  if (ultimateLine) lines.push(ultimateLine, "");

  if (event) {
    lines.push(
      `**${event.emoji} Événement du jour : ${event.nom}**`,
      event.description,
      "",
    );
  }

  const scoreCumule = cumulativeScore(state.totalDegatsCumules, state.totalDegatsOptimalCumules);
  lines.push(
    `🛡️ Défense    : **${dayParams.defense}/10**`,
    `🔮 Résistance : **${dayParams.resistance}/10**`,
    "",
    `⚔️ Dégâts cumulés : **${state.totalDegatsCumules}** — 🏆 Score cumulé : **${formatScore(scoreCumule)}**`,
  );

  return {
    title: `⚔️ Boss Raid — Jour ${jour}/${config.duree_jours}`,
    description: lines.join("\n"),
    color: BOSSRAID_COLOR,
    image: { url: bossRaidImageUrl(jour) },
    footer: {
      text: `Votez avant ${formatUtcTimeAsParis(8)} demain pour orienter la journée. Vote modifiable jusqu’à la clôture.`,
    },
  };
}

function buildComponents(jour, phase, voteCounts, config) {
  const utilityRow = {
    type: 1,
    components: [
      {
        type: 2,
        style: 3,
        label: "Règles",
        emoji: { name: "📖" },
        custom_id: "bossraid_regles",
      },
      {
        type: 2,
        style: 2,
        label: "Journal",
        emoji: { name: "📜" },
        custom_id: "bossraid_journal",
      },
    ],
  };

  if (phase !== "combat") return [utilityRow];

  const voteRow = {
    type: 1,
    components: Object.entries(config.roles).map(([roleId, role]) => ({
      type: 2,
      style: 2,
      label: `${role.label} (${voteCounts[roleId] || 0})`.slice(0, 80),
      emoji: { name: role.emoji },
      custom_id:
        roleId === "espion"
          ? `bossraid_espion:${jour}`
          : `bossraid_vote:${jour}:${roleId}`,
    })),
  };

  return [voteRow, utilityRow];
}

// Le jeu est rejoué plusieurs fois dans l'année : la manche qui vient de se
// terminer est comparée aux précédentes (manches, currentManche — voir
// archiveManche()/listManches() dans bossraid.js), avec un 🏆 sur le
// meilleur total de dégâts toutes manches confondues.

function formatMancheLine(record, isCurrent, isBest) {
  const marker = isBest ? "🏆 " : "";
  const suffix = isCurrent ? " *(cette manche)*" : "";
  return `${marker}Manche ${record.manche} — **${record.totalDegatsCumules}** dégâts (score ${formatScore(record.scoreFinal)})${suffix}`;
}

function buildManchesSection(manches, currentManche) {
  if (!manches.length) return [];
  const best = manches.reduce((a, b) =>
    b.totalDegatsCumules > a.totalDegatsCumules ? b : a,
  );
  return [
    "",
    "**📊 Manches précédentes**",
    ...manches.map((m) =>
      formatMancheLine(m, m.manche === currentManche, m.manche === best.manche),
    ),
  ];
}

function buildOutcomeEmbed(
  totalDegatsCumules,
  scoreFinal,
  config,
  manches = [],
  currentManche = null,
) {
  return {
    title: "🏆 Boss Raid terminé !",
    description: [
      `Après ${config.duree_jours} jours de combat acharné, Kiki le P.E.K.K.A. se retire enfin — le clan a tenu bon jusqu’au bout !`,
      "",
      `💥 **Dégâts totaux infligés à Kiki : ${totalDegatsCumules}**`,
      `🏆 **Score final : ${formatScore(scoreFinal)}**`,
      ...buildManchesSection(manches, currentManche),
      "",
      "Merci à tous les combattants qui ont participé à ce Raid !",
    ].join("\n"),
    color: 0xf1c40f,
    image: { url: bossRaidImageUrl(config.duree_jours) },
  };
}

// ── Publication quotidienne (appelée uniquement par scripts/postBossRaid.js) ──

export async function postBossRaid(
  channelId,
  {
    dryRun = false,
    noPing = false,
    isPublic = false,
    requireActiveState = false,
    force = false,
  } = {},
) {
  const config = await loadBossRaidConfig();
  const state = await readState();

  if (state?.termine) {
    return { termine: true };
  }

  // Garde-fou anti-double-avancée : un cron en retard qui se déclencherait
  // juste après une relance manuelle du même jour clôturerait un jour tout
  // juste ouvert (même incident/pattern que Robinson, 26/08). Jamais
  // appliqué en dry-run. `force` permet un rattrapage volontaire en test.
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

  // Garde-fou : un Raid actif sur un AUTRE salon ne doit JAMAIS être repris
  // ici — sinon un Raid de test oublié actif fuiterait dans le salon public
  // au prochain cron (et inversement). Voir l'incident réel du 23/08/2026 sur
  // Quiz, même cause (état partagé test/public sans contrôle de salon), qui a
  // motivé ce garde-fou sur tous les jeux à avancée quotidienne.
  if (state && state.channelId !== channelId) {
    return { wrongChannel: true, activeChannelId: state.channelId };
  }

  // Le cron quotidien ne fait qu'avancer un Raid déjà lancé manuellement — il
  // ne doit jamais poster l'annonce/Jour 1 tout seul (voir workflow_dispatch
  // vs schedule dans .github/workflows/bossraid.yml).
  if (!state && requireActiveState) {
    return { skipped: true };
  }

  // 1) Aucun état -> jour d'annonce (pas de vote possible, ping éventuel)
  if (!state) {
    const embed = buildAnnonceEmbed(config);
    const components = buildComponents(null, "annonce", {}, config);

    if (dryRun) {
      const pingRoleId = !noPing
        ? await getRoleIdByName(MINI_JEUX_ROLE_NAME)
        : null;
      return { dryRun: true, phase: "annonce", embed, components, pingRoleId };
    }

    return publishAndWriteState(channelId, null, {
      phase: "annonce",
      jour: null,
      totalDegatsCumules: 0,
      totalDegatsOptimalCumules: 0,
      embed,
      components,
      noPing,
      estAnnonce: true,
    });
  }

  // 2) Transition annonce -> Jour 1 : rien à clôturer (aucun vote possible avant), jamais de ping ici
  if (state.phase === "annonce") {
    const jour = 1;
    const event = activeEventForDay(jour, config.evenements_boss);
    const embed = await buildCombatEmbed(jour, null, null, event, config, state);
    const components = buildComponents(jour, "combat", {}, config);

    if (dryRun)
      return { dryRun: true, phase: "combat", jour, embed, components, event };

    return publishAndWriteState(channelId, state, {
      phase: "combat",
      jour,
      totalDegatsCumules: state.totalDegatsCumules,
      totalDegatsOptimalCumules: state.totalDegatsOptimalCumules,
      embed,
      components,
      noPing: true,
      estAnnonce: false,
    });
  }

  // 3) Clôture normale d'un jour de combat
  const closure = dryRun
    ? await previewCloture(state.jour, config)
    : await closeDayAndAdvance(state.jour, config);

  const jourSuivant = state.jour + 1;

  // Fin de partie (duree_jours écoulés) — score final, plus aucun vote possible.
  if (jourSuivant > config.duree_jours) {
    const scoreFinal = cumulativeScore(closure.totalDegatsApres, closure.totalDegatsOptimalApres);
    // Archivage AVANT lecture de la liste : la manche qui vient de se
    // terminer apparaît alors dans son propre récap comparatif (marquée
    // "cette manche"). Jamais archivé en dry-run NI sur le salon de test
    // (isPublic) — seule une vraie publication sur le salon public compte
    // comme une manche réelle, pour ne jamais polluer l'archive avec des
    // parties de test (voir CONTRIBUTING.md, section Manches).
    let currentManche = null;
    if (!dryRun && isPublic) {
      currentManche = await archiveManche({
        totalDegatsCumules: closure.totalDegatsApres,
        scoreFinal,
        resolvedAt: new Date().toISOString(),
      });
    }
    const manches = await listManches({ limit: 10 });
    const embed = buildOutcomeEmbed(
      closure.totalDegatsApres,
      scoreFinal,
      config,
      manches,
      currentManche,
    );
    if (dryRun) return { dryRun: true, final: true, embed, closure };
    const result = await publishAndWriteState(channelId, state, {
      phase: "combat",
      jour: state.jour,
      totalDegatsCumules: closure.totalDegatsApres,
      totalDegatsOptimalCumules: closure.totalDegatsOptimalApres,
      embed,
      components: [],
      noPing,
      estAnnonce: false,
      termine: true,
    });
    return { ...result, final: true };
  }

  const event = activeEventForDay(jourSuivant, config.evenements_boss);
  const nextState = {
    ...state,
    totalDegatsCumules: closure.totalDegatsApres,
    totalDegatsOptimalCumules: closure.totalDegatsOptimalApres,
  };
  const embed = await buildCombatEmbed(jourSuivant, state.jour, closure, event, config, nextState);
  const components = buildComponents(jourSuivant, "combat", {}, config);

  if (dryRun)
    return {
      dryRun: true,
      jour: jourSuivant,
      embed,
      components,
      event,
      closure,
    };

  return publishAndWriteState(channelId, state, {
    phase: "combat",
    jour: jourSuivant,
    totalDegatsCumules: closure.totalDegatsApres,
    totalDegatsOptimalCumules: closure.totalDegatsOptimalApres,
    embed,
    components,
    noPing: true,
    estAnnonce: false,
  });
}

// Supprime l'ancien message (tolérant), poste le nouveau, écrit l'état.
// Mirroring publishAndWriteState() dans api/discord/_handlers/robinson.js.
async function publishAndWriteState(
  channelId,
  previousState,
  {
    phase,
    jour,
    totalDegatsCumules,
    totalDegatsOptimalCumules,
    embed,
    components,
    noPing,
    estAnnonce,
    termine = false,
  },
) {
  const token = process.env.DISCORD_TOKEN;
  if (!token) throw new Error("DISCORD_TOKEN manquant.");

  if (previousState?.messageId && previousState?.channelId) {
    try {
      const delRes = await fetch(
        `https://discord.com/api/v10/channels/${previousState.channelId}/messages/${previousState.messageId}`,
        { method: "DELETE", headers: { Authorization: `Bot ${token}` } },
      );
      if (!delRes.ok && delRes.status !== 404) {
        console.warn(
          `[BossRaid] Échec suppression du message de la veille (${delRes.status}), publication du nouveau jour quand même.`,
        );
      }
    } catch (err) {
      console.warn(
        "[BossRaid] Erreur réseau à la suppression du message de la veille:",
        err.message,
      );
    }
  }

  // Ping réservé au jour d'annonce (lancement) et à la fin de manche —
  // jamais pour les jours intermédiaires.
  const roleId =
    (estAnnonce || termine) && !noPing
      ? await getRoleIdByName(MINI_JEUX_ROLE_NAME)
      : null;

  const res = await fetch(
    `https://discord.com/api/v10/channels/${channelId}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bot ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        embeds: [embed],
        components,
        ...buildRolePingFields(roleId),
      }),
    },
  );
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Erreur envoi salon Discord (${res.status}): ${errText}`);
  }
  const message = await res.json();

  await writeState({
    phase,
    jour,
    channelId,
    messageId: message.id,
    publishedAt: new Date().toISOString(),
    termine,
    totalDegatsCumules,
    totalDegatsOptimalCumules,
  });

  return { jour, embed, message, termine };
}

// ── Édition en place (réponses aux interactions) ──────────────────

async function patchOriginal(webhookUrl, payload) {
  if (!webhookUrl) return;
  try {
    await fetch(`${webhookUrl}/messages/@original`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    console.error("[BossRaid] Échec PATCH:", err.message);
  }
}

// Message de suivi ÉPHÉMÈRE (visible uniquement par l'auteur du clic),
// indépendant du message public — utilisé pour le rejet Chevalier : le
// message public (édité par le type 6 déjà acquitté) ne doit PAS changer,
// seul l'auteur doit voir pourquoi son vote n'a pas été enregistré.
async function postFollowup(webhookUrl, payload) {
  if (!webhookUrl) return;
  try {
    await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...payload, flags: 64 }),
    });
  } catch (err) {
    console.error("[BossRaid] Échec followup:", err.message);
  }
}

async function renderCombatPayload(state, config) {
  const voteCounts = await tallyVotes(state.jour);
  const event = activeEventForDay(state.jour, config.evenements_boss);
  // Le message public ne montre jamais le bilan de la veille après coup
  // (uniquement au moment de la publication du jour) — un simple
  // re-render suite à un clic de vote ne doit pas ressasser le bilan.
  const embed = await buildCombatEmbed(state.jour, state.jour - 1, null, event, config, state);
  const components = buildComponents(
    state.jour,
    state.phase,
    voteCounts,
    config,
  );
  return { embed, components };
}

// ── Boutons de vote (Chevalier/Voleuse/Sorcier/Archères) ────────────
// Vote MODIFIABLE jusqu'au cron : pas de tirage au clic, juste un HSET
// écrasable + réaffichage du message public en place (type 6, géré par le
// routeur), aucun éphémère ici.

export async function handleVoteButton(
  webhookUrl,
  jour,
  roleId,
  discordId,
  username,
) {
  try {
    const state = await readState();
    const config = await loadBossRaidConfig();

    if (
      !state ||
      state.termine ||
      state.phase !== "combat" ||
      String(state.jour) !== String(jour)
    ) {
      // Jour changé entre le clic et le traitement : on réaffiche l'état
      // courant sans enregistrer un vote périmé.
      if (state && state.phase === "combat" && !state.termine) {
        const { embed, components } = await renderCombatPayload(state, config);
        await patchOriginal(webhookUrl, { embeds: [embed], components });
      }
      return;
    }

    if (roleId === "chevalier") {
      const dernierRole = await readDernierRole(discordId);
      if (!isChevalierVoteAllowed(dernierRole)) {
        await postFollowup(webhookUrl, {
          content:
            "🛡️ Tu as protégé le camp hier — impossible de voter Chevalier 2 jours de suite, choisis un autre rôle aujourd’hui !",
        });
        return;
      }
    }

    await recordVote(jour, discordId, roleId, username);

    const { embed, components } = await renderCombatPayload(state, config);
    await patchOriginal(webhookUrl, { embeds: [embed], components });
  } catch (err) {
    console.error("[BossRaid] Échec traitement du vote:", err.message);
  }
}

// ── Bouton Espionne — exception : réponse éphémère avec projection live ──
// Le vote Espionne ne compte dans aucune combinaison (0 dégât, exclu du
// calcul de la meilleure combinaison), mais sa réponse est privée :
// projection des dégâts + note de combinaison du jour EN COURS
// (previewCloture, écriture nulle) + révélation de l'événement prévu pour
// le LENDEMAIN, exclusivité de ce bouton.

export async function handleEspion(
  webhookUrl,
  jour,
  discordId,
  username,
  botToken,
) {
  try {
    const state = await readState();
    if (
      !state ||
      state.termine ||
      state.phase !== "combat" ||
      String(state.jour) !== String(jour)
    ) {
      await patchOriginal(webhookUrl, {
        content:
          "Le vote du jour a déjà été clôturé, la journée a changé — regarde le nouveau message !",
        embeds: [],
        components: [],
      });
      return;
    }

    const config = await loadBossRaidConfig();
    await recordVote(jour, discordId, "espion", username);

    const projection = await previewCloture(Number(jour), config);
    const lendemain = activeEventForDay(
      Number(jour) + 1,
      config.evenements_boss,
    );

    const lines = [
      `🔍 **Projection actuelle du Jour ${jour}** (basée sur les votes en cours, sujette à changement jusqu’à ${formatUtcTimeAsParis(8)}, heure de Paris) :`,
      `💥 Dégâts projetés : **${projection.totalDamageDuJour}** *(meilleure combinaison possible : ${projection.bestDamage})*`,
      `🎯 Indice de note actuelle : **${formatScore(projection.score)}**`,
    ];
    lines.push(
      "",
      lendemain
        ? `**${lendemain.emoji} Événement prévu demain : ${lendemain.nom}** — ${lendemain.description}`
        : "Aucun événement spécial prévu pour demain.",
    );

    await patchOriginal(webhookUrl, {
      content: lines.join("\n"),
      embeds: [],
      components: [],
    });

    // Le vote Espionne fait aussi avancer le compteur "Espion (n)" du message
    // public — rafraîchi séparément en PATCH direct (bot token), même
    // découplage que Tamagotchi/Robinson pour un vote confirmé en éphémère.
    const { embed, components } = await renderCombatPayload(state, config);
    await fetch(
      `https://discord.com/api/v10/channels/${state.channelId}/messages/${state.messageId}`,
      {
        method: "PATCH",
        headers: {
          Authorization: `Bot ${botToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ embeds: [embed], components }),
      },
    );
  } catch (err) {
    console.error("[BossRaid] Échec Espionne:", err.message);
  }
}

// ── Bouton [📜 Journal] — lecture seule, hors-vote ─────────────────

function formatUltimateSuffix(multiplier) {
  if (multiplier === 1.3) return " — ⚡+30%";
  if (multiplier === 1.1) return " — ⚡+10%";
  if (multiplier === 0.9) return " — ⚡-10%";
  return "";
}

function formatHistoriqueLine(entry) {
  const evt = entry.event ? ` — ${entry.event.emoji} ${entry.event.nom}` : "";
  const ultimate = formatUltimateSuffix(entry.ultimateMultiplier);
  return `Jour ${entry.jour} : 💥 ${entry.totalDamageDuJour}pts *(meilleure combi ${entry.bestDamage}pts)* — score ${formatScore(entry.score)}${ultimate}${evt}`;
}

export async function handleJournal(webhookUrl) {
  try {
    const state = await readState();
    if (!state) {
      await patchOriginal(webhookUrl, {
        content: "Aucun Boss Raid en cours pour le moment.",
        embeds: [],
        components: [],
      });
      return;
    }

    const config = await loadBossRaidConfig();
    const scoreCumule = cumulativeScore(state.totalDegatsCumules, state.totalDegatsOptimalCumules);
    const lines = [
      `⚔️ Dégâts cumulés : **${state.totalDegatsCumules}** — 🏆 Score cumulé : **${formatScore(scoreCumule)}**`,
    ];

    const { entries } = await listHistorique({ limit: 10 });
    if (entries.length > 0) {
      const dernier = entries[0];
      lines.push(
        "",
        ...buildBilanLines(dernier.jour, dernier, config),
      );
    }
    if (entries.length > 0) {
      lines.push(
        "",
        "**Jours précédents :**",
        ...entries.map(formatHistoriqueLine),
      );
    }

    const embed = {
      title: "📜 Journal du Raid",
      description: lines.join("\n"),
      color: BOSSRAID_COLOR,
    };
    await patchOriginal(webhookUrl, { embeds: [embed], components: [] });
  } catch (err) {
    console.error("[BossRaid] Échec Journal:", err.message);
  }
}

// ── Bouton [📖 Règles & Rôles] — éphémère, statique, hors-vote ─────
// Ne consomme jamais le vote du jour, contenu généré depuis boss_raid.json.
// Les événements du Boss ne sont volontairement jamais listés ici — même
// principe que Robinson, ils restent une surprise (sauf pour l'Espionne, qui
// révèle l'événement du lendemain en exclusivité).

function buildReglesEmbed(config) {
  const lines = [
    `Le clan affronte Kiki, un P.E.K.K.A. colossal, pendant ${config.duree_jours} jours de combat. Objectif : accumuler le maximum de dégâts cumulés en trouvant, jour après jour, la MEILLEURE répartition des votes du clan entre les rôles.`,
    "",
    "🎯 **Aucun aléatoire** : tous les dégâts sont fixes. Chaque jour, une combinaison de rôles est objectivement optimale — le Journal révèle après coup quelle était cette meilleure combinaison, comparée à celle réellement votée, avec une note de **SS/S/A/B/C/D**.",
    "",
    `**Rôles (1 vote par membre et par jour, modifiable jusqu’à ${formatUtcTimeAsParis(8)}):**`,
  ];

  const chevalier = config.roles.chevalier;
  lines.push(
    `${chevalier.emoji} **${chevalier.label}** — 0 dégât, protège jusqu’à ${chevalier.protection_slots} unités à distance (Sorcier/Archères) contre le malus de non-protection. Impossible de voter Chevalier 2 jours de suite.`,
  );

  const voleuse = config.roles.voleuse;
  lines.push(
    `${voleuse.emoji} **${voleuse.label}** — ${voleuse.degats} dégâts fixes, jamais réduits ni affectés par la protection. Chaque vote Voleuse réduit aussi la Défense du Boss de **${voleuse.debuff_defense_par_vote}** point pour la journée (plancher 0) — un soutien direct aux Archères.`,
  );

  const sorcier = config.roles.sorcier;
  lines.push(
    `${sorcier.emoji} **${sorcier.label}** — ${sorcier.degats} dégâts de base, réduits par la Résistance du Boss (10%/point). Non protégé par un Chevalier : malus -50% (peut varier selon l’événement du jour).`,
  );

  const archeres = config.roles.archeres;
  lines.push(
    `${archeres.emoji} **${archeres.label}** — ${archeres.degats} dégâts de base, réduits par la Défense du Boss (10%/point, après débuff Voleuse éventuel). Non protégée par un Chevalier : malus -50% (peut varier selon l’événement du jour).`,
  );

  const espion = config.roles.espion;
  lines.push(
    `${espion.emoji} **${espion.label}** — 0 dégât, ne compte dans aucune combinaison. Affiche en privé la projection des dégâts du jour, un indice de note, et l’événement prévu pour le lendemain.`,
  );

  lines.push(
    "",
    `🛡️ **Chaque jour repart de la même base** : Défense et Résistance du Boss reviennent à **${config.boss_stats_base.defense}/10** et **${config.boss_stats_base.resistance}/10** — sans persistance d’un jour à l’autre.`,
    "",
    "📅 **Un événement différent chaque jour** (sauf le Jour 1) bouleverse la donne — Défense/Résistance modifiées, protection affaiblie, rôle pénalisé ou renforcé… à vous de réadapter la combinaison en conséquence. Le Boss garde ses surprises, seule l’Espionne révèle l’événement du lendemain en exclusivité.",
    "",
    "⚡ **Ultime** : un score de **S ou plus** hier octroie +10% de dégâts aujourd’hui (+30% si atteint 2 jours de suite) ; un score de **C ou moins** hier inflige -10%. Un bonus/malus commun à toute la journée, jamais d’influence sur la note (qui compare toujours au plafond théorique DU jour).",
  );

  return {
    title: "📖 Règles & Rôles — Boss Raid",
    description: lines.join("\n"),
    color: BOSSRAID_COLOR,
  };
}

export async function handleRegles(webhookUrl) {
  try {
    const config = await loadBossRaidConfig();
    const embed = buildReglesEmbed(config);
    await patchOriginal(webhookUrl, { embeds: [embed], components: [] });
  } catch (err) {
    console.error("[BossRaid] Échec Règles & Rôles:", err.message);
  }
}
