// ============================================================
// server.js — Express entry point
// ============================================================

import dotenv from "dotenv";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

// Load .env from the project root (one level above backend/)
const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, "../.env") });

import fs from "fs/promises";
import express from "express";
import cors from "cors";
import compression from "compression";
import playerRoutes from "./routes/player.js";
import clanRoutes, { ALLOWED_CLANS } from "./routes/clan.js";
import deckRoutes from "./routes/decks.js";
import matchupRoutes from "./routes/matchup.js";
import discordRoutes from "./routes/discord.js";
import { clearAll } from "./services/cache.js";
import { fetchClan, fetchPlayer } from "./services/clashApi.js";
import { getCurrentFrameImage, getFrameImageByGameId } from "./services/frames.js";

const app = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ────────────────────────────────────────────────
app.use(cors());
app.use(compression()); // We need raw body for Discord interaction signature verification, so
// skip the global JSON parser for the /api/discord route.
app.use((req, res, next) => {
  if (req.path.startsWith("/api/discord")) return next();
  express.json()(req, res, next);
});

// ── Health check ──────────────────────────────────────────────
app.get("/health", (_req, res) => res.json({ status: "ok" }));

// ── Server public IP (useful to whitelist on developer.clashroyale.com) ──
app.get("/api/ip", async (_req, res) => {
  try {
    const r = await (
      await import("node-fetch")
    ).default("https://api.ipify.org?format=json");
    const data = await r.json();
    res.json({
      ip: data.ip,
      hint: `Add this IP to your Clash Royale API key at https://developer.clashroyale.com/`,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const CLAN_META_DESCRIPTION = {
  Y8JUPC9C: {
    name: "La Resistance",
    description:
      "Clan 1 de la famille Resistance. Top France. Guerre de clan obligatoire",
  },
  LRQP20V9: {
    name: "Les Resistants",
    description:
      "Clan 2 de la famille Resistance. Top France. Guerre de clan obligatoire",
  },
  QU9UQJRL: {
    name: "Les Revoltes",
    description: "Clan 3 de la famille Resistance. Entraînement Guerre de clan",
  },
  QUV220GJ: {
    name: "La Treve",
    description: "Clan 4 de la famille Resistance. Joueurs en pause",
  },
};

function normalizeTag(tag) {
  return tag?.replace(/^#/, "").toUpperCase() || "";
}
function getClanMeta(tag) {
  return CLAN_META_DESCRIPTION[normalizeTag(tag)] || null;
}
function escapeHtml(str = "") {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function buildPageMeta(type, titleName, clanTag) {
  const clanMeta = getClanMeta(clanTag);
  const name = titleName || clanMeta?.name || "TrustRoyale";
  const title =
    type === "clan"
      ? `TrustRoyale - Fiabilité du clan : ${name}`
      : `TrustRoyale - Fiabilité du joueur : ${name}`;

  const description =
    type === "clan"
      ? clanMeta?.description || `Analyse de la fiabilité du clan ${name}.`
      : clanMeta?.name
        ? `Analyse de la fiabilité du joueur ${name} dans le clan ${clanMeta.name}.`
        : `Analyse de la fiabilité du joueur ${name}.`;

  return { title, description };
}

async function loadIndexHtml(req) {
  const staticUrl = new URL(
    "/index.html",
    `${req.headers["x-forwarded-proto"] || req.protocol}://${req.headers.host}`,
  ).toString();

  if (process.env.VERCEL && req.headers.host) {
    try {
      const res = await fetch(staticUrl);
      if (res.ok) return await res.text();
      throw new Error(`Static index fetch failed: ${res.status}`);
    } catch (err) {
      console.warn("Failed to fetch static index.html from host:", err.message);
    }
  }

  const localPath = resolve(__dirname, "../frontend/dist/index.html");
  return fs.readFile(localPath, "utf8");
}

function applyMetaToHtml(html, meta, reqUrl) {
  let rendered = html;
  rendered = rendered.replace(
    /<title>[\s\S]*?<\/title>/i,
    `<title>${escapeHtml(meta.title)}</title>`,
  );

  const insertAfterTitle = (fragment) => {
    if (!/<\/title>/i.test(rendered)) return;
    rendered = rendered.replace(
      /(<\/title>)/i,
      `$1
    ${fragment}`,
    );
  };

  const ensureMeta = (regex, fragment) => {
    if (regex.test(rendered)) {
      rendered = rendered.replace(regex, fragment);
    } else {
      insertAfterTitle(fragment);
    }
  };

  ensureMeta(
    /<meta\s+name="description"\s+content="[^"]*"\s*\/?\s*>/i,
    `<meta name="description" content="${escapeHtml(meta.description)}" />`,
  );
  ensureMeta(
    /<meta\s+property="og:title"\s+content="[^"]*"\s*\/?\s*>/i,
    `<meta property="og:title" content="${escapeHtml(meta.title)}" />`,
  );
  ensureMeta(
    /<meta\s+property="og:description"\s+content="[^"]*"\s*\/?\s*>/i,
    `<meta property="og:description" content="${escapeHtml(meta.description)}" />`,
  );
  ensureMeta(
    /<meta\s+name="twitter:title"\s+content="[^"]*"\s*\/?\s*>/i,
    `<meta name="twitter:title" content="${escapeHtml(meta.title)}" />`,
  );
  ensureMeta(
    /<meta\s+name="twitter:description"\s+content="[^"]*"\s*\/?\s*>/i,
    `<meta name="twitter:description" content="${escapeHtml(meta.description)}" />`,
  );
  ensureMeta(
    /<link\s+rel="canonical"\s+href="[^"]*"\s*\/?\s*>/i,
    `<link rel="canonical" href="${escapeHtml(reqUrl)}" />`,
  );
  ensureMeta(
    /<meta\s+property="og:url"\s+content="[^"]*"\s*\/?\s*>/i,
    `<meta property="og:url" content="${escapeHtml(reqUrl)}" />`,
  );
  return rendered;
}

