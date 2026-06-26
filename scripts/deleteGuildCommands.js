#!/usr/bin/env node
// One-shot script: delete all guild commands to remove duplicates.
// Run once after switching to global-only registration.
// Usage: node scripts/deleteGuildCommands.js

import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config({ path: "./.env" });

const appId = process.env.DISCORD_APP_ID;
const token = process.env.DISCORD_TOKEN;
const guildId = process.env.DISCORD_GUILD_ID;

if (!appId || !token || !guildId) {
  console.error("DISCORD_APP_ID, DISCORD_TOKEN, and DISCORD_GUILD_ID must be set");
  process.exit(1);
}

const guildUrl = `https://discord.com/api/v10/applications/${appId}/guilds/${guildId}/commands`;

(async () => {
  try {
    // Fetch existing guild commands
    const res = await fetch(guildUrl, {
      headers: { Authorization: `Bot ${token}` },
    });
    const commands = await res.json();
    if (!res.ok) {
      console.error("Failed to fetch guild commands", commands);
      process.exit(1);
    }
    console.log(`Found ${commands.length} guild command(s) to delete.`);

    // Delete each one
    for (const cmd of commands) {
      const delRes = await fetch(`${guildUrl}/${cmd.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bot ${token}` },
      });
      if (delRes.ok) {
        console.log(`Deleted: ${cmd.name} (${cmd.id})`);
      } else {
        const err = await delRes.json();
        console.error(`Failed to delete ${cmd.name} (${cmd.id}):`, err);
      }
    }
    console.log("Done. Global commands remain active. Duplicates should disappear.");
  } catch (err) {
    console.error("Request failed", err);
    process.exit(1);
  }
})();
