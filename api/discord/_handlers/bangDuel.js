// ============================================================
// bangDuel.js (handler) — Bang! Duel (`/bang`) : un joueur contre le Bot,
// dans un seul message éphémère édité en place à chaque action. Réservé
// au rôle MINI-JEUX (vérifié au lancement). Le Bot joue son tour aussitôt
// que le joueur a fini le sien.
//
// Service : backend/services/bangDuel.js (Redis, une partie par joueur),
// règles : backend/services/bangDuelRules.js.
// ============================================================

import {
  agirDuel,
  loadDuelConfig,
  nouveauDuel,
  readDuel,
  supprimerDuel,
} from "../../../backend/services/bangDuel.js";
import {
  CARTES,
  JOUABLES_DUEL,
  POSITIONS,
  jouer,
  jouerBot,
  piocherClic,
  placer,
  voler,
} from "../../../backend/services/bangDuelRules.js";
import {
  getRoleIdByName,
  MINI_JEUX_ROLE_NAME,
} from "../../../backend/services/discordRoles.js";

const BANG_COLOR = 0xc0392b;
const TRUST_ROYALE_URL = "https://trustroyale.vercel.app";

export async function memberHasMiniJeuxRole(body) {
  const roleId = await getRoleIdByName(MINI_JEUX_ROLE_NAME);
  if (!roleId) return false;
  const roles = body.member?.roles;
  return Array.isArray(roles) && roles.includes(roleId);
}

async function patchOriginal(webhookUrl, payload) {
  if (!webhookUrl) return;
  try {
    await fetch(`${webhookUrl}/messages/@original`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "",
        embeds: [],
        components: [],
        ...payload,
      }),
    });
  } catch (err) {
    console.error("[BangDuel] Échec PATCH:", err.message);
  }
}

// ── Mise en forme ────────────────────────────────────────────────────

function plural(n, mot) {
  return `${n} ${mot}${n > 1 ? "s" : ""}`;
}

function carteLabel(id) {
  return `${CARTES[id].emoji} ${CARTES[id].nom}`;
}

// « 💚 Esprit de guérison · 👺 Gobelin ×2 », dans l'ordre de CARTES.
function formatMain(main) {
  const groupes = Object.keys(CARTES)
    .map((id) => [id, main.filter((c) => c === id).length])
    .filter(([, n]) => n > 0);
  if (!groupes.length) return "aucune carte";
  return groupes
    .map(([id, n]) => `${carteLabel(id)}${n > 1 ? ` ×${n}` : ""}`)
    .join(" · ");
}

function mainImageUrl(main) {
  if (!main?.length) return null;
  return `${TRUST_ROYALE_URL}/api/bang/main?${new URLSearchParams({ c: [...main].sort().join("|") })}`;
}

const EFFETS = {
  sarbacane: "Regarde les 3 premières cartes de la pioche.",
  moine: "Renvoie la prochaine attaque du Bot.",
  fut: "Esquive une pioche (ton tour se termine sans piocher).",
  gang: "Termine ton tour : le Bot devra piocher 2 fois.",
  voleuse: "Regarde la main du Bot et prends-lui une carte.",
  tornade: "Mélange la pioche.",
};

const ERREURS = {
  termine: "La partie est terminée.",
  pasTonTour: "Ce n'est pas ton tour.",
  enAttente: "Cache d'abord le Gobelin explosif dans la pioche.",
  vol: "Choisis d'abord la carte à voler.",
  pioche: "La pioche est vide.",
  plafond: "Tu as joué toutes tes cartes de ce tour.",
  injouable: "Cette carte ne se joue pas.",
  pasEnMain: "Cette carte n'est plus disponible.",
  moineActif: "Ton Moine te protège déjà.",
  pasEnAttente: "Aucun Gobelin explosif à cacher.",
  position: "Emplacement inconnu.",
  pasDeVol: "Aucune carte à voler.",
};

const avertissement = (code) => `⚠️ ${ERREURS[code] || "Action impossible."}`;

