// ============================================================
// penduDuel.js (handler) — Pendu (`/pendu`), 1v1 seulement : message
// public (bouton Jouer dans le lobby : rejoindre ; puis Ma vue) et une vue
// éphémère par joueur. Les deux joueurs cherchent le même mot, chacun de
// son côté : le message public dit seulement qui est encore en jeu et qui
// a terminé ; le mot et les deux potences sont dévoilés à la fin.
// 1 minute par action, sinon pendu : l'invocation de chaque action attend
// l'échéance du joueur puis l'applique si rien n'a bougé (surveiller()).
// Réservé au rôle MINI-JEUX pour lancer (rejoindre ne l'exige pas).
//
// custom_id : penduduel_lettre:<lettre> (voyelles, boutons),
// penduduel_consonne (menu, lettre dans values), penduduel_proposer (ouvre
// la fenêtre de saisie, réponse synchrone dans la route), penduduel_mot
// (fenêtre soumise), penduduel_ouvrir (Jouer / Ma vue du message public),
// penduduel_regles, penduduel_abandon (🏳️, confirmation),
// penduduel_abandon_ok / penduduel_abandon_non.
//
// Service : jeux/services/penduDuel.js (Redis), règles :
// jeux/services/penduRules.js, images : jeux/services/penduImage.js.
// ============================================================

import {
  agirPvp,
  enregistrerMessagePvp,
  loadDuelConfig,
  ouvrirPvp,
  readPvp,
  rejoindrePvp,
  siegeDe,
} from "../../services/penduDuel.js";
import {
  CONSONNES,
  ERREURS_MAX,
  ERREURS_MOT_FAUX,
  SIEGES,
  VOYELLES,
  abandonner,
  adversaire,
  echeance,
  lettresDecouvertes,
  lettresFausses,
  motif,
  proposerLettre,
  proposerMot,
} from "../../services/penduRules.js";
import { encodeFinal, encodeVue } from "../../services/penduImage.js";
import {
  getRoleIdByName,
  MINI_JEUX_ROLE_NAME,
} from "@clash/commun/discordRoles.js";

const PENDU_COLOR = 0x8d6e63;
const TITRE = "🪢 Pendu";
const TRUST_ROYALE_URL = "https://trustroyale.vercel.app";
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

export function versV2({ content = null, embeds = [], components = [], ...reste }) {
  const blocs = [];
  if (content) blocs.push({ type: 10, content });
  const [embed] = embeds;
  if (embed) {
    const texte = [embed.title ? `### ${embed.title}` : null, embed.description].filter(Boolean).join("\n");
    blocs.push({
      type: 17,
      accent_color: embed.color ?? PENDU_COLOR,
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
const urlMessage = (webhookUrl) => (webhookUrl.includes("/messages/") ? webhookUrl : `${webhookUrl}/messages/@original`);

async function patchOriginal(webhookUrl, payload) {
  if (!webhookUrl) return;
  try {
    const res = await fetch(urlMessage(webhookUrl), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(versV2(payload)),
    });
    if (!res.ok) console.error(`[Pendu] PATCH refusé (${res.status}) :`, (await res.text()).slice(0, 300));
  } catch (err) {
    console.error("[Pendu] Échec PATCH:", err.message);
  }
}

async function supprimerOriginal(webhookUrl) {
  if (!webhookUrl) return false;
  try {
    return (await fetch(urlMessage(webhookUrl), { method: "DELETE" })).ok;
  } catch (err) {
    console.error("[Pendu] Échec DELETE:", err.message);
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
      console.error(`[Pendu] Followup refusé (${res.status}) :`, (await res.text()).slice(0, 300));
      return null;
    }
    const { id } = await res.json();
    return id ? `${webhookUrl}/messages/${id}` : null;
  } catch (err) {
    console.error("[Pendu] Échec followup:", err.message);
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
      headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
      // Jamais de ping dans ce jeu
      ...(payload ? { body: JSON.stringify({ allowed_mentions: { parse: [] }, ...versV2(payload) }) } : {}),
    });
    if (!res.ok && res.status !== 404) {
      console.warn(`[Pendu] Échec ${method} du message public (${res.status}).`);
      return null;
    }
    return method === "POST" ? await res.json() : {};
  } catch (err) {
    console.warn(`[Pendu] Erreur réseau (${method} message public):`, err.message);
    return null;
  }
}

