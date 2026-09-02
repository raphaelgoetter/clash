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

import { readState as readFrameState } from "../../../backend/services/frames.js";
import { readState as readAnagramState } from "../../../backend/services/anagrams.js";
import { readState as readZoomState } from "../../../backend/services/zoom.js";
import { readState as readJusteCarteState } from "../../../backend/services/lajustecarte.js";

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
  { key: "frame", title: "🎬 Trouve le film !", weekday: 3, readState: readFrameState },
  { key: "zoom", title: "🔍 Zoom carte", weekday: 5, readState: readZoomState },
  { key: "anagram", title: "🔤 Anagram", weekday: 6, readState: readAnagramState },
  { key: "lajustecarte", title: "🃏 La Juste Carte", weekday: 0, readState: readJusteCarteState },
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
    image: BLACKJACK_START_IMAGE_URL,
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
  if (daysUntil === 0) return "fin aujourd'hui";
  if (daysUntil === 1) return "fin demain";
  return `fin dans ${daysUntil}j`;
}

function buildProgressBar(current, total) {
  if (!total || total <= 0 || !current) return "⬜".repeat(BAR_SEGMENTS);
  const filled = Math.max(0, Math.min(BAR_SEGMENTS, Math.round((current / total) * BAR_SEGMENTS)));
  return "🟩".repeat(filled) + "⬜".repeat(BAR_SEGMENTS - filled);
}

async function buildRegularGamesBlock(now) {
  const entries = await Promise.all(
    REGULAR_GAMES.map(async (game) => {
      const rawState = await game.readState();
      const state = isLiveOnPublicChannel(rawState) ? rawState : null;
      return { ...game, state, daysUntil: daysUntilWeekday(now, game.weekday) };
    }),
  );
  entries.sort((a, b) => a.daysUntil - b.daysUntil);

  const lines = entries.map((entry, index) => {
    const header = `${index + 1}. **${entry.title}** (${formatEndLabel(entry.daysUntil)})`;
    if (!entry.state) {
      return `${header}\n${"⬜".repeat(BAR_SEGMENTS)} · pas encore lancé cette saison`;
    }
    const bar = buildProgressBar(entry.state.seasonManche, entry.state.seasonMancheTotal);
    return `${header}\n${bar} · Manche ${entry.state.seasonManche}/${entry.state.seasonMancheTotal}`;
  });

  return `**Les Mini-jeux réguliers du serveur**\n*(classés par ordre de fin la plus proche)*\n\n${lines.join("\n\n")}`;
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

async function buildSpecialGameField(now) {
  const active = await findActiveSpecialGame();
  if (!active) {
    return { name: "🎲 Jeu spécial du moment", value: "Aucun jeu spécial en cours actuellement." };
  }
  const { game, state } = active;
  const detail = await game.detail(state);
  const lines = [`**${game.title}**`, `- Style : ${game.style}`];
  if (detail.phaseLabel) {
    lines.push(`- ${detail.phaseLabel}`);
  } else {
    lines.push(`- Jour ${detail.jour}${detail.dureeJours ? `/${detail.dureeJours}` : ""}`);
  }
  lines.push(`- ${detail.participants} participant${detail.participants > 1 ? "s" : ""}`);

  return {
    field: { name: "🎲 Jeu spécial du moment", value: lines.join("\n") },
    image: game.image ?? null,
  };
}

// Field factice (nom/valeur en espace insécable invisible) : crée un espace
// vertical entre les mini-jeux réguliers et le jeu spécial, pour que ce
// dernier ressorte comme un bloc à part plutôt que de s'enchaîner
// directement après la liste — but recherché par l'utilisateur ("mieux
// mettre en avant" le jeu spécial).
function spacerField() {
  return { name: "​", value: "​" };
}

export async function buildMiniJeuxEmbed(now = new Date()) {
  const [description, special] = await Promise.all([
    buildRegularGamesBlock(now),
    buildSpecialGameField(now),
  ]);

  const link = channelLink();
  const fields = [spacerField(), special.field ?? special];
  fields.push({
    name: "📍 Salon des Mini-jeux",
    value: link ? `[Accéder au salon](${link})` : "Salon des Mini-jeux",
  });

  const { end } = getCurrentSeasonBounds(now);
  const daysUntilSeasonEnd = Math.max(0, Math.ceil((end.getTime() - now.getTime()) / 86400000));

  const embed = {
    title: "🎮 État des lieux des Mini-jeux",
    description,
    color: MINIJEUX_COLOR,
    fields,
    footer: {
      text: `Fin de la saison mini-jeux en cours : dans ${daysUntilSeasonEnd}j !`,
    },
  };

  if (special.image) {
    embed.image = { url: special.image };
  }

  return embed;
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
