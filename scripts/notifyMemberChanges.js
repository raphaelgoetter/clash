// notifyMemberChanges.js
// Détecte les arrivées, départs et changements de rôle de membres dans chaque clan
// en comparant le clan cache persisté (état précédent, ~1h) avec l'état actuel de l'API Clash Royale.
// Doit être exécuté AVANT npm run cache pour que le fichier JSON ne soit pas encore écrasé.
//
// Usage :
//   node scripts/notifyMemberChanges.js           — mode normal (poste sur Discord)
//   node scripts/notifyMemberChanges.js --dry-run — affiche l'embed sans poster
//   DEBUG_NOTIFY_MEMBER_CHANGES=1 node scripts/notifyMemberChanges.js --dry-run — mode debug

import dotenv from "dotenv";
dotenv.config({ path: "./.env" });

import { readFile, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";
import fetch from "node-fetch";
import { fetchClanMembers } from "../backend/services/clashApi.js";
import { getPlayerAnalysis } from "../backend/services/playerAnalysis.js";
import { ALLOWED_CLANS } from "../backend/routes/clan.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(
  __dirname,
  "..",
  "frontend",
  "public",
  "clan-cache",
);

const DISCORD_API = "https://discord.com/api/v10";
const DRY_RUN = process.argv.includes("--dry-run");
const SIMULATE = process.argv.includes("--simulate");
const DEBUG = process.env.DEBUG_NOTIFY_MEMBER_CHANGES === "1";

/**
 * Lit le clan cache persisté pour un tag donné.
 * Retourne null si le fichier est absent (premier run).
 * @param {string} tag
 * @returns {Promise<{ tags: Set<string>, names: Map<string, string> } | null>}
 */
function buildMemberData(members) {
  const tags = new Set();
  const names = new Map();
  const roles = new Map();

  for (const member of members) {
    const tag = member.tag;
    if (!tag) continue;
    tags.add(tag);
    names.set(tag, member.name ?? tag);
    roles.set(tag, String(member.role || "member"));
  }

  return { tags, names, roles };
}

async function readCachedMembers(tag) {
  const filePath = path.join(CACHE_DIR, `${tag}.json`);
  if (!existsSync(filePath)) return null;

  const raw = await readFile(filePath, "utf-8");
  const data = JSON.parse(raw);
  const members = data.members ?? [];
  if (members.length === 0) return null;

  return buildMemberData(members);
}

/**
 * Récupère les membres actuels via l'API Clash Royale.
 * @param {string} tag
 * @returns {Promise<{ tags: Set<string>, names: Map<string, string>, roles: Map<string, string> }>}
 */
async function fetchCurrentMembers(tag) {
  const members = await fetchClanMembers(tag);
  return buildMemberData(members);
}

function debugLog(msg) {
  if (DEBUG) {
    console.log(`[DEBUG] ${msg}`);
  }
}

/**
 * Lit le nom du clan depuis le cache persisté.
 * @param {string} tag
 * @returns {Promise<string>}
 */
const NOTIFIED_FILE = path.join(
  __dirname,
  "..",
  "data",
  "member-notifications.json",
);

async function readClanName(tag) {
  const filePath = path.join(CACHE_DIR, `${tag}.json`);
  if (!existsSync(filePath)) return `#${tag}`;
  const raw = await readFile(filePath, "utf-8");
  const data = JSON.parse(raw);
  return data.clan?.name ?? `#${tag}`;
}

async function readNotifiedChanges() {
  try {
    const raw = await readFile(NOTIFIED_FILE, "utf-8");
    return JSON.parse(raw);
  } catch (_) {
    return {};
  }
}

async function saveNotifiedChanges(data) {
  await writeFile(NOTIFIED_FILE, JSON.stringify(data, null, 2));
}

/**
 * Formate une ligne de membre avec son score de fiabilité.
 * @param {object} m - { tag, name, analysis? }
 * @returns {string}
 */
const RELIABILITY_BADGES = {
  green: "<:relsuccess:1499075446527099032>",
  yellow: "<:relmedium:1499320146559369286>",
  orange: "<:relwarn:1499078423463854122>",
  red: "<:relerror:1499077154066137230>",
};

