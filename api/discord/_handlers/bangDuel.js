// ============================================================
// bangDuel.js (handler) — Bang! Duel (`/bang`), deux modes :
// - contre Kévina, le bot (`/bang adversaire:bot`) : un seul message éphémère édité en place à
//   chaque action ; Kévina joue son tour aussitôt que le joueur a fini le
//   sien ;
// - 1v1 (`/bang adversaire:1v1`) : message public dans le salon (bouton Jouer :
//   rejoindre, puis afficher sa main) et une vue éphémère par joueur,
//   rééditée après chaque action adverse (webhook mémorisé, valable 15 min,
//   bouton Actualiser sinon). Une seule partie à la fois, comme Blackjack
//   et Gobelet Duel.
// Réservé au rôle MINI-JEUX pour lancer (rejoindre un 1v1 ne l'exige pas).
//
// custom_id : bangduel_<action> (contre Kévina), bangduel_<action>:pvp
// (1v1), bangduel_ouvrir (bouton Jouer du message public), bangduel_regles.
//
// Service : backend/services/bangDuel.js (Redis),
// règles : backend/services/bangDuelRules.js.
// ============================================================

import {
  agirDuel,
  agirPvp,
  enregistrerMessagePvp,
  loadDuelConfig,
  nouveauDuel,
  ouvrirPvp,
  readDuel,
  rejoindrePvp,
  siegeDe,
  supprimerDuel,
} from "../../../backend/services/bangDuel.js";
import {
  CARTES,
  JOUABLES_DUEL,
  POSITIONS,
  adversaire,
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
// Jeton d'interaction Discord valable 15 min : marge d'une minute
const WEBHOOK_VALIDITE_MS = 14 * 60_000;

export async function memberHasMiniJeuxRole(body) {
  const roleId = await getRoleIdByName(MINI_JEUX_ROLE_NAME);
  if (!roleId) return false;
  const roles = body.member?.roles;
  return Array.isArray(roles) && roles.includes(roleId);
}

export function extractMember(body) {
  const discordId = body.member?.user?.id;
  const username =
    body.member?.nick ||
    body.member?.user?.global_name ||
    body.member?.user?.username ||
    "Inconnu";
  return { discordId, username };
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

// Message public du 1v1 (jeton du bot) : création, édition, suppression.
async function messageSalon(method, channelId, messageId, payload) {
  const token = process.env.DISCORD_TOKEN;
  if (!token || !channelId) return null;
  const url = `https://discord.com/api/v10/channels/${channelId}/messages${messageId ? `/${messageId}` : ""}`;
  try {
    const res = await fetch(url, {
      method,
      headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
      ...(payload ? { body: JSON.stringify(payload) } : {}),
    });
    if (!res.ok && res.status !== 404) {
      console.warn(`[BangDuel] Échec ${method} du message public (${res.status}).`);
      return null;
    }
    return method === "POST" ? await res.json() : {};
  } catch (err) {
    console.warn(`[BangDuel] Erreur réseau (${method} message public):`, err.message);
    return null;
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

// Désignation de l'adversaire dans les textes : Kévina (le bot) ou un joueur.
const BOT = { Sujet: "Kévina", sujet: "Kévina", de: "de Kévina", a: "à Kévina", emoji: "🤖" };

function nomsJoueur(pseudo) {
  const elision = /^[aeiouyhàâéèêëîïôûAEIOUYHÀÂÉÈÊËÎÏÔÛ]/.test(pseudo);
  return { Sujet: pseudo, sujet: pseudo, de: `${elision ? "d'" : "de "}${pseudo}`, a: `à ${pseudo}`, emoji: "🤠" };
}

// Adversaire du siège `moi` dans une partie 1v1.
function nomsAdv(partie, moi) {
  return nomsJoueur(partie.noms[partie.sieges[adversaire(moi)]] ?? "?");
}

function effets(A) {
  return {
    sarbacane: "Regarde les 3 premières cartes de la pioche.",
    moine: `Renvoie la prochaine attaque ${A.de}.`,
    fut: "Esquive une pioche (ton tour se termine sans piocher).",
    gang: `Termine ton tour : ${A.sujet} devra piocher 2 fois.`,
    voleuse: `Regarde la main ${A.de} et prends-lui une carte.`,
    tornade: "Mélange la pioche.",
  };
}

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
  pasJoueur: "Tu ne joues pas dans ce duel.",
  lobby: "En attente d'un adversaire.",
};

const avertissement = (code) => `⚠️ ${ERREURS[code] || "Action impossible."}`;

// Tour de l'adversaire, raconté au siège `moi` (pioches consécutives
// regroupées ; carte piochée, Moine et emplacement d'un Gobelin explosif
// restent secrets).
function lignesAdv(entrees, moi, A) {
  const adv = adversaire(moi);
  const lignes = [];
  let pioches = 0;
  const vider = () => {
    if (pioches) lignes.push(`🃏 ${A.Sujet} pioche ${plural(pioches, "carte")}.`);
    pioches = 0;
  };
  for (const e of entrees) {
    if (e.id === adv && e.k === "pioche") {
      pioches++;
      continue;
    }
    vider();
    if (e.id === moi && e.k === "renvoi") {
      lignes.push(
        e.vole
          ? `🙏 Ton Moine renvoie la Voleuse ${A.de} : tu lui prends ${carteLabel(e.vole)} !`
          : `🙏 Ton Moine renvoie la Voleuse ${A.de}… qui n'a rien à prendre !`,
      );
      continue;
    }
    if (e.id !== adv) continue;
    const textes = {
      sarbacane: () => `🎯 ${A.Sujet} scrute la pioche avec son Gobelin à sarbacane…`,
      tornade: () => `🌪️ ${A.Sujet} déclenche une Tornade : la pioche est mélangée !`,
      fut: () => `🛢️ ${A.Sujet} se cache dans un Fût à gobelins et esquive une pioche.`,
      gang: () => `👊 ${A.Sujet} t'envoie son Gang de gobelins : tu devras piocher ${e.n} cartes d'un coup !`,
      voleuse: () => `🦹 La Voleuse ${A.de} te prend : ${carteLabel(e.carte)} !`,
      voleuseVide: () => `🦹 La Voleuse ${A.de} ne trouve rien dans ta main.`,
      renvoi: () =>
        `🙏 Aïe ! Le Moine ${A.de} renvoie ta carte (${carteLabel(e.carte)})${e.vole ? ` et te prend ${carteLabel(e.vole)}` : ""}.`,
      sauve: () => `💥 ${A.Sujet} pioche un Gobelin explosif… sauvé par son Esprit de guérison !`,
      cache: () => `🤫 ${A.Sujet} cache le Gobelin explosif quelque part dans la pioche…`,
      explose: () => `🚀 **BANG !** ${A.Sujet} explose !`,
    };
    const texte = textes[e.k]?.();
    if (texte) lignes.push(texte);
  }
  vider();
  return lignes;
}

// Fin du tour du joueur (pioche, Fût ou Gang) : Kévina joue aussitôt.
function tourDuBot(d, config) {
  if (d.termine || d.actif !== "bot") return;
  const avant = d.journal.length;
  jouerBot(d, "bot", { config });
  d.resumeBot = lignesAdv(d.journal.slice(avant), "joueur", BOT);
}

// ── Vues ─────────────────────────────────────────────────────────────

const BOUTON_REGLES = {
  type: 2,
  style: 2,
  label: "Règles",
  emoji: { name: "📖" },
  custom_id: "bangduel_regles",
};

function boutonsFin() {
  return [{ type: 1, components: [BOUTON_REGLES] }];
}

// `ctx` : { moi (siège du moteur), A (adversaire), pvp, raison, echeance }
function vueFin(d, texte, { moi = "joueur", A = BOT, raison = null } = {}) {
  const resume = lignesAdv(d.journal.slice(d.debutTour ?? d.journal.length), moi, A);
  const lignes = [
    ...(texte ? [texte, ""] : []),
    ...(d.resumeBot?.length && A === BOT ? [`**${A.emoji} Tour ${A.de}**`, ...d.resumeBot, ""] : []),
    ...(A !== BOT && resume.length && d.actif !== moi ? [`**${A.emoji} Tour ${A.de}**`, ...resume, ""] : []),
  ];
  const gagne = d.gagnant === moi;
  const titre = !d.gagnant
    ? "🤝 Match nul : personne n'a explosé."
    : raison === "delai"
      ? gagne
        ? `🏆 Victoire ! ${A.Sujet} n'a pas joué à temps.`
        : "💀 Défaite… tu n'as pas joué à temps."
      : raison === "abandon"
        ? gagne
          ? `🏆 Victoire ! ${A.Sujet} abandonne.`
          : "🏳️ Tu as abandonné."
        : gagne
          ? `🏆 Victoire ! ${A.Sujet} a explosé.`
          : "💀 Défaite… tu as explosé.";
  return {
    embeds: [
      {
        title: `💣 Bang! Duel · ${titre}`,
        description: lignes.join("\n").slice(0, 4096) || " ",
        color: BANG_COLOR,
      },
    ],
    components: boutonsFin(),
  };
}

// Message de la partie pour le siège `moi` : résultat de la dernière action
// (`texte`), tour de l'adversaire, état de la pioche, main ; composants
// selon l'étape (placement d'un Gobelin explosif, choix de la Voleuse, tour
// normal, attente du tour adverse en 1v1).
function buildVue(d, config, { texte = null, moi = "joueur", A = BOT, pvp = false, echeance = null, raison = null } = {}) {
  if (d.termine) return vueFin(d, texte, { moi, A, raison });
  const sfx = pvp ? ":pvp" : "";
  const j = d.joueurs[moi];
  const adv = d.joueurs[adversaire(moi)];
  const monTour = d.actif === moi;
  const bombes = d.pioche.filter((c) => c === "bombe").length;
  // Contre Kévina : son dernier tour ; 1v1 : le dernier tour adverse (à
  // mon tour) ou le tour adverse en cours (en attente)
  const resume = !pvp
    ? d.resumeBot
    : monTour
      ? d.resume?.[moi]
      : lignesAdv(d.journal.slice(d.debutTour ?? 0), moi, A);
  const lignes = [
    ...(texte ? [texte, ""] : []),
    ...(resume?.length ? [`**${A.emoji} Tour ${A.de}${monTour ? "" : " (en cours)"}**`, ...resume, ""] : []),
    `🃏 Pioche : **${plural(d.pioche.length, "carte")}**, dont **${bombes}** 💥`,
    `${A.emoji} ${A.Sujet} a **${plural(adv.main.length, "carte")}** en main.`,
    ...(monTour && j.dette > 1
      ? [`👊 Gang de gobelins : **${j.dette} cartes** à piocher d'un seul clic.`]
      : []),
    ...(j.moine
      ? [`🙏 Ton Moine te protège : la prochaine attaque ${A.de} sera renvoyée.`]
      : []),
    "",
    ...(monTour
      ? [`Cartes jouées ce tour : **${j.jouees}/${config.cartes_par_tour}**`]
      : [`⏳ Au tour ${A.de}${echeance ? `, limite <t:${echeance}:R>` : ""}.`]),
    `**Ta main** : ${formatMain(j.main)}`,
  ];
  const image = mainImageUrl(j.main);
  const embed = {
    title: `💣 Bang! Duel · Tour ${d.tour}/${config.tours_max}${pvp && monTour ? " · À toi !" : ""}`,
    description: lignes.join("\n").slice(0, 4096),
    color: BANG_COLOR,
    ...(image ? { image: { url: image } } : {}),
  };

  if (!monTour) {
    return {
      embeds: [embed],
      components: [
        {
          type: 1,
          components: [
            {
              type: 2,
              style: 1,
              label: "Actualiser",
              emoji: { name: "🔄" },
              custom_id: "bangduel_actualiser:pvp",
            },
            BOUTON_REGLES,
            { type: 2, style: 4, label: "Abandonner", custom_id: "bangduel_abandon:pvp" },
          ],
        },
      ],
    };
  }
  if (j.enAttente) {
    return {
      embeds: [embed],
      components: [
        {
          type: 1,
          components: [
            {
              type: 3,
              custom_id: `bangduel_placer${sfx}`,
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
      .map((id) => [id, adv.main.filter((c) => c === id).length])
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
              custom_id: `bangduel_voler${sfx}`,
              placeholder: `🦹 Quelle carte prendre ${A.a} ?`,
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
          custom_id: `bangduel_piocher${sfx}`,
        },
        BOUTON_REGLES,
        {
          type: 2,
          style: 4,
          label: "Abandonner",
          custom_id: `bangduel_abandon${sfx}`,
        },
      ],
    },
  ];
  const jouables = JOUABLES_DUEL.filter(
    (c) => j.main.includes(c) && !(c === "moine" && j.moine),
  );
  if (jouables.length && j.jouees < config.cartes_par_tour) {
    const desc = effets(A);
    components.push({
      type: 1,
      components: [
        {
          type: 3,
          custom_id: `bangduel_carte${sfx}`,
          placeholder: "⚡ Jouer une carte",
          options: jouables.map((c) => {
            const n = j.main.filter((x) => x === c).length;
            return {
              label: `${CARTES[c].nom}${n > 1 ? ` (×${n})` : ""}`,
              value: c,
              emoji: { name: CARTES[c].emoji },
              description: desc[c],
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
      "Fais exploser ton adversaire (Kévina ou un autre joueur) avant d'exploser toi-même !",
      "",
      `**🔁 Tour** : chacun son tour. ${config.tours_max} tours au plus : si personne n'a explosé, match nul.`,
      `**🃏 À ton tour** : joue d'abord jusqu'à ${config.cartes_par_tour} cartes (ou aucune), puis **Piocher** : une seule carte, et ton tour se termine.`,
      `**🎴 Départ** : chacun reçoit un ${carteLabel("esprit")} et ${plural(config.main_depart, "carte")}. La pioche contient ${plural(config.bombes, "Gobelin explosif")} et ${plural(config.esprits_pioche, "Esprit de guérison")}.`,
      "",
      `${carteLabel("bombe")} : si tu le pioches, ton Esprit de guérison est sacrifié et tu le caches où tu veux dans la pioche. Sans Esprit, tu exploses.`,
      `${carteLabel("sarbacane")} : regarde les 3 premières cartes de la pioche.`,
      `${carteLabel("fut")} : esquive une pioche (ton tour se termine sans piocher, ou une pioche de moins à faire après un Gang).`,
      `${carteLabel("gang")} : termine ton tour sans piocher ; ton adversaire devra piocher ${config.gang_pioches} cartes.`,
      `${carteLabel("voleuse")} : regarde la main de ton adversaire et prends-lui la carte de ton choix.`,
      `${carteLabel("moine")} : joue-le à l'avance, la prochaine attaque adverse (Gang, Voleuse) est renvoyée.`,
      `${carteLabel("tornade")} : mélange la pioche.`,
      `${carteLabel("gobelin")} : carte purement décorative.`,
      "",
      `**👥 1v1** (\`/bang\` puis 1v1) : le premier qui clique sur **Jouer** relève le défi, le joueur qui commence est tiré au sort. ${plural(config.delai_tour_minutes, "minute")} par tour, sinon défaite.`,
      "⏰ Sans action pendant 2 h, la partie est abandonnée.",
    ].join("\n"),
    color: BANG_COLOR,
  };
}

// ── Actions (communes aux deux modes) ────────────────────────────────
// `(d, moi, config, A)` → { texte } ou { erreur }.

function actionPiocher(d, moi, config) {
  // Pioches dues d'un Gang de gobelins : toutes d'un seul clic
  const r = piocherClic(d, moi, { config });
  if (r.erreur) return r;
  if (r.vide && !r.tirages.length)
    return { texte: "🃏 La pioche est vide : ton tour passe." };
  const cartes = r.tirages.filter((t) => !t.bang).map((t) => t.carte);
  const bang = r.tirages.find((t) => t.bang)?.bang;
  const avant = cartes.length
    ? `Tu pioches : **${cartes.map(carteLabel).join("**, **")}**`
    : null;
  const suite =
    bang === "elimine"
      ? "💥 **BANG !** Tu as pioché un Gobelin explosif sans Esprit de guérison."
      : bang === "sauve"
        ? `${carteLabel("bombe")} désamorcé ! Ton Esprit de guérison te sauve : choisis où cacher le Gobelin explosif.`
        : null;
  return { texte: [avant, suite].filter(Boolean).join("\n") };
}

function actionPlacer(d, moi, config, position) {
  const r = placer(d, moi, position, { config });
  if (r.erreur) return r;
  return { texte: `🤫 Gobelin explosif caché : ${POSITIONS[position].toLowerCase()}.` };
}

function actionCarte(d, moi, config, A, carte) {
  const r = jouer(d, moi, carte, { config });
  if (r.erreur) return r;
  if (r.carte === "sarbacane") {
    const vues = r.revelation.length
      ? r.revelation.map((c, i) => `${i + 1}. ${carteLabel(c)}`).join("\n")
      : "La pioche est vide.";
    return { texte: `🎯 **Sommet de la pioche** :\n${vues}` };
  }
  if (r.carte === "moine")
    return { texte: `🙏 Ton Moine veille : la prochaine attaque ${A.de} lui sera renvoyée.` };
  if (r.carte === "tornade") return { texte: "🌪️ Tornade ! La pioche est mélangée." };
  if (r.carte === "fut")
    return {
      texte: r.finTour
        ? "🛢️ Tu te caches dans un Fût à gobelins : ton tour se termine sans piocher."
        : "🛢️ Tu te caches dans un Fût à gobelins et esquives une des pioches du Gang.",
    };
  if (r.renvoi && r.carte === "gang")
    return {
      texte: `🙏 Aïe ! Le Moine ${A.de} renvoie ton Gang de gobelins : tu dois piocher ${config.gang_pioches} cartes d'un coup.`,
    };
  if (r.renvoi)
    return {
      texte: `🙏 Aïe ! Le Moine ${A.de} renvoie ta Voleuse${r.vole ? ` : ${A.sujet} te prend ${carteLabel(r.vole)}` : ""}.`,
    };
  if (r.carte === "gang")
    return {
      texte: `👊 Ton Gang de gobelins attend ${A.sujet} : il faudra piocher ${config.gang_pioches} cartes. Ton tour est terminé.`,
    };
  if (r.choix) return { texte: `🦹 Ta Voleuse fouille la main ${A.de} : choisis la carte à prendre.` };
  return { texte: `🦹 Ta Voleuse ne trouve rien : la main ${A.de} est vide.` };
}

function actionVoler(d, moi, config, A, carte) {
  const r = voler(d, moi, carte);
  if (r.erreur) return r;
  return { texte: `🦹 Tu prends ${A.a} : **${carteLabel(r.carte)}**` };
}

const ACTIONS = {
  piocher: (d, moi, config) => actionPiocher(d, moi, config),
  placer: (d, moi, config, A, valeur) => actionPlacer(d, moi, config, valeur),
  carte: actionCarte,
  voler: actionVoler,
};

// ── Contre Kévina ────────────────────────────────────────────────────

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
        texte: `Nouvelle partie contre Kévina ! Tu commences. Tu as un ${carteLabel("esprit")} et ${plural(config.main_depart, "carte")}.`,
      }),
    );
  } catch (err) {
    console.error("[BangDuel] Échec lancement:", err.message);
  }
}

// Action sous verrou ; Kévina joue si elle a la main.
async function executerSolo(webhookUrl, discordId, action, valeur) {
  const { duel, config, resultat } = await agirDuel(discordId, (d, cfg) => {
    const r = ACTIONS[action](d, "joueur", cfg, BOT, valeur) || {};
    if (!r.erreur) {
      // Nouvelle action du joueur : le récit du tour de Kévina s'efface
      d.resumeBot = [];
      tourDuBot(d, cfg);
    }
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

async function abandonSolo(webhookUrl, discordId) {
  await supprimerDuel(discordId);
  await patchOriginal(webhookUrl, {
    embeds: [
      {
        title: "💣 Bang! Duel · Partie abandonnée",
        description: "Kévina l'emporte par forfait.",
        color: BANG_COLOR,
      },
    ],
    components: boutonsFin(),
  });
}

// ── 1v1 ──────────────────────────────────────────────────────────────

const echeanceDe = (partie, config) =>
  Math.floor((partie.dernierCoupAt + config.delai_tour_minutes * 60_000) / 1000);

function memoriserWebhook(partie, discordId, webhookUrl) {
  if (webhookUrl) partie.webhooks[discordId] = { url: webhookUrl, at: Date.now() };
}

function webhookValide(partie, discordId) {
  const w = partie.webhooks?.[discordId];
  return w && Date.now() - w.at < WEBHOOK_VALIDITE_MS ? w.url : null;
}

// Vue éphémère d'un joueur du 1v1 (lobby, partie, fin).
function vuePvp(partie, config, discordId, texte = null) {
  if (partie.statut === "lobby") {
    return {
      embeds: [
        {
          title: "💣 Bang! Duel · 1v1",
          description: [
            ...(texte ? [texte, ""] : []),
            "⏳ En attente d'un adversaire : le premier qui clique sur **Jouer** dans le salon relève le défi.",
          ].join("\n"),
          color: BANG_COLOR,
        },
      ],
      components: boutonsFin(),
    };
  }
  const moi = siegeDe(partie, discordId);
  return buildVue(partie.duel, config, {
    texte,
    moi,
    A: nomsAdv(partie, moi),
    pvp: true,
    echeance: echeanceDe(partie, config),
    raison: partie.raisonFin,
  });
}

// Message public : lobby, partie en cours (au tour de qui, délai).
function messagePublic(partie, config) {
  const bouton = {
    type: 1,
    components: [
      { type: 2, style: 3, label: "Jouer", emoji: { name: "💣" }, custom_id: "bangduel_ouvrir" },
      BOUTON_REGLES,
    ],
  };
  if (partie.statut === "lobby") {
    return {
      embeds: [
        {
          title: "💣 Bang! Duel · 1v1",
          description: `<@${partie.lanceur}> lance un duel ! Qui relève le défi ? Clique sur **Jouer** pour l'affronter.`,
          color: BANG_COLOR,
        },
      ],
      components: [bouton],
    };
  }
  const d = partie.duel;
  const [a, b] = [partie.sieges.joueur, partie.sieges.bot];
  const bombes = d.pioche.filter((c) => c === "bombe").length;
  return {
    embeds: [
      {
        title: `💣 Bang! Duel · ${partie.noms[a]} contre ${partie.noms[b]}`,
        description: [
          `**Tour ${d.tour}/${config.tours_max}** · au tour de <@${partie.sieges[d.actif]}>, limite <t:${echeanceDe(partie, config)}:R>`,
          `🃏 Pioche : **${plural(d.pioche.length, "carte")}**, dont **${bombes}** 💥`,
          "",
          "Joueurs : clique sur **Jouer** pour afficher ta main.",
        ].join("\n"),
        color: BANG_COLOR,
      },
    ],
    components: [bouton],
  };
}

// Fin du 1v1 : récapitulatif dans un NOUVEAU message (visible en bas du
// salon), puis suppression du message de la partie (comme Gobelet Duel).
function messageFinal(partie) {
  const d = partie.duel;
  const [a, b] = [partie.sieges.joueur, partie.sieges.bot];
  const gagnant = d.gagnant ? partie.sieges[d.gagnant] : null;
  const perdant = d.gagnant ? partie.sieges[adversaire(d.gagnant)] : null;
  const description = !gagnant
    ? `🤝 Match nul entre <@${a}> et <@${b}> : personne n'a explosé.`
    : partie.raisonFin === "delai"
      ? `🏆 <@${gagnant}> remporte le duel : <@${perdant}> n'a pas joué à temps.`
      : partie.raisonFin === "abandon"
        ? `🏆 <@${gagnant}> remporte le duel : <@${perdant}> abandonne.`
        : `🏆 <@${gagnant}> remporte le duel : <@${perdant}> a explosé au tour ${d.tour} !`;
  return {
    embeds: [{ title: "💣 Bang! Duel · 1v1", description, color: BANG_COLOR }],
    components: boutonsFin(),
  };
}

// Après une action : vue de l'auteur, vue de l'adversaire (webhook encore
// valable), message public (ou récapitulatif final).
async function diffuserPvp(partie, config, discordId, webhookUrl, texte) {
  const autres = Object.values(partie.sieges ?? {}).filter((id) => id !== discordId);
  await Promise.all([
    patchOriginal(webhookUrl, vuePvp(partie, config, discordId, texte)),
    ...autres.map((id) => patchOriginal(webhookValide(partie, id), vuePvp(partie, config, id))),
  ]);
  if (partie.statut === "fini") {
    const ok = await messageSalon("POST", partie.channelId, null, messageFinal(partie));
    if (ok) await messageSalon("DELETE", partie.channelId, partie.messageId);
    else await messageSalon("PATCH", partie.channelId, partie.messageId, messageFinal(partie));
    return;
  }
  await messageSalon("PATCH", partie.channelId, partie.messageId, messagePublic(partie, config));
}

const AUCUNE_PARTIE_PVP = {
  embeds: [
    {
      description: "⏰ Aucun duel 1v1 en cours. Lance-en un avec `/bang` (1v1) !",
      color: BANG_COLOR,
    },
  ],
  components: boutonsFin(),
};

// `/bang adversaire:1v1` : ouvre le lobby (message public), la réponse
// éphémère devient la vue du lanceur.
export async function handleBangDuelPvpCommand(webhookUrl, body) {
  try {
    const { discordId, username } = extractMember(body);
    const r = await ouvrirPvp({ channelId: body.channel_id, lanceur: discordId, nom: username });
    if (r.dejaEnCours) {
      await patchOriginal(webhookUrl, {
        content: `Un duel 1v1 est déjà en cours dans <#${r.dejaEnCours.channelId}> : attends qu'il se termine.`,
      });
      return;
    }
    // Lobby sans adversaire ou partie au délai dépassé, remplacés
    if (r.ancienne?.messageId) await messageSalon("DELETE", r.ancienne.channelId, r.ancienne.messageId);
    const config = await loadDuelConfig();
    const message = await messageSalon("POST", body.channel_id, null, messagePublic(r.partie, config));
    if (!message?.id) throw new Error("message public non créé");
    await enregistrerMessagePvp(message.id);
    const { partie } = await agirPvp((p) => {
      memoriserWebhook(p, discordId, webhookUrl);
    });
    await patchOriginal(webhookUrl, vuePvp(partie, config, discordId, "💣 Défi lancé dans le salon !"));
  } catch (err) {
    console.error("[BangDuel] Échec lancement 1v1:", err.message);
    await patchOriginal(webhookUrl, { content: "⚠️ Erreur lors du lancement du duel." });
  }
}

// [💣 Jouer] du message public : rejoindre (2ᵉ joueur), sinon afficher sa
// vue (nouvel éphémère, mémorisé pour les mises à jour).
export async function handleBangDuelOuvrir(webhookUrl, body) {
  try {
    const { discordId, username } = extractMember(body);
    const { partie, config, resultat } = await agirPvp((p, cfg) => {
      if (p.statut === "lobby" && discordId !== p.lanceur) {
        rejoindrePvp(p, cfg, discordId, username);
        memoriserWebhook(p, discordId, webhookUrl);
        return { rejoint: true, coup: true };
      }
      if (p.statut !== "lobby" && !siegeDe(p, discordId)) return { erreur: "pasJoueur" };
      memoriserWebhook(p, discordId, webhookUrl);
      return {};
    });
    if (!partie) {
      await patchOriginal(webhookUrl, AUCUNE_PARTIE_PVP);
      return;
    }
    if (resultat.erreur) {
      const [a, b] = Object.values(partie.sieges);
      await patchOriginal(webhookUrl, {
        content: `Ce duel oppose <@${a}> et <@${b}>. Lance le tien avec \`/bang\` (1v1) une fois qu'il est terminé !`,
      });
      return;
    }
    if (resultat.rejoint || resultat.vientDeFinir) {
      const premier = partie.noms[partie.sieges.joueur];
      const texte = resultat.rejoint
        ? `⚔️ ${username} relève le défi ! Tirage au sort : ${premier} commence.`
        : null;
      // Le lanceur voit aussi l'arrivée de son adversaire
      await diffuserPvp(partie, config, discordId, webhookUrl, texte);
      return;
    }
    await patchOriginal(webhookUrl, vuePvp(partie, config, discordId));
  } catch (err) {
    console.error("[BangDuel] Échec Jouer 1v1:", err.message);
  }
}

// Action d'un joueur du 1v1 sous verrou. Changement de tour : le récit du
// tour qui s'achève est gardé pour le joueur suivant.
async function executerPvp(webhookUrl, discordId, action, valeur) {
  const { partie, config, resultat } = await agirPvp((p, cfg) => {
    const moi = siegeDe(p, discordId);
    if (!moi) return { erreur: p.statut === "lobby" ? "lobby" : "pasJoueur" };
    memoriserWebhook(p, discordId, webhookUrl);
    if (p.statut !== "enCours") return { erreur: "termine" };
    const d = p.duel;
    const actifAvant = d.actif;
    let r;
    if (action === "abandon") {
      d.termine = true;
      d.gagnant = adversaire(moi);
      p.raisonFin = "abandon";
      r = { texte: null };
    } else if (action === "actualiser") {
      return {};
    } else {
      r = ACTIONS[action](d, moi, cfg, nomsAdv(p, moi), valeur) || {};
      if (r.erreur) return r;
    }
    d.resume = { ...(d.resume ?? {}), [moi]: [] };
    if (d.actif !== actifAvant && !d.termine) {
      d.resume[d.actif] = lignesAdv(d.journal.slice(d.debutTour ?? 0), d.actif, nomsAdv(p, d.actif));
      d.debutTour = d.journal.length;
    }
    return { ...r, coup: true };
  });
  if (!partie) {
    await patchOriginal(webhookUrl, AUCUNE_PARTIE_PVP);
    return;
  }
  if (resultat.erreur === "pasJoueur") {
    await patchOriginal(webhookUrl, { content: avertissement("pasJoueur") });
    return;
  }
  const texte = resultat.erreur ? avertissement(resultat.erreur) : resultat.texte;
  if (resultat.coup || resultat.vientDeFinir) {
    await diffuserPvp(partie, config, discordId, webhookUrl, texte);
    return;
  }
  await patchOriginal(webhookUrl, vuePvp(partie, config, discordId, texte));
}

// ── Points d'entrée des composants ───────────────────────────────────

async function executer(webhookUrl, discordId, action, { pvp = false, valeur } = {}) {
  try {
    if (pvp) await executerPvp(webhookUrl, discordId, action, valeur);
    else if (action === "abandon") await abandonSolo(webhookUrl, discordId);
    else await executerSolo(webhookUrl, discordId, action, valeur);
  } catch (err) {
    console.error(`[BangDuel] Échec ${action}:`, err.message);
  }
}

export const handleBangDuelPiocher = (webhookUrl, discordId, opts) =>
  executer(webhookUrl, discordId, "piocher", opts);
export const handleBangDuelPlacer = (webhookUrl, discordId, valeur, opts) =>
  executer(webhookUrl, discordId, "placer", { ...opts, valeur });
export const handleBangDuelCarte = (webhookUrl, discordId, valeur, opts) =>
  executer(webhookUrl, discordId, "carte", { ...opts, valeur });
export const handleBangDuelVoler = (webhookUrl, discordId, valeur, opts) =>
  executer(webhookUrl, discordId, "voler", { ...opts, valeur });
export const handleBangDuelAbandon = (webhookUrl, discordId, opts) =>
  executer(webhookUrl, discordId, "abandon", opts);
export const handleBangDuelActualiser = (webhookUrl, discordId) =>
  executer(webhookUrl, discordId, "actualiser", { pvp: true });

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
