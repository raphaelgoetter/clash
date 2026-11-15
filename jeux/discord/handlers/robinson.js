// ============================================================
// robinson.js — Handlers Discord pour Robinson (survie insulaire
// communautaire). Embed, boutons d'action (vote), Journal de Bord.
// La publication/suppression quotidienne passe uniquement par
// jeux/scripts/postRobinson.js (postRobinson) — les boutons restent gérés par
// api/discord/interactions.js.
// ============================================================

import {
  loadRobinsonConfig,
  loadNarratifs,
  readState,
  writeState,
  initEconomy,
  readStocks,
  readRadeauPoints,
  harvestResource,
  attemptRaftContribution,
  grantFreeRadeauPoints,
  recordVote,
  releaseVoteSlot,
  writeVoteDetail,
  getVoteDetail,
  tallyVotes,
  countUniqueVoters,
  listVotes,
  listHistorique,
  getHistoriqueEntry,
  rollHarvestAmount,
  rollEventCappedAmount,
  rollExplorerYield,
  rollCharpentierRadeauPoints,
  pickChefExplorateur,
  pickChefCharpentier,
  harvestCapForEvent,
  isExplorerDisabled,
  isRadeauDisabled,
  computeDailyConsumption,
  computeRaftSections,
  computeEpaveBoisBonus,
  computePoissonsPourrisLoss,
  spoilPoisson,
  isSurvivalVictory,
  isTooSoonSinceLastClosure,
  eventForDay,
  previewCloseDay,
  closeDayAndAdvance,
  finalizeDayClosure,
  updateZeroStreaks,
  ZERO_STREAK_LIMIT,
  grantResource,
  computeMancheScore,
  archiveManche,
  listManches,
  readConstructions,
  attemptConstructionContribution,
  incrementZone,
  readZones,
  drawEventProgramme,
  forecastForDay,
  computeEpuisementPalier,
  computeEpuisementMalus,
  computeHarvestAmount,
  computeExplorerAmount,
  isConstructionDone,
  constructionHarvestBonus,
  raftPointsPerVote,
  computeRadeauPlafondJour,
  computeAppauvrissement,
  harvestMaxForDay,
  readRadeauJour,
  computeDay1ConsumptionVoters,
  hasEmptyResource,
} from "../../services/robinson.js";
import {
  getRoleIdByName,
  buildRolePingFields,
  MINI_JEUX_ROLE_NAME,
} from "@clash/commun/discordRoles.js";
import { resolveDisplayName } from "@clash/commun/discordUsers.js";
import { formatUtcTimeAsParis } from "@clash/clash-royale/dateUtils.js";
import { encodePlateau } from "../../services/robinsonImage.js";

const ROBINSON_COLOR = 0x1abc9c;
const RESOURCE_LABELS = { poisson: "poisson(s)", eau: "eau", bois: "bois" };
const TRUST_ROYALE_URL = "https://trustroyale.vercel.app";

// Illustration du jour — fichiers statiques frontend/public/images/robinson/
// (rob-01.webp à rob-10.webp), servis tels quels par Vercel, même principe
// que tamagotchiImageUrl() dans jeux/discord/handlers/tamagotchi.js.
function robinsonImageUrl(jour) {
  return `${TRUST_ROYALE_URL}/images/robinson/rob-${String(jour).padStart(2, "0")}.webp`;
}

// Pitch affiché uniquement au Jour 1 — plante le décor et rappelle le
// principe en 2 phrases, avant de renvoyer vers le bouton Règles du jeu pour
// le détail complet (barème, consommation, événements). Fonction plutôt que
// constante depuis la refonte du 29/08 : `duree_jours` et `ZERO_STREAK_LIMIT`
// sont désormais interpolés depuis la config/le code plutôt que codés en dur
// dans le texte, pour ne plus jamais désynchroniser ce pitch d'un futur
// changement de durée ou de seuil de défaite.
function buildDay1Intro(config) {
  return (
    "⛵ **Naufrage général !** Le navire qui emmenait le clan vers le prochain tournoi d’Arène a sombré cette nuit dans la tempête. Par miracle, tout le monde s’est échoué sain et sauf sur une île déserte, sans le moindre Coffre à l’horizon.\n\n" +
    `Tenez ${config.duree_jours} jours, le temps que les secours repèrent l’épave, ou évadez-vous plus tôt en achevant un Radeau. Chaque membre vote une fois par jour ; si une ressource reste à 0 pendant ${ZERO_STREAK_LIMIT} jours de suite, c’est le naufrage définitif. Besoin d’un rappel ? Clique sur *Règles du jeu*.`
  );
}

// ── Texte narratif ────────────────────────────────────────────────
// Les variantes de phrases vivent dans jeux/data/robinson/narratifs.json (pas
// dans le code), même principe que jeux/data/tamagotchi/narratifs.json. La
// sélection est déterministe (indexée par le jour, pas Math.random()) : le
// narratif ne doit jamais changer entre deux ré-affichages du MÊME jour (ex.
// après chaque clic de vote qui repatch l'embed), seulement d'un jour à
// l'autre — même si la catégorie de stock (bas/normal/haut), elle, peut
// légitimement changer en cours de journée si le stock franchit un seuil.

function pickFlavor(pool, seed) {
  if (!pool?.length) return "";
  return pool[((seed % pool.length) + pool.length) % pool.length];
}

function stockCategory(resource, value) {
  if (value <= 3) return `${resource}_bas`;
  if (value >= 12) return `${resource}_haut`;
  return `${resource}_normal`;
}

async function pickVoterNames(voters) {
  if (!voters?.length) return [];
  const picked = voters.slice(0, 2);
  const resolved = await Promise.all(
    picked.map((v) => resolveDisplayName(v.discordId, v.username)),
  );
  return resolved.filter(Boolean);
}

// "normal" n'a volontairement aucun pool de texte associé : rien
// d'intéressant à raconter sur un stock ordinaire, la ligne est alors
// simplement omise plutôt que de meubler avec une phrase creuse.
async function buildNarrative(jour, stocks, voters, estPremierJour, config) {
  if (estPremierJour) return buildDay1Intro(config);

  const narratifs = await loadNarratifs();
  const intro = pickFlavor(narratifs.intro_cocasse, jour);

  const lines = [];
  const poissonKey = stockCategory("poisson", stocks.poisson);
  if (!poissonKey.endsWith("_normal"))
    lines.push(pickFlavor(narratifs[poissonKey], jour + 1));
  const eauKey = stockCategory("eau", stocks.eau);
  if (!eauKey.endsWith("_normal"))
    lines.push(pickFlavor(narratifs[eauKey], jour + 2));
  const boisKey = stockCategory("bois", stocks.bois);
  if (!boisKey.endsWith("_normal"))
    lines.push(pickFlavor(narratifs[boisKey], jour + 3));

  const names = await pickVoterNames(voters);
  if (names.length) {
    const template = pickFlavor(narratifs.cloture_votants, jour + 4);
    lines.push(
      template
        .replaceAll("{noms}", names.join(" et "))
        .replaceAll("{premier}", names[0]),
    );
  }

  if (!lines.length) return intro;
  return `${intro}\n\n${lines.join("\n")}`;
}

// ── Embed / composants du jour ────────────────────────────────────

const HARVEST_ACTIONS = ["peche", "eau", "bois", "explorer"];

function constructionIds(config) {
  return Object.keys(config.constructions ?? {});
}

// Besoin de la nuit affiché dans le message du jour : V de la veille, ou au
// Jour 1 une fraction des votants du jour (`consommation_jour1_ratio`).
function computeBesoinNuit(jour, config, vVeille, vJour) {
  const V = jour > 1 && vVeille != null ? vVeille : computeDay1ConsumptionVoters(vJour, config.consommation_jour1_ratio);
  return computeDailyConsumption(V);
}

