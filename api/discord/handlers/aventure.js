// ============================================================
// aventure.js — Handlers Discord pour l'Aventure interactive
// "Livre dont vous êtes le héros". Embed, boutons de vote, bouton et
// select menu Historique. La publication/suppression quotidienne passe
// uniquement par scripts/postAventure.js (postChapter) — les boutons/
// select menu restent gérés par api/discord/interactions.js.
// ============================================================

import {
  loadHistoire,
  readState,
  writeState,
  recordVote,
  tallyVotes,
  previewNextChapitreId,
  resolveAndAdvance,
  assignJourNumber,
  previewJourNumber,
  writeHistoriqueEntry,
  getHistoriqueEntry,
  listHistorique,
} from "../../../backend/services/aventure.js";

const AVENTURE_COLOR = 0xe74c3c;
const HISTORIQUE_PAGE_SIZE = 25; // limite Discord : 25 options max par select menu

// ── Embed / composants du chapitre du jour ──────────────────────

function buildAventureEmbed(chapitreEntry, jour) {
  return {
    title: chapitreEntry.titre,
    description: chapitreEntry.texte,
    color: AVENTURE_COLOR,
    footer: { text: `Jour ${jour} de l’aventure` },
  };
}

// count vient de tallyVotes(chapitreId), recalculé à chaque affichage
// (publication ET après chaque clic de vote) pour que le compteur affiché
// dans le label du bouton reste toujours exact.
function buildAventureComponents(chapitreId, chapitreEntry, voteCounts) {
  const rows = [];

  if (chapitreEntry.choix?.length) {
    rows.push({
      type: 1,
      components: chapitreEntry.choix.map((c) => ({
        type: 2,
        style: 2,
        label: `${c.label} (${voteCounts[c.id] || 0})`.slice(0, 80),
        ...(c.emoji ? { emoji: { name: c.emoji } } : {}),
        custom_id: `aventure_vote:${chapitreId}:${c.id}`,
      })),
    });
  }

  // Toujours présent, même après la fin de l'histoire (utile pour relire
  // le parcours complet une fois le livre terminé).
  rows.push({
    type: 1,
    components: [
      { type: 2, style: 2, label: "📜 Historique", custom_id: "aventure_historique_open" },
    ],
  });

  return rows;
}

async function buildChapitrePayload(chapitreId, chapitreEntry, jour) {
  const voteCounts = chapitreEntry.choix?.length ? await tallyVotes(chapitreId) : {};
  return {
    embed: buildAventureEmbed(chapitreEntry, jour),
    components: buildAventureComponents(chapitreId, chapitreEntry, voteCounts),
  };
}

// ── Publication quotidienne (appelée uniquement par scripts/postAventure.js) ──

