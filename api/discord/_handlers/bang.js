// ============================================================
// bang.js — Handlers Discord de Bang! (jeu spécial de 7 jours inspiré
// d'Exploding Kittens). Un seul message officiel par jour (survivants,
// pioche, derniers événements), réédité en direct après chaque action,
// avec quatre boutons, chacun en éphémère : Piocher (la carte piochée),
// Jouer une carte (le deck et le menu des cartes, puis des cibles, édités
// en place), Journal (ce qui concerne le joueur) et Règles.
//
// La publication/clôture quotidienne passe uniquement par
// scripts/postBang.js (postBang) ; la fin de partie peut aussi survenir
// en cours de journée, quand il ne reste qu'un Roi (terminerPartie).
//
// ⚠️ Les mains restent secrètes : seul l'éphémère montre au joueur ses
// cartes. Le Moine joué reste secret ; les attaques et explosions sont
// annoncées dans le message officiel.
// ============================================================

import {
  loadBangConfig,
  readState,
  writeState,
  readPartie,
  initPartie,
  agir,
  previewCloture,
  closeDayAndAdvance,
  figerResultat,
  archiveManche,
  listManches,
  isTooSoonSinceLastClosure,
} from "../../../backend/services/bang.js";
import {
  CARTES,
  JOUABLES,
  CIBLEES,
  POSITIONS,
  piocherClic,
  placer,
  jouer,
  vivants,
  nbBombes,
  nbEsprits,
  texteJournal,
} from "../../../backend/services/bangRules.js";
import {
  encodeTable,
  NB_AVATARS,
} from "../../../backend/services/bangImage.js";
import {
  getRoleIdByName,
  buildRolePingFields,
  MINI_JEUX_ROLE_NAME,
} from "../../../backend/services/discordRoles.js";
import { formatUtcTimeAsParis } from "../../../backend/services/dateUtils.js";

const BANG_COLOR = 0xc0392b;
const TRUST_ROYALE_URL = "https://trustroyale.vercel.app";
const JOURNAL_AFFICHE = 10;

function illustrationUrl() {
  return `${TRUST_ROYALE_URL}/api/bang/illustration?v=${Date.now()}`;
}

// Plateau d'avancement : survivants (ordre alphabétique) puis éliminés
// (ordre d'élimination), comme dans le texte du message. Avatar selon
// l'ordre d'arrivée, décalé au hasard à chaque partie : tous différents
// jusqu'à NB_AVATARS joueurs.
function tableImageUrl(jour, config, partie) {
  const tous = Object.values(partie.joueurs);
  const rois = [
    ...tous
      .filter((j) => j.vivant)
      .sort((a, b) => a.username.localeCompare(b.username)),
    ...tous
      .filter((j) => !j.vivant)
      .sort((a, b) => a.rangElimination - b.rangElimination),
  ].map((j) => ({
    nom: j.username,
    cartes: j.main.length,
    vivant: j.vivant,
    avatar: (j.arrivee + (partie.decalageAvatars ?? 0)) % NB_AVATARS,
  }));
  const d = encodeTable({
    jour,
    duree: config.duree_jours,
    pioche: partie.pioche.length,
    bombes: nbBombes(partie),
    esprits: nbEsprits(partie),
    rois,
  });
  return `${TRUST_ROYALE_URL}/api/bang/table?d=${d}`;
}

function mainImageUrl(main) {
  if (!main?.length) return null;
  // v : version du rendu ; Discord garde en cache une image par URL, une
  // ancienne version (main sur le tapis) ressortait pour certaines mains
  return `${TRUST_ROYALE_URL}/api/bang/main?${new URLSearchParams({ c: [...main].sort().join("|"), v: "2" })}`;
}

// ── Mise en forme ────────────────────────────────────────────────────

function plural(n, mot) {
  return `${n} ${mot}${n > 1 ? "s" : ""}`;
}

function carteLabel(id) {
  return `${CARTES[id].emoji} ${CARTES[id].nom}`;
}

// « 💚 Esprit de guérison · 👊 Gang de gobelins ×2 », dans l'ordre de CARTES.
function formatMain(main) {
  const groupes = Object.keys(CARTES)
    .map((id) => [id, main.filter((c) => c === id).length])
    .filter(([, n]) => n > 0);
  if (!groupes.length) return "aucune carte";
  return groupes
    .map(([id, n]) => `${carteLabel(id)}${n > 1 ? ` ×${n}` : ""}`)
    .join(" · ");
}

function piocheLigne(partie) {
  const bombes = nbBombes(partie);
  const esprits = nbEsprits(partie);
  return `🃏 Pioche : **${plural(partie.pioche.length, "carte")}**, dont **${bombes}** 💥 Gobelin${bombes > 1 ? "s explosifs" : " explosif"} et **${esprits}** 💚 Esprit${esprits > 1 ? "s" : ""} de guérison`;
}

const MEDALS = ["🥇", "🥈", "🥉"];

// ── Embeds publics ───────────────────────────────────────────────────

