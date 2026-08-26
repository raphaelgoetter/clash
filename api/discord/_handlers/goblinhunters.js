// ============================================================
// goblinhunters.js — Handlers Discord pour Goblin Hunters (jeu à identité
// secrète/camps cachés). Embed d'inscription, embed de jour (plateau +
// bilan), boutons de lieu, select menu de cible, DM de rôle/enquête.
// La publication/clôture quotidienne passe uniquement par
// scripts/postGoblinHunters.js (postGoblinHunters) — les boutons restent
// gérés par api/discord/interactions.js.
// ============================================================

import {
  loadGoblinHuntersConfig,
  loadNarratifs,
  readState,
  writeState,
  registerPlayer,
  unregisterPlayer,
  countInscriptions,
  recordAction,
  readPlayerAction,
  isLieuRepeatAllowed,
  isActionLocked,
  previewCloture,
  closeDayAndAdvance,
  launchGame,
  listInscriptions,
  computeMinorityCount,
  assignCampsAndRoles,
  buildInitialRoster,
  readPlayerIndices,
  archiveManche,
  listManches,
  hasSentMessageToday,
  recordMessage,
  listRecentMessages,
} from "../../../backend/services/goblinhunters.js";
import {
  getRoleIdByName,
  buildRolePingFields,
  MINI_JEUX_ROLE_NAME,
} from "../../../backend/services/discordRoles.js";

const GOBLINHUNTERS_COLOR = 0x16a34a;
const TRUST_ROYALE_URL = "https://trustroyale.vercel.app";

function boardImageUrl(jour) {
  return `${TRUST_ROYALE_URL}/api/goblinhunters/image?jour=${jour}&v=${Date.now()}`;
}

function startImageUrl() {
  return `${TRUST_ROYALE_URL}/api/goblinhunters/start-image`;
}

function addDays(date, days) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

function formatDateFr(iso) {
  return new Date(iso).toLocaleString("fr-FR", {
    timeZone: "Europe/Paris",
    dateStyle: "long",
    timeStyle: "short",
  });
}

// ── Texte narratif — pool dans data/goblinhunters/narratifs.json, sélection
// déterministe par jour (comme bossraid.js/robinson.js), jamais Math.random().

function pickFlavor(pool, seed) {
  if (!pool?.length) return "";
  return pool[((seed % pool.length) + pool.length) % pool.length];
}

async function buildNarrative(jour, closure) {
  const narratifs = await loadNarratifs();
  if (!closure) return pickFlavor(narratifs.intro_cocasse, jour); // Jour 1 : pas de bilan de la veille

  const lines = [pickFlavor(narratifs.intro_cocasse, jour)];
  if (closure.eliminationsParVote === null && closure.deathIdCombat === null) {
    lines.push(pickFlavor(narratifs.pas_de_mort, jour + 1));
  } else {
    if (closure.deathIdCombat)
      lines.push(pickFlavor(narratifs.mort_combat, jour + 2));
    if (closure.eliminationsParVote)
      lines.push(pickFlavor(narratifs.mort_vote, jour + 3));
  }
  return lines.join(" ");
}

// ── Embeds / composants — inscription ────────────────────────────

function buildAnnonceInscriptionEmbed(config, closingAt) {
  return {
    title: "👺 Goblin Hunters — les inscriptions sont ouvertes !",
    description: [
      "Des Gobelins se sont infiltrés parmi nous, déguisés en villageois. Sauras-tu les démasquer avant qu'ils ne prennent le contrôle du village ?",
      "",
      `Un jeu de bluff et de déduction sur **${config.duree_jours} jours**, 1 action par jour. Inscris-toi via le bouton ci-dessous.`,
      `Effectif requis : **${config.effectif_min} à ${config.effectif_max} joueurs**.`,
    ].join("\n"),
    color: GOBLINHUNTERS_COLOR,
    image: { url: startImageUrl() },
    footer: { text: `Clôture des inscriptions : ${formatDateFr(closingAt)}.` },
  };
}

// L'image d'inscription est répétée sur les 3 gabarits (annonce/rappel/
// prolongation), pas seulement l'annonce initiale : le message d'inscription
// est PATCHé en place à chaque inscription/désinscription en réutilisant
// toujours le gabarit "rappel" (voir refreshInscriptionMessage) — sans
// l'image ici aussi, elle disparaîtrait du message dès le premier clic.
function buildInscriptionRappelEmbed(config, count, closingAt) {
  return {
    title: "👺 Goblin Hunters — inscriptions en cours",
    description: [
      `**${count}/${config.effectif_max}** joueurs inscrits pour l'instant (minimum requis : ${config.effectif_min}).`,
      "",
      "Inscris-toi via le bouton ci-dessous si ce n'est pas déjà fait !",
    ].join("\n"),
    color: GOBLINHUNTERS_COLOR,
    image: { url: startImageUrl() },
    footer: { text: `Clôture des inscriptions : ${formatDateFr(closingAt)}.` },
  };
}

function buildInscriptionReportEmbed(config, count, closingAt) {
  return {
    title: "👺 Goblin Hunters — inscriptions prolongées",
    description: [
      `Seulement **${count}** joueur(s) inscrit(s), il en faut au moins **${config.effectif_min}** pour lancer la partie.`,
      "",
      "Les inscriptions sont prolongées — parles-en autour de toi !",
    ].join("\n"),
    color: GOBLINHUNTERS_COLOR,
    image: { url: startImageUrl() },
    footer: { text: `Nouvelle clôture : ${formatDateFr(closingAt)}.` },
  };
}

function buildInscriptionComponents(count = 0) {
  return [
    {
      type: 1,
      components: [
        {
          type: 2,
          style: 3,
          label: `S'inscrire (${count})`,
          emoji: { name: "✅" },
          custom_id: "goblinhunters_register",
        },
        {
          type: 2,
          style: 4,
          label: "Se désinscrire",
          emoji: { name: "✖️" },
          custom_id: "goblinhunters_unregister",
        },
        {
          type: 2,
          style: 3,
          label: "Règles",
          emoji: { name: "📖" },
          custom_id: "goblinhunters_regles",
        },
      ],
    },
  ];
}

// ── Embeds / composants — jour de jeu ─────────────────────────────

function formatBilanLigne(joueurId, joueursApres, config) {
  const j = joueursApres.find((p) => p.discordId === joueurId);
  if (!j) return null;
  const camp = config.camps[j.camp];
  return `**${j.username}** était un(e) ${camp.emoji} **${camp.labelSingulier}**.`;
}

