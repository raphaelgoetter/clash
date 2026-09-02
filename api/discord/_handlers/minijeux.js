// ============================================================
// minijeux.js — Handler Discord pour /mini-jeux : état des lieux de tous
// les mini-jeux réguliers (Frame, Anagram, Zoom carte, La Juste Carte) et
// du jeu spécial actuellement actif (Quiz, Tamagotchi, Robinson, Boss Raid,
// Goblin Hunters ou Blackjack). Lecture seule, aucune écriture Redis.
//
// ⚠️ Goblin Hunters : ne jamais lire/afficher state.joueurs[].camp/role/pv —
// seuls le nombre d'inscrits/vivants et le jour sont publics (voir la mise
// en garde de scripts/goblinHuntersStatus.js).
// ============================================================

import { readState as readQuizState, loadQuizConfig, listVotes as listQuizVotes } from "../../../backend/services/quiz.js";
import { readState as readTamaState, loadTamagotchiConfig, listVotes as listTamaVotes } from "../../../backend/services/tamagotchi.js";
import { readState as readRobinsonState, loadRobinsonConfig, countUniqueVoters as countRobinsonVoters } from "../../../backend/services/robinson.js";
import { readState as readBossraidState, loadBossRaidConfig, countUniqueVoters as countBossraidVoters } from "../../../backend/services/bossraid.js";
import { readState as readGoblinState, loadGoblinHuntersConfig, listInscriptions as listGoblinInscriptions } from "../../../backend/services/goblinhunters.js";
import { readState as readBlackjackState, loadBlackjackConfig, listHands as listBlackjackHands } from "../../../backend/services/blackjack.js";
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

// 0 = dimanche .. 6 = samedi (Date.getUTCDay())
const REGULAR_GAMES = [
  { key: "frame", title: "🎬 Trouve le film !", weekday: 3 },
  { key: "zoom", title: "🔍 Zoom carte", weekday: 5 },
  { key: "anagram", title: "🔤 Anagram", weekday: 6 },
  { key: "lajustecarte", title: "🃏 La Juste Carte", weekday: 0 },
];

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
      const dureeJours = config.manches[state.mancheIndex]?.questions.length ?? null;
      const votes = await listQuizVotes(state.manche, state.jour);
      return { jour: state.jour, dureeJours, participants: votes.length };
    },
  },
  {
    key: "tamagotchi",
    title: "Tamagotchi",
    style: "Simulation",
    readState: readTamaState,
    async detail(state) {
      const config = await loadTamagotchiConfig();
      const votes = await listTamaVotes(state.jour);
      return { jour: state.jour, dureeJours: config.duree_jours, participants: votes.length };
    },
  },
  {
    key: "robinson",
    title: "Robinson",
    style: "Survie",
    readState: readRobinsonState,
    async detail(state) {
      const config = await loadRobinsonConfig();
      const participants = await countRobinsonVoters(state.jour);
      return { jour: state.jour, dureeJours: config.duree_jours, participants };
    },
  },
  {
    key: "bossraid",
    title: "Boss Raid",
    style: "Collaboratif",
    readState: readBossraidState,
    async detail(state) {
      const config = await loadBossRaidConfig();
      const participants = await countBossraidVoters(state.jour);
      return { jour: state.jour, dureeJours: config.duree_jours, participants };
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
        const inscriptions = await listGoblinInscriptions();
        return {
          jour: null,
          dureeJours: null,
          participants: inscriptions.length,
          phaseLabel: `Inscriptions en cours (${inscriptions.length}/${config.effectif_max})`,
        };
      }
      // Jamais lire state.joueurs[].camp/role/pv ici — seul le décompte des
      // vivants est public.
      const vivants = state.joueurs.filter((j) => j.alive).length;
      return { jour: state.jour, dureeJours: config.duree_jours, participants: vivants };
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
      return { jour: state.jour, dureeJours: config.duree_jours, participants: Object.keys(hands).length };
    },
  },
];

function isLiveOnPublicChannel(state) {
  return Boolean(state && !state.termine && state.channelId === PUBLIC_CHANNEL_ID);
}

function daysUntilWeekday(now, weekday) {
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const todayWeekday = new Date(todayUtc).getUTCDay();
  return (weekday - todayWeekday + 7) % 7;
}

function formatEndLabel(daysUntil) {
  if (daysUntil === 0) return "⚠️ fin aujourd'hui";
  if (daysUntil === 1) return "fin demain";
  return `fin dans ${daysUntil}j`;
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

function buildRegularGamesBlock(now) {
  const entries = REGULAR_GAMES.map((game) => ({
    ...game,
    daysUntil: daysUntilWeekday(now, game.weekday),
  })).sort((a, b) => a.daysUntil - b.daysUntil);

  const lines = entries.map((entry, index) => {
    const header = `${index + 1}. **${entry.title}** (${formatEndLabel(entry.daysUntil)})`;
    return `${header}\n${buildCountdownBar(entry.daysUntil)}`;
  });

  // "##" (titre markdown niveau 2) plutôt que "**gras**" : même taille de
  // rendu que le titre du jeu spécial ci-dessous, plus imposante qu'un
  // simple gras — voir buildSpecialGameBlock().
  return `## Les Mini-jeux réguliers du serveur\n*(classés par ordre de fin la plus proche)*\n\n${lines.join("\n\n")}`;
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
    lines.push(`- Jour ${detail.jour}${detail.dureeJours ? `/${detail.dureeJours}` : ""}`);
  }
  lines.push(`- ${detail.participants} participant${detail.participants > 1 ? "s" : ""}`);

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
  const daysUntilSeasonEnd = Math.max(0, Math.ceil((end.getTime() - now.getTime()) / 86400000));

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
    await patchOriginal(webhookUrl, { embeds: [embed] });
  } catch (err) {
    console.error("[MiniJeux] Erreur /mini-jeux:", err);
    await patchOriginal(webhookUrl, {
      content: "⚠️ Erreur lors de la récupération de l'état des mini-jeux.",
    });
  }
}