// ── Mise en forme ────────────────────────────────────────────────────

const plural = (n, mot) => `${n} ${mot}${n > 1 ? "s" : ""}`;
const nomDe = (partie) => (siege) => partie.noms?.[partie.sieges?.[siege]] ?? "?";
const motAffiche = (d) => d.mot.charAt(0).toUpperCase() + d.mot.slice(1);

const ERREURS = {
  lettre: "Lettre invalide.",
  dejaJouee: "Lettre déjà proposée.",
  vide: "Mot vide.",
  fini: "Ta partie est finie.",
  temps: "Temps écoulé : pendu !",
  termine: "La partie est terminée.",
  pasJoueur: "Tu ne joues pas dans ce duel.",
  lobby: "En attente d'un adversaire.",
};
const avertissement = (code) => `⚠️ ${ERREURS[code] || "Action impossible."}`;

// Résultat d'une proposition
function retour(action, r) {
  if (action.type === "lettre") {
    return r.present ? `✅ **${action.lettre}** : ${r.nb} fois dans le mot.` : `❌ Pas de **${action.lettre}** dans le mot.`;
  }
  return r.juste ? "🎉 C'est le mot !" : `❌ **${action.mot}** n'est pas le mot (+${ERREURS_MOT_FAUX} erreurs).`;
}

const urlVue = (d, siege) =>
  `${TRUST_ROYALE_URL}/api/pendu/vue?d=${encodeVue({ motif: motif(d, siege), fausses: lettresFausses(d, siege), erreurs: d.joueurs[siege].erreurs, fin: d.joueurs[siege].fin })}`;

const urlFinal = (partie) => {
  const d = partie.duel;
  const n = nomDe(partie);
  return `${TRUST_ROYALE_URL}/api/pendu/final?d=${encodeFinal({
    mot: d.mot,
    joueurs: SIEGES.map((s) => ({ nom: n(s), erreurs: d.joueurs[s].erreurs, decouvertes: lettresDecouvertes(d, s), fin: d.joueurs[s].fin })),
    gagnant: SIEGES.indexOf(d.gagnant),
  })}`;
};

const FINS = {
  trouve: (j) => `🎉 Trouvé avec ${plural(j.erreurs, "erreur")} !`,
  pendu: () => "💀 Pendu !",
  temps: () => "⏰ Temps écoulé : pendu !",
};

// ── Vues ─────────────────────────────────────────────────────────────

const BOUTON_REGLES = { type: 2, style: 2, label: "Règles", emoji: { name: "📖" }, custom_id: "penduduel_regles" };
const boutonsFin = () => [{ type: 1, components: [BOUTON_REGLES] }];
const BOUTON_ABANDON = { type: 2, style: 2, emoji: { name: "🏳️" }, custom_id: "penduduel_abandon" };

const BOUTONS_CONFIRMATION = [
  {
    type: 1,
    components: [
      { type: 2, style: 4, label: "Abandonner", emoji: { name: "🏳️" }, custom_id: "penduduel_abandon_ok" },
      { type: 2, style: 2, label: "Annuler", custom_id: "penduduel_abandon_non" },
    ],
  },
];

const boutonVoyelle = (l, jouee) => ({ type: 2, style: 2, label: l, custom_id: `penduduel_lettre:${l}`, disabled: jouee });

// Voyelles A E I O U en boutons, puis Y, Proposer le mot, Règles, abandon ;
// consonnes restantes dans un menu (au plus 20 options, sous la limite de 25).
function boutonsJeu(j) {
  const jouee = (l) => j.lettres.includes(l);
  const [y, autres] = [VOYELLES.at(-1), VOYELLES.slice(0, -1)];
  const restantes = CONSONNES.filter((l) => !jouee(l));
  return [
    { type: 1, components: autres.map((l) => boutonVoyelle(l, jouee(l))) },
    {
      type: 1,
      components: [
        boutonVoyelle(y, jouee(y)),
        { type: 2, style: 1, label: "Proposer le mot", emoji: { name: "✏️" }, custom_id: "penduduel_proposer" },
        BOUTON_REGLES,
        BOUTON_ABANDON,
      ],
    },
    ...(restantes.length
      ? [
          {
            type: 1,
            components: [
              {
                type: 3,
                custom_id: "penduduel_consonne",
                placeholder: "Choisir une consonne",
                options: restantes.map((l) => ({ label: l, value: l })),
              },
            ],
          },
        ]
      : []),
  ];
}

