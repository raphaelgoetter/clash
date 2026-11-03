// ============================================================
// bacDuel.js (handler) — Petit Bac (`/bac`), deux modes :
// - contre Kévina, le bot (`/bac adversaire:bot`) : table publique dans le
//   salon (suivie par tous, réponses cachées jusqu'à la fin de la manche)
//   et vue éphémère du joueur ; Kévina répond en début de manche ;
// - 1v1 (`/bac adversaire:1v1`) : message public (bouton Jouer dans le
//   lobby : rejoindre) et une vue éphémère par joueur, rééditée à chaque
//   événement (webhook mémorisé, valable 15 min, renouvelé à chaque action).
//   Une seule partie à la fois.
// Les deux joueurs répondent en même temps ; chaque manche dure
// `delai_manche_secondes` : l'invocation qui ouvre la manche attend la fin
// du temps puis la clôt si personne ne l'a fait (surveillerManche()).
// Réservé au rôle MINI-JEUX pour lancer (rejoindre un 1v1 ne l'exige pas).
//
// custom_id : bacduel_proposer:<manche>:<thème>:<lettre>[:pvp] (ouvre la
// fenêtre de saisie, réponse synchrone dans la route), bacduel_mot:<manche>[:pvp]
// (fenêtre soumise), bacduel_passer:<manche>[:pvp], bacduel_suivante:<manche>[:pvp],
// bacduel_ouvrir (Jouer du message public 1v1), bacduel_regles,
// bacduel_abandon[:pvp] (🏳️, confirmation), bacduel_abandon_ok[:pvp] /
// bacduel_abandon_non[:pvp]. <manche> = numéro de la manche affichée : une
// action sur une manche dépassée est refusée.
//
// Service : jeux/services/bacDuel.js (Redis), règles : jeux/services/bacRules.js.
// ============================================================

import {
  agirDuel,
  agirPvp,
  enregistrerMessagePvp,
  loadDuelConfig,
  nouveauDuel,
  ouvrirPvp,
  readDuel,
  readPvp,
  rejoindrePvp,
  siegeDe,
} from "../../services/bacDuel.js";
import {
  NB_MANCHES,
  NIVEAUX,
  PROPOSITIONS_MAX,
  THEMES,
  adversaire,
  cloreManche,
  formatPoints,
  jouerKevina,
  mancheCourante,
  mancheOuverte,
  mancheSuivante,
  niveauDe,
  passer,
  proposer,
  tempsEcoule,
  themeDePersonnes,
} from "../../services/bacRules.js";
import {
  getRoleIdByName,
  MINI_JEUX_ROLE_NAME,
} from "@clash/commun/discordRoles.js";

const BAC_COLOR = 0x2e86c1;
const TITRE = "🔤 Petit Bac";
const TRUST_ROYALE_URL = "https://trustroyale.vercel.app";
// Illustration du message public de fin de partie (bacImage.js)
const URL_ILLUSTRATION = `${TRUST_ROYALE_URL}/api/bac/illustration`;
// Jeton d'interaction Discord valable 15 min : marge d'une minute
const WEBHOOK_VALIDITE_MS = 14 * 60_000;
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

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

// Messages en Components V2 (conteneur à liseré coloré, comme un embed) :
// les vues sont écrites comme des embeds, converties ici à l'envoi.
const IS_COMPONENTS_V2 = 1 << 15;
const EPHEMERE = 1 << 6;
const TEXTE_MAX = 4000;

export function versV2({
  content = null,
  embeds = [],
  components = [],
  ...reste
}) {
  const blocs = [];
  if (content) blocs.push({ type: 10, content });
  const [embed] = embeds;
  if (embed) {
    const texte = [embed.title ? `### ${embed.title}` : null, embed.description]
      .filter(Boolean)
      .join("\n");
    blocs.push({
      type: 17,
      accent_color: embed.color ?? BAC_COLOR,
      components: [
        { type: 10, content: texte.slice(0, TEXTE_MAX) },
        // Image : galerie sous le texte
        ...(embed.image?.url ? [{ type: 12, items: [{ media: { url: embed.image.url } }] }] : []),
        ...components,
      ],
    });
  } else blocs.push(...components);
  return { ...reste, flags: IS_COMPONENTS_V2, components: blocs };
}

// Message visé : la réponse de l'interaction (`@original`), ou un followup
// si l'URL mémorisée désigne déjà un message (`…/messages/<id>`).
const urlMessage = (webhookUrl) =>
  webhookUrl.includes("/messages/")
    ? webhookUrl
    : `${webhookUrl}/messages/@original`;

async function patchOriginal(webhookUrl, payload) {
  if (!webhookUrl) return;
  try {
    const res = await fetch(urlMessage(webhookUrl), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(versV2(payload)),
    });
    if (!res.ok)
      console.error(
        `[Petit Bac] PATCH refusé (${res.status}) :`,
        (await res.text()).slice(0, 300),
      );
  } catch (err) {
    console.error("[Petit Bac] Échec PATCH:", err.message);
  }
}

async function supprimerOriginal(webhookUrl) {
  if (!webhookUrl) return false;
  try {
    return (await fetch(urlMessage(webhookUrl), { method: "DELETE" })).ok;
  } catch (err) {
    console.error("[Petit Bac] Échec DELETE:", err.message);
    return false;
  }
}

