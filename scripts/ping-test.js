#!/usr/bin/env node

import dotenv from "dotenv";
import fetch from "node-fetch";

dotenv.config({ path: "./.env" });

const DISCORD_API = "https://discord.com/api/v10";
const DRY_RUN = process.argv.includes("--dry-run");

const CHANNEL_ID = process.env.DISCORD_CHANNEL_MEMBERS_LRQP20V9;
const TOKEN = process.env.DISCORD_TOKEN;
const TARGET_USER_ID = "333264132277010432";

async function main() {
  if (!CHANNEL_ID) {
    throw new Error("Variable manquante: DISCORD_CHANNEL_MEMBERS_LRQP20V9");
  }

  if (!TOKEN) {
    throw new Error("Variable manquante: DISCORD_TOKEN");
  }

  const payload = {
    content: `Test ping TrustRoyale: <@${TARGET_USER_ID}>`,
    allowed_mentions: {
      parse: [],
      users: [TARGET_USER_ID],
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
