// ============================================================
// minijeux.js — Handler Discord pour /mini-jeux : état des lieux des 5
// groupes de mini-jeux hebdomadaires (deux jeux en alternance chacun, voir
// refonte.js), du jeu spécial actuellement actif (Quiz, Robinson, Goblin
// Hunters, Blackjack, Pont du Troll, Mario Clash, Gobelet ou Meow ; Qui
// est-ce ? archivé) et des duels.
// Lecture seule, aucune écriture Redis.
//
// ⚠️ Goblin Hunters : ne jamais lire/afficher state.joueurs[].camp/role/pv —
// seuls le nombre d'inscrits/vivants et le jour sont publics (voir la mise
// en garde de jeux/scripts/goblinHuntersStatus.js).
// ============================================================

// Imports en namespace : /mini-jeux n'a besoin que de readState(), mais le
// bouton "Mon passeport" lit aussi la progression du joueur
// (readParticipant, computeSeasonRanking...) — même interface sur les 8 jeux.
import * as frameSvc from "../../services/frames.js";
import * as zoomSvc from "../../services/zoom.js";
import * as zoom2Svc from "../../services/zoom2.js";
import * as platPaysSvc from "../../services/platpays.js";
import * as peleMeleSvc from "../../services/pelemele.js";
import * as triviaSvc from "../../services/trivia.js";
import * as triviaGeekSvc from "../../services/triviageek.js";
import * as intrusSvc from "../../services/intrus.js";
import * as conceptSvc from "../../services/concept.js";
import * as synopsisSvc from "../../services/synopsis.js";
import * as blackjackDuelSvc from "../../services/blackjackDuel.js";
import * as gobeletDuelSvc from "../../services/gobeletDuel.js";
import * as grilleDuelSvc from "../../services/grilleDuel.js";
import * as quatreDuelSvc from "../../services/quatreDuel.js";
import * as puntoDuelSvc from "../../services/puntoDuel.js";
import * as friseDuelSvc from "../../services/friseDuel.js";
import * as potatoDuelSvc from "../../services/potatoDuel.js";
import * as bacDuelSvc from "../../services/bacDuel.js";
import * as penduDuelSvc from "../../services/penduDuel.js";
import {
  getCurrentSeasonId as getAveugleSeasonId,
  getActiveBlindGame,
} from "../../services/jeuxaveugle.js";
import {
  getCurrentSeasonId as getLettresSeasonId,
  getActiveLetterGame,
} from "../../services/jeuxdelettres.js";
import {
  getCurrentSeasonId as getVisuelsSeasonId,
  getActiveVisualGame,
} from "../../services/jeuxvisuels.js";
import {
  getCurrentSeasonId as getCultureSeasonId,
  getActiveCultureGame,
} from "../../services/jeuxculture.js";
import {
  getCurrentSeasonId as getClashSeasonId,
  getActiveClashGame,
  CLASH_WEEKDAY,
} from "../../services/jeuxclash.js";

import {
  readState as readQuizState,
  loadQuizConfig,
  listVotes as listQuizVotes,
} from "../../services/quiz.js";
import {
  readState as readRobinsonState,
  loadRobinsonConfig,
  countUniqueVoters as countRobinsonVoters,
  listVotes as listRobinsonVotes,
} from "../../services/robinson.js";
import {
  readState as readGoblinState,
  loadGoblinHuntersConfig,
  listInscriptions as listGoblinInscriptions,
  readPlayerAction as readGoblinPlayerAction,
} from "../../services/goblinhunters.js";
import {
  readState as readBlackjackState,
  loadBlackjackConfig,
  listHands as listBlackjackHands,
  readHand as readBlackjackHand,
  readPoints as readBlackjackPoints,
} from "../../services/blackjack.js";
import {
  readState as readMarioClashState,
  loadMarioClashConfig,
  readActions as readMarioClashActions,
  readJoueur as readMarioClashJoueur,
} from "../../services/marioclash.js";
import {
  readState as readGobeletState,
  loadGobeletConfig,
  listHands as listGobeletHands,
  readHand as readGobeletHand,
  readPoints as readGobeletPoints,
} from "../../services/gobelet.js";
import {
  readState as readQuiEstCeState,
  loadQuiEstCeConfig,
  readPartie as readQuiEstCePartie,
} from "../../services/quiestce.js";
import { points as quiEstCePoints } from "../../services/quiestceRules.js";
import {
  readState as readMeowState,
  loadMeowConfig,
  readPartie as readMeowPartie,
} from "../../services/meow.js";
import { BANDES as MEOW_BANDES, jourDe as meowJourDe, horloge as meowHorloge } from "../../services/meowRules.js";
import { BLACKJACK_START_IMAGE_URL } from "./blackjack.js";
import {
  readState as readPontState,
  loadPontConfig,
  readChoix as readPontChoix,
  compterPassants as compterPontPassants,
  readPoints as readPontPoints,
  formatPieces as formatPontPieces,
  readVraiFaux as readPontVraiFaux,
  compterReponsesVraiFaux as compterPontReponsesVraiFaux,
  MATIN as PONT_MATIN,
} from "../../services/pont.js";
import { CRENEAUX, creneauJouable } from "../../services/creneaux.js";