function formatMemberLine(m) {
  const playerUrl = `https://trustroyale.vercel.app/?mode=player&tag=${encodeURIComponent(m.tag)}`;
  let reliabilityStr = "";

  const scoreObj = m.analysis?.warScore ?? m.analysis?.reliability;
  if (scoreObj) {
    const s = scoreObj;
    const pct = Math.round(s.pct ?? 0);
    let verdict = s.verdict || "";
    let emoji = "⚪";

    if (pct >= 75) {
      emoji = RELIABILITY_BADGES.green;
      verdict = "Fiable";
    } else if (pct >= 61) {
      emoji = RELIABILITY_BADGES.yellow;
      verdict = "Risque";
    } else if (pct >= 31) {
      emoji = RELIABILITY_BADGES.orange;
      verdict = "Élevé";
    } else {
      emoji = RELIABILITY_BADGES.red;
      verdict = "Extrême";
    }

    reliabilityStr = ` · ${emoji} ${verdict} (${pct}%)`;
  }

  return `**[${m.name}](${playerUrl})**${reliabilityStr}`;
}

const ROLE_ORDER = {
  leader: 4,
  coleader: 3,
  coLeader: 3,
  elder: 2,
  member: 1,
};

const ROLE_LABELS = {
  member: "membre",
  elder: "aîné",
  coleader: "chef adjoint",
  coLeader: "chef adjoint",
  leader: "chef",
};

function getRolePriority(role) {
  const normalized = String(role || "member")
    .trim()
    .toLowerCase();
  return ROLE_ORDER[normalized] ?? 0;
}

function formatRole(role) {
  const normalized = String(role || "member")
    .trim()
    .toLowerCase();
  return ROLE_LABELS[normalized] ?? String(role);
}

function formatRoleChangeLine(change) {
  const playerUrl = `https://trustroyale.vercel.app/?mode=player&tag=${encodeURIComponent(change.tag)}`;
  return `**[${change.name}](${playerUrl})** (${formatRole(change.oldRole)} ⇢ ${formatRole(change.newRole)})`;
}

/**
 * Envoie un embed Discord dans le channel configuré pour ce clan.
 * @param {string} tag - tag du clan (sans #)
 * @param {string} clanName
 * @param {Array<{tag: string, name: string, analysis?: object}>} arrivals
 * @param {Array<{tag: string, name: string, analysis?: object}>} departures
 * @param {Array<{tag: string, name: string, oldRole: string, newRole: string}>} promotions
 * @param {Array<{tag: string, name: string, oldRole: string, newRole: string}>} demotions
 */