// Ligne « 🔭 Demain » : événement programmé, Grosse Houle qui commence, ou
// arrivée des secours au dernier jour.
function buildForecastLines(jour, config, programme) {
  if (jour >= config.duree_jours) {
    return ["🚢 **Demain : les secours arrivent !** Aucune ressource ne doit être à 0 après cette dernière nuit (sauf Radeau achevé)."];
  }
  const lines = [];
  const prevu = forecastForDay(jour + 1, config.evenements, programme);
  if (prevu) {
    const detail = (prevu.prevision ?? "").replaceAll("{seuil}", prevu.condition_votants_veille_max ?? "");
    lines.push(`🔭 **Demain : ${prevu.emoji} ${prevu.nom}** (${detail})`);
  }
  const appauvDemain = computeAppauvrissement(jour + 1, config);
  if (appauvDemain > computeAppauvrissement(jour, config)) {
    lines.push(`🔭 **Demain : 🍂 l’île s’appauvrit** (récolte de 0 à ${harvestMaxForDay(jour + 1, config)}, Explorer ${3 - appauvDemain})`);
  }
  const houle = config.radeau_verrouille;
  if (houle && jour + 1 === houle.jour_debut) {
    lines.push(`🔭 **Demain : ${houle.emoji} ${houle.nom}** (Radeau indisponible jusqu’au Jour ${houle.jour_fin} inclus)`);
  }
  return lines;
}

// Plateau graphique du jour (/api/robinson/plateau, robinsonImage.js) :
// stocks et besoin de la nuit, Radeau, constructions, récolte du jour et
// frise des jours. Seuls les événements déjà vus, celui du jour et celui
// annoncé pour demain sont encodés (anti-spoiler).
function buildPlateauUrl({ jour, config, stocks, besoin, zeroStreaks, radeauPoints, radeauJour, constructions, eventsVus, event, programme, zones, palier }) {
  const prevu = jour < config.duree_jours ? forecastForDay(jour + 1, config.evenements, programme) : null;
  const evenements = { ...(eventsVus ?? {}) };
  if (event?.id) evenements[jour] = event.id;
  if (prevu) evenements[jour + 1] = prevu.id;
  const d = encodePlateau({
    jour,
    stocks,
    besoin: besoin ?? { poisson: 0, eau: 0, bois: 0 },
    zeroStreaks,
    radeauPoints,
    radeauJour,
    constructions,
    evenements,
    zones,
    palier,
    explorerBloque: isExplorerDisabled(event),
  });
  return `${TRUST_ROYALE_URL}/api/robinson/plateau?d=${d}`;
}

async function buildRobinsonEmbed({
  jour,
  stocks,
  radeauPoints,
  config,
  event,
  estPremierJour,
  voters,
  chefExplorateurId,
  chefCharpentierId,
  constructions = {},
  programme = null,
  palier = null,
  zones = {},
  besoin = null,
  zeroStreaks = {},
  radeauJour = 0,
  eventsVus = {},
}) {

  const narrative = await buildNarrative(jour, stocks, voters, estPremierJour, config);
  const lines = [narrative, ""];
  if (event) {
    lines.push(
      `**${event.emoji} Événement du jour : ${event.nom}**`,
      event.description,
    );
    // Perte réelle de Poissons Pourris, calculée dynamiquement selon V — le
    // texte statique de robinson.json ne peut pas l'inclure d'avance.
    if (event.perte != null) {
      lines.push(
        `🐟 -${event.perte} Poisson perdu${event.perte > 1 ? "s" : ""} cette nuit.`,
      );
    }
    lines.push("");
  }
  // Verrou anti-rush narré : affiché tant que le jour est dans la fenêtre de
  // config.radeau_verrouille, en plus de l'événement du jour éventuel.
  if (isRadeauDisabled(jour, config.radeau_verrouille)) {
    const { emoji, nom, description, jour_fin } = config.radeau_verrouille;
    lines.push(
      `**${emoji} ${nom}**`,
      description,
      `🛶 Radeau indisponible jusqu’au Jour ${jour_fin} inclus.`,
      "",
    );
  }
  // Chefs du jour : annoncés dès l'ouverture, choisis parmi les votants
  // réels de la veille (pickChefExplorateur()/pickChefCharpentier()).
  if (chefExplorateurId) {
    lines.push(
      `👑 **Chef explorateur du jour :** <@${chefExplorateurId}> récolte automatiquement 1 ressource de plus aujourd’hui sur Pêcher/Eau/Bois.`,
      "",
    );
  }
  if (chefCharpentierId) {
    lines.push(
      `🪓 **Chef charpentier du jour :** <@${chefCharpentierId}> peut construire en solo aujourd’hui : un vote Radeau de sa part ne coûte aucun Bois commun et rapporte des points doublés !`,
      "",
    );
  }
  // Le détail (besoin de la nuit, Radeau, constructions, récolte) est dans
  // le plateau ; le texte garde les stocks en une ligne et l'alerte à 0,
  // lisibles même si l'image ne se charge pas.
  const total = config.points_par_section * config.radeau_sections_max;
  lines.push(`🐟 **${stocks.poisson}** · 💧 **${stocks.eau}** · 🪵 **${stocks.bois}** · 🛶 **${Math.min(radeauPoints, total)}**/${total}`);
  const aZero = [["poisson", "Nourriture"], ["eau", "Eau"], ["bois", "Bois"]].filter(([id]) => stocks[id] <= 0).map(([, l]) => l);
  if (aZero.length) {
    lines.push(`⚠️ **${aZero.join(" et ")} à 0** : encore une journée comme ça et c'est la fin !`);
  }
  const forecast = buildForecastLines(jour, config, programme);
  if (forecast.length) lines.push("", ...forecast);

  return {
    title: `🏝️ Robinson (Jour ${jour}/${config.duree_jours})`,
    description: lines.join("\n"),
    color: ROBINSON_COLOR,
    image: {
      url: buildPlateauUrl({ jour, config, stocks, besoin, zeroStreaks, radeauPoints, radeauJour, constructions, eventsVus, event, programme, zones, palier }),
    },
    footer: {
      text: estPremierJour
        ? `Naufragés ! Survivez ensemble jusqu’au Jour ${config.duree_jours + 1}, ou évadez-vous avant en finissant le Radeau.`
        : `Votez avant ${formatUtcTimeAsParis(8)} demain pour orienter la journée.`,
    },
  };
}

// ── Jour de présentation (annonce) ─────────────────────────────────
// Publié au lancement manuel, la veille du Jour 1 (même modèle que Mario
// Clash) : aucun bouton de vote, seulement Règles.

function buildAnnonceEmbed(config) {
  return {
    title: "🏝️ Robinson : le navire lève l’ancre",
    description: [
      `Le clan embarque pour le prochain tournoi d’Arène… mais la météo s’annonce capricieuse. Préparez-vous à survivre **${config.duree_jours} jours** ensemble sur une île déserte (ou à vous évader plus tôt en Radeau).`,
      "",
      "Plus d’infos ? Clique sur *Règles* ci-dessous.",
    ].join("\n"),
    color: ROBINSON_COLOR,
    image: { url: robinsonImageUrl(1) },
    footer: { text: `La partie commence demain à ${formatUtcTimeAsParis(8)}.` },
  };
}

function buildAnnonceComponents() {
  return [
    {
      type: 1,
      components: [
        {
          type: 2,
          style: 2,
          label: "Règles",
          emoji: { name: "📖" },
          custom_id: "robinson_regles",
        },
      ],
    },
  ];
}

// Actions qui coûtent du Bois (Radeau et constructions), regroupées
// derrière le bouton Bâtir : le message public garde une seule rangée
// d'actions (récolter ou bâtir), le choix du chantier se fait en éphémère.
const BATIR = { id: "batir", label: "Bâtir", emoji: "🔨" };