function buildAnnonceEmbed(config) {
  return {
    title: "💣 Bang! Et paf le gobelin…",
    description: [
      "Une pioche commune, des **💥 Gobelins explosifs** cachés dedans, et un objectif simple: **être le dernier joueur en vie** !",
      "",
      `📅 **${config.duree_jours} jours de jeu**, à partir de demain. Pioche, piège tes adversaires et, surtout, reste en vie.`,
      "",
      "Plus d'infos ? Clique sur *Règles* ci-dessous.",
    ].join("\n"),
    color: BANG_COLOR,
    image: { url: illustrationUrl() },
    footer: { text: `La partie commence demain à ${formatUtcTimeAsParis(8)}.` },
  };
}

const INTRO_J1 =
  "Les Gobelins ont envahi l'Arène et caché leurs **💥 Gobelins explosifs** dans la pioche… Chaque nouveau joueur y ajoute ses cartes. À toi de piocher le premier !";

// Événements marquants de la veille (bilan archivé à la clôture).
function bilanVeilleLignes(veille) {
  const noms = (liste) => liste.map((n) => `**${n}**`).join(", ");
  const lignes = [];
  if (veille.explosions.length) {
    lignes.push(
      `🚀 ${veille.explosions.length > 1 ? `${veille.explosions.length} joueurs ont explosé` : "1 joueur a explosé"} : ${noms(veille.explosions)}.`,
    );
  } else {
    lignes.push("🚀 Personne n'a explosé.");
  }
  if (veille.sauves.length)
    lignes.push(
      `💚 Sauvé${veille.sauves.length > 1 ? "s" : ""} par un Esprit de guérison : ${noms(veille.sauves)}.`,
    );
  if (veille.attaques) {
    lignes.push(
      `⚔️ ${plural(veille.attaques, "attaque")}${veille.renvois ? `, dont ${veille.renvois} renvoyée${veille.renvois > 1 ? "s" : ""} par un Moine` : ""}.`,
    );
  }
  const nbAuto = veille.automatiques.length;
  if (nbAuto)
    lignes.push(
      `⏰ ${nbAuto} pioche${nbAuto > 1 ? "s automatiques" : " automatique"} (détail dans le Journal).`,
    );
  return lignes;
}

// Message officiel du jour : intro (J1) ou bilan de la veille, pioche,
// survivants et derniers événements.
function buildTableEmbed(jour, config, partie) {
  const tous = Object.values(partie.joueurs);
  const survivants = tous
    .filter((j) => j.vivant)
    .sort((a, b) => a.username.localeCompare(b.username));
  const elimines = tous
    .filter((j) => !j.vivant)
    .sort((a, b) => a.rangElimination - b.rangElimination);
  const lignes =
    jour === 1 || !partie.veille
      ? [INTRO_J1]
      : ["**📰 Hier dans l'Arène**", ...bilanVeilleLignes(partie.veille)];
  lignes.push("", piocheLigne(partie));
  if (survivants.length) {
    lignes.push(
      "",
      `**👑 Survivants (${survivants.length})**`,
      survivants.map((j) => `${j.username} (${j.main.length} 🃏)`).join(" · "),
    );
  }
  if (elimines.length) {
    lignes.push(
      "",
      `**💀 Joueurs éliminés (${elimines.length})**`,
      elimines.map((j) => j.username).join(" · "),
    );
  }
  // Seuls les faits cruciaux du jour (explosions) : le détail est dans le
  // bouton Journal
  const cruciaux = partie.journal
    .filter((e) => e.c && e.j === (partie.numeroJour ?? jour))
    .slice(-JOURNAL_AFFICHE);
  if (cruciaux.length)
    lignes.push(
      "",
      "**💥 Aujourd'hui**",
      ...cruciaux.map((e) => texteJournal(partie, e)),
    );
  return {
    title: `🔫 Bang! — Jour ${jour}/${config.duree_jours}`,
    description: lignes.join("\n").slice(-4096),
    color: BANG_COLOR,
    image: { url: tableImageUrl(jour, config, partie) },
    footer: {
      text: `Pioche automatique de ${config.pioches_auto} cartes pour ceux qui n'ont pas pioché à ${formatUtcTimeAsParis(8)}.`,
    },
  };
}

function formatMancheLine(record, isCurrent) {
  const suffix = isCurrent ? " *(cette manche)*" : "";
  return `Manche ${record.manche} : vainqueur **${record.vainqueur}** (${plural(record.nbJoueurs, "joueur")})${suffix}`;
}

// Critère qui a départagé le vainqueur du 2e survivant, dans l'ordre de
// classement() (Bravoure, Esprits de guérison, cartes en main, arrivée).
function critereVictoire(a, b) {
  const esprits = (j) => j.main.filter((c) => c === "esprit").length;
  if ((a.bravoure ?? 0) !== (b.bravoure ?? 0)) return "avec le plus de Bravoure";
  if (esprits(a) !== esprits(b)) return "à Bravoure égale, avec le plus d'Esprits de guérison";
  if (a.main.length !== b.main.length) return "à Bravoure égale, avec le plus de cartes en main";
  return "à égalité parfaite, grâce à son inscription plus précoce";
}

