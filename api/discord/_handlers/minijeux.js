// ============================================================
// minijeux.js — Handler Discord pour /mini-jeux : état des lieux de tous
// les mini-jeux réguliers (Frame, Jeux de lettres [Anagram/Pêle-mêle en
// alternance], Jeux visuels [Zoom carte/Palette en alternance], La Juste
// Carte) et du jeu spécial actuellement actif (Quiz, Tamagotchi, Robinson, Boss Raid,
// Goblin Hunters, Blackjack, Mario Clash ou Gobelet). Lecture seule, aucune
// écriture Redis.
//
// ⚠️ Goblin Hunters : ne jamais lire/afficher state.joueurs[].camp/role/pv —
// seuls le nombre d'inscrits/vivants et le jour sont publics (voir la mise
// en garde de scripts/goblinHuntersStatus.js).
// ============================================================

import { readState as readBlindRoyaleState } from "../../../backend/services/blindroyale.js";
import { readState as readFrameState } from "../../../backend/services/frames.js";
import { readState as readZoomState } from "../../../backend/services/zoom.js";
import { readState as readPaletteState } from "../../../backend/services/palette.js";
import { readState as readAnagramState } from "../../../backend/services/anagrams.js";
import { readState as readPeleMeleState } from "../../../backend/services/pelemele.js";
import { readState as readJusteCarteState } from "../../../backend/services/lajustecarte.js";
import {
  getCurrentSeasonId as getAveugleSeasonId,
  getActiveBlindGame,
} from "../../../backend/services/jeuxaveugle.js";
import {
  getCurrentSeasonId as getLettresSeasonId,
  getActiveLetterGame,
} from "../../../backend/services/jeuxdelettres.js";
import {
  getCurrentSeasonId as getVisuelsSeasonId,
  getActiveVisualGame,
} from "../../../backend/services/jeuxvisuels.js";
import {
  getCurrentSeasonId as getCultureSeasonId,
  getActiveCultureGame,
} from "../../../backend/services/jeuxculture.js";
import { readState as readTriviaState } from "../../../backend/services/trivia.js";

import {
  readState as readQuizState,
  loadQuizConfig,
  listVotes as listQuizVotes,
} from "../../../backend/services/quiz.js";
import {
  readState as readTamaState,
  loadTamagotchiConfig,
  listVotes as listTamaVotes,
} from "../../../backend/services/tamagotchi.js";
import {
  readState as readRobinsonState,
  loadRobinsonConfig,
  countUniqueVoters as countRobinsonVoters,
} from "../../../backend/services/robinson.js";
import {
  readState as readBossraidState,
  loadBossRaidConfig,
  countUniqueVoters as countBossraidVoters,
} from "../../../backend/services/bossraid.js";
import {
  readState as readGoblinState,
  loadGoblinHuntersConfig,
  listInscriptions as listGoblinInscriptions,
} from "../../../backend/services/goblinhunters.js";
import {
  readState as readBlackjackState,
  loadBlackjackConfig,
  listHands as listBlackjackHands,
} from "../../../backend/services/blackjack.js";
import {
  readState as readMarioClashState,
  loadMarioClashConfig,
  readActions as readMarioClashActions,
} from "../../../backend/services/marioclash.js";
import {
  readState as readGobeletState,
  loadGobeletConfig,
  listHands as listGobeletHands,
} from "../../../backend/services/gobelet.js";
import { BLACKJACK_START_IMAGE_URL } from "./blackjack.js";

import { getCurrentSeasonBounds } from "../../../backend/services/dateUtils.js";

const MINIJEUX_COLOR = 0x5865f2;
const BAR_SEGMENTS = 7;

// Même salon pour tous les mini-jeux (voir DISCORD_CHANNEL_FRAME_PUBLIC
// réutilisé par tous les workflows .github/workflows/*.yml) — sert aussi de
// garde-fou : une partie active sur le salon de test ne doit jamais
// apparaître ici comme état "public".
const PUBLIC_CHANNEL_ID = process.env.DISCORD_CHANNEL_FRAME_PUBLIC;