// Chantiers proposés par le menu Bâtir : Radeau hors Grosse Houle, puis les
// constructions inachevées, dans l'ordre de la config.
function listChantiers(jour, config, constructions, radeauJour = 0) {
  const chantiers = [];
  if (
    config.actions.radeau &&
    !isRadeauDisabled(jour, config.radeau_verrouille) &&
    radeauJour < computeRadeauPlafondJour(config)
  ) {
    chantiers.push("radeau");
  }
  for (const [id, c] of Object.entries(config.constructions ?? {})) {
    if (!isConstructionDone(constructions?.[id] ?? 0, c)) chantiers.push(id);
  }
  return chantiers;
}

function buildRobinsonComponents(jour, config, voteCounts, event, constructions = {}, radeauJour = 0) {
  const recoltes = HARVEST_ACTIONS.filter(
    (id) => config.actions[id] && !(id === "explorer" && isExplorerDisabled(event)),
  );
  const chantiers = listChantiers(jour, config, constructions, radeauJour);
  // Compteur du bouton Bâtir : tous les votes Radeau et construction du jour.
  const votesBatir = ["radeau", ...Object.keys(config.constructions ?? {})].reduce(
    (total, id) => total + (voteCounts[id] || 0),
    0,
  );

  const actions = recoltes.map((id) => {
    const action = config.actions[id];
    return {
      type: 2,
      style: 2,
      label: `${action.label} (${voteCounts[id] || 0})`.slice(0, 80),
      emoji: { name: action.emoji },
      custom_id: `robinson_vote:${jour}:${id}`,
    };
  });
  if (chantiers.length) {
    actions.push({
      type: 2,
      style: 2,
      label: `${BATIR.label} (${votesBatir})`,
      emoji: { name: BATIR.emoji },
      custom_id: `robinson_vote:${jour}:${BATIR.id}`,
    });
  }

  return [
    { type: 1, components: actions },
    {
      type: 1,
      components: [
        {
          type: 2,
          style: 2,
          label: "Journal",
          emoji: { name: "📜" },
          custom_id: "robinson_journal",
        },
        {
          type: 2,
          style: 2,
          label: "Règles",
          emoji: { name: "📖" },
          custom_id: "robinson_regles",
        },
      ],
    },
  ];
}

// Le jeu est rejoué plusieurs fois dans l'année : la manche qui vient de se
// terminer est comparée aux précédentes (manches, currentManche — voir
// archiveManche()/listManches()/computeMancheScore() dans robinson.js),
// avec un 🏆 sur la meilleure manche toutes issues confondues.

// Exportée pour jeux/scripts/robinsonStatus.js (projection du Jour suivant).
export function outcomeLabel(outcome) {
  if (outcome === "victoire_radeau") return "🛶 Victoire (Radeau)";
  // Libellé volontairement générique (pas "Jour X" codé en dur) : l'ID
  // interne "victoire_jour11" date du calendrier à 10 jours (le dernier
  // jour de survie s'appelait alors Jour 11) et n'a pas été renommé pour ne
  // pas casser le format des manches déjà archivées — mais le libellé
  // affiché doit rester correct quelle que soit `duree_jours` en vigueur.
  if (outcome === "victoire_jour11") return "🚢 Victoire (survie)";
  return "💀 Défaite";
}

function formatMancheLine(record, config, isCurrent, isBest) {
  const marker = isBest ? "🏆 " : "";
  const suffix = isCurrent ? " *(cette manche)*" : "";
  return `${marker}Manche ${record.manche} : ${outcomeLabel(record.outcome)}, jour ${record.jour}${suffix}`;
}

function buildManchesSection(manches, config, currentManche) {
  if (!manches.length) return [];
  const best = manches.reduce((a, b) =>
    computeMancheScore(b.outcome, b.jour, config.duree_jours) >
    computeMancheScore(a.outcome, a.jour, config.duree_jours)
      ? b
      : a,
  );
  return [
    "",
    "**📊 Manches précédentes**",
    ...manches.map((m) =>
      formatMancheLine(
        m,
        config,
        m.manche === currentManche,
        m.manche === best.manche,
      ),
    ),
  ];
}

function buildOutcomeEmbed(
  outcome,
  config,
  manches = [],
  currentManche = null,
  { derniereNuit = false } = {},
) {
  const image = { url: robinsonImageUrl(config.duree_jours) };
  const manchesLines = buildManchesSection(manches, config, currentManche);

  if (outcome === "victoire_radeau") {
    return {
      title: "🛶 Victoire anticipée : le Radeau est achevé !",
      description: [
        "Contre toute attente, la communauté a fini de construire le Radeau avant l’arrivée des secours ! Direction le large, l’île est enfin derrière vous.",
        ...manchesLines,
      ].join("\n"),
      color: 0xf1c40f,
      image,
    };
  }
  if (outcome === "victoire_jour11") {
    return {
      title: "🚢 Les secours sont arrivés !",
      description: [
        `Après ${config.duree_jours} jours de survie acharnée, un bateau apparaît enfin à l’horizon ! Bravo à tous les naufragés, vous avez survécu à l’île.`,
        ...manchesLines,
      ].join("\n"),
      color: 0xf1c40f,
      image,
    };
  }
  return {
    title: "💀 Naufrage définitif…",
    description: [
      derniereNuit
        ? "Les secours accostent au matin… mais le camp n’a pas tenu cette dernière nuit : une ressource critique est tombée à 0. L’aventure s’arrête ici."
        : `Une ressource critique est restée à 0 pendant ${ZERO_STREAK_LIMIT} jours de suite, l’île a eu raison du campement. L’aventure s’arrête ici.`,
      ...manchesLines,
    ].join("\n"),
    color: 0x2c3e50,
    image,
  };
}

// ── Publication quotidienne (appelée uniquement par jeux/scripts/postRobinson.js) ──

