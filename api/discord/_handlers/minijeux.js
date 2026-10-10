// ============================================================
// minijeux.js — Handler Discord pour /mini-jeux : état des lieux de tous
// les mini-jeux réguliers (Frame, Jeux de lettres [Anagram/Pêle-mêle en
// alternance], Jeux visuels [Zoom carte/Palette en alternance], La Juste
// Carte) et du jeu spécial actuellement actif (Quiz, Robinson,
// Goblin Hunters, Blackjack, Mario Clash, Gobelet ou Bang! ;
// Tamagotchi et Boss Raid archivés).
// Lecture seule, aucune écriture Redis.
//
// ⚠️ Goblin Hunters : ne jamais lire/afficher state.joueurs[].camp/role/pv —
// seuls le nombre d'inscrits/vivants et le jour sont publics (voir la mise
// en garde de scripts/goblinHuntersStatus.js).
// ============================================================

// Imports en namespace : /mini-jeux n'a besoin que de readState(), mais le
// bouton "Ma participation" lit aussi la progression du joueur
// (readParticipant, computeSeasonRanking...) — même interface sur les 8 jeux.
import * as blindRoyaleSvc from "../../../backend/services/blindroyale.js";
import * as frameSvc from "../../../backend/services/frames.js";
import * as zoomSvc from "../../../backend/services/zoom.js";
import * as paletteSvc from "../../../backend/services/palette.js";
import * as anagramSvc from "../../../backend/services/anagrams.js";
import * as peleMeleSvc from "../../../backend/services/pelemele.js";
import * as justeCarteSvc from "../../../backend/services/lajustecarte.js";
import * as triviaSvc from "../../../backend/services/trivia.js";
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
  listVotes as listRobinsonVotes,
} from "../../../backend/services/robinson.js";
import {
  readState as readBossraidState,
  loadBossRaidConfig,
  countUniqueVoters as countBossraidVoters,
  listVotes as listBossraidVotes,
} from "../../../backend/services/bossraid.js";
import {
  readState as readGoblinState,
  loadGoblinHuntersConfig,
  listInscriptions as listGoblinInscriptions,
  readPlayerAction as readGoblinPlayerAction,
} from "../../../backend/services/goblinhunters.js";
import {
  readState as readBlackjackState,
  loadBlackjackConfig,
  listHands as listBlackjackHands,
  readHand as readBlackjackHand,
  readPoints as readBlackjackPoints,
} from "../../../backend/services/blackjack.js";
import {
  readState as readMarioClashState,
  loadMarioClashConfig,
  readActions as readMarioClashActions,
  readJoueur as readMarioClashJoueur,
} from "../../../backend/services/marioclash.js";
import {
  readState as readGobeletState,
  loadGobeletConfig,
  listHands as listGobeletHands,
  readHand as readGobeletHand,
  readPoints as readGobeletPoints,
} from "../../../backend/services/gobelet.js";
import {
  readState as readBangState,
  loadBangConfig,
  readPartie as readBangPartie,
} from "../../../backend/services/bang.js";
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
  blindroyale: { title: "🎧 Blind Royale", svc: blindRoyaleSvc },
  lajustecarte: { title: "🃏 La Juste Carte", svc: justeCarteSvc },
};

// "Jeux visuels" (vendredi) et "Jeux de lettres" (samedi) alternent chacun
// entre deux jeux une saison Clash Royale sur deux (voir jeuxvisuels.js /
// jeuxdelettres.js, mêmes fonctions utilisées par scripts/postJeuxVisuels.js
// et postJeuxDeLettres.js pour la publication) — /mini-jeux doit donc
// résoudre le jeu réellement actif plutôt que d'en référencer un seul en dur.
const VISUELS_GAMES = {
  zoom: { title: "🔍 Zoom carte", svc: zoomSvc },
  palette: { title: "🎨 Palette", svc: paletteSvc },
};
const LETTRES_GAMES = {
  anagram: { title: "🔤 Anagram", svc: anagramSvc },
  pelemele: { title: "🔤 Pêle-mêle", svc: peleMeleSvc },
};
// "Mini-jeux de Culture" (mercredi) : Frame et Trivia alternent une saison
// Clash Royale sur deux (voir jeuxculture.js), même mécanisme que
// VISUELS_GAMES/LETTRES_GAMES ci-dessus.
const CULTURE_GAMES = {
  frame: { title: "🎬 Trouve le film !", svc: frameSvc },
  trivia: { title: "🧠 Trivia", svc: triviaSvc },
};

