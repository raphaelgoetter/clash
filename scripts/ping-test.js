#!/usr/bin/env node

import dotenv from "dotenv";
import fetch from "node-fetch";
import { warResetOffsetMs } from "../backend/services/dateUtils.js";

dotenv.config({ path: "./.env" });

const DISCORD_API = "https://discord.com/api/v10";
const DRY_RUN = process.argv.includes("--dry-run");

const CHANNEL_ID = process.env.DISCORD_CHANNEL_MEMBERS_LRQP20V9;
const TOKEN = process.env.DISCORD_TOKEN;
const TARGET_USER_ID = "333264132277010432";
const CLAN_TAG = "LRQP20V9";
const CLAN_NAME = "Les Resistants";

function getWarContext() {
  const now = new Date();
  const resetUtcMs = warResetOffsetMs(CLAN_TAG);
  const p = new Date(now.toLocaleString("en-US", { timeZone: "Europe/Paris" }));
  const parisTime = `${String(p.getHours()).padStart(2, "0")}h${String(p.getMinutes()).padStart(2, "0")}`;

  const msOfDayUtc = now.getUTCHours() * 3600000 + now.getUTCMinutes() * 60000;
  if (msOfDayUtc < resetUtcMs) p.setDate(p.getDate() - 1);

  const WAR_DAY_LABELS = {
    4: "Jeudi (J1)",
    5: "Vendredi (J2)",
    6: "Samedi (J3)",
    0: "Dimanche (J4)",
  };

  return {
    parisTime,
    warDayLabel: WAR_DAY_LABELS[p.getDay()] ?? "Jour de GDC",
  };
}

async function main() {
  if (!CHANNEL_ID) {
    throw new Error("Variable manquante: DISCORD_CHANNEL_MEMBERS_LRQP20V9");
  }

  if (!TOKEN) {
    throw new Error("Variable manquante: DISCORD_TOKEN");
  }

  const mentionIds = new Set([TARGET_USER_ID]);
  const mentionLine = Array.from(mentionIds)
    .map((id) => `<@${id}>`)
    .join(" ");

  const { parisTime, warDayLabel } = getWarContext();
  const playerUrl = "https://trustroyale.vercel.app/fr/player/TESTPING";
  const description = [
    `- 1 joueur en retard a ${parisTime}`,
    "- 4 decks joues",
    "- 4 decks manquants",
    "",
    "**Manque 4 decks**",
    `- [displaynone](${playerUrl}) (membre) <@${TARGET_USER_ID}>`,
  ].join("\n");

  const embed = {
    title: "GDC : Soldat, il te reste des decks à jouer !",
    description,
    color: 0xe67e22,
    footer: { text: `${CLAN_NAME}, retardataires de ${warDayLabel}` },
  };

  const payload = {
    content: mentionLine || undefined,
    embeds: [embed],
    allowed_mentions: {
      parse: [],
      users: Array.from(mentionIds),
    },
  };

  if (DRY_RUN) {
    console.log("[DRY-RUN] Message qui serait envoye:");
    console.log(JSON.stringify(payload, null, 2));
    console.log(`[DRY-RUN] Channel cible: ${CHANNEL_ID}`);
    return;
  }

  const res = await fetch(`${DISCORD_API}/channels/${CHANNEL_ID}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bot ${TOKEN}`,
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Discord API ${res.status}: ${err}`);
  }

  const data = await res.json();
  console.log(`Ping envoye avec succes. Message ID: ${data.id}`);
}

main().catch((err) => {
  console.error("[ping-test] Erreur:", err.message);
  process.exit(1);
});