// « 🏆 Alice bat Bob : … », égalité, abandon (sièges du moteur)
function resultat(partie) {
  const d = partie.duel;
  const n = nomDe(partie);
  if (d.abandon) return `🏳️ ${n(d.abandon)} abandonne : ${n(adversaire(d.abandon))} remporte la partie.`;
  const [a, b] = SIEGES.map((s) => d.joueurs[s]);
  const trouves = [a, b].filter((j) => j.fin === "trouve").length;
  if (d.gagnant === "nul") {
    return trouves === 2
      ? `🤝 Égalité : ${n("joueur")} et ${n("bot")} trouvent le mot avec ${plural(a.erreurs, "erreur")}.`
      : `🤝 Égalité : deux pendus, ${plural(lettresDecouvertes(d, "joueur"), "lettre")} découverte${lettresDecouvertes(d, "joueur") > 1 ? "s" : ""} chacun.`;
  }
  const g = d.gagnant;
  const p = adversaire(g);
  if (trouves === 2)
    return `🏆 ${n(g)} bat ${n(p)} : mot trouvé avec ${plural(d.joueurs[g].erreurs, "erreur")} contre ${d.joueurs[p].erreurs}.`;
  if (trouves === 1)
    return `🏆 ${n(g)} trouve le mot, ${n(p)} ${d.joueurs[p].fin === "temps" ? "n'a pas joué à temps" : "est pendu"}.`;
  return `🏆 Deux pendus, mais ${n(g)} a découvert ${lettresDecouvertes(d, g)} lettres contre ${lettresDecouvertes(d, p)}.`;
}

// Vue d'un joueur. `ctx` : { texte, config, confirmerAbandon }.
function buildVue(partie, discordId, { texte = null, config, confirmerAbandon = false } = {}) {
  const d = partie.duel;
  const moi = siegeDe(partie, discordId);
  const A = nomDe(partie)(adversaire(moi));
  const titre = `${TITRE} · contre ${A}`;
  const j = d.joueurs[moi];
  if (d.termine) {
    const issue = d.gagnant === "nul" ? "🤝 Égalité !" : d.gagnant === moi ? "🏆 Victoire !" : "💀 Défaite…";
    return {
      embeds: [
        {
          title: titre,
          description: [...(texte ? [texte, ""] : []), resultat(partie), `Le mot était **${motAffiche(d)}**.`, "", `${issue} La partie est terminée.`].join("\n"),
          image: { url: d.abandon ? urlVue(d, moi) : urlFinal(partie) },
          color: PENDU_COLOR,
        },
      ],
      components: boutonsFin(),
    };
  }
  if (confirmerAbandon) {
    return {
      embeds: [{ title: titre, description: "🏳️ **Abandonner la partie ?** Ce sera une défaite.", color: PENDU_COLOR }],
      components: BOUTONS_CONFIRMATION,
    };
  }
  const faux = j.motsFaux.length ? [`Mots refusés : ${j.motsFaux.map((m) => `~~${m}~~`).join(", ")}`] : [];
  if (j.fin) {
    return {
      embeds: [
        {
          title: titre,
          description: [...(texte ? [texte] : []), FINS[j.fin](j), ...faux, `⏳ En attente de ${A}…`].join("\n"),
          image: { url: urlVue(d, moi) },
          color: PENDU_COLOR,
        },
      ],
      components: boutonsFin(),
    };
  }
  const limite = Math.floor(echeance(d, moi, config.delai_action_secondes * 1000) / 1000);
  return {
    embeds: [
      {
        title: titre,
        description: [
          `Mot de **${d.cible.length} lettres** · ${plural(j.erreurs, "erreur")} sur ${ERREURS_MAX}`,
          ...(texte ? [texte] : []),
          ...faux,
          `⏰ Prochaine lettre avant <t:${limite}:R>`,
        ].join("\n"),
        image: { url: urlVue(d, moi) },
        color: PENDU_COLOR,
      },
    ],
    components: boutonsJeu(j),
  };
}