// Nouveau message éphémère (followup) ; renvoie son URL, null en cas d'échec.
async function envoyerEphemere(webhookUrl, payload) {
  if (!webhookUrl) return null;
  try {
    const v2 = versV2(payload);
    const res = await fetch(`${webhookUrl}?wait=true`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...v2, flags: v2.flags | EPHEMERE }),
    });
    if (!res.ok) {
      console.error(
        `[Petit Bac] Followup refusé (${res.status}) :`,
        (await res.text()).slice(0, 300),
      );
      return null;
    }
    const { id } = await res.json();
    return id ? `${webhookUrl}/messages/${id}` : null;
  } catch (err) {
    console.error("[Petit Bac] Échec followup:", err.message);
    return null;
  }
}

// Message public (jeton du bot) : création, édition, suppression.
async function messageSalon(method, channelId, messageId, payload) {
  const token = process.env.DISCORD_TOKEN;
  if (!token || !channelId) return null;
  const url = `https://discord.com/api/v10/channels/${channelId}/messages${messageId ? `/${messageId}` : ""}`;
  try {
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bot ${token}`,
        "Content-Type": "application/json",
      },
      // Jamais de ping dans ce jeu
      ...(payload
        ? {
            body: JSON.stringify({
              allowed_mentions: { parse: [] },
              ...versV2(payload),
            }),
          }
        : {}),
    });
    if (!res.ok && res.status !== 404) {
      console.warn(
        `[Petit Bac] Échec ${method} du message public (${res.status}).`,
      );
      return null;
    }
    return method === "POST" ? await res.json() : {};
  } catch (err) {
    console.warn(
      `[Petit Bac] Erreur réseau (${method} message public):`,
      err.message,
    );
    return null;
  }
}

// ── Mise en forme ────────────────────────────────────────────────────

const BOT = { Sujet: "Kévina" };
const nomsAdv = (partie, moi) => ({
  Sujet: partie.noms[partie.sieges[adversaire(moi)]] ?? "?",
});
const fp = formatPoints;
const plural = (n, mot) => `${n} ${mot}${n > 1 ? "s" : ""}`;

const intitule = (m) => `${THEMES[m.theme]} en ${m.lettre}`;
const echeanceDe = (m, config) =>
  Math.floor((m.debut + config.delai_manche_secondes * 1000) / 1000);
const score = (d, moi, A) =>
  `Toi ${fp(d.scores[moi])} – ${fp(d.scores[adversaire(moi)])} ${A.Sujet}`;

const RAISONS = {
  lettre: (m) => `ne commence pas par ${m.lettre}`,
  nom: (m) => `le nom de famille doit commencer par ${m.lettre}`,
  inconnu: () => "pas dans la liste",
  vide: () => "mot vide",
};

// Résultat de la dernière proposition de `moi`
function retour(m, moi, r) {
  if (r.ok) return `✅ **${m.reponses[moi].mot}** accepté.`;
  const f = m.refus[moi];
  return `❌ **${f.mot || "?"}** refusé : ${RAISONS[f.raison](m)}.`;
}

// Ligne de réponse d'une manche close : « Toi : **Kangourou** +1 »
function ligneReponse(m, id, qui) {
  const r = m.reponses[id];
  return r
    ? `${qui} : **${r.mot}** +${fp(m.points[id])}`
    : `${qui} : aucune réponse`;
}

const ERREURS = {
  termine: "La partie est terminée.",
  close: "La manche est terminée.",
  fige: "Ta réponse est déjà figée pour cette manche.",
  temps: "Temps écoulé !",
  perime: "Cette manche est passée.",
  ouverte: "La manche n'est pas finie.",
  pasJoueur: "Tu ne joues pas dans ce duel.",
  lobby: "En attente d'un adversaire.",
};
const avertissement = (code) => `⚠️ ${ERREURS[code] || "Action impossible."}`;

// ── Vues ─────────────────────────────────────────────────────────────

const BOUTON_REGLES = {
  type: 2,
  style: 2,
  label: "Règles",
  emoji: { name: "📖" },
  custom_id: "bacduel_regles",
};
const boutonsFin = () => [{ type: 1, components: [BOUTON_REGLES] }];
const boutonAbandon = (sfx) => ({
  type: 2,
  style: 2,
  emoji: { name: "🏳️" },
  custom_id: `bacduel_abandon${sfx}`,
});

function boutonsConfirmation(sfx) {
  return [
    {
      type: 1,
      components: [
        {
          type: 2,
          style: 4,
          label: "Abandonner",
          emoji: { name: "🏳️" },
          custom_id: `bacduel_abandon_ok${sfx}`,
        },
        {
          type: 2,
          style: 2,
          label: "Annuler",
          custom_id: `bacduel_abandon_non${sfx}`,
        },
      ],
    },
  ];
}

// Fin de partie : résultat de la dernière manche et score final.
function vueFin(d, { moi, A }) {
  const m = mancheCourante(d);
  const issue = d.abandon
    ? d.gagnant === moi
      ? `🏆 Victoire ! ${A.Sujet} abandonne.`
      : "🏳️ Tu abandonnes."
    : d.gagnant === "nul"
      ? "🤝 Égalité !"
      : d.gagnant === moi
        ? "🏆 Victoire !"
        : "💀 Défaite…";
  const derniere = m.points
    ? [
        `Manche **${d.manches.length}**/${NB_MANCHES} : **${intitule(m)}**`,
        ligneReponse(m, moi, "Toi"),
        ligneReponse(m, adversaire(moi), A.Sujet),
        "",
      ]
    : [];
  return {
    embeds: [
      {
        title: `${TITRE} · ${score(d, moi, A)}`,
        description: [...derniere, `${issue} La partie est terminée.`].join(
          "\n",
        ),
        color: BAC_COLOR,
      },
    ],
    components: [],
  };
}

// Vue d'un joueur : manche en cours (thème, lettre, sa réponse, boutons)
// ou résultat de la manche close (bouton Manche suivante). `ctx` : { texte,
// moi, A, pvp, config, confirmerAbandon }.
function buildVue(
  d,
  {
    texte = null,
    moi = "joueur",
    A = BOT,
    pvp = false,
    config,
    confirmerAbandon = false,
  } = {},
) {
  if (d.termine) return vueFin(d, { moi, A });
  const sfx = pvp ? ":pvp" : "";
  const m = mancheCourante(d);
  const n = d.manches.length;
  const titre = `${TITRE} · ${score(d, moi, A)}`;
  if (confirmerAbandon) {
    return {
      embeds: [
        {
          title: titre,
          description: "🏳️ **Abandonner la partie ?** Ce sera une défaite.",
          color: BAC_COLOR,
        },
      ],
      components: boutonsConfirmation(sfx),
    };
  }
  const entete = `Manche **${n}**/${NB_MANCHES} · ${niveauDe(m.theme)}`;
  if (!mancheOuverte(d)) {
    const lignes = [
      entete,
      `## ${intitule(m)}`,
      ...(texte ? [texte] : []),
      ligneReponse(m, moi, "Toi"),
      ligneReponse(m, adversaire(moi), A.Sujet),
    ];
    const suivante = {
      type: 2,
      style: 2,
      label: "Manche suivante",
      emoji: { name: "▶️" },
      custom_id: `bacduel_suivante:${n}${sfx}`,
    };
    return {
      embeds: [
        { title: titre, description: lignes.join("\n"), color: BAC_COLOR },
      ],
      components: [
        { type: 1, components: [suivante, BOUTON_REGLES, boutonAbandon(sfx)] },
      ],
    };
  }
  const rep = m.reponses[moi];
  const reste = PROPOSITIONS_MAX - m.essais[moi];
  const etat = m.fige[moi]
    ? [
        rep
          ? `Ta réponse : **${rep.mot}**`
          : "Pas de réponse pour cette manche.",
        `⏳ En attente de ${A.Sujet}…`,
      ]
    : [
        [
          rep ? `Ta réponse : **${rep.mot}**` : null,
          plural(reste, "proposition") +
            (reste > 1 ? " possibles" : " possible"),
        ]
          .filter(Boolean)
          .join(" · "),
      ];
  const consigne = themeDePersonnes(m.theme)
    ? ["👤 Seul le nom de famille compte."]
    : [];
  const lignes = [
    entete,
    `## ${intitule(m)}`,
    ...consigne,
    ...(texte ? [texte] : []),
    ...etat,
    `⏰ Fin de la manche <t:${echeanceDe(m, config)}:R>`,
  ];
  const actions = m.fige[moi]
    ? []
    : [
        {
          type: 2,
          style: 2,
          label: rep ? "Changer de mot" : "Proposer un mot",
          emoji: { name: "✏️" },
          custom_id: `bacduel_proposer:${n}:${m.theme}:${m.lettre}${sfx}`,
        },
        rep
          ? {
              type: 2,
              style: 2,
              label: "Valider",
              emoji: { name: "✅" },
              custom_id: `bacduel_passer:${n}${sfx}`,
            }
          : {
              type: 2,
              style: 2,
              label: "Passer",
              emoji: { name: "⏭️" },
              custom_id: `bacduel_passer:${n}${sfx}`,
            },
      ];
  return {
    embeds: [
      {
        title: titre,
        description: lignes.join("\n").slice(0, 4096),
        color: BAC_COLOR,
      },
    ],
    components: [
      { type: 1, components: [...actions, BOUTON_REGLES, boutonAbandon(sfx)] },
    ],
  };
}