// Blackjack et Gobelet : deux mains par jour (creneaux.js). « A joué » =
// main du créneau ouvert (hors créneau : l'une des deux) ; participants =
// joueurs ayant joué au moins une main du jour.
async function aJoueCreneau(readHand, state, discordId) {
  const creneau = creneauJouable(state.publishedAt);
  const mains = await Promise.all((creneau ? [creneau] : CRENEAUX).map((c) => readHand(state.jour, discordId, c)));
  return mains.some((m) => m != null);
}
async function participantsDuJour(listHands, jour) {
  const parCreneau = await Promise.all(CRENEAUX.map((c) => listHands(jour, c)));
  return new Set(parCreneau.flatMap((h) => Object.keys(h))).size;
}

import { deMois, getCurrentSeasonBounds, seasonIdForDate } from "../../services/saison.js";
import { getWiredGame } from "../../services/refonte.js";
import { computeMiniJeuxStats } from "../../services/miniJeuxStats.js";
import { lireCompteurs, lirePasseport, listerPasseportsComplets } from "../../services/passeport.js";
import { resolveDisplayName } from "@clash/commun/discordUsers.js";
import { bossEnCours } from "../../services/boss.js";
import { boutonLancer } from "./boss.js";

const MINIJEUX_COLOR = 0x5865f2;

// Duels à la demande (voir « Duels à la demande » dans jeux/CONTRIBUTING.md),
// affichés par /mini-jeux avec le record contre Kévina (ou solo) et son
// détenteur, une ligne par format (5 et 10 manches) ou difficulté (Petit Bac). `precision` : mode affiché entre parenthèses après « Record ».
// À tenir à jour à chaque ajout ou archivage.
const DUEL_COMMANDS = [
  { commande: "/blackjack", precision: "5 manches", record: () => blackjackDuelSvc.lireHighScore(5) },
  { commande: "/blackjack", precision: "10 manches", record: () => blackjackDuelSvc.lireHighScore(10) },
  { commande: "/gobelet", precision: "5 manches", record: () => gobeletDuelSvc.lireHighScore(5) },
  { commande: "/gobelet", precision: "10 manches", record: () => gobeletDuelSvc.lireHighScore(10) },
  { commande: "/grille", record: () => grilleDuelSvc.lireHighScore() },
  { commande: "/quatre", record: () => quatreDuelSvc.lireRecord("bot") },
  { commande: "/punto", record: () => puntoDuelSvc.lireRecord("bot") },
  { commande: "/frise", record: () => friseDuelSvc.lireRecord("bot") },
  { commande: "/potato", record: () => potatoDuelSvc.lireRecord("bot") },
  { commande: "/bac", precision: "normal", record: () => bacDuelSvc.lireRecord("bot", "normal") },
  { commande: "/bac", precision: "difficile", record: () => bacDuelSvc.lireRecord("bot", "difficile") },
  { commande: "/pendu", record: () => penduDuelSvc.lireRecord("solo") },
];

