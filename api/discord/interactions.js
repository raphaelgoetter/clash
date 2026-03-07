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

  let body;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return res.status(400).end('invalid json');
  }

  // Discord PING — répond avant la vérification de signature (requis pour la validation de l'endpoint)
  if (body.type === 1) {
    return res.status(200).json({ type: 1 });
  }

  // Vérification obligatoire pour toutes les autres interactions
  if (!verifyDiscordSignature(signature, timestamp, rawBody)) {
    return res.status(401).end('invalid request signature');
  }

  // Commande /trust
  if (body.type === 2 && body.data?.name === 'trust') {
    return res.status(200).json({
      type: 4,
      data: { content: '✅ Hello world ! La commande `/trust` fonctionne.' },
    });
  }

  return res.status(400).json({ error: 'Unsupported interaction type' });
}
