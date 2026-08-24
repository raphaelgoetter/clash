// ============================================================
// tamagotchi.js — Handlers Discord pour le Tamagotchi communautaire
// "Bébé Dragon Lilith". Embed, boutons d'action (vote) et Règles du jeu.
// La publication/suppression quotidienne passe uniquement
// par scripts/postTamagotchi.js (postTamagotchi) — les boutons restent gérés
// par api/discord/interactions.js.
// ============================================================

import {
  loadTamagotchiConfig,
  loadNarratifs,
  readState,
  writeState,
  recordVote,
  releaseVote,
  tallyVotes,
  previewCloseDay,
  closeDayAndAdvance,
  eventForDay,
  applyGaugeDelta,
  computeDayOpenGauges,
  computeFinalTier,
  capTierByConfiance,
  archiveManche,
  listManches,
  claimPilule,
  readPiluleState,
  computePiluleDelta,
} from "../../../backend/services/tamagotchi.js";
import {
  getRoleIdByName,
  buildRolePingFields,
  MINI_JEUX_ROLE_NAME,
} from "../../../backend/services/discordRoles.js";
import { resolveDisplayName } from "../../../backend/services/discordUsers.js";
import { formatUtcTimeAsParis } from "../../../backend/services/dateUtils.js";

const TAMAGOTCHI_COLOR = 0xe67e22;
const TRUST_ROYALE_URL = "https://trustroyale.vercel.app";

// Illustration du jour — fichiers statiques frontend/public/images/tamagotchi/
// (tama-01.webp à tama-10.webp), servis tels quels par Vercel, aucun besoin de
// masquer l'URL comme pour le jeu Frame (pas un jeu de devinette).
function tamagotchiImageUrl(jour) {
  return `${TRUST_ROYALE_URL}/images/tamagotchi/tama-${String(jour).padStart(2, "0")}.webp`;
}

const FLAVOR_NAMES = [
  "Aurel",
  "Rico",
  "Mariechou",
  "Pasqua",
  "Azzgameuse",
  "Lepamowi",
  "Snaatchou",
  "Electron",
  "Kayzor",
];

const DAY1_INTRO =
  "« Wesh la famille ! Je pars 10 jours visiter la Petite France à Strasbourg et déguster des tartes flambées.\n" +
  "Je vous confie Lilith mon Bébé Dragon de compétition. Il est très difficile : gardez ses jauges équilibrées !\n" +
  "Je reviendrai le 11e jour pour récupérer ma Lilith. Attention, si vous me la rendez en mauvais état… je débarque dans votre arène avec un deck Mineur-Poison et je défonce tout.\n" +
  "Bon courage ! » — Mohamed Light";

// ── Rendu des jauges ─────────────────────────────────────────────

// 8 paliers (nombre pair) plutôt que 5 ou 7 : à 50% pile, value/segment tombe
// sur un entier exact (4/8) sans arrondi, contrairement à un nombre impair de
// paliers où 50% tombe systématiquement sur une moitié (arrondie vers le
// haut) et penche donc visuellement vers le vert.
const GAUGE_SEGMENTS = 8;

export function renderGaugeBar(value) {
  const filled = Math.max(
    0,
    Math.min(GAUGE_SEGMENTS, Math.round((value / 100) * GAUGE_SEGMENTS)),
  );
  return `${"🟩".repeat(filled)}${"🟥".repeat(GAUGE_SEGMENTS - filled)}`;
}

// Libellé + pourcentage sur leur propre ligne, barre sur la ligne suivante —
// sur mobile, un seul retour à la ligne automatique au milieu de la barre
// suffit à casser sa lisibilité (ex. "🟩🟩🟩🟩" puis "🟥🟥🟥🟥 50%" sur la
// ligne d'après). Séparer explicitement les deux évite ce retour au milieu.
function renderGaugeLine(label, value) {
  return `${label} : ${value}%\n${renderGaugeBar(value)}`;
}

// Format lisible d'un objet {estomac, energie, moral} en "Estomac +25, Énergie
// -10, Moral +0" — réutilisé pour les impacts d'action (Règles du jeu) et le
// modificateur d'un événement, pour qu'on puisse toujours deviner son effet
// sans avoir à ouvrir tamagotchi.json.
// Exportée avec formatActionOverrides ci-dessous pour être réutilisée telle
// quelle par scripts/tamagotchiStatus.js (projection du Jour suivant), plutôt
// que de dupliquer ce formatage.
export function formatGaugeImpact({ estomac, energie, moral }) {
  const fmt = (v) => `${v >= 0 ? "+" : ""}${v}`;
  return `Estomac ${fmt(estomac)}, Énergie ${fmt(energie)}, Moral ${fmt(moral)}`;
}

const GAUGE_LABELS = { estomac: "Estomac", energie: "Énergie", moral: "Moral" };