// Tour du Bot, raconté au joueur (pioches consécutives regroupées ; carte
// piochée, Moine et emplacement d'un Gobelin explosif restent secrets).
function lignesBot(entrees) {
  const lignes = [];
  let pioches = 0;
  const vider = () => {
    if (pioches) lignes.push(`🃏 Le Bot pioche ${plural(pioches, "carte")}.`);
    pioches = 0;
  };
  for (const e of entrees) {
    if (e.id === "bot" && e.k === "pioche") {
      pioches++;
      continue;
    }
    vider();
    if (e.id === "joueur" && e.k === "renvoi") {
      lignes.push(
        e.vole
          ? `🙏 Ton Moine renvoie la Voleuse du Bot : tu lui prends ${carteLabel(e.vole)} !`
          : "🙏 Ton Moine renvoie la Voleuse du Bot… qui n'a rien à prendre !",
      );
      continue;
    }
    if (e.id !== "bot") continue;
    const textes = {
      sarbacane: () =>
        "🎯 Le Bot scrute la pioche avec son Gobelin à sarbacane…",
      tornade: () =>
        "🌪️ Le Bot déclenche une Tornade : la pioche est mélangée !",
      fut: () =>
        "🛢️ Le Bot se cache dans un Fût à gobelins et esquive une pioche.",
      gang: () =>
        `👊 Le Bot t'envoie son Gang de gobelins : tu devras piocher ${e.n} cartes d'un coup !`,
      voleuse: () => `🦹 La Voleuse du Bot te prend : ${carteLabel(e.carte)} !`,
      voleuseVide: () => "🦹 La Voleuse du Bot ne trouve rien dans ta main.",
      renvoi: () =>
        `🙏 Aïe ! Le Moine du Bot renvoie ta carte (${carteLabel(e.carte)})${e.vole ? ` et te prend ${carteLabel(e.vole)}` : ""}.`,
      sauve: () =>
        "💥 Le Bot pioche un Gobelin explosif… sauvé par son Esprit de guérison !",
      cache: () =>
        "🤫 Le Bot cache le Gobelin explosif quelque part dans la pioche…",
      explose: () => "🚀 **BANG !** Le Bot explose !",
    };
    const texte = textes[e.k]?.();
    if (texte) lignes.push(texte);
  }
  vider();
  return lignes;
}

// Fin du tour du joueur (pioche, Fût ou Gang) : le Bot joue aussitôt.
function tourDuBot(d, config) {
  if (d.termine || d.actif !== "bot") return;
  const avant = d.journal.length;
  jouerBot(d, "bot", { config });
  d.resumeBot = lignesBot(d.journal.slice(avant));
}

// ── Vues ─────────────────────────────────────────────────────────────

function boutonsFin() {
  return [
    {
      type: 1,
      components: [
        {
          type: 2,
          style: 2,
          label: "Règles",
          emoji: { name: "📖" },
          custom_id: "bangduel_regles",
        },
      ],
    },
  ];
}

function vueFin(d, texte) {
  const lignes = [
    ...(texte ? [texte, ""] : []),
    ...(d.resumeBot?.length ? ["**🤖 Tour du Bot**", ...d.resumeBot, ""] : []),
  ];
  const titre =
    d.gagnant === "joueur"
      ? "🏆 Victoire ! Le Bot a explosé."
      : d.gagnant === "bot"
        ? "💀 Défaite… tu as explosé."
        : "🤝 Match nul : personne n'a explosé.";
  return {
    embeds: [
      {
        title: `💣 Bang! Duel · ${titre}`,
        description: lignes.join("\n") || " ",
        color: BANG_COLOR,
      },
    ],
    components: boutonsFin(),
  };
}

