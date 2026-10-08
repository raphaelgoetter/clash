// ============================================================
// bang.js — Handlers Discord de Bang! (jeu spécial de 7 jours inspiré
// d'Exploding Kittens). Un seul message officiel par jour (survivants,
// pioche, derniers événements), réédité en direct après chaque action,
// avec quatre boutons : Piocher, Mon deck, Jouer, Règles. Chaque bouton
// ouvre le deck éphémère du joueur, d'où il enchaîne pioches, cartes et
// cibles (édition en place de l'éphémère).
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
import { CARTES, JOUABLES, CIBLEES, POSITIONS, piocher, placer, jouer, vivants, nbBombes } from "../../../backend/services/bangRules.js";
import { getRoleIdByName, buildRolePingFields, MINI_JEUX_ROLE_NAME } from "../../../backend/services/discordRoles.js";
import { formatUtcTimeAsParis } from "../../../backend/services/dateUtils.js";

const BANG_COLOR = 0xc0392b;
const TRUST_ROYALE_URL = "https://trustroyale.vercel.app";
const JOURNAL_AFFICHE = 10;

function illustrationUrl() {
  return `${TRUST_ROYALE_URL}/api/bang/illustration?v=${Date.now()}`;
}

function mainImageUrl(main) {
  if (!main?.length) return null;
  return `${TRUST_ROYALE_URL}/api/bang/main?${new URLSearchParams({ c: [...main].sort().join("|") })}`;
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
  return groupes.map(([id, n]) => `${carteLabel(id)}${n > 1 ? ` ×${n}` : ""}`).join(" · ");
}

function piocheLigne(partie) {
  return `🃏 Pioche : **${plural(partie.pioche.length, "carte")}**, dont **${nbBombes(partie)}** 💥 Gobelin${nbBombes(partie) > 1 ? "s explosifs" : " explosif"}`;
}

const MEDALS = ["🥇", "🥈", "🥉"];

// ── Embeds publics ───────────────────────────────────────────────────

function buildAnnonceEmbed(config) {
  return {
    title: "🔫 Bang! — Les Gobelins envahissent l'Arène…",
    description: [
      "Une pioche commune, des **💥 Gobelins explosifs** cachés dedans, et un seul objectif : **être le dernier Roi en vie** !",
      "",
      `📅 **${config.duree_jours} jours de jeu**, à partir de demain. Chaque jour, tu reçois **${config.elixir.par_jour} Élixirs** pour piocher, quand tu veux. Pioche, piège tes adversaires et protège ton Roi.`,
      "",
      "Plus d'infos ? Clique sur *Règles* ci-dessous.",
    ].join("\n"),
    color: BANG_COLOR,
    image: { url: illustrationUrl() },
    footer: { text: `La partie commence demain à ${formatUtcTimeAsParis(8)}.` },
  };
}

// Message officiel du jour : survivants, pioche et derniers événements.
function buildTableEmbed(jour, config, partie) {
  const tous = Object.values(partie.joueurs);
  const survivants = tous.filter((j) => j.vivant).sort((a, b) => a.username.localeCompare(b.username));
  const elimines = tous.filter((j) => !j.vivant).sort((a, b) => a.rangElimination - b.rangElimination);
  const lignes = ["Pioche avec ton Élixir, piège tes adversaires et sois **le dernier Roi en vie** !"];
  if (jour <= config.inscription_jours) {
    lignes.push(`🆕 Inscriptions ouvertes jusqu'au jour ${config.inscription_jours} : clique sur un bouton pour rejoindre l'Arène.`);
  }
  lignes.push("", piocheLigne(partie));
  if (survivants.length) {
    lignes.push("", `**👑 Survivants (${survivants.length})**`, survivants.map((j) => `${j.username} (${j.main.length} 🃏)`).join(" · "));
  }
  if (elimines.length) {
    lignes.push("", `**💀 Rois explosés (${elimines.length})**`, elimines.map((j) => j.username).join(" · "));
  }
  const journal = partie.journal.slice(-JOURNAL_AFFICHE);
  if (journal.length) lignes.push("", "**📜 Derniers événements**", ...journal);
  return {
    title: `🔫 Bang! — Jour ${jour}/${config.duree_jours}`,
    description: lignes.join("\n").slice(-4096),
    color: BANG_COLOR,
    image: { url: illustrationUrl() },
    footer: { text: `+${config.elixir.par_jour} Élixirs (${config.elixir.max} max) et pioche automatique pour ceux qui n'ont pas pioché à ${formatUtcTimeAsParis(8)}.` },
  };
}