// Fenêtre de saisie (réponse synchrone de la route, sans état lu : thème
// et lettre viennent du custom_id du bouton)
export function buildModalMot(manche, themeId, lettre, pvp) {
  return {
    custom_id: `bacduel_mot:${manche}${pvp ? ":pvp" : ""}`,
    title: `${THEMES[themeId] ?? "Petit Bac"} en ${lettre}`.slice(0, 45),
    components: [
      {
        type: 1,
        components: [
          {
            type: 4,
            custom_id: "bacduel_mot_input",
            style: 1,
            label: "Ton mot",
            placeholder: `Commence par ${lettre}…`,
            required: true,
            max_length: 40,
          },
        ],
      },
    ],
  };
}

function buildReglesEmbed(config) {
  return {
    title: "📖 Règles du Petit Bac",
    description: [
      `**${NB_MANCHES} manches**, chacune avec un thème et une lettre. Les deux joueurs ont **${config.delai_manche_secondes} secondes** pour trouver un mot du thème qui commence par la lettre.`,
      "",
      `✏️ **${PROPOSITIONS_MAX} propositions** possibles par manche, résultat immédiat : un mot accepté remplace le précédent, un mot refusé ne change rien.`,
      "⏭️ **Passer** (ou ✅ **Valider**) fige ta réponse pour la manche.",
      "",
      "**Points** : 1 par bonne réponse, 0,5 chacun si vous avez trouvé le même mot.",
      "Majuscules, accents, pluriel et article (le, la, l') sont tolérés.",
      "",
      "**Difficulté croissante** : manches 1 à 3 sur un thème facile, 4 à 6 sur un thème moyen, 7 et 8 sur un thème difficile ; la 3ᵉ et la 6ᵉ manche tirent une lettre moins courante. Acteurs et musique : seul le nom de famille compte.",
      "",
      ...Object.entries(NIVEAUX).map(
        ([n, l]) =>
          `**${n.charAt(0).toUpperCase() + n.slice(1)}** : ${l.map((id) => THEMES[id]).join(", ")}.`,
      ),
      "**🏳️ Abandon** : défaite immédiate (après confirmation).",
    ].join("\n"),
    color: BAC_COLOR,
  };
}