// Message de la partie : résultat de la dernière action (`texte`), tour du
// Bot, état de la pioche, main du joueur ; composants selon l'étape
// (placement d'un Gobelin explosif, choix de la Voleuse, tour normal).
function buildVue(d, config, { texte = null } = {}) {
  if (d.termine) return vueFin(d, texte);
  const j = d.joueurs.joueur;
  const bot = d.joueurs.bot;
  const bombes = d.pioche.filter((c) => c === "bombe").length;
  const lignes = [
    ...(texte ? [texte, ""] : []),
    ...(d.resumeBot?.length ? ["**🤖 Tour du Bot**", ...d.resumeBot, ""] : []),
    `🃏 Pioche : **${plural(d.pioche.length, "carte")}**, dont **${bombes}** 💥`,
    `🤖 Le Bot a **${plural(bot.main.length, "carte")}** en main.`,
    ...(j.dette > 1
      ? [`👊 Gang de gobelins : **${j.dette} cartes** à piocher d'un seul clic.`]
      : []),
    ...(j.moine
      ? ["🙏 Ton Moine te protège : la prochaine attaque du Bot sera renvoyée."]
      : []),
    "",
    `Cartes jouées ce tour : **${j.jouees}/${config.cartes_par_tour}**`,
    `**Ta main** : ${formatMain(j.main)}`,
  ];
  const image = mainImageUrl(j.main);
  const embed = {
    title: `💣 Bang! Duel · Tour ${d.tour}/${config.tours_max}`,
    description: lignes.join("\n").slice(0, 4096),
    color: BANG_COLOR,
    ...(image ? { image: { url: image } } : {}),
  };

  if (j.enAttente) {
    return {
      embeds: [embed],
      components: [
        {
          type: 1,
          components: [
            {
              type: 3,
              custom_id: "bangduel_placer",
              placeholder: "Où cacher le Gobelin explosif ?",
              options: Object.entries(POSITIONS).map(([value, label]) => ({
                label,
                value,
              })),
            },
          ],
        },
      ],
    };
  }
  if (j.vol) {
    const options = Object.keys(CARTES)
      .map((id) => [id, bot.main.filter((c) => c === id).length])
      .filter(([, n]) => n > 0)
      .map(([id, n]) => ({
        label: `${CARTES[id].nom}${n > 1 ? ` (×${n})` : ""}`,
        value: id,
        emoji: { name: CARTES[id].emoji },
      }));
    return {
      embeds: [embed],
      components: [
        {
          type: 1,
          components: [
            {
              type: 3,
              custom_id: "bangduel_voler",
              placeholder: "🦹 Quelle carte prendre au Bot ?",
              options,
            },
          ],
        },
      ],
    };
  }

  const components = [
    {
      type: 1,
      components: [
        {
          type: 2,
          style: 1,
          label: d.pioche.length
            ? j.dette > 1
              ? `Piocher ${j.dette} cartes`
              : "Piocher"
            : "Passer (pioche vide)",
          emoji: { name: "🃏" },
          custom_id: "bangduel_piocher",
        },
        {
          type: 2,
          style: 2,
          label: "Règles",
          emoji: { name: "📖" },
          custom_id: "bangduel_regles",
        },
        {
          type: 2,
          style: 4,
          label: "Abandonner",
          custom_id: "bangduel_abandon",
        },
      ],
    },
  ];
  const jouables = JOUABLES_DUEL.filter(
    (c) => j.main.includes(c) && !(c === "moine" && j.moine),
  );
  if (jouables.length && j.jouees < config.cartes_par_tour) {
    components.push({
      type: 1,
      components: [
        {
          type: 3,
          custom_id: "bangduel_carte",
          placeholder: "⚡ Jouer une carte",
          options: jouables.map((c) => {
            const n = j.main.filter((x) => x === c).length;
            return {
              label: `${CARTES[c].nom}${n > 1 ? ` (×${n})` : ""}`,
              value: c,
              emoji: { name: CARTES[c].emoji },
              description: EFFETS[c],
            };
          }),
        },
      ],
    });
  }
  return { embeds: [embed], components };
}