function formatMancheLine(record, isCurrent) {
  const suffix = isCurrent ? " *(cette manche)*" : "";
  return `Manche ${record.manche} : vainqueur **${record.vainqueur}** (${plural(record.nbJoueurs, "joueur")})${suffix}`;
}

function buildFinEmbed(ranking, partie, config, manches, currentManche) {
  const top = ranking[0];
  const seul = top && vivants(partie).length === 1;
  const titre = !top
    ? "Personne n'a participé."
    : seul
      ? `👑 **${top.username}** est le dernier Roi debout !`
      : `👑 **${top.username}** l'emporte parmi les ${vivants(partie).length} survivants, avec le plus d'Élixir !`;
  const statut = (r) => {
    const j = partie.joueurs[r.discordId];
    return j.vivant ? `👑 ${j.elixir} Élixir` : "💀";
  };
  return {
    title: "🏆 Bang! — Partie terminée !",
    description: [
      titre,
      "",
      "**Classement final**",
      ...ranking.slice(0, 15).map((r, i) => `${MEDALS[i] || `${i + 1}.`} **${r.username}** (${statut(r)}, ${plural(r.score, "pt")})`),
      ...(manches.length ? ["", "**📊 Manches précédentes**", ...manches.map((m) => formatMancheLine(m, m.manche === currentManche))] : []),
    ]
      .join("\n")
      .slice(0, 4096),
    color: 0xf1c40f,
    image: { url: illustrationUrl() },
  };
}

function buildReglesEmbed(config) {
  return {
    title: "📖 Règles — Bang!",
    description: [
      "Sois **le dernier Roi en vie** ! Pas de tour de jeu : connecte-toi quand tu veux.",
      "",
      `**🧪 Élixir** : +${config.elixir.par_jour} par jour (${config.elixir.max} max). **Piocher** coûte 1 Élixir. Tu n'es jamais obligé de jouer la carte piochée.`,
      `**⏰ Chaque jour**, pioche au moins une fois (ou joue un Fût à gobelins) : sinon, la clôture pioche pour toi.`,
      "",
      `${carteLabel("bombe")} : si tu le pioches, ton Esprit de guérison est sacrifié. Sans Esprit, ton Roi explose et quitte l'Arène.`,
      `${carteLabel("esprit")} : sauve ton Roi, puis tu caches le Gobelin explosif où tu veux dans la pioche. Chacun en reçoit un au départ.`,
      `${carteLabel("moine")} : joue-le à l'avance. Jusqu'à la clôture du jour, la prochaine attaque contre toi est renvoyée à l'envoyeur. Personne ne sait que ton Roi est protégé.`,
      `${carteLabel("fut")} : esquive une pioche (celle du jour, ou une pioche due), et vole 1 Élixir à la banque ou à un joueur.`,
      `${carteLabel("malediction")} : la prochaine carte que ta cible piochera sera un simple Gobelin.`,
      `${carteLabel("gang")} : ta cible devra piocher ${config.gang_pioches} fois d'affilée.`,
      `${carteLabel("sarbacane")} : regarde les 3 premières cartes de la pioche.`,
      `${carteLabel("voleuse")} : vole une carte au hasard à un joueur.`,
      `${carteLabel("gobelin")} : carte sans pouvoir.`,
      "",
      `**🆕 Inscriptions** : jusqu'au jour ${config.inscription_jours}, en cliquant sur un bouton.`,
      `**🏁 Fin** : dès qu'il ne reste qu'un Roi, sinon au jour ${config.duree_jours}. Les survivants sont alors classés par Élixir restant.`,
    ].join("\n"),
    color: BANG_COLOR,
  };
}

// ── Composants publics ───────────────────────────────────────────────

function reglesButton() {
  return { type: 2, style: 2, label: "Règles", emoji: { name: "📖" }, custom_id: "bang_regles" };
}