// Valeur d'un record : points (high score) ou plus longue série de victoires.
function valeurRecord(r) {
  if (r?.points != null) return `${r.points} pt${r.points > 1 ? "s" : ""}`;
  if (r?.serie != null) return `${r.serie} victoire${r.serie > 1 ? "s" : ""}`;
  return null;
}

async function buildDuelsBlock() {
  const lignes = await Promise.all(
    DUEL_COMMANDS.map(async ({ commande, precision, record }) => {
      // Un record illisible ne doit pas casser l'embed /mini-jeux.
      const r = await record().catch(() => null);
      const libelle = ["Record", valeurRecord(r), precision && `(${precision})`].filter(Boolean).join(" ");
      return `- \`${commande}\` · ${libelle} : ${r?.username ?? "aucun"}`;
    }),
  );
  return `## Les mini-jeux Duels de Kévina:\n${lignes.join("\n")}`;
}
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

// Groupes hebdomadaires : deux jeux alternent une saison sur deux (voir
// refonte.js et jeux<groupe>.js, mêmes fonctions que les orchestrateurs
// jeux/scripts/postJeux*.js) ; /mini-jeux résout le jeu réellement actif.
// 🎮 Culture geek (lundi).
const AVEUGLE_GAMES = {
  triviageek: { title: "🎮 Trivia Geek", svc: triviaGeekSvc },
  intrus: { title: "🎒 Intrus de l'inventaire", svc: intrusSvc },
};

// 📸 Coup d'œil (vendredi).
const VISUELS_GAMES = {
  zoom2: { title: "🔍 Zoom logo", svc: zoom2Svc },
  platpays: { title: "🍽️ Plat Pays", svc: platPaysSvc },
};
// 🔤 Jeux de mots (samedi).
const LETTRES_GAMES = {
  pelemele: { title: "🔤 Pêle-mêle", svc: peleMeleSvc },
  concept: { title: "🧩 Concept", svc: conceptSvc },
};
// 🎬 Ciné-club (mercredi).
const CULTURE_GAMES = {
  frame: { title: "🎬 Trouve le film !", svc: frameSvc },
  synopsis: { title: "🎬 Synopsis éclaté", svc: synopsisSvc },
};
// ⚔️ Clash (mardi, voir jeuxclash.js).
const CLASH_GAMES = {
  trivia: { title: "🧠 Trivia", svc: triviaSvc },
  zoom: { title: "🔍 Zoom carte", svc: zoomSvc },
};

// Filet de sécurité si getCurrentSeasonId() renvoyait null : on retombe sur
// le premier jeu de la paire plutôt que de planter l'embed /mini-jeux.
//
// ⚠️ L'alternance saisonnière désigne le jeu de la saison EN COURS, pas
// forcément celui dont une manche tourne : au changement de saison, la
// dernière manche de l'ancien jeu court encore jusqu'à son créneau
// hebdomadaire. Le jeu affiché est donc celui dont la manche la plus
// récente a été postée sur le salon public ; le jeu désigné par la saison
// n'est retenu que si aucune manche publique n'existe encore (et "next"
// signale la relève quand les deux diffèrent).
//
// Une manche n'est retenue pour un groupe que si le jeu y était actif pour
// la saison de la manche.
// fallbackKey null : groupe masqué tant qu'il n'a aucun jeu (Clash avant la
// bascule).
async function resolvePairGame(games, getSeasonId, getActiveKey, fallbackKey) {
  const seasonId = await getSeasonId();
  const activeKey = seasonId == null ? fallbackKey : getActiveKey(seasonId);
  // Refonte : un jeu de la nouvelle paire pas encore prêt (getActiveKey
  // renvoie null) ou absent de `games` n'est jamais affiché, ni comme jeu en
  // cours ni comme relève (voir jeux/services/refonte.js).
  const seasonKey = games[activeKey] ? activeKey : null;
  const states = await Promise.all(
    Object.entries(games).map(async ([key, game]) => ({
      key,
      state: await game.svc.readState(),
    })),
  );
  const running = states
    .filter(({ state }) => state?.channelId === PUBLIC_CHANNEL_ID)
    .filter(({ key, state }) => state?.seasonId == null || getActiveKey(state.seasonId) === key)
    // Une manche d'avant la saison précédente est forcément terminée (seule
    // la dernière manche de la saison précédente peut encore courir) : sans
    // ce filtre, un groupe sans manche en cours afficherait une manche
    // périmée (Frame de septembre entre le Trivia Clash du mardi et le
    // Synopsis du mercredi, à la refonte).
    .filter(({ state }) => state?.seasonId == null || seasonId == null || state.seasonId >= seasonId - 1)
    .sort((a, b) => String(b.state.startedAt ?? "").localeCompare(String(a.state.startedAt ?? "")))[0];
  const key = running?.key ?? seasonKey ?? fallbackKey;
  if (!key) return null;
  return {
    ...games[key],
    gameKey: key,
    seasonId,
    state: running?.state ?? null,
    next: seasonKey && key !== seasonKey ? games[seasonKey] : null,
  };
}