// ── Séries de victoires (messages de fin) ────────────────────────────

const SERIE_CASSEE_MIN = 2;
const victoires = (n) => (n > 1 ? `${n} victoires d'affilée` : `${n} victoire`);
const deNom = (pseudo) =>
  /^[aeiouyhàâéèêëîïôûAEIOUYHÀÂÉÈÊËÎÏÔÛ]/.test(pseudo)
    ? `d'${pseudo}`
    : `de ${pseudo}`;

function lignesSeries({
  gagnant,
  perdant,
  record,
  libelleSerie,
  libelleRecord,
}) {
  const rec = record
    ? `${libelleRecord} : ${record.username ?? "?"} (${record.serie})`
    : null;
  const lignes = [];
  if (gagnant)
    lignes.push(
      [`🔥 ${libelleSerie(gagnant.nom)} : ${victoires(gagnant.serie)}`, rec]
        .filter(Boolean)
        .join(" · "),
    );
  else if (rec) lignes.push(rec);
  if (perdant && perdant.avant >= SERIE_CASSEE_MIN)
    lignes.push(`💔 Fin de la série ${deNom(perdant.nom)} (${perdant.avant})`);
  return lignes;
}

// « 🏆 A bat B : 3,5 à 2 ! », égalité, abandon
function resultat(d, nomDe) {
  if (d.abandon)
    return `🏳️ ${nomDe(d.abandon)} abandonne : ${nomDe(adversaire(d.abandon))} remporte la partie.`;
  if (d.gagnant === "nul")
    return `🤝 Égalité entre ${nomDe("joueur")} et ${nomDe("bot")} : ${fp(d.scores.joueur)} partout.`;
  const g = d.gagnant;
  return `🏆 ${nomDe(g)} bat ${nomDe(adversaire(g))} : ${fp(d.scores[g])} à ${fp(d.scores[adversaire(g)])} !`;
}

// ── Message public ───────────────────────────────────────────────────

// Table publique (solo et 1v1) : manche, score, réponses une fois la
// manche close (cachées avant).
function messageTable(d, nomDe, config) {
  const m = mancheCourante(d);
  const etat = mancheOuverte(d)
    ? [
        `⏳ Manche en cours, fin <t:${echeanceDe(m, config)}:R>.`,
        ...["joueur", "bot"]
          .filter((id) => m.fige[id])
          .map((id) => `✔️ ${nomDe(id)} a répondu.`),
      ]
    : [
        ligneReponse(m, "joueur", nomDe("joueur")),
        ligneReponse(m, "bot", nomDe("bot")),
      ];
  return {
    embeds: [
      {
        title: `${TITRE} · ${nomDe("joueur")} contre ${nomDe("bot")}`,
        description: [
          `Manche **${d.manches.length}**/${NB_MANCHES} : **${intitule(m)}**`,
          `Score : **${nomDe("joueur")} ${fp(d.scores.joueur)}** – ${fp(d.scores.bot)} ${nomDe("bot")}`,
          "",
          ...etat,
        ].join("\n"),
        color: BAC_COLOR,
      },
    ],
    components: boutonsFin(),
  };
}

function messageFinal(d, nomDe, series) {
  return {
    embeds: [
      {
        title: `${TITRE} · ${nomDe("joueur")} contre ${nomDe("bot")}`,
        description: [
          resultat(d, nomDe),
          ...(series.length ? ["", ...series] : []),
        ].join("\n"),
        image: { url: URL_ILLUSTRATION },
        color: BAC_COLOR,
      },
    ],
    components: boutonsFin(),
  };
}

// ── Contre Kévina ────────────────────────────────────────────────────

export async function handleBacRoleRejected(webhookUrl) {
  await patchOriginal(webhookUrl, {
    content:
      "Tu n'as pas le rôle nécessaire (MINI-JEUX) pour lancer une partie.",
  });
}

const AUCUNE_PARTIE_SOLO = {
  embeds: [
    {
      description:
        "⏰ Aucune partie en cours (abandonnée après 1 h sans action). Relance `/bac` !",
      color: BAC_COLOR,
    },
  ],
  components: boutonsFin(),
};

const nomDeSolo = (pseudo) => (id) =>
  id === "bot" ? "Kévina" : (pseudo ?? "?");
const reglagesKevina = (config) => ({ trouve: config.trouve_kevina });

async function majSalonSolo(d, pseudo, config) {
  if (d.salon)
    await messageSalon(
      "PATCH",
      d.salon.channelId,
      d.salon.messageId,
      messageTable(d, nomDeSolo(pseudo), config),
    );
}

