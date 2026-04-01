// notifyMemberChanges.js
// Détecte les arrivées et départs de membres dans chaque clan en comparant
// le clan cache persisté (état précédent, ~1h) avec l'état actuel de l'API Clash Royale.
// Doit être exécuté AVANT npm run cache pour que le fichier JSON ne soit pas encore écrasé.

import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import fetch from 'node-fetch';
import { fetchClanMembers } from '../backend/services/clashApi.js';
import { ALLOWED_CLANS } from '../backend/routes/clan.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(__dirname, '..', 'frontend', 'public', 'clan-cache');

const DISCORD_API = 'https://discord.com/api/v10';

/**
 * Lit le clan cache persisté pour un tag donné.
 * Retourne null si le fichier est absent (premier run).
 * @param {string} tag
 * @returns {Promise<{ tags: Set<string>, names: Map<string, string> } | null>}
 */
async function readCachedMembers(tag) {
  const filePath = path.join(CACHE_DIR, `${tag}.json`);
  if (!existsSync(filePath)) return null;

  const raw = await readFile(filePath, 'utf-8');
  const data = JSON.parse(raw);
  const members = data.members ?? [];
  if (members.length === 0) return null;

  const tags = new Set(members.map((m) => m.tag));
  const names = new Map(members.map((m) => [m.tag, m.name]));
  return { tags, names };
}

/**
 * Récupère les membres actuels via l'API Clash Royale.
 * @param {string} tag
 * @returns {Promise<{ tags: Set<string>, names: Map<string, string>, clanName: string }>}
 */
async function fetchCurrentMembers(tag) {
  const members = await fetchClanMembers(tag);
  const tags = new Set(members.map((m) => m.tag));
  const names = new Map(members.map((m) => [m.tag, m.name]));
  // Le nom du clan n'est pas dans fetchClanMembers — fallback sur le cache si dispo
  return { tags, names };
}

/**
 * Lit le nom du clan depuis le cache persisté.
 * @param {string} tag
 * @returns {Promise<string>}
 */
async function readClanName(tag) {
  const filePath = path.join(CACHE_DIR, `${tag}.json`);
  if (!existsSync(filePath)) return `#${tag}`;
  const raw = await readFile(filePath, 'utf-8');
  const data = JSON.parse(raw);
  return data.clan?.name ?? `#${tag}`;
}

/**
 * Envoie un embed Discord dans le channel configuré pour ce clan.
 * @param {string} tag - tag du clan (sans #)
 * @param {string} clanName
 * @param {Array<{tag: string, name: string}>} arrivals
 * @param {Array<{tag: string, name: string}>} departures
 */
async function postDiscordEmbed(tag, clanName, arrivals, departures) {
  const channelId = process.env[`DISCORD_CHANNEL_MEMBERS_${tag}`];
  const token = process.env.DISCORD_TOKEN;

  if (!channelId) {
    console.log(`[${tag}] DISCORD_CHANNEL_MEMBERS_${tag} non configuré — notification ignorée.`);
    return;
  }
  if (!token) {
    console.log(`[${tag}] DISCORD_TOKEN non configuré — notification ignorée.`);
    return;
  }

  // Couleur : vert = arrivées uniquement, rouge = départs uniquement, bleu = mixte
  let color;
  if (arrivals.length > 0 && departures.length === 0) color = 0x57f287; // vert
  else if (departures.length > 0 && arrivals.length === 0) color = 0xed4245; // rouge
  else color = 0x5865f2; // bleu

  const fields = [];

  if (arrivals.length > 0) {
    fields.push({
      name: `🟢 Arrivée${arrivals.length > 1 ? 's' : ''} (${arrivals.length})`,
      value: arrivals.map((m) => `**${m.name}** (\`${m.tag}\`)`).join('\n'),
      inline: false,
    });
  }

  if (departures.length > 0) {
    fields.push({
      name: `🔴 Départ${departures.length > 1 ? 's' : ''} (${departures.length})`,
      value: departures.map((m) => `**${m.name}** (\`${m.tag}\`)`).join('\n'),
      inline: false,
    });
  }

  const embed = {
    title: `${clanName} — Mouvement${arrivals.length + departures.length > 1 ? 's' : ''} de membre${arrivals.length + departures.length > 1 ? 's' : ''}`,
    color,
    fields,
    footer: { text: new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC' },
  };

  const res = await fetch(`${DISCORD_API}/channels/${channelId}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bot ${token}`,
    },
    body: JSON.stringify({ embeds: [embed] }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Discord API ${res.status}: ${err}`);
  }

  console.log(`[${tag}] Notification envoyée (${arrivals.length} arrivée(s), ${departures.length} départ(s)).`);
}

async function main() {
  let hasError = false;

  for (const tag of ALLOWED_CLANS) {
    try {
      const [cached, current, clanName] = await Promise.all([
        readCachedMembers(tag),
        fetchCurrentMembers(tag),
        readClanName(tag),
      ]);

      if (!cached) {
        console.log(`[${tag}] Pas de cache précédent — premier run, diff ignoré.`);
        continue;
      }

      const arrivals = [...current.tags]
        .filter((t) => !cached.tags.has(t))
        .map((t) => ({ tag: t, name: current.names.get(t) ?? t }));

      const departures = [...cached.tags]
        .filter((t) => !current.tags.has(t))
        .map((t) => ({ tag: t, name: cached.names.get(t) ?? t }));

      if (arrivals.length === 0 && departures.length === 0) {
        console.log(`[${tag}] Aucun changement de membres.`);
        continue;
      }

      console.log(`[${tag}] Changements détectés — ${arrivals.length} arrivée(s), ${departures.length} départ(s).`);
      await postDiscordEmbed(tag, clanName, arrivals, departures);
    } catch (err) {
      console.error(`[${tag}] Erreur : ${err.message}`);
      hasError = true;
    }
  }

  // Ne pas faire échouer le workflow pour une erreur de notification
  process.exit(0);
}

main();