export async function postRobinson(
  channelId,
  {
    dryRun = false,
    noPing = false,
    isPublic = false,
    requireActiveState = false,
    force = false,
  } = {},
) {
  const config = await loadRobinsonConfig();
  const state = await readState();

  if (state?.termine) {
    return { termine: true };
  }

  // Garde-fou anti-double-avancée : un cron en retard qui se déclencherait
  // juste après une relance manuelle du même jour clôturerait un jour tout
  // juste ouvert, quasi sans laisser le temps de voter (incident réel du
  // 27/08). Jamais appliqué en dry-run : une simple projection en lecture
  // seule (jeux/scripts/robinsonStatus.js) n'écrit rien et ne peut pas causer ce
  // problème, quelle que soit sa fréquence d'appel. `force` permet un
  // rattrapage volontaire répété en test.
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
  // (l'état "annonce" compte comme partie lancée) — il ne doit jamais
  // démarrer une partie tout seul (voir workflow_dispatch vs schedule dans
  // .github/workflows/robinson.yml).
  if (!state && requireActiveState) {
    return { skipped: true };
  }

  // 1) Aucun état -> jour de présentation (jamais le Jour 1 directement).
  if (!state) {
    const embed = buildAnnonceEmbed(config);
    const components = buildAnnonceComponents();
    if (dryRun) {
      const pingRoleId = !noPing
        ? await getRoleIdByName(MINI_JEUX_ROLE_NAME)
        : null;
      return { dryRun: true, phase: "annonce", embed, components, pingRoleId };
    }
    return publishAndWriteState(channelId, null, {
      phase: "annonce",
      jour: null,
      event: null,
      zeroStreaks: { poisson: 0, eau: 0, bois: 0 },
      dayVoters: [],
      embed,
      components,
      noPing,
      estAnnonce: true,
    });
  }

  // 2) Transition présentation -> Jour 1 : rien à clôturer, initialisation
  // de l'économie (stocks initiaux, Radeau à 0) puis ouverture du Jour 1.
  // Pas de ping : le lancement a déjà été annoncé la veille.
  if (state.phase === "annonce") {
    const jour = 1;
    const stocks = config.stocks_initiaux;
    // Ordre des événements tiré une fois pour toute la manche, gardé dans
    // l'état (prévision affichée la veille de chaque événement).
    const programme = drawEventProgramme(config.evenements, config.duree_jours);
    const palierEpuisement = computeEpuisementPalier(null, config.epuisement);
    const embed = await buildRobinsonEmbed({
      jour,
      stocks,
      radeauPoints: 0,
      config,
      event: null,
      estPremierJour: true,
      voters: [],
      programme,
      palier: palierEpuisement,
      besoin: computeBesoinNuit(jour, config, null, 0),
    });
    const components = buildRobinsonComponents(jour, config, {}, null);

    if (dryRun) return { dryRun: true, phase: "jour", jour, embed, components };

    await initEconomy(config.stocks_initiaux, constructionIds(config));
    return publishAndWriteState(channelId, state, {
      phase: "jour",
      jour,
      programme,
      palierEpuisement,
      eventsVus: {},
      event: null,
      zeroStreaks: { poisson: 0, eau: 0, bois: 0 },
      dayVoters: [],
      embed,
      components,
      noPing,
      estAnnonce: false,
      estPremierJour: true,
    });
  }

  const closure = dryRun
    ? await previewCloseDay(state, config)
    : await closeDayAndAdvance(state, config);

  // Victoire par le Radeau : détectée par computeClosure elle-même (déjà
  // acquise avant même la conso du jour) — court-circuite tout, y compris
  // la défaite. Jamais annoncée en temps réel au clic, toujours révélée ici.
  if (closure.outcome === "victoire_radeau") {
    // Jamais archivé en dry-run NI sur le salon de test (isPublic) — seule
    // une vraie publication sur le salon public compte comme une manche
    // réelle (voir jeux/CONTRIBUTING.md, section Manches).
    let currentManche = null;
    if (!dryRun && isPublic) {
      currentManche = await archiveManche({
        outcome: closure.outcome,
        jour: state.jour,
        radeauPoints: closure.radeauPoints,
        resolvedAt: new Date().toISOString(),
      });
    }
    const manches = await listManches({ limit: 10 });
    const embed = buildOutcomeEmbed(
      closure.outcome,
      config,
      manches,
      currentManche,
    );
    if (dryRun)
      return { dryRun: true, final: true, outcome: closure.outcome, embed };
    const result = await publishAndWriteState(channelId, state, {
      jour: state.jour,
      event: state.event,
      zeroStreaks: closure.zeroStreaksApres,
      dayVoters: [],
      embed,
      components: [],
      noPing,
      estAnnonce: false,
      termine: true,
    });
    return { ...result, final: true, outcome: closure.outcome };
  }

  const jourSuivant = state.jour + 1;
  // Dernière nuit : une ressource à 0 après la consommation du dernier jour
  // = défaite, même si les secours arrivent (le Radeau achevé a déjà été
  // traité plus haut). Sans cette règle, le dernier jour serait gratuit.
  if (
    isSurvivalVictory(jourSuivant, config.duree_jours) &&
    hasEmptyResource(closure.stocksApres)
  ) {
    let currentManche = null;
    if (!dryRun) {
      await finalizeDayClosure(state.jour, {
        V: closure.V,
        radeauVotes: closure.voters.filter((v) => v.actionId === "radeau").length,
        stocksAvant: closure.stocksAvant,
        stocksFinal: closure.stocksApres,
        consumption: closure.consumption,
        gobelinsVoleur: closure.gobelinsVoleur,
        event: state.event ?? null,
        previousZeroStreaks: state.zeroStreaks,
        outcome: "defaite",
      });
    }
    if (!dryRun && isPublic) {
      currentManche = await archiveManche({
        outcome: "defaite",
        jour: state.jour,
        radeauPoints: closure.radeauPoints,
        resolvedAt: new Date().toISOString(),
      });
    }
    const manches = await listManches({ limit: 10 });
    const embed = buildOutcomeEmbed("defaite", config, manches, currentManche, { derniereNuit: true });
    if (dryRun) return { dryRun: true, final: true, outcome: "defaite", embed };
    const result = await publishAndWriteState(channelId, state, {
      jour: state.jour,
      event: state.event,
      zeroStreaks: state.zeroStreaks,
      dayVoters: [],
      embed,
      components: [],
      noPing,
      estAnnonce: false,
      termine: true,
    });
    return { ...result, final: true, outcome: "defaite" };
  }
  if (isSurvivalVictory(jourSuivant, config.duree_jours)) {
    let currentManche = null;
    if (!dryRun && isPublic) {
      currentManche = await archiveManche({
        outcome: "victoire_jour11",
        jour: jourSuivant,
        radeauPoints: closure.radeauPoints,
        resolvedAt: new Date().toISOString(),
      });
    }
    const manches = await listManches({ limit: 10 });
    const embed = buildOutcomeEmbed(
      "victoire_jour11",
      config,
      manches,
      currentManche,
    );
    if (dryRun)
      return { dryRun: true, final: true, outcome: "victoire_jour11", embed };
    const result = await publishAndWriteState(channelId, state, {
      jour: state.jour,
      event: state.event,
      zeroStreaks: state.zeroStreaks,
      dayVoters: [],
      embed,
      components: [],
      noPing,
      estAnnonce: false,
      termine: true,
    });
    return { ...result, final: true, outcome: "victoire_jour11" };
  }

  // eventForDay reçoit le nombre de votants de la veille (closure.V) : les
  // événements conditionnels (Colis Royal) ou à montant dégressif (Épave)
  // en ont besoin. Les dons sont appliqués une seule fois, à l'arrivée du
  // jour concerné — jamais liés à un vote, jamais répétés à un reclic.
  const event = eventForDay(jourSuivant, config.evenements, closure.V, state.programme);
  const palierEpuisement = computeEpuisementPalier(closure.V, config.epuisement);
  let stocksPourEmbed = closure.stocksApres;
  let radeauPointsPourEmbed = closure.radeauPoints;
  let eventPourEmbed = event;
  // Chef Explorateur du jour : tiré parmi les votants RÉELS de la veille
  // (closure.voters), null si personne n'a voté — pas de Chef ce jour-là.
  // Jamais calculé en dry-run : ce serait un tirage au sort différent à
  // chaque appel de `npm run robinson:status`, sans rapport avec le Chef qui
  // sera réellement désigné au prochain cron.
  const chefExplorateurId = dryRun ? null : pickChefExplorateur(closure.voters);
  // Chef Charpentier du jour : même tirage, réservé aux jours où le Radeau
  // est déverrouillé (voir isRadeauDisabled) — inutile de désigner quelqu'un
  // pour un rôle qui ne peut avoir aucun effet ce jour-là. Exclut le Chef
  // Explorateur du tirage pour éviter de cumuler les deux rôles.
  const chefCharpentierId =
    dryRun || isRadeauDisabled(jourSuivant, config.radeau_verrouille)
      ? null
      : pickChefCharpentier(closure.voters, chefExplorateurId);

  // Épave (Jour 7) — inversée en don de Bois brut (au lieu de points de
  // Radeau directs) : le Bois doit encore être converti en points via de
  // vrais votes Radeau, ce qui réintroduit le vrai goulot d'étranglement
  // (le nombre de votes disponibles) au lieu de le contourner.
  if (event?.id === "epave") {
    const bonus = computeEpaveBoisBonus(event, closure.V);
    stocksPourEmbed = dryRun
      ? { ...stocksPourEmbed, bois: stocksPourEmbed.bois + bonus }
      : await grantResource("bois", bonus);
  }
  if (event?.id === "poissons_pourris") {
    const perte = computePoissonsPourrisLoss(
      closure.V,
      event.condition_votants_veille_max,
    );
    stocksPourEmbed = dryRun
      ? {
          ...closure.stocksApres,
          poisson: Math.max(0, closure.stocksApres.poisson - perte),
        }
      : await spoilPoisson(perte);
    eventPourEmbed = { ...event, perte };
  }

  // Défaite déterminée UNIQUEMENT sur le stock FINAL (après tous les bonus/
  // pertes ci-dessus) — jamais sur closure.stocksApres seul, qui ignore les
  // événements du jour suivant. Sans ça, un Colis Royal (ou toute autre
  // remontée) peut masquer à l'affichage un "jour à 0" déjà compté dans le
  // streak — la défaite doit se baser sur ce que les joueurs voient
  // réellement, jamais sur une valeur intermédiaire invisible (incident du
  // 26/08 sur l'Eau). `finalizeDayClosure()` écrit aussi l'historique et
  // vide les votes — jamais appelée en dry-run (aucune écriture).
  let zeroStreaksApres;
  let defeated;
  if (dryRun) {
    ({ streaks: zeroStreaksApres, defeated } = updateZeroStreaks(
      state.zeroStreaks,
      stocksPourEmbed,
    ));
  } else {
    const finalized = await finalizeDayClosure(state.jour, {
      V: closure.V,
      radeauVotes: closure.voters.filter((v) => v.actionId === "radeau").length,
      stocksAvant: closure.stocksAvant,
      stocksFinal: stocksPourEmbed,
      consumption: closure.consumption,
      gobelinsVoleur: closure.gobelinsVoleur,
      event: eventPourEmbed,
      previousZeroStreaks: state.zeroStreaks,
    });
    zeroStreaksApres = finalized.streaks;
    defeated = finalized.defeated;
  }

  if (defeated) {
    let currentManche = null;
    if (!dryRun && isPublic) {
      currentManche = await archiveManche({
        outcome: "defaite",
        jour: state.jour,
        radeauPoints: radeauPointsPourEmbed,
        resolvedAt: new Date().toISOString(),
      });
    }
    const manches = await listManches({ limit: 10 });
    const embedDefaite = buildOutcomeEmbed(
      "defaite",
      config,
      manches,
      currentManche,
    );
    if (dryRun)
      return {
        dryRun: true,
        final: true,
        outcome: "defaite",
        embed: embedDefaite,
      };
    const result = await publishAndWriteState(channelId, state, {
      jour: state.jour,
      event: state.event,
      zeroStreaks: zeroStreaksApres,
      dayVoters: [],
      embed: embedDefaite,
      components: [],
      noPing,
      estAnnonce: false,
      termine: true,
    });
    return { ...result, final: true, outcome: "defaite" };
  }

  const constructions = await readConstructions(constructionIds(config));
  const embed = await buildRobinsonEmbed({
    jour: jourSuivant,
    stocks: stocksPourEmbed,
    radeauPoints: radeauPointsPourEmbed,
    config,
    event: eventPourEmbed,
    estPremierJour: false,
    voters: closure.voters,
    chefExplorateurId,
    chefCharpentierId,
    constructions,
    programme: state.programme,
    palier: palierEpuisement,
    besoin: computeBesoinNuit(jourSuivant, config, closure.V, 0),
    zeroStreaks: zeroStreaksApres,
    eventsVus: state.eventsVus,
  });
  const components = buildRobinsonComponents(jourSuivant, config, {}, event, constructions);

  if (dryRun) {
    // stocks/radeauPoints exposés en plus de l'embed pour jeux/scripts/robinsonStatus.js
    // (projection numérique du Jour suivant), qui a besoin des valeurs brutes
    // plutôt que de reparser le texte de l'embed.
    return {
      dryRun: true,
      jour: jourSuivant,
      embed,
      components,
      event: eventPourEmbed,
      stocks: stocksPourEmbed,
      radeauPoints: radeauPointsPourEmbed,
    };
  }

  return publishAndWriteState(channelId, state, {
    jour: jourSuivant,
    programme: state.programme,
    // Événements réellement survenus (frise du plateau), jamais le programme à venir
    eventsVus: { ...(state.eventsVus ?? {}), ...(event ? { [jourSuivant]: event.id } : {}) },
    palierEpuisement,
    event: eventPourEmbed,
    chefExplorateurId,
    chefCharpentierId,
    zeroStreaks: zeroStreaksApres,
    dayVoters: closure.voters,
    embed,
    components,
    noPing: true,
    estAnnonce: false,
  });
}