async function renderDynamicPage(req, res, type) {
  try {
    const tag = normalizeTag(req.params.tag);
    let displayName = null;
    let metaClanTag = null;

    if (type === "clan") {
      try {
        const clan = await fetchClan(tag);
        displayName = clan?.name || getClanMeta(tag)?.name || tag;
        metaClanTag = tag;
      } catch {
        displayName = getClanMeta(tag)?.name || tag;
        metaClanTag = tag;
      }
    } else {
      try {
        const player = await fetchPlayer(tag);
        displayName = player?.name || tag;
        metaClanTag = player?.clan?.tag ? normalizeTag(player.clan.tag) : null;
      } catch {
        displayName = tag;
      }
    }

    const meta = buildPageMeta(type, displayName, metaClanTag);
    const html = await loadIndexHtml(req);
    const protocol = req.headers["x-forwarded-proto"] || req.protocol;
    const canonicalUrl = `${protocol}://${req.headers.host}${req.path}`;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(applyMetaToHtml(html, meta, canonicalUrl));
  } catch (err) {
    console.error("Dynamic page rendering failed:", err);
    res.status(500).send("Internal Server Error");
  }
}

app.get("/player/:tag", async (req, res) =>
  renderDynamicPage(req, res, "player"),
);
app.get("/clan/:tag", async (req, res) =>
  renderDynamicPage(req, res, "clan"),
);

// ── Debug helper (remove before production) ─────────────────────
app.get("/api/debug", (_req, res) => {
  // show which critical env vars are set; public key/app id are safe to print
  res.json({
    clashKey: process.env.CLASH_API_KEY ? "present" : null,
    discordPublicKey: process.env.DISCORD_PUBLIC_KEY || null,
    discordAppId: process.env.DISCORD_APP_ID || null,
  });
});

// ── API routes ────────────────────────────────────────────────
app.use("/api/player", playerRoutes);
app.use("/api/clan", clanRoutes);
app.use("/api/decks", deckRoutes);
app.use("/api/matchup", matchupRoutes);
// Discord interactions endpoint (slash commands)
app.use("/api/discord", discordRoutes);

// Jeu Frame : sert l'image d'une manche précise (?gameId=), ou par défaut
// celle de la partie active — jamais une image future par nom de fichier
// deviné (data/frames/images n'est pas exposé statiquement, seule cette
// route y donne accès). Le paramètre gameId permet aux anciens posts
// Discord de continuer à afficher LEUR image même après que la partie ait
// avancé (voir getFrameImageByGameId, gardé par un registre des gameId déjà
// postés — jamais une manche qui n'a pas encore eu lieu).
app.get("/api/frames/image", async (req, res) => {
  const { gameId } = req.query;
  const image = await (gameId
    ? getFrameImageByGameId(String(gameId))
    : getCurrentFrameImage()
  ).catch(() => null);
  if (!image) return res.status(404).end();
  res.setHeader("Content-Type", "image/webp");
  res.setHeader("Cache-Control", "no-store");
  res.send(image.buffer);
});

// ── Cache flush (dev) ─────────────────────────────────────────
app.post("/api/cache/flush", (_req, res) => {
  clearAll();
  res.json({ ok: true, message: "Cache vidé." });
});

// ── 404 handler ───────────────────────────────────────────────
app.use((_req, res) => res.status(404).json({ error: "Route not found" }));

// ── Global error handler ──────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
});

// ── Start ─────────────────────────────────────────────────────
// Export app for Vercel serverless (handler is the Express app itself)
export default app;

// Only bind a TCP port when running locally (Vercel sets VERCEL=1)
if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`✅  Backend running at http://localhost:${PORT}`);
  });
}
