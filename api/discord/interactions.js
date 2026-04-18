// Fonction Vercel dédiée pour les interactions Discord.
// Utilise waitUntil de @vercel/functions pour maintenir la fonction active
// après avoir répondu type:5 à Discord (deferred).
import { createPublicKey, verify } from "node:crypto";
import { waitUntil } from "@vercel/functions";

// Maintient la fonction Vercel active le temps de l'exécution asynchrone.
function runBackground(fn) {
  try {
    if (typeof waitUntil === "function") {
      waitUntil(fn());
    } else {
      // En environnement non-Vercel (dev), on exécute quand même pour éviter le timeout.
      fn().catch((err) => console.error("runBackground fallback error:", err));
    }
  } catch (err) {
    console.error("runBackground error:", err);
    fn().catch((err2) => console.error("runBackground fallback error:", err2));
  }
}

// Vérifie la signature Ed25519 envoyée par Discord.
function verifyDiscordSignature(signature, timestamp, rawBody) {
  const publicKeyHex = process.env.DISCORD_PUBLIC_KEY;
  if (!publicKeyHex || !signature || !timestamp) return false;
  try {
    // Encapsule la clé publique brute dans le format SPKI DER attendu par Node.js
    const spkiPrefix = Buffer.from("302a300506032b6570032100", "hex");
    const pubKeyDer = Buffer.concat([
      spkiPrefix,
      Buffer.from(publicKeyHex, "hex"),
    ]);
    const publicKey = createPublicKey({
      key: pubKeyDer,
      format: "der",
      type: "spki",
    });
    return verify(
      null,
      Buffer.from(timestamp + rawBody),
      publicKey,
      Buffer.from(signature, "hex"),
    );
  } catch {
    return false;
  }
}

const COLOR_MAP = {
  green: 0x2ecc71,
  yellow: 0xf1c40f,
  orange: 0xe67e22,
  red: 0xe74c3c,
};
const EMOJI_MAP = { green: "🟢", yellow: "🟡", orange: "🟠", red: "🔴" };
const TRUST_ROYALE_URL = "https://trustroyale.vercel.app";
const MS_PER_DAY = 24 * 60 * 60 * 1000;

const ROLE_FR = {
  leader: "chef",
  coleader: "chef adjoint",
  coLeader: "chef adjoint",
  elder: "aîné",
  member: "membre",
};

function formatDiscordRole(role) {
  const normalized = String(role || "member")
    .trim()
    .toLowerCase();
  return `(${ROLE_FR[normalized] ?? ROLE_FR.member})`;
}

function parseBattleTimestamp(value) {
  if (!value) return null;
  const d = new Date(value);
  if (!Number.isNaN(d.getTime())) return d;

  // fallback: format 20240315T123456.000Z
  const m = /^(.{8}T.{6}\.\d{3}Z)$/.exec(value);
  if (m) {
    const iso = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T${value.slice(9, 11)}:${value.slice(11, 13)}:${value.slice(13, 15)}.${value.slice(16, 19)}Z`;
    const d2 = new Date(iso);
    if (!Number.isNaN(d2.getTime())) return d2;
  }

  return null;
}

function computeBattlesPerDayFromPlayer(player) {
  if (!player) return 0;
  const battleLog = Array.isArray(player.battleLog) ? player.battleLog : [];

  if (battleLog.length > 0) {
    const times = battleLog
      .map((b) =>
        parseBattleTimestamp(
          b?.battleTime ||
            b?.battleTimeStamp ||
            b?.battle_time ||
            b?.battleTimeStampLocal,
        ),
      )
      .filter((d) => d instanceof Date && !Number.isNaN(d.getTime()))
      .map((d) => d.getTime());

    if (times.length > 0) {
      const min = Math.min(...times);
      const max = Math.max(...times);
      const spanDays = Math.max(1, Math.ceil((max - min + 1) / MS_PER_DAY));
      const totalBattles = Number.isFinite(
        player?.activityIndicators?.totalBattles,
      )
        ? player.activityIndicators.totalBattles
        : battleLog.length;
      return totalBattles > 0
        ? Number((totalBattles / spanDays).toFixed(1))
        : 0;
    }
  }

  const dailyActivity = Array.isArray(player.recentActivity?.dailyActivity)
    ? player.recentActivity.dailyActivity
    : [];
  const dailyTotal = dailyActivity.reduce((sum, d) => sum + (d?.count ?? 0), 0);
  const dailyCount = dailyActivity.length > 0 ? dailyActivity.length : 7;
  return dailyCount > 0 ? Number((dailyTotal / dailyCount).toFixed(1)) : 0;
}

// Icône selon le ratio score/max : ✅ ≥ 75 %, ⚠️ ≥ 40 %, ❌ sinon
function criterionIcon(score, max) {
  const r = max > 0 ? score / max : 0;
  if (r >= 0.75) return "✅";
  if (r >= 0.4) return "⚠️";
  return "❌";
}

// Convertit un critère de breakdown en field Discord (inline)
// et effectue la traduction française des libellés.
const LABEL_FR = {
  "War Activity": "Activité de guerre",
  "Win Rate (War)": "Winrate (guerre)",
  "CW2 Battle Wins": "Victoires CW2",
  "Last Seen": "Connexion",
  "General Activity": "Activité générale",
  Experience: "Expérience",
  Donations: "Dons totaux",
  Regularity: "Régularité",
  "Avg Score": "Score moyen",
  Stability: "Stabilité",
  Points: "Points",
  "Member Reliability": "Fiabilité membre",
  "Historical Win Rate": "Winrate historique",
  // fallback: other labels can be added if needed
};
function breakdownField(item) {
  const icon = criterionIcon(item.score, item.max);
  let label = LABEL_FR[item.label] || item.label;
  if (item.label === "Discord")
    label = `Discord (${item.score > 0 ? "oui" : "non"})`;
  return {
    name: `${icon} ${label}`,
    value: `${item.score}/${item.max}`,
    inline: true,
  };
}

// simple utility used by promote handler
function capitalize(str) {
  return str && str.length ? str[0].toUpperCase() + str.slice(1) : "";
}

// Calcule la largeur visuelle d'une chaîne en monospace :
// les symboles Misc, CJK et emoji comptent pour 2 colonnes,
// les caractères ASCII normaux pour 1.
function displayWidth(str) {
  let w = 0;
  for (const ch of str) {
    const cp = ch.codePointAt(0);
    if (
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0x9fff) ||
      (cp >= 0xa000 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7af) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe10 && cp <= 0xfe6f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x1f004 && cp <= 0x1ffff) ||
      (cp >= 0x2600 && cp <= 0x27bf) // Misc Symbols : ♠♦♥♣☆ etc.
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
  return str + " ".repeat(Math.max(0, width - dw));
}

// ── Discord Links — stockage GitHub ─────────────────────────────────────────
// Les liens Clash tag → Discord user ID sont persistés dans data/discord-links.json
// via l'API GitHub Contents pour survivre aux redéploiements Vercel.

async function readDiscordLinks() {
  const repo = process.env.GITHUB_REPO;
  const token = process.env.GITHUB_TOKEN;
  if (!repo || !token) return { links: {}, sha: null };
  try {
    const res = await fetch(
      `https://api.github.com/repos/${repo}/contents/data/discord-links.json`,
      {
        headers: {
          Authorization: `token ${token}`,
          Accept: "application/vnd.github+json",
        },
      },
    );
    if (!res.ok) return { links: {}, sha: null };
    const data = await res.json();
    const links = JSON.parse(
      Buffer.from(data.content, "base64").toString("utf8"),
    );
    return { links, sha: data.sha };
  } catch {
    return { links: {}, sha: null };
  }
}