function resolveActiveAveugleGame() {
  return resolvePairGame(AVEUGLE_GAMES, getAveugleSeasonId, (id) => getWiredGame("aveugle", id, getActiveBlindGame(id)), "triviageek");
}

function resolveActiveVisuelsGame() {
  return resolvePairGame(VISUELS_GAMES, getVisuelsSeasonId, (id) => getWiredGame("visuels", id, getActiveVisualGame(id)), "zoom2");
}

function resolveActiveLettresGame() {
  return resolvePairGame(LETTRES_GAMES, getLettresSeasonId, (id) => getWiredGame("lettres", id, getActiveLetterGame(id)), "concept");
}

function resolveActiveCultureGame() {
  return resolvePairGame(CULTURE_GAMES, getCultureSeasonId, (id) => getWiredGame("culture", id, getActiveCultureGame(id)), "synopsis");
}

function resolveActiveClashGame() {
  return resolvePairGame(CLASH_GAMES, getClashSeasonId, (id) => getWiredGame("clash", id, getActiveClashGame(id)), null);
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
      if (state.phase === "annonce") return null;
      const votes = await listQuizVotes(state.manche, state.jour);
      return { played: votes.some((v) => v.discordId === discordId) };
    },
    async detail(state) {
      if (state.phase === "annonce") {
        // Jour de présentation : pas encore de jour joué (jour = null) —
        // même traitement que Mario Clash ci-dessous.
        return {
          jour: null,
          dureeJours: null,
          participantsLabel: null,
          phaseLabel: "Phase de présentation du jeu",
        };
      }
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
    key: "robinson",
    title: "Robinson",
    style: "Collaboratif",
    readState: readRobinsonState,
    async participation(state, discordId) {
      if (state.phase === "annonce") return null;
      const votes = await listRobinsonVotes(state.jour);
      return { played: votes.some((v) => v.discordId === discordId) };
    },
    async detail(state) {
      if (state.phase === "annonce") {
        // Jour de présentation : pas encore de jour joué (jour = null) —
        // même traitement que Mario Clash ci-dessous.
        return {
          jour: null,
          dureeJours: null,
          participantsLabel: null,
          phaseLabel: "Phase de présentation du jeu",
        };
      }
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
    // Joueurs ayant joué depuis le début de la partie (bouton "📊 Stats").
    async livePlayerIds() {
      return Object.keys(await readBlackjackPoints());
    },
    async participation(state, discordId) {
      if (state.phase === "annonce") return null;
      const [played, points] = await Promise.all([
        aJoueCreneau(readBlackjackHand, state, discordId),
        readBlackjackPoints(),
      ]);
      return {
        played,
        scoreLabel: `Score de la partie : **${formatPoints(points[discordId] ?? 0)}**`,
      };
    },
    async detail(state) {
      if (state.phase === "annonce") {
        // Jour de présentation : pas encore de jour joué (jour = null) —
        // même traitement que Mario Clash ci-dessous.
        return {
          jour: null,
          dureeJours: null,
          participantsLabel: null,
          phaseLabel: "Phase de présentation du jeu",
        };
      }
      const config = await loadBlackjackConfig();
      return {
        jour: state.jour,
        dureeJours: config.duree_jours,
        participantsLabel: formatParticipantsToday(await participantsDuJour(listBlackjackHands, state.jour)),
      };
    },
  },
  {
    key: "pont",
    title: "Pont du Troll",
    style: "Minorité",
    readState: readPontState,
    // Joueurs ayant traversé au moins une fois (bouton "📊 Stats")
    async livePlayerIds() {
      return Object.keys(await readPontPoints());
    },
    // ⚠️ Jamais le pont choisi (vote secret), seulement « a joué » : le
    // matin, a répondu au Vrai/Faux ; l'après-midi, a traversé
    async participation(state, discordId) {
      if (state.phase === "annonce") return null;
      const lireJeu = state.phase === PONT_MATIN ? readPontVraiFaux : readPontChoix;
      const [joue, points] = await Promise.all([lireJeu(state.jour, discordId), readPontPoints()]);
      return {
        played: joue != null,
        scoreLabel: `Score de la partie : **${formatPontPieces(points[discordId] ?? 0)} pièces**`,
      };
    },
    async detail(state) {
      if (state.phase === "annonce") {
        return { jour: null, dureeJours: null, participantsLabel: null, phaseLabel: "Phase de présentation du jeu" };
      }
      const config = await loadPontConfig();
      return {
        jour: state.jour,
        dureeJours: config.duree_jours,
        participantsLabel: formatParticipantsToday(
          await (state.phase === PONT_MATIN ? compterPontReponsesVraiFaux : compterPontPassants)(state.jour),
        ),
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
        // possible — même traitement que Goblin Hunters ci-dessus.
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
    // Joueurs ayant joué depuis le début de la partie (bouton "📊 Stats").
    async livePlayerIds() {
      return Object.keys(await readGobeletPoints());
    },
    async participation(state, discordId) {
      if (state.phase === "annonce") return null;
      const [played, points] = await Promise.all([
        aJoueCreneau(readGobeletHand, state, discordId),
        readGobeletPoints(),
      ]);
      return {
        played,
        scoreLabel: `Score de la partie : **${formatPoints(points[discordId] ?? 0)}**`,
      };
    },
    async detail(state) {
      const config = await loadGobeletConfig();
      if (state.phase === "annonce") {
        return {
          jour: null,
          dureeJours: null,
          participantsLabel: null,
          phaseLabel: "Phase de présentation du jeu",
        };
      }
      return {
        jour: state.jour,
        dureeJours: config.duree_jours,
        participantsLabel: formatParticipantsToday(await participantsDuJour(listGobeletHands, state.jour)),
      };
    },
  },
  {
    key: "quiestce",
    title: "Qui est-ce ?",
    style: "Enquête",
    // Jeu archivé (cartes Clash Royale) : ignoré par findActiveSpecialGame(),
    // même si un état périmé traîne dans Redis.
    archived: true,
    readState: readQuiEstCeState,
    async participation(state, discordId) {
      if (state.phase === "annonce") return null;
      const joueur = (await readQuiEstCePartie()).joueurs[discordId];
      if (!joueur?.carte) return { played: false, scoreLabel: null };
      return {
        played: joueur.objetRecuJour,
        scoreLabel: `🎯 **${quiEstCePoints(joueur)} pt${Math.abs(quiEstCePoints(joueur)) > 1 ? "s" : ""}** (${joueur.demasques.length} découverte${joueur.demasques.length > 1 ? "s" : ""}, ${joueur.nbDemasque}× démasqué)`,
      };
    },
    async detail(state) {
      if (state.phase === "annonce") {
        // Fenêtre d'inscription (comme Goblin Hunters)
        const count = Object.keys((await readQuiEstCePartie()).joueurs).length;
        return {
          jour: null,
          dureeJours: null,
          participantsLabel: `${count} inscrit${count > 1 ? "s" : ""} à ce jour`,
          phaseLabel: "Phase de présentation du jeu",
        };
      }
      const [config, partie] = await Promise.all([loadQuiEstCeConfig(), readQuiEstCePartie()]);
      const n = Object.values(partie.joueurs).filter((j) => j.carte).length;
      return {
        jour: state.jour,
        dureeJours: config.duree_jours,
        participantsLabel: `${n} joueur${n > 1 ? "s" : ""}`,
      };
    },
  },
  {
    key: "meow",
    title: "Meow",
    style: "Stratégie en équipe",
    readState: readMeowState,
    // Joueurs ayant rejoint une bande (bouton "📊 Stats").
    async livePlayerIds(state) {
      if (state.phase === "annonce") return [];
      const partie = await readMeowPartie();
      return Object.entries(partie.joueurs)
        .filter(([, j]) => j.bande != null)
        .map(([discordId]) => discordId);
    },
    async participation(state, discordId) {
      if (state.phase === "annonce") return null;
      const [config, partie] = await Promise.all([loadMeowConfig(), readMeowPartie()]);
      const joueur = partie.joueurs[discordId];
      if (joueur?.bande == null) return { played: false, scoreLabel: null };
      // Caïd des coussins volontairement caché jusqu'à la fin (surprise)
      const bande = MEOW_BANDES[joueur.bande];
      return {
        played: joueur.jourActif === meowJourDe(partie, meowHorloge(partie)),
        scoreLabel: `${bande.emoji} **${bande.nom}**`,
      };
    },
    async detail(state) {
      if (state.phase === "annonce") {
        const count = Object.keys((await readMeowPartie()).joueurs).length;
        return {
          jour: null,
          dureeJours: null,
          participantsLabel: `${count} inscrit${count > 1 ? "s" : ""} à ce jour`,
          phaseLabel: "Phase de présentation du jeu",
        };
      }
      const [config, partie] = await Promise.all([loadMeowConfig(), readMeowPartie()]);
      const n = Object.values(partie.joueurs).filter((j) => j.bande != null).length;
      return {
        jour: state.jour,
        dureeJours: config.duree_jours,
        participantsLabel: `${n} joueur${n > 1 ? "s" : ""}`,
      };
    },
  },
];

// Quiz/Robinson/Blackjack ne comptent que les votants
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
  const regular = daysUntil === 0 && startedToday ? 7 : daysUntil;
  // Trivia et Zoom carte rejoignent le groupe Clash à la refonte : la
  // dernière manche de leur ancien groupe se termine dès que le groupe Clash
  // les reposte, si ce créneau tombe avant celui de l'ancien groupe.
  if (game.key === "clash" || !CLASH_GAMES[game.gameKey] || !game.state) return regular;
  const daysToClash = daysUntilWeekday(now, CLASH_WEEKDAY);
  const clashSeasonId = seasonIdForDate(new Date(now.getTime() + daysToClash * 86400000));
  if (getWiredGame("clash", clashSeasonId, getActiveClashGame(clashSeasonId)) !== game.gameKey) return regular;
  return Math.min(regular, daysToClash);
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

// Les jeux réguliers actifs (4, puis 5 avec le groupe Clash), triés par fin
// la plus proche — même ordre pour /mini-jeux et pour le bouton "Ma
// participation".
async function resolveRegularGames(now) {
  const [aveugleGame, visuelsGame, lettresGame, cultureGame, clashGame] = await Promise.all([
    resolveActiveAveugleGame(),
    resolveActiveVisuelsGame(),
    resolveActiveLettresGame(),
    resolveActiveCultureGame(),
    resolveActiveClashGame(),
  ]);
  const games = [
    { key: "aveugle", weekday: 1, ...aveugleGame },
    { key: "visuels", weekday: 5, ...visuelsGame },
    { key: "lettres", weekday: 6, ...lettresGame },
    { key: "culture", weekday: 3, ...cultureGame },
    ...(clashGame ? [{ key: "clash", weekday: CLASH_WEEKDAY, ...clashGame }] : []),
  ]
    // Groupe Clash pas encore lancé alors que son jeu court encore dans son
    // ancien groupe : une seule ligne pour ce jeu, dont la fin tombe le jour
    // de son premier lancement Clash (voir daysUntilEnd).
    .filter((game, _, all) => !(game.key === "clash" && !game.state && all.some((other) => other.key !== "clash" && other.state && other.gameKey === game.gameKey)))
    .map((game) => ({ ...game, daysUntil: daysUntilEnd(now, game) }));
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
      return `${index + 1}. **${entry.title}** *(jamais lancé, ${formatNextLaunchLabel(entry.daysUntil)})*`;
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
  const [regularBlock, duelsBlock, specialBlock] = await Promise.all([
    buildRegularGamesBlock(now),
    buildDuelsBlock(),
    buildSpecialGameBlock(),
  ]);

  const description = `${regularBlock}\n\n${duelsBlock}\n\n${specialBlock}`;

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
          label: "🛂 Mon passeport",
          custom_id: "minijeux_participation",
        },
        {
          type: 2,
          style: 2,
          label: "📊 Stats",
          custom_id: "minijeux_stats",
        },
      ],
    },
  ];
}