async function postDiscordEmbed(
  tag,
  clanName,
  arrivals,
  departures,
  promotions,
  demotions,
) {
  const channelId = process.env[`DISCORD_CHANNEL_MEMBERS_${tag}`];
  const token = process.env.DISCORD_TOKEN;

  const hasArrivals = arrivals.length > 0;
  const hasDepartures = departures.length > 0;
  const hasPromotions = promotions.length > 0;
  const hasDemotions = demotions.length > 0;

  // Couleur : vert = arrivées/promotions uniquement, rouge = départs/rétrogradations uniquement, bleu = mixte
  let color;
  if ((hasArrivals || hasPromotions) && !(hasDepartures || hasDemotions))
    color = 0x57f287; // vert
  else if ((hasDepartures || hasDemotions) && !(hasArrivals || hasPromotions))
    color = 0xed4245; // rouge
  else color = 0x5865f2; // bleu

  const fields = [];

  if (arrivals.length > 0) {
    fields.push({
      name: `<:hi:1493849416514277426> Arrivée${arrivals.length > 1 ? "s" : ""} (${arrivals.length})`,
      value: arrivals.map(formatMemberLine).join("\n"),
      inline: false,
    });
  }

  if (departures.length > 0) {
    fields.push({
      name: `<:bye:1493849413901222019> Départ${departures.length > 1 ? "s" : ""} (${departures.length})`,
      value: departures.map(formatMemberLine).join("\n"),
      inline: false,
    });
  }

  if (promotions.length > 0) {
    fields.push({
      name: `<:princesswink:1493700353735262249> Promotions (${promotions.length})`,
      value: promotions.map(formatRoleChangeLine).join("\n"),
      inline: false,
    });
  }

  if (demotions.length > 0) {
    fields.push({
      name: `<:boohoo:1493849412387209357> Rétrogradations (${demotions.length})`,
      value: demotions.map(formatRoleChangeLine).join("\n"),
      inline: false,
    });
  }

  const now = new Date();
  const date = now.toLocaleDateString("fr-FR", { timeZone: "Europe/Paris" }); // JJ/MM/AAAA
  const time = now.toLocaleTimeString("fr-FR", {
    timeZone: "Europe/Paris",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  const embed = {
    title: `<:stats:1499284927894650950> ${clanName} · Nouveautés`,
    color,
    fields,
    footer: { text: `Constat fait le : ${date} ${time}` },
  };

  if (DRY_RUN) {
    console.log(
      `\n[${tag}] ── DRY-RUN ── embed qui serait posté dans le channel ${channelId ?? "(non configuré)"} :`,
    );
    console.log(JSON.stringify({ embeds: [embed] }, null, 2));
    return;
  }

  if (!channelId) {
    console.log(
      `[${tag}] DISCORD_CHANNEL_MEMBERS_${tag} non configuré — notification ignorée.`,
    );
    return;
  }
  if (!token) {
    console.log(`[${tag}] DISCORD_TOKEN non configuré — notification ignorée.`);
    return;
  }

  const res = await fetch(`${DISCORD_API}/channels/${channelId}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bot ${token}`,
    },
    body: JSON.stringify({ embeds: [embed] }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Discord API ${res.status}: ${err}`);
  }

  console.log(
    `[${tag}] Notification envoyée (${arrivals.length} arrivée(s), ${departures.length} départ(s)).`,
  );
}

async function main() {
  // Mode simulation : affiche un embed fictif pour chaque clan sans appel API
  if (SIMULATE) {
    for (const tag of ALLOWED_CLANS) {
      const clanName = await readClanName(tag);
      await postDiscordEmbed(
        tag,
        clanName,
        [
          { tag: "#FAKEARRIVAL1", name: "NouveauMembre" },
          { tag: "#FAKEARRIVAL2", name: "AutreArrivée" },
        ],
        [{ tag: "#FAKEDEPART1", name: "AncienMembre" }],
        [
          {
            tag: "#FAKEPROMO1",
            name: "displaynone",
            oldRole: "member",
            newRole: "elder",
          },
        ],
        [
          {
            tag: "#FAKEREV1",
            name: "slowfall",
            oldRole: "elder",
            newRole: "member",
          },
        ],
      );
    }
    return;
  }

  let hasError = false;
  const notifiedChanges = await readNotifiedChanges();

  for (const tag of ALLOWED_CLANS) {
    try {
      const [cached, current, clanName] = await Promise.all([
        readCachedMembers(tag),
        fetchCurrentMembers(tag),
        readClanName(tag),
      ]);

      if (!cached) {
        console.log(
          `[${tag}] Pas de cache précédent — premier run, diff ignoré.`,
        );
        continue;
      }

      // Fusionner avec les valeurs par défaut pour que les clés promotions/demotions
      // existent même si l'entrée du clan dans le fichier JSON est antérieure à leur ajout.
      const notified = {
        arrivals: [],
        departures: [],
        promotions: [],
        demotions: [],
        ...(notifiedChanges[tag] ?? {}),
      };

      const arrivals = [...current.tags]
        .filter((t) => !cached.tags.has(t))
        .map((t) => ({ tag: t, name: current.names.get(t) ?? t }));

      const departures = [...cached.tags]
        .filter((t) => !current.tags.has(t))
        .map((t) => ({ tag: t, name: cached.names.get(t) ?? t }));

      const roleChanges = [...current.tags]
        .filter((t) => cached.tags.has(t))
        .map((tag) => {
          const oldRole = cached.roles.get(tag) ?? "member";
          const newRole = current.roles.get(tag) ?? "member";
          const name = current.names.get(tag) ?? tag;
          return { tag, name, oldRole, newRole };
        })
        .filter((change) => change.oldRole !== change.newRole);

      const promotions = roleChanges.filter(
        (change) =>
          getRolePriority(change.newRole) > getRolePriority(change.oldRole),
      );
      const demotions = roleChanges.filter(
        (change) =>
          getRolePriority(change.newRole) < getRolePriority(change.oldRole),
      );

      if (DEBUG) {
        debugLog(
          `${tag}: roleChanges=${roleChanges.length} promotions=${promotions.length} demotions=${demotions.length}`,
        );
        for (const change of roleChanges) {
          debugLog(`  ${change.tag} ${change.oldRole} -> ${change.newRole}`);
        }
      }

      // Retirer des notifications déjà envoyées les joueurs qui sont revenus ou dont le changement de rôle a disparu.
      notified.arrivals = notified.arrivals.filter((t) => current.tags.has(t));
      notified.departures = notified.departures.filter(
        (t) => !current.tags.has(t),
      );
      notified.promotions = notified.promotions.filter(
        (t) =>
          current.tags.has(t) &&
          cached.tags.has(t) &&
          current.roles.get(t) !== cached.roles.get(t),
      );
      notified.demotions = notified.demotions.filter(
        (t) =>
          current.tags.has(t) &&
          cached.tags.has(t) &&
          current.roles.get(t) !== cached.roles.get(t),
      );

      const newArrivals = arrivals.filter(
        (a) => !notified.arrivals.includes(a.tag),
      );
      const newDepartures = departures.filter(
        (d) => !notified.departures.includes(d.tag),
      );
      const newPromotions = promotions.filter(
        (p) => !notified.promotions.includes(p.tag),
      );
      const newDemotions = demotions.filter(
        (d) => !notified.demotions.includes(d.tag),
      );

      if (
        newArrivals.length === 0 &&
        newDepartures.length === 0 &&
        newPromotions.length === 0 &&
        newDemotions.length === 0
      ) {
        const nbArrivals = arrivals.length;
        const nbDepartures = departures.length;
        const nbPromotions = promotions.length;
        const nbDemotions = demotions.length;
        if (
          nbArrivals > 0 ||
          nbDepartures > 0 ||
          nbPromotions > 0 ||
          nbDemotions > 0
        ) {
          console.log(
            `[${tag}] Aucun nouveau changement de membres à notifier — mêmes tags/rôles déjà traités.`,
          );
        } else {
          console.log(`[${tag}] Aucun changement de membres.`);
        }
        notifiedChanges[tag] = notified;
        await saveNotifiedChanges(notifiedChanges);
        continue;
      }

      console.log(
        `[${tag}] Changements détectés — ${newArrivals.length} arrivée(s), ${newDepartures.length} départ(s), ${newPromotions.length} promotion(s), ${newDemotions.length} rétrogradation(s) (après dédup).`,
      );

      // En dry-run, on ne récupère pas l'analyse pour ne pas ralentir la vérification.
      if (!DRY_RUN) {
        const allChanges = [
          ...newArrivals,
          ...newDepartures,
          ...newPromotions,
          ...newDemotions,
        ];
        await Promise.all(
          allChanges.map(async (m) => {
            try {
              m.analysis = await getPlayerAnalysis(m.tag);
            } catch (err) {
              console.warn(
                `[${tag}] Impossible de récupérer l'analyse pour ${m.tag}: ${err.message}`,
              );
            }
          }),
        );
      }

      await postDiscordEmbed(
        tag,
        clanName,
        newArrivals,
        newDepartures,
        newPromotions,
        newDemotions,
      );

      if (!DRY_RUN) {
        notified.arrivals = Array.from(
          new Set([...notified.arrivals, ...newArrivals.map((a) => a.tag)]),
        );
        notified.departures = Array.from(
          new Set([...notified.departures, ...newDepartures.map((d) => d.tag)]),
        );
        notified.promotions = Array.from(
          new Set([...notified.promotions, ...newPromotions.map((p) => p.tag)]),
        );
        notified.demotions = Array.from(
          new Set([...notified.demotions, ...newDemotions.map((d) => d.tag)]),
        );
        notifiedChanges[tag] = notified;
        await saveNotifiedChanges(notifiedChanges);
      }
    } catch (err) {
      console.error(`[${tag}] Erreur : ${err.message}`);
      hasError = true;
    }
  }

  // Ne pas faire échouer le workflow pour une erreur de notification
  process.exit(0);
}

main();