// Fin contre Kévina : récapitulatif dans un NOUVEAU message, table publique
// supprimée (repli : éditée en récapitulatif) ; la vue garde le résultat.
async function publierFinSolo(webhookUrl, channelId, d, pseudo, config) {
  const nomDe = nomDeSolo(pseudo);
  const s = d.series;
  const series = s
    ? lignesSeries({
        gagnant:
          d.gagnant === "joueur" && s.serie > 0
            ? { nom: pseudo, serie: s.serie }
            : null,
        perdant: d.gagnant === "bot" ? { nom: pseudo, avant: s.avant } : null,
        record: s.record,
        libelleSerie: () => "Série",
        libelleRecord: "Record",
      })
    : [];
  const final = messageFinal(d, nomDe, series);
  const ok = await messageSalon(
    "POST",
    d.salon?.channelId ?? channelId,
    null,
    final,
  );
  if (d.salon) {
    if (ok) await messageSalon("DELETE", d.salon.channelId, d.salon.messageId);
    else
      await messageSalon("PATCH", d.salon.channelId, d.salon.messageId, final);
  }
  await patchOriginal(webhookUrl, buildVue(d, { config }));
}

// Après une action contre Kévina : vue, table publique, fin éventuelle.
async function diffuserSolo(
  webhookUrl,
  d,
  { texte = null, channelId, pseudo, config, vientDeFinir = false },
) {
  if (vientDeFinir)
    return publierFinSolo(webhookUrl, channelId, d, pseudo, config);
  await Promise.all([
    patchOriginal(webhookUrl, buildVue(d, { texte, config })),
    majSalonSolo(d, pseudo, config),
  ]);
}

// Fin du temps de la manche `n` sans clic : l'invocation qui l'a ouverte
// attend l'échéance puis la clôt (si personne ne l'a fait).
async function surveillerMancheSolo(
  webhookUrl,
  discordId,
  d,
  config,
  { channelId, pseudo },
) {
  if (!mancheOuverte(d)) return;
  const n = d.manches.length;
  await pause(
    Math.max(0, echeanceDe(mancheCourante(d), config) * 1000 - Date.now()) +
      500,
  );
  const { duel, resultat: r } = await agirDuel(
    discordId,
    (x) => {
      if (
        x.manches.length !== n ||
        !tempsEcoule(x, config.delai_manche_secondes * 1000)
      )
        return {};
      cloreManche(x);
      return { clos: true, vientDeFinir: x.termine };
    },
    { nom: pseudo },
  );
  if (duel && r.clos)
    await diffuserSolo(webhookUrl, duel, {
      texte: "⏰ Temps écoulé !",
      channelId,
      pseudo,
      config,
      vientDeFinir: r.vientDeFinir,
    });
}

// Lance une partie : table publique dans le salon, puis vue éphémère du
// joueur EN DESSOUS (followup) ; repli : vue dans la réponse différée.
export async function handleBacCommand(webhookUrl, body) {
  try {
    const { discordId, username } = extractMember(body);
    const config = await loadDuelConfig();
    const { duel, ancien } = await nouveauDuel(discordId, {
      preparer: (d) => jouerKevina(d, "bot", reglagesKevina(config)),
    });
    if (ancien?.salon && !ancien.termine)
      await messageSalon(
        "DELETE",
        ancien.salon.channelId,
        ancien.salon.messageId,
      );
    const message = await messageSalon(
      "POST",
      body.channel_id,
      null,
      messageTable(duel, nomDeSolo(username), config),
    );
    const enregistre = message?.id
      ? await agirDuel(discordId, (d) => {
          d.salon = { channelId: body.channel_id, messageId: message.id };
        })
      : null;
    const d = enregistre?.duel ?? duel;
    const vue = buildVue(d, {
      texte: "Nouvelle partie contre Kévina !",
      config,
    });
    const followup =
      enregistre && (await supprimerOriginal(webhookUrl))
        ? await envoyerEphemere(webhookUrl, vue)
        : null;
    if (!followup) await patchOriginal(webhookUrl, vue);
    await surveillerMancheSolo(followup ?? webhookUrl, discordId, d, config, {
      channelId: body.channel_id,
      pseudo: username,
    });
  } catch (err) {
    console.error("[Petit Bac] Échec lancement:", err.message);
  }
}

// Action du joueur contre Kévina : { type: "mot", mot } | { type: "passer" }
// | { type: "suivante" } sur la manche `n`.
async function executerSolo(
  webhookUrl,
  discordId,
  action,
  n,
  { channelId, pseudo },
) {
  const config = await loadDuelConfig();
  const { duel, resultat: r } = await agirDuel(
    discordId,
    (d) => {
      if (d.termine) return { erreur: "termine" };
      if (action.type === "suivante") {
        if (d.manches.length !== n) return { erreur: "perime" };
        const e = mancheSuivante(d, { now: Date.now() });
        if (e.erreur) return e;
        jouerKevina(d, "bot", reglagesKevina(config));
        return { nouvelle: true };
      }
      if (d.manches.length !== n) return { erreur: "perime" };
      if (tempsEcoule(d, config.delai_manche_secondes * 1000)) {
        cloreManche(d);
        return { texte: avertissement("temps"), vientDeFinir: d.termine };
      }
      const m = mancheCourante(d);
      const res =
        action.type === "mot"
          ? proposer(d, "joueur", action.mot)
          : passer(d, "joueur");
      if (res.erreur) return res;
      return {
        texte: action.type === "mot" ? retour(m, "joueur", res) : null,
        vientDeFinir: d.termine,
      };
    },
    { nom: pseudo },
  );
  if (!duel) {
    await patchOriginal(webhookUrl, AUCUNE_PARTIE_SOLO);
    return;
  }
  const texte = r.erreur ? avertissement(r.erreur) : r.texte;
  await diffuserSolo(webhookUrl, duel, {
    texte,
    channelId,
    pseudo,
    config,
    vientDeFinir: r.vientDeFinir,
  });
  if (r.nouvelle)
    await surveillerMancheSolo(webhookUrl, discordId, duel, config, {
      channelId,
      pseudo,
    });
}