// Supprime l'ancien message (tolérant), poste le nouveau, écrit l'état.
// Mirroring publishAndWriteState() dans jeux/discord/handlers/tamagotchi.js.
async function publishAndWriteState(
  channelId,
  previousState,
  {
    phase = "jour",
    jour,
    programme = previousState?.programme ?? null,
    palierEpuisement = previousState?.palierEpuisement ?? null,
    eventsVus = previousState?.eventsVus ?? {},
    event,
    chefExplorateurId = null,
    chefCharpentierId = null,
    zeroStreaks,
    dayVoters,
    embed,
    components,
    noPing,
    estAnnonce,
    estPremierJour = false,
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
          `[Robinson] Échec suppression du message de la veille (${delRes.status}), publication du nouveau jour quand même.`,
        );
      }
    } catch (err) {
      console.warn(
        "[Robinson] Erreur réseau à la suppression du message de la veille:",
        err.message,
      );
    }
  }

  // Ping à l'annonce, au Jour 1 et à la fin de manche (jamais les jours
  // intermédiaires).
  const roleId =
    (estAnnonce || estPremierJour || termine) && !noPing
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
    programme,
    palierEpuisement,
    eventsVus,
    event,
    chefExplorateurId,
    chefCharpentierId,
    zeroStreaks,
    dayVoters,
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
    console.error("[Robinson] Échec PATCH:", err.message);
  }
}

