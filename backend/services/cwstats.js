import fs from 'fs/promises';
import path from 'path';

import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.resolve(__dirname, '..', '..', 'data', 'cwstats');
const CACHE_TTL_MS = 1000 * 60 * 60; // 1h

async function ensureCacheDir() {
  try {
    await fs.mkdir(CACHE_DIR, { recursive: true });
  } catch (_) {}
}

function cacheFile(clanTag) {
  const clean = clanTag.replace(/[^A-Za-z0-9]/g, '');
  return path.join(CACHE_DIR, `${clean}.json`);
}

async function loadCache(clanTag) {
  await ensureCacheDir();
  const file = cacheFile(clanTag);
  try {
    const txt = await fs.readFile(file, 'utf8');
    const obj = JSON.parse(txt);
    if (Date.now() - (obj.updatedAt || 0) > CACHE_TTL_MS) return null;
    return obj;
  } catch (_) {
    return null;
  }
}

async function saveCache(clanTag, data) {
  await ensureCacheDir();
  const file = cacheFile(clanTag);
  const out = { updatedAt: Date.now(), ...data };
  await fs.writeFile(file, JSON.stringify(out, null, 2));
  return out;
}

async function fetchCwstatsClan(clanTag) {
  // cwstats expects tag without '#'
  const clean = clanTag.replace(/[^A-Za-z0-9]/g, '');
  const url = `https://cwstats.com/clan/${clean}/race`;
  const res = await fetch(url, { headers: { 'User-Agent': 'TrustRoyale/1.0' } });
  if (!res.ok) throw new Error(`cwstats fetch failed: ${res.status}`);
  const text = await res.text();

  // The relevant data is embedded in a JS string used by the React app.
  // We locate the `"clans":[ ... ]` json array in the payload and then
  // extract the clan entry we're interested in.
  const clansToken = '\\"clans\\":[';
  const clansIdx = text.indexOf(clansToken);
  let decksUsed = null;
  let decksUsedToday = null;

  if (clansIdx !== -1) {
    const start = text.indexOf('[', clansIdx);
    if (start !== -1) {
      let depth = 0;
      let end = -1;
      for (let i = start; i < text.length; i++) {
        const c = text[i];
        if (c === '[') depth++;
        else if (c === ']') {
          depth--;
          if (depth === 0) {
            end = i + 1;
            break;
          }
        }
      }
      if (end !== -1) {
        const raw = text.slice(start, end);
        // Unescape quote sequences so we can search and parse real JSON.
        const unescaped = raw.replace(/\\\"/g, '"');

        // Find the exact clan object by locating its tag and extracting the surrounding JSON object.
        const clanToken = `\"tag\":\"#${clean.toUpperCase()}\"`;
        let clanObj = null;

        // Search occurrences of the tag token and try to locate the enclosing clan object.
        let searchPos = 0;
        while (true) {
          const pos = unescaped.indexOf(clanToken, searchPos);
          if (pos === -1) break;

          // Look back for the start of the clan object (it begins with {"badgeId":)
          const badgeStart = unescaped.lastIndexOf('{"badgeId":', pos);
          if (badgeStart !== -1) {
            // Extract the object text from this brace to its matching closing brace.
            let depth = 0;
            let objEnd = -1;
            for (let i = badgeStart; i < unescaped.length; i++) {
              const c = unescaped[i];
              if (c === '{') depth++;
              else if (c === '}') {
                depth--;
                if (depth === 0) {
                  objEnd = i + 1;
                  break;
                }
              }
            }
            if (objEnd !== -1) {
              const objStr = unescaped.slice(badgeStart, objEnd);
              try {
                const parsed = JSON.parse(objStr);
                if (parsed?.tag === `#${clean.toUpperCase()}`) {
                  clanObj = parsed;
                  break;
                }
              } catch {
                // ignore parse failure
              }
            }
          }

          searchPos = pos + clanToken.length;
        }

        if (clanObj) {
          if (Array.isArray(clanObj.participants)) {
            decksUsed = clanObj.participants.reduce((sum, p) => sum + (Number(p?.decksUsed) || 0), 0);
            decksUsedToday = clanObj.participants.reduce((sum, p) => sum + (Number(p?.decksUsedToday) || 0), 0);
          }
          if (decksUsed == null && Number.isFinite(clanObj.decksUsed)) {
            decksUsed = clanObj.decksUsed;
          }
          if (decksUsedToday == null && Number.isFinite(clanObj.decksUsedToday)) {
            decksUsedToday = clanObj.decksUsedToday;
          }
        }
      }
    }
  }

  return { decksUsed, decksUsedToday, raw: text.slice(0, 200000), fetchedAt: Date.now() };
}

export async function getCwstatsData(clanTag) {
  const cached = await loadCache(clanTag);
  if (cached) return cached;
  const fresh = await fetchCwstatsClan(clanTag);
  return await saveCache(clanTag, fresh);
}
