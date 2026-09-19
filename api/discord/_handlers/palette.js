// ============================================================
// palette.js — Handlers Discord pour le jeu "Palette [TEST]" (devine la
// couleur dominante d'une carte parmi 4 propositions A/B/C/D). Allégé par
// rapport à _handlers/zoom.js : pas de Modal, pas de bouton indice, pas de
// DM, pas de commande slash, pas de récap de saison — un seul essai par
// joueur, verrouillé au premier clic (voir backend/services/palette.js).
// La publication d'une manche passe uniquement par scripts/postPalette.js.
// ============================================================

import {
  resolvePaletteEntry,
  loadPaletteCatalog,
  readState,
  writeState,
  startNewGame,
  checkAnswer,
  getCorrectLetter,
  computeScore,
  recordAnswer,
  readParticipant,
  readRoundOrder,
  isTooSoonSinceLastRound,
  previewMancheNumber,
  LETTERS,
} from "../../../backend/services/palette.js";

const TRUST_ROYALE_URL = "https://trustroyale.vercel.app";
const PALETTE_COLOR = 0x9b59b6;

function buildPaletteEmbed({ gameId, mancheNumber, cacheBust }) {
  return {
    title: "🎨 [TEST] Palette — devine la couleur dominante !",
    description: [
      `**Manche #${mancheNumber}**`,
      "",
      "Une carte, 4 couleurs proposées (A, B, C, D). Laquelle domine le plus l'illustration ?",
      "",
      "**Barème** : bonne réponse = jusqu'à 10 pts (bonus de rapidité, plancher à 5), mauvaise réponse = 0 pt.",
      "**Un seul essai** : ton premier clic est définitif !",
    ].join("\n"),
    image: { url: `${TRUST_ROYALE_URL}/api/palette/image?gameId=${gameId}&v=${cacheBust}` },
    color: PALETTE_COLOR,
    footer: { text: "[TEST] Jeu en phase d'essai — merci de ne pas spoiler !" },
  };
}

function buildPaletteComponents(gameId) {
  return [
    {
      type: 1,
      components: LETTERS.map((letter) => ({
        type: 2,
        style: 2,
        label: letter,
        custom_id: `palette_answer:${gameId}:${letter}`,
      })),
    },
  ];
}

// `force` ignore le garde-fou anti-double-post (isTooSoonSinceLastRound) —
// utile pour relancer une manche de test à la main, jamais depuis un cron
// (qui n'existe pas encore pour ce jeu).
export async function postPalette(channelId, { dryRun = false, force = false } = {}) {
  if (dryRun) {
    const mancheNumber = await previewMancheNumber();
    const gameId = "preview";
    const embed = buildPaletteEmbed({ gameId, mancheNumber, cacheBust: Date.now() });
    const components = buildPaletteComponents(gameId);
    const catalog = await loadPaletteCatalog();
    return { dryRun: true, entry: { fr: "(aperçu, carte réelle tirée à la publication)" }, embed, components, catalog };
  }

  const state = await readState();
  if (!force && isTooSoonSinceLastRound(state?.startedAt)) {
    return { skipped: true, reason: "too-soon-since-last-round" };
  }

  const token = process.env.DISCORD_TOKEN;
  if (!token) throw new Error("DISCORD_TOKEN manquant.");

  const { state: newState, entry } = await startNewGame(channelId);
  const embed = buildPaletteEmbed({ gameId: newState.gameId, mancheNumber: newState.mancheNumber, cacheBust: Date.now() });
  const components = buildPaletteComponents(newState.gameId);

  const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ embeds: [embed], components }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Erreur envoi salon Discord (${res.status}): ${errText}`);
  }

  const message = await res.json();
  newState.messageId = message.id;
  await writeState(newState);

  return { state: newState, entry, message };
}

async function postEphemeral(webhookUrl, content) {
  if (!webhookUrl) return;
  try {
    await fetch(`${webhookUrl}/messages/@original`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    });
  } catch (err) {
    console.error("[Palette] Échec PATCH réponse éphémère:", err.message);
  }
}

async function postEphemeralEmbed(webhookUrl, embed) {
  if (!webhookUrl) return;
  try {
    await fetch(`${webhookUrl}/messages/@original`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ embeds: [embed] }),
    });
  } catch (err) {
    console.error("[Palette] Échec PATCH réponse éphémère (embed):", err.message);
  }
}

// ── Bouton de réponse A/B/C/D ──────────────────────────────────────
// Contrairement à Zoom (Modal), un simple clic suffit : ACK immédiat
// (type 5, éphémère) côté routeur, tout le traitement se fait ici, en
// arrière-plan (voir le bloc quiz_vote de interactions.js pour le même
// principe d'ACK).

export async function handleAnswerButton(webhookUrl, gameId, letter, discordId, username) {
  try {
    const state = await readState();
    if (!state || state.gameId !== gameId) {
      await postEphemeral(webhookUrl, "⚠️ Cette manche est terminée, une nouvelle a peut-être déjà commencé !");
      return;
    }

    const existing = await readParticipant(gameId, discordId);
    if (existing) {
      await postEphemeral(webhookUrl, "Tu as déjà répondu à cette manche, une seule tentative autorisée !");
      return;
    }

    const order = await readRoundOrder(gameId);
    const correct = checkAnswer(order, letter);
    const elapsedMs = Date.now() - new Date(state.startedAt).getTime();
    const score = computeScore(correct, elapsedMs);

    const { alreadyAnswered } = await recordAnswer(gameId, discordId, username, letter, correct, score);
    if (alreadyAnswered) {
      await postEphemeral(webhookUrl, "Tu as déjà répondu à cette manche, une seule tentative autorisée !");
      return;
    }

    const catalog = await loadPaletteCatalog();
    const entry = resolvePaletteEntry(catalog, gameId);
    const correctLetter = getCorrectLetter(order);
    const description = correct
      ? `✅ Bonne réponse ! **${entry?.fr ?? gameId}** — **+${score} pts**`
      : `❌ Mauvaise réponse (tu avais choisi **${letter}**, c'était **${correctLetter}**) — **${entry?.fr ?? gameId}**`;

    await postEphemeralEmbed(webhookUrl, {
      description,
      image: { url: `${TRUST_ROYALE_URL}/api/palette/image?gameId=${gameId}&stage=result&v=${Date.now()}` },
      color: PALETTE_COLOR,
    });
  } catch (err) {
    console.error("[Palette] Échec traitement de la réponse:", err.message);
    await postEphemeral(webhookUrl, `⚠️ ${err.message}`);
  }
}