function buildReglesEmbed(config) {
  return {
    title: "📖 Règles — Bang! Duel",
    description: [
      "Fais exploser le Bot avant d'exploser toi-même !",
      "",
      `**🔁 Tour** : tu joues, puis le Bot. ${config.tours_max} tours au plus : si personne n'a explosé, match nul.`,
      `**🃏 À ton tour** : joue d'abord jusqu'à ${config.cartes_par_tour} cartes (ou aucune), puis **Piocher** : une seule carte, et ton tour se termine.`,
      `**🎴 Départ** : chacun reçoit un ${carteLabel("esprit")} et ${plural(config.main_depart, "carte")}. La pioche contient ${plural(config.bombes, "Gobelin explosif")} et ${plural(config.esprits_pioche, "Esprit de guérison")}.`,
      "",
      `${carteLabel("bombe")} : si tu le pioches, ton Esprit de guérison est sacrifié et tu le caches où tu veux dans la pioche. Sans Esprit, tu exploses.`,
      `${carteLabel("sarbacane")} : regarde les 3 premières cartes de la pioche.`,
      `${carteLabel("fut")} : esquive une pioche (ton tour se termine sans piocher, ou une pioche de moins à faire après un Gang).`,
      `${carteLabel("gang")} : termine ton tour sans piocher ; le Bot devra piocher ${config.gang_pioches} cartes.`,
      `${carteLabel("voleuse")} : regarde la main du Bot et prends-lui la carte de ton choix.`,
      `${carteLabel("moine")} : joue-le à l'avance, la prochaine attaque du Bot (Gang, Voleuse) lui est renvoyée.`,
      `${carteLabel("tornade")} : mélange la pioche.`,
      `${carteLabel("gobelin")} : carte purement décorative.`,
      "",
      "⏰ Sans action pendant 2 h, la partie est abandonnée.",
    ].join("\n"),
    color: BANG_COLOR,
  };
}

// ── Lancement (/bang) ────────────────────────────────────────────────

export async function handleBangDuelRoleRejected(webhookUrl) {
  await patchOriginal(webhookUrl, {
    content:
      "Tu n'as pas le rôle nécessaire (MINI-JEUX) pour lancer une partie.",
  });
}

// Reprend la partie en cours, sinon en lance une nouvelle.
export async function handleBangDuelCommand(webhookUrl, discordId) {
  try {
    const config = await loadDuelConfig();
    const enCours = await readDuel(discordId);
    if (enCours && !enCours.termine) {
      await patchOriginal(
        webhookUrl,
        buildVue(enCours, config, {
          texte: "▶️ Reprise de ta partie en cours.",
        }),
      );
      return;
    }
    const { duel } = await nouveauDuel(discordId);
    await patchOriginal(
      webhookUrl,
      buildVue(duel, config, {
        texte: `Nouvelle partie contre le Bot ! Tu commences. Tu as un ${carteLabel("esprit")} et ${plural(config.main_depart, "carte")}.`,
      }),
    );
  } catch (err) {
    console.error("[BangDuel] Échec lancement:", err.message);
  }
}

// ── Composants du message (édition en place) ─────────────────────────

// Action sous verrou : `fn(duel, config)` renvoie { texte?, erreur? } ;
// le Bot joue s'il a la main.
async function executer(webhookUrl, discordId, fn) {
  const { duel, config, resultat } = await agirDuel(discordId, (d, cfg) => {
    const r = fn(d, cfg) || {};
    if (!r.erreur) tourDuBot(d, cfg);
    return r;
  });
  if (!duel) {
    await patchOriginal(webhookUrl, {
      embeds: [
        {
          description:
            "⏰ Aucune partie en cours (abandonnée après 2 h sans action). Relance `/bang` !",
          color: BANG_COLOR,
        },
      ],
      components: boutonsFin(),
    });
    return;
  }
  await patchOriginal(
    webhookUrl,
    buildVue(duel, config, {
      texte: resultat.erreur ? avertissement(resultat.erreur) : resultat.texte,
    }),
  );
}

export async function handleBangDuelPiocher(webhookUrl, discordId) {
  try {
    await executer(webhookUrl, discordId, (d, config) => {
      // Nouvelle action du joueur : le récit du tour du Bot s'efface
      // Pioches dues d'un Gang de gobelins : toutes d'un seul clic
      const r = piocherClic(d, "joueur", { config });
      if (r.erreur) return r;
      d.resumeBot = [];
      if (r.vide && !r.tirages.length)
        return { texte: "🃏 La pioche est vide : ton tour passe." };
      const cartes = r.tirages.filter((t) => !t.bang).map((t) => t.carte);
      const bang = r.tirages.find((t) => t.bang)?.bang;
      const avant = cartes.length
        ? `Tu pioches : **${cartes.map(carteLabel).join("**, **")}**`
        : null;
      if (bang === "elimine")
        return {
          texte: [
            avant,
            "💥 **BANG !** Tu as pioché un Gobelin explosif sans Esprit de guérison.",
          ]
            .filter(Boolean)
            .join("\n"),
        };
      if (bang === "sauve")
        return {
          texte: [
            avant,
            `${carteLabel("bombe")} désamorcé ! Ton Esprit de guérison te sauve : choisis où cacher le Gobelin explosif.`,
          ]
            .filter(Boolean)
            .join("\n"),
        };
      return { texte: avant };
    });
  } catch (err) {
    console.error("[BangDuel] Échec pioche:", err.message);
  }
}

