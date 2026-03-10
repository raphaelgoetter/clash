// ============================================================
// server.js — Express entry point
// ============================================================

import dotenv from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// Load .env from the project root (one level above backend/)
const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, '../.env') });

import express from 'express';
import cors from 'cors';
import playerRoutes from './routes/player.js';
import clanRoutes, { ALLOWED_CLANS } from './routes/clan.js';
import discordRoutes from './routes/discord.js';
import { clearAll } from './services/cache.js';
import { fetchRaceLog } from './services/clashApi.js';

const app = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ────────────────────────────────────────────────
app.use(cors());
// We need raw body for Discord interaction signature verification, so
// skip the global JSON parser for the /api/discord route.
app.use((req, res, next) => {
  if (req.path.startsWith('/api/discord')) return next();
  express.json()(req, res, next);
});

// ── Request logger (development) ──────────────────────────────
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// ── Snapshot middleware ───────────────────────────────────────
// Trigger a decksUsed snapshot for each allowed clan on *any* page
// visit, but only once per UTC day per clan.  Uses fire‑and‑forget calls
// so it doesn't delay the response.  The cache is in‑memory and reset on
// server restart, which is fine for low‑traffic use; a more persistent
// store could be added later if needed.
const lastSnapshotDate = {}; // tag (upper, no #) -> 'YYYY-MM-DD'
app.use((req, res, next) => {
  const today = new Date().toISOString().slice(0, 10);
  if (req.path.startsWith('/api/discord')) return next();

  ALLOWED_CLANS.forEach((clanTag) => {
    if (lastSnapshotDate[clanTag] === today) return;
    lastSnapshotDate[clanTag] = today;

    fetchRaceLog(clanTag)
      .then((log) => {
        if (Array.isArray(log) && log.length) {
          const standing = log[0].standings.find(
            (s) => s.clan?.tag?.toUpperCase() === `#${clanTag}`
          );
          const participants = standing?.clan?.participants || [];
          const weekId = `S${log[0].seasonId}W${log[0].sectionIndex}`;
          import('./services/snapshot.js').then(({ recordSnapshot }) => {
            recordSnapshot(clanTag, participants, weekId).catch(() => {});
          });
        }
      })
      .catch(() => {}); // ignore API failure, will retry next request
  });

  // also refresh persistent analysis cache asynchronously
  import('./routes/clan.js').then(({ buildClanAnalysis }) => {
    import('./services/analysisCache.js').then(({ refreshAllClans }) => {
      refreshAllClans(ALLOWED_CLANS, buildClanAnalysis).catch(() => {});
    });
  });

  next();
});

// ── Health check ──────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// ── Server public IP (useful to whitelist on developer.clashroyale.com) ──
app.get('/api/ip', async (_req, res) => {
  try {
    const r = await (await import('node-fetch')).default('https://api.ipify.org?format=json');
    const data = await r.json();
    res.json({
      ip: data.ip,
      hint: `Add this IP to your Clash Royale API key at https://developer.clashroyale.com/`,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Debug helper (remove before production) ─────────────────────
app.get('/api/debug', (_req, res) => {
  // show which critical env vars are set; public key/app id are safe to print
  res.json({
    clashKey: process.env.CLASH_API_KEY ? 'present' : null,
    discordPublicKey: process.env.DISCORD_PUBLIC_KEY || null,
    discordAppId: process.env.DISCORD_APP_ID || null,
  });
});

// ── API routes ────────────────────────────────────────────────
app.use('/api/player', playerRoutes);
app.use('/api/clan', clanRoutes);
// Discord interactions endpoint (slash commands)
app.use('/api/discord', discordRoutes);

// ── Cache flush (dev) ─────────────────────────────────────────
app.post('/api/cache/flush', (_req, res) => {
  clearAll();
  res.json({ ok: true, message: 'Cache vidé.' });
});

// ── Manual analysis cache refresh (triggered by frontend button) ──
app.post('/api/cache/refresh', async (req, res) => {
  try {
    const { refreshAllClans } = await import('./services/analysisCache.js');
    const { ALLOWED_CLANS, buildClanAnalysis } = await import('./routes/clan.js');
    await refreshAllClans(ALLOWED_CLANS, buildClanAnalysis);
    res.json({ ok: true });
  } catch (err) {
    console.error('cache refresh endpoint failure', err);
    res.status(500).json({ error: err.message });
  }
});

// ── 404 handler ───────────────────────────────────────────────
app.use((_req, res) => res.status(404).json({ error: 'Route not found' }));

// ── Global error handler ──────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
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