// Relit l'état public frais (stocks, radeau, compteurs de votes) et
// rafraîchit le message du salon en PATCH direct (bot token, pas webhook) —
// même découplage que handleVoteButton dans tamagotchi.js. Exportée pour
// jeux/scripts/robinsonRefresh.js : permet de corriger un texte statique (embed,
// intro) sur le message déjà publié sans avancer le jour ni toucher aux
// votes/stocks — contrairement à postRobinson(), qui clôturerait la journée.
export async function refreshPublicMessage(state, config, botToken) {
  const [stocks, radeauPoints, voteCounts, constructions, zones, veille, radeauJour] = await Promise.all([
    readStocks(),
    readRadeauPoints(),
    tallyVotes(state.jour),
    readConstructions(constructionIds(config)),
    readZones(state.jour),
    state.jour > 1 ? getHistoriqueEntry(state.jour - 1) : null,
    readRadeauJour(state.jour),
  ]);
  const vJour = Object.values(voteCounts).reduce((a, b) => a + b, 0);
  const embed = await buildRobinsonEmbed({
    jour: state.jour,
    stocks,
    radeauPoints,
    config,
    event: state.event,
    estPremierJour: state.jour === 1,
    voters: state.dayVoters,
    chefExplorateurId: state.chefExplorateurId,
    chefCharpentierId: state.chefCharpentierId,
    constructions,
    programme: state.programme,
    palier: state.palierEpuisement,
    zones,
    besoin: computeBesoinNuit(state.jour, config, veille?.V ?? null, vJour),
    zeroStreaks: state.zeroStreaks,
    radeauJour,
    eventsVus: state.eventsVus,
  });
  const components = buildRobinsonComponents(
    state.jour,
    config,
    voteCounts,
    state.event,
    constructions,
    radeauJour,
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
}

// Précisions entre parenthèses : épuisement et Filet/Citerne, seulement
// quand ils ont joué (concision des messages joueurs).
function formatModifiers(detail, config) {
  const parts = [];
  if (detail.malus > 0) parts.push(`zone épuisée −${detail.malus}`);
  if (detail.bonusConstruction > 0 && detail.constructionId) {
    const c = config.constructions?.[detail.constructionId];
    if (c) parts.push(`${c.label} +${detail.bonusConstruction}`);
  }
  return parts.length ? ` (${parts.join(", ")})` : "";
}

function formatHarvestConfirmation(actionId, config, detail) {
  if (actionId === "explorer") {
    const [resourceId, n] =
      Object.entries(detail.yields).find(([, v]) => v > 0) ?? [];
    return `🔍 Exploration réussie : tu ramènes ${n} ${RESOURCE_LABELS[resourceId]} !${formatModifiers(detail, config)}`;
  }
  const action = config.actions[actionId];
  if (detail.amount === 0) {
    return `${action.emoji} ${action.label} : bredouille cette fois-ci, rien à ramener !${formatModifiers(detail, config)}`;
  }
  const prefix = detail.isChef ? "👑 Chef explorateur du jour : " : "";
  return `${prefix}${action.emoji} ${action.label} : tu récoltes ${detail.amount} ${RESOURCE_LABELS[action.resource]} !${formatModifiers(detail, config)}`;
}

// ── Bouton de vote — actions de récolte (Pêcher/Eau/Bois/Explorer) ──
// Tirage EN DIRECT au moment du clic (décision validée) : le joueur voit
// immédiatement en éphémère ce qu'il a récolté. Ack routeur en type 5
// éphémère (comme Tamagotchi) — chaque vote a un résultat individuel à
// révéler en privé, le message public est mis à jour séparément par un
// second PATCH direct (bot token) au salon.

async function handleHarvestVote(
  webhookUrl,
  state,
  config,
  actionId,
  discordId,
  username,
  botToken,
) {
  const result = await recordVote(state.jour, discordId, actionId, username);

  if (result.status === "rejected") {
    await patchOriginal(webhookUrl, {
      content:
        "Tu as déjà voté aujourd’hui pour une autre action, ton vote est définitif jusqu’à demain !",
      embeds: [],
      components: [],
    });
    return;
  }

  if (result.status === "already_recorded") {
    const detail = await getVoteDetail(state.jour, discordId);
    await patchOriginal(webhookUrl, {
      content: detail
        ? formatHarvestConfirmation(actionId, config, detail)
        : "Tu as déjà voté cette action aujourd’hui, c’est noté !",
      embeds: [],
      components: [],
    });
    return;
  }

  // "recorded" — premier vote réussi du joueur ce jour-ci : le tirage a
  // réellement lieu maintenant, et le stock est incrémenté immédiatement.
  // Rang sur cette action aujourd'hui (épuisement), compté seulement pour
  // un vote réellement enregistré.
  const rang = await incrementZone(state.jour, actionId);
  const malus = computeEpuisementMalus(rang, state.palierEpuisement);

  let detail;
  if (actionId === "explorer") {
    const tirage = rollExplorerYield(Math.random);
    const [resourceId] = Object.entries(tirage).find(([, n]) => n > 0);
    const appauv = computeAppauvrissement(state.jour, config);
    const amount = computeExplorerAmount(malus + appauv, config.epuisement?.explorer_min ?? 1);
    await harvestResource(resourceId, amount);
    detail = {
      actionId,
      yields: { poisson: 0, eau: 0, bois: 0, [resourceId]: amount },
      malus,
      at: new Date().toISOString(),
    };
  } else {
    const resourceId = config.actions[actionId].resource;
    // Chef explorateur : +1 sur Pêcher/Eau/Bois (pas Explorer ni Radeau).
    // Filet/Citerne : +1 sur Pêcher/Eau une fois achevés.
    const isChef = state.chefExplorateurId === discordId;
    const constructions = await readConstructions(constructionIds(config));
    const bonusConstruction = constructionHarvestBonus(actionId, constructions, config.constructions);
    const baseRoll = harvestCapForEvent(state.event, actionId)
      ? rollEventCappedAmount(state.event, Math.random)
      : rollHarvestAmount(Math.random, harvestMaxForDay(state.jour, config));
    const amount = computeHarvestAmount({ baseRoll, malus, isChef, bonusConstruction });
    await harvestResource(resourceId, amount);
    detail = {
      actionId,
      amount,
      malus,
      bonusConstruction,
      constructionId: actionId === "peche" ? "filet" : actionId === "eau" ? "citerne" : null,
      at: new Date().toISOString(),
      isChef,
    };
  }
  await writeVoteDetail(state.jour, discordId, detail);

  await patchOriginal(webhookUrl, {
    content: formatHarvestConfirmation(actionId, config, detail),
    embeds: [],
    components: [],
  });

  await refreshPublicMessage(state, config, botToken);
}

// ── Bouton de vote — Construire le Radeau ──
// Seule action pouvant échouer (stock de Bois insuffisant) : si elle échoue,
// le slot de vote réservé par recordVote() est libéré (releaseVoteSlot), le
// joueur peut réessayer plus tard dans la journée sans avoir "gâché" son vote.

async function handleRadeauVote(
  webhookUrl,
  state,
  config,
  discordId,
  username,
  botToken,
) {
  const result = await recordVote(state.jour, discordId, "radeau", username);

  if (result.status === "rejected") {
    await patchOriginal(webhookUrl, {
      content:
        "Tu as déjà voté aujourd’hui pour une autre action, ton vote est définitif jusqu’à demain !",
      embeds: [],
      components: [],
    });
    return;
  }

  if (result.status === "already_recorded") {
    await patchOriginal(webhookUrl, {
      content: "🛶 Tu as déjà contribué au Radeau aujourd’hui, c’est noté !",
      embeds: [],
      components: [],
    });
    return;
  }

  const plafond = { jour: state.jour, plafond: computeRadeauPlafondJour(config) };
  const refusPlafond = async () => {
    await releaseVoteSlot(state.jour, discordId);
    await patchOriginal(webhookUrl, {
      content: `🛶 Le Radeau a assez avancé pour aujourd’hui (${plafond.plafond} points au maximum par jour), choisis une autre action !`,
      embeds: [],
      components: [],
    });
  };

  // Chef Charpentier : aucun coût en Bois, tirage de récolte +1 doublé,
  // plafond quotidien compris (gain partiel s'il reste moins).
  if (state.chefCharpentierId === discordId) {
    const gain = rollCharpentierRadeauPoints(Math.random);
    const don = await grantFreeRadeauPoints(gain, plafond);
    if (!don.success) {
      await refusPlafond();
      return;
    }
    await writeVoteDetail(state.jour, discordId, {
      actionId: "radeau",
      pointsAdded: don.pointsAjoutes,
      isCharpentier: true,
      at: new Date().toISOString(),
    });
    await patchOriginal(webhookUrl, {
      content: `🪓 Chef charpentier du jour : tu construis en solo, sans toucher au Bois commun : +${don.pointsAjoutes} points de construction (total : ${don.points}) !`,
      embeds: [],
      components: [],
    });
    await refreshPublicMessage(state, config, botToken);
    return;
  }

  const constructions = await readConstructions(constructionIds(config));
  const pointsGagnes = raftPointsPerVote(constructions, config.constructions);
  const contribution = await attemptRaftContribution(
    config.bois_par_point_radeau,
    pointsGagnes,
    plafond,
  );
  if (!contribution.success && contribution.raison === "plafond") {
    await refusPlafond();
    return;
  }
  if (!contribution.success) {
    await releaseVoteSlot(state.jour, discordId);
    await patchOriginal(webhookUrl, {
      content: `🛶 Pas assez de Bois pour construire le Radeau (il en faut ${config.bois_par_point_radeau}), réessaie plus tard si le stock remonte !`,
      embeds: [],
      components: [],
    });
    return;
  }

  await writeVoteDetail(state.jour, discordId, {
    actionId: "radeau",
    pointsAdded: contribution.pointsAjoutes,
    boisRestant: contribution.boisRestant,
    at: new Date().toISOString(),
  });
  const ajout = contribution.pointsAjoutes;
  await patchOriginal(webhookUrl, {
    content: `🛶 Contribution réussie ! +${ajout} point${ajout > 1 ? "s" : ""} de construction${ajout > 1 ? " (Atelier)" : ""}, il reste ${contribution.boisRestant} Bois.`,
    embeds: [],
    components: [],
  });

  await refreshPublicMessage(state, config, botToken);
}

// ── Bouton de vote — constructions (Filet, Citerne, Atelier) ──────
// Même principe que le Radeau : 1 vote + 1 Bois commun = 1 point. Refus
// sans consommer le vote si le Bois manque ou si la construction est déjà
// achevée (slot libéré, le joueur peut voter autre chose).
async function handleConstructionVote(
  webhookUrl,
  state,
  config,
  constructionId,
  discordId,
  username,
  botToken,
) {
  const construction = config.constructions[constructionId];
  const result = await recordVote(state.jour, discordId, constructionId, username);

  if (result.status === "rejected") {
    await patchOriginal(webhookUrl, {
      content:
        "Tu as déjà voté aujourd’hui pour une autre action, ton vote est définitif jusqu’à demain !",
      embeds: [],
      components: [],
    });
    return;
  }
  if (result.status === "already_recorded") {
    await patchOriginal(webhookUrl, {
      content: `${construction.emoji} Tu as déjà travaillé sur : ${construction.nom} aujourd’hui, c’est noté !`,
      embeds: [],
      components: [],
    });
    return;
  }

  const contribution = await attemptConstructionContribution(
    constructionId,
    construction.cout,
    config.bois_par_point_radeau,
  );
  if (!contribution.success) {
    await releaseVoteSlot(state.jour, discordId);
    await patchOriginal(webhookUrl, {
      content:
        contribution.raison === "achevee"
          ? `${construction.emoji} ${construction.nom} : déjà achevé, choisis une autre action !`
          : `${construction.emoji} Pas assez de Bois pour construire (il en faut ${config.bois_par_point_radeau}), réessaie plus tard si le stock remonte !`,
      embeds: [],
      components: [],
    });
    return;
  }

  await writeVoteDetail(state.jour, discordId, {
    actionId: constructionId,
    pointsAdded: 1,
    boisRestant: contribution.boisRestant,
    at: new Date().toISOString(),
  });
  await patchOriginal(webhookUrl, {
    content: contribution.achevee
      ? `${construction.emoji} ${construction.nom} achevé grâce à toi ! Effet immédiat : ${construction.description}.`
      : `${construction.emoji} ${construction.nom} : +1 point (${contribution.points}/${construction.cout}), il reste ${contribution.boisRestant} Bois.`,
    embeds: [],
    components: [],
  });

  await refreshPublicMessage(state, config, botToken);
}

// ── Bouton Bâtir — menu éphémère des chantiers ─────────────────────
// Ne consomme pas le vote : le vote a lieu au clic sur un chantier du menu
// (`robinson_vote:<jour>:<chantier>`, même routage que les autres actions).
async function handleBatirMenu(webhookUrl, state, config, discordId) {
  if (await getVoteDetail(state.jour, discordId)) {
    await patchOriginal(webhookUrl, {
      content: "Tu as déjà voté aujourd’hui, ton vote est définitif jusqu’à demain !",
      embeds: [],
      components: [],
    });
    return;
  }
  const total = config.points_par_section * config.radeau_sections_max;
  const [stocks, radeauPoints, constructions, radeauJour] = await Promise.all([
    readStocks(),
    readRadeauPoints(),
    readConstructions(constructionIds(config)),
    readRadeauJour(state.jour),
  ]);
  const chantiers = listChantiers(state.jour, config, constructions, radeauJour);
  const plafondJour = computeRadeauPlafondJour(config);
  if (!chantiers.length) {
    await patchOriginal(webhookUrl, {
      content: "Rien à bâtir aujourd’hui !",
      embeds: [],
      components: [],
    });
    return;
  }

  const estCharpentier = state.chefCharpentierId === discordId;
  const parVote = raftPointsPerVote(constructions, config.constructions);
  const lignes = chantiers.map((id) => {
    if (id === "radeau") {
      const effet = estCharpentier
        ? "🪓 gratuit pour toi aujourd’hui, points doublés"
        : `1 Bois = ${parVote} point${parVote > 1 ? "s" : ""}`;
      const resteJour = Number.isFinite(plafondJour) ? `, encore ${plafondJour - radeauJour} aujourd’hui` : "";
      return `${config.actions.radeau.emoji} **Radeau** ${radeauPoints}/${total} : ${effet}${resteJour}`;
    }
    const c = config.constructions[id];
    return `${c.emoji} **${c.nom}** ${constructions[id] ?? 0}/${c.cout} : ${c.description}`;
  });

  await patchOriginal(webhookUrl, {
    content: [
      `🔨 **Bâtir** (1 vote + 1 Bois = 1 point, il reste ${stocks.bois} Bois) :`,
      ...lignes,
    ].join("\n"),
    embeds: [],
    components: [
      {
        type: 1,
        components: chantiers.map((id) => {
          const item = id === "radeau" ? config.actions.radeau : config.constructions[id];
          return {
            type: 2,
            style: 2,
            label: item.label,
            emoji: { name: item.emoji },
            custom_id: `robinson_vote:${state.jour}:${id}`,
          };
        }),
      },
    ],
  });
}

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
          "Le vote du jour a déjà été clôturé, la journée a changé : regarde le nouveau message !",
        embeds: [],
        components: [],
      });
      return;
    }

    if (actionId === BATIR.id) {
      await handleBatirMenu(webhookUrl, state, await loadRobinsonConfig(), discordId);
      return;
    }

    if (actionId === "explorer" && isExplorerDisabled(state.event)) {
      await patchOriginal(webhookUrl, {
        content:
          "🧌 L’exploration est bloquée aujourd’hui à cause des Gobelins !",
        embeds: [],
        components: [],
      });
      return;
    }

    const config = await loadRobinsonConfig();

    // Verrou anti-rush (26/08), narré par l'événement "Grosse Houle" plutôt
    // que codé en dur — le bouton est déjà masqué dans les composants
    // pendant la fenêtre (buildRobinsonComponents()), ce contrôle ne sert
    // que de filet si un joueur clique sur un vieux message affiché avant la
    // clôture du jour.
    if (
      actionId === "radeau" &&
      isRadeauDisabled(jour, config.radeau_verrouille)
    ) {
      const { emoji, nom, jour_fin } = config.radeau_verrouille;
      await patchOriginal(webhookUrl, {
        content: `${emoji} ${nom} : le Radeau est hors de portée avec une mer pareille, reviens à partir du Jour ${jour_fin + 1} !`,
        embeds: [],
        components: [],
      });
      return;
    }

    if (config.constructions?.[actionId]) {
      await handleConstructionVote(
        webhookUrl,
        state,
        config,
        actionId,
        discordId,
        username,
        botToken,
      );
      return;
    }

    if (!config.actions[actionId]) {
      // Identifiant inconnu (bouton d'une ancienne version du jeu).
      await patchOriginal(webhookUrl, {
        content: "Ce bouton n’est plus valable, utilise le message du jour !",
        embeds: [],
        components: [],
      });
      return;
    }

    if (actionId === "radeau") {
      await handleRadeauVote(
        webhookUrl,
        state,
        config,
        discordId,
        username,
        botToken,
      );
      return;
    }

    await handleHarvestVote(
      webhookUrl,
      state,
      config,
      actionId,
      discordId,
      username,
      botToken,
    );
  } catch (err) {
    console.error("[Robinson] Échec traitement du vote:", err.message);
  }
}