// Pendant du formatGaugeImpact ci-dessus, mais pour un événement qui modifie
// temporairement l'impact d'une ou plusieurs actions (ex. Indigestion de
// bonbons, Jour 8) plutôt que d'appliquer un delta de jauges une fois pour
// toutes. Affiche l'ancienne ET la nouvelle valeur — sans ça, le nerf est
// invisible tant qu'on n'a pas comparé au bouton Règles du jeu, et se lit
// comme un bug plutôt qu'un défi du jour.
export function formatActionOverrides(actionsModifiees, actionsConfig) {
  const fmt = (v) => `${v >= 0 ? "+" : ""}${v}`;
  return Object.entries(actionsModifiees)
    .map(([id, override]) => {
      const action = actionsConfig[id];
      const changes = Object.entries(override)
        .map(
          ([gauge, value]) =>
            `${GAUGE_LABELS[gauge]} ${fmt(value)} (au lieu de ${fmt(action.impact[gauge])})`,
        )
        .join(", ");
      return `${action.emoji} ${action.label} : ${changes}`;
    })
    .join(" · ");
}

// ── Texte narratif ────────────────────────────────────────────────
// Les variantes de phrases vivent dans data/tamagotchi/narratifs.json (pas
// dans le code) pour être facilement enrichies sans toucher au JS. La
// sélection est déterministe (indexée par le jour, pas Math.random()) : le
// narratif ne doit jamais changer entre deux ré-affichages du MÊME jour
// (ex. après chaque clic de vote qui repatch l'embed), seulement d'un jour
// à l'autre.

function pickFlavor(pool, seed) {
  if (!pool?.length) return "";
  return pool[((seed % pool.length) + pool.length) % pool.length];
}

function gaugeCategory(kind, value, zones) {
  if (value < zones.min) return `${kind}_bas`;
  if (value > zones.max) return `${kind}_haut`;
  return `${kind}_normal`;
}

// Icône affichée devant chaque jauge — l'Estomac reste fixe (🍭, symbolise la
// nourriture), l'Énergie et le Moral varient selon le niveau pour que l'état
// se lise d'un coup d'œil, sans avoir à lire le pourcentage.
const GAUGE_ICONS = {
  estomac_bas: "🍭",
  estomac_normal: "🍭",
  estomac_haut: "🍭",
  energie_bas: "🪫",
  energie_normal: "⚡",
  energie_haut: "🔋",
  moral_bas: "🥱",
  moral_normal: "😐",
  moral_haut: "😋",
};

function gaugeIcon(kind, value, zones) {
  return GAUGE_ICONS[gaugeCategory(kind, value, zones)];
}

async function pickVoterNames(voters, jour) {
  if (voters?.length) {
    const picked = voters.slice(0, 2);
    const resolved = await Promise.all(
      picked.map((v) => resolveDisplayName(v.discordId, v.username)),
    );
    return resolved.filter(Boolean);
  }
  // Aucun vote la veille : pioche stable (déterministe par jour) dans le pool
  // de pseudos de secours, pour que le narratif reste cohérent en dry-run.
  const start = (jour * 2) % FLAVOR_NAMES.length;
  return [FLAVOR_NAMES[start], FLAVOR_NAMES[(start + 1) % FLAVOR_NAMES.length]];
}