// Fenêtre de saisie (réponse synchrone de la route, sans état lu)
export function buildModalMot() {
  return {
    custom_id: "penduduel_mot",
    title: "Proposer le mot",
    components: [
      {
        type: 1,
        components: [
          {
            type: 4,
            custom_id: "penduduel_mot_input",
            style: 1,
            label: `Ton mot (faux : +${ERREURS_MOT_FAUX} erreurs)`,
            placeholder: "Accents et majuscules ignorés",
            required: true,
            max_length: 30,
          },
        ],
      },
    ],
  };
}

function buildReglesEmbed(config) {
  return {
    title: "📖 Règles du Pendu",
    description: [
      "Les deux joueurs cherchent **le même mot**, chacun de son côté. Tu ne vois ni les lettres ni l'avancement de ton adversaire, seulement s'il a terminé.",
      "",
      "🔤 Voyelles en boutons, consonnes dans le menu. Une lettre absente du mot ajoute une erreur.",
      `✏️ **Proposer le mot** à tout moment : un mot faux compte ${ERREURS_MOT_FAUX} erreurs.`,
      `💀 **${ERREURS_MAX} erreurs** : pendu.`,
      `⏰ **${plural(config.delai_action_secondes, "seconde")}** par action, sinon pendu.`,
      "",
      "**Fin de partie** : quand les deux ont fini, le mot et les deux potences sont dévoilés.",
      "🏆 Celui qui trouve le mot bat celui qui est pendu. Les deux trouvent : le moins d'erreurs gagne. Deux pendus : le plus de lettres découvertes gagne. Sinon, égalité.",
      "",
      "Le mot est un nom commun de 4 à 11 lettres. Accents ignorés : **E** révèle aussi É, È, Ê.",
      "**🏳️ Abandon** : défaite immédiate (après confirmation).",
    ].join("\n"),
    color: PENDU_COLOR,
  };
}

// ── Séries de victoires (message de fin) ─────────────────────────────

const SERIE_CASSEE_MIN = 2;
const victoires = (n) => (n > 1 ? `${n} victoires d'affilée` : `${n} victoire`);
const deNom = (pseudo) => (/^[aeiouyhàâéèêëîïôûAEIOUYHÀÂÉÈÊËÎÏÔÛ]/.test(pseudo) ? `d'${pseudo}` : `de ${pseudo}`);

function lignesSeries(partie) {
  const s = partie.series;
  const g = partie.duel.gagnant;
  if (!s || g === "nul") return [];
  const n = nomDe(partie);
  const p = adversaire(g);
  const rec = s.record ? `Record : ${s.record.username ?? "?"} (${s.record.serie})` : null;
  const lignes = [[`🔥 Série ${deNom(n(g))} : ${victoires(s[g].serie)}`, rec].filter(Boolean).join(" · ")];
  if (s[p].avant >= SERIE_CASSEE_MIN) lignes.push(`💔 Fin de la série ${deNom(n(p))} (${s[p].avant})`);
  return lignes;
}

// ── Message public ───────────────────────────────────────────────────

const BOUTON_MA_VUE = { type: 2, style: 2, label: "Ma vue", emoji: { name: "🎮" }, custom_id: "penduduel_ouvrir" };
const BOUTON_JOUER = { type: 2, style: 3, label: "Jouer", custom_id: "penduduel_ouvrir" };

function messagePublic(partie) {
  const n = nomDe(partie);
  if (partie.statut === "lobby") {
    return {
      embeds: [
        {
          title: `${TITRE} · 1v1`,
          description: `${partie.noms?.[partie.lanceur] ?? "?"} lance un duel ! Qui relève le défi ? Clique sur **Jouer** pour l'affronter.`,
          color: PENDU_COLOR,
        },
      ],
      components: [{ type: 1, components: [BOUTON_JOUER, BOUTON_REGLES] }],
    };
  }
  const d = partie.duel;
  if (partie.statut === "fini") {
    const series = lignesSeries(partie);
    return {
      embeds: [
        {
          title: `${TITRE} · ${n("joueur")} contre ${n("bot")}`,
          description: [resultat(partie), `Le mot était **${motAffiche(d)}**.`, ...(series.length ? ["", ...series] : [])].join("\n"),
          ...(d.abandon ? {} : { image: { url: urlFinal(partie) } }),
          color: PENDU_COLOR,
        },
      ],
      components: boutonsFin(),
    };
  }
  // Partie en cours : seulement qui joue encore et qui a terminé
  return {
    embeds: [
      {
        title: `${TITRE} · ${n("joueur")} contre ${n("bot")}`,
        description: [
          `Mot de **${d.cible.length} lettres**, le même pour les deux.`,
          "",
          ...SIEGES.map((s) => (d.joueurs[s].fin ? `✔️ ${n(s)} a terminé.` : `⏳ ${n(s)} : en cours`)),
        ].join("\n"),
        color: PENDU_COLOR,
      },
    ],
    // [🎮 Ma vue] renvoie sa vue à chaque joueur (vue perdue plus haut
    // dans le salon, autre appareil)
    components: [{ type: 1, components: [BOUTON_MA_VUE, BOUTON_REGLES] }],
  };
}

