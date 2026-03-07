// ============================================================
// routes/discord.js — Discord interactions endpoint (slash commands)
// ============================================================

import { Router } from 'express';
import express from 'express';
import fetch from 'node-fetch';
import { verifyKey } from 'discord-interactions';
import { getPlayerAnalysis } from '../services/analysisService.js';

function colorEmoji(color) {
  switch (color) {
    case 'green': return '🟢';
    case 'yellow': return '🟡';
    case 'orange': return '🟠';
    case 'red': return '🔴';
    default: return '';
  }
}

function hexColor(name) {
  return {
    green: 0x00FF00,
    yellow: 0xFFFF00,
    orange: 0xFFA500,
    red: 0xFF0000,
  }[name] ?? 0x808080;
}

const router = Router();

// We use express.raw here so we can verify Discord's Ed25519 signature
// before the body is parsed. The verifier expects the raw JSON string.
router.post(
  '/interactions',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    const signature = req.headers['x-signature-ed25519'];
    const timestamp = req.headers['x-signature-timestamp'];
    const rawBody = req.body.toString('utf8');

    if (
      !verifyKey(rawBody, signature, timestamp, process.env.DISCORD_PUBLIC_KEY)
    ) {
      return res.status(401).send('invalid request signature');
    }

    let body;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return res.status(400).send('invalid json');
    }

    // Discord PING (required for endpoint verification)
    if (body.type === 1) {
      return res.json({ type: 1 });
    }

    // Application command
    if (body.type === 2 && body.data?.name === 'trust') {
      const tagOption = body.data.options?.find((o) => o.name === 'tag');
      const tag = tagOption?.value;
      if (!tag) {
        return res.json({
          type: 4,
          data: { content: 'Veuillez fournir un tag de joueur.', flags: 64 },
        });
      }

      // acknowledge quickly and defer the actual message
      res.json({ type: 5 });

      try {
        const analysis = await getPlayerAnalysis(tag);
        const scoreObj = analysis.warScore || analysis.reliability;
        const total = scoreObj.total;
        const maxScore = scoreObj.maxScore;
        const pct = scoreObj.pct;
        const colorName = scoreObj.color ?? 'grey';
        const embedColor = hexColor(colorName);

        const lastSeen = analysis.overview.lastSeen
          ? new Date(analysis.overview.lastSeen).toLocaleString()
          : 'N/A';
        const stability = analysis.warHistory
          ? `${analysis.warHistory.streakInCurrentClan} semaines`
          : 'N/A';
        const donations = analysis.activityIndicators?.donations ?? 0;

        const embed = {
          title: `Analyse de ${analysis.overview.name}`,
          description: `${total}/${maxScore} pts (${pct}%) ${colorEmoji(colorName)}`,
          color: embedColor,
          fields: [
            { name: 'Derniers dons', value: `${donations}`, inline: true },
            { name: 'Stabilité dans le clan', value: stability, inline: true },
            { name: 'Dernière activité', value: lastSeen, inline: true },
          ],
          url: `https://trustroyale.vercel.app/?mode=player&tag=${encodeURIComponent(
            tag,
          )}`,
        };

        const webhookUrl =
          `https://discord.com/api/v10/webhooks/${process.env.DISCORD_APP_ID}/${body.token}`;
        await fetch(webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ embeds: [embed] }),
        });
      } catch (err) {
        const webhookUrl =
          `https://discord.com/api/v10/webhooks/${process.env.DISCORD_APP_ID}/${body.token}`;
        await fetch(webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            content: `Erreur lors de l'analyse : ${err.message}`,
            flags: 64,
          }),
        });
      }
      return;
    }

    // unknown interaction type
    res.status(400).json({ error: 'Unsupported interaction' });
  },
);

export default router;
