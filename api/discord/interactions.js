// Fonction Vercel dédiée pour les interactions Discord.
// Utilise waitUntil de @vercel/functions pour maintenir la fonction active
// après avoir répondu type:5 à Discord (deferred).
import { createPublicKey, verify } from 'node:crypto';
import { waitUntil } from '@vercel/functions';

// Maintient la fonction Vercel active le temps de l'exécution asynchrone.
function runBackground(fn) {
  waitUntil(fn());
}

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
  'Donations': 'Dons totaux',
  'Regularity': 'Régularité',
  'Avg Score': 'Score moyen',
  'Stability': 'Stabilité',
  // fallback: other labels can be added if needed
};
function breakdownField(item) {
  const icon = criterionIcon(item.score, item.max);
  let label = LABEL_FR[item.label] || item.label;
  if (item.label === 'Discord') label = `Discord (${item.score > 0 ? 'oui' : 'non'})`;
  return { name: `${icon} ${label}`, value: `${item.score}/${item.max}`, inline: true };
}

// simple utility used by promote handler
function capitalize(str) {
  return str && str.length ? str[0].toUpperCase() + str.slice(1) : '';
}

// Calcule la largeur visuelle d'une chaîne en monospace :
// les symboles Misc, CJK et emoji comptent pour 2 colonnes,
// les caractères ASCII normaux pour 1.
function displayWidth(str) {
  let w = 0;
  for (const ch of str) {
    const cp = ch.codePointAt(0);
    if (
      (cp >= 0x1100 && cp <= 0x115F) ||
      (cp >= 0x2E80 && cp <= 0x9FFF) ||
      (cp >= 0xA000 && cp <= 0xA4CF) ||
      (cp >= 0xAC00 && cp <= 0xD7AF) ||
      (cp >= 0xF900 && cp <= 0xFAFF) ||
      (cp >= 0xFE10 && cp <= 0xFE6F) ||
      (cp >= 0xFF00 && cp <= 0xFF60) ||
      (cp >= 0xFFE0 && cp <= 0xFFE6) ||
      (cp >= 0x1F004 && cp <= 0x1FFFF) ||
      (cp >= 0x2600 && cp <= 0x27BF)   // Misc Symbols : ♠♦♥♣☆ etc.
    ) {
      w += 2;
    } else {
      w += 1;
    }
  }
  return w;
}

// Équivalent de padEnd mais qui tient compte de la largeur visuelle.
function padEndDisplay(str, width) {
  const dw = displayWidth(str);
  return str + ' '.repeat(Math.max(0, width - dw));
}

// ── Discord Links — stockage GitHub ─────────────────────────────────────────
// Les liens Clash tag → Discord user ID sont persistés dans data/discord-links.json
// via l'API GitHub Contents pour survivre aux redéploiements Vercel.

async function readDiscordLinks() {
  const repo  = process.env.GITHUB_REPO;
  const token = process.env.GITHUB_TOKEN;
  if (!repo || !token) return { links: {}, sha: null };
  try {
    const res = await fetch(
      `https://api.github.com/repos/${repo}/contents/data/discord-links.json`,
      { headers: { Authorization: `token ${token}`, Accept: 'application/vnd.github+json' } },
    );
    if (!res.ok) return { links: {}, sha: null };
    const data = await res.json();
    const links = JSON.parse(Buffer.from(data.content, 'base64').toString('utf8'));
    return { links, sha: data.sha };
  } catch {
    return { links: {}, sha: null };
  }
}