async function abandonSolo(webhookUrl, discordId, { channelId, pseudo }) {
  const config = await loadDuelConfig();
  const { duel, resultat: r } = await agirDuel(
    discordId,
    (d) => {
      if (d.termine) return { erreur: "termine" };
      Object.assign(d, { termine: true, gagnant: "bot", abandon: "joueur" });
      return {};
    },
    { nom: pseudo },
  );
  if (!duel) {
    await patchOriginal(webhookUrl, AUCUNE_PARTIE_SOLO);
    return;
  }
  if (r.erreur)
    await patchOriginal(
      webhookUrl,
      buildVue(duel, { texte: avertissement(r.erreur), config }),
    );
  else await publierFinSolo(webhookUrl, channelId, duel, pseudo, config);
}

// ── 1v1 ──────────────────────────────────────────────────────────────

function memoriserWebhook(partie, discordId, webhookUrl) {
  if (webhookUrl)
    partie.webhooks[discordId] = { url: webhookUrl, at: Date.now() };
}

function webhookValide(partie, discordId) {
  const w = partie.webhooks?.[discordId];
  return w && Date.now() - w.at < WEBHOOK_VALIDITE_MS ? w.url : null;
}

const nomDePvp = (partie) => (siege) =>
  partie.noms?.[partie.sieges?.[siege]] ?? "?";

function vuePvp(
  partie,
  config,
  discordId,
  texte = null,
  { confirmerAbandon = false } = {},
) {
  if (partie.statut === "lobby") {
    return {
      embeds: [
        {
          title: `${TITRE} · 1v1`,
          description: [
            ...(texte ? [texte, ""] : []),
            "⏳ En attente d'un adversaire : le premier qui clique sur **Jouer** dans le salon relève le défi.",
          ].join("\n"),
          color: BAC_COLOR,
        },
      ],
      components: [],
    };
  }
  const moi = siegeDe(partie, discordId);
  return buildVue(partie.duel, {
    texte,
    moi,
    A: nomsAdv(partie, moi),
    pvp: true,
    config,
    confirmerAbandon,
  });
}

const BOUTON_JOUER = {
  type: 2,
  style: 3,
  label: "Jouer",
  custom_id: "bacduel_ouvrir",
};

function messagePublic(partie, config) {
  if (partie.statut === "lobby") {
    return {
      embeds: [
        {
          title: `${TITRE} · 1v1`,
          description: `${partie.noms?.[partie.lanceur] ?? "?"} lance un duel ! Qui relève le défi ? Clique sur **Jouer** pour l'affronter.`,
          color: BAC_COLOR,
        },
      ],
      components: [{ type: 1, components: [BOUTON_JOUER, BOUTON_REGLES] }],
    };
  }
  return messageTable(partie.duel, nomDePvp(partie), config);
}

function messageFinalPvp(partie) {
  const d = partie.duel;
  const nomDe = nomDePvp(partie);
  const s = partie.series;
  const g = d.gagnant;
  const series =
    s && g !== "nul"
      ? lignesSeries({
          gagnant: { nom: nomDe(g), serie: s[g].serie },
          perdant: { nom: nomDe(adversaire(g)), avant: s[adversaire(g)].avant },
          record: s.record,
          libelleSerie: (n) => `Série ${deNom(n)}`,
          libelleRecord: "Record 1v1",
        })
      : [];
  return messageFinal(d, nomDe, series);
}

// Après un événement : vue de l'auteur (`texte`), vue de l'adversaire si
// `lesDeux` (webhook encore valable), message public ; en fin de partie,
// récapitulatif dans un nouveau message.
async function diffuserPvp(
  partie,
  config,
  discordId,
  webhookUrl,
  texte,
  { lesDeux = true } = {},
) {
  const autres = lesDeux
    ? Object.values(partie.sieges ?? {}).filter((id) => id !== discordId)
    : [];
  const vues = [
    patchOriginal(webhookUrl, vuePvp(partie, config, discordId, texte)),
    ...autres.map((id) =>
      patchOriginal(webhookValide(partie, id), vuePvp(partie, config, id)),
    ),
  ];
  if (partie.statut === "fini") {
    const ok = await messageSalon(
      "POST",
      partie.channelId,
      null,
      messageFinalPvp(partie),
    );
    if (ok) await messageSalon("DELETE", partie.channelId, partie.messageId);
    else
      await messageSalon(
        "PATCH",
        partie.channelId,
        partie.messageId,
        messageFinalPvp(partie),
      );
    await Promise.all(vues);
    return;
  }
  await Promise.all([
    ...vues,
    messageSalon(
      "PATCH",
      partie.channelId,
      partie.messageId,
      messagePublic(partie, config),
    ),
  ]);
}