function channelLink() {
  const guildId = process.env.DISCORD_GUILD_ID;
  if (!guildId || !PUBLIC_CHANNEL_ID) return null;
  return `https://discord.com/channels/${guildId}/${PUBLIC_CHANNEL_ID}`;
}

// "Jeux à l'aveugle" (lundi) : Blind Royale et La Juste Carte alternent une
// saison Clash Royale sur deux (voir jeuxaveugle.js, même fonction utilisée
// par scripts/postJeuxAveugle.js pour la publication) — un seul des deux est
// actif à la fois, jamais les deux en même temps (même mécanisme que
// VISUELS_GAMES/LETTRES_GAMES/CULTURE_GAMES ci-dessous).
const AVEUGLE_GAMES = {
  blindroyale: { title: "🎧 Blind Royale", readState: readBlindRoyaleState },
  lajustecarte: { title: "🃏 La Juste Carte", readState: readJusteCarteState },
};

// "Jeux visuels" (vendredi) et "Jeux de lettres" (samedi) alternent chacun
// entre deux jeux une saison Clash Royale sur deux (voir jeuxvisuels.js /
// jeuxdelettres.js, mêmes fonctions utilisées par scripts/postJeuxVisuels.js
// et postJeuxDeLettres.js pour la publication) — /mini-jeux doit donc
// résoudre le jeu réellement actif plutôt que d'en référencer un seul en dur.
const VISUELS_GAMES = {
  zoom: { title: "🔍 Zoom carte", readState: readZoomState },
  palette: { title: "🎨 Palette", readState: readPaletteState },
};
const LETTRES_GAMES = {
  anagram: { title: "🔤 Anagram", readState: readAnagramState },
  pelemele: { title: "🔤 Pêle-mêle", readState: readPeleMeleState },
};
// "Mini-jeux de Culture" (mercredi) : Frame et Trivia alternent une saison
// Clash Royale sur deux (voir jeuxculture.js), même mécanisme que
// VISUELS_GAMES/LETTRES_GAMES ci-dessus.
const CULTURE_GAMES = {
  frame: { title: "🎬 Trouve le film !", readState: readFrameState },
  trivia: { title: "🧠 Trivia", readState: readTriviaState },
};

// getCurrentSeasonId() peut renvoyer null (API Clash Royale indisponible) :
// on retombe alors sur le jeu "historique" de la paire plutôt que de planter
// l'embed /mini-jeux.
async function resolveActiveAveugleGame() {
  const seasonId = await getAveugleSeasonId();
  const key = seasonId == null ? "lajustecarte" : getActiveBlindGame(seasonId);
  return AVEUGLE_GAMES[key];
}

async function resolveActiveVisuelsGame() {
  const seasonId = await getVisuelsSeasonId();
  const key = seasonId == null ? "zoom" : getActiveVisualGame(seasonId);
  return VISUELS_GAMES[key];
}

async function resolveActiveLettresGame() {
  const seasonId = await getLettresSeasonId();
  const key = seasonId == null ? "anagram" : getActiveLetterGame(seasonId);
  return LETTRES_GAMES[key];
}

async function resolveActiveCultureGame() {
  const seasonId = await getCultureSeasonId();
  const key = seasonId == null ? "frame" : getActiveCultureGame(seasonId);
  return CULTURE_GAMES[key];
}