// ── Bouton "Mon passeport" (message éphémère personnel) ─────────────

function formatPoints(n) {
  return `${n} pt${n > 1 ? "s" : ""}`;
}

function formatRank(rank) {
  return rank === 1 ? "1er" : `${rank}e`;
}

// Un joueur a-t-il interagi avec la manche en cours ? readParticipant()
// suffit pour les QCM (une seule réponse = un document participant),
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

  if (!state) return `➖ **${game.title}** : pas encore de manche`;
  const entry = ranking.find((e) => e.discordId === discordId);
  // Pas encore au classement (aucune manche trouvée cette saison) : 0 pt
  const score = entry
    ? ` · ${formatPoints(entry.totalScore)} (${formatRank(svc.findTiedRank(ranking, discordId, "totalScore"))}/${ranking.length})`
    : ` · ${formatPoints(0)}`;
  return `${played ? "✅" : "❌"} **${game.title}**${score}`;
}

function buildTamponsBlock({ seasonId, tampons, complet }) {
  const valides = tampons.filter((t) => t.valide).length;
  const lines = tampons.map((t) => {
    const progression = t.objectif ? ` (${Math.min(t.valeur, t.objectif)}/${t.objectif})` : "";
    return `${t.valide ? "✅" : "⬜"} ${t.libelle}${progression}`;
  });
  if (complet) lines.push("🎉 Passeport complet !");
  return `## 🛂 Tampons de la saison ${deMois(seasonId)} (${valides}/${tampons.length})\n${lines.join("\n")}`;
}

