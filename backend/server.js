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
import clanRoutes from './routes/clan.js';
import { clearAll } from './services/cache.js';

const app = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ────────────────────────────────────────────────
app.use(cors());
app.use(express.json());

// ── Request logger (development) ──────────────────────────────
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
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

// ── API routes ────────────────────────────────────────────────
app.use('/api/player', playerRoutes);
app.use('/api/clan', clanRoutes);

// ── Cache flush (dev) ─────────────────────────────────────────
app.post('/api/cache/flush', (_req, res) => {
  clearAll();
  res.json({ ok: true, message: 'Cache vidé.' });
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