// ── Diffusion ────────────────────────────────────────────────────────

export async function handlePenduRoleRejected(webhookUrl) {
  await patchOriginal(webhookUrl, { content: "Tu n'as pas le rôle nécessaire (MINI-JEUX) pour lancer une partie." });
}

function memoriserWebhook(partie, discordId, webhookUrl) {
  if (webhookUrl) partie.webhooks[discordId] = { url: webhookUrl, at: Date.now() };
}

function webhookValide(partie, discordId) {
  const w = partie.webhooks?.[discordId];
  return w && Date.now() - w.at < WEBHOOK_VALIDITE_MS ? w.url : null;
}

const finis = (partie) => (partie.duel ? SIEGES.filter((s) => partie.duel.joueurs[s].fin).length : 0);

// Après un événement : vue de l'auteur (`texte`, s'il y en a un), vues des
// joueurs `autres` (sièges ; webhook encore valable), message public si
// `publicAussi` ; en fin de partie, les deux vues et le récapitulatif dans
// un NOUVEAU message (l'ancien supprimé ; repli : édition).
async function diffuser(partie, config, { auteur = null, webhookUrl = null, texte = null, autres = [], publicAussi = false }) {
  const fini = partie.statut === "fini";
  const cibles = fini ? Object.values(partie.sieges).filter((id) => id !== auteur) : autres.map((s) => partie.sieges[s]).filter((id) => id !== auteur);
  const vues = [
    ...(auteur ? [patchOriginal(webhookUrl, buildVue(partie, auteur, { texte, config }))] : []),
    ...cibles.map((id) => patchOriginal(webhookValide(partie, id), buildVue(partie, id, { config }))),
  ];
  if (fini) {
    const final = messagePublic(partie);
    const ok = await messageSalon("POST", partie.channelId, null, final);
    if (ok) await messageSalon("DELETE", partie.channelId, partie.messageId);
    else await messageSalon("PATCH", partie.channelId, partie.messageId, final);
  } else if (publicAussi) vues.push(messageSalon("PATCH", partie.channelId, partie.messageId, messagePublic(partie)));
  await Promise.all(vues);
}

// Délais dépassés appliqués par agirPvp() : les joueurs concernés voient
// leur vue changer, le message public aussi.
const optionsDelais = (r) => ({ autres: r.delais ?? [], publicAussi: (r.delais ?? []).length > 0 });

// Fin du délai sans clic : l'invocation attend l'échéance des joueurs
// `sieges` encore en jeu, puis applique les délais dépassés. Chaque action
// relaie la surveillance de son auteur (la dernière action de chacun est
// toujours surveillée).
async function surveiller(partie, config, sieges) {
  if (partie.statut !== "enCours") return;
  const delaiMs = config.delai_action_secondes * 1000;
  const echeances = sieges.map((s) => echeance(partie.duel, s, delaiMs)).filter((t) => t !== null);
  if (!echeances.length) return;
  await pause(Math.max(0, Math.min(...echeances) - Date.now()) + 1000);
  const r = await agirPvp(() => ({}));
  if (r.partie && (r.resultat.delais.length || r.resultat.vientDeFinir)) await diffuser(r.partie, r.config, optionsDelais(r.resultat));
}

const AUCUNE_PARTIE = {
  embeds: [{ description: "⏰ Aucun duel en cours. Lance-en un avec `/pendu` !", color: PENDU_COLOR }],
  components: boutonsFin(),
};