// ── Bouton [📜 Journal de Bord] — lecture seule, hors-vote ──────────
// Ne consomme jamais le vote du jour, relit toujours l'état courant (pas de
// garde de fraîcheur nécessaire, contrairement à un vote).

function formatHistoriqueLine(entry) {
  if (entry.outcome === "victoire_radeau")
    return `Jour ${entry.jour} : 🛶 Victoire par le Radeau !`;
  if (entry.outcome === "victoire_jour11")
    return `Jour ${entry.jour} : 🚢 Les secours sont arrivés !`;
  if (entry.outcome === "defaite") return `Jour ${entry.jour} : 💀 Naufrage.`;
  const vol = entry.gobelinsVoleur
    ? " (🧌 les Gobelins ont volé 5 Poissons)"
    : "";
  // radeauVotes absent sur les entrées enregistrées avant le 25/08 (champ
  // ajouté après coup) — omis proprement plutôt que d'afficher "undefined".
  const radeau =
    entry.radeauVotes != null
      ? `, ${entry.radeauVotes} vote${entry.radeauVotes > 1 ? "s" : ""} radeau`
      : "";
  return `Jour ${entry.jour} : ${entry.V} joueur${entry.V > 1 ? "s" : ""}${radeau}${vol}`;
}

export async function handleJournal(webhookUrl) {
  try {
    const state = await readState();
    if (!state) {
      await patchOriginal(webhookUrl, {
        content: "Aucune partie Robinson en cours pour le moment.",
        embeds: [],
        components: [],
      });
      return;
    }
    if (state.phase === "annonce") {
      await patchOriginal(webhookUrl, {
        content: `La partie commence demain à ${formatUtcTimeAsParis(8)}, rien à consulter pour l’instant.`,
        embeds: [],
        components: [],
      });
      return;
    }

    const [stocks, V, radeauPoints, config, { entries }, veille] =
      await Promise.all([
        readStocks(),
        countUniqueVoters(state.jour),
        readRadeauPoints(),
        loadRobinsonConfig(),
        listHistorique({ limit: 10 }),
        state.jour > 1 ? getHistoriqueEntry(state.jour - 1) : null,
      ]);
    // Le besoin projeté se base sur la mobilisation de LA VEILLE (V d'hier),
    // pas sur le décompte du jour en cours — sinon "couvert" est trivialement
    // vrai en tout début de journée (peu de votants encore comptés = besoin
    // minuscule), un signal trompeur qui masque une vraie baisse de
    // mobilisation au lieu de la révéler. Le Jour 1 n'a pas de veille : seul
    // cas où on garde le décompte du jour même (comportement historique).
    const besoin = computeBesoinNuit(state.jour, config, veille?.V ?? null, V);
    const manque = {
      poisson: Math.max(0, besoin.poisson - stocks.poisson),
      eau: Math.max(0, besoin.eau - stocks.eau),
      bois: Math.max(0, besoin.bois - stocks.bois),
    };
    const sections = computeRaftSections(
      radeauPoints,
      config.points_par_section,
    );
    const baseBesoin =
      state.jour > 1 && veille
        ? ` (estimés sur les ${veille.V} joueurs d’hier)`
        : " (provisions du navire : seule une partie des joueurs du jour compte)";

    const lines = [
      `**Joueurs aujourd’hui : ${V}**`,
      `🛶 Radeau : ${radeauPoints} pts (${sections}/${config.radeau_sections_max} sections)`,
      "",
      `**Besoins pour la clôture de ${formatUtcTimeAsParis(8)} ${baseBesoin} :**`,
      `🐟 Nourriture : ${besoin.poisson} nécessaire${manque.poisson > 0 ? ` (**il en manque ${manque.poisson}**)` : " (couvert)"}`,
      `💧 Eau : ${besoin.eau} nécessaire${manque.eau > 0 ? ` (**il en manque ${manque.eau}**)` : " (couvert)"}`,
      `🪵 Bois : ${besoin.bois} nécessaire${manque.bois > 0 ? ` (**il en manque ${manque.bois}**)` : " (couvert)"}`,
    ];

    // Compteurs de jours consécutifs à 0 — invisibles partout ailleurs
    // (aucun embed public ne les affiche). N'apparaît que si au moins une
    // ressource est déjà en streak, pour ne pas polluer l'affichage en
    // temps normal.
    const streakWarnings = [
      state.zeroStreaks?.poisson > 0
        ? `🐟 Nourriture : ${state.zeroStreaks.poisson}/${ZERO_STREAK_LIMIT} jours à 0`
        : null,
      state.zeroStreaks?.eau > 0
        ? `💧 Eau : ${state.zeroStreaks.eau}/${ZERO_STREAK_LIMIT} jours à 0`
        : null,
      state.zeroStreaks?.bois > 0
        ? `🪵 Bois : ${state.zeroStreaks.bois}/${ZERO_STREAK_LIMIT} jours à 0`
        : null,
    ].filter(Boolean);
    if (streakWarnings.length > 0) {
      lines.push(
        "",
        `**⚠️ Jours consécutifs à 0 (naufrage à ${ZERO_STREAK_LIMIT}) :**`,
        ...streakWarnings,
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
      title: "📜 Journal de Bord",
      description: lines.join("\n"),
      color: ROBINSON_COLOR,
    };
    await patchOriginal(webhookUrl, { embeds: [embed], components: [] });
  } catch (err) {
    console.error("[Robinson] Échec Journal de Bord:", err.message);
  }
}

// ── Bouton [📖 Règles du jeu] — éphémère, statique ────────────────
// Ne consomme jamais le vote du jour, contenu généré depuis robinson.json,
// aucune lecture/écriture d'état (même principe que Tamagotchi).

function buildReglesEmbed(config) {
  const total = config.points_par_section * config.radeau_sections_max;
  const ep = config.epuisement;
  const actionLines = Object.entries(config.actions).map(([id, action]) => {
    if (id === "radeau") return null; // présenté avec les constructions (bouton Bâtir)
    if (id === "explorer") {
      return `${action.emoji} **${action.label}** : 3 unités d’une ressource tirée au hasard.`;
    }
    return `${action.emoji} **${action.label}** : 0 à 5 ${RESOURCE_LABELS[action.resource]} au hasard.`;
  }).filter(Boolean);
  const constructionLines = Object.values(config.constructions ?? {}).map(
    (c) => `${c.emoji} **${c.nom}** (${c.cout} points) : ${c.description}.`,
  );

  return {
    title: "📖 Règles du jeu Robinson",
    description: [
      `Naufragés sur une île, survivez ${config.duree_jours} jours jusqu’à l’arrivée des secours au Jour ${config.duree_jours + 1}, ou évadez-vous plus tôt en achevant le Radeau.`,
      "",
      "**Actions (1 vote par membre et par jour) :**",
      ...actionLines,
      "",
      ...(ep
        ? [
            `**Épuisement :** sur une même action, chaque groupe de récolteurs du jour retire 1 à la récolte suivante (palier affiché dans le message du jour). Répartissez-vous !`,
            "",
          ]
        : []),
      `${BATIR.emoji} **Bâtir** (1 vote + 1 Bois = 1 point, chantier choisi après le clic, effet immédiat une fois achevé) :`,
      `${config.actions.radeau.emoji} **Radeau** (${total} points) : l’évasion !${Number.isFinite(computeRadeauPlafondJour(config)) ? ` Au plus ${computeRadeauPlafondJour(config)} points par jour.` : ""}`,
      ...constructionLines,
      "",
      "**Consommation chaque nuit** (V = votants de la veille) : −V Nourriture, −V Eau, −⌈V/2⌉ Bois. La première nuit, seule la moitié des votants compte.",
      "",
      `**Défaite :** une ressource à 0 pendant ${ZERO_STREAK_LIMIT} jours de suite, ou à 0 après la dernière nuit.`,
      "",
      ...(Array.isArray(config.appauvrissement) && config.appauvrissement.some((m) => m > 0)
        ? ["🍂 **L’île s’appauvrit** au fil des jours : les récoltes diminuent (annoncé la veille). Les constructions, elles, gardent leur bonus.", ""]
        : []),
      "🔭 Les événements qui frappent l’île sont annoncés la veille.",
      "",
      "📜 **Journal de Bord** : besoins du jour et historique, sans consommer ton vote.",
      "",
      "Un vote n’est pas modifiable une fois qu’il a réellement abouti.",
    ].join("\n"),
    color: ROBINSON_COLOR,
  };
}

export async function handleRegles(webhookUrl) {
  try {
    const config = await loadRobinsonConfig();
    const embed = buildReglesEmbed(config);
    await patchOriginal(webhookUrl, { embeds: [embed], components: [] });
  } catch (err) {
    console.error("[Robinson] Échec Règles du jeu:", err.message);
  }
}