// Chaque ligne du message de Mohamed Light préfixée par "> " — rendu Discord
// en citation multi-lignes (contrairement à ">>>" qui citerait aussi la
// mini-explication ajoutée après, qui doit rester du texte normal).
function quoteBlock(text) {
  return text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

function buildDay1Intro() {
  return [
    "**VOUS AVEZ REÇU UN NOUVEAU MESSAGE !**",
    "",
    quoteBlock(DAY1_INTRO),
    "",
    "Collaborez ensemble pour vous occuper du Bébé Dragon et subvenir à ses besoins.",
  ].join("\n");
}

// "normal" n'a volontairement aucun pool de texte associé (contrairement à
// GAUGE_ICONS, qui a besoin d'une icône même en normal) : rien
// d'intéressant à raconter sur une jauge ordinaire, la ligne est alors
// simplement omise plutôt que de meubler avec une phrase creuse.
async function buildNarrative(jour, gauges, voters, estPremierJour, zones, confiance, confianceConfig) {
  if (estPremierJour) return buildDay1Intro();

  const narratifs = await loadNarratifs();
  const intro = pickFlavor(narratifs.intro_cocasse, jour);

  const lines = [];
  const estomacKey = gaugeCategory("estomac", gauges.estomac, zones);
  if (!estomacKey.endsWith("_normal"))
    lines.push(pickFlavor(narratifs[estomacKey], jour + 1));
  const energieKey = gaugeCategory("energie", gauges.energie, zones);
  if (!energieKey.endsWith("_normal"))
    lines.push(pickFlavor(narratifs[energieKey], jour + 2));
  const moralKey = gaugeCategory("moral", gauges.moral, zones);
  if (!moralKey.endsWith("_normal"))
    lines.push(pickFlavor(narratifs[moralKey], jour + 3));

  // Confiance : pas de bande "zone" comme les 3 jauges (elle part de 100 et ne
  // fait que baisser/se reconstruire lentement) — un seul seuil "bas", repris
  // du plafond de palier le plus haut (là où la Confiance commence déjà à
  // coûter cher en fin de manche), pour rester cohérent sans dupliquer le
  // nombre en dur ici.
  if (confiance != null && confianceConfig?.plafond_tier?.length && narratifs.confiance_bas?.length) {
    const seuil = Math.max(...confianceConfig.plafond_tier.map((p) => p.sous));
    if (confiance < seuil) lines.push(pickFlavor(narratifs.confiance_bas, jour + 5));
  }

  const names = await pickVoterNames(voters, jour);
  if (names.length) {
    const template = pickFlavor(narratifs.cloture_soins, jour + 4);
    const phrase = template
      .replaceAll("{noms}", names.join(" et "))
      .replaceAll("{premier}", names[0]);
    // Rattachée à la dernière ligne (même paragraphe) si possible, sinon
    // ligne à part (les 3 jauges peuvent toutes être "normal" ce jour-là).
    if (lines.length) {
      lines[lines.length - 1] += ` ${phrase}`;
    } else {
      lines.push(phrase);
    }
  }

  if (!lines.length) return intro;
  return `${intro}\n\n${lines.join("\n")}`;
}

const RATING_LABELS = {
  parfaite: "✅ Parfait (+1 ⭐)",
  moyenne: "⚠️ Moyen (+0 ⭐)",
  catastrophe: "❌ Catastrophe (-1 ⭐)",
};

// ── Embed / composants du jour ────────────────────────────────────

async function buildTamagotchiEmbed(
  jour,
  gauges,
  config,
  event,
  starTotal,
  estPremierJour,
  voters,
  previousRating,
  confiance,
) {
  const narrative = await buildNarrative(
    jour,
    gauges,
    voters,
    estPremierJour,
    config.zones_ideales,
    confiance,
    config.confiance,
  );
  const lines = [narrative, ""];
  if (event) {
    const effet = event.actions_modifiees
      ? formatActionOverrides(event.actions_modifiees, config.actions)
      : formatGaugeImpact(event.modificateur_jauges);
    lines.push(
      `**📯 Événement du jour : ${event.titre}**`,
      event.description,
      `Effet : ${effet}`,
      "",
    );
  }
  lines.push(
    renderGaugeLine(
      `${gaugeIcon("estomac", gauges.estomac, config.zones_ideales)} Estomac`,
      gauges.estomac,
    ),
    renderGaugeLine(
      `${gaugeIcon("energie", gauges.energie, config.zones_ideales)} Énergie`,
      gauges.energie,
    ),
    renderGaugeLine(
      `${gaugeIcon("moral", gauges.moral, config.zones_ideales)} Moral`,
      gauges.moral,
    ),
    "",
  );
  // Confiance : pas de gaugeIcon/zones (pas de bande cible, juste un
  // "combien il en reste" à sens unique) — visible chaque jour pour que
  // voter Câliner de temps en temps ait un sens compris de tous, pas une
  // règle cachée.
  if (confiance != null) {
    lines.push(renderGaugeLine("🤝 Confiance", confiance), "");
  }
  // Rend visible POURQUOI le score a (ou n'a pas) bougé : sans ça, une seule
  // jauge hors zone (donnant 0 étoile, pas de malus) est facilement confondue
  // avec un score qui "n'augmente jamais".
  if (previousRating) {
    lines.push(
      `Bilan d'hier : ${RATING_LABELS[previousRating.rating] || previousRating.rating}`,
      "",
    );
  }
  lines.push(`⭐ Étoiles de dressage : ${starTotal}/${config.duree_jours}`);

  return {
    title: `🐉 Tamagotchi — Jour ${jour}/${config.duree_jours}`,
    description: lines.join("\n"),
    color: TAMAGOTCHI_COLOR,
    image: { url: tamagotchiImageUrl(jour) },
    footer: {
      text: estPremierJour
        ? "Mohamed Light vous confie Lilith — bon courage !"
        : `Votez avant ${formatUtcTimeAsParis(8)} (heure de Paris) demain pour orienter la journée.`,
    },
  };
}

// Évite une lecture Redis inutile hors de la fenêtre [day_min, day_max] —
// factorisé ici car appelé par les 3 sites qui reconstruisent l'embed du
// jour (post quotidien, repatch après vote normal, repatch après Pilule).
async function loadPiluleStateIfActive(jour, config) {
  const pilule = config.actions.pilule;
  if (!pilule || jour < pilule.day_min || jour > pilule.day_max) return null;
  return readPiluleState(jour, pilule.total_cap);
}

// `piluleState` (nullable) est précalculé par l'appelant via
// readPiluleState() — cette fonction reste synchrone/pure (aucun I/O), pour
// que les 3 sites d'appel gardent le contrôle de quand lire Redis.
function buildTamagotchiComponentsWithCounts(
  jour,
  config,
  voteCounts,
  piluleState,
) {
  const actionIds = Object.keys(config.actions).filter(
    (id) => !config.actions[id].is_info_action,
  );
  const pilule = config.actions.pilule;

  const rows = [
    {
      type: 1,
      components: actionIds.map((id) => {
        const action = config.actions[id];
        return {
          type: 2,
          style: 2,
          label: `${action.label} (${voteCounts[id] || 0})`.slice(0, 80),
          emoji: { name: action.emoji },
          custom_id: `tamagotchi_vote:${jour}:${id}`,
        };
      }),
    },
    {
      type: 1,
      components: [
        {
          type: 2,
          style: 2,
          label: "Règles",
          emoji: { name: "📖" },
          custom_id: "tamagotchi_regles",
        },
      ],
    },
  ];

  // Rangée Pilule : uniquement Jours [day_min, day_max], et seulement si
  // l'appelant a fourni son état (jamais construit à l'aveugle). `exhausted`
  // est vérifié AVANT `usedToday` — voir readPiluleState() côté service pour
  // pourquoi (la clé du jour peut rester "posée" même quota épuisé).
  if (
    pilule &&
    piluleState &&
    jour >= pilule.day_min &&
    jour <= pilule.day_max
  ) {
    const disabled = piluleState.exhausted || piluleState.usedToday;
    const label = piluleState.exhausted
      ? "Pilule — épuisée"
      : piluleState.usedToday
        ? "Pilule — déjà utilisée aujourd'hui"
        : `Pilule (${piluleState.remaining}/${pilule.total_cap})`;
    rows.push({
      type: 1,
      components: [
        {
          type: 2,
          style: 2,
          label: label.slice(0, 80),
          emoji: { name: pilule.emoji },
          disabled,
          custom_id: `tamagotchi_pilule:${jour}`,
        },
      ],
    });
  }

  return rows;
}

async function buildDayPayload(
  jour,
  gauges,
  config,
  event,
  starTotal,
  estPremierJour,
  voters,
  previousRating,
  confiance,
) {
  const [voteCounts, piluleState] = await Promise.all([
    estPremierJour ? Promise.resolve({}) : tallyVotes(jour),
    loadPiluleStateIfActive(jour, config),
  ]);
  return {
    embed: await buildTamagotchiEmbed(
      jour,
      gauges,
      config,
      event,
      starTotal,
      estPremierJour,
      voters,
      previousRating,
      confiance,
    ),
    components: buildTamagotchiComponentsWithCounts(
      jour,
      config,
      voteCounts,
      piluleState,
    ),
  };
}

// ── Embed de fin de partie (Jour 10) ──────────────────────────────
// Le jeu est rejoué plusieurs fois dans l'année : la manche qui vient de se
// terminer est comparée aux précédentes (manches, currentManche — voir
// archiveManche()/listManches() dans tamagotchi.js), avec un 🏆 sur le
// meilleur total d'étoiles toutes manches confondues.

function formatMancheLine(record, isCurrent, isBest) {
  const marker = isBest ? "🏆 " : "";
  const suffix = isCurrent ? " *(cette manche)*" : "";
  return `${marker}Manche ${record.manche} — ${record.starTotal}⭐ (${record.tier})${suffix}`;
}

function buildManchesSection(manches, currentManche) {
  if (!manches.length) return [];
  const best = manches.reduce((a, b) => (b.starTotal > a.starTotal ? b : a));
  return [
    "",
    "**📊 Manches précédentes**",
    ...manches.map((m) =>
      formatMancheLine(m, m.manche === currentManche, m.manche === best.manche),
    ),
  ];
}

// `tierBrut` (palier calculé sur les seules étoiles) et `confianceFinale`
// permettent d'expliquer un plafonnement par la Confiance — sans cette
// ligne, un palier plafonné en silence ressemblerait à un bug plutôt qu'à
// une conséquence du peu de Câliner voté pendant la manche.
function buildFinalTierEmbed(
  starTotal,
  tier,
  config,
  manches = [],
  currentManche = null,
  tierBrut = tier,
  confianceFinale = null,
) {
  const image = { url: tamagotchiImageUrl(config.duree_jours) };
  const manchesLines = buildManchesSection(manches, currentManche);
  const confianceLine =
    tier !== tierBrut && confianceFinale != null
      ? [
          "",
          `🤝 Confiance finale : ${confianceFinale}/100 — trop basse pour dépasser le palier ${tier} malgré ${starTotal} étoiles.`,
        ]
      : [];

  if (tier === "S") {
    return {
      title: "🐉 Fin de l'aventure — Mohamed Light est impressionné !",
      description: [
        `Lilith rentre en pleine forme, l'écaille brillante et le sourire aux crocs. Mohamed Light décerne au serveur ` +
          `le titre honorifique **🐉 Éleveur de Champion** — un immense bravo à toute la communauté !`,
        "",
        `⭐ Étoiles de dressage finales : ${starTotal}/${config.duree_jours}`,
        ...confianceLine,
        ...manchesLines,
      ].join("\n"),
      color: 0xf1c40f,
      image,
    };
  }
  if (tier === "B") {
    return {
      title: "🐉 Fin de l'aventure — Lilith rentre saine et sauve",
      description: [
        `Le Bébé Dragon rentre un peu fatigué, mais indemne. Mohamed Light vous remercie chaleureusement d'avoir pris soin de Lilith !`,
        "",
        `⭐ Étoiles de dressage finales : ${starTotal}/${config.duree_jours}`,
        ...confianceLine,
        ...manchesLines,
      ].join("\n"),
      color: TAMAGOTCHI_COLOR,
      image,
    };
  }
  return {
    title: "🐉 Fin de l'aventure — Lilith crache de la fumée noire",
    description: [
      `Mohamed Light retrouve son Bébé Dragon dans un sale état. Furieux, il lance un défi d'arène au serveur — ` +
        `préparez-vous à affronter un deck Mineur-Poison !`,
      "",
      `⭐ Étoiles de dressage finales : ${starTotal}/${config.duree_jours}`,
      ...confianceLine,
      ...manchesLines,
    ].join("\n"),
    color: 0x2c3e50,
    image,
  };
}

function buildReglesEmbed(config) {
  const actionLines = Object.entries(config.actions)
    .filter(([, action]) => !action.is_info_action)
    .map(
      ([, action]) =>
        `${action.emoji} **${action.label}** — ${formatGaugeImpact(action.impact)}`,
    );

  return {
    title: "📖 Règles du jeu — Tamagotchi",
    description: [
      `Garde les 3 jauges de Lilith (🍭 Estomac, ⚡ Énergie, 😐 Moral) en **zone verte (${config.zones_ideales.min}-${config.zones_ideales.max}%)** à la clôture quotidienne (${formatUtcTimeAsParis(8)}, heure de Paris).`,
      "",
      "**Actions :**",
      ...actionLines,
      `Chaque impact est réparti au prorata des votes reçus, puis multiplié par la participation du jour : effet plein à partir de ${config.votants_reference} votants, réduit en dessous — mobiliser du monde compte vraiment.`,
      "",
      ...(config.fatigue
        ? [
            `😵 **Fatigue** : l'action qui a récolté le plus de votes hier voit son effet réduit aujourd'hui (×${config.fatigue.facteur}) — impossible de répéter indéfiniment la même stratégie gagnante, il faut varier d'un jour à l'autre.`,
            "",
          ]
        : []),
      ...(config.confiance
        ? [
            `🤝 **Confiance** (${config.confiance.depart}/100 au départ) baisse d'elle-même sur les jours ⚠️ Moyen ou ❌ Catastrophe, et ne remonte QUE via 🤗 **Câliner** (léger coût Estomac, aucun autre effet). Un mauvais jour laisse une trace qu'aucune autre action ne peut effacer — et une Confiance trop basse en fin de manche plafonne le palier final, même avec beaucoup d'étoiles.`,
            "",
          ]
        : []),
      `💊 **Pilule** (Jours ${config.actions.pilule.day_min}-${config.actions.pilule.day_max}) rapproche *instantanément* chaque jauge vers la moyenne, jusqu'à ${config.actions.pilule.max_step}%. Consomme ton vote sauf si elle a déjà été utilisée. Item Rare : ${config.actions.pilule.total_cap} utilisations max sur toute la manche (1 seule par jour).`,
      "Chacune consomme ton vote du jour comme une action normale (1 vote/jour, définitif) — sauf 📖 Règles, toujours libre.",
      "",
      `**⭐ Étoiles :** 3 jauges en zone = ${RATING_LABELS.parfaite} ; 1 hors zone = ${RATING_LABELS.moyenne} ; 2-3 hors zone = ${RATING_LABELS.catastrophe}. Sur 10 jours : 8+ impressionne Mohamed Light, moins de 4 et il débarque furieux avec un deck Mineur-Poison — sauf si la Confiance finale est trop basse pour dépasser un palier, quel que soit le total d'étoiles.`,
    ].join("\n"),
    color: TAMAGOTCHI_COLOR,
  };
}

// ── Publication quotidienne (appelée uniquement par scripts/postTamagotchi.js) ──

export async function postTamagotchi(
  channelId,
  {
    dryRun = false,
    noPing = false,
    isPublic = false,
    requireActiveState = false,
  } = {},
) {
  const config = await loadTamagotchiConfig();
  const state = await readState();

  if (state?.termine) {
    return { termine: true };
  }

  // Garde-fou : une partie active sur un AUTRE salon ne doit JAMAIS être
  // reprise ici — sinon une partie de test oubliée active fuiterait dans le
  // salon public au prochain cron (et inversement). Voir l'incident réel du
  // 23/08/2026 sur Quiz, même cause (état partagé test/public sans contrôle
  // de salon), qui a motivé ce garde-fou sur tous les jeux à avancée
  // quotidienne.
  if (state && state.channelId !== channelId) {
    return { wrongChannel: true, activeChannelId: state.channelId };
  }

  // Le cron quotidien ne fait qu'avancer une partie déjà lancée manuellement
  // — il ne doit jamais démarrer le Jour 1 tout seul (voir workflow_dispatch
  // vs schedule dans .github/workflows/tamagotchi.yml).
  if (!state && requireActiveState) {
    return { skipped: true };
  }

  const estPremierJour = !state;

  if (estPremierJour) {
    const jour = 1;
    const gauges = config.jauges_initiales;
    const { embed, components } = await buildDayPayload(
      jour,
      gauges,
      config,
      null,
      0,
      true,
      [],
      null,
      config.confiance?.depart ?? null,
    );

    if (dryRun) {
      const pingRoleId = !noPing
        ? await getRoleIdByName(MINI_JEUX_ROLE_NAME)
        : null;
      return { dryRun: true, jour, embed, components, pingRoleId };
    }
    return publishAndWriteState(channelId, null, {
      jour,
      gauges,
      starTotal: 0,
      lastEvent: null,
      lastRating: null,
      dayVoters: [],
      confiance: config.confiance?.depart ?? null,
      actionFatiguee: null,
      embed,
      components,
      noPing,
      estPremierJour: true,
    });
  }

  const closure = dryRun
    ? await previewCloseDay(state, config)
    : await closeDayAndAdvance(state, config);
  const starTotalApres = dryRun
    ? state.starTotal + closure.rating.starDelta
    : closure.starTotalApres;
  const jour = state.jour + 1;

  if (jour > config.duree_jours) {
    const tierBrut = computeFinalTier(starTotalApres);
    // La Confiance finale plafonne le palier — un mauvais début de manche
    // (jours Moyen/Catastrophe non compensés par Câliner) laisse une trace
    // qu'aucun bon score d'étoiles ne peut effacer.
    const tier = capTierByConfiance(tierBrut, closure.confianceApres, config.confiance);

    // Archivage de la manche AVANT lecture de la liste : la manche qui
    // vient de se terminer apparaît alors dans son propre récap comparatif
    // (marquée "cette manche"). Jamais archivé en dry-run NI sur le salon de
    // test (isPublic) — seule une vraie publication sur le salon public
    // compte comme une manche réelle, pour ne jamais polluer l'archive avec
    // des parties de test (voir CONTRIBUTING.md, section Manches).
    let currentManche = null;
    if (!dryRun && isPublic) {
      currentManche = await archiveManche({
        starTotal: starTotalApres,
        tier,
        resolvedAt: new Date().toISOString(),
      });
    }
    const manches = await listManches({ limit: 10 });
    const embed = buildFinalTierEmbed(
      starTotalApres,
      tier,
      config,
      manches,
      currentManche,
      tierBrut,
      closure.confianceApres,
    );

    if (dryRun) {
      return {
        dryRun: true,
        final: true,
        tier,
        starTotal: starTotalApres,
        embed,
      };
    }
    const result = await publishAndWriteState(channelId, state, {
      jour: state.jour,
      gauges: closure.gaugesClosing,
      starTotal: starTotalApres,
      lastEvent: state.lastEvent,
      lastRating: closure.rating,
      dayVoters: closure.voters,
      confiance: closure.confianceApres,
      actionFatiguee: closure.actionFatigueeSuivante,
      embed,
      components: [],
      noPing,
      estPremierJour: false,
      termine: true,
    });
    return { ...result, final: true, tier, starTotal: starTotalApres };
  }

  const event = eventForDay(jour, config.evenements_possibles);
  // Un événement à actions_modifiees (ex. Indigestion de bonbons) n'a aucun
  // effet instantané sur les jauges au démarrage du jour — son effet ne se
  // fera sentir qu'à la clôture de CE jour, via computeClosure() côté service
  // (voir applyActionOverrides()), donc pas de modificateur_jauges à appliquer
  // ici pour ce type d'événement.
  const gauges = computeDayOpenGauges(closure.gaugesClosing, jour, event, config);
  const { embed, components } = await buildDayPayload(
    jour,
    gauges,
    config,
    event,
    starTotalApres,
    false,
    closure.voters,
    closure.rating,
    closure.confianceApres,
  );

  if (dryRun) {
    return {
      dryRun: true,
      jour,
      embed,
      components,
      event,
      starTotal: starTotalApres,
    };
  }
  return publishAndWriteState(channelId, state, {
    jour,
    gauges,
    starTotal: starTotalApres,
    lastEvent: event,
    lastRating: closure.rating,
    dayVoters: closure.voters,
    confiance: closure.confianceApres,
    actionFatiguee: closure.actionFatigueeSuivante,
    embed,
    components,
    noPing,
    estPremierJour: false,
  });
}

// Supprime l'ancien message (tolérant), poste le nouveau, écrit l'état.
async function publishAndWriteState(
  channelId,
  previousState,
  {
    jour,
    gauges,
    starTotal,
    lastEvent,
    lastRating,
    dayVoters,
    confiance,
    actionFatiguee,
    embed,
    components,
    noPing,
    estPremierJour,
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
          `[Tamagotchi] Échec suppression du message de la veille (${delRes.status}), publication quand même.`,
        );
      }
    } catch (err) {
      console.warn(
        "[Tamagotchi] Erreur réseau à la suppression du message de la veille:",
        err.message,
      );
    }
  }

  // Ping réservé au lancement (Jour 1) et à la fin de manche — jamais pour
  // les jours intermédiaires.
  const roleId =
    (estPremierJour || termine) && !noPing
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
    jour,
    gauges,
    channelId,
    messageId: message.id,
    publishedAt: new Date().toISOString(),
    termine,
    starTotal,
    lastEvent,
    lastRating,
    dayVoters,
    confiance,
    actionFatiguee,
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
    console.error("[Tamagotchi] Échec PATCH:", err.message);
  }
}