// getCurrentSeasonId() peut renvoyer null (API Clash Royale indisponible) :
// on retombe alors sur le jeu "historique" de la paire plutôt que de planter
// l'embed /mini-jeux.
//
// ⚠️ L'alternance saisonnière désigne le jeu de la saison EN COURS, pas
// forcément celui dont une manche tourne : au changement de saison Clash
// Royale, la dernière manche de l'ancien jeu court encore jusqu'à son
// créneau hebdomadaire. Le jeu affiché est donc celui dont la manche la plus
// récente a été postée sur le salon public ; le jeu désigné par la saison
// n'est retenu que si aucune manche publique n'existe encore (et "next"
// signale la relève quand les deux diffèrent).
async function resolvePairGame(games, getSeasonId, getActiveKey, fallbackKey) {
  const seasonId = await getSeasonId();
  const seasonKey = seasonId == null ? fallbackKey : getActiveKey(seasonId);
  const states = await Promise.all(
    Object.entries(games).map(async ([key, game]) => ({
      key,
      state: await game.svc.readState(),
    })),
  );
  const running = states
    .filter(({ state }) => state?.channelId === PUBLIC_CHANNEL_ID)
    .sort((a, b) => String(b.state.startedAt ?? "").localeCompare(String(a.state.startedAt ?? "")))[0];
  const key = running?.key ?? seasonKey;
  return {
    ...games[key],
    seasonId,
    state: running?.state ?? null,
    next: key !== seasonKey ? games[seasonKey] : null,
  };
}

function resolveActiveAveugleGame() {
  return resolvePairGame(AVEUGLE_GAMES, getAveugleSeasonId, getActiveBlindGame, "lajustecarte");
}

function resolveActiveVisuelsGame() {
  return resolvePairGame(VISUELS_GAMES, getVisuelsSeasonId, getActiveVisualGame, "zoom");
}

function resolveActiveLettresGame() {
  return resolvePairGame(LETTRES_GAMES, getLettresSeasonId, getActiveLetterGame, "anagram");
}