async function writeDiscordLinks(links, sha, message) {
  const repo  = process.env.GITHUB_REPO;
  const token = process.env.GITHUB_TOKEN;
  if (!repo || !token || !sha) return false;
  try {
    const res = await fetch(
      `https://api.github.com/repos/${repo}/contents/data/discord-links.json`,
      {
        method: 'PUT',
        headers: {
          Authorization: `token ${token}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          message,
          content: Buffer.from(JSON.stringify(links, null, 2) + '\n').toString('base64'),
          sha,
        }),
      },
    );
    return res.ok;
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

    runBackground(async () => {
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
                      recordSnapshot(clanTag, participants, weekId).catch(() => {});
                    }
                  })
                  .catch(() => {});
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
    });
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

    runBackground(async () => {
      try {
        const { fetchClanMembers } = await import('../../backend/services/clashApi.js');
        const { computeTopPlayers } = await import('../../backend/services/topplayers.js');
        // fetch clan members to get roles
        const members = await fetchClanMembers(`#${clanTag}`);
        const top = await computeTopPlayers(clanTag, members, [min]);
        let players = top.playersByQuota[min] || [];
        players = players.slice().sort((a, b) => b.fame - a.fame);

        let description;
        if (players.length === 0) {
          description = `Aucun joueur n'atteint ${min} fame.`;
        } else {
          // Discord rend tous les caractères en largeur 1 dans les blocs de code
          let maxName = 0;
          for (const p of players) if (p.name.length > maxName) maxName = p.name.length;
          const rows = players.map((p, i) => {
            const num  = String(i + 1).padStart(2);
            const name = p.name.padEnd(maxName);
            const role = capitalize(p.role || 'member');
            return `${num}. ${name}  ${p.fame} fame  [${role}]`;
          });
          description = '```\n' + rows.join('\n') + '\n```';
        }

        const embed = {
          title: `🏅 Semaine de GDC précédente — ${clanName} (≥ ${min} fame)`,
          color: 0x5865f2,
          description,
          footer: { text: `Quota : ${min} · Clan : ${clanName}` },
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
          body: JSON.stringify({ content: `Erreur : ${err.message}`, flags: 64 }),
        });
      }
    });
    return;
  }

  // Commande /trust-clan
  if (body.type === 2 && body.data?.name === 'trust-clan') {
    const clanOpt = body.data.options?.find((o) => o.name === 'clan');
    const clanVal = (clanOpt?.value || '1').toString().trim().toLowerCase();
    const CLAN_MAP = {
      '1': { name: 'La Resistance',  tag: 'Y8JUPC9C' },
      '2': { name: 'Les Resistants', tag: 'LRQP20V9' },
      '3': { name: 'Les Revoltes',   tag: 'QU9UQJRL' },
    };
    const resolved = CLAN_MAP[clanVal] ?? CLAN_MAP['1'];

    res.status(200).json({ type: 5 });
    const webhookUrl = `https://discord.com/api/v10/webhooks/${process.env.DISCORD_APP_ID}/${body.token}`;

    runBackground(async () => {
      try {
        const apiResp = await fetch(
          `https://trustroyale.vercel.app/api/clan/${encodeURIComponent(resolved.tag)}/analysis`,
          { headers: { Accept: 'application/json' } },
        );
        if (!apiResp.ok) {
          await fetch(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: `Erreur API clan (${apiResp.status}).`, flags: 64 }),
          });
          return;
        }
        const analysis = await apiResp.json();
        const members = analysis.members || [];

        const filtered = members
          .filter((m) => m.verdict === 'High risk' || m.verdict === 'Extreme risk')
          .sort((a, b) => {
            // Risque le plus élevé en premier (score le plus bas = plus risqué)
            if (a.activityScore !== b.activityScore) return a.activityScore - b.activityScore;
            // En cas d'égalité, trier par verdict (extrême avant high)
            const severity = { 'Extreme risk': 0, 'High risk': 1 };
            return (severity[a.verdict] || 0) - (severity[b.verdict] || 0);
          });

        if (filtered.length === 0) {
          await fetch(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              content: `✅ Aucun membre en High/Extreme risk trouvé dans ${resolved.name}.`,
              flags: 64,
            }),
          });
          return;
        }

        const VERDICT_EMOJI = { 'Extreme risk': '🔴', 'High risk': '🟠' };
        const clanUrl = `https://trustroyale.vercel.app/?mode=clan&tag=%23${resolved.tag}`;
        const rows = filtered.slice(0, 25).map((m) => {
          const newTag = m.isNew ? ' (new)' : '';
          const role = capitalize(m.role || 'member');
          const emoji = VERDICT_EMOJI[m.verdict] ?? '⚠️';
          const pct = Math.round(m.activityScore ?? 0);
          const verdict = (m.verdict || '').replace(/\s*risk$/i, '');
          const playerUrl = `https://trustroyale.vercel.app/?mode=player&tag=${encodeURIComponent(m.tag)}`;
          return `- [${m.name}](${playerUrl})${newTag} ${m.tag} [${role}] ${emoji} ${verdict} (${pct}%)`;
        });

        const description = rows.join('\n') + (filtered.length > 25 ? `\n...and ${filtered.length - 25} more` : '');

        const embed = {
          title: `⚠️  ${resolved.name} (${filtered.length} joueurs à risque)`,
          url: clanUrl,
          color: 0xe67e22,
          description,
          footer: { text: `Clan : ${resolved.name}` },
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
          body: JSON.stringify({ content: `Erreur : ${err.message}`, flags: 64 }),
        });
      }
    });
    return;
  }

  // Commande /chelem
  if (body.type === 2 && body.data?.name === 'chelem') {
    const clanOpt = body.data.options?.find((o) => o.name === 'clan');
    const seasonOpt = body.data.options?.find((o) => o.name === 'season');

    const clanVal = (clanOpt?.value || '1').toString().trim().toLowerCase();
    const CLAN_MAP = {
      '1': { name: 'La Resistance',  tag: 'Y8JUPC9C' },
      '2': { name: 'Les Resistants', tag: 'LRQP20V9' },
      '3': { name: 'Les Revoltes',   tag: 'QU9UQJRL' },
    };
    const resolved = CLAN_MAP[clanVal] ?? CLAN_MAP['1'];

    const requestedSeason = seasonOpt && !Number.isNaN(parseInt(seasonOpt.value, 10))
      ? parseInt(seasonOpt.value, 10)
      : null;

    // Réponse différée obligatoire (sinon Discord timeout)
    res.status(200).json({ type: 5 });
    const webhookUrl = `https://discord.com/api/v10/webhooks/${process.env.DISCORD_APP_ID}/${body.token}`;

    runBackground(async () => {
      try {
        const { fetchRaceLog, fetchClanMembers } = await import('../../backend/services/clashApi.js');
        const raceLog = await fetchRaceLog(`#${resolved.tag}`);
        if (!Array.isArray(raceLog) || raceLog.length === 0) {
          await fetch(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: 'Impossible de récupérer le race log du clan.', flags: 64 }),
          });
          return;
        }

        // Saison précédente = la plus récente saison ayant 4 semaines complètes dans le log.
        // Une saison en cours n'a pas encore ses 4 semaines → elle est ignorée.
        const seasonCounts = {};
        for (const r of raceLog) {
          seasonCounts[r.seasonId] = (seasonCounts[r.seasonId] || 0) + 1;
        }
        const sortedSeasons = Object.keys(seasonCounts).map(Number).sort((a, b) => b - a);
        const defaultSeason = sortedSeasons.find((sid) => seasonCounts[sid] >= 4) ?? sortedSeasons[0];

        const seasonId = requestedSeason ?? defaultSeason;
        if (!seasonId) {
          await fetch(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: 'Impossible de déterminer la saison cible.', flags: 64 }),
          });
          return;
        }

        const weeks = raceLog.filter((r) => r.seasonId === seasonId);
        if (weeks.length === 0) {
          await fetch(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: `Aucune donnée trouvée pour la saison ${seasonId}.`, flags: 64 }),
          });
          return;
        }

        const fullSets = weeks.map((w) => {
          const standing = (w.standings || []).find((s) =>
            s.clan?.tag?.toUpperCase() === `#${resolved.tag}`
          );
          const participants = standing?.clan?.participants ?? [];
          return new Set(
            participants
              .filter((p) => (p.decksUsed ?? 0) >= 16)
              .map((p) => p.tag.toUpperCase()),
          );
        });

        const intersection = fullSets.reduce((acc, set) => {
          if (!acc) return set;
          return new Set([...acc].filter((t) => set.has(t)));
        }, null);

        const fullTags = intersection ? [...intersection] : [];

        // Noms depuis le raceLog en priorité (couvre les joueurs qui ont quitté le clan depuis).
        // On parcourt toutes les semaines de la saison ciblée pour construire le dictionnaire.
        const nameFromLog = {};
        for (const w of weeks) {
          const standing = (w.standings || []).find((s) =>
            s.clan?.tag?.toUpperCase() === `#${resolved.tag}`
          );
          for (const p of standing?.clan?.participants ?? []) {
            if (p.tag && p.name) nameFromLog[p.tag.toUpperCase()] = p.name;
          }
        }

        const clanMembers = await fetchClanMembers(`#${resolved.tag}`);
        const memberByTag = Object.fromEntries(clanMembers.map((m) => [m.tag.toUpperCase(), m]));

        const ROLE_FR = { leader: 'Leader', coLeader: 'Co-leader', elder: 'Aîné', member: 'Membre' };

        const players = fullTags
          .map((tag) => {
            const m = memberByTag[tag];
            // Nom depuis le raceLog si disponible, sinon depuis le roster actuel
            const name = nameFromLog[tag] ?? m?.name ?? tag;
            const role = m ? (ROLE_FR[m.role] ?? 'Membre') : '(parti)';
            return { tag, name, role };
          })
          .sort((a, b) => a.name.localeCompare(b.name, 'fr', { sensitivity: 'base' }));

        // 16 decks/semaine × nombre de semaines de la saison = decks attendus par joueur
        const decksPerPlayer = weeks.length * 16;

        let description;
        if (players.length === 0) {
          description = `Aucun joueur n'a joué 100% des decks toutes les semaines de la saison ${seasonId}.`;
        } else {
          const rows = players.map((p, idx) => `${String(idx + 1).padStart(2)}. ${p.name} ${p.tag} [${p.role}]`);
          description = '```\n' + rows.join('\n') + '\n```';
        }

        const embed = {
          title: `🏆 ${resolved.name} — saison ${seasonId}`,
          color: 0x5865f2,
          description,
          footer: { text: `${players.length} joueur(s) ont joué 100% des decks (${decksPerPlayer} decks)` },
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
          body: JSON.stringify({ content: `Erreur : ${err.message}`, flags: 64 }),
        });
      }
    });
    return;
  }

  // Commande /discord-link
  if (body.type === 2 && body.data?.name === 'discord-link') {
    const opts = body.data.options ?? [];
    const rawTags = ['tag', 'tag2', 'tag3']
      .map((n) => opts.find((o) => o.name === n)?.value?.trim())
      .filter(Boolean);
    if (rawTags.length === 0) {
      return res.status(200).json({
        type: 4,
        data: { content: 'Veuillez fournir au moins un tag de joueur (ex: `#ABC123`).', flags: 64 },
      });
    }

    // Réponse éphémère différée (visible uniquement par l'utilisateur)
    res.status(200).json({ type: 5, data: { flags: 64 } });
    const webhookUrl = `https://discord.com/api/v10/webhooks/${process.env.DISCORD_APP_ID}/${body.token}`;
    const discordUserId = body.member?.user?.id ?? body.user?.id;
    const tags = rawTags.map((t) => t.startsWith('#') ? t.toUpperCase() : `#${t.toUpperCase()}`);

    runBackground(async () => {
      try {
        const { fetchPlayer } = await import('../../backend/services/clashApi.js');
        // Valider tous les tags en parallèle
        const results = await Promise.all(tags.map(async (tag) => {
          try {
            const player = await fetchPlayer(tag);
            return { tag, player, ok: true };
          } catch {
            return { tag, ok: false };
          }
        }));

        const failed  = results.filter((r) => !r.ok);
        const success = results.filter((r) => r.ok);

        if (failed.length > 0 && success.length === 0) {
          await fetch(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              content: failed.map((r) => `❌ Tag \`${r.tag}\` introuvable dans Clash Royale.`).join('\n'),
              flags: 64,
            }),
          });
          return;
        }

        const { links, sha } = await readDiscordLinks();
        // Ajouter les nouveaux liens (sans supprimer les liens existants de cet utilisateur)
        for (const { tag } of success) {
          links[tag] = discordUserId;
        }

        const tagList = success.map((r) => r.tag).join(', ');
        const ok = await writeDiscordLinks(
          links, sha,
          `discord: lien Discord ${discordUserId} → Clash ${tagList}`,
        );

        const lines = [];
        for (const { tag, player } of success) {
          lines.push(`✅ Lié à **${player.name}** (\`${tag}\`).`);
        }
        for (const { tag } of failed) {
          lines.push(`❌ Tag \`${tag}\` introuvable — ignoré.`);
        }
        if (!ok) lines.push('⚠️ Sauvegarde GitHub échouée — contacte un admin.');

        await fetch(webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: lines.join('\n'), flags: 64 }),
        });
      } catch (err) {
        await fetch(webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: `Erreur : ${err.message}`, flags: 64 }),
        });
      }
    });
    return;
  }

  // Commande /discord-check
  if (body.type === 2 && body.data?.name === 'discord-check') {
    const clanOpt = body.data.options?.find((o) => o.name === 'clan');
    const clanVal = (clanOpt?.value || '1').toString().trim();
    const CLAN_MAP = {
      '1': { name: 'La Resistance',  tag: 'Y8JUPC9C' },
      '2': { name: 'Les Resistants', tag: 'LRQP20V9' },
      '3': { name: 'Les Revoltes',   tag: 'QU9UQJRL' },
    };
    const resolved = CLAN_MAP[clanVal] ?? CLAN_MAP['1'];

    res.status(200).json({ type: 5 });
    const webhookUrl = `https://discord.com/api/v10/webhooks/${process.env.DISCORD_APP_ID}/${body.token}`;

    runBackground(async () => {
      try {
        const { fetchClanMembers } = await import('../../backend/services/clashApi.js');
        const [clanMembers, { links }] = await Promise.all([
          fetchClanMembers(`#${resolved.tag}`),
          readDiscordLinks(),
        ]);

        // Récupère tous les membres du serveur Discord (max 1 000)
        const guildId   = process.env.DISCORD_GUILD_ID;
        const botToken  = process.env.DISCORD_TOKEN;
        const guildRes  = await fetch(
          `https://discord.com/api/v10/guilds/${guildId}/members?limit=1000`,
          { headers: { Authorization: `Bot ${botToken}` } },
        );
        if (!guildRes.ok) {
          const errBody = await guildRes.text();
          throw new Error(`Discord Guild Members API: ${guildRes.status} — ${errBody}`);
        }
        const guildMembers   = await guildRes.json();
        const guildMemberIds = new Set(guildMembers.map((m) => m.user?.id).filter(Boolean));

        const memberById = new Map(guildMembers.map((m) => [m.user?.id, m]));

        const presentByDiscord = new Map();
        const absentByDiscord  = new Map();
        const unlinked = [];

        for (const m of clanMembers) {
          const normTag   = m.tag.startsWith('#') ? m.tag : `#${m.tag}`;
          const discordId = links[normTag];
          if (!discordId) {
            unlinked.push({ clash: m.name, tag: normTag });
            continue;
          }

          const guildMember = memberById.get(discordId);
          const entry = { clash: m.name, tag: normTag };

          if (!guildMember) {
            const list = absentByDiscord.get(discordId) || [];
            list.push(entry);
            absentByDiscord.set(discordId, list);
            continue;
          }

          const user = guildMember.user;
          const displayName = guildMember.nick || user.global_name || user.username || 'unknown';
          const key = `${displayName.startsWith('☆') ? '0' : '1'}:${displayName.toLowerCase()}`;

          const existing = presentByDiscord.get(discordId);
          if (existing) {
            existing.entries.push(entry);
          } else {
            presentByDiscord.set(discordId, { discord: displayName, discordId, key, entries: [entry] });
          }
        }

        const present = Array.from(presentByDiscord.values());
        present.sort((a, b) => a.key.localeCompare(b.key, 'fr', { numeric: true, sensitivity: 'base' }));

        const absent = Array.from(absentByDiscord.values())
          .flat()
          .sort((a, b) => a.clash.localeCompare(b.clash, 'fr', { numeric: true, sensitivity: 'base' }));

        unlinked.sort((a, b) => a.clash.localeCompare(b.clash, 'fr', { numeric: true, sensitivity: 'base' }));

        const lines = [];
        if (present.length) {
          const list = present
            .map((p) => {
              const clashes = p.entries.map((e) => `${e.clash} ${e.tag}`).join(' + ');
              const mention = `<@${p.discordId}>`;
              return `• ${mention} ⤑ ${clashes}`;
            })
            .join('\n');

          lines.push('✅ Liés (présents sur le serveur) :');
          lines.push(list);
        }
        if (absent.length)   lines.push(`❌ **Liés mais absents du serveur** (${absent.length}) : ${absent.map((e) => `${e.clash} ${e.tag}`).join(', ')}`);
        if (unlinked.length) lines.push(`❓ **Non liés** (${unlinked.length}) : ${unlinked.map((e) => e.clash).join(', ')}`);

        const embed = {
          title: `📋 Présence Discord — ${resolved.name}`,
          color: 0x5865f2,
          description: lines.join('\n\n') || 'Aucun membre trouvé.',
          footer: { text: `${clanMembers.length} membres · ${present.length + absent.length} comptes Discord liés` },
        };

        await fetch(webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            embeds: [embed],
            allowed_mentions: { parse: [] },
          }),
        });
      } catch (err) {
        await fetch(webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: `Erreur : ${err.message}`, flags: 64 }),
        });
      }
    });
    return;
  }

  return res.status(400).json({ error: 'Unsupported interaction type' });
}
