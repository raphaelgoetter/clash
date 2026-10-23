// Commandes d'administration et de liaison de comptes : /help,
// /discord-link, /blacklist, /discord-check.
//
// Routage extrait de api/discord/interactions.js : chaque bloc répond à
// Discord via `res` s'il reconnaît l'interaction, sinon la fonction rend
// la main sans rien envoyer et le routeur essaie le module suivant.

import {
  getDiscordLinks,
  setDiscordLinks,
} from "../../../backend/services/discordLinks.js";
import { handleBlacklistCommand } from "../_handlers/blacklist.js";
import { runBackground, buildDiscordWebhookUrl } from "../_lib/commun.js";

export async function routeAdmin(body, res) {
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
            "## Commandes joueur\n\n" +
            "**Stats**\n" +
            "Commande : `/stats tag:#TAG`\n" +
            "Usage : affiche les statistiques GDC détaillées d'un membre de la famille\n\n" +
            "**Matchup GDC**\n" +
            "Commande : `/matchup-gdc tag:#TAG`\n" +
            "Usage : calcule le matchup GDC d'un joueur (decks regroupés par jour de GDC)\n\n" +
            "**Matchup**\n" +
            "Commande : `/matchup tag:#TAG`\n" +
            "Usage : affiche les 6 derniers combats d'un joueur, tous types confondus (GDC, Ladder, Amical, Challenge...)\n\n" +
            "**Combats**\n" +
            "Commande : `/combats tag:#TAG`\n" +
            "Usage : affiche le suivi jour par jour des combats de GDC d'un joueur (semaine en cours + précédente)\n\n" +
            "**Collection**\n" +
            "Commande : `/collection tag:#TAG`\n" +
            "Usage : statistiques de collection (cartes, niveaux, évolutions, héros, niveau de collection)\n\n" +
            "**Discord Link**\n" +
            "Commande : `/discord-link tag:#TAG [tag2] [tag3]`\n" +
            "Usage : lie ton tag Clash à Discord (à faire par un membre)\n\n" +
            "**Discord Check**\n" +
            "Commande : `/discord-check clan:N`\n" +
            "Usage : vérifie la présence Discord des membres d'un clan\n\n" +
            // Commandes des jeux : listées ici tant qu'elles sont servies par
            // ce bot (sans bot des jeux configuré, cf. registerCommands.js).
            (process.env.DISCORD_JEUX_APP_ID
              ? ""
              : "**Frame**\n" +
                "Commande : `/frame`\n" +
                "Usage : affiche tes scores au jeu Frame (devine le film) — manche en cours, historique de la saison, total\n\n" +
                "**Anagram**\n" +
                "Commande : `/anagram`\n" +
                "Usage : affiche tes scores au jeu Anagram (devine la carte) — manche en cours, historique de la saison, total\n\n") +
            "## Commandes clan\n\n" +
            "**Trust Clan**\n" +
            "Commande : `/trust-clan clan:N`\n" +
            "Usage : liste les membres risqués du clan\n\n" +
            "**Late**\n" +
            "Commande : `/late clan:N`\n" +
            "Usage : liste les retardataires GDC actuels (à faire avant reset)\n\n" +
            "**Promote**\n" +
            "Commande : `/promote clan:N`\n" +
            "Usage : liste les joueurs ≥ 2600 pts semaine précédente\n\n" +
            "**Demote**\n" +
            "Commande : `/demote clan:N`\n" +
            "Usage : liste les joueurs n'ayant pas joué 16/16 decks (semaine précédente)\n\n" +
            "**Fail**\n" +
            "Commande : `/fail clan:N`\n" +
            "Usage : affiche les joueurs qui ont manqué une journée de GDC hier\n\n" +
            "**Top Players**\n" +
            "Commande : `/top-players number:[3|5|10] period:[week|season|all-time]`\n" +
            "Usage : meilleurs joueurs de toute la famille (semaine, saison précédente ou tous les temps)\n\n" +
            "**Chelem**\n" +
            "Commande : `/chelem clan:N [season:X]`\n" +
            "Usage : joueurs ayant fait 16/16 decks toutes semaines d'une saison entière\n\n" +
            "**Family**\n" +
            "Commande : `/family`\n" +
            "Usage : affiche un résumé des clans de la famille\n\n" +
            "**Clan**\n" +
            "Commande : `/clan clan:N|tag:#TAG`\n" +
            "Usage : affiche la fiche récapitulative d'un clan (famille ou tag libre)\n\n" +
            "**Stats Clan**\n" +
            "Commande : `/stats-clan clan:N`\n" +
            "Usage : statistiques GDC détaillées de tous les membres, avec boutons pour changer le tri\n\n" +
            "**Recap**\n" +
            "Commande : `/recap saison:-1`\n" +
            "Usage : récap GDC de la saison passée — 10 moins bons scoreurs de La Resistance, " +
            "10 meilleurs de Les Resistants. Option `saison` : -1 (défaut) ou -2\n\n" +
            "**Compare**\n" +
            "Commande : `/compare clan:N`\n" +
            "Usage : compare les 5 clans du groupe GDC\n\n" +
            "**Top Clans**\n" +
            "Commande : `/top-clans [start:N]`\n" +
            "Usage : affiche 30 clans du classement France GDC à partir du rang N (défaut : 1)\n\n" +
            "**Historique Champions**\n" +
            "Commande : `/champion-history clan:CLAN`\n" +
            "Usage : historique des champions GDC passés",
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
          await import("@clash/clash-royale/clashApi.js");
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

        // HSET atomique : n'écrase pas les liens des autres joueurs, pas
        // besoin de lire l'état existant au préalable.
        const newLinks = {};
        for (const { tag } of success) {
          newLinks[tag] = discordUserId;
        }
        const ok = await setDiscordLinks(newLinks);

        const lines = [];
        for (const { tag, player } of success) {
          lines.push(`✅ Lié à **${player.name}** (\`${tag}\`).`);
        }
        for (const { tag } of failed) {
          lines.push(`❌ Tag \`${tag}\` introuvable — ignoré.`);
        }
        if (!ok)
          lines.push("⚠️ Sauvegarde échouée — contacte un admin.");

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

  // Commande /blacklist (réservée au staff, vérifié en arrière-plan car la
  // résolution des noms de rôles nécessite un appel à l'API Discord)
  if (body.type === 2 && body.data?.name === "blacklist") {
    res.status(200).json({ type: 5, data: { flags: 64 } });
    const webhookUrl = buildDiscordWebhookUrl(body);
    runBackground(() => handleBlacklistCommand(webhookUrl, body));
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
          await import("@clash/clash-royale/clashApi.js");
        const [clanMembers, links] = await Promise.all([
          fetchClanMembers(`#${resolved.tag}`),
          getDiscordLinks(),
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
}