// Un seul actif à la fois par convention (voir les gardes-fous "wrongChannel"
// dans chaque handler *_handlers/*.js) — le premier trouvé (avec un état non
// terminé sur le salon public) gagne.
const SPECIAL_GAMES = [
  {
    key: "quiz",
    title: "Quiz",
    style: "Trivia",
    readState: readQuizState,
    async detail(state) {
      const config = await loadQuizConfig();
      const dureeJours =
        config.manches[state.mancheIndex]?.questions.length ?? null;
      const votes = await listQuizVotes(state.manche, state.jour);
      return {
        jour: state.jour,
        dureeJours,
        participantsLabel: formatParticipantsToday(votes.length),
      };
    },
  },
  {
    key: "tamagotchi",
    title: "Tamagotchi",
    style: "Collaboratif",
    readState: readTamaState,
    async detail(state) {
      const config = await loadTamagotchiConfig();
      const votes = await listTamaVotes(state.jour);
      return {
        jour: state.jour,
        dureeJours: config.duree_jours,
        participantsLabel: formatParticipantsToday(votes.length),
      };
    },
  },
  {
    key: "robinson",
    title: "Robinson",
    style: "Collaboratif",
    readState: readRobinsonState,
    async detail(state) {
      const config = await loadRobinsonConfig();
      const participants = await countRobinsonVoters(state.jour);
      return {
        jour: state.jour,
        dureeJours: config.duree_jours,
        participantsLabel: formatParticipantsToday(participants),
      };
    },
  },
  {
    key: "bossraid",
    title: "Boss Raid",
    style: "Collaboratif",
    readState: readBossraidState,
    async detail(state) {
      const config = await loadBossRaidConfig();
      if (state.phase === "annonce") {
        // Jour d'annonce : aucun vote possible encore (jour = null côté
        // état), donc ni "Jour null/7" ni "0 participant ce jour" n'ont de
        // sens — voir le même traitement pour Goblin Hunters ci-dessous.
        return {
          jour: null,
          dureeJours: null,
          participantsLabel: null,
          phaseLabel: "Phase de présentation du jeu",
        };
      }
      const participants = await countBossraidVoters(state.jour);
      return {
        jour: state.jour,
        dureeJours: config.duree_jours,
        participantsLabel: formatParticipantsToday(participants),
      };
    },
  },
  {
    key: "goblinhunters",
    title: "Goblin Hunters",
    style: "Identité secrète",
    readState: readGoblinState,
    async detail(state) {
      const config = await loadGoblinHuntersConfig();
      if (state.phase === "inscription") {
        // Seul jeu spécial où l'on peut "participer" (s'inscrire) avant que
        // le jour 1 ne démarre — voir formatParticipantsToday() pour les
        // autres jeux, où ce cas de figure n'existe pas encore.
        const inscriptions = await listGoblinInscriptions();
        const count = inscriptions.length;
        return {
          jour: null,
          dureeJours: null,
          participantsLabel: `${count} inscrit${count > 1 ? "s" : ""} à ce jour`,
          phaseLabel: "Phase de présentation du jeu",
        };
      }
      // Jamais lire state.joueurs[].camp/role/pv ici — seul le décompte des
      // vivants est public.
      const vivants = state.joueurs.filter((j) => j.alive).length;
      return {
        jour: state.jour,
        dureeJours: config.duree_jours,
        participantsLabel: `${vivants} joueur${vivants > 1 ? "s" : ""} en vie`,
      };
    },
  },
  {
    key: "blackjack",
    title: "Blackjack",
    style: "Casino",
    readState: readBlackjackState,
    async detail(state) {
      const config = await loadBlackjackConfig();
      const hands = await listBlackjackHands(state.jour);
      return {
        jour: state.jour,
        dureeJours: config.duree_jours,
        participantsLabel: formatParticipantsToday(Object.keys(hands).length),
      };
    },
  },
  {
    key: "marioclash",
    title: "Mario Clash",
    style: "Course",
    readState: readMarioClashState,
    async detail(state) {
      const config = await loadMarioClashConfig();
      if (state.phase === "annonce") {
        // Jour de présentation : pas encore de jour de course ni d'action
        // possible — même traitement que Boss Raid/Goblin Hunters ci-dessus.
        return {
          jour: null,
          dureeJours: null,
          participantsLabel: null,
          phaseLabel: "Phase de présentation du jeu",
        };
      }
      const actions = await readMarioClashActions(state.jour);
      return {
        jour: state.jour,
        dureeJours: config.duree_jours,
        participantsLabel: formatParticipantsToday(Object.keys(actions).length),
      };
    },
  },
  {
    key: "gobelet",
    title: "Gobelet",
    style: "Casino",
    readState: readGobeletState,
    async detail(state) {
      const config = await loadGobeletConfig();
      const hands = await listGobeletHands(state.jour);
      return {
        jour: state.jour,
        dureeJours: config.duree_jours,
        participantsLabel: formatParticipantsToday(Object.keys(hands).length),
      };
    },
  },
];