function buildFinEmbed(jour, ranking, partie, config, manches, currentManche) {
  const top = ranking[0];
  const seul = top && vivants(partie).length === 1;
  const titre = !top
    ? "Personne n'a participé."
    : seul
      ? `👑 **${top.username}** est le dernier joueur en vie !`
      : `👑 **${top.username}** l'emporte parmi les ${vivants(partie).length} survivants, ${critereVictoire(partie.joueurs[top.discordId], partie.joueurs[ranking[1].discordId])} !`;
  const statut = (r) => {
    const j = partie.joueurs[r.discordId];
    return j.vivant ? `🔥 ${j.bravoure ?? 0} Bravoure` : "💀";
  };
  return {
    title: "🏆 Bang! — Partie terminée !",
    description: [
      titre,
      "",
      "**Classement final**",
      ...ranking
        .slice(0, 15)
        .map(
          (r, i) =>
            `${MEDALS[i] || `${i + 1}.`} **${r.username}** (${statut(r)}, ${plural(r.score, "pt")})`,
        ),
      ...(manches.length
        ? [
            "",
            "**📊 Manches précédentes**",
            ...manches.map((m) =>
              formatMancheLine(m, m.manche === currentManche),
            ),
          ]
        : []),
    ]
      .join("\n")
      .slice(0, 4096),
    color: 0xf1c40f,
    image: { url: tableImageUrl(jour, config, partie) },
  };
}

function buildReglesEmbed(config) {
  return {
    title: "📖 Règles — Bang!",
    description: [
      "Sois **le dernier joueur en vie** !",
      "",
      `**⚡ Cartes** : ${config.cartes_par_jour} cartes jouées max par jour.`,
      `**🔥 Bravoure** : chaque pioche (${config.pioches_par_jour} max par jour) et chaque attaque réussie rapporte ${plural(config.bravoure.pioche, "point")}.`,
      `**⏰ Chaque jour**, pioche au moins une fois, sinon, la clôture te fait piocher ${config.pioches_auto} cartes (sans Bravoure).`,
      "",
      `${carteLabel("bombe")} : si tu le pioches, ton Esprit de guérison est sacrifié. Sans Esprit, tu exploses et quittes l'Arène.`,
      `${carteLabel("esprit")} : te sauve, puis tu caches le Gobelin explosif où tu veux dans la pioche. Chacun en reçoit un au départ.`,
      `${carteLabel("moine")} : joue-le à l'avance, la prochaine attaque contre toi est renvoyée à l'envoyeur. Personne ne sait que tu es sous sa protection.`,
      `${carteLabel("fut")} : esquive une pioche (celle du jour, ou une pioche due), et peut voler 1 Bravoure à un joueur.`,
      `${carteLabel("malediction")} : la prochaine carte que ta cible piochera sera un simple Gobelin.`,
      `${carteLabel("gang")} : ta cible devra piocher ${config.gang_pioches} cartes d'un coup.`,
      `${carteLabel("sarbacane")} : regarde les 3 prochaines cartes de la pioche.`,
      `${carteLabel("voleuse")} : vole une carte au hasard à un joueur.`,
      `${carteLabel("gobelin")} : carte purement décorative.`,
      "",
      `**🏁 Fin** : dès qu'il ne reste qu'un joueur, sinon au jour ${config.duree_jours}. Les survivants sont alors classés par Bravoure.`,
    ].join("\n"),
    color: BANG_COLOR,
  };
}

// ── Composants publics ───────────────────────────────────────────────

function reglesButton() {
  return {
    type: 2,
    style: 2,
    label: "Règles",
    emoji: { name: "📖" },
    custom_id: "bang_regles",
  };
}

function buildTableComponents() {
  return [
    {
      type: 1,
      components: [
        {
          type: 2,
          style: 1,
          label: "Piocher",
          emoji: { name: "🃏" },
          custom_id: "bang_piocher",
        },
        {
          type: 2,
          style: 3,
          label: "Jouer une carte",
          emoji: { name: "⚡" },
          custom_id: "bang_jouer",
        },
        {
          type: 2,
          style: 2,
          label: "Journal",
          emoji: { name: "📜" },
          custom_id: "bang_journal",
        },
        reglesButton(),
      ],
    },
  ];
}

// ── Messages Discord du salon ────────────────────────────────────────

async function discordFetch(url, init) {
  const token = process.env.DISCORD_TOKEN;
  if (!token) throw new Error("DISCORD_TOKEN manquant.");
  // FormData (pièce jointe) : Content-Type multipart posé par fetch
  const multipart = init?.body instanceof FormData;
  return fetch(`https://discord.com/api/v10${url}`, {
    ...init,
    headers: {
      Authorization: `Bot ${token}`,
      ...(multipart ? {} : { "Content-Type": "application/json" }),
    },
  });
}

// Image du plateau jointe au message (`attachment://`) plutôt que confiée
// par URL à Discord : son proxy va chercher l'image depuis sa propre région
// (cache CDN Vercel régional, rendu à froid), dépasse parfois son délai et
// affiche alors le message sans image, l'image apparaissant ou disparaissant
// d'une édition à l'autre. Repli sur l'URL si le téléchargement échoue.
const PLATEAU_FILENAME = "plateau.png";

async function joindreImage(embed) {
  const url = embed?.image?.url;
  if (!url?.includes("/api/bang/table")) return null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    embed.image = { url: `attachment://${PLATEAU_FILENAME}` };
    return buffer;
  } catch (err) {
    console.warn("[Bang] Image du plateau non jointe:", err.message);
    return null;
  }
}