// Fin du temps de la manche en cours sans clic (voir surveillerMancheSolo)
async function surveillerManchePvp(partie, config, discordId, webhookUrl) {
  if (partie.statut !== "enCours" || !mancheOuverte(partie.duel)) return;
  const n = partie.duel.manches.length;
  await pause(
    Math.max(
      0,
      echeanceDe(mancheCourante(partie.duel), config) * 1000 - Date.now(),
    ) + 500,
  );
  const r = await agirPvp((p) => {
    if (
      p.statut !== "enCours" ||
      p.duel.manches.length !== n ||
      !tempsEcoule(p.duel, config.delai_manche_secondes * 1000)
    )
      return {};
    cloreManche(p.duel);
    return { clos: true };
  });
  if (r.partie && r.resultat.clos)
    await diffuserPvp(
      r.partie,
      r.config,
      discordId,
      webhookValide(r.partie, discordId) ?? webhookUrl,
      "⏰ Temps écoulé !",
    );
}

const AUCUNE_PARTIE_PVP = {
  embeds: [
    {
      description:
        "⏰ Aucun duel 1v1 en cours. Lance-en un avec `/bac` (1v1) !",
      color: BAC_COLOR,
    },
  ],
  components: boutonsFin(),
};

// `/bac adversaire:1v1` : ouvre le lobby (message public), la réponse
// éphémère devient la vue du lanceur.
export async function handleBacPvpCommand(webhookUrl, body) {
  try {
    const { discordId, username } = extractMember(body);
    const r = await ouvrirPvp({
      channelId: body.channel_id,
      lanceur: discordId,
      nom: username,
    });
    if (r.dejaEnCours) {
      await patchOriginal(webhookUrl, {
        content: `Un duel 1v1 est déjà en cours dans <#${r.dejaEnCours.channelId}> : attends qu'il se termine.`,
      });
      return;
    }
    if (r.ancienne?.messageId)
      await messageSalon("DELETE", r.ancienne.channelId, r.ancienne.messageId);
    const config = await loadDuelConfig();
    const message = await messageSalon(
      "POST",
      body.channel_id,
      null,
      messagePublic(r.partie, config),
    );
    if (!message?.id) throw new Error("message public non créé");
    await enregistrerMessagePvp(message.id);
    const vue = vuePvp(
      r.partie,
      config,
      discordId,
      "🔤 Défi lancé dans le salon !",
    );
    const followup = (await supprimerOriginal(webhookUrl))
      ? await envoyerEphemere(webhookUrl, vue)
      : null;
    const { partie } = await agirPvp((p) => {
      memoriserWebhook(p, discordId, followup ?? webhookUrl);
    });
    // L'adversaire a pu rejoindre entre-temps
    const aJour =
      partie && partie.statut !== "lobby"
        ? vuePvp(partie, config, discordId)
        : null;
    if (!followup) await patchOriginal(webhookUrl, aJour ?? vue);
    else if (aJour) await patchOriginal(followup, aJour);
  } catch (err) {
    console.error("[Petit Bac] Échec lancement 1v1:", err.message);
    await patchOriginal(webhookUrl, {
      content: "⚠️ Erreur lors du lancement du duel.",
    });
  }
}

// [Jouer] du message public : rejoindre (2ᵉ joueur), sinon afficher sa vue
// (nouvel éphémère, mémorisé ; l'ancienne vue est supprimée).
export async function handleBacOuvrir(webhookUrl, body) {
  try {
    const { discordId, username } = extractMember(body);
    let ancienneVue = null;
    const {
      partie,
      config,
      resultat: r,
    } = await agirPvp((p) => {
      if (p.statut === "lobby" && discordId !== p.lanceur) {
        rejoindrePvp(p, discordId, username);
        memoriserWebhook(p, discordId, webhookUrl);
        return { rejoint: true, coup: true };
      }
      if (p.statut !== "lobby" && !siegeDe(p, discordId))
        return { erreur: "pasJoueur" };
      ancienneVue = webhookValide(p, discordId);
      memoriserWebhook(p, discordId, webhookUrl);
      return {};
    });
    await supprimerOriginal(ancienneVue);
    if (!partie) {
      await patchOriginal(webhookUrl, AUCUNE_PARTIE_PVP);
      return;
    }
    if (r.erreur) {
      const [a, b] = Object.values(partie.sieges);
      await patchOriginal(webhookUrl, {
        content: `Ce duel oppose ${partie.noms[a]} et ${partie.noms[b]}. Lance le tien avec \`/bac\` (1v1) une fois qu'il est terminé !`,
      });
      return;
    }
    if (r.rejoint) {
      await diffuserPvp(
        partie,
        config,
        discordId,
        webhookUrl,
        `⚔️ ${username} relève le défi !`,
      );
      await surveillerManchePvp(partie, config, discordId, webhookUrl);
      return;
    }
    await patchOriginal(webhookUrl, vuePvp(partie, config, discordId));
  } catch (err) {
    console.error("[Petit Bac] Échec Jouer 1v1:", err.message);
  }
}

