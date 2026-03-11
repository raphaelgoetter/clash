// ============================================================
// services/discordLinks.js — Récupération des liens Discord
// En production : lit data/discord-links.json depuis GitHub (cache 5 min).
// En dev local  : lit directement le fichier local.
// ============================================================

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOCAL_PATH = path.resolve(__dirname, '../../data/discord-links.json');

let _cache = null;
let _cacheTime = 0;
const TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Retourne le mapping { "#TAG": "discord_user_id" }.
 * Utilise GitHub Contents API en production, le fichier local en dev.
 * En cas d'erreur, retourne {}.
 */
export async function getDiscordLinks() {
  if (_cache !== null && Date.now() - _cacheTime < TTL) return _cache;

  const repo  = process.env.GITHUB_REPO;
  const token = process.env.GITHUB_TOKEN;

  // Fallback local : utilisé quand les variables GitHub ne sont pas définies
  if (!repo || !token) {
    try {
      const raw = await fs.readFile(LOCAL_PATH, 'utf8');
      _cache = JSON.parse(raw);
      _cacheTime = Date.now();
      return _cache;
    } catch {
      return {};
    }
  }

  try {
    const res = await fetch(
      `https://api.github.com/repos/${repo}/contents/data/discord-links.json`,
      { headers: { Authorization: `token ${token}`, Accept: 'application/vnd.github+json' } },
    );
    if (!res.ok) return {};
    const json = await res.json();
    _cache = JSON.parse(Buffer.from(json.content, 'base64').toString('utf8'));
    _cacheTime = Date.now();
    return _cache;
  } catch {
    return {};
  }
}