// Passeports complets de la saison à ce jour (pseudos Discord actuels)
const MAX_COMPLETS = 40;
async function ligneComplets(seasonId, now) {
  const ids = await listerPasseportsComplets(seasonId, { now });
  if (!ids.length) return "Aucun passeport complet pour l'instant.";
  const noms = await Promise.all(ids.slice(0, MAX_COMPLETS).map((id) => resolveDisplayName(id, null)));
  const reste = ids.length > MAX_COMPLETS ? ` et ${ids.length - MAX_COMPLETS} autres` : "";
  return `**Passeports complets (${ids.length})** : ${noms.join(", ")}${reste}`;
}

function ligneCompteurs({ passeports, boss }) {
  if (!passeports) return null;
  return `🛂 Passeports complétés : **${passeports}** · 🐉 Boss vaincus : **${boss}**`;
}

// Message du bouton « 🛂 Mon passeport » : embed, et pendant la semaine du
// Boss, bouton « Affronter Kévina » pour les qualifiés (secours des MP).
export async function buildPasseportMessage(discordId, username, now = new Date()) {
  const games = await resolveRegularGames(now);
  const [regularLines, passeport, compteurs, boss, complets] = await Promise.all([
    Promise.all(games.map((game) => buildRegularParticipationLine(game, discordId))),
    lirePasseport(discordId, { now }),
    lireCompteurs(discordId),
    bossEnCours(now),
    ligneComplets(seasonIdForDate(now), now),
  ]);
  const semaine = regularLines;
  const qualifie = boss?.qualifies.includes(discordId);
  const blocs = [
    `## Cette semaine\n${semaine.join("\n")}`,
    buildTamponsBlock(passeport),
    complets,
    qualifie ? `🐉 **Boss de la saison ${deMois(boss.seasonId)}** : Kévina t'attend jusqu'au <t:${Math.floor(new Date(boss.clotureAt).getTime() / 1000)}:f> !` : null,
    ligneCompteurs(compteurs),
  ].filter(Boolean);

  return {
    embeds: [{ title: `🛂 Passeport de ${username}`, description: blocs.join("\n\n"), color: MINIJEUX_COLOR }],
    components: qualifie ? [{ type: 1, components: [boutonLancer(boss.seasonId)] }] : [],
  };
}

