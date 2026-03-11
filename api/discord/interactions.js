// Fonction Vercel dédiée pour les interactions Discord.
// Utilise waitUntil de @vercel/functions pour exécuter l'appel à l'API
// Clash en arrière-plan APRÈS avoir répondu type:5 à Discord (deferred).
import { createPublicKey, verify } from 'node:crypto';
import { waitUntil } from '@vercel/functions';

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

// Icône selon le ratio score/max : ✅ ≥ 75 %, ⚠️ ≥ 40 %, ❌ sinon
function criterionIcon(score, max) {
  const r = max > 0 ? score / max : 0;
  if (r >= 0.75) return '✅';
  if (r >= 0.4)  return '⚠️';
  return '❌';
}

// Convertit un critère de breakdown en field Discord (inline)
// et effectue la traduction française des libellés.
const LABEL_FR = {
  'War Activity': 'Activité de guerre',
  'Win Rate (War)': 'Winrate (guerre)',
  'CW2 Battle Wins': 'Victoires CW2',
  'Last Seen': 'Dernière connexion',
  'General Activity': 'Activité générale',
  'Experience': 'Expérience',
  'Donations': 'Dons',
  'Regularity': 'Régularité',
  'Avg Score': 'Score moyen',
  'Stability': 'Stabilité',
  // fallback: other labels can be added if needed
};
function breakdownField(item) {
  const icon = criterionIcon(item.score, item.max);
  const label = LABEL_FR[item.label] || item.label;
  return { name: `${icon} ${label}`, value: `${item.score}/${item.max}`, inline: true };
}