// `/pendu` : ouvre le lobby (message public), la réponse éphémère devient
// la vue du lanceur.
export async function handlePenduCommand(webhookUrl, body) {
  try {
    const { discordId, username } = extractMember(body);
    const r = await ouvrirPvp({ channelId: body.channel_id, lanceur: discordId, nom: username });
    if (r.dejaEnCours) {
      await patchOriginal(webhookUrl, { content: `Un duel de Pendu est déjà en cours dans <#${r.dejaEnCours.channelId}> : attends qu'il se termine.` });
      return;
    }
    if (r.ancienne?.messageId) await messageSalon("DELETE", r.ancienne.channelId, r.ancienne.messageId);
    const config = await loadDuelConfig();
    const message = await messageSalon("POST", body.channel_id, null, messagePublic(r.partie));
    if (!message?.id) throw new Error("message public non créé");
    await enregistrerMessagePvp(message.id);
    const attente = {
      embeds: [
        {
          title: `${TITRE} · 1v1`,
          description: "🪢 Défi lancé dans le salon !\n\n⏳ En attente d'un adversaire : le premier qui clique sur **Jouer** dans le salon relève le défi.",
          color: PENDU_COLOR,
        },
      ],
      components: [],
    };
    const followup = (await supprimerOriginal(webhookUrl)) ? await envoyerEphemere(webhookUrl, attente) : null;
    const { partie } = await agirPvp((p) => {
      memoriserWebhook(p, discordId, followup ?? webhookUrl);
    });
    // L'adversaire a pu rejoindre entre-temps
    const aJour = partie && partie.statut !== "lobby" ? buildVue(partie, discordId, { config }) : null;
    if (!followup) await patchOriginal(webhookUrl, aJour ?? attente);
    else if (aJour) await patchOriginal(followup, aJour);
  } catch (err) {
    console.error("[Pendu] Échec lancement:", err.message);
    await patchOriginal(webhookUrl, { content: "⚠️ Erreur lors du lancement du duel." });
  }
}

// [Jouer] / [🎮 Ma vue] du message public : rejoindre (2ᵉ joueur), sinon
// afficher sa vue (nouvel éphémère, mémorisé ; l'ancienne vue est supprimée).
export async function handlePenduOuvrir(webhookUrl, body) {
  try {
    const { discordId, username } = extractMember(body);
    let ancienneVue = null;
    const { partie, config, resultat: r } = await agirPvp((p) => {
      if (p.statut === "lobby" && discordId !== p.lanceur) {
        rejoindrePvp(p, discordId, username);
        memoriserWebhook(p, discordId, webhookUrl);
        return { rejoint: true, coup: true };
      }
      if (p.statut !== "lobby" && !siegeDe(p, discordId)) return { erreur: "pasJoueur" };
      ancienneVue = webhookValide(p, discordId);
      memoriserWebhook(p, discordId, webhookUrl);
      return {};
    });
    await supprimerOriginal(ancienneVue);
    if (!partie) {
      await patchOriginal(webhookUrl, AUCUNE_PARTIE);
      return;
    }
    if (r.erreur) {
      const [a, b] = Object.values(partie.sieges);
      await patchOriginal(webhookUrl, {
        content: `Ce duel oppose ${partie.noms[a]} et ${partie.noms[b]}. Lance le tien avec \`/pendu\` une fois qu'il est terminé !`,
      });
      return;
    }
    if (r.rejoint) {
      await diffuser(partie, config, { auteur: discordId, webhookUrl, texte: `⚔️ Tu relèves le défi de ${partie.noms[partie.lanceur]} !`, autres: SIEGES, publicAussi: true });
      // Les deux chronos démarrent maintenant
      await surveiller(partie, config, SIEGES);
      return;
    }
    if (partie.statut === "lobby") {
      await patchOriginal(webhookUrl, { content: "⏳ En attente d'un adversaire." });
      return;
    }
    await diffuser(partie, config, { auteur: discordId, webhookUrl, ...optionsDelais(r) });
  } catch (err) {
    console.error("[Pendu] Échec Jouer:", err.message);
  }
}