export async function handleMiniJeuxParticipation(webhookUrl, discordId, username) {
  try {
    await patchOriginal(webhookUrl, await buildPasseportMessage(discordId, username));
  } catch (err) {
    console.error("[MiniJeux] Erreur Mon passeport:", err);
    await patchOriginal(webhookUrl, {
      content: "⚠️ Erreur lors de la récupération de ton passeport.",
    });
  }
}

// ── Bouton "📊 Stats" (message éphémère, stats globales) ─────────────

// Au-delà, une liste de pseudos devient illisible : on n'affiche que le
// nombre de joueurs du palier.
const ASSIDUS_MAX_NAMES = 12;

function formatJoueurs(n) {
  return `${n} joueur${n > 1 ? "s" : ""}`;
}

function formatManches(n) {
  return `${n} manche${n > 1 ? "s" : ""}`;
}

async function findLiveSpecialPlayers() {
  const active = await findActiveSpecialGame();
  if (!active?.game.livePlayerIds) return null;
  const playerIds = await active.game.livePlayerIds(active.state);
  return { key: active.game.key, playerIds };
}

function buildStatsWeeklyBlock(games) {
  if (!games.length) return null;
  const lines = games.map(
    (g, index) =>
      `${index + 1}. **${g.title}** : ${formatJoueurs(Math.round(g.average))} en moyenne (${g.totalPlayers} au total sur ${formatManches(g.rounds)})`,
  );
  return `## Les jeux les plus joués\n${lines.join("\n")}`;
}

