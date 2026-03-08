// ============================================================
// routes/discord.js — Fallback Discord interactions endpoint
// Les vraies interactions sont traitées par api/discord/interactions.js
// (fonction Vercel dédiée, cold start minimal).
// Ce fichier reste uniquement pour la compatibilité de routing Express.
// ============================================================

import { Router } from 'express';
import express from 'express';

const router = Router();

router.post(
  '/interactions',
  express.raw({ type: 'application/json' }),
  (_req, res) => {
    res.status(404).json({ error: 'Use /api/discord/interactions directly.' });
  },
);

export default router;