async function buildJourEmbed(jour, joueursApres, config, closure) {
  const narrative = await buildNarrative(jour, closure);
  const lines = [narrative, ""];

  if (closure) {
    lines.push("**Bilan du jour précédent**");
    const voteLine = closure.eliminationsParVote
      ? formatBilanLigne(closure.eliminationsParVote, joueursApres, config)
      : null;
    const combatLine = closure.deathIdCombat
      ? formatBilanLigne(closure.deathIdCombat, joueursApres, config)
      : null;
    if (voteLine) lines.push(`⚖️ Accusé(e) par le village : ${voteLine}`);
    if (combatLine) lines.push(`⚔️ Tombé(e) au combat : ${combatLine}`);
    if (!voteLine && !combatLine)
      lines.push("Personne n'a été éliminé aujourd'hui.");

    // Guet-Apens/Explosif : effets déclenchés à la mort d'un rôle spécial,
    // annoncés publiquement au même titre que le reveal de camp habituel
    // (même logique de transparence que "Révélation à l'élimination").
    if (closure.guetApensReveal) {
      for (const { attackerId, campReporte } of closure.guetApensReveal
        .attackers) {
        const attacker = joueursApres.find((p) => p.discordId === attackerId);
        const camp = config.camps[campReporte];
        lines.push(
          `🪤 Piège du Guet-Apens : **${attacker?.username || "?"}** est démasqué(e) — camp ${camp.emoji} **${camp.labelSingulier}** !`,
        );
      }
    }
    if (closure.explosifRetaliation) {
      const gobelin = joueursApres.find(
        (p) => p.discordId === closure.explosifRetaliation.gobelinId,
      );
      const target = joueursApres.find(
        (p) => p.discordId === closure.explosifRetaliation.targetId,
      );
      lines.push(
        `💣 **${gobelin?.username || "?"}** explose en mourant — **${target?.username || "?"}** encaisse ${config.roles.explosif.degats_riposte} dégât.`,
      );
    }

    lines.push("");
  }

  // Le total de Gobelins n'est PAS un secret : il découle mécaniquement de
  // l'effectif de départ via la table de ratio publique (goblinhunters.json),
  // donc n'importe quel joueur peut déjà le calculer lui-même — masquer le
  // compte en vie serait une fausse pudeur, pas un vrai secret (repéré par
  // l'utilisateur sur un "?" affiché à tort).
  const vivants = joueursApres.filter((j) => j.alive);
  const chasseursVivants = vivants.filter((j) => j.camp === "chasseur").length;
  const gobelinsVivants = vivants.filter((j) => j.camp === "gobelin").length;
  lines.push(
    `${config.camps.chasseur.emoji} Villageois en vie : **${chasseursVivants}** — ${config.camps.gobelin.emoji} Gobelins en vie : **${gobelinsVivants}**`,
  );

  // Messages de tension informatifs : préviennent quand une victoire devient
  // possible DÈS AUJOURD'HUI pour l'un des deux camps (comptes déjà publics,
  // voir plus haut — ce n'est qu'une mise en avant, pas une fuite d'info).
  // Un seul Gobelin restant -> les Villageois peuvent gagner par élimination
  // totale ; les Gobelins à 1 mort près de la parité -> ils peuvent gagner
  // dès aujourd'hui aussi. Les deux peuvent se produire en même temps en fin
  // de partie très serrée (ex. 1 Gobelin / 2 Villageois).
  const narratifs = await loadNarratifs();
  const chasseursPresDeLaVictoire = gobelinsVivants === 1;
  const gobelinsPresDeLaParite =
    gobelinsVivants > 0 && gobelinsVivants === chasseursVivants - 1;
  if (chasseursPresDeLaVictoire && gobelinsPresDeLaParite) {
    lines.push(pickFlavor(narratifs.tension_double, jour));
  } else if (chasseursPresDeLaVictoire) {
    lines.push(pickFlavor(narratifs.tension_gobelin_dernier, jour));
  } else if (gobelinsPresDeLaParite) {
    lines.push(pickFlavor(narratifs.tension_parite_proche, jour));
  }
  // Approche du Jour 10 : rappel de l'échéance (victoire par défaut des
  // Villageois si rien ne bouge), indépendant du compte de joueurs.
  if (jour >= config.duree_jours - 1) {
    lines.push(pickFlavor(narratifs.tension_derniers_jours, jour));
  }

  if (Number(jour) === 1) {
    lines.push(
      "🔒 Vote et combat n'ont aucun effet le Jour 1 — tu peux quand même te rendre au Château ou à l'Arène, mais ça ne servira à rien.",
    );
  }

  return {
    title: `👺 Goblin Hunters — Jour ${jour}/${config.duree_jours}`,
    description: lines.join("\n"),
    color: GOBLINHUNTERS_COLOR,
    image: { url: boardImageUrl(jour) },
    footer: {
      text: "Choisis ton lieu du jour avant la clôture de demain — définitif dès validation.",
    },
  };
}

// Château (vote) et Arène (combat) n'ont strictement aucun effet le Jour 1
// (computeCloture() ignore vote et combat tant que jour === 1, garde-fou
// existant) — les boutons restent cliquables (un joueur peut vouloir s'y
// rendre pour sa position, ex. accompagner quelqu'un ou juste par choix),
// mais handleLieuButton saute l'étape de sélection de cible ce jour-là (voir
// plus bas) : le lieu est enregistré tel quel, sans cibleId, comme
// Taverne/Clairière. Décidé avec l'utilisateur après une première version
// qui désactivait carrément les boutons — trop restrictif, seule l'ACTION
// doit être nulle, pas le déplacement lui-même.
const LIEUX_SANS_CIBLE_JOUR1 = new Set(["chateau", "camp_entrainement"]);

function buildLieuButtonsRow(jour, config, slot) {
  return {
    type: 1,
    components: Object.entries(config.lieux).map(([lieuId, lieu]) => ({
      type: 2,
      style: 2,
      label: lieu.label.slice(0, 80),
      emoji: { name: lieu.emoji },
      custom_id: `goblinhunters_lieu:${jour}:${lieuId}:${slot}`,
    })),
  };
}

function buildJourComponents(jour, config) {
  return [
    buildLieuButtonsRow(jour, config, "primary"),
    {
      type: 1,
      components: [
        {
          type: 2,
          style: 3,
          label: "Règles",
          emoji: { name: "📖" },
          custom_id: "goblinhunters_regles",
        },
        {
          type: 2,
          style: 2,
          label: "Journal",
          emoji: { name: "📜" },
          custom_id: "goblinhunters_journal",
        },
        {
          type: 2,
          style: 2,
          label: "Messagerie",
          emoji: { name: "📬" },
          custom_id: "goblinhunters_messagerie",
        },
      ],
    },
  ];
}

// Select de cible — n'affiche que les joueurs vivants dont la position sur
// le DERNIER plateau connu correspond au lieu choisi (ciblage restreint,
// décidé avec l'utilisateur), sauf pour le vote du Château qui reste libre
// sur tout joueur vivant (accusation villageoise, pas une confrontation).
function buildTargetSelectRow(candidats, jour, lieu, slot) {
  if (!candidats.length) return null;
  return [
    {
      type: 1,
      components: [
        {
          type: 3,
          custom_id: `goblinhunters_target:${jour}:${lieu}:${slot}`,
          placeholder: "Choisis une cible",
          options: candidats.slice(0, 25).map((j) => ({
            label: j.username.slice(0, 100),
            value: j.discordId,
          })),
        },
      ],
    },
  ];
}