// Quiz/Tamagotchi/Robinson/Boss Raid/Blackjack ne comptent que les votants
// du JOUR courant (aucune trace des jours précédents n'est agrégée côté
// service) — le préciser pour ne pas laisser croire à un total sur toute la
// partie. Goblin Hunters s'exprime différemment (inscrits ou vivants), voir
// son detail() dédié.
function formatParticipantsToday(count) {
  return `${count} participant${count > 1 ? "s" : ""} ce jour`;
}

function isLiveOnPublicChannel(state) {
  return Boolean(
    state && !state.termine && state.channelId === PUBLIC_CHANNEL_ID,
  );
}

function daysUntilWeekday(now, weekday) {
  const todayUtc = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );
  const todayWeekday = new Date(todayUtc).getUTCDay();
  return (weekday - todayWeekday + 7) % 7;
}

function formatEndLabel(daysUntil) {
  if (daysUntil === 0) return "⚠️ fin aujourd'hui";
  if (daysUntil === 1) return "fin demain";
  return `fin dans ${daysUntil}j`;
}

// Un jeu jamais lancé n'a pas de manche en cours : "fin" n'a pas de sens
// pour lui, seule la date de son PREMIER lancement (le prochain créneau
// hebdomadaire) est pertinente.
function formatNextLaunchLabel(daysUntil) {
  if (daysUntil === 0) return "premier lancement aujourd'hui";
  if (daysUntil === 1) return "premier lancement demain";
  return `premier lancement dans ${daysUntil}j`;
}

// Indicateur neutre (pas de sémantique bonne/mauvaise, donc pas de rouge/vert) :
// une case se remplit par jour écoulé avant la fin. daysUntil va de 0 (fin
// aujourd'hui, 6 jours viennent de s'écouler → barre pleine) à 6 (fin dans
// 6 jours, la semaine vient de démarrer → 1 seule case remplie). Bleu plutôt
// que noir : le noir se fond dans le thème sombre de Discord (peu visible).
function buildCountdownBar(daysUntil) {
  const filled = Math.max(0, Math.min(BAR_SEGMENTS, BAR_SEGMENTS - daysUntil));
  return "🟦".repeat(filled) + "⬜".repeat(BAR_SEGMENTS - filled);
}

async function buildRegularGamesBlock(now) {
  const [aveugleGame, visuelsGame, lettresGame, cultureGame] = await Promise.all([
    resolveActiveAveugleGame(),
    resolveActiveVisuelsGame(),
    resolveActiveLettresGame(),
    resolveActiveCultureGame(),
  ]);
  const games = [
    { key: "aveugle", weekday: 1, ...aveugleGame },
    { key: "visuels", weekday: 5, ...visuelsGame },
    { key: "lettres", weekday: 6, ...lettresGame },
    { key: "culture", weekday: 3, ...cultureGame },
  ];

  const entries = await Promise.all(
    games.map(async (game) => ({
      ...game,
      daysUntil: daysUntilWeekday(now, game.weekday),
      // null seulement si aucune manche n'a jamais été postée pour ce jeu
      // (readState() ne renvoie rien tant que startNewGame() n'a jamais
      // tourné) — pas un indicateur "en pause", juste "jamais lancé".
      neverStarted: (await game.readState()) == null,
    })),
  );
  entries.sort((a, b) => a.daysUntil - b.daysUntil);

  const lines = entries.map((entry, index) => {
    if (entry.neverStarted) {
      // Ni "fin dans Xj" ni barre de progression : rien n'est en cours pour
      // ce jeu, seul son premier lancement à venir a un sens.
      return `${index + 1}. **${entry.title}** — *jamais lancé, ${formatNextLaunchLabel(entry.daysUntil)}*`;
    }
    const header = `${index + 1}. **${entry.title}** (${formatEndLabel(entry.daysUntil)})`;
    return `${header}\n${buildCountdownBar(entry.daysUntil)}`;
  });

  // "##" (titre markdown niveau 2) plutôt que "**gras**" : même taille de
  // rendu que le titre du jeu spécial ci-dessous, plus imposante qu'un
  // simple gras — voir buildSpecialGameBlock().
  return `## Les Mini-jeux hebdomadaires\n*(classés par ordre de fin la plus proche)*\n\n${lines.join("\n\n")}`;
}