async function writeDiscordLinks(links, sha, message) {
  const repo = process.env.GITHUB_REPO;
  const token = process.env.GITHUB_TOKEN;
  if (!repo || !token || !sha) return false;
  try {
    const res = await fetch(
      `https://api.github.com/repos/${repo}/contents/data/discord-links.json`,
      {
        method: "PUT",
        headers: {
          Authorization: `token ${token}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          message,
          content: Buffer.from(JSON.stringify(links, null, 2) + "\n").toString(
            "base64",
          ),
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
  if (req.method !== "POST") return res.status(405).end();

  const signature = req.headers["x-signature-ed25519"];
  const timestamp = req.headers["x-signature-timestamp"];

  // Lecture du corps brut (nécessaire pour vérifier la signature)
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const rawBody = Buffer.concat(chunks).toString("utf8");

  // Vérification de signature obligatoire *avant tout*, y compris pour les PINGs.
  // Discord teste explicitement que le endpoint rejette les requêtes sans signature valide.
  if (!verifyDiscordSignature(signature, timestamp, rawBody)) {
    return res.status(401).end("invalid request signature");
  }

  let body;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return res.status(400).end("invalid json");
  }

  // Discord PING — répond après vérification de signature (requis par Discord pour valider l'endpoint)
  if (body.type === 1) {
    return res.status(200).json({ type: 1 });
  }

  // Vérification de la liste blanche des serveurs autorisés.
  // Effectuée en premier, avant tout traitement métier, pour minimiser le temps d'exécution.
  const authorizedGuilds = (process.env.AUTHORIZED_GUILD_IDS || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);

  if (
    authorizedGuilds.length > 0 &&
    !authorizedGuilds.includes(body.guild_id)
  ) {
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
  if (body.type === 2 && body.data?.name === "trust") {
    const tagOption = body.data.options?.find((o) => o.name === "tag");
    const rawTag = tagOption?.value?.trim();
    if (!rawTag) {
      return res.status(200).json({
        type: 4,
        data: {
          content: "Veuillez fournir un tag de joueur (ex: `#ABC123`).",
          flags: 64,
        },
      });
    }

    // Réponse différée immédiate — satisfait la fenêtre de 3 s de Discord.
    // waitUntil garantit que Vercel maintient la fonction active jusqu'à la fin de l'analyse.
    res.status(200).json({ type: 5 });

    const tag = rawTag.startsWith("#") ? rawTag : `#${rawTag}`;
    const webhookUrl = `https://discord.com/api/v10/webhooks/${process.env.DISCORD_APP_ID}/${body.token}`;

    runBackground(async () => {
      try {
        // Appel interne à notre propre endpoint d'analyse (évite de redupliquer la logique)
        // On utilise l'URL canonique pour éviter les redirections vers une instance froide
        const apiResp = await fetch(
          `https://trustroyale.vercel.app/api/player/${encodeURIComponent(tag)}/analysis`,
          { headers: { Accept: "application/json" } },
        );

        // --- déclencher snapshots pour tous les clans autorisés ---
        // c'est léger (3 appels à RoyaleAPI) et fait gagner un cycle aux visiteurs.
        // Si l'un d'eux échoue, on s'en fiche.
        const [{ ALLOWED_CLANS }, { fetchRaceLog }, { recordSnapshot }] =
          await Promise.all([
            import("../../backend/routes/clan.js"),
            import("../../backend/services/clashApi.js"),
            import("../../backend/services/snapshot.js"),
          ]);
        ALLOWED_CLANS.forEach((clanTag) => {
          fetchRaceLog(clanTag)
            .then((log) => {
              if (Array.isArray(log) && log.length) {
                const standing = log[0].standings.find(
                  (s) => s.clan?.tag?.toUpperCase() === `#${clanTag}`,
                );
                const participants = standing?.clan?.participants || [];
                const weekId = `S${log[0].seasonId}W${log[0].sectionIndex + 1}`;
                recordSnapshot(clanTag, participants, weekId).catch((err) =>
                  console.warn(
                    "[snapshot] recordSnapshot failed for",
                    clanTag,
                    ":",
                    err.message,
                  ),
                );
              }
            })
            .catch((err) =>
              console.warn(
                "[snapshot] fetchRaceLog failed for",
                clanTag,
                ":",
                err.message,
              ),
            );
        });

        if (!apiResp.ok) {
          const msg =
            apiResp.status === 404
              ? `Joueur \`${tag}\` introuvable.`
              : `Erreur API (${apiResp.status}).`;
          await fetch(webhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ content: msg, flags: 64 }),
          });
          return;
        }

        const analysis = await apiResp.json();
        const score = analysis.warScore ?? analysis.reliability;
        const { total, maxScore, pct, color, verdict } = score;
        const emoji = EMOJI_MAP[color] ?? "⚪";
        const embedColor = COLOR_MAP[color] ?? 0x808080;
        // verdict en français
        const FR_VERDICTS = {
          "High reliability": "Fiabilité élevée",
          "Moderate risk": "Risque modéré",
          "High risk": "Risque élevé",
          "Extreme risk": "Risque extrême",
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
        const description =
          `${emoji} ${pct} % (${verdictFr})\n\n` +
          "```\n" +
          rows.join("\n") +
          "\n```";

        const embed = {
          title: `<:interrogation:1493849417520906271> Joueur : ${analysis.overview.name}`,
          url: `https://trustroyale.vercel.app/?mode=player&tag=${encodeURIComponent(tag)}`,
          color: embedColor,
          description,
          footer: { text: `Tag : ${tag}` },
        };

        await fetch(webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ embeds: [embed] }),
        });
      } catch (err) {
        await fetch(webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            content: `Erreur lors de l'analyse : ${err.message}`,
            flags: 64,
          }),
        });
      }
    });
    return;
  }

  // Commande /help
  if (body.type === 2 && body.data?.name === "help") {
    res.status(200).json({ type: 5 });
    const webhookUrl = `https://discord.com/api/v10/webhooks/${process.env.DISCORD_APP_ID}/${body.token}`;

    runBackground(async () => {
      try {
        const embed = {
          title:
            "<:interrogation:1493849417520906271> TrustRoyale — Guide des commandes",
          color: 0x5865f2,
          description:
            "**Trust**\n" +
            "Commande : `/trust tag:#TAG`\n" +
            "Usage : donne le score de fiabilité d'un joueur à partir de son tag\n\n" +
            "**Trust Clan**\n" +
            "Commande : `/trust-clan clan:N`\n" +
            "Usage : liste les membres risqués du clan\n\n" +
            "**Promote**\n" +
            "Commande : `/promote clan:N`\n" +
            "Usage : liste les joueurs ≥ 2600 pts semaine précédente\n\n" +
            "**Demote**\n" +
            "Commande : `/demote clan:N`\n" +
            "Usage : liste les joueurs n'ayant pas joué 16/16 decks (semaine précédente)\n\n" +
            "**Late**\n" +
            "Commande : `/late clan:N`\n" +
            "Usage : liste les retardataires GDC actuels (à faire avant reset)\n\n" +
            "**Compare**\n" +
            "Commande : `/compare clan:N`\n" +
            "Usage : compare les 5 clans du groupe GDC\n\n" +
            "**Chelem**\n" +
            "Commande : `/chelem clan:N [season:X]`\n" +
            "Usage : joueurs ayant fait 16/16 decks toutes semaines d'une saison entière\n\n" +
            "**Top Players**\n" +
            "Commande : `/top-players number:[3|5|10] period:[week|season]`\n" +
            "Usage : meilleurs joueurs de toute la famille (semaine ou saison précédente)\n\n" +
            "**Battles Per Day**\n" +
            "Commande : `/battles-per-day clan:N`\n" +
            "Usage : activités moyennes selon les 30 dernières batailles (Battle log)\n\n" +
            "**Discord Link**\n" +
            "Commande : `/discord-link tag:#TAG [tag2] [tag3]`\n" +
            "Usage : lie ton tag Clash à Discord (à faire par un membre)\n\n" +
            "**Discord Check**\n" +
            "Commande : `/discord-check clan:N`\n" +
            "Usage : vérifie la présence Discord des membres d'un clan\n\n" +
            "**Help**\n" +
            "Commande : `/help`\n" +
            "Usage : affiche cette fenêtre",
        };

        await fetch(webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            embeds: [embed],
            allowed_mentions: { parse: [] },
          }),
        });
      } catch (err) {
        await fetch(webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            content: `Erreur : ${err.message}`,
            flags: 64,
          }),
        });
      }
    });
    return;
  }

  // Commande /promote
  if (body.type === 2 && body.data?.name === "promote") {
    // parse options
    const clanOpt = body.data.options?.find((o) => o.name === "clan");
    const min = 2600;
    let clanVal = (clanOpt?.value || "1").toString().trim().toLowerCase();
    // Résoudre clan de façon synchrone (pas d'await) avant le type:5
    const CLAN_MAP = {
      1: { index: 0, name: "La Resistance", tag: "Y8JUPC9C" },
      la: { index: 0, name: "La Resistance", tag: "Y8JUPC9C" },
      2: { index: 1, name: "Les Resistants", tag: "LRQP20V9" },
      les: { index: 1, name: "Les Resistants", tag: "LRQP20V9" },
      3: { index: 2, name: "Les Revoltes", tag: "QU9UQJRL" },
    };
    const resolved = CLAN_MAP[clanVal] ?? CLAN_MAP["1"];
    const clanName = resolved.name;
    const clanTag = resolved.tag;

    // defer response IMMÉDIATEMENT — avant tout await
    res.status(200).json({ type: 5 });
    const webhookUrl = `https://discord.com/api/v10/webhooks/${process.env.DISCORD_APP_ID}/${body.token}`;

    runBackground(async () => {
      try {
        const { fetchClanMembers } =
          await import("../../backend/services/clashApi.js");
        const { computeTopPlayers } =
          await import("../../backend/services/topplayers.js");
        // fetch clan members to get roles
        const members = await fetchClanMembers(`#${clanTag}`);
        const { fetchRaceLog } =
          await import("../../backend/services/clashApi.js");
        const raceLog = await fetchRaceLog(`#${clanTag}`);
        const top = await computeTopPlayers(clanTag, members, [min], raceLog);
        let players = top.playersByQuota[min] || [];
        players = players.slice().sort((a, b) => b.fame - a.fame);

        // Récupérer éventuellement isNew/isFamilyTransfer via l'analyse de clan pour annoter /promote
        const analysisMap = new Map();
        try {
          const abortCtrl = new AbortController();
          const abortTimer = setTimeout(() => abortCtrl.abort(), 50000);
          const apiResp = await fetch(
            `https://trustroyale.vercel.app/api/clan/${encodeURIComponent(clanTag)}/analysis`,
            {
              headers: { Accept: "application/json" },
              signal: abortCtrl.signal,
            },
          );
          clearTimeout(abortTimer);
          if (apiResp.ok) {
            const analysis = await apiResp.json();
            (analysis.members || []).forEach((m) => {
              if (m?.tag) analysisMap.set((m.tag || "").toUpperCase(), m);
            });
          }
        } catch (err) {
          // ignore, annotations sont facultatives
        }

        // Déduire le weekId depuis le raceLog (première entrée = semaine précédente)
        const { computePrevWeekId } =
          await import("../../backend/services/dateUtils.js");
        const weekId = computePrevWeekId(raceLog) || "S?";

        let description;
        if (players.length === 0) {
          description =
            "Aucun joueur n'a atteint 2600 pts la semaine précédente.";
        } else {
          const rows = players.map((p, idx) => {
            const playerUrl = `https://trustroyale.vercel.app/?mode=player&tag=${encodeURIComponent(p.tag)}`;
            const fameStr = Number.isFinite(p.fame)
              ? p.fame.toLocaleString("fr-FR")
              : "0";
            const normalizedRole = String(p.role || "member")
              .trim()
              .toLowerCase();
            const promotionMarker = normalizedRole === "member" ? "🔼 " : "";
            return `${idx + 1}. [${p.name}](${playerUrl}) · **${fameStr} pts** · ${promotionMarker}${formatDiscordRole(p.role)}`;
          });
          description = rows.join("\n");
        }
        const embed = {
          title: `<:princesswink:1493700353735262249> ${clanName} (scores ≥ ${min} pts)`,
          color: 0x5865f2,
          description,
          footer: {
            text: `Quota : ${min} · Semaine : ${weekId}`,
          },
        };

        await fetch(webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ embeds: [embed] }),
        });
      } catch (err) {
        await fetch(webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            content: `Erreur : ${err.message}`,
            flags: 64,
          }),
        });
      }
    });
    return;
  }

  // Commande /trust-clan
  if (body.type === 2 && body.data?.name === "trust-clan") {
    const clanOpt = body.data.options?.find((o) => o.name === "clan");
    const clanVal = (clanOpt?.value || "1").toString().trim().toLowerCase();
    const CLAN_MAP = {
      1: { name: "La Resistance", tag: "Y8JUPC9C" },
      2: { name: "Les Resistants", tag: "LRQP20V9" },
      3: { name: "Les Revoltes", tag: "QU9UQJRL" },
    };
    const resolved = CLAN_MAP[clanVal] ?? CLAN_MAP["1"];

    res.status(200).json({ type: 5 });
    const webhookUrl = `https://discord.com/api/v10/webhooks/${process.env.DISCORD_APP_ID}/${body.token}`;

    runBackground(async () => {
      try {
        const abortCtrl = new AbortController();
        const abortTimer = setTimeout(() => abortCtrl.abort(), 50000);
        let apiResp;
        try {
          apiResp = await fetch(
            `https://trustroyale.vercel.app/api/clan/${encodeURIComponent(resolved.tag)}/analysis`,
            {
              headers: { Accept: "application/json" },
              signal: abortCtrl.signal,
            },
          );
        } catch (fetchErr) {
          clearTimeout(abortTimer);
          const msg =
            fetchErr.name === "AbortError"
              ? `⏱️ L'analyse du clan a pris trop longtemps. Réessayez dans 30 secondes (le cache est en cours de préchauffage).`
              : `Erreur réseau : ${fetchErr.message}`;
          await fetch(webhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ content: msg, flags: 64 }),
          });
          return;
        }
        clearTimeout(abortTimer);
        if (!apiResp.ok) {
          await fetch(webhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              content: `Erreur API clan (${apiResp.status}). Réessayez dans quelques instants.`,
              flags: 64,
            }),
          });
          return;
        }
        const analysis = await apiResp.json();
        const members = analysis.members || [];

        const filtered = members
          .filter(
            (m) => m.verdict === "High risk" || m.verdict === "Extreme risk",
          )
          .sort((a, b) => {
            // Risque le plus élevé en premier (score le plus bas = plus risqué)
            const scoreA = Number(a.reliability ?? 0);
            const scoreB = Number(b.reliability ?? 0);
            if (scoreA !== scoreB) return scoreA - scoreB;
            // En cas d'égalité, trier par verdict (extrême avant high)
            const severity = { "Extreme risk": 0, "High risk": 1 };
            return (severity[a.verdict] || 0) - (severity[b.verdict] || 0);
          });

        if (filtered.length === 0) {
          await fetch(webhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              content: `✅ Aucun membre avec un risque Élevé/Extrême trouvé dans ${resolved.name}.`,
              flags: 64,
            }),
          });
          return;
        }

        const VERDICT_EMOJI = { "Extreme risk": "🔴", "High risk": "🟠" };
        const VERDICT_LABELFr = {
          "Extreme risk": "Extrême",
          "High risk": "Élevé",
        };
        const clanUrl = `https://trustroyale.vercel.app/?mode=clan&tag=%23${resolved.tag}`;
        const allRows = filtered.map((m) => {
          const newTag = m.isNew ? " 🆕" : "";
          const emoji = VERDICT_EMOJI[m.verdict] ?? "⚠️";
          const pct = Math.round(Number(m.reliability ?? 0));
          const verdictLabel =
            VERDICT_LABELFr[m.verdict] ||
            (m.verdict || "").replace(/\s*risk$/i, "");
          const playerUrl = `https://trustroyale.vercel.app/?mode=player&tag=${encodeURIComponent(m.tag)}`;
          return `- [${m.name}](${playerUrl})${newTag} · ${emoji} ${verdictLabel} (${pct}%)`;
        });

        let description;
        const MAX_ROWS = 80;
        if (allRows.length <= MAX_ROWS) {
          description = allRows.join("\n");
        } else {
          description =
            allRows.slice(0, MAX_ROWS).join("\n") +
            `\n...et ${allRows.length - MAX_ROWS} autres`;
        }

        const weekId =
          analysis.prevWeekId || analysis.clanWarSummary?.weekId || "S?";
        const embed = {
          title: `<:interrogation:1493849417520906271> ${resolved.name} (${filtered.length} risqués)`,
          url: clanUrl,
          color: 0xe67e22,
          description,
        };

        await fetch(webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ embeds: [embed] }),
        });
      } catch (err) {
        await fetch(webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            content: `Erreur : ${err.message}`,
            flags: 64,
          }),
        });
      }
    });
    return;
  }

  // Commande /battles-per-day
  if (body.type === 2 && body.data?.name === "battles-per-day") {
    const clanOpt = body.data.options?.find((o) => o.name === "clan");
    const modeOpt = body.data.options?.find((o) => o.name === "mode");
    const clanVal = (clanOpt?.value || "1").toString().trim().toLowerCase();
    const selectedMode =
      (modeOpt?.value || "top").toString().trim().toLowerCase() === "bottom"
        ? "bottom"
        : "top";

    const CLAN_MAP = {
      1: { name: "La Resistance", tag: "Y8JUPC9C" },
      2: { name: "Les Resistants", tag: "LRQP20V9" },
      3: { name: "Les Revoltes", tag: "QU9UQJRL" },
    };
    const resolved = CLAN_MAP[clanVal] ?? CLAN_MAP["1"];

    res.status(200).json({ type: 5 });
    const webhookUrl = `https://discord.com/api/v10/webhooks/${process.env.DISCORD_APP_ID}/${body.token}`;

    runBackground(async () => {
      try {
        const baseUrl = process.env.VERCEL_URL
          ? `https://${process.env.VERCEL_URL}`
          : process.env.NODE_ENV === "production"
            ? "https://trustroyale.vercel.app"
            : "http://localhost:3000";

        let analysis = null;
        let analysisSource = null;

        try {
          const { buildClanAnalysis } =
            await import("../../backend/routes/clan.js");
          analysis = await buildClanAnalysis(resolved.tag);
          analysisSource = "local";
        } catch (err) {
          console.warn(
            "[battles-per-day] buildClanAnalysis failed, fallback to API:",
            err.message,
          );
          const apiResp = await fetch(
            `${baseUrl}/api/clan/${encodeURIComponent(resolved.tag)}/analysis`,
            { headers: { Accept: "application/json" } },
          );
          if (!apiResp.ok) {
            const bodyText = await apiResp.text().catch(() => "(no body)");
            await fetch(webhookUrl, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                content: `Erreur API clan (${apiResp.status}): ${bodyText}`,
                flags: 64,
              }),
            });
            return;
          }
          analysis = await apiResp.json();
          analysisSource = "http";
        }

        const members = Array.isArray(analysis.members) ? analysis.members : [];

        if (members.length === 0) {
          await fetch(webhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              content: `Aucun membre trouvé pour ${resolved.name}.`,
              flags: 64,
            }),
          });
          return;
        }

        const candidates = members
          .filter((m) => m && m.tag)
          .map((m) => ({ tag: m.tag, name: m.name || m.tag }));

        const limitedCandidates = candidates;

        const { fetchBattleLog } =
          await import("../../backend/services/clashApi.js");
        const BATCH_SIZE = 4;
        const withTimeout = (promise, ms) =>
          Promise.race([
            promise,
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error("timeout")), ms),
            ),
          ]);

        const enriched = [];
        for (let i = 0; i < limitedCandidates.length; i += BATCH_SIZE) {
          const chunk = limitedCandidates.slice(i, i + BATCH_SIZE);
          const results = await Promise.all(
            chunk.map(async (m) => {
              try {
                const tagNormalized = m.tag?.startsWith("#")
                  ? m.tag
                  : `#${m.tag}`;
                const battleLog = await withTimeout(
                  fetchBattleLog(tagNormalized),
                  7000,
                );
                const battlesPerDay = computeBattlesPerDayFromPlayer({
                  battleLog: Array.isArray(battleLog) ? battleLog : [],
                });
                if (battlesPerDay == null || Number.isNaN(battlesPerDay))
                  return null;
                return {
                  tag: tagNormalized,
                  name: m.name,
                  battlesPerDay,
                  playerUrl: `${baseUrl}/?mode=player&tag=${encodeURIComponent(tagNormalized)}`,
                };
              } catch {
                return null;
              }
            }),
          );
          enriched.push(...results.filter(Boolean));
        }

        if (enriched.length === 0) {
          await fetch(webhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              content: `Impossible de récupérer les logs Battle pour ${resolved.name}.`,
              flags: 64,
            }),
          });
          return;
        }

        const sorted = enriched.sort((a, b) => {
          return selectedMode === "bottom"
            ? a.battlesPerDay - b.battlesPerDay
            : b.battlesPerDay - a.battlesPerDay;
        });

        const selectedRows = sorted.slice(0, 25);
        const totalAvg =
          selectedRows.reduce((sum, p) => sum + p.battlesPerDay, 0) /
          selectedRows.length;

        const displayedRows =
          selectedMode === "bottom"
            ? [...selectedRows].reverse()
            : selectedRows;
        const rows = displayedRows.map(
          (p, idx) =>
            `${idx + 1}. [${p.name}](${p.playerUrl}) · ${p.battlesPerDay}`,
        );
        const modeLabel =
          selectedMode === "bottom"
            ? "Bas du classement"
            : "Haut du classement";
        const descriptionHeader = `Mode : ${modeLabel} | ${selectedRows.length} membres (limite 25)\n\n`;
        const description = descriptionHeader + rows.join("\n");

        const embed = {
          title: `Clan : ${resolved.name} · Combats moyens / jour`,
          color: 0x5865f2,
          description,
          footer: {
            text: `Moyenne (liste) : ${totalAvg.toFixed(1)} (n=${sorted.length})`,
          },
        };

        await fetch(webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ embeds: [embed] }),
        });
      } catch (err) {
        await fetch(webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            content: `Erreur : ${err.message}`,
            flags: 64,
          }),
        });
      }
    });
    return;
  }

  // Commande /top-players
  if (body.type === 2 && body.data?.name === "top-players") {
    const numberOpt = body.data.options?.find((o) => o.name === "number");
    const periodOpt = body.data.options?.find((o) => o.name === "period");

    const allowedNumbers = [3, 5, 10];
    const requestedNumber = Number(numberOpt?.value ?? 5) || 5;
    const limit = allowedNumbers.includes(requestedNumber)
      ? requestedNumber
      : 5;
    const period = (periodOpt?.value || "week").toString().toLowerCase();

    res.status(200).json({ type: 5 });
    const webhookUrl = `https://discord.com/api/v10/webhooks/${process.env.DISCORD_APP_ID}/${body.token}`;

    runBackground(async () => {
      try {
        const { fetchRaceLog, fetchClanMembers } =
          await import("../../backend/services/clashApi.js");

        const CLANS = [
          { name: "La Resistance", tag: "Y8JUPC9C" },
          { name: "Les Resistants", tag: "LRQP20V9" },
          { name: "Les Revoltes", tag: "QU9UQJRL" },
        ];

        const allMembers = new Map(); // tag -> { name, role, clan }
        const allTeams = [];

        let currentSeason = null;
        let defaultSeason = null; // determined from first clan race log, same logic as /chelem
        const clanRaceLogs = {};

        const {
          computeCurrentSeasonId,
          computeCurrentWeekId,
          computePrevWeekId,
        } = await import("../../backend/services/dateUtils.js");

        for (const clan of CLANS) {
          const [raceLog, members] = await Promise.all([
            fetchRaceLog(`#${clan.tag}`),
            fetchClanMembers(`#${clan.tag}`),
          ]);

          if (Array.isArray(raceLog) && raceLog.length > 0) {
            clanRaceLogs[clan.tag] = raceLog;

            if (currentSeason === null) {
              currentSeason = computeCurrentSeasonId(null, raceLog);
            }

            if (defaultSeason === null) {
              // Saison par défaut = la plus récente saison TERMINÉE.
              // On exclut la saison active (currentSeason) car elle est encore en cours.
              const localSeasonCounts = {};
              for (const week of raceLog) {
                const sid = week?.seasonId;
                if (sid == null) continue;
                localSeasonCounts[sid] = (localSeasonCounts[sid] || 0) + 1;
              }

              const sortedSeasons = Object.keys(localSeasonCounts)
                .map(Number)
                .sort((a, b) => b - a);
              defaultSeason =
                sortedSeasons.find(
                  (sid) => sid !== currentSeason && localSeasonCounts[sid] >= 4,
                ) ??
                sortedSeasons.find((sid) => sid !== currentSeason) ??
                sortedSeasons[0];
            }

            const lastWeek = raceLog[0];
            const standing = Array.isArray(lastWeek?.standings)
              ? lastWeek.standings.find(
                  (s) => s.clan?.tag?.toUpperCase() === `#${clan.tag}`,
                )
              : null;
            const participants = standing?.clan?.participants ?? [];

            // we will populate `allTeams` after accumulations.

            members.forEach((m) => {
              const normalized = m.tag?.toUpperCase?.() || "";
              if (!normalized) return;
              if (
                !allMembers.has(normalized) ||
                allMembers.get(normalized).clan === "La Resistance"
              ) {
                allMembers.set(normalized, {
                  name: m.name,
                  role: m.role || "member",
                  clan: clan.name,
                });
              }
            });
          }
        }

        // Build record for week mode.
        if (period === "week") {
          for (const clan of CLANS) {
            const raceLog = clanRaceLogs[clan.tag];
            const lastWeek =
              Array.isArray(raceLog) && raceLog.length > 0 ? raceLog[0] : null;
            const standing = Array.isArray(lastWeek?.standings)
              ? lastWeek.standings.find(
                  (s) => s.clan?.tag?.toUpperCase() === `#${clan.tag}`,
                )
              : null;
            const participants = standing?.clan?.participants ?? [];
            for (const p of participants) {
              const tag = p.tag?.toUpperCase?.() || "";
              const role = allMembers.get(tag)?.role || "member";
              allTeams.push({
                tag,
                name: p.name || "",
                clan: clan.name,
                role,
                fame: p.fame || 0,
              });
            }
          }
        }

        let title;
        let footer;
        let players = [];

        if (period === "season") {
          if (defaultSeason == null && currentSeason == null) {
            throw new Error("Impossible de trouver une saison dans les logs.");
          }

          const selectedSeason = defaultSeason;
          if (selectedSeason == null) {
            throw new Error("Impossible de déterminer la saison cible.");
          }

          title = `🏆 <:topplayers:1493708397407899648> Meilleurs joueurs`;
          footer = `😎 Meilleurs joueurs de la saison précédente (S${selectedSeason})`;
          if (currentSeason != null && currentSeason !== selectedSeason) {
            footer += ` (la S${currentSeason} n'est pas terminée)`;
          }

          const seasonTotals = new Map();

          for (const clan of CLANS) {
            const raceLog = clanRaceLogs[clan.tag];
            if (!Array.isArray(raceLog)) continue;
            const weeks = raceLog.filter((w) => w.seasonId === selectedSeason);
            for (const week of weeks) {
              const standing = Array.isArray(week.standings)
                ? week.standings.find(
                    (s) => s.clan?.tag?.toUpperCase() === `#${clan.tag}`,
                  )
                : null;
              const participants = standing?.clan?.participants ?? [];
              for (const p of participants) {
                const tag = p.tag?.toUpperCase?.() || "";
                if (!tag) continue;
                const existing = seasonTotals.get(tag) || {
                  name: p.name || "",
                  fame: 0,
                };
                existing.name = existing.name || p.name || "";
                existing.fame += p.fame || 0;
                existing.clan = allMembers.get(tag)?.clan || clan.name;
                existing.role = allMembers.get(tag)?.role || "member";
                seasonTotals.set(tag, existing);
              }
            }
          }

          const seasonSorted = Array.from(seasonTotals.entries())
            .map(([tag, data]) => ({ tag, ...data }))
            .sort(
              (a, b) =>
                b.fame - a.fame ||
                a.name.localeCompare(b.name, "fr", { sensitivity: "base" }),
            );
          if (seasonSorted.length <= limit) {
            players = seasonSorted;
          } else {
            const cutoffFame = seasonSorted[limit - 1].fame;
            players = seasonSorted.filter((p) => p.fame >= cutoffFame);
          }
        } else {
          title = `<:topplayers:1493708397407899648> Meilleurs joueurs`;
          const weekRef = (function () {
            for (const clan of CLANS) {
              const raceLog = clanRaceLogs[clan.tag];
              const prevWeekId = computePrevWeekId(raceLog);
              if (prevWeekId) return prevWeekId;
            }
            return null;
          })();

          footer = `😎 Meilleurs joueurs de la semaine précédente (${weekRef ?? "S?-W?"})`;

          const weekSorted = allTeams.sort(
            (a, b) =>
              b.fame - a.fame ||
              a.name.localeCompare(b.name, "fr", { sensitivity: "base" }),
          );
          if (weekSorted.length <= limit) {
            players = weekSorted;
          } else {
            const cutoffFame = weekSorted[limit - 1].fame;
            players = weekSorted.filter((p) => p.fame >= cutoffFame);
          }
        }

        if (players.length === 0) {
          await fetch(webhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              content: "Aucun joueur trouvé pour la période demandée.",
              flags: 64,
            }),
          });
          return;
        }

        const rows = players
          .map((p, idx) => {
            const playerUrl = `https://trustroyale.vercel.app/?mode=player&tag=${encodeURIComponent(p.tag)}`;
            const name = p.name || p.tag;
            const clan = p.clan || "?";
            const fame = p.fame || 0;
            const fameStr = fame.toLocaleString("fr-FR");
            return `${idx + 1}. [${name}](${playerUrl}) (${clan})\n**${fameStr} pts**`;
          })
          .join("\n");

        const embed = {
          title,
          color: 0x5865f2,
          description: `Classement familial\n\n${rows}`,
          image: {
            url: `${TRUST_ROYALE_URL}/images/banner1.webp`,
          },
          footer: { text: footer },
        };

        await fetch(webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            embeds: [embed],
            allowed_mentions: { parse: [] },
          }),
        });
      } catch (err) {
        await fetch(webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            content: `Erreur : ${err.message}`,
            flags: 64,
          }),
        });
      }
    });
    return;
  }

  // Commande /demote
  if (body.type === 2 && body.data?.name === "demote") {
    const clanOpt = body.data.options?.find((o) => o.name === "clan");
    const clanVal = (clanOpt?.value || "1").toString().trim().toLowerCase();
    const CLAN_MAP = {
      1: { name: "La Resistance", tag: "Y8JUPC9C" },
      2: { name: "Les Resistants", tag: "LRQP20V9" },
      3: { name: "Les Revoltes", tag: "QU9UQJRL" },
    };
    const resolved = CLAN_MAP[clanVal] ?? CLAN_MAP["1"];

    res.status(200).json({ type: 5 });
    const webhookUrl = `https://discord.com/api/v10/webhooks/${process.env.DISCORD_APP_ID}/${body.token}`;

    runBackground(async () => {
      try {
        const apiUrl = `https://trustroyale.vercel.app/api/clan/${encodeURIComponent(resolved.tag)}/analysis?includeTopPlayers=false&includeUncomplete=true`;
        const apiResp = await fetch(apiUrl);
        if (!apiResp.ok) {
          const msg = `Erreur API : ${apiResp.status}`;
          await fetch(webhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ content: msg, flags: 64 }),
          });
          return;
        }

        const analysis = await apiResp.json();
        const uncompleteAll = analysis.uncomplete?.players || [];
        const uncomplete = uncompleteAll.filter((p) => p.inClan);

        if (uncomplete.length === 0) {
          await fetch(webhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              content: `✅ Aucun joueur en fail 16/16 dans ${resolved.name}.`,
              flags: 64,
            }),
          });
          return;
        }

        const MAX_ROWS = 25;
        const sorted = uncomplete
          .slice()
          .sort((a, b) => a.decks - b.decks || a.name.localeCompare(b.name));

        const rows = sorted.slice(0, MAX_ROWS).map((p, i) => {
          const playerUrl = `https://trustroyale.vercel.app/?mode=player&tag=${encodeURIComponent(p.tag)}`;
          const isNew = p.isNew ? " 🆕" : "";
          const role = formatDiscordRole(p.role);
          return `${i + 1}. [${p.name}](${playerUrl})${isNew} • ${role} • **${p.decks} decks**`;
        });

        let description = `Joueurs n'ayant pas joué 16/16 decks\n${rows.join("\n")}`;
        // Discord limite les embeds à 4096 caractères pour description
        if (description.length > 4090) {
          const trimmed = rows
            .join("\n")
            .slice(0, 4000)
            .split("\n")
            .slice(0, -1)
            .join("\n");
          description = `Joueurs n'ayant pas joué 16/16 decks\n${trimmed}\n...liste tronquée`;
        }
        const clanUrl = `https://trustroyale.vercel.app/?mode=clan&tag=%23${resolved.tag}`;

        const weekId =
          analysis.prevWeekId || analysis.clanWarSummary?.weekId || "S?";
        const embed = {
          title: `<:interrogation:1493849417520906271> ${resolved.name} · Oublis`,
          url: clanUrl,
          color: 0xf1c40f,
          description,
          footer: { text: `Combats non joués · Semaine : ${weekId}` },
        };

        await fetch(webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ embeds: [embed] }),
        });
      } catch (err) {
        await fetch(webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            content: `Erreur : ${err.message}`,
            flags: 64,
          }),
        });
      }
    });
    return;
  }

  // Commande /chelem
  if (body.type === 2 && body.data?.name === "chelem") {
    const clanOpt = body.data.options?.find((o) => o.name === "clan");
    const seasonOpt = body.data.options?.find((o) => o.name === "season");

    const clanVal = (clanOpt?.value || "1").toString().trim().toLowerCase();
    const CLAN_MAP = {
      1: { name: "La Resistance", tag: "Y8JUPC9C" },
      2: { name: "Les Resistants", tag: "LRQP20V9" },
      3: { name: "Les Revoltes", tag: "QU9UQJRL" },
    };
    const resolved = CLAN_MAP[clanVal] ?? CLAN_MAP["1"];

    const requestedSeason =
      seasonOpt && !Number.isNaN(parseInt(seasonOpt.value, 10))
        ? parseInt(seasonOpt.value, 10)
        : null;

    // Réponse différée obligatoire (sinon Discord timeout)
    res.status(200).json({ type: 5 });
    const webhookUrl = `https://discord.com/api/v10/webhooks/${process.env.DISCORD_APP_ID}/${body.token}`;

    runBackground(async () => {
      try {
        const { fetchRaceLog, fetchClanMembers, fetchCurrentRace } =
          await import("../../backend/services/clashApi.js");
        const [raceLog, currentRace] = await Promise.all([
          fetchRaceLog(`#${resolved.tag}`),
          fetchCurrentRace(`#${resolved.tag}`).catch(() => null),
        ]);
        if (!Array.isArray(raceLog) || raceLog.length === 0) {
          await fetch(webhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              content: "Impossible de récupérer le race log du clan.",
              flags: 64,
            }),
          });
          return;
        }

        const { computeCurrentSeasonId } =
          await import("../../backend/services/dateUtils.js");

        // Saison par défaut = la plus récente saison TERMINÉE dans le log.
        // Si toutes les semaines de la saison courante sont déjà dans le raceLog (>= 4),
        // c'est que la saison est terminée (ex. Colisée fini) → on peut l'utiliser comme défaut.
        const currentSeasonId = computeCurrentSeasonId(currentRace, raceLog);
        const seasonCounts = {};
        for (const r of raceLog) {
          seasonCounts[r.seasonId] = (seasonCounts[r.seasonId] || 0) + 1;
        }
        const sortedSeasons = Object.keys(seasonCounts)
          .map(Number)
          .sort((a, b) => b - a);
        const currentSeasonIsComplete =
          currentSeasonId && (seasonCounts[currentSeasonId] ?? 0) >= 4;
        const defaultSeason = currentSeasonIsComplete
          ? (sortedSeasons.find((sid) => seasonCounts[sid] >= 4) ??
            sortedSeasons[0])
          : (sortedSeasons.find(
              (sid) => sid !== currentSeasonId && seasonCounts[sid] >= 4,
            ) ??
            sortedSeasons.find((sid) => sid !== currentSeasonId) ??
            sortedSeasons[0]);

        const seasonId = requestedSeason ?? defaultSeason;
        if (!seasonId) {
          await fetch(webhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              content: "Impossible de déterminer la saison cible.",
              flags: 64,
            }),
          });
          return;
        }

        const weeks = raceLog.filter((r) => r.seasonId === seasonId);
        if (weeks.length === 0) {
          await fetch(webhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              content: `Aucune donnée trouvée pour la saison ${seasonId}.`,
              flags: 64,
            }),
          });
          return;
        }

        const fullSets = weeks.map((w) => {
          const standing = (w.standings || []).find(
            (s) => s.clan?.tag?.toUpperCase() === `#${resolved.tag}`,
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
          const standing = (w.standings || []).find(
            (s) => s.clan?.tag?.toUpperCase() === `#${resolved.tag}`,
          );
          for (const p of standing?.clan?.participants ?? []) {
            if (p.tag && p.name) nameFromLog[p.tag.toUpperCase()] = p.name;
          }
        }

        const clanMembers = await fetchClanMembers(`#${resolved.tag}`);
        const memberByTag = Object.fromEntries(
          clanMembers.map((m) => [m.tag.toUpperCase(), m]),
        );

        const players = fullTags
          .map((tag) => {
            const m = memberByTag[tag];
            // Nom depuis le raceLog si disponible, sinon depuis le roster actuel
            const name = nameFromLog[tag] ?? m?.name ?? tag;
            const role = m ? formatDiscordRole(m.role) : "(parti)";
            return { tag, name, role };
          })
          .sort((a, b) =>
            a.name.localeCompare(b.name, "fr", { sensitivity: "base" }),
          );

        // 16 decks/semaine × nombre de semaines de la saison = decks attendus par joueur
        const decksPerPlayer = weeks.length * 16;

        let description;
        if (players.length === 0) {
          description = `Aucun joueur n'a joué 100% des decks toutes les semaines de la saison ${seasonId}.`;
        } else {
          const MAX_ROWS = 80;
          const rows = players.map((p, idx) => {
            const playerUrl = `https://trustroyale.vercel.app/?mode=player&tag=${encodeURIComponent(p.tag)}`;
            return `${idx + 1}. [${p.name}](${playerUrl}) · ${p.role}`;
          });
          const visibleRows = rows.slice(0, MAX_ROWS);
          description = visibleRows.join("\n");
          if (rows.length > MAX_ROWS) {
            description += `\n...et ${rows.length - MAX_ROWS} autres`;
          }
        }

        const embed = {
          title: `<:topplayers:1493708397407899648> ${resolved.name} — saison ${seasonId}`,
          color: 0x5865f2,
          description,
          footer: {
            text: `${players.length} joueur(s) ont joué 100% des decks (${decksPerPlayer} decks)`,
          },
        };

        await fetch(webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ embeds: [embed] }),
        });
      } catch (err) {
        await fetch(webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            content: `Erreur : ${err.message}`,
            flags: 64,
          }),
        });
      }
    });
    return;
  }

  // Commande /discord-link
  if (body.type === 2 && body.data?.name === "discord-link") {
    const opts = body.data.options ?? [];
    const rawTags = ["tag", "tag2", "tag3"]
      .map((n) => opts.find((o) => o.name === n)?.value?.trim())
      .filter(Boolean);
    if (rawTags.length === 0) {
      return res.status(200).json({
        type: 4,
        data: {
          content:
            "Veuillez fournir au moins un tag de joueur (ex: `#ABC123`).",
          flags: 64,
        },
      });
    }

    // Réponse éphémère différée (visible uniquement par l'utilisateur)
    res.status(200).json({ type: 5, data: { flags: 64 } });
    const webhookUrl = `https://discord.com/api/v10/webhooks/${process.env.DISCORD_APP_ID}/${body.token}`;
    const discordUserId = body.member?.user?.id ?? body.user?.id;
    const tags = rawTags.map((t) =>
      t.startsWith("#") ? t.toUpperCase() : `#${t.toUpperCase()}`,
    );

    runBackground(async () => {
      try {
        const { fetchPlayer } =
          await import("../../backend/services/clashApi.js");
        // Valider tous les tags en parallèle
        const results = await Promise.all(
          tags.map(async (tag) => {
            try {
              const player = await fetchPlayer(tag);
              return { tag, player, ok: true };
            } catch {
              return { tag, ok: false };
            }
          }),
        );

        const failed = results.filter((r) => !r.ok);
        const success = results.filter((r) => r.ok);

        if (failed.length > 0 && success.length === 0) {
          await fetch(webhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              content: failed
                .map(
                  (r) => `❌ Tag \`${r.tag}\` introuvable dans Clash Royale.`,
                )
                .join("\n"),
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

        const tagList = success.map((r) => r.tag).join(", ");
        const ok = await writeDiscordLinks(
          links,
          sha,
          `discord: lien Discord ${discordUserId} → Clash ${tagList}`,
        );

        const lines = [];
        for (const { tag, player } of success) {
          lines.push(`✅ Lié à **${player.name}** (\`${tag}\`).`);
        }
        for (const { tag } of failed) {
          lines.push(`❌ Tag \`${tag}\` introuvable — ignoré.`);
        }
        if (!ok)
          lines.push("⚠️ Sauvegarde GitHub échouée — contacte un admin.");

        await fetch(webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: lines.join("\n"), flags: 64 }),
        });
      } catch (err) {
        await fetch(webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            content: `Erreur : ${err.message}`,
            flags: 64,
          }),
        });
      }
    });
    return;
  }

  // Commande /discord-check
  if (body.type === 2 && body.data?.name === "discord-check") {
    const clanOpt = body.data.options?.find((o) => o.name === "clan");
    const clanVal = (clanOpt?.value || "1").toString().trim();
    const CLAN_MAP = {
      1: { name: "La Resistance", tag: "Y8JUPC9C" },
      2: { name: "Les Resistants", tag: "LRQP20V9" },
      3: { name: "Les Revoltes", tag: "QU9UQJRL" },
    };
    const resolved = CLAN_MAP[clanVal] ?? CLAN_MAP["1"];

    res.status(200).json({ type: 5 });
    const webhookUrl = `https://discord.com/api/v10/webhooks/${process.env.DISCORD_APP_ID}/${body.token}`;

    runBackground(async () => {
      try {
        const { fetchClanMembers } =
          await import("../../backend/services/clashApi.js");
        const [clanMembers, { links }] = await Promise.all([
          fetchClanMembers(`#${resolved.tag}`),
          readDiscordLinks(),
        ]);

        // Récupère tous les membres du serveur Discord (max 1 000)
        const guildId = process.env.DISCORD_GUILD_ID;
        const botToken = process.env.DISCORD_TOKEN;
        const guildRes = await fetch(
          `https://discord.com/api/v10/guilds/${guildId}/members?limit=1000`,
          { headers: { Authorization: `Bot ${botToken}` } },
        );
        if (!guildRes.ok) {
          const errBody = await guildRes.text();
          throw new Error(
            `Discord Guild Members API: ${guildRes.status} — ${errBody}`,
          );
        }
        const guildMembers = await guildRes.json();
        const guildMemberIds = new Set(
          guildMembers.map((m) => m.user?.id).filter(Boolean),
        );

        const memberById = new Map(guildMembers.map((m) => [m.user?.id, m]));

        const presentByDiscord = new Map();
        const absentByDiscord = new Map();
        const unlinked = [];

        for (const m of clanMembers) {
          const normTag = m.tag.startsWith("#") ? m.tag : `#${m.tag}`;
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
          const displayName =
            guildMember.nick || user.global_name || user.username || "unknown";
          const key = `${displayName.startsWith("☆") ? "0" : "1"}:${displayName.toLowerCase()}`;

          const existing = presentByDiscord.get(discordId);
          if (existing) {
            existing.entries.push(entry);
          } else {
            presentByDiscord.set(discordId, {
              discord: displayName,
              discordId,
              key,
              entries: [entry],
            });
          }
        }

        const present = Array.from(presentByDiscord.values());
        present.sort((a, b) =>
          a.key.localeCompare(b.key, "fr", {
            numeric: true,
            sensitivity: "base",
          }),
        );

        const absent = Array.from(absentByDiscord.values())
          .flat()
          .sort((a, b) =>
            a.clash.localeCompare(b.clash, "fr", {
              numeric: true,
              sensitivity: "base",
            }),
          );

        unlinked.sort((a, b) =>
          a.clash.localeCompare(b.clash, "fr", {
            numeric: true,
            sensitivity: "base",
          }),
        );

        const lines = [];
        if (present.length) {
          const list = present
            .map((p) => {
              const clashes = p.entries
                .map((e) => `${e.clash} ${e.tag}`)
                .join(" + ");
              const mention = `<@${p.discordId}>`;
              return `• ${mention} ⤑ ${clashes}`;
            })
            .join("\n");

          lines.push("✅ Liés (présents sur le serveur) :");
          lines.push(list);
        }
        if (absent.length)
          lines.push(
            `❌ **Liés mais absents du serveur** (${absent.length}) : ${absent.map((e) => `${e.clash} ${e.tag}`).join(", ")}`,
          );
        if (unlinked.length)
          lines.push(
            `❓ **Non liés** (${unlinked.length}) : ${unlinked.map((e) => e.clash).join(", ")}`,
          );

        const embed = {
          title: `📋 Présence Discord — ${resolved.name}`,
          color: 0x5865f2,
          description: lines.join("\n\n") || "Aucun membre trouvé.",
          footer: {
            text: `${clanMembers.length} membres · ${present.length + absent.length} comptes Discord liés`,
          },
        };

        await fetch(webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            embeds: [embed],
            allowed_mentions: { parse: [] },
          }),
        });
      } catch (err) {
        await fetch(webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            content: `Erreur : ${err.message}`,
            flags: 64,
          }),
        });
      }
    });
    return;
  }

  // Commande /late
  if (body.type === 2 && body.data?.name === "late") {
    const clanOpt = body.data.options?.find((o) => o.name === "clan");
    const clanVal = (clanOpt?.value || "1").toString().trim();
    const CLAN_MAP = {
      1: { name: "La Resistance", tag: "Y8JUPC9C" },
      2: { name: "Les Resistants", tag: "LRQP20V9" },
      3: { name: "Les Revoltes", tag: "QU9UQJRL" },
    };
    const resolved = CLAN_MAP[clanVal] ?? CLAN_MAP["1"];

    res.status(200).json({ type: 5 });
    const webhookUrl = `https://discord.com/api/v10/webhooks/${process.env.DISCORD_APP_ID}/${body.token}`;

    runBackground(async () => {
      // Helper : race une promise contre un timeout
      const withTimeout = (promise, ms, label) =>
        Promise.race([
          promise,
          new Promise((_, reject) =>
            setTimeout(
              () => reject(new Error(`Timeout ${label} (${ms}ms)`)),
              ms,
            ),
          ),
        ]);

      // Envoie systématiquement quelque chose au webhook Discord (évite le freeze "thinking...")
      const sendToWebhook = async (payload) => {
        const r = await fetch(webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (!r.ok) {
          const txt = await r.text().catch(() => "");
          console.error(
            `[/late] webhook Discord HTTP ${r.status}:`,
            txt.slice(0, 300),
          );
        }
      };

      try {
        console.log("[/late] start, clan:", resolved.tag);
        const { fetchCurrentRace, fetchClanMembers } =
          await import("../../backend/services/clashApi.js");
        console.log("[/late] import OK");

        const [race, currentMembers, { links }] = await withTimeout(
          Promise.all([
            fetchCurrentRace(`#${resolved.tag}`),
            fetchClanMembers(`#${resolved.tag}`),
            readDiscordLinks(),
          ]),
          20000,
          "fetch initial",
        );

        const participants = race?.clan?.participants ?? [];

        // Hors journée de GDC : afficher un message explicite et ne rien calculer
        if (race?.periodType !== "warDay") {
          await sendToWebhook({
            content: `<:cards:1493711279121104926> **${resolved.name}** — Aucune journée de GDC en cours (période d'entraînement).`,
          });
          return;
        }

        // Récupération éventuelle des statuts isNew/isFamilyTransfer pour /late
        // Timeout court (10s) car ces annotations sont facultatives — le /late doit
        // impérativement s'exécuter en moins de 60s (limite Vercel, fonction interactions.js).
        const analysisMap = new Map();
        try {
          const abortCtrl = new AbortController();
          const abortTimer = setTimeout(() => abortCtrl.abort(), 10000);
          const apiResp = await fetch(
            `https://trustroyale.vercel.app/api/clan/${encodeURIComponent(resolved.tag)}/analysis`,
            {
              headers: { Accept: "application/json" },
              signal: abortCtrl.signal,
            },
          );
          clearTimeout(abortTimer);
          if (apiResp.ok) {
            const analysis = await apiResp.json();
            (analysis.members || []).forEach((m) => {
              if (m?.tag) analysisMap.set((m.tag || "").toUpperCase(), m);
            });
          }
        } catch (err) {
          // ignore, annotations sont facultatives
        }

        // Seuls les membres actuellement dans le clan (les anciens membres ex-participants sont exclus)
        const currentMemberTags = new Set(currentMembers.map((m) => m.tag));
        const currentMemberByTag = new Map(
          currentMembers.map((m) => [(m.tag || "").toUpperCase(), m]),
        );

        // Joueurs en retard : membres actuels qui n'ont pas encore joué leurs 4 decks du jour
        const late = participants
          .filter(
            (p) => currentMemberTags.has(p.tag) && (p.decksUsedToday ?? 0) < 4,
          )
          .map((p) => ({ ...p, missing: 4 - (p.decksUsedToday ?? 0) }))
          .sort(
            (a, b) =>
              b.missing - a.missing || a.name.localeCompare(b.name, "fr"),
          );

        // Pseudos Discord — timeout 10s, non-bloquant (pings optionnels)
        const guildId = process.env.DISCORD_GUILD_ID;
        const botToken = process.env.DISCORD_TOKEN;
        let guildMembers = [];
        try {
          const guildRes = await withTimeout(
            fetch(
              `https://discord.com/api/v10/guilds/${guildId}/members?limit=1000`,
              { headers: { Authorization: `Bot ${botToken}` } },
            ),
            10000,
            "guild members",
          );
          guildMembers = guildRes.ok ? await guildRes.json() : [];
        } catch {
          // pings Discord optionnels — on continue sans eux
        }
        const memberById = new Map(guildMembers.map((m) => [m.user?.id, m]));

        // Heure de Paris au moment de la commande
        const now = new Date();
        const p = new Date(
          now.toLocaleString("en-US", { timeZone: "Europe/Paris" }),
        );
        const parisTime = `${String(p.getHours()).padStart(2, "0")}h${String(p.getMinutes()).padStart(2, "0")}`;

        const { warResetOffsetMs } =
          await import("../../backend/services/dateUtils.js");
        const resetUtcMs = warResetOffsetMs(resolved.tag);
        const msOfDayUtc =
          now.getUTCHours() * 3600000 + now.getUTCMinutes() * 60000;
        if (msOfDayUtc < resetUtcMs) p.setDate(p.getDate() - 1);
        const WAR_DAY_LABELS = {
          4: "Jeudi (J1)",
          5: "Vendredi (J2)",
          6: "Samedi (J3)",
          0: "Dimanche (J4)",
        };
        const warDayLabel = WAR_DAY_LABELS[p.getDay()] ?? "Jour de GDC";

        // Decks déjà joués aujourd'hui par les membres actuels
        const currentParticipants = participants.filter((p) =>
          currentMemberTags.has(p.tag),
        );
        const totalPlayed = currentParticipants.reduce(
          (sum, pl) => sum + (pl.decksUsedToday ?? 0),
          0,
        );

        // Points du jour uniquement pour GDC classique (warDay).
        // Après le reset (msOfDayUtc >= resetUtcMs) : p.fame est déjà remis à zéro
        // par l'API → on l'utilise directement sans soustraction.
        // Avant le reset : p.fame est cumulatif sur la semaine → on soustrait la fame
        // cumulée du dernier snapshot (veille) pour obtenir uniquement la fame du jour.
        // Pour Colisée, la fame est toujours cumulative → on l'affiche telle quelle.
        const isWarDay = race?.periodType === "warDay";
        const isAfterReset = msOfDayUtc >= resetUtcMs;
        const prevCumulByTag = new Map();
        if (isWarDay && !isAfterReset) {
          const pad2 = (n) => String(n).padStart(2, "0");
          // p a déjà été ajusté (setDate -1) donc correspond au jour GDC courant
          const realDayToday = `${p.getFullYear()}-${pad2(p.getMonth() + 1)}-${pad2(p.getDate())}`;
          try {
            const { readFile: _rf } = await import("fs/promises");
            const { fileURLToPath: _ftu } = await import("url");
            const { default: _path } = await import("path");
            const __fileDir = _path.dirname(_ftu(import.meta.url));
            const snapPath = _path.resolve(
              __fileDir,
              "../../data/snapshots",
              `${resolved.tag}.json`,
            );
            const snapData = JSON.parse(await _rf(snapPath, "utf-8"));
            if (Array.isArray(snapData)) {
              // _cumulFame est cumulatif sur toute la semaine GDC : on prend
              // le dernier snapshot du jour GDC précédent (realDay < realDayToday
              // où realDayToday est la date GDC du jour courant, corrigée pré-reset).
              // Note : l'écart de ~400 pts est inévitable car le snapshot est pris
              // ~37 min avant le reset (pas exactement à 09h54 UTC).
              const allDays = snapData.flatMap((w) => w.days ?? []);
              const prevDay = allDays
                .filter(
                  (d) =>
                    d.realDay &&
                    d.realDay < realDayToday &&
                    d._cumulFame &&
                    Object.keys(d._cumulFame).length > 0,
                )
                .sort((a, b) => b.realDay.localeCompare(a.realDay))[0];
              if (prevDay?._cumulFame) {
                // Vérifier que prevDay est bien le jour calendaire immédiatement avant
                // realDayToday. Sur J1, le dernier snapshot disponible est celui de J4
                // de la semaine précédente → la soustraction serait fausse (elle donnerait
                // ~400 pts au lieu des vrais points J1).
                const realDayTodayMs = new Date(
                  realDayToday + "T00:00:00Z",
                ).getTime();
                const prevDayExpected = new Date(realDayTodayMs - 86400000)
                  .toISOString()
                  .slice(0, 10);
                if (prevDay.realDay === prevDayExpected) {
                  for (const [tag, fame] of Object.entries(
                    prevDay._cumulFame,
                  )) {
                    prevCumulByTag.set(tag, fame ?? 0);
                  }
                }
              }
            }
          } catch (_) {
            // snapshot indisponible — on affichera la fame hebdomadaire (dégradé acceptable)
          }
        }

        const totalFame = currentParticipants.reduce((sum, pl) => {
          const rawFame = pl.fame ?? 0;
          const plTag = pl.tag.startsWith("#") ? pl.tag : `#${pl.tag}`;
          const todayFame =
            isWarDay && !isAfterReset
              ? Math.max(0, rawFame - (prevCumulByTag.get(plTag) ?? 0))
              : rawFame;
          return sum + todayFame;
        }, 0);

        // Decks manquants (pré-calculé)
        const totalMissing = late.reduce((sum, pl) => sum + pl.missing, 0);
        const hideDetails = totalMissing > 100;

        // Attaques bateaux du jour
        const boatAttackers = currentParticipants.filter(
          (pl) => (pl.boatAttacks ?? 0) > 0,
        );
        const totalBoatAttacks = boatAttackers.reduce(
          (sum, pl) => sum + (pl.boatAttacks ?? 0),
          0,
        );
        const boatNames = boatAttackers
          .map((pl) => {
            const plTag = pl.tag.startsWith("#") ? pl.tag : `#${pl.tag}`;
            const playerUrl = `https://trustroyale.vercel.app/?mode=player&tag=${encodeURIComponent(plTag)}`;
            return `[${pl.name}](${playerUrl})`;
          })
          .join(", ");

        // Construction de la liste par groupe
        const lateHeader =
          late.length === 0
            ? `Aucun joueur en retard à ${parisTime}`
            : `- ${late.length} joueur${late.length > 1 ? "s" : ""} en retard à ${parisTime}`;
        const descLines = [
          lateHeader,
          `- ${totalPlayed} deck${totalPlayed > 1 ? "s" : ""} joué${totalPlayed > 1 ? "s" : ""}`,
        ];
        if (late.length > 0) {
          descLines.push(
            `- ${totalMissing} deck${totalMissing > 1 ? "s" : ""} manquant${totalMissing > 1 ? "s" : ""}`,
          );
        }
        if (totalBoatAttacks > 0) {
          descLines.push(
            `- ${totalBoatAttacks} attaque${totalBoatAttacks > 1 ? "s" : ""} bateau (${boatNames})`,
          );
        }

        if (hideDetails) {
          descLines.push(
            "",
            "Pas de liste détaillée car il y a plus de 100 decks manquants",
          );
        } else {
          for (const count of [4, 3, 2, 1]) {
            const group = late.filter((pl) => pl.missing === count);
            if (!group.length) continue;
            descLines.push("");
            descLines.push(`**Manque ${count} deck${count > 1 ? "s" : ""}**`);
            for (const pl of group) {
              const tag = pl.tag.startsWith("#") ? pl.tag : `#${pl.tag}`;
              const playerUrl = `https://trustroyale.vercel.app/?mode=player&tag=${encodeURIComponent(tag)}`;
              const memberInfo = currentMemberByTag.get(tag.toUpperCase());
              const role = (memberInfo?.role || "member").toLowerCase();
              const roleText = formatDiscordRole(role);
              const discordId = links[tag];
              const guildMember = discordId ? memberById.get(discordId) : null;
              const discordPart = guildMember ? ` <@${discordId}>` : "";
              const memberAnalysis = analysisMap.get(tag.toUpperCase()) || {};
              const newTag = memberAnalysis.isNew ? " 🆕" : "";
              descLines.push(
                `• [${pl.name}](${playerUrl})${newTag} ${roleText}${discordPart}`,
              );
            }
          }
        }

        // Discord limite les descriptions d'embed à 4096 caractères
        let description = descLines.join("\n");
        if (description.length > 4000) {
          console.warn(
            "[/late] description trop longue:",
            description.length,
            "chars, troncature",
          );
          description = description.slice(0, 3950) + "\n…*(liste tronquée)*";
        }

        const embed = {
          title: `<:boohoo:1493849412387209357> ${resolved.name}, retardataires de ${warDayLabel}`,
          description,
          color: 0xe67e22,
        };

        console.log(
          "[/late] envoi embed, late:",
          late.length,
          "descLen:",
          description.length,
        );
        await sendToWebhook({
          embeds: [embed],
          allowed_mentions: { parse: [] },
        });
      } catch (err) {
        console.error("[/late] erreur:", err.message);
        await sendToWebhook({ content: `Erreur : ${err.message}`, flags: 64 });
      }
    });
    return;
  }

  // Commande /compare
  if (body.type === 2 && body.data?.name === "compare") {
    const clanOpt = body.data.options?.find((o) => o.name === "clan");
    const clanVal = (clanOpt?.value || "1").toString().trim().toLowerCase();
    const CLAN_MAP = {
      1: { name: "La Resistance", tag: "Y8JUPC9C" },
      2: { name: "Les Resistants", tag: "LRQP20V9" },
      3: { name: "Les Revoltes", tag: "QU9UQJRL" },
    };
    const resolved = CLAN_MAP[clanVal] ?? CLAN_MAP["1"];

    res.status(200).json({ type: 5 });
    const webhookUrl = `https://discord.com/api/v10/webhooks/${process.env.DISCORD_APP_ID}/${body.token}`;

    runBackground(async () => {
      try {
        const apiUrl = `https://trustroyale.vercel.app/api/clan/${resolved.tag}/analysis?includeRaceGroup=true&includeTopPlayers=false&includeUncomplete=false`;
        const apiRes = await fetch(apiUrl);
        if (!apiRes.ok) throw new Error(`API ${apiRes.status}`);
        const data = await apiRes.json();

        const raceGroup = data.raceGroup;
        if (!Array.isArray(raceGroup) || raceGroup.length === 0) {
          await fetch(webhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              content: `Aucun groupe de course trouvé pour **${resolved.name}** (données indisponibles ou phase de préparation).`,
              flags: 64,
            }),
          });
          return;
        }

        const ownTag = `#${resolved.tag}`.toUpperCase();
        const FAMILY_TAGS = new Set(["#Y8JUPC9C", "#LRQP20V9", "#QU9UQJRL"]);

        const isWarPeriod = raceGroup.some((c) => c.projectedFame != null);

        // Trier par projection si GDC active, sinon par lastWarFame décroissant
        const sorted = [...raceGroup].sort((a, b) => {
          if (isWarPeriod) {
            return (b.projectedFame ?? 0) - (a.projectedFame ?? 0);
          }
          return (b.lastWarFame ?? 0) - (a.lastWarFame ?? 0);
        });

        const fmt = (n) =>
          typeof n === "number" ? n.toLocaleString("fr-FR") : "—";

        const rows = sorted.map((clan, idx) => {
          const clanTag = (clan.tag ?? "").toUpperCase();
          const isOwn = clanTag === ownTag;
          const cleanTag = clanTag.replace("#", "");
          const isFamilyMember = FAMILY_TAGS.has(clanTag);
          const url = isFamilyMember
            ? `https://trustroyale.vercel.app/?mode=clan&tag=${encodeURIComponent(clanTag)}`
            : `https://trustroyale.vercel.app/?mode=clan&tag=${encodeURIComponent(clanTag)}`;
          const rank = `**#${idx + 1}**`;
          const nameStr = `**[${clan.name ?? clanTag}](${url})**`;
          const bold = isOwn ? "__" : "";

          const trophies =
            clan.clanWarTrophies != null
              ? `<:trophy2:1493677804733337621> ${fmt(clan.clanWarTrophies)}`
              : "";

          let prevWarStr =
            clan.prevWarFame != null
              ? `<:battle:1493710671244689449> ${fmt(clan.prevWarFame)} (n-2)`
              : "";

          let trend = "";
          if (clan.lastWarFame != null && clan.prevWarFame != null) {
            if (clan.lastWarFame > clan.prevWarFame) trend = " ⬆";
            else if (clan.lastWarFame < clan.prevWarFame) trend = " ⬇";
          }
          let lastWarStr =
            clan.lastWarFame != null
              ? `<:battle:1493710671244689449> **${fmt(clan.lastWarFame)}** (Last)${trend}`
              : "";

          let line1 = `${rank} ${bold}${nameStr}${bold} ${trophies}`.trim();
          let line2 = [prevWarStr, lastWarStr].filter(Boolean).join(" · ");

          let row = `${line1}\n${line2}`;

          // Ajouter indicateurs GDC si disponibles
          if (isWarPeriod && clan.projectedFame != null) {
            const decks = `<:cards:1493711279121104926> ${clan.decksToday != null ? clan.decksToday : "?"} decks`;
            const eff = `<:cible:1493711597682557019> ${clan.ptsPerDeck != null ? clan.ptsPerDeck.toFixed(1) : "?"} pts/d`;
            const proj = `🔮 Proj: **${fmt(Math.round(clan.projectedFame))}**`;
            row += `\n${decks} · ${eff} · ${proj}`;
          }

          return row;
        });

        const footerText = isWarPeriod
          ? `Trié par Projection`
          : `Trié par Total Dernière GDC`;

        const embed = {
          title: `<:trophy2:1493677804733337621> Groupe de GDC — ${resolved.name}`,
          color: 0xe74c3c,
          description: rows.join("\n\n"),
          footer: { text: footerText },
        };

        await fetch(webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            embeds: [embed],
            allowed_mentions: { parse: [] },
          }),
        });
      } catch (err) {
        console.error("[/compare] erreur:", err.message);
        await fetch(webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            content: `Erreur : ${err.message}`,
            flags: 64,
          }),
        });
      }
    });
    return;
  }

  return res.status(400).json({ error: "Unsupported interaction type" });
}