// Corps JSON, ou multipart avec l'image du plateau. `attachments` liste la
// seule pièce jointe conservée : en édition, l'ancien plateau est retiré
// (y compris au repli sur l'URL, sinon il s'afficherait hors de l'embed).
function corpsMessage(payload, image) {
  if (!image) return JSON.stringify({ ...payload, attachments: [] });
  const form = new FormData();
  form.append(
    "payload_json",
    JSON.stringify({
      ...payload,
      attachments: [{ id: 0, filename: PLATEAU_FILENAME }],
    }),
  );
  form.append(
    "files[0]",
    new Blob([image], { type: "image/png" }),
    PLATEAU_FILENAME,
  );
  return form;
}

async function supprimerMessage(state) {
  if (!state?.messageId || !state?.channelId) return;
  try {
    const res = await discordFetch(
      `/channels/${state.channelId}/messages/${state.messageId}`,
      { method: "DELETE" },
    );
    if (!res.ok && res.status !== 404)
      console.warn(
        `[Bang] Échec suppression du message officiel (${res.status}), publication quand même.`,
      );
  } catch (err) {
    console.warn(
      "[Bang] Erreur réseau à la suppression du message officiel:",
      err.message,
    );
  }
}

async function publishAndWriteState(
  channelId,
  previousState,
  { phase, jour, embed, components, ping, termine = false, isPublic, noPing },
) {
  const image = await joindreImage(embed);
  await supprimerMessage(previousState);
  const roleId =
    ping && !noPing ? await getRoleIdByName(MINI_JEUX_ROLE_NAME) : null;
  const res = await discordFetch(`/channels/${channelId}/messages`, {
    method: "POST",
    body: corpsMessage(
      { embeds: [embed], components, ...buildRolePingFields(roleId) },
      image,
    ),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Erreur envoi salon Discord (${res.status}): ${errText}`);
  }
  const message = await res.json();
  await writeState({
    phase,
    jour,
    channelId,
    messageId: message.id,
    publishedAt: new Date().toISOString(),
    termine,
    isPublic,
    noPing,
  });
  return { jour, embed, message, termine };
}

// Réédite le message officiel du jour (après chaque action).
async function rafraichirTable(state, partie) {
  if (!state?.messageId || state.termine) return;
  try {
    const config = await loadBangConfig();
    const embed = buildTableEmbed(state.jour, config, partie);
    const image = await joindreImage(embed);
    const res = await discordFetch(
      `/channels/${state.channelId}/messages/${state.messageId}`,
      {
        method: "PATCH",
        body: corpsMessage(
          { embeds: [embed], components: buildTableComponents() },
          image,
        ),
      },
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    console.error(
      "[Bang] Échec rafraîchissement du message officiel:",
      err.message,
    );
  }
}

// Fin de partie : manche archivée (salon public), message final avec ping.
// `final` déjà figé (dernier Roi debout ou dernier jour).
async function terminerPartie(state, partie, final, { dryRun = false } = {}) {
  const config = await loadBangConfig();
  let currentManche = null;
  if (!dryRun && state.isPublic && final.length) {
    currentManche = await archiveManche({
      vainqueur: final[0].username,
      scoreGagnant: final[0].score,
      nbJoueurs: final.length,
      ranking: final.map((r) => ({
        discordId: r.discordId,
        username: r.username,
        score: r.score,
      })),
      resolvedAt: new Date().toISOString(),
    });
  }
  const manches = await listManches({ limit: 10 });
  const embed = buildFinEmbed(
    state.jour,
    final,
    partie,
    config,
    manches,
    currentManche,
  );
  const components = [{ type: 1, components: [reglesButton()] }];
  if (dryRun) return { dryRun: true, final: true, embed };
  const result = await publishAndWriteState(state.channelId, state, {
    phase: "jour",
    jour: state.jour,
    embed,
    components,
    ping: true,
    termine: true,
    isPublic: state.isPublic,
    noPing: state.noPing,
  });
  return { ...result, final: true };
}

// ── Publication quotidienne (appelée uniquement par scripts/postBang.js) ──

// Joueurs fictifs du salon de test (6 ou 7 tirés au sort), voir initPartie.
const PNJ = [
  "Kévina",
  "Josette",
  "Gérard",
  "Ginette",
  "Jean-Mi",
  "Bernadette",
  "Régis",
  "Huguette",
];

function tirerPnj() {
  const noms = [...PNJ].sort(() => Math.random() - 0.5);
  return noms.slice(0, 6 + Math.floor(Math.random() * 2));
}

export async function postBang(
  channelId,
  {
    dryRun = false,
    noPing = false,
    isPublic = false,
    requireActiveState = false,
    force = false,
    pnj = !isPublic,
  } = {},
) {
  const config = await loadBangConfig();
  const state = await readState();

  if (state?.termine) return { termine: true };
  if (
    state &&
    !dryRun &&
    !force &&
    isTooSoonSinceLastClosure(state.publishedAt)
  ) {
    return {
      skipped: true,
      reason: "tooSoonSinceLastClosure",
      publishedAt: state.publishedAt,
    };
  }
  if (state && state.channelId !== channelId)
    return { wrongChannel: true, activeChannelId: state.channelId };
  if (!state && requireActiveState) return { skipped: true };

  // 1) Aucun état → jour de présentation
  if (!state) {
    const embed = buildAnnonceEmbed(config);
    const components = [{ type: 1, components: [reglesButton()] }];
    if (dryRun) return { dryRun: true, phase: "annonce", embed, components };
    return publishAndWriteState(channelId, null, {
      phase: "annonce",
      jour: null,
      embed,
      components,
      ping: true,
      isPublic,
      noPing,
    });
  }

  // 2) Présentation → Jour 1 : pioche vide, elle se remplit avec les joueurs
  if (state.phase === "annonce") {
    const partie = dryRun
      ? await readPartie()
      : await initPartie({ pnj: pnj && !isPublic ? tirerPnj() : [] });
    const embed = buildTableEmbed(1, config, partie);
    const components = buildTableComponents();
    if (dryRun)
      return { dryRun: true, phase: "jour", jour: 1, embed, components };
    return publishAndWriteState(channelId, state, {
      phase: "jour",
      jour: 1,
      embed,
      components,
      ping: false,
      isPublic,
      noPing,
    });
  }

  // 3) Clôture d'un jour (lecture seule en dry-run)
  const closure = dryRun
    ? await previewCloture(state.jour)
    : await closeDayAndAdvance(state.jour);
  if (closure.termine) {
    const final = closure.final;
    return terminerPartie(
      { ...state, isPublic, noPing },
      closure.partie,
      final,
      { dryRun },
    );
  }
  const embed = buildTableEmbed(closure.jourSuivant, config, closure.partie);
  const components = buildTableComponents();
  if (dryRun)
    return { dryRun: true, jour: closure.jourSuivant, embed, components };
  return publishAndWriteState(channelId, state, {
    phase: "jour",
    jour: closure.jourSuivant,
    embed,
    components,
    ping: false,
    isPublic,
    noPing,
  });
}

// ── Réponses éphémères ───────────────────────────────────────────────

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
    console.error("[Bang] Échec PATCH:", err.message);
  }
}

const ERREURS = {
  termine: "La partie est terminée.",
  elimine: "Tu as explosé, tu ne peux plus jouer.",
  enAttente: "Cache d'abord le Gobelin explosif dans la pioche.",
  pioche: "La pioche est vide.",
  plafondPioche: "Tu as fait toutes tes pioches du jour.",
  injouable: "Cette carte ne se joue pas.",
  pasEnMain: "Cette carte n'est plus dans ta main.",
  moineActif: "Ton Moine te protège déjà.",
  plafond: "Tu as déjà joué toutes tes cartes du jour.",
  cible: "Cible impossible.",
  pasEnAttente: "Aucun Gobelin explosif à cacher.",
  position: "Emplacement inconnu.",
};

function avertissement(code) {
  return `⚠️ ${ERREURS[code] || "Action impossible."}`;
}

// Texte du résultat d'une carte jouée.
function jouerTexte(r, cible, partie) {
  const nomCible = partie.joueurs[cible]?.username;
  if (r.carte === "sarbacane") {
    const vues = r.revelation.length
      ? r.revelation.map((c, i) => `${i + 1}. ${carteLabel(c)}`).join("\n")
      : "La pioche est vide.";
    return `🎯 **Sommet de la pioche** (visible par toi seulement) :\n${vues}`;
  }
  if (r.carte === "moine")
    return "🙏 Ton Moine veille jusqu'à la clôture : la prochaine attaque contre toi sera renvoyée à l'envoyeur.";
  if (r.carte === "fut" && cible === "pioche")
    return "🛢️ Tu esquives une pioche.";
  if (r.renvoi) {
    return `🙏 Aïe ! Le Moine de **${nomCible}** renvoie ta carte (${carteLabel(r.carte)}) contre toi.${r.vole ? ` Tu perds : ${carteLabel(r.vole)}.` : ""}`;
  }
  const extra = r.vole
    ? ` Tu dérobes : **${carteLabel(r.vole)}**.`
    : r.carte === "fut"
      ? " Tu esquives une pioche."
      : "";
  return `✅ Tu joues ${carteLabel(r.carte)} contre **${nomCible}**.${extra}`;
}

function alertes(j) {
  const lignes = [];
  if (j.dette > 0)
    lignes.push(
      `👊 Gang de gobelins : **${plural(j.dette, "pioche")}** à faire, d'un seul clic sur Piocher.`,
    );
  if (j.maudit > 0)
    lignes.push(
      `🧿 Malédiction : ta prochaine carte piochée sera un simple Gobelin${j.maudit > 1 ? ` (×${j.maudit})` : ""}.`,
    );
  if (j.moine)
    lignes.push(
      "🙏 Ton Moine te protège jusqu'à la clôture : la prochaine attaque sera renvoyée.",
    );
  return lignes;
}

// Effet de chaque carte : sous la carte piochée, et dans le menu « Jouer
// une carte » (100 caractères au plus, limite Discord).
const EFFETS = {
  bombe: "Sans Esprit de guérison, tu exploses.",
  esprit: "Te sauve si tu pioches un Gobelin explosif.",
  sarbacane: "Regarde les 3 premières cartes de la pioche.",
  moine: "Renvoie la prochaine attaque contre toi (jusqu'à la clôture).",
  fut: "Esquive une pioche et peut voler 1 Bravoure à un joueur.",
  gang: "Ta cible devra piocher 2 cartes d'un coup.",
  malediction: "La prochaine carte piochée par ta cible devient un Gobelin.",
  voleuse: "Vole une carte au hasard à un joueur.",
  gobelin: "Carte sans pouvoir.",
};

const NOUVEAU = (config) =>
  `Bienvenue dans l'Arène ! Tu reçois un ${carteLabel("esprit")} et ${plural(config.main_depart, "carte")}.`;

function bravoureFooter(j, config) {
  return {
    text: `Bravoure : ${j.bravoure ?? 0} · Pioches du jour : ${j.pioches ?? 0}/${config.pioches_par_jour}`,
  };
}

function finVue(j) {
  const texte = !j.vivant
    ? "💀 Tu as explosé, ta partie est terminée. Suis la suite sur le message officiel !"
    : "🏁 La partie est terminée.";
  return {
    embeds: [{ description: texte, color: BANG_COLOR }],
    components: [],
  };
}

// Bouton personnel « Piocher (N) » de l'éphémère, N = pioches restantes
// du jour, ou dues (le bouton du message officiel, commun à tous, ne peut
// pas l'afficher).
function repiocherRow(j, partie, config) {
  const restantes =
    j.dette > 0 ? j.dette : config.pioches_par_jour - (j.pioches ?? 0);
  const possible = partie.pioche.length > 0 && restantes > 0;
  return {
    type: 1,
    components: [
      {
        type: 2,
        style: 1,
        label: `Piocher (${Math.max(0, restantes)})`,
        emoji: { name: "🃏" },
        custom_id: "bang_e_piocher",
        disabled: !possible,
      },
    ],
  };
}

function placementRow() {
  return {
    type: 1,
    components: [
      {
        type: 3,
        custom_id: "bang_placer",
        placeholder: "Où cacher le Gobelin explosif ?",
        options: Object.entries(POSITIONS).map(([value, label]) => ({
          label,
          value,
        })),
      },
    ],
  };
}

// [🃏 Piocher] : la ou les cartes piochées (image et effet ; plusieurs
// d'un coup pour les pioches dues d'un Gang de gobelins), ou l'explosion.
// Après un Gobelin explosif désamorcé, le menu pour le cacher.
function buildPiocheView(
  config,
  partie,
  discordId,
  { tirages = [], erreur = null, nouveau = false, entete = null } = {},
) {
  const j = partie.joueurs[discordId];
  const cartes = tirages.filter((t) => !t.bang);
  const bang = tirages.find((t) => t.bang)?.bang ?? null;
  const intro = [
    ...(nouveau ? [NOUVEAU(config), ""] : []),
    ...(entete ? [entete, ""] : []),
  ];
  // Cartes piochées avant un Gobelin explosif (pioches dues)
  if (cartes.length && bang)
    intro.push(
      `Tu pioches d'abord : ${cartes.map((t) => carteLabel(t.carte)).join(", ")}.`,
      "",
    );
  if (j.enAttente) {
    return {
      embeds: [
        {
          title: `${carteLabel("bombe")} désamorcé !`,
          description: [
            ...intro,
            "Ton Esprit de guérison te sauve. Choisis où cacher le Gobelin explosif dans la pioche.",
          ].join("\n"),
          color: BANG_COLOR,
          thumbnail: { url: mainImageUrl(["bombe"]) },
          footer: bravoureFooter(j, config),
        },
      ],
      components: [placementRow()],
    };
  }
  if (!j.vivant || (partie.termine && !tirages.length)) {
    if (bang === "elimine") {
      return {
        embeds: [
          {
            title: "💥 BANG !",
            description: [
              ...intro,
              "Tu as pioché un Gobelin explosif sans Esprit de guérison : tu exploses ! Fin de partie pour toi.",
            ].join("\n"),
            color: BANG_COLOR,
            thumbnail: { url: mainImageUrl(["bombe"]) },
          },
        ],
        components: [],
      };
    }
    return finVue(j);
  }
  if (erreur || !cartes.length) {
    return {
      embeds: [
        {
          description: [...intro, avertissement(erreur), ...alertes(j)].join(
            "\n",
          ),
          color: BANG_COLOR,
        },
      ],
      components: [repiocherRow(j, partie, config)],
    };
  }
  const lignes = [...intro];
  for (const t of cartes) {
    if (t.transformee)
      lignes.push(
        `🧿 Malédiction ! Ta carte (${CARTES[t.transformee].nom}) devient un simple Gobelin.`,
      );
    lignes.push(
      cartes.length > 1
        ? `${carteLabel(t.carte)} : ${EFFETS[t.carte]}`
        : EFFETS[t.carte],
    );
  }
  if (j.dette > 0)
    lignes.push(
      "",
      `👊 Encore **${plural(j.dette, "pioche")}** à faire (Gang de gobelins).`,
    );
  return {
    embeds: [
      {
        title:
          cartes.length > 1
            ? `Tu pioches ${cartes.length} cartes (Gang de gobelins)`
            : `Tu pioches : ${carteLabel(cartes[0].carte)}`,
        description: lignes.join("\n"),
        color: BANG_COLOR,
        image: { url: mainImageUrl(cartes.map((t) => t.carte)) },
      },
    ],
    components: [repiocherRow(j, partie, config)],
  };
}

// [⚡ Jouer une carte] : résultat de l'action, alertes, Bravoure, deck (texte
// et image), menu des cartes jouables avec leur effet ; `carteCiblee` :
// carte choisie, en attente de sa cible.
function buildJouerView(
  config,
  partie,
  discordId,
  { entete = null, nouveau = false, carteCiblee = null } = {},
) {
  const j = partie.joueurs[discordId];
  if (!j.vivant || partie.termine) return finVue(j);
  if (j.enAttente)
    return buildPiocheView(config, partie, discordId, { entete });
  const lignes = [
    ...(nouveau ? [NOUVEAU(config), ""] : []),
    ...(entete ? [entete, ""] : []),
    ...alertes(j),
    `🔥 Bravoure : **${j.bravoure ?? 0}**`,
    `🃏 Pioches aujourd'hui : **${j.pioches ?? 0}/${config.pioches_par_jour}**`,
    `⚡ Cartes jouées aujourd'hui : **${j.jouees ?? 0}/${config.cartes_par_jour}**`,
    `**Ton deck** : ${formatMain(j.main)}`,
  ];
  const components = [];
  if (carteCiblee) {
    const adversaires = vivants(partie)
      .filter(([id]) => id !== discordId)
      .sort(([, a], [, b]) => a.username.localeCompare(b.username))
      .map(([id, a]) => ({
        label: a.username.slice(0, 100),
        value: id,
        description: `${plural(a.main.length, "carte")}`,
      }));
    const options = [
      ...(carteCiblee === "fut"
        ? [
            {
              label: "Personne (esquive seule)",
              value: "pioche",
              emoji: { name: "🛢️" },
            },
          ]
        : []),
      ...adversaires,
    ].slice(0, 25);
    components.push(
      {
        type: 1,
        components: [
          {
            type: 3,
            custom_id: `bang_cible:${carteCiblee}`,
            placeholder: `Cible de ta carte : ${CARTES[carteCiblee].nom}`,
            options,
          },
        ],
      },
      {
        type: 1,
        components: [
          { type: 2, style: 2, label: "Annuler", custom_id: "bang_annuler" },
        ],
      },
    );
  } else {
    const jouables = JOUABLES.filter(
      (c) => j.main.includes(c) && !(c === "moine" && j.moine),
    );
    if ((j.jouees ?? 0) >= config.cartes_par_jour) {
      lignes.push(
        "",
        "Tu as joué toutes tes cartes du jour : la suite demain !",
      );
    } else if (!jouables.length) {
      lignes.push("", "Tu n'as aucune carte à jouer pour l'instant.");
    } else {
      components.push({
        type: 1,
        components: [
          {
            type: 3,
            custom_id: "bang_carte",
            placeholder: "⚡ Choisis la carte à jouer",
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
  }
  const image = mainImageUrl(j.main);
  return {
    embeds: [
      {
        title: "⚡ Jouer une carte",
        description: lignes.join("\n").slice(0, 4096),
        color: BANG_COLOR,
        image: image ? { url: image } : undefined,
      },
    ],
    components,
  };
}

// État actif requis pour toute action ; null (et message) sinon.
async function guardActive(webhookUrl) {
  const state = await readState();
  if (!state || state.phase !== "jour" || state.termine) {
    await patchOriginal(webhookUrl, {
      content: "Aucune partie de Bang! en cours.",
    });
    return null;
  }
  return state;
}

// Action commune : sous verrou (bang.js), puis vue éphémère (`vue`),
// message officiel réédité et fin de partie éventuelle.
// `action(partie, config)` renvoie les options de la vue.
async function executer(
  webhookUrl,
  discordId,
  username,
  action,
  vue,
  { rafraichir = true } = {},
) {
  const state = await guardActive(webhookUrl);
  if (!state) return;
  const config = await loadBangConfig();
  const r = await agir(state.jour, discordId, username, action);
  if (r.erreur === "inscriptions") {
    await patchOriginal(webhookUrl, {
      content: `🔒 Trop tard : on ne peut plus rejoindre l'Arène après le jour ${config.inscription_jours}. Rendez-vous à la prochaine partie !`,
    });
    return;
  }
  await patchOriginal(
    webhookUrl,
    vue(config, r.partie, discordId, {
      ...(r.resultat || {}),
      nouveau: r.nouveau,
    }),
  );
  if (r.partie.termine) {
    const final = await figerResultat(r.partie);
    if (final) await terminerPartie(state, r.partie, final);
    return;
  }
  if (rafraichir || r.nouveau) await rafraichirTable(state, await readPartie());
}

// ── Boutons du message officiel (nouvel éphémère) ────────────────────

// [⚡ Jouer une carte] (et « Annuler » au choix de la cible).
export async function handleJouer(webhookUrl, discordId, username) {
  try {
    await executer(
      webhookUrl,
      discordId,
      username,
      () => ({}),
      buildJouerView,
      { rafraichir: false },
    );
  } catch (err) {
    console.error("[Bang] Échec jouer:", err.message);
  }
}

// [🃏 Piocher].
export async function handlePiocher(webhookUrl, discordId, username) {
  try {
    await executer(
      webhookUrl,
      discordId,
      username,
      (partie, config) => {
        const r = piocherClic(partie, discordId, { config });
        return r.erreur ? { erreur: r.erreur } : { tirages: r.tirages };
      },
      buildPiocheView,
    );
  } catch (err) {
    console.error("[Bang] Échec pioche:", err.message);
  }
}

// ── Composants de l'éphémère (édition en place) ──────────────────────

// Menu « Choisis la carte à jouer » : jouée tout de suite, ou menu des cibles.
export async function handleCarte(webhookUrl, discordId, username, carte) {
  try {
    if (CIBLEES.includes(carte)) {
      await executer(
        webhookUrl,
        discordId,
        username,
        (partie) => {
          const j = partie.joueurs[discordId];
          if (!j?.main.includes(carte))
            return { entete: avertissement("pasEnMain") };
          // Menu des cibles vide (seul joueur de la partie) : refusé par Discord
          if (carte !== "fut" && vivants(partie).length < 2)
            return { entete: "⚠️ Aucun adversaire à viser pour l'instant." };
          return { carteCiblee: carte };
        },
        buildJouerView,
        { rafraichir: false },
      );
      return;
    }
    await executer(
      webhookUrl,
      discordId,
      username,
      (partie, config) => {
        const r = jouer(partie, discordId, carte, null, { config });
        return {
          entete: r.erreur
            ? avertissement(r.erreur)
            : jouerTexte(r, null, partie),
        };
      },
      buildJouerView,
    );
  } catch (err) {
    console.error("[Bang] Échec carte:", err.message);
  }
}

// Menu des cibles d'une carte.
export async function handleCible(
  webhookUrl,
  discordId,
  username,
  carte,
  cible,
) {
  try {
    await executer(
      webhookUrl,
      discordId,
      username,
      (partie, config) => {
        const r = jouer(partie, discordId, carte, cible, { config });
        return {
          entete: r.erreur
            ? avertissement(r.erreur)
            : jouerTexte(r, cible, partie),
        };
      },
      buildJouerView,
    );
  } catch (err) {
    console.error("[Bang] Échec cible:", err.message);
  }
}

// Menu « Où cacher le Gobelin explosif ? ».
export async function handlePlacer(webhookUrl, discordId, username, position) {
  try {
    await executer(
      webhookUrl,
      discordId,
      username,
      (partie) => {
        const r = placer(partie, discordId, position);
        return {
          texte: r.erreur
            ? avertissement(r.erreur)
            : `🤫 Gobelin explosif caché : ${POSITIONS[position].toLowerCase()}.`,
        };
      },
      (config, partie, id, { texte }) => {
        const j = partie.joueurs[id];
        if (j.enAttente)
          return buildPiocheView(config, partie, id, { entete: texte });
        return {
          embeds: [{ description: texte, color: BANG_COLOR }],
          components: [repiocherRow(j, partie, config)],
        };
      },
    );
  } catch (err) {
    console.error("[Bang] Échec placement:", err.message);
  }
}

// ── Bouton [📜 Journal] (éphémère) ───────────────────────────────────

// Ce qui concerne le joueur (ses actions, celles qui le visent, ses notes
// privées : pioches, Sarbacane, Moine…), regroupé par jour, du plus récent
// au plus ancien (jours anciens coupés au-delà de 4096 caractères).
export async function handleJournal(webhookUrl, discordId) {
  try {
    const [state, partie] = await Promise.all([readState(), readPartie()]);
    if (!state || state.phase !== "jour") {
      await patchOriginal(webhookUrl, {
        content: "Aucune partie de Bang! en cours.",
      });
      return;
    }
    if (!partie.joueurs[discordId]) {
      await patchOriginal(webhookUrl, {
        content: "Tu ne participes pas à cette partie.",
      });
      return;
    }
    const jours = new Map();
    for (const e of partie.journal) {
      if (e.p !== discordId && !e.ids?.includes(discordId)) continue;
      if (!jours.has(e.j)) jours.set(e.j, []);
      jours.get(e.j).push(texteJournal(partie, e, discordId));
    }
    let description = "";
    for (const [j, lignes] of [...jours.entries()].sort(
      (a, b) => b[0] - a[0],
    )) {
      const bloc = [`**Jour ${j}**`, ...lignes, ""].join("\n");
      if (description.length + bloc.length > 4000) {
        description += "*(jours précédents non affichés)*";
        break;
      }
      description += `${bloc}\n`;
    }
    await patchOriginal(webhookUrl, {
      embeds: [
        {
          title: "📜 Ton journal",
          description: description.trim() || "Rien à signaler pour l'instant.",
          color: BANG_COLOR,
        },
      ],
    });
  } catch (err) {
    console.error("[Bang] Échec Journal:", err.message);
  }
}

// ── Bouton [📖 Règles] (éphémère, statique) ──────────────────────────

export async function handleRegles(webhookUrl) {
  try {
    await patchOriginal(webhookUrl, {
      embeds: [buildReglesEmbed(await loadBangConfig())],
    });
  } catch (err) {
    console.error("[Bang] Échec Règles:", err.message);
  }
}