async function findActiveSpecialGame() {
  for (const game of SPECIAL_GAMES) {
    const state = await game.readState();
    if (isLiveOnPublicChannel(state)) {
      return { game, state };
    }
  }
  return null;
}

// Bloc intégré à la description (pas un field séparé) : un field name ne
// peut afficher qu'un texte en gras simple, jamais un titre "##" — pour que
// ce titre ait EXACTEMENT la même taille que "Les Mini-jeux réguliers du
// serveur" ci-dessus, les deux doivent partager le même rendu markdown.
async function buildSpecialGameBlock() {
  const active = await findActiveSpecialGame();
  if (!active) {
    return "## 🎲 Jeu spécial du moment\nAucun jeu spécial en cours actuellement.";
  }
  const { game, state } = active;
  const detail = await game.detail(state);
  const lines = [`- Style : ${game.style}`];
  if (detail.phaseLabel) {
    lines.push(`- ${detail.phaseLabel}`);
  } else {
    lines.push(
      `- Jour ${detail.jour}${detail.dureeJours ? `/${detail.dureeJours}` : ""}`,
    );
  }
  if (detail.participantsLabel) {
    lines.push(`- ${detail.participantsLabel}`);
  }

  return `## 🎲 Jeu spécial du moment: ${game.title}\n${lines.join("\n")}`;
}

export async function buildMiniJeuxEmbed(now = new Date()) {
  const [regularBlock, specialBlock] = await Promise.all([
    buildRegularGamesBlock(now),
    buildSpecialGameBlock(),
  ]);

  const description = `${regularBlock}\n\n${specialBlock}`;

  const link = channelLink();
  const fields = [
    {
      name: "📍 Salon des Mini-jeux",
      value: link ? `[Accéder au salon](${link})` : "Salon des Mini-jeux",
    },
  ];

  const { end } = getCurrentSeasonBounds(now);
  const daysUntilSeasonEnd = Math.max(
    0,
    Math.ceil((end.getTime() - now.getTime()) / 86400000),
  );

  return {
    title: "🎮 État des lieux des Mini-jeux",
    description,
    color: MINIJEUX_COLOR,
    fields,
    // Illustration fixe de la commande (pas liée au jeu spécial actif).
    image: { url: BLACKJACK_START_IMAGE_URL },
    footer: {
      text: `Fin de la saison mini-jeux en cours : dans ${daysUntilSeasonEnd}j !`,
    },
  };
}

function buildMiniJeuxComponents() {
  return [
    {
      type: 1,
      components: [
        {
          type: 2,
          style: 2,
          label: "🔄 Rafraîchir",
          custom_id: "minijeux_refresh",
        },
      ],
    },
  ];
}

async function patchOriginal(webhookUrl, payload) {
  if (!webhookUrl) return;
  try {
    await fetch(`${webhookUrl}/messages/@original`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    console.error("[MiniJeux] Échec PATCH réponse:", err.message);
  }
}

export async function handleMiniJeuxCommand(webhookUrl) {
  try {
    const embed = await buildMiniJeuxEmbed();
    await patchOriginal(webhookUrl, {
      embeds: [embed],
      components: buildMiniJeuxComponents(),
    });
  } catch (err) {
    console.error("[MiniJeux] Erreur /mini-jeux:", err);
    await patchOriginal(webhookUrl, {
      content: "⚠️ Erreur lors de la récupération de l'état des mini-jeux.",
    });
  }
}
