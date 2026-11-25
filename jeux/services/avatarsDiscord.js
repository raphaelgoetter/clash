// ============================================================
// avatarsDiscord.js — Avatars Discord des joueurs pour les images de jeux
// (Qui est-ce ?, Pont du Troll), en data URL PNG prête pour un <image> SVG.
// Avatar téléchargé sur le CDN Discord (128 px, délai 4 s, cache mémoire
// par instance) ; repli sur une créature Clay fixe (Vercel Blob,
// `avatars/clay-XX.png`) si l'avatar manque ou échoue.
// ============================================================

import { readBlobAsset } from "@clash/commun/blobAssets.js";

const NB_CLAY = 12;
const avatarCache = new Map();

async function dataUrlDepuis(url, lire) {
  if (!avatarCache.has(url)) {
    avatarCache.set(
      url,
      lire()
        .then((buffer) => `data:image/png;base64,${buffer.toString("base64")}`)
        .catch(() => {
          avatarCache.delete(url);
          return null;
        }),
    );
  }
  return avatarCache.get(url);
}

export function clayDataUrl(i) {
  const n = String((((i % NB_CLAY) + NB_CLAY) % NB_CLAY) + 1).padStart(2, "0");
  return dataUrlDepuis(`clay-${n}`, () => readBlobAsset(`avatars/clay-${n}.png`));
}

// Avatar Discord `"id/hash"` (id/hash validés : la valeur peut venir d'un
// paramètre public) ou créature Clay fixe (`"clay-02"`, bots remplaçants).
// `i` choisit la créature de repli.
export async function avatarDataUrl(av, i) {
  const clay = /^clay-(\d{2})$/.exec(String(av ?? ""));
  if (clay) return clayDataUrl(Number(clay[1]) - 1);
  const m = /^(\d{5,22})\/((?:a_)?[0-9a-f]{32})$/.exec(String(av ?? ""));
  if (m) {
    const url = `https://cdn.discordapp.com/avatars/${m[1]}/${m[2]}.png?size=128`;
    const d = await dataUrlDepuis(url, async () => {
      const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    });
    if (d) return d;
  }
  return clayDataUrl(i);
}