// ── Bouton de vote ────────────────────────────────────────────────
// Ack routeur : type 5 (DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE, éphémère) car
// on doit toujours répondre en privé à l'auteur du clic (confirmation ou
// rejet d'un vote déjà posé) — le message public n'est jamais édité via
// "@original" ici mais via un second appel PATCH direct au salon (Bot
// token), découplé de la réponse éphémère.

export async function handleVoteButton(
  webhookUrl,
  jour,
  actionId,
  discordId,
  username,
  botToken,
) {
  try {
    const state = await readState();
    if (!state || state.termine || String(state.jour) !== String(jour)) {
      await patchOriginal(webhookUrl, {
        content:
          "Le vote du jour a déjà été clôturé, la journée a changé — regarde le nouveau message !",
        embeds: [],
        components: [],
      });
      return;
    }

    const result = await recordVote(state.jour, discordId, actionId, username);

    const confirmText =
      result.status === "rejected"
        ? "Tu as déjà voté aujourd'hui pour une autre action, ton vote est définitif jusqu'à demain !"
        : result.status === "already_recorded"
          ? "Tu as déjà voté cette action aujourd'hui, c'est noté !"
          : "Vote enregistré, merci d'avoir pris soin de Lilith aujourd'hui !";
    await patchOriginal(webhookUrl, {
      content: confirmText,
      embeds: [],
      components: [],
    });

    if (result.status === "rejected") return;

    const config = await loadTamagotchiConfig();
    const [voteCounts, piluleState] = await Promise.all([
      tallyVotes(state.jour),
      loadPiluleStateIfActive(state.jour, config),
    ]);
    // lastRating n'est jamais renseigné pour le Jour 1 (aucun jour précédent
    // à clôturer) et toujours renseigné à partir du Jour 2 — repère fiable
    // pour reconstruire le MÊME embed que celui posté initialement ce jour-là.
    const estPremierJour = state.lastRating == null;
    const embed = await buildTamagotchiEmbed(
      state.jour,
      state.gauges,
      config,
      state.lastEvent,
      state.starTotal,
      estPremierJour,
      state.dayVoters,
      state.lastRating,
      state.confiance,
    );
    const components = buildTamagotchiComponentsWithCounts(
      state.jour,
      config,
      voteCounts,
      piluleState,
    );

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
    console.error("[Tamagotchi] Échec traitement du vote:", err.message);
  }
}