function buildEclaireurSecondButtonRow(jour) {
  return [
    {
      type: 1,
      components: [
        {
          type: 2,
          style: 1,
          label: "🧭 Choisir ma 2ᵉ action",
          custom_id: `goblinhunters_second:${jour}`,
        },
      ],
    },
  ];
}

function buildOutcomeEmbed(
  victory,
  joueursApres,
  config,
  manches,
  currentManche,
) {
  const victoireTexte = {
    gobelins_parite: `${config.camps.gobelin.emoji} Les **Gobelins** l'emportent — parité atteinte !`,
    chasseurs_gobelins_elimines: `${config.camps.chasseur.emoji} Les **Villageois** l'emportent — tous les Gobelins ont été démasqués !`,
    chasseurs_survie: `${config.camps.chasseur.emoji} Les **Villageois** l'emportent — le village a tenu ${config.duree_jours} jours !`,
  }[victory];

  const reveal = joueursApres
    .map((j) => {
      const statutSymbole = j.alive ? "✅" : "☠️";
      const roleTexte = j.role ? ` (${config.roles[j.role].label})` : "";
      return `${statutSymbole} ${config.camps[j.camp].emoji} **${j.username}** — ${config.camps[j.camp].labelSingulier}${roleTexte}`;
    })
    .join("\n");

  const mancheLines = manches.length
    ? [
        "",
        "**📊 Manches précédentes**",
        ...manches.map(
          (m) =>
            `Manche ${m.manche} — ${m.victory}${m.manche === currentManche ? " *(cette manche)*" : ""}`,
        ),
      ]
    : [];

  return {
    title: "🏆 Goblin Hunters — partie terminée !",
    description: [
      victoireTexte,
      "",
      "**Révélation des identités**",
      reveal,
      ...mancheLines,
    ].join("\n"),
    color: 0xf1c40f,
    image: { url: `${TRUST_ROYALE_URL}/api/goblinhunters/end-image` },
  };
}

// Description en une phrase de ce que fait un rôle spécial — réutilisée dans
// les Règles ET dans le DM de rôle (sur demande explicite : le DM ne
// donnait auparavant que le libellé du rôle, jamais ce qu'il fait
// concrètement). Générée depuis la config plutôt qu'écrite en dur, pour ne
// jamais désynchroniser d'un futur réglage des chiffres (PV/dégâts/etc.).
function roleDescription(roleKey, config) {
  const r = config.roles[roleKey];
  switch (roleKey) {
    case "eclaireur":
      return `permet ${r.actions_par_jour} actions par jour au lieu d'une.`;
    case "bucheron":
      return `${r.pv} PV et ${r.degats} dégâts par coup au lieu de ${config.combat.pv_base} PV et ${config.combat.degats_base} dégât.`;
    case "guet_apens":
      return "si tu meurs au combat à l'Arène, le camp de qui t'a achevé est révélé publiquement.";
    case "infiltre":
      return 'l\'enquête menée sur toi à la Tour de Guet renvoie toujours "Villageois".';
    case "explosif":
      return `si tu meurs (vote ou combat), tu infliges automatiquement ${r.degats_riposte} dégât à un Villageois avant de partir — jamais mortel.`;
    default:
      return "";
  }
}

function buildReglesEmbed(config) {
  const lines = [
    "Deux camps s'affrontent en secret : les **Villageois** (majorité) et les **Gobelins infiltrés** (minorité). Chaque jour, choisis un lieu — il détermine ton action.",
    "",
    "**Lieux** (tous les 5 lieux comptent comme une action) :",
    `${config.lieux.chateau.emoji} **${config.lieux.chateau.label}** — vote d'accusation public. En cas d'égalité, personne n'est éliminé.`,
    `${config.lieux.camp_entrainement.emoji} **${config.lieux.camp_entrainement.label}** — attaque (1 dégât) un joueur vu ici la veille; si personne n'y était, tu frappes un joueur tiré au hasard.`,
    `${config.lieux.tour_de_guet.emoji} **${config.lieux.tour_de_guet.label}** — révèle le camp d'un joueur vu ici la veille; si personne n'y était, révèle un joueur tiré au hasard.`,
    `${config.lieux.taverne.emoji} **${config.lieux.taverne.label}** — protection des attaques tant que moins de ${config.taverne_seuil_protection} joueurs s'y trouvent le même jour.`,
    `${config.lieux.clairiere_mystique.emoji} **${config.lieux.clairiere_mystique.label}** — révèle la position actuelle de 2 joueurs tirés au hasard.`,
    "",
    "**Rôles spéciaux** (1 exemplaire de chacun) :",
    ...Object.keys(config.roles).map(
      (roleKey) =>
        `${config.roles[roleKey].emoji} **${config.roles[roleKey].label}** (camp ${config.camps[config.roles[roleKey].camp].label}) — ${roleDescription(roleKey, config)}`,
    ),
    "",
    `Chaque joueur a **${config.combat.pv_base} PV**. Maximum **1 mort par combat et par jour**.`,
    `Aucune élimination possible le Jour 1 (vote et combat désactivés).`,
    `🚫 Impossible de rester au même lieu 2 jours de suite.`,
    `📬 Bouton **Messagerie** : 1 message anonyme par jour, les 3 derniers restent affichés.`,
    "",
    "Victoire des Gobelins à la parité, des Villageois si tous les Gobelins sont éliminés, sinon des Villageois par défaut au dernier jour.",
  ];
  return {
    title: "📖 Règles — Goblin Hunters",
    description: lines.join("\n"),
    color: GOBLINHUNTERS_COLOR,
  };
}

// ── DM (fetch direct API REST Discord, comme zoom.js/lajustecarte.js) ──