async function executerPvp(webhookUrl, discordId, action, n) {
  const {
    partie,
    config,
    resultat: r,
  } = await agirPvp((p, config) => {
    const moi = siegeDe(p, discordId);
    if (!moi) return { erreur: p.statut === "lobby" ? "lobby" : "pasJoueur" };
    memoriserWebhook(p, discordId, webhookUrl);
    if (p.statut !== "enCours") return { erreur: "termine" };
    const d = p.duel;
    if (d.manches.length !== n) return { erreur: "perime" };
    if (action.type === "suivante") {
      const e = mancheSuivante(d, { now: Date.now() });
      return e.erreur ? e : { coup: true, nouvelle: true, lesDeux: true };
    }
    if (tempsEcoule(d, config.delai_manche_secondes * 1000)) {
      cloreManche(d);
      return { coup: true, texte: avertissement("temps"), lesDeux: true };
    }
    const m = mancheCourante(d);
    const res =
      action.type === "mot" ? proposer(d, moi, action.mot) : passer(d, moi);
    if (res.erreur) return res;
    // Manche close (les deux réponses figées) : les deux vues changent
    return {
      coup: true,
      texte: action.type === "mot" ? retour(m, moi, res) : null,
      lesDeux: !mancheOuverte(d),
    };
  });
  if (!partie) {
    await patchOriginal(webhookUrl, AUCUNE_PARTIE_PVP);
    return;
  }
  if (r.erreur === "pasJoueur") {
    await patchOriginal(webhookUrl, { content: avertissement("pasJoueur") });
    return;
  }
  const texte = r.erreur ? avertissement(r.erreur) : r.texte;
  if (r.coup || r.vientDeFinir) {
    await diffuserPvp(partie, config, discordId, webhookUrl, texte, {
      lesDeux: r.lesDeux || r.vientDeFinir,
    });
    if (r.nouvelle)
      await surveillerManchePvp(partie, config, discordId, webhookUrl);
    return;
  }
  await patchOriginal(webhookUrl, vuePvp(partie, config, discordId, texte));
}

async function abandonPvp(webhookUrl, discordId) {
  const {
    partie,
    config,
    resultat: r,
  } = await agirPvp((p) => {
    const moi = siegeDe(p, discordId);
    if (!moi) return { erreur: "pasJoueur" };
    memoriserWebhook(p, discordId, webhookUrl);
    if (p.statut !== "enCours") return { erreur: "termine" };
    Object.assign(p.duel, {
      termine: true,
      gagnant: adversaire(moi),
      abandon: moi,
    });
    p.raisonFin = "abandon";
    return {};
  });
  if (!partie) {
    await patchOriginal(webhookUrl, AUCUNE_PARTIE_PVP);
    return;
  }
  if (r.erreur === "pasJoueur") {
    await patchOriginal(webhookUrl, { content: avertissement("pasJoueur") });
    return;
  }
  if (r.vientDeFinir) {
    await diffuserPvp(partie, config, discordId, webhookUrl, null);
    return;
  }
  await patchOriginal(
    webhookUrl,
    vuePvp(partie, config, discordId, avertissement("termine")),
  );
}

// ── Points d'entrée des composants ───────────────────────────────────

// Fenêtre de saisie soumise : proposition du mot `mot` pour la manche `n`.
export async function handleBacMot(
  webhookUrl,
  discordId,
  n,
  mot,
  { pvp = false, channelId, pseudo } = {},
) {
  try {
    const action = { type: "mot", mot: String(mot ?? "").slice(0, 40) };
    if (pvp) await executerPvp(webhookUrl, discordId, action, n);
    else
      await executerSolo(webhookUrl, discordId, action, n, {
        channelId,
        pseudo,
      });
  } catch (err) {
    console.error("[Petit Bac] Échec proposition:", err.message);
  }
}

// [⏭️ Passer] / [✅ Valider] (type "passer") et [▶️ Manche suivante] (type "suivante")
export async function handleBacAction(
  webhookUrl,
  discordId,
  type,
  n,
  { pvp = false, channelId, pseudo } = {},
) {
  try {
    if (!["passer", "suivante"].includes(type)) return;
    if (pvp) await executerPvp(webhookUrl, discordId, { type }, n);
    else
      await executerSolo(webhookUrl, discordId, { type }, n, {
        channelId,
        pseudo,
      });
  } catch (err) {
    console.error("[Petit Bac] Échec action:", err.message);
  }
}

// [🏳️] (`etape` "demande") : confirmation ; "non" : retour à la vue ; "ok" : abandon.
export async function handleBacAbandon(
  webhookUrl,
  discordId,
  etape,
  { pvp = false, channelId, pseudo } = {},
) {
  try {
    if (etape === "ok") {
      if (pvp) await abandonPvp(webhookUrl, discordId);
      else await abandonSolo(webhookUrl, discordId, { channelId, pseudo });
      return;
    }
    const confirmerAbandon = etape === "demande";
    const config = await loadDuelConfig();
    if (!pvp) {
      const duel = await readDuel(discordId);
      await patchOriginal(
        webhookUrl,
        duel
          ? buildVue(duel, { config, confirmerAbandon })
          : AUCUNE_PARTIE_SOLO,
      );
      return;
    }
    const partie = await readPvp();
    if (!partie) {
      await patchOriginal(webhookUrl, AUCUNE_PARTIE_PVP);
      return;
    }
    if (!siegeDe(partie, discordId)) {
      await patchOriginal(webhookUrl, { content: avertissement("pasJoueur") });
      return;
    }
    await patchOriginal(
      webhookUrl,
      vuePvp(partie, config, discordId, null, { confirmerAbandon }),
    );
  } catch (err) {
    console.error("[Petit Bac] Échec abandon:", err.message);
  }
}

// [📖 Règles] : nouvel éphémère.
export async function handleBacRegles(webhookUrl) {
  try {
    await patchOriginal(webhookUrl, {
      embeds: [buildReglesEmbed(await loadDuelConfig())],
    });
  } catch (err) {
    console.error("[Petit Bac] Échec Règles:", err.message);
  }
}