// ── Bouton [💊 Pilule] — filet de sécurité rare (Jours 4-10, voir tamagotchi.json).
// Contrairement aux 4 actions normales, son effet est INSTANTANÉ (mutate
// state.gauges directement, pas seulement à la clôture) et GARANTI (pas dilué
// par computeDayImpact — is_info_action l'exclut du blend). Consomme le vote
// du jour du joueur SEULEMENT si elle est effectivement appliquée : si la
// réclamation échoue (déjà utilisée aujourd'hui / quota de manche épuisé),
// le vote est libéré via releaseVote() pour que le joueur puisse revoter une
// vraie action — même précédent que releaseVoteSlot() dans Robinson (Radeau).
export async function handlePilule(
  webhookUrl,
  jour,
  discordId,
  username,
  botToken,
) {
  try {
    const state = await readState();
    if (!state || state.termine || String(state.jour) !== String(jour)) {
      await patchOriginal(webhookUrl, {
        content:
          "Le vote du jour a déjà été clôturé, la journée a changé — regarde le nouveau message !",
        embeds: [],
        components: [],
      });
      return;
    }

    const config = await loadTamagotchiConfig();
    const pilule = config.actions.pilule;
    // Défense en profondeur : le bouton ne devrait jamais être rendu hors de
    // [day_min, day_max], mais un custom_id périmé/forgé ne doit pas la
    // contourner.
    if (state.jour < pilule.day_min || state.jour > pilule.day_max) {
      await patchOriginal(webhookUrl, {
        content: "La Pilule n'est pas disponible aujourd'hui.",
        embeds: [],
        components: [],
      });
      return;
    }

    const voteResult = await recordVote(
      state.jour,
      discordId,
      "pilule",
      username,
    );
    if (voteResult.status === "rejected") {
      await patchOriginal(webhookUrl, {
        content:
          "Tu as déjà voté aujourd'hui pour une autre action, ton vote est définitif jusqu'à demain !",
        embeds: [],
        components: [],
      });
      return;
    }
    if (voteResult.status === "already_recorded") {
      await patchOriginal(webhookUrl, {
        content: "Tu as déjà utilisé la Pilule aujourd'hui, c'est noté !",
        embeds: [],
        components: [],
      });
      return;
    }

    // Premier vote Pilule du joueur ce jour-là — tente la réclamation partagée.
    const claim = await claimPilule(state.jour, pilule.total_cap);
    if (!claim.claimed) {
      await releaseVote(state.jour, discordId);
      const message =
        claim.reason === "total_exhausted"
          ? `La Pilule a déjà été utilisée ${pilule.total_cap} fois cette manche, elle n'est plus disponible.`
          : "La Pilule vient d'être utilisée par quelqu'un d'autre aujourd'hui !";
      await patchOriginal(webhookUrl, {
        content: message,
        embeds: [],
        components: [],
      });
      return;
    }

    // Réclamation gagnée — applique l'effet. Re-lit l'état juste avant
    // d'écrire pour réduire (sans l'éliminer) la fenêtre de course avec le
    // cron quotidien : handlePilule est le premier code à muter state.gauges
    // hors du flux de clôture (closeDayAndAdvance).
    const freshState = await readState();
    if (
      !freshState ||
      freshState.termine ||
      String(freshState.jour) !== String(jour)
    ) {
      await patchOriginal(webhookUrl, {
        content:
          "Le jour a changé pendant l'opération, réessaie sur le nouveau message.",
        embeds: [],
        components: [],
      });
      return;
    }

    const delta = computePiluleDelta(
      freshState.gauges,
      pilule.target,
      pilule.max_step,
    );
    const newGauges = applyGaugeDelta(freshState.gauges, delta);
    await writeState({ ...freshState, gauges: newGauges });

    await patchOriginal(webhookUrl, {
      content:
        "💊 Pilule administrée, les jauges de Lilith ont été rééquilibrées !",
      embeds: [],
      components: [],
    });

    // Repatch le message public — même découplage (PATCH direct au bot
    // token) que handleVoteButton, pour refléter les nouvelles jauges ET
    // l'état à jour du bouton Pilule (utilisée aujourd'hui / épuisée).
    const voteCounts = await tallyVotes(freshState.jour);
    const piluleState = await readPiluleState(
      freshState.jour,
      pilule.total_cap,
    );
    const estPremierJour = freshState.lastRating == null;
    const embed = await buildTamagotchiEmbed(
      freshState.jour,
      newGauges,
      config,
      freshState.lastEvent,
      freshState.starTotal,
      estPremierJour,
      freshState.dayVoters,
      freshState.lastRating,
      freshState.confiance,
    );
    const components = buildTamagotchiComponentsWithCounts(
      freshState.jour,
      config,
      voteCounts,
      piluleState,
    );

    await fetch(
      `https://discord.com/api/v10/channels/${freshState.channelId}/messages/${freshState.messageId}`,
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
    console.error("[Tamagotchi] Échec traitement Pilule:", err.message);
  }
}

// ── Bouton [📖 Règles du jeu] — éphémère, statique ────────────────

export async function handleRegles(webhookUrl) {
  try {
    const config = await loadTamagotchiConfig();
    const embed = buildReglesEmbed(config);
    await patchOriginal(webhookUrl, { embeds: [embed], components: [] });
  } catch (err) {
    console.error("[Tamagotchi] Échec Règles du jeu:", err.message);
  }
}