async function sendGoblinHuntersDM(discordId, embed) {
  const token = process.env.DISCORD_TOKEN;
  if (!token) return false;
  try {
    const dmRes = await fetch(
      "https://discord.com/api/v10/users/@me/channels",
      {
        method: "POST",
        headers: {
          Authorization: `Bot ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ recipient_id: discordId }),
      },
    );
    if (!dmRes.ok) return false;
    const { id: dmChannelId } = await dmRes.json();
    await fetch(
      `https://discord.com/api/v10/channels/${dmChannelId}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bot ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ embeds: [embed] }),
      },
    );
    return true;
  } catch (err) {
    console.error("[GoblinHunters] Échec envoi DM:", err.message);
    return false;
  }
}

async function sendRoleDM(joueur, config, joueurs) {
  const camp = config.camps[joueur.camp];
  const roleLabel = joueur.role ? config.roles[joueur.role].label : null;
  const roleLine = joueur.role
    ? `${config.roles[joueur.role].emoji} **${roleLabel}** — ${roleDescription(joueur.role, config)}`
    : null;
  const gobelinsLine = otherGobelinsLine(joueur, joueurs);
  const embed = {
    title: "👺 Goblin Hunters — ton rôle secret",
    description: [
      `Tu es un(e) ${camp.emoji} **${camp.labelSingulier}**${roleLabel ? ` (rôle spécial : **${roleLabel}**)` : ""}.`,
      ...(roleLine ? ["", roleLine] : []),
      ...(gobelinsLine ? ["", gobelinsLine] : []),
      "",
      "🤫 Garde ce rôle secret — le jeu n'a d'intérêt que si tu sais bluffer !",
    ].join("\n"),
    color: GOBLINHUNTERS_COLOR,
  };
  await sendGoblinHuntersDM(joueur.discordId, embed);
}

async function sendInvestigationDM(investigation, joueursApres, config) {
  const cible = joueursApres.find((j) => j.discordId === investigation.cibleId);
  const camp = config.camps[investigation.campReporte];
  const embed = {
    title: "🔭 Tour de Guet — résultat de ton enquête",
    description: `**${cible?.username || "?"}** appartient au camp des ${camp.emoji} **${camp.label}**.`,
    color: GOBLINHUNTERS_COLOR,
  };
  await sendGoblinHuntersDM(investigation.investigatorId, embed);
}

// DM envoyé au joueur qui vient d'être éliminé (vote ou combat) — sur
// demande explicite, "description complète de ce qu'il s'est passé". Rappelle
// son propre camp/rôle (seule trace, l'embed public ne montre que le camp),
// la cause précise, et les effets de mort déclenchés le concernant (Guet-
// Apens/Explosif s'il détenait l'un de ces rôles). Ne révèle PAS qui a voté
// contre lui ni l'identité/camp de son attaquant au combat — décision de
// conception : préserver le mystère même après élimination, un joueur mort
// pourrait sinon relayer cette info aux vivants hors-jeu (voir la simulation
// d'équilibrage sur l'impact de la communication externe, mémoire projet).
async function sendEliminationDM(discordId, cause, closure, jourClos, config) {
  const joueur = closure.joueursApres.find((j) => j.discordId === discordId);
  if (!joueur) return;
  const camp = config.camps[joueur.camp];
  const roleLabel = joueur.role ? ` (${config.roles[joueur.role].label})` : "";

  const lines = [
    `Tu as été éliminé(e) au **Jour ${jourClos}**.`,
    `Tu étais un(e) ${camp.emoji} **${camp.labelSingulier}**${roleLabel}.`,
  ];

  if (cause === "vote") {
    const votes = closure.voteTally?.[discordId] ?? 0;
    lines.push(`⚖️ Le village t'a accusé(e) au Château (${votes} vote${votes > 1 ? "s" : ""}).`);
  } else {
    lines.push(`⚔️ Tu es tombé(e) au combat à l'Arène.`);
  }

  if (closure.guetApensReveal?.guetApensId === discordId) {
    const camps = closure.guetApensReveal.attackers
      .map((a) => config.camps[a.campReporte].labelSingulier)
      .join(", ");
    lines.push(`🪤 Ton piège de Guet-Apens s'est déclenché : le camp de qui t'a achevé(e) a été révélé publiquement (${camps}).`);
  }
  if (closure.explosifRetaliation?.gobelinId === discordId) {
    const cible = closure.joueursApres.find(
      (j) => j.discordId === closure.explosifRetaliation.targetId,
    );
    lines.push(
      `💣 Tu as explosé en mourant, infligeant ${config.roles.explosif.degats_riposte} dégât à **${cible?.username || "?"}**.`,
    );
  }

  lines.push(
    "",
    `Tu peux continuer à suivre la partie, mais tu ne peux plus agir. Rendez-vous au bilan final (Jour ${config.duree_jours} au plus tard) !`,
  );

  const embed = {
    title: "☠️ Goblin Hunters — tu as été éliminé(e)",
    description: lines.join("\n"),
    color: GOBLINHUNTERS_COLOR,
  };
  await sendGoblinHuntersDM(discordId, embed);
}

async function sendClairiereDM(discordId, reveals, config) {
  if (!reveals?.length) return;
  const lines = reveals.map(
    (r) =>
      `**${r.cibleUsername}** se trouve à ${config.lieux[r.lieu].emoji} ${config.lieux[r.lieu].label}.`,
  );
  const embed = {
    title: "🌫️ Clairière — ta vision",
    description: lines.join("\n"),
    color: GOBLINHUNTERS_COLOR,
  };
  await sendGoblinHuntersDM(discordId, embed);
}

// ── Publication quotidienne (appelée uniquement par scripts/postGoblinHunters.js) ──

export async function postGoblinHunters(
  channelId,
  {
    dryRun = false,
    noPing = false,
    isPublic = false,
    requireActiveState = false,
    forceClose = false,
  } = {},
) {
  const config = await loadGoblinHuntersConfig();
  const state = await readState();

  if (state?.termine) return { termine: true };

  // Garde-fou : une partie active sur un AUTRE salon ne doit jamais être
  // reprise ici (même incident/principe que Boss Raid, voir CONTRIBUTING.md).
  if (state && state.channelId !== channelId) {
    return { wrongChannel: true, activeChannelId: state.channelId };
  }

  if (!state && requireActiveState) {
    return { skipped: true };
  }

  // 1) Aucun état -> ouverture de la fenêtre d'inscription. Interroge le
  // vrai compteur (pas 0 en dur) : en production personne n'est encore
  // inscrit à ce stade, mais le flux de test recommandé seed le faux pool
  // AVANT d'ouvrir (voir goblinhunters:seed-test-pool, CONTRIBUTING.md).
  if (!state) {
    const closingAt = addDays(
      new Date(),
      config.fenetre_inscription_jours,
    ).toISOString();
    const initialCount = await countInscriptions();
    const embed = buildAnnonceInscriptionEmbed(config, closingAt);
    const components = buildInscriptionComponents(initialCount);

    if (dryRun) {
      const pingRoleId = !noPing
        ? await getRoleIdByName(MINI_JEUX_ROLE_NAME)
        : null;
      return {
        dryRun: true,
        phase: "inscription",
        embed,
        components,
        pingRoleId,
      };
    }

    return publishAndWriteState(channelId, null, {
      embed,
      components,
      noPing,
      estAnnonce: true,
      extraState: { phase: "inscription", closingAt },
    });
  }

  // 2) Phase inscription : rappel, report, ou lancement si la fenêtre est close
  if (state.phase === "inscription") {
    const now = new Date();
    const count = await countInscriptions();

    // --force-close (tests uniquement, jamais câblé dans le workflow GitHub
    // Actions) : ignore l'échéance réelle de closingAt pour ce run, sans la
    // réécrire — évite d'attendre 3 jours pour tester le lancement.
    if (!forceClose && new Date(state.closingAt) > now) {
      const embed = buildInscriptionRappelEmbed(config, count, state.closingAt);
      const components = buildInscriptionComponents(count);
      if (dryRun)
        return { dryRun: true, phase: "inscription", embed, components };
      return publishAndWriteState(channelId, state, {
        embed,
        components,
        noPing: true,
        estAnnonce: false,
        extraState: {},
      });
    }

    if (count < config.effectif_min) {
      const closingAt = addDays(
        now,
        config.fenetre_inscription_jours,
      ).toISOString();
      const embed = buildInscriptionReportEmbed(config, count, closingAt);
      const components = buildInscriptionComponents(count);
      if (dryRun)
        return {
          dryRun: true,
          phase: "inscription",
          report: true,
          embed,
          components,
        };
      return publishAndWriteState(channelId, state, {
        embed,
        components,
        noPing,
        estAnnonce: true,
        extraState: { closingAt },
      });
    }

    if (dryRun) {
      // Aperçu du lancement SANS écrire d'état ni envoyer de DM : reproduit
      // la même logique que launchGame() (backend/services/goblinhunters.js)
      // en lecture seule, pour valider la répartition des camps/rôles avant
      // le vrai lancement (ex. avec --force-close en test).
      const inscriptions = await listInscriptions();
      const playerIds = inscriptions.map((i) => i.discordId);
      const minorityCount = computeMinorityCount(
        playerIds.length,
        config.minority_table,
      );
      const assignments = assignCampsAndRoles(playerIds, minorityCount);
      const joueursPreview = buildInitialRoster(inscriptions, assignments, {
        pv_base: config.combat.pv_base,
        bucheronOverride: { pv: config.roles.bucheron.pv },
      });
      const embed = await buildJourEmbed(1, joueursPreview, config, null);
      const components = buildJourComponents(1, config);
      return {
        dryRun: true,
        phase: "lancement",
        joueursCount: count,
        embed,
        components,
        joueurs: joueursPreview,
      };
    }

    const { joueurs } = await launchGame(channelId, config);
    for (const j of joueurs) {
      await sendRoleDM(j, config, joueurs);
    }
    const embed = await buildJourEmbed(1, joueurs, config, null);
    const components = buildJourComponents(1, config);
    const freshState = await readState();
    return publishAndWriteState(channelId, freshState, {
      embed,
      components,
      noPing: true,
      estAnnonce: true,
      extraState: {},
    });
  }

  // 3) Phase jeu : clôture du jour courant, avance au suivant (ou fin de partie)
  const jourClos = state.jour;
  const closure = dryRun
    ? await previewCloture(jourClos, config)
    : await closeDayAndAdvance(jourClos, config);
  const jourSuivant = jourClos + 1;

  if (!dryRun) {
    if (closure.eliminationsParVote) {
      await sendEliminationDM(closure.eliminationsParVote, "vote", closure, jourClos, config);
    }
    if (closure.deathIdCombat) {
      await sendEliminationDM(closure.deathIdCombat, "combat", closure, jourClos, config);
    }
    for (const investigation of closure.investigations) {
      await sendInvestigationDM(investigation, closure.joueursApres, config);
    }
    for (const [discordId, reveals] of Object.entries(
      closure.clairiereReveals || {},
    )) {
      await sendClairiereDM(discordId, reveals, config);
    }
  }

  const victory =
    closure.victory ||
    (jourSuivant > config.duree_jours ? "chasseurs_survie" : null);

  if (victory) {
    let currentManche = null;
    if (!dryRun && isPublic) {
      currentManche = await archiveManche({
        victory,
        jourFinal: jourClos,
        resolvedAt: new Date().toISOString(),
      });
    }
    const manches = await listManches({ limit: 10 });
    const embed = buildOutcomeEmbed(
      victory,
      closure.joueursApres,
      config,
      manches,
      currentManche,
    );
    if (dryRun) return { dryRun: true, final: true, embed, closure };

    const freshState = await readState();
    const result = await publishAndWriteState(channelId, freshState, {
      embed,
      components: [],
      noPing,
      estAnnonce: false,
      termine: true,
      extraState: { termine: true },
    });
    return { ...result, final: true };
  }

  const embed = await buildJourEmbed(
    jourSuivant,
    closure.joueursApres,
    config,
    closure,
  );
  const components = buildJourComponents(jourSuivant, config);
  if (dryRun)
    return { dryRun: true, jour: jourSuivant, embed, components, closure };

  const freshState = await readState();
  return publishAndWriteState(channelId, freshState, {
    embed,
    components,
    noPing: true,
    estAnnonce: false,
    extraState: {},
  });
}

// Supprime l'ancien message (tolérant), poste le nouveau, fusionne l'état
// déjà écrit par le service (launchGame/closeDayAndAdvance pour la phase
// "jeu") avec les métadonnées de message. Diffère du publishAndWriteState de
// bossraid.js (qui écrit tout l'état d'un coup) car l'état ici est bien plus
// riche (roster complet) et déjà persisté par la couche service — voir
// backend/services/goblinhunters.js.
async function publishAndWriteState(
  channelId,
  previousState,
  { embed, components, noPing, estAnnonce, termine = false, extraState = {} },
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
          `[GoblinHunters] Échec suppression du message de la veille (${delRes.status}), publication quand même.`,
        );
      }
    } catch (err) {
      console.warn(
        "[GoblinHunters] Erreur réseau à la suppression du message de la veille:",
        err.message,
      );
    }
  }

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

  const base = (await readState()) || {};
  await writeState({
    ...base,
    ...extraState,
    channelId,
    messageId: message.id,
    publishedAt: new Date().toISOString(),
    termine,
  });

  return { embed, message, termine };
}