function resolveActiveCultureGame() {
  return resolvePairGame(CULTURE_GAMES, getCultureSeasonId, getActiveCultureGame, "frame");
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
    // Classement Quiz volontairement secret (voir quiz.js) : participation
    // du jour uniquement, jamais de score.
    async participation(state, discordId) {
      const votes = await listQuizVotes(state.manche, state.jour);
      return { played: votes.some((v) => v.discordId === discordId) };
    },
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
    // Jeu archivé (04/10, pas de relance prévue) : ignoré par
    // findActiveSpecialGame(), même si un état périmé traîne dans Redis.
    archived: true,
    readState: readTamaState,
    async participation(state, discordId) {
      const votes = await listTamaVotes(state.jour);
      return { played: votes.some((v) => v.discordId === discordId) };
    },
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
    async participation(state, discordId) {
      const votes = await listRobinsonVotes(state.jour);
      return { played: votes.some((v) => v.discordId === discordId) };
    },
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
    // Jeu archivé (10/10, pas de relance prévue) : ignoré par
    // findActiveSpecialGame(), même si un état périmé traîne dans Redis.
    archived: true,
    readState: readBossraidState,
    async participation(state, discordId) {
      if (state.phase === "annonce") return null;
      const votes = await listBossraidVotes(state.jour);
      return { played: votes.some((v) => v.discordId === discordId) };
    },
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
    // Jamais camp/rôle/PV ici non plus, même pour le joueur lui-même :
    // seule l'inscription et l'action du jour sont affichées.
    async participation(state, discordId) {
      if (state.phase === "inscription") {
        const inscriptions = await listGoblinInscriptions();
        const inscrit = inscriptions.some((i) => i.discordId === discordId);
        return { statusLabel: inscrit ? "✅ Inscrit" : "❌ Pas inscrit" };
      }
      if (!state.joueurs.some((j) => j.discordId === discordId)) {
        return { statusLabel: "Pas inscrit à cette partie" };
      }
      const action = await readGoblinPlayerAction(state.jour, discordId);
      return { played: action != null };
    },
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
    async participation(state, discordId) {
      const [hand, points] = await Promise.all([
        readBlackjackHand(state.jour, discordId),
        readBlackjackPoints(),
      ]);
      return {
        played: hand != null,
        scoreLabel: `Score de la partie : **${formatPoints(points[discordId] ?? 0)}**`,
      };
    },
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
    async participation(state, discordId) {
      if (state.phase === "annonce") return null;
      const [actions, joueur] = await Promise.all([
        readMarioClashActions(state.jour),
        readMarioClashJoueur(discordId),
      ]);
      return {
        played: actions[discordId] != null,
        scoreLabel: joueur ? `Position : **case ${joueur.position}**` : null,
      };
    },
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
    async participation(state, discordId) {
      const [hand, points] = await Promise.all([
        readGobeletHand(state.jour, discordId),
        readGobeletPoints(),
      ]);
      return {
        played: hand != null,
        scoreLabel: `Score de la partie : **${formatPoints(points[discordId] ?? 0)}**`,
      };
    },
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
  {
    key: "bang",
    title: "Bang!",
    style: "Survie",
    readState: readBangState,
    async participation(state, discordId) {
      if (state.phase === "annonce") return null;
      const joueur = (await readBangPartie()).joueurs[discordId];
      if (!joueur) return { played: false, scoreLabel: null };
      return {
        played: joueur.tourFait || !joueur.vivant,
        scoreLabel: joueur.vivant ? `👑 En vie (**${joueur.elixir} Élixir**)` : "💀 Éliminé de l'Arène",
      };
    },
    async detail(state) {
      if (state.phase === "annonce") {
        return {
          jour: null,
          dureeJours: null,
          participantsLabel: null,
          phaseLabel: "Phase de présentation du jeu",
        };
      }
      const [config, partie] = await Promise.all([loadBangConfig(), readBangPartie()]);
      const joueurs = Object.values(partie.joueurs);
      const vivants = joueurs.filter((j) => j.vivant).length;
      return {
        jour: state.jour,
        dureeJours: config.duree_jours,
        participantsLabel: `${vivants} joueur${vivants > 1 ? "s" : ""} en vie sur ${joueurs.length}`,
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

// Le jour du créneau, la manche affichée peut être soit l'ancienne (pas
// encore remplacée, elle finit bien aujourd'hui), soit la nouvelle déjà
// postée ce jour-là : celle-ci court alors jusqu'au créneau suivant (7j).
function daysUntilEnd(now, game) {
  const daysUntil = daysUntilWeekday(now, game.weekday);
  const startedToday =
    String(game.state?.startedAt ?? "").slice(0, 10) === now.toISOString().slice(0, 10);
  return daysUntil === 0 && startedToday ? 7 : daysUntil;
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
// 6 jours → 1 seule case remplie), voire 7 (manche postée aujourd'hui →
// barre vide, voir daysUntilEnd). Bleu plutôt
// que noir : le noir se fond dans le thème sombre de Discord (peu visible).
function buildCountdownBar(daysUntil) {
  const filled = Math.max(0, Math.min(BAR_SEGMENTS, BAR_SEGMENTS - daysUntil));
  return "🟦".repeat(filled) + "⬜".repeat(BAR_SEGMENTS - filled);
}

// Les 4 jeux réguliers actifs, triés par fin la plus proche — même ordre
// pour /mini-jeux et pour le bouton "Ma participation".
async function resolveRegularGames(now) {
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
  ].map((game) => ({ ...game, daysUntil: daysUntilEnd(now, game) }));
  return games.sort((a, b) => a.daysUntil - b.daysUntil);
}

async function buildRegularGamesBlock(now) {
  const games = await resolveRegularGames(now);

  const lines = games.map((entry, index) => {
    // state null seulement si aucune manche publique n'a jamais été postée
    // pour aucun des deux jeux de la paire — pas un indicateur "en pause",
    // juste "jamais lancé".
    if (entry.state == null) {
      // Ni "fin dans Xj" ni barre de progression : rien n'est en cours pour
      // ce jeu, seul son premier lancement à venir a un sens.
      return `${index + 1}. **${entry.title}** — *jamais lancé, ${formatNextLaunchLabel(entry.daysUntil)}*`;
    }
    const relay = entry.next ? `, puis ${entry.next.title}` : "";
    const header = `${index + 1}. **${entry.title}** (${formatEndLabel(entry.daysUntil)}${relay})`;
    return `${header}\n${buildCountdownBar(entry.daysUntil)}`;
  });

  // "##" (titre markdown niveau 2) plutôt que "**gras**" : même taille de
  // rendu que le titre du jeu spécial ci-dessous, plus imposante qu'un
  // simple gras — voir buildSpecialGameBlock().
  return `## Les Mini-jeux hebdomadaires\n*(classés par ordre de fin la plus proche)*\n\n${lines.join("\n\n")}`;
}

async function findActiveSpecialGame() {
  for (const game of SPECIAL_GAMES) {
    if (game.archived) continue;
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
          label: "🙋 Ma participation",
          custom_id: "minijeux_participation",
        },
      ],
    },
  ];
}

// ── Bouton "Ma participation" (message éphémère personnel) ──────────

function formatPoints(n) {
  return `${n} pt${n > 1 ? "s" : ""}`;
}

function formatRank(rank) {
  return rank === 1 ? "1er" : `${rank}e`;
}

// Un joueur a-t-il interagi avec la manche en cours ? readParticipant()
// suffit pour Trivia/Palette (une seule réponse = un document participant),
// les autres jeux écrivent d'abord des tentatives/indices sans document
// participant (voir hasPlayerInteracted() dans chaque service).
async function hasPlayedRound(svc, gameId, discordId) {
  if (await svc.readParticipant(gameId, discordId)) return true;
  return svc.hasPlayerInteracted
    ? svc.hasPlayerInteracted(gameId, discordId)
    : false;
}

async function buildRegularParticipationLine(game, discordId) {
  const { svc, seasonId, state } = game;
  // Score de la saison de la manche en cours (peut être la saison
  // précédente pendant la relève d'une paire en alternance, voir
  // resolvePairGame()).
  const rankingSeasonId = state?.seasonId ?? seasonId ?? null;

  const [played, ranking] = await Promise.all([
    state ? hasPlayedRound(svc, state.gameId, discordId) : false,
    rankingSeasonId != null ? svc.computeSeasonRanking(rankingSeasonId) : [],
  ]);

  const status = !state
    ? "Pas encore de manche cette saison"
    : played
      ? "✅ Déjà joué à la manche en cours"
      : "❌ Pas encore joué à la manche en cours";

  const entry = ranking.find((e) => e.discordId === discordId);
  const score = entry
    ? `${formatPoints(entry.totalScore)} (${formatRank(svc.findTiedRank(ranking, discordId, "totalScore"))}/${ranking.length})`
    : formatPoints(0);

  return `**${game.title}**\n${status}\nScore saison : **${score}**`;
}

async function buildSpecialParticipationBlock(discordId) {
  const active = await findActiveSpecialGame();
  if (!active) {
    return "## 🎲 Jeu spécial du moment\nAucun jeu spécial en cours actuellement.";
  }
  const { game, state } = active;
  const participation = await game.participation(state, discordId);
  const lines = [];
  if (!participation) {
    lines.push("Phase de présentation du jeu");
  } else {
    if (participation.statusLabel) {
      lines.push(participation.statusLabel);
    } else {
      lines.push(
        participation.played
          ? "✅ Déjà joué aujourd'hui"
          : "❌ Pas encore joué aujourd'hui",
      );
    }
    if (participation.scoreLabel) lines.push(participation.scoreLabel);
  }
  return `## 🎲 Jeu spécial du moment: ${game.title}\n${lines.join("\n")}`;
}

export async function buildParticipationEmbed(discordId, username, now = new Date()) {
  const games = await resolveRegularGames(now);
  const [regularLines, specialBlock] = await Promise.all([
    Promise.all(games.map((game) => buildRegularParticipationLine(game, discordId))),
    buildSpecialParticipationBlock(discordId),
  ]);

  return {
    title: `🙋 Participation de ${username}`,
    description: `## Les Mini-jeux hebdomadaires\n${regularLines.join("\n\n")}\n\n${specialBlock}`,
    color: MINIJEUX_COLOR,
  };
}

export async function handleMiniJeuxParticipation(webhookUrl, discordId, username) {
  try {
    const embed = await buildParticipationEmbed(discordId, username);
    await patchOriginal(webhookUrl, { embeds: [embed] });
  } catch (err) {
    console.error("[MiniJeux] Erreur Ma participation:", err);
    await patchOriginal(webhookUrl, {
      content: "⚠️ Erreur lors de la récupération de ta participation.",
    });
  }
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