function buildTableComponents() {
  return [
    {
      type: 1,
      components: [
        { type: 2, style: 1, label: "Piocher (1 Élixir)", emoji: { name: "🃏" }, custom_id: "bang_piocher" },
        { type: 2, style: 2, label: "Mon deck", emoji: { name: "🎒" }, custom_id: "bang_deck" },
        { type: 2, style: 3, label: "Jouer", emoji: { name: "⚡" }, custom_id: "bang_jouer" },
        reglesButton(),
      ],
    },
  ];
}

// ── Messages Discord du salon ────────────────────────────────────────

async function discordFetch(url, init) {
  const token = process.env.DISCORD_TOKEN;
  if (!token) throw new Error("DISCORD_TOKEN manquant.");
  return fetch(`https://discord.com/api/v10${url}`, {
    ...init,
    headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
  });
}

async function supprimerMessage(state) {
  if (!state?.messageId || !state?.channelId) return;
  try {
    const res = await discordFetch(`/channels/${state.channelId}/messages/${state.messageId}`, { method: "DELETE" });
    if (!res.ok && res.status !== 404) console.warn(`[Bang] Échec suppression du message officiel (${res.status}), publication quand même.`);
  } catch (err) {
    console.warn("[Bang] Erreur réseau à la suppression du message officiel:", err.message);
  }
}