export async function handleBangDuelPlacer(webhookUrl, discordId, position) {
  try {
    await executer(webhookUrl, discordId, (d, config) => {
      const r = placer(d, "joueur", position, { config });
      if (r.erreur) return r;
      return {
        texte: `🤫 Gobelin explosif caché : ${POSITIONS[position].toLowerCase()}.`,
      };
    });
  } catch (err) {
    console.error("[BangDuel] Échec placement:", err.message);
  }
}

export async function handleBangDuelCarte(webhookUrl, discordId, carte) {
  try {
    await executer(webhookUrl, discordId, (d, config) => {
      const r = jouer(d, "joueur", carte, { config });
      if (r.erreur) return r;
      d.resumeBot = [];
      if (r.carte === "sarbacane") {
        const vues = r.revelation.length
          ? r.revelation.map((c, i) => `${i + 1}. ${carteLabel(c)}`).join("\n")
          : "La pioche est vide.";
        return { texte: `🎯 **Sommet de la pioche** :\n${vues}` };
      }
      if (r.carte === "moine")
        return {
          texte:
            "🙏 Ton Moine veille : la prochaine attaque du Bot lui sera renvoyée.",
        };
      if (r.carte === "tornade")
        return { texte: "🌪️ Tornade ! La pioche est mélangée." };
      if (r.carte === "fut")
        return {
          texte: r.finTour
            ? "🛢️ Tu te caches dans un Fût à gobelins : ton tour se termine sans piocher."
            : "🛢️ Tu te caches dans un Fût à gobelins et esquives une des pioches du Gang.",
        };
      if (r.renvoi && r.carte === "gang")
        return {
          texte: `🙏 Aïe ! Le Moine du Bot renvoie ton Gang de gobelins : tu dois piocher ${config.gang_pioches} cartes d'un coup.`,
        };
      if (r.renvoi)
        return {
          texte: `🙏 Aïe ! Le Moine du Bot renvoie ta Voleuse${r.vole ? ` : il te prend ${carteLabel(r.vole)}` : ""}.`,
        };
      if (r.carte === "gang")
        return {
          texte: `👊 Ton Gang de gobelins attend le Bot : il devra piocher ${config.gang_pioches} cartes. Ton tour est terminé.`,
        };
      if (r.choix)
        return {
          texte:
            "🦹 Ta Voleuse fouille la main du Bot : choisis la carte à prendre.",
        };
      return {
        texte: "🦹 Ta Voleuse ne trouve rien : la main du Bot est vide.",
      };
    });
  } catch (err) {
    console.error("[BangDuel] Échec carte:", err.message);
  }
}

export async function handleBangDuelVoler(webhookUrl, discordId, carte) {
  try {
    await executer(webhookUrl, discordId, (d) => {
      const r = voler(d, "joueur", carte);
      if (r.erreur) return r;
      return { texte: `🦹 Tu prends au Bot : **${carteLabel(r.carte)}**` };
    });
  } catch (err) {
    console.error("[BangDuel] Échec Voleuse:", err.message);
  }
}

export async function handleBangDuelAbandon(webhookUrl, discordId) {
  try {
    await supprimerDuel(discordId);
    await patchOriginal(webhookUrl, {
      embeds: [
        {
          title: "💣 Bang! Duel · Partie abandonnée",
          description: "Le Bot l'emporte par forfait.",
          color: BANG_COLOR,
        },
      ],
      components: boutonsFin(),
    });
  } catch (err) {
    console.error("[BangDuel] Échec abandon:", err.message);
  }
}

// [📖 Règles] : nouvel éphémère.
export async function handleBangDuelRegles(webhookUrl) {
  try {
    await patchOriginal(webhookUrl, {
      embeds: [buildReglesEmbed(await loadDuelConfig())],
    });
  } catch (err) {
    console.error("[BangDuel] Échec Règles:", err.message);
  }
}