// ── Édition en place (réponses aux interactions, éphémères) ────────

async function patchOriginal(webhookUrl, payload) {
  if (!webhookUrl) return;
  try {
    await fetch(`${webhookUrl}/messages/@original`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    console.error("[GoblinHunters] Échec PATCH:", err.message);
  }
}

// ── Boutons d'inscription ───────────────────────────────────────────
// Réponse éphémère à l'auteur du clic (confirmation) + PATCH direct du
// message public (token du bot) pour rafraîchir le compteur affiché sur le
// bouton [✅ S'inscrire (n)] — même découplage que le bouton Espion de
// Boss Raid (recordVote en éphémère, compteur public rafraîchi séparément).

async function refreshInscriptionMessage(botToken, config) {
  if (!botToken) return;
  try {
    const state = await readState();
    if (
      !state ||
      state.phase !== "inscription" ||
      !state.channelId ||
      !state.messageId
    )
      return;
    const count = await countInscriptions();
    // Réutilise toujours le gabarit "rappel" (compteur en avant) pour le
    // rafraîchissement live, même si le message actuellement affiché était
    // l'annonce initiale ou une prolongation — on ne retrace pas quelle
    // variante est postée, et le compteur à jour prime sur le texte exact.
    const embed = buildInscriptionRappelEmbed(config, count, state.closingAt);
    const components = buildInscriptionComponents(count);
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
    console.error(
      "[GoblinHunters] Échec rafraîchissement du compteur d'inscription:",
      err.message,
    );
  }
}

export async function handleRegisterButton(
  webhookUrl,
  discordId,
  username,
  botToken,
) {
  try {
    const config = await loadGoblinHuntersConfig();
    const result = await registerPlayer(
      discordId,
      username,
      config.effectif_max,
    );
    const messages = {
      registered: "✅ Tu es inscrit(e) à Goblin Hunters !",
      already_registered: "Tu es déjà inscrit(e).",
      full: `Désolé, l'effectif maximum (${config.effectif_max}) est atteint.`,
    };
    await patchOriginal(webhookUrl, {
      content: messages[result.status],
      embeds: [],
      components: [],
    });
    if (result.status === "registered")
      await refreshInscriptionMessage(botToken, config);
  } catch (err) {
    console.error("[GoblinHunters] Échec inscription:", err.message);
  }
}

export async function handleUnregisterButton(webhookUrl, discordId, botToken) {
  try {
    const result = await unregisterPlayer(discordId);
    const content =
      result.status === "unregistered"
        ? "✖️ Tu as été désinscrit(e)."
        : "Tu n'étais pas inscrit(e).";
    await patchOriginal(webhookUrl, { content, embeds: [], components: [] });
    if (result.status === "unregistered") {
      const config = await loadGoblinHuntersConfig();
      await refreshInscriptionMessage(botToken, config);
    }
  } catch (err) {
    console.error("[GoblinHunters] Échec désinscription:", err.message);
  }
}

// ── Boutons de lieu ──────────────────────────────────────────────────

export async function handleLieuButton(
  webhookUrl,
  jour,
  lieu,
  slot,
  discordId,
  username,
) {
  try {
    const state = await readState();
    const config = await loadGoblinHuntersConfig();

    if (
      !state ||
      state.phase !== "jeu" ||
      state.termine ||
      String(state.jour) !== String(jour)
    ) {
      await patchOriginal(webhookUrl, {
        content:
          "La journée a changé entre-temps — regarde le nouveau message !",
        embeds: [],
        components: [],
      });
      return;
    }

    const joueur = state.joueurs.find((j) => j.discordId === discordId);
    if (!joueur || !joueur.alive) {
      await patchOriginal(webhookUrl, {
        content: "Tu ne participes pas (ou plus) à cette partie.",
        embeds: [],
        components: [],
      });
      return;
    }
    if (slot === "secondary" && joueur.role !== "eclaireur") {
      await patchOriginal(webhookUrl, {
        content: "Seul l'Éclaireur peut soumettre une 2ᵉ action.",
        embeds: [],
        components: [],
      });
      return;
    }
    if (!isLieuRepeatAllowed(joueur.position, lieu, jour)) {
      await patchOriginal(webhookUrl, {
        content: `🚫 Tu étais déjà à ${config.lieux[lieu].label} hier — impossible d'y rester 2 jours de suite, choisis un autre lieu.`,
        embeds: [],
        components: [],
      });
      return;
    }
    const existingAction = await readPlayerAction(jour, discordId);
    if (isActionLocked(existingAction, slot)) {
      await patchOriginal(webhookUrl, {
        content:
          "🔒 Tu as déjà choisi ton lieu aujourd'hui — définitif dès validation, impossible d'en changer ou de choisir un autre lieu.",
        embeds: [],
        components: [],
      });
      return;
    }
    // Nerf Éclaireur : la 2ᵉ action doit cibler un lieu DIFFÉRENT de la 1ère
    // — sans ça, l'Éclaireur pouvait voter 2x ou attaquer 2x le même jour,
    // doublant un effet qui n'est censé compter qu'une fois par lieu/jour.
    if (slot === "secondary" && existingAction?.primary?.lieu === lieu) {
      await patchOriginal(webhookUrl, {
        content: `🚫 Tu as déjà choisi ${config.lieux[lieu].label} pour ta 1ère action — ta 2ᵉ action doit viser un lieu différent.`,
        embeds: [],
        components: [],
      });
      return;
    }

    const lieuAction = config.lieux[lieu]?.action;
    // Château/Arène au Jour 1 : le déplacement reste possible, mais aucune
    // action réelle (computeCloture() ignore vote et combat tant que
    // jour === 1) — traité comme Taverne/Clairière ci-dessous, sans étape de
    // sélection de cible. Décidé avec l'utilisateur : seule l'ACTION doit
    // être nulle ce jour-là, pas le choix du lieu lui-même.
    const sansCibleJour1 = Number(jour) === 1 && LIEUX_SANS_CIBLE_JOUR1.has(lieu);

    // Taverne/Clairière : aucune cible nécessaire, action enregistrée
    // directement (la Clairière révèle 2 joueurs au hasard à la clôture,
    // voir computeClairiereReveals — pas de choix à faire ici).
    if (lieuAction === "protection" || lieuAction === "vision" || sansCibleJour1) {
      await recordAction(jour, discordId, slot, { lieu }, username);
      const followup =
        joueur.role === "eclaireur" && slot === "primary"
          ? buildEclaireurSecondButtonRow(jour)
          : [];
      const confirmation = sansCibleJour1
        ? `${config.lieux[lieu].emoji} Tu te rends à ${config.lieux[lieu].label} — aucun effet aujourd'hui (vote et combat désactivés le Jour 1). **Choix définitif pour aujourd'hui.**`
        : lieuAction === "protection"
          ? "🍺 Tu te rends à la Taverne (protection si le lieu n'est pas surpeuplé aujourd'hui). **Choix définitif pour aujourd'hui.**"
          : "🌫️ Tu te rends à la Clairière — la position de 2 joueurs au hasard te sera révélée demain. **Choix définitif pour aujourd'hui.**";
      await patchOriginal(webhookUrl, {
        content: confirmation,
        embeds: [],
        components: followup,
      });
      return;
    }

    // Château (vote) : cible libre sur tout joueur vivant (hors soi-même).
    // Combat/Enquête : cible restreinte au dernier plateau connu.
    const candidats =
      lieu === "chateau"
        ? state.joueurs.filter((j) => j.alive && j.discordId !== discordId)
        : state.joueurs.filter(
            (j) => j.alive && j.discordId !== discordId && j.position === lieu,
          );

    if (!candidats.length) {
      await recordAction(
        jour,
        discordId,
        slot,
        { lieu, cibleId: null },
        username,
      );
      const followup =
        joueur.role === "eclaireur" && slot === "primary"
          ? buildEclaireurSecondButtonRow(jour)
          : [];
      // Personne vu ici hier, mais l'action n'est pas perdue pour autant :
      // le filet de sécurité (fallbackActorsFor, backend/services/goblinhunters.js)
      // choisira une cible au hasard à la clôture — cibleId reste null ici,
      // c'est le tirage à la clôture qui tranche, jamais au clic.
      await patchOriginal(webhookUrl, {
        content: `${config.lieux[lieu].emoji} Tu te rends à ${config.lieux[lieu].label} — personne repéré ici pour l'instant, tu agiras sur un joueur choisi au hasard à la clôture. **Choix définitif pour aujourd'hui.**`,
        embeds: [],
        components: followup,
      });
      return;
    }

    const components = buildTargetSelectRow(candidats, jour, lieu, slot);
    await patchOriginal(webhookUrl, {
      content: `${config.lieux[lieu].emoji} Choisis ta cible à ${config.lieux[lieu].label} :`,
      embeds: [],
      components,
    });
  } catch (err) {
    console.error("[GoblinHunters] Échec bouton de lieu:", err.message);
  }
}

export async function handleEclaireurSecond(webhookUrl, jour, discordId) {
  try {
    const state = await readState();
    const config = await loadGoblinHuntersConfig();
    if (
      !state ||
      state.phase !== "jeu" ||
      state.termine ||
      String(state.jour) !== String(jour)
    ) {
      await patchOriginal(webhookUrl, {
        content: "La journée a changé entre-temps.",
        embeds: [],
        components: [],
      });
      return;
    }
    const joueur = state.joueurs.find((j) => j.discordId === discordId);
    if (!joueur || joueur.role !== "eclaireur") {
      await patchOriginal(webhookUrl, {
        content: "Seul l'Éclaireur peut soumettre une 2ᵉ action.",
        embeds: [],
        components: [],
      });
      return;
    }
    await patchOriginal(webhookUrl, {
      content: "🧭 Choisis ta 2ᵉ destination du jour :",
      embeds: [],
      components: [buildLieuButtonsRow(jour, config, "secondary")],
    });
  } catch (err) {
    console.error("[GoblinHunters] Échec 2e action Éclaireur:", err.message);
  }
}

// ── Select de cible ──────────────────────────────────────────────────

export async function handleTargetSelect(
  webhookUrl,
  jour,
  lieu,
  slot,
  discordId,
  username,
  selectedValue,
) {
  try {
    const state = await readState();
    if (
      !state ||
      state.phase !== "jeu" ||
      state.termine ||
      String(state.jour) !== String(jour)
    ) {
      await patchOriginal(webhookUrl, {
        content: "La journée a changé entre-temps.",
        embeds: [],
        components: [],
      });
      return;
    }
    const config = await loadGoblinHuntersConfig();
    const cibleId = selectedValue === "__none__" ? null : selectedValue;

    // Défense en profondeur : réévalue le verrou ici aussi (en plus du
    // contrôle déjà fait dans handleLieuButton) au cas où le select menu
    // éphémère aurait été ouvert avant qu'une action ne soit déjà validée
    // entre-temps (ex. via l'autre slot, ou un double-clic).
    const existingAction = await readPlayerAction(jour, discordId);
    if (isActionLocked(existingAction, slot)) {
      await patchOriginal(webhookUrl, {
        content:
          "🔒 Tu as déjà choisi ton lieu aujourd'hui — définitif dès validation, impossible d'en changer.",
        embeds: [],
        components: [],
      });
      return;
    }

    // Le vote du Château passe par le même recordAction() que tout autre
    // lieu (pas de stockage séparé) — sinon voter n'écrase jamais une
    // action précédente et inversement, permettant de cumuler les deux le
    // même jour (bug corrigé, voir computeVoteTally dans goblinhunters.js).
    await recordAction(jour, discordId, slot, { lieu, cibleId }, username);

    const joueur = state.joueurs.find((j) => j.discordId === discordId);
    const followup =
      joueur?.role === "eclaireur" && slot === "primary"
        ? buildEclaireurSecondButtonRow(jour)
        : [];
    const cibleUsername =
      state.joueurs.find((j) => j.discordId === cibleId)?.username || "?";
    await patchOriginal(webhookUrl, {
      content: `${config.lieux[lieu].emoji} Action enregistrée — cible : **${cibleUsername}**. **Choix définitif pour aujourd'hui.**`,
      embeds: [],
      components: followup,
    });
  } catch (err) {
    console.error("[GoblinHunters] Échec select de cible:", err.message);
  }
}

// ── Bouton [📜 Journal] — ÉPHÉMÈRE ET PERSONNEL, jamais public ─────
// Contrairement aux autres jeux (Journal = historique public), ici le
// Journal affiche exclusivement des infos privées au joueur qui clique :
// son rôle/camp secrets, sa dernière position connue, ses PV, et son carnet
// d'indices personnel cumulé sur toute la partie (computeIndicesForDay) —
// seule trace persistante des rencontres passées, le plateau public
// n'affichant que les positions COURANTES.

// Les Gobelins se connaissent entre eux dès le lancement (décision de
// design actée — voir mémoire projet) : sans ça, leur seul avantage
// structurel (savoir qui est dans leur camp) n'existe que sur le papier et
// jamais en jeu. Liste les autres membres du camp (vivants ET éliminés, le
// roster étant figé) — `null` si le joueur n'est pas un Gobelin.
function otherGobelinsLine(joueur, joueurs) {
  if (joueur.camp !== "gobelin") return null;
  const autres = joueurs.filter(
    (j) => j.camp === "gobelin" && j.discordId !== joueur.discordId,
  );
  if (!autres.length) return "Tu es le seul Gobelin restant.";
  const noms = autres.map((j) =>
    j.alive ? `**${j.username}**` : `**${j.username}** (☠️ éliminé)`,
  );
  return `Les autres Gobelins sont : ${noms.join(", ")}.`;
}

function formatIndiceLine(entry, config) {
  const lieu = config.lieux[entry.lieu];
  if (entry.type === "enquete") {
    const camp = config.camps[entry.campReporte];
    return `Jour ${entry.jour} — 🔭 **${entry.cibleUsername}** = ${camp.emoji} ${camp.labelSingulier}`;
  }
  if (entry.type === "reveal") {
    return `Jour ${entry.jour} — 🌫️ **${entry.cibleUsername}** se trouvait à ${lieu.emoji} ${lieu.label}`;
  }
  return `Jour ${entry.jour} — ⚔️ **${entry.cibleUsername}** croisé(e) au combat (${lieu.emoji} ${lieu.label})`;
}

export async function handleJournal(webhookUrl, discordId) {
  try {
    const state = await readState();
    if (!state || state.phase === "inscription") {
      await patchOriginal(webhookUrl, {
        content: "Aucune partie Goblin Hunters en cours pour le moment.",
        embeds: [],
        components: [],
      });
      return;
    }
    const joueur = state.joueurs.find((j) => j.discordId === discordId);
    if (!joueur) {
      await patchOriginal(webhookUrl, {
        content: "Tu ne participes pas à cette partie.",
        embeds: [],
        components: [],
      });
      return;
    }

    const config = await loadGoblinHuntersConfig();
    const camp = config.camps[joueur.camp];
    const roleLabel = joueur.role
      ? config.roles[joueur.role].label
      : "aucun (rôle de base)";
    const lieu = config.lieux[joueur.position];
    const statut = joueur.alive
      ? `**${joueur.pv}/${joueur.pvMax} PV**`
      : `☠️ éliminé(e) (jour ${joueur.campReveleAt})`;

    const gobelinsLine = otherGobelinsLine(joueur, state.joueurs);

    const lines = [
      `${camp.emoji} **Camp** : ${camp.labelSingulier}`,
      `**Rôle spécial** : ${roleLabel}`,
      ...(gobelinsLine ? [gobelinsLine] : []),
      `**Dernière position connue** : ${lieu.emoji} ${lieu.label}`,
      `**État** : ${statut}`,
    ];

    // Choix déjà validé pour AUJOURD'HUI (pas encore appliqué au plateau
    // public — ça n'arrive qu'à la clôture) : puisque chaque choix est
    // définitif dès validation (isActionLocked), le rappeler ici évite au
    // joueur de devoir s'en souvenir lui-même en attendant demain.
    if (joueur.alive) {
      const todaysAction = await readPlayerAction(state.jour, discordId);
      const joueurById = new Map(state.joueurs.map((j) => [j.discordId, j]));
      const formatChoice = (choice) => {
        if (!choice) return null;
        const choiceLieu = config.lieux[choice.lieu];
        const cibleUsername = choice.cibleId
          ? joueurById.get(choice.cibleId)?.username
          : null;
        return `${choiceLieu.emoji} ${choiceLieu.label}${cibleUsername ? ` → **${cibleUsername}**` : ""}`;
      };
      const choix = [
        formatChoice(todaysAction?.primary),
        formatChoice(todaysAction?.secondary),
      ].filter(Boolean);
      lines.push(
        `**Choix du Jour ${state.jour}** : ${choix.length ? choix.join(" + ") : "aucun soumis pour l'instant"}`,
      );
    }

    lines.push("", "**🔍 Indices récoltés**");

    const indices = await readPlayerIndices(discordId);
    lines.push(
      ...(indices.length
        ? indices.map((e) => formatIndiceLine(e, config))
        : ["Aucun pour l'instant."]),
    );

    const embed = {
      title: "📜 Ton Journal — Goblin Hunters",
      description: lines.join("\n"),
      color: GOBLINHUNTERS_COLOR,
    };
    await patchOriginal(webhookUrl, { embeds: [embed], components: [] });
  } catch (err) {
    console.error("[GoblinHunters] Échec Journal:", err.message);
  }
}

// ── Bouton [📖 Règles] — éphémère, statique ────────────────────────

export async function handleRegles(webhookUrl) {
  try {
    const config = await loadGoblinHuntersConfig();
    const embed = buildReglesEmbed(config);
    await patchOriginal(webhookUrl, { embeds: [embed], components: [] });
  } catch (err) {
    console.error("[GoblinHunters] Échec Règles:", err.message);
  }
}

// ── Bouton [📬 Messagerie] — mur de messages anonymes, 1/jour/joueur ──────
// Ni un lieu ni une action de clôture : contrairement au reste du jeu, la
// Messagerie est LIVE (pas résolue le lendemain via computeCloture) — un
// message posté apparaît immédiatement pour tout le monde au prochain clic.
// L'anonymat est structurel côté service (goblinhunters.js ne stocke jamais
// le discordId de l'auteur avec le contenu), pas juste un masquage ici.

function buildMessagerieEmbed(messages, { alive, alreadySent }) {
  const lines = messages.length
    ? messages.map((m) => `- Jour ${m.jour} : "${m.content}"`)
    : ["- Aucun message pour l'instant."];
  const footer = !alive
    ? "Tu es éliminé(e), tu ne peux plus poster de message."
    : alreadySent
      ? "Tu as déjà envoyé ton message du jour — reviens demain."
      : "Un message par jour et par joueur (anonyme).";
  return {
    title: "📬 Messagerie du village",
    description: [
      "Les 3 derniers messages postés :",
      ...lines,
      "",
      footer,
    ].join("\n"),
    color: GOBLINHUNTERS_COLOR,
  };
}

function buildMessagerieComponents({ alive, alreadySent }) {
  if (!alive || alreadySent) return [];
  return [
    {
      type: 1,
      components: [
        {
          type: 2,
          style: 1,
          label: "✍️ Écrire un message",
          custom_id: "goblinhunters_messagerie_write",
        },
      ],
    },
  ];
}

// Contenu de la Modal ouverte par le bouton "Écrire un message" — voir
// anagrams.js pour le mécanisme détaillé (réponse synchrone type:9).
export function buildMessagerieModal() {
  return {
    custom_id: "goblinhunters_messagerie_modal",
    title: "Message anonyme",
    components: [
      {
        type: 1,
        components: [
          {
            type: 4,
            custom_id: "goblinhunters_messagerie_input",
            style: 1,
            label: "Ton message (anonyme, 1/jour)",
            placeholder: "Ex. : Qui était à la Taverne hier soir ?",
            required: true,
            max_length: 200,
          },
        ],
      },
    ],
  };
}

export async function handleMessagerie(webhookUrl, discordId) {
  try {
    const state = await readState();
    if (!state || state.phase !== "jeu") {
      await patchOriginal(webhookUrl, {
        content: "Aucune partie Goblin Hunters en cours pour le moment.",
        embeds: [],
        components: [],
      });
      return;
    }
    const joueur = state.joueurs.find((j) => j.discordId === discordId);
    const alive = joueur?.alive === true;
    const alreadySent = alive
      ? await hasSentMessageToday(state.jour, discordId)
      : false;
    const messages = await listRecentMessages();
    const embed = buildMessagerieEmbed(messages, { alive, alreadySent });
    const components = buildMessagerieComponents({ alive, alreadySent });
    await patchOriginal(webhookUrl, { embeds: [embed], components });
  } catch (err) {
    console.error("[GoblinHunters] Échec Messagerie:", err.message);
  }
}

// Soumission de la Modal — le quota (1/jour) est revérifié ici en autorité
// (le bouton "Écrire" n'est qu'une aide visuelle côté handleMessagerie,
// jamais la garde réelle), sur le jour COURANT relu depuis l'état, jamais un
// jour capturé au moment de l'ouverture de la modal (la partie a pu avancer
// entre-temps si le joueur a mis du temps à écrire).
export async function handleMessagerieSubmit(
  webhookUrl,
  discordId,
  rawMessage,
) {
  try {
    const content = (rawMessage || "").trim();
    if (!content) {
      await patchOriginal(webhookUrl, {
        content: "Message vide, rien n'a été envoyé.",
        embeds: [],
        components: [],
      });
      return;
    }
    const state = await readState();
    const joueur =
      state?.phase === "jeu"
        ? state.joueurs.find((j) => j.discordId === discordId)
        : null;
    if (!joueur?.alive) {
      await patchOriginal(webhookUrl, {
        content: "Tu ne peux pas envoyer de message pour le moment.",
        embeds: [],
        components: [],
      });
      return;
    }
    const result = await recordMessage(state.jour, discordId, content);
    if (result.status === "already_sent") {
      await patchOriginal(webhookUrl, {
        content: "Tu as déjà envoyé ton message du jour — reviens demain.",
        embeds: [],
        components: [],
      });
      return;
    }
    await patchOriginal(webhookUrl, {
      content: "📬 Message envoyé anonymement !",
      embeds: [],
      components: [],
    });
  } catch (err) {
    console.error("[GoblinHunters] Échec envoi Messagerie:", err.message);
  }
}