// Action d'un joueur : { type: "lettre", lettre } | { type: "mot", mot }.
async function executer(webhookUrl, discordId, action) {
  const { partie, config, resultat: r } = await agirPvp((p) => {
    const moi = siegeDe(p, discordId);
    if (!moi) return { erreur: p.statut === "lobby" ? "lobby" : "pasJoueur" };
    memoriserWebhook(p, discordId, webhookUrl);
    if (p.statut !== "enCours") return { erreur: "termine" };
    const fin = p.duel.joueurs[moi].fin;
    // Délai dépassé (appliqué juste avant par agirPvp()) : pendu
    if (fin) return { erreur: fin === "temps" ? "temps" : "fini" };
    const avant = finis(p);
    const res = action.type === "lettre" ? proposerLettre(p.duel, moi, action.lettre) : proposerMot(p.duel, moi, action.mot);
    if (res.erreur) return res;
    return { coup: true, texte: retour(action, res), publicAussi: finis(p) !== avant };
  });
  if (!partie) {
    await patchOriginal(webhookUrl, AUCUNE_PARTIE);
    return;
  }
  if (r.erreur === "pasJoueur" || r.erreur === "lobby") {
    await patchOriginal(webhookUrl, { content: avertissement(r.erreur) });
    return;
  }
  const delais = optionsDelais(r);
  await diffuser(partie, config, {
    auteur: discordId,
    webhookUrl,
    texte: r.erreur ? avertissement(r.erreur) : r.texte,
    autres: delais.autres,
    publicAussi: r.publicAussi || delais.publicAussi,
  });
  // L'auteur est toujours en jeu : son nouveau délai est surveillé ici
  if (r.coup) await surveiller(partie, config, [siegeDe(partie, discordId)]);
}

// [Voyelle] ou menu des consonnes
export async function handlePenduLettre(webhookUrl, discordId, lettre) {
  try {
    await executer(webhookUrl, discordId, { type: "lettre", lettre: String(lettre ?? "").slice(0, 1) });
  } catch (err) {
    console.error("[Pendu] Échec lettre:", err.message);
  }
}

// Fenêtre de saisie soumise
export async function handlePenduMot(webhookUrl, discordId, mot) {
  try {
    await executer(webhookUrl, discordId, { type: "mot", mot: String(mot ?? "").slice(0, 30) });
  } catch (err) {
    console.error("[Pendu] Échec proposition:", err.message);
  }
}

async function abandon(webhookUrl, discordId) {
  const { partie, config, resultat: r } = await agirPvp((p) => {
    const moi = siegeDe(p, discordId);
    if (!moi) return { erreur: "pasJoueur" };
    memoriserWebhook(p, discordId, webhookUrl);
    if (p.statut !== "enCours") return { erreur: "termine" };
    // Partie finie de son côté : on attend l'adversaire, plus d'abandon
    if (p.duel.joueurs[moi].fin) return { erreur: "fini" };
    return abandonner(p.duel, moi);
  });
  if (!partie) {
    await patchOriginal(webhookUrl, AUCUNE_PARTIE);
    return;
  }
  if (r.erreur === "pasJoueur") {
    await patchOriginal(webhookUrl, { content: avertissement("pasJoueur") });
    return;
  }
  await diffuser(partie, config, { auteur: discordId, webhookUrl, texte: r.erreur ? avertissement(r.erreur) : null });
}

// [🏳️] (`etape` "demande") : confirmation ; "non" : retour à la vue ; "ok" : abandon.
export async function handlePenduAbandon(webhookUrl, discordId, etape) {
  try {
    if (etape === "ok") {
      await abandon(webhookUrl, discordId);
      return;
    }
    const config = await loadDuelConfig();
    const partie = await readPvp();
    if (!partie || partie.statut === "lobby") {
      await patchOriginal(webhookUrl, AUCUNE_PARTIE);
      return;
    }
    if (!siegeDe(partie, discordId)) {
      await patchOriginal(webhookUrl, { content: avertissement("pasJoueur") });
      return;
    }
    await patchOriginal(webhookUrl, buildVue(partie, discordId, { config, confirmerAbandon: etape === "demande" }));
  } catch (err) {
    console.error("[Pendu] Échec abandon:", err.message);
  }
}

// [📖 Règles] : nouvel éphémère.
export async function handlePenduRegles(webhookUrl) {
  try {
    await patchOriginal(webhookUrl, { embeds: [buildReglesEmbed(await loadDuelConfig())] });
  } catch (err) {
    console.error("[Pendu] Échec Règles:", err.message);
  }
}