async function publishAndWriteState(channelId, previousState, { phase, jour, embed, components, ping, termine = false, isPublic, noPing }) {
  await supprimerMessage(previousState);
  const roleId = ping && !noPing ? await getRoleIdByName(MINI_JEUX_ROLE_NAME) : null;
  const res = await discordFetch(`/channels/${channelId}/messages`, {
    method: "POST",
    body: JSON.stringify({ embeds: [embed], components, ...buildRolePingFields(roleId) }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Erreur envoi salon Discord (${res.status}): ${errText}`);
  }
  const message = await res.json();
  await writeState({ phase, jour, channelId, messageId: message.id, publishedAt: new Date().toISOString(), termine, isPublic, noPing });
  return { jour, embed, message, termine };
}

// Réédite le message officiel du jour (après chaque action).
async function rafraichirTable(state, partie) {
  if (!state?.messageId || state.termine) return;
  try {
    const config = await loadBangConfig();
    await discordFetch(`/channels/${state.channelId}/messages/${state.messageId}`, {
      method: "PATCH",
      body: JSON.stringify({ embeds: [buildTableEmbed(state.jour, config, partie)], components: buildTableComponents() }),
    });
  } catch (err) {
    console.error("[Bang] Échec rafraîchissement du message officiel:", err.message);
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
      ranking: final.map((r) => ({ discordId: r.discordId, username: r.username, score: r.score })),
      resolvedAt: new Date().toISOString(),
    });
  }
  const manches = await listManches({ limit: 10 });
  const embed = buildFinEmbed(final, partie, config, manches, currentManche);
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

export async function postBang(channelId, { dryRun = false, noPing = false, isPublic = false, requireActiveState = false, force = false } = {}) {
  const config = await loadBangConfig();
  const state = await readState();

  if (state?.termine) return { termine: true };
  if (state && !dryRun && !force && isTooSoonSinceLastClosure(state.publishedAt)) {
    return { skipped: true, reason: "tooSoonSinceLastClosure", publishedAt: state.publishedAt };
  }
  if (state && state.channelId !== channelId) return { wrongChannel: true, activeChannelId: state.channelId };
  if (!state && requireActiveState) return { skipped: true };

  // 1) Aucun état → jour de présentation
  if (!state) {
    const embed = buildAnnonceEmbed(config);
    const components = [{ type: 1, components: [reglesButton()] }];
    if (dryRun) return { dryRun: true, phase: "annonce", embed, components };
    return publishAndWriteState(channelId, null, { phase: "annonce", jour: null, embed, components, ping: true, isPublic, noPing });
  }

  // 2) Présentation → Jour 1 : pioche vide, elle se remplit avec les joueurs
  if (state.phase === "annonce") {
    const partie = dryRun ? await readPartie() : await initPartie();
    const embed = buildTableEmbed(1, config, partie);
    const components = buildTableComponents();
    if (dryRun) return { dryRun: true, phase: "jour", jour: 1, embed, components };
    return publishAndWriteState(channelId, state, { phase: "jour", jour: 1, embed, components, ping: false, isPublic, noPing });
  }

  // 3) Clôture d'un jour (lecture seule en dry-run)
  const closure = dryRun ? await previewCloture(state.jour) : await closeDayAndAdvance(state.jour);
  if (closure.termine) {
    const final = closure.final;
    return terminerPartie({ ...state, isPublic, noPing }, closure.partie, final, { dryRun });
  }
  const embed = buildTableEmbed(closure.jourSuivant, config, closure.partie);
  const components = buildTableComponents();
  if (dryRun) return { dryRun: true, jour: closure.jourSuivant, embed, components };
  return publishAndWriteState(channelId, state, { phase: "jour", jour: closure.jourSuivant, embed, components, ping: false, isPublic, noPing });
}

// ── Réponses éphémères ───────────────────────────────────────────────

async function patchOriginal(webhookUrl, payload) {
  if (!webhookUrl) return;
  try {
    await fetch(`${webhookUrl}/messages/@original`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "", embeds: [], components: [], ...payload }),
    });
  } catch (err) {
    console.error("[Bang] Échec PATCH:", err.message);
  }
}

const ERREURS = {
  termine: "La partie est terminée.",
  elimine: "Ton Roi a explosé, tu ne peux plus jouer.",
  enAttente: "Cache d'abord le Gobelin explosif dans la pioche.",
  pioche: "La pioche est vide.",
  elixir: "Pas assez d'Élixir pour piocher.",
  injouable: "Cette carte ne se joue pas.",
  pasEnMain: "Cette carte n'est plus dans ta main.",
  moineActif: "Ton Moine te protège déjà.",
  cible: "Cible impossible.",
  pasEnAttente: "Aucun Gobelin explosif à cacher.",
  position: "Emplacement inconnu.",
};

function avertissement(code) {
  return `⚠️ ${ERREURS[code] || "Action impossible."}`;
}

// Texte du résultat d'une pioche.
function piocheTexte(r) {
  if (r.bang === "elimine") return "💥 **BANG !** Tu as pioché un Gobelin explosif sans Esprit de guérison : ton Roi explose ! Fin de partie pour toi.";
  if (r.bang === "sauve") return "💥 **BANG !** Tu as pioché un Gobelin explosif… ton Esprit de guérison te sauve ! Choisis où cacher le Gobelin dans la pioche.";
  if (r.transformee) return `🧿 Malédiction ! Ta carte (${carteLabel(r.transformee)}) se transforme en simple **${carteLabel("gobelin")}**.`;
  return `🃏 Tu pioches : **${carteLabel(r.carte)}**.`;
}

// Texte du résultat d'une carte jouée.
function jouerTexte(r, cible, partie) {
  const nomCible = partie.joueurs[cible]?.username;
  if (r.carte === "sarbacane") {
    const vues = r.revelation.length ? r.revelation.map((c, i) => `${i + 1}. ${carteLabel(c)}`).join("\n") : "La pioche est vide.";
    return `🎯 **Sommet de la pioche** (visible par toi seulement) :\n${vues}`;
  }
  if (r.carte === "moine") return "🙏 Ton Moine veille jusqu'à la clôture : la prochaine attaque contre toi sera renvoyée à l'envoyeur.";
  if (r.carte === "fut" && cible === "pioche") return "🛢️ Tu esquives une pioche et récupères 1 Élixir.";
  if (r.renvoi) {
    return `🙏 Aïe ! Le Moine de **${nomCible}** renvoie ta carte (${carteLabel(r.carte)}) contre toi.${r.vole ? ` Tu perds : ${carteLabel(r.vole)}.` : ""}`;
  }
  const extra = r.vole ? ` Tu dérobes : **${carteLabel(r.vole)}**.` : r.carte === "fut" ? " Tu esquives une pioche." : "";
  return `✅ Tu joues ${carteLabel(r.carte)} contre **${nomCible}**.${extra}`;
}

function alertes(j, config) {
  const lignes = [];
  if (j.dette > 0) lignes.push(`👊 Gang de gobelins : encore **${plural(j.dette, "pioche")}** à faire (même sans Élixir).`);
  if (j.maudit > 0) lignes.push(`🧿 Malédiction : ta prochaine carte piochée sera un simple Gobelin${j.maudit > 1 ? ` (×${j.maudit})` : ""}.`);
  if (j.moine) lignes.push("🙏 Ton Moine te protège jusqu'à la clôture : la prochaine attaque sera renvoyée.");
  if (!j.tourFait && !j.dette) lignes.push(`⏰ Tu n'as pas encore pioché aujourd'hui : sinon, la clôture de ${formatUtcTimeAsParis(8)} piochera pour toi.`);
  return lignes;
}

// Deck éphémère : alertes, Élixir, main, et les actions possibles.
// `carteCiblee` : carte choisie dans le menu Jouer, en attente de sa cible.
function buildDeckView(jour, config, partie, discordId, { entete = null, nouveau = false, carteCiblee = null } = {}) {
  const j = partie.joueurs[discordId];
  const lignes = [
    ...(entete ? [entete, ""] : []),
    ...(nouveau ? [`Bienvenue dans l'Arène ! Tu reçois un ${carteLabel("esprit")} et ${plural(config.main_depart, "carte")}.`, ""] : []),
  ];
  const embed = { title: `🎒 Ton deck — Jour ${jour}/${config.duree_jours}`, color: BANG_COLOR };

  if (!j.vivant || partie.termine) {
    lignes.push(!j.vivant ? "💀 Ton Roi a explosé, ta partie est terminée. Suis la suite sur le message officiel !" : "🏁 La partie est terminée.");
    return { embeds: [{ ...embed, description: lignes.join("\n").slice(0, 4096) }], components: [] };
  }

  if (j.enAttente) lignes.push("💥 **Gobelin explosif désamorcé !** Choisis où le cacher dans la pioche.", "");
  lignes.push(...alertes(j, config));
  lignes.push(`🧪 Élixir : **${j.elixir}/${config.elixir.max}**`, `**Ta main** : ${formatMain(j.main)}`, "", piocheLigne(partie));
  const image = mainImageUrl(j.main);

  const components = [];
  if (j.enAttente) {
    components.push({
      type: 1,
      components: [
        {
          type: 3,
          custom_id: "bang_placer",
          placeholder: "Où cacher le Gobelin explosif ?",
          options: Object.entries(POSITIONS).map(([value, label]) => ({ label, value })),
        },
      ],
    });
  } else if (carteCiblee) {
    const adversaires = vivants(partie)
      .filter(([id]) => id !== discordId)
      .sort(([, a], [, b]) => a.username.localeCompare(b.username))
      .map(([id, a]) => ({ label: a.username.slice(0, 100), value: id, description: `${plural(a.main.length, "carte")}` }));
    const options = [...(carteCiblee === "fut" ? [{ label: "La banque (+1 Élixir)", value: "pioche", emoji: { name: "🧪" } }] : []), ...adversaires].slice(0, 25);
    components.push(
      { type: 1, components: [{ type: 3, custom_id: `bang_cible:${carteCiblee}`, placeholder: `Cible de ta carte : ${CARTES[carteCiblee].nom}`, options }] },
      { type: 1, components: [{ type: 2, style: 2, label: "Annuler", custom_id: "bang_annuler" }] },
    );
  } else {
    const peutPiocher = partie.pioche.length > 0 && (j.elixir >= 1 || j.dette > 0);
    components.push({
      type: 1,
      components: [{ type: 2, style: 1, label: j.dette > 0 ? "Piocher (pioche due)" : "Piocher (1 Élixir)", emoji: { name: "🃏" }, custom_id: "bang_e_piocher", disabled: !peutPiocher }],
    });
    const jouables = JOUABLES.filter((c) => j.main.includes(c) && !(c === "moine" && j.moine));
    if (jouables.length) {
      components.push({
        type: 1,
        components: [
          {
            type: 3,
            custom_id: "bang_carte",
            placeholder: "⚡ Jouer une carte",
            options: jouables.map((c) => ({
              label: CARTES[c].nom,
              value: c,
              emoji: { name: CARTES[c].emoji },
              description: `×${j.main.filter((x) => x === c).length} dans ta main`,
            })),
          },
        ],
      });
    }
  }
  return {
    embeds: [{ ...embed, description: lignes.join("\n").slice(0, 4096), image: image ? { url: image } : undefined }],
    components,
  };
}

// État actif requis pour toute action ; null (et message) sinon.
async function guardActive(webhookUrl) {
  const state = await readState();
  if (!state || state.phase !== "jour" || state.termine) {
    await patchOriginal(webhookUrl, { content: "Aucune partie de Bang! en cours." });
    return null;
  }
  return state;
}

// Action commune : sous verrou (bang.js), puis deck éphémère, message
// officiel réédité et fin de partie éventuelle.
// `action(partie, config)` renvoie { entete?, carteCiblee? }.
async function executer(webhookUrl, discordId, username, action, { rafraichir = true } = {}) {
  const state = await guardActive(webhookUrl);
  if (!state) return;
  const config = await loadBangConfig();
  const r = await agir(state.jour, discordId, username, action);
  if (r.erreur === "inscriptions") {
    await patchOriginal(webhookUrl, { content: `🔒 Les inscriptions sont closes depuis le jour ${config.inscription_jours}. Rendez-vous à la prochaine partie !` });
    return;
  }
  await patchOriginal(webhookUrl, buildDeckView(state.jour, config, r.partie, discordId, { ...(r.resultat || {}), nouveau: r.nouveau }));
  if (r.partie.termine) {
    const final = await figerResultat(r.partie);
    if (final) await terminerPartie(state, r.partie, final);
    return;
  }
  if (rafraichir || r.nouveau) await rafraichirTable(state, await readPartie());
}

// ── Boutons du message officiel (nouvel éphémère) ────────────────────

// [🎒 Mon deck] et [⚡ Jouer] : le deck, avec le menu des cartes.
export async function handleDeck(webhookUrl, discordId, username) {
  try {
    await executer(webhookUrl, discordId, username, () => null, { rafraichir: false });
  } catch (err) {
    console.error("[Bang] Échec deck:", err.message);
  }
}

// [🃏 Piocher] (message officiel ou deck éphémère).
export async function handlePiocher(webhookUrl, discordId, username) {
  try {
    await executer(webhookUrl, discordId, username, (partie) => {
      const r = piocher(partie, discordId);
      return { entete: r.erreur ? avertissement(r.erreur) : piocheTexte(r) };
    });
  } catch (err) {
    console.error("[Bang] Échec pioche:", err.message);
  }
}

// ── Composants du deck éphémère (édition en place) ───────────────────

// Menu « Jouer une carte » : jouée tout de suite, ou menu des cibles.
export async function handleCarte(webhookUrl, discordId, username, carte) {
  try {
    if (CIBLEES.includes(carte)) {
      await executer(webhookUrl, discordId, username, (partie) => {
        const j = partie.joueurs[discordId];
        return j?.main.includes(carte) ? { carteCiblee: carte } : { entete: avertissement("pasEnMain") };
      }, { rafraichir: false });
      return;
    }
    await executer(webhookUrl, discordId, username, (partie, config) => {
      const r = jouer(partie, discordId, carte, null, { config });
      return { entete: r.erreur ? avertissement(r.erreur) : jouerTexte(r, null, partie) };
    });
  } catch (err) {
    console.error("[Bang] Échec carte:", err.message);
  }
}

// Menu des cibles d'une carte.
export async function handleCible(webhookUrl, discordId, username, carte, cible) {
  try {
    await executer(webhookUrl, discordId, username, (partie, config) => {
      const r = jouer(partie, discordId, carte, cible, { config });
      return { entete: r.erreur ? avertissement(r.erreur) : jouerTexte(r, cible, partie) };
    });
  } catch (err) {
    console.error("[Bang] Échec cible:", err.message);
  }
}

// Menu « Où cacher le Gobelin explosif ? ».
export async function handlePlacer(webhookUrl, discordId, username, position) {
  try {
    await executer(webhookUrl, discordId, username, (partie) => {
      const r = placer(partie, discordId, position);
      return { entete: r.erreur ? avertissement(r.erreur) : `🤫 Gobelin explosif caché : ${POSITIONS[position].toLowerCase()}.` };
    });
  } catch (err) {
    console.error("[Bang] Échec placement:", err.message);
  }
}

// ── Bouton [📖 Règles] (éphémère, statique) ──────────────────────────

export async function handleRegles(webhookUrl) {
  try {
    await patchOriginal(webhookUrl, { embeds: [buildReglesEmbed(await loadBangConfig())] });
  } catch (err) {
    console.error("[Bang] Échec Règles:", err.message);
  }
}