export async function postChapter(channelId, { dryRun = false } = {}) {
  const histoire = await loadHistoire();
  const state = await readState();

  if (state?.termine) {
    return { termine: true };
  }

  const chapitreId = state
    ? (dryRun ? await previewNextChapitreId(state) : (await resolveAndAdvance(state)).nextChapitreId)
    : histoire.debut;

  if (!chapitreId) {
    throw new Error(
      `Aucun vainqueur déterminable pour le chapitre "${state.chapitreId}" : vérifiez ses choix dans histoire.json.`,
    );
  }

  const chapitreEntry = histoire.chapitres[chapitreId];
  if (!chapitreEntry) {
    throw new Error(
      `Chapitre "${chapitreId}" introuvable dans histoire.json (référence prochain_chapitre cassée).`,
    );
  }
  const estFinal = !chapitreEntry.choix?.length;

  if (dryRun) {
    const jour = await previewJourNumber();
    const { embed, components } = await buildChapitrePayload(chapitreId, chapitreEntry, jour);
    return { dryRun: true, chapitreId, chapitreEntry, jour, embed, components, estFinal };
  }

  const token = process.env.DISCORD_TOKEN;
  if (!token) throw new Error("DISCORD_TOKEN manquant.");

  const jour = await assignJourNumber(chapitreId);
  const { embed, components } = await buildChapitrePayload(chapitreId, chapitreEntry, jour);

  // Suppression du message de la veille — seul message actif autorisé dans
  // le salon. Un échec (message déjà supprimé, permission) est loggé mais
  // ne doit jamais bloquer la publication du nouveau chapitre : le bot peut
  // toujours supprimer ses propres messages sans permission particulière.
  if (state?.messageId && state?.channelId) {
    try {
      const delRes = await fetch(
        `https://discord.com/api/v10/channels/${state.channelId}/messages/${state.messageId}`,
        { method: "DELETE", headers: { Authorization: `Bot ${token}` } },
      );
      if (!delRes.ok && delRes.status !== 404) {
        console.warn(
          `[Aventure] Échec suppression du message de la veille (${delRes.status}), publication du nouveau chapitre quand même.`,
        );
      }
    } catch (err) {
      console.warn("[Aventure] Erreur réseau à la suppression du message de la veille:", err.message);
    }
  }

  const res = await fetch(
    `https://discord.com/api/v10/channels/${channelId}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bot ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ embeds: [embed], components }),
    },
  );
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Erreur envoi salon Discord (${res.status}): ${errText}`);
  }
  const message = await res.json();

  await writeState({
    chapitreId,
    channelId,
    messageId: message.id,
    publishedAt: new Date().toISOString(),
    termine: estFinal,
  });

  // Le chapitre final n'a pas de choix à voter, donc jamais résolu par
  // resolveAndAdvance() — on écrit quand même son entrée d'historique
  // (choixGagnantId: null) pour qu'il reste consultable dans le menu.
  if (estFinal) {
    await writeHistoriqueEntry(chapitreId, {
      jour,
      choixGagnantId: null,
      resolvedAt: new Date().toISOString(),
    });
  }

  return { chapitreId, chapitreEntry, jour, message, estFinal };
}

// ── Édition en place (bouton de vote, historique) ────────────────