function buildStatsSpecialBlock(parties) {
  if (!parties.length) return null;
  const lines = parties.map((p, index) => {
    const suffix = p.live ? " *(en cours)*" : p.multiple ? ` *(partie ${p.manche})*` : "";
    return `${index + 1}. **${p.title}** : ${formatJoueurs(p.players)}${suffix}`;
  });
  return `## 🎲 Jeux spéciaux\n${lines.join("\n")}`;
}

function buildStatsAssidusBlock({ seasonId, totalRounds, tiers }) {
  if (!tiers.length) return null;
  const lines = tiers.map(({ played, names }) => {
    const who = names.length > ASSIDUS_MAX_NAMES ? formatJoueurs(names.length) : names.join(", ");
    return `**${played}/${totalRounds}** : ${who}`;
  });
  return `## 🏅 Les assidus de la saison ${deMois(seasonId)}\n${lines.join("\n")}`;
}

export async function buildStatsEmbed(now = new Date()) {
  const live = await findLiveSpecialPlayers();
  const stats = await computeMiniJeuxStats({ now, live });

  const blocks = [
    buildStatsWeeklyBlock(stats.weekly),
    buildStatsSpecialBlock(stats.special),
    buildStatsAssidusBlock(stats.assidus),
  ].filter(Boolean);

  const since = stats.firstDate
    ? ` depuis ${new Date(stats.firstDate).toLocaleDateString("fr-FR", { month: "long", year: "numeric", timeZone: "UTC" })}`
    : "";

  return {
    title: "📊 Statistiques des Mini-jeux",
    description: blocks.join("\n\n") || "Aucune donnée pour le moment.",
    color: MINIJEUX_COLOR,
    footer: { text: `${formatJoueurs(stats.totalPlayers)} différents${since}` },
  };
}

export async function handleMiniJeuxStats(webhookUrl) {
  try {
    const embed = await buildStatsEmbed();
    await patchOriginal(webhookUrl, { embeds: [embed] });
  } catch (err) {
    console.error("[MiniJeux] Erreur Stats:", err);
    await patchOriginal(webhookUrl, {
      content: "⚠️ Erreur lors du calcul des statistiques des mini-jeux.",
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
