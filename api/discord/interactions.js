// Fonction Vercel dédiée pour les interactions Discord.
// Volontairement sans Express ni aucune dépendance npm afin de minimiser
// le cold start et répondre dans la fenêtre de 3 s imposée par Discord.
import { createPublicKey, verify } from 'node:crypto';

// Vérifie la signature Ed25519 envoyée par Discord.
function verifyDiscordSignature(signature, timestamp, rawBody) {
  const publicKeyHex = process.env.DISCORD_PUBLIC_KEY;
  if (!publicKeyHex || !signature || !timestamp) return false;
  try {
    // Encapsule la clé publique brute dans le format SPKI DER attendu par Node.js
    const spkiPrefix = Buffer.from('302a300506032b6570032100', 'hex');
    const pubKeyDer = Buffer.concat([spkiPrefix, Buffer.from(publicKeyHex, 'hex')]);
    const publicKey = createPublicKey({ key: pubKeyDer, format: 'der', type: 'spki' });
    return verify(
      null,
      Buffer.from(timestamp + rawBody),
      publicKey,
      Buffer.from(signature, 'hex'),
    );
  } catch {
    return false;
  }
}

const COLOR_MAP = { green: 0x2ecc71, yellow: 0xf1c40f, orange: 0xe67e22, red: 0xe74c3c };
const EMOJI_MAP = { green: '🟢', yellow: '🟡', orange: '🟠', red: '🔴' };

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const signature = req.headers['x-signature-ed25519'];
  const timestamp  = req.headers['x-signature-timestamp'];

  // Lecture du corps brut (nécessaire pour vérifier la signature)
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const rawBody = Buffer.concat(chunks).toString('utf8');

  // Vérification de signature obligatoire *avant tout*, y compris pour les PINGs.
  // Discord teste explicitement que le endpoint rejette les requêtes sans signature valide.
  if (!verifyDiscordSignature(signature, timestamp, rawBody)) {
    return res.status(401).end('invalid request signature');
  }

  let body;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return res.status(400).end('invalid json');
  }

  // Discord PING — répond après vérification de signature (requis par Discord pour valider l'endpoint)
  if (body.type === 1) {
    return res.status(200).json({ type: 1 });
  }

  // Commande /trust
  if (body.type === 2 && body.data?.name === 'trust') {
    const tagOption = body.data.options?.find((o) => o.name === 'tag');
    const rawTag = tagOption?.value?.trim();
    if (!rawTag) {
      return res.status(200).json({
        type: 4,
        data: { content: 'Veuillez fournir un tag de joueur (ex: `#ABC123`).', flags: 64 },
      });
    }

    // Réponse différée immédiate — satisfait la fenêtre de 3 s de Discord.
    // La fonction Vercel reste active jusqu'à son retour (maxDuration: 10 s).
    res.status(200).json({ type: 5 });

    const tag = rawTag.startsWith('#') ? rawTag : `#${rawTag}`;
    const webhookUrl = `https://discord.com/api/v10/webhooks/${process.env.DISCORD_APP_ID}/${body.token}`;

    try {
      // Appel interne à notre propre endpoint d'analyse (évite de redupliquer la logique)
      const base = process.env.VERCEL_URL
        ? `https://${process.env.VERCEL_URL}`
        : 'https://trustroyale.vercel.app';
      const apiResp = await fetch(
        `${base}/api/player/${encodeURIComponent(tag)}/analysis`,
        { headers: { Accept: 'application/json' } },
      );

      if (!apiResp.ok) {
        const msg = apiResp.status === 404
          ? `Joueur \`${tag}\` introuvable.`
          : `Erreur API (${apiResp.status}).`;
        await fetch(webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: msg, flags: 64 }),
        });
        return;
      }

      const analysis = await apiResp.json();
      const score = analysis.warScore ?? analysis.reliability;
      const { total, maxScore, pct, color, verdict } = score;
      const emoji  = EMOJI_MAP[color]  ?? '⚪';
      const embedColor = COLOR_MAP[color] ?? 0x808080;

      const wh = analysis.warHistory;
      const donations = analysis.activityIndicators?.donations ?? 0;
      const stability = wh ? `${wh.streakInCurrentClan} sem. dans ce clan` : 'N/A';
      const avgFame   = wh ? `${wh.avgFame.toLocaleString('fr-FR')} fame/sem.` : 'N/A';

      const embed = {
        title: `${emoji} ${analysis.overview.name} — ${verdict}`,
        url: `https://trustroyale.vercel.app/?mode=player&tag=${encodeURIComponent(tag)}`,
        color: embedColor,
        description: `**${total} / ${maxScore} pts (${pct} %)**`,
        fields: [
          { name: 'Fame moyen', value: avgFame, inline: true },
          { name: 'Stabilité',  value: stability, inline: true },
          { name: 'Dons',       value: `${donations}`, inline: true },
        ],
        footer: { text: `Tag : ${tag}` },
      };

      await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ embeds: [embed] }),
      });
    } catch (err) {
      await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: `Erreur lors de l'analyse : ${err.message}`,
          flags: 64,
        }),
      });
    }
    return;
  }

  return res.status(400).json({ error: 'Unsupported interaction type' });
}