// simple utility used by promote handler
function capitalize(str) {
  return str && str.length ? str[0].toUpperCase() + str.slice(1) : '';
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

  // Vérification de la liste blanche des serveurs autorisés.
  // Effectuée en premier, avant tout traitement métier, pour minimiser le temps d'exécution.
  const authorizedGuilds = (process.env.AUTHORIZED_GUILD_IDS || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);

  if (authorizedGuilds.length > 0 && !authorizedGuilds.includes(body.guild_id)) {
    return res.status(200).json({
      type: 4,
      data: {
        content:
          "🚫 Ce serveur n'est pas autorisé à utiliser l'instance officielle de TrustRoyale. Contactez l'administrateur pour enregistrer votre guilde.",
        flags: 64,
      },
    });
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
    // waitUntil garantit que Vercel maintient la fonction active jusqu'à la fin de l'analyse.
    res.status(200).json({ type: 5 });

    const tag = rawTag.startsWith('#') ? rawTag : `#${rawTag}`;
    const webhookUrl = `https://discord.com/api/v10/webhooks/${process.env.DISCORD_APP_ID}/${body.token}`;

    waitUntil((async () => {
      try {
        // Appel interne à notre propre endpoint d'analyse (évite de redupliquer la logique)
        // On utilise l'URL canonique pour éviter les redirections vers une instance froide
        const apiResp = await fetch(
          `https://trustroyale.vercel.app/api/player/${encodeURIComponent(tag)}/analysis`,
          { headers: { Accept: 'application/json' } },
        );

        // --- déclencher snapshots pour tous les clans autorisés ---
        // c'est léger (3 appels à RoyaleAPI) et fait gagner un cycle aux visiteurs.
        // Si l'un d'eux échoue, on s'en fiche.
        import('../../backend/routes/clan.js').then(({ ALLOWED_CLANS }) => {
          import('../../backend/services/clashApi.js').then(({ fetchRaceLog }) => {
            import('../../backend/services/snapshot.js').then(({ recordSnapshot }) => {
              ALLOWED_CLANS.forEach((clanTag) => {
                fetchRaceLog(clanTag)
                  .then((log) => {
                    if (Array.isArray(log) && log.length) {
                      const standing = log[0].standings.find(
                        (s) => s.clan?.tag?.toUpperCase() === `#${clanTag}`
                      );
                      const participants = standing?.clan?.participants || [];
                      const weekId = `S${log[0].seasonId}W${log[0].sectionIndex}`;
                      recordSnapshot(clanTag, participants, weekId).catch(()=>{});
                    }
                  })
                  .catch(()=>{});
              });
            });
          });
        });

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
        const emoji      = EMOJI_MAP[color]  ?? '⚪';
        const embedColor = COLOR_MAP[color] ?? 0x808080;
        // verdict en français
        const FR_VERDICTS = {
          'High reliability': 'Fiabilité élevée',
          'Moderate risk': 'Risque modéré',
          'High risk': 'Risque élevé',
          'Extreme risk': 'Risque extrême',
        };
        const verdictFr = FR_VERDICTS[verdict] || verdict;

        // Grille 2 colonnes : 2 critères inline + 1 spacer invisible = 1 ligne
        const breakdown = score.breakdown ?? [];

        // Table markdown isn't rendered by Discord; instead build a
        // monospaced code block with padded columns so values align nicely.
        const rows = [];
        let maxLabel = 0;
        for (const item of breakdown) {
          const label = LABEL_FR[item.label] || item.label;
          if (label.length > maxLabel) maxLabel = label.length;
        }
        for (const item of breakdown) {
          const icon = criterionIcon(item.score, item.max);
          const label = LABEL_FR[item.label] || item.label;
          const scoreStr = `${item.score}/${item.max}`;
          rows.push(`${icon} ${label.padEnd(maxLabel)} ${scoreStr}`);
        }
        const description = '```\n' + rows.join('\n') + '\n```';

        const embed = {
          title: `${emoji} ${analysis.overview.name} ⤑ ${pct} % (${verdictFr})`,
          url: `https://trustroyale.vercel.app/?mode=player&tag=${encodeURIComponent(tag)}`,
          color: embedColor,
          description,
          footer: { text: `Tag : ${tag}` },
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
    })());
    return;
  }

  // Commande /promote
  if (body.type === 2 && body.data?.name === 'promote') {
    // parse options
    const minOpt = body.data.options?.find((o) => o.name === 'min');
    const clanOpt = body.data.options?.find((o) => o.name === 'clan');
    let min = 2800;
    if (minOpt && !isNaN(parseInt(minOpt.value))) {
      min = parseInt(minOpt.value, 10);
    }
    let clanVal = (clanOpt?.value || '1').toString().trim().toLowerCase();
    // Résoudre clan de façon synchrone (pas d'await) avant le type:5
    const CLAN_MAP = {
      '1': { index: 0, name: 'La Resistance',  tag: 'Y8JUPC9C' },
      'la': { index: 0, name: 'La Resistance', tag: 'Y8JUPC9C' },
      '2': { index: 1, name: 'Les Resistants', tag: 'LRQP20V9' },
      'les': { index: 1, name: 'Les Resistants', tag: 'LRQP20V9' },
      '3': { index: 2, name: 'Les Revoltes',   tag: 'QU9UQJRL' },
    };
    const resolved = CLAN_MAP[clanVal] ?? CLAN_MAP['1'];
    const clanName = resolved.name;
    const clanTag  = resolved.tag;

    // defer response IMMÉDIATEMENT — avant tout await
    res.status(200).json({ type: 5 });
    const webhookUrl = `https://discord.com/api/v10/webhooks/${process.env.DISCORD_APP_ID}/${body.token}`;

    waitUntil((async () => {
      try {
        const { fetchClanMembers } = await import('../../backend/services/clashApi.js');
        const { computeTopPlayers } = await import('../../backend/services/topplayers.js');
        // fetch clan members to get roles
        const members = await fetchClanMembers(`#${clanTag}`);
        const top = await computeTopPlayers(clanTag, members, [min]);
        let players = top.playersByQuota[min] || [];
        players = players.slice().sort((a, b) => b.fame - a.fame);

        let content;
        if (players.length === 0) {
          content = `SEMAINE DE GDC PRÉCÉDENTE :\nAucun joueur ne dépasse ${min} fame pour **${clanName}**.`;
        } else {
          content = `SEMAINE DE GDC PRÉCÉDENTE :\nJoueurs ≥ ${min} fame pour **${clanName}** :\n` +
            players.map(p => {
              const role = p.role ? ` [${capitalize(p.role)}]` : '';
              return `${p.name} (${p.tag}) – ${p.fame} fame${role}`;
            }).join('\n');
        }

        await fetch(webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content }),
        });
      } catch (err) {
        await fetch(webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: `Erreur : ${err.message}`, flags: 64 }),
        });
      }
    })());
    return;
  }

  return res.status(400).json({ error: 'Unsupported interaction type' });
}