async function patchOriginal(webhookUrl, payload) {
  if (!webhookUrl) return;
  try {
    await fetch(`${webhookUrl}/messages/@original`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    console.error("[Aventure] Échec PATCH:", err.message);
  }
}

// ── Bouton de vote ────────────────────────────────────────────────
// Édite le message public lui-même (pas de réponse éphémère) : chaque clic
// est une nouvelle interaction avec son propre token, valable pour éditer
// "@original" (le message d'origine du composant) même si ce message est
// vieux de plusieurs heures — voir champion_history_page dans
// interactions.js pour ce même principe.

export async function handleVoteButton(webhookUrl, chapitreId, choixId, discordId) {
  try {
    const state = await readState();
    // Vote hors-jeu (chapitre déjà remplacé, ou histoire terminée) : on ne
    // l'enregistre pas, on réaffiche simplement l'état courant sans erreur
    // bruyante — même principe que la garde state.gameId !== gameId du jeu
    // Frame (handleHintButton).
    if (!state || state.termine || state.chapitreId !== chapitreId) {
      const histoire = await loadHistoire();
      const chapitreEntry = histoire.chapitres[state?.chapitreId];
      if (chapitreEntry) {
        const jour = await assignJourNumber(state.chapitreId);
        const { embed, components } = await buildChapitrePayload(state.chapitreId, chapitreEntry, jour);
        await patchOriginal(webhookUrl, { embeds: [embed], components });
      }
      return;
    }

    await recordVote(chapitreId, discordId, choixId);

    const histoire = await loadHistoire();
    const chapitreEntry = histoire.chapitres[chapitreId];
    const jour = await assignJourNumber(chapitreId);
    const { embed, components } = await buildChapitrePayload(chapitreId, chapitreEntry, jour);
    await patchOriginal(webhookUrl, { embeds: [embed], components });
  } catch (err) {
    console.error("[Aventure] Échec traitement du vote:", err.message);
  }
}

// ── Bouton [📜 Historique] et navigation ─────────────────────────

function buildHistoriqueListEmbed() {
  return {
    title: "📜 Historique de l’aventure",
    description: "Choisis un jour à revivre dans le menu ci-dessous.",
    color: AVENTURE_COLOR,
  };
}

async function buildHistoriqueListComponents(histoire, offset) {
  const { entries, hasMore } = await listHistorique({ limit: HISTORIQUE_PAGE_SIZE, offset });
  if (entries.length === 0) return null;

  const options = entries.map((entry) => {
    const chapitreEntry = histoire.chapitres[entry.chapitreId] || {};
    return {
      label: (chapitreEntry.titre || entry.chapitreId).slice(0, 100),
      description: (chapitreEntry.resume_historique || "").slice(0, 100) || undefined,
      value: entry.chapitreId,
    };
  });

  const rows = [
    {
      type: 1,
      components: [
        {
          type: 3,
          custom_id: `aventure_historique_select:${offset}`,
          placeholder: "Choisis un jour à revivre",
          options,
        },
      ],
    },
  ];

  const pageButtons = [];
  if (offset > 0) {
    pageButtons.push({
      type: 2,
      style: 2,
      label: "↑ Plus récents",
      custom_id: `aventure_historique_page:${Math.max(0, offset - HISTORIQUE_PAGE_SIZE)}`,
    });
  }
  if (hasMore) {
    pageButtons.push({
      type: 2,
      style: 2,
      label: "↓ Plus anciens",
      custom_id: `aventure_historique_page:${offset + HISTORIQUE_PAGE_SIZE}`,
    });
  }
  if (pageButtons.length > 0) {
    rows.push({ type: 1, components: pageButtons });
  }

  return rows;
}

export async function handleHistoriqueOpen(webhookUrl) {
  await handleHistoriquePage(webhookUrl, 0);
}

export async function handleHistoriquePage(webhookUrl, offset) {
  try {
    const histoire = await loadHistoire();
    const components = await buildHistoriqueListComponents(histoire, offset);
    if (!components) {
      await patchOriginal(webhookUrl, {
        content: "Aucun chapitre précédent pour l’instant, reviens demain !",
        embeds: [],
        components: [],
      });
      return;
    }
    await patchOriginal(webhookUrl, { content: "", embeds: [buildHistoriqueListEmbed()], components });
  } catch (err) {
    console.error("[Aventure] Échec affichage historique:", err.message);
  }
}

// ── Sélection d'un chapitre dans le select menu Historique ────────

export async function handleHistoriqueSelect(webhookUrl, body) {
  try {
    const offset = parseInt(body.data?.custom_id?.split(":")[1], 10) || 0;
    const chapitreId = body.data?.values?.[0];
    if (!chapitreId) return;

    const histoire = await loadHistoire();
    const chapitreEntry = histoire.chapitres[chapitreId];
    if (!chapitreEntry) return;

    const historiqueEntry = await getHistoriqueEntry(chapitreId);
    const gagnant = chapitreEntry.choix?.find((c) => c.id === historiqueEntry?.choixGagnantId);

    const lignes = [chapitreEntry.texte, "", "---"];
    if (gagnant) {
      lignes.push(`**Choix retenu ce jour-là :** ${gagnant.emoji ? `${gagnant.emoji} ` : ""}${gagnant.label}`);
    } else {
      lignes.push("**Fin de l’aventure.**");
    }

    const embed = {
      title: chapitreEntry.titre,
      description: lignes.join("\n"),
      color: AVENTURE_COLOR,
    };
    const components = [
      {
        type: 1,
        components: [
          {
            type: 2,
            style: 2,
            label: "◀ Retour à la liste",
            custom_id: `aventure_historique_back:${offset}`,
          },
        ],
      },
    ];

    await patchOriginal(webhookUrl, { content: "", embeds: [embed], components });
  } catch (err) {
    console.error("[Aventure] Échec affichage détail historique:", err.message);
  }
}
