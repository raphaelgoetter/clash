// ============================================================
// marioclash.js — Handlers Discord pour Mario Clash (course communautaire
// façon Mario Kart sur plateau à 49 cases de 0 à 48, thème Clash Royale). Embed,
// boutons du jour (dé/boutique/objet/sort), selects de ciblage, Règles. La
// publication/clôture quotidienne passe uniquement par
// scripts/postMarioClash.js (postMarioClash) — les boutons/selects restent
// gérés par api/discord/interactions.js.
//
// ⚠️ Modèle de référence = Boss Raid, pas Robinson : rien n'est appliqué en
// direct pendant la journée (dé/objet/sort) — tout se résout UNE SEULE FOIS
// à la clôture, dans computeCloture() (backend/services/marioclash.js). Seul
// l'achat en boutique est résolu en direct (action individuelle, sans
// interaction avec les autres joueurs — voir marioclash.js).
//
// ⚠️ Participation libre, comme Robinson/Tamagoshi/Boss Raid : pas
// d'inscription préalable, un joueur rejoint la course au premier clic
// (ensureJoueur()).
// ============================================================

import {
  loadMarioClashConfig,
  readState,
  writeState,
  readJoueurs,
  readJoueur,
  ensureJoueur,
  purchaseItem,
  rollDiceForPlayer,
  castSpellForPlayer,
  recordItemUse,
  readActions,
  previewCloture,
  closeDayAndAdvance,
  loadNarratifs,
  getHistoriqueEntry,
  archiveManche,
  listManches,
  isTooSoonSinceLastClosure,
  ciblesObjet,
} from "../../../backend/services/marioclash.js";
import {
  getRoleIdByName,
  buildRolePingFields,
  MINI_JEUX_ROLE_NAME,
} from "../../../backend/services/discordRoles.js";
import { formatUtcTimeAsParis } from "../../../backend/services/dateUtils.js";

const MARIOCLASH_COLOR = 0xe74c3c;
const TRUST_ROYALE_URL = "https://trustroyale.vercel.app";

function boardImageUrl(jour) {
  return `${TRUST_ROYALE_URL}/api/marioclash/image?jour=${jour}&v=${Date.now()}`;
}

// Cache-buster dynamique, pas une valeur fixe (?v=1) : Discord met en cache
// l'ÉCHEC d'un premier fetch par URL exacte, ce qui aurait bloqué l'image en
// permanence après le premier post raté (juste après déploiement) — même
// principe que boardImageUrl() ci-dessus, voir aussi le commentaire ?v=2
// dans bossraid.js pour l'incident équivalent.
function illustrationUrl() {
  return `${TRUST_ROYALE_URL}/api/marioclash/illustration?v=${Date.now()}`;
}

// ── Classement ───────────────────────────────────────────────────────

function sortedRanking(joueurs) {
  return Object.entries(joueurs)
    .map(([discordId, j]) => ({ discordId, ...j }))
    .sort(
      (a, b) => b.position - a.position || a.username.localeCompare(b.username),
    );
}

// `detailed` : le Journal affiche les points, le classement final du
// message de fin reste sobre (juste la position). ⚠️ Jamais l'objet
// possédé : l'achat du jour doit rester caché jusqu'au bilan, sinon plus
// aucun bluff possible autour de l'Étoile (qui renvoie les objets).
function formatRankingLines(
  joueurs,
  config,
  { limit = 10, detailed = true, inclureId = null, deLances = null } = {},
) {
  const ranking = sortedRanking(joueurs);
  if (!ranking.length) return ["*Personne n'a encore rejoint la course.*"];
  const formatLigne = (j, index) => {
    const medal =
      index === 0
        ? "🥇"
        : index === 1
          ? "🥈"
          : index === 2
            ? "🥉"
            : `${index + 1}.`;
    const arrivee = j.position >= config.case_arrivee ? " 🏁" : "";
    const coche = deLances?.has(j.discordId) ? " ✅" : "";
    if (!detailed)
      return `${medal} **${j.username}** — case ${j.position}${arrivee}`;
    return `${medal} **${j.username}** — case ${j.position}${arrivee} · ${j.points} Or${coche}`;
  };
  const lignes = ranking.slice(0, limit).map(formatLigne);
  // Joueur hors du top affiché : on ajoute quand même sa propre ligne.
  const indexInclus = inclureId ? ranking.findIndex((j) => j.discordId === inclureId) : -1;
  if (indexInclus >= limit) lignes.push("…", formatLigne(ranking[indexInclus], indexInclus));
  return lignes;
}

// ── Résumé narratif du jour (remplace la description statique du message
// public) — sélection déterministe par jour (jamais Math.random(), pour
// rester testable/reproductible), même convention que pickFlavor() de
// bossraid.js/goblinhunters.js.

function pickFlavor(pool, seed) {
  if (!pool?.length) return "";
  return pool[((seed % pool.length) + pool.length) % pool.length];
}

// Compare le classement avant/après clôture pour repérer les faits
// marquants (nouveau leader, avance confortable, course serrée, traîne,
// échanges de position) — au maximum 3 lignes, retombe sur un narratif
// "calme" rigolo quand rien de notable ne s'est produit.
function buildResumeLignes(
  jour,
  joueursAvant,
  joueursApres,
  closureLignes,
  narratifs,
) {
  const nomDe = (id) =>
    joueursApres[id]?.username || joueursAvant?.[id]?.username || "?";
  const rankingApres = sortedRanking(joueursApres);
  const rankingAvant = sortedRanking(joueursAvant || {});
  const lines = [];

  if (rankingApres.length) {
    const leader = rankingApres[0];
    if (rankingAvant.length && rankingAvant[0].discordId !== leader.discordId) {
      lines.push(
        pickFlavor(narratifs.nouveau_leader, jour).replaceAll(
          "{joueur}",
          leader.username,
        ),
      );
    } else if (rankingApres.length >= 2) {
      const ecart = leader.position - rankingApres[1].position;
      if (ecart >= 8) {
        lines.push(
          pickFlavor(narratifs.grosse_avance, jour).replaceAll(
            "{joueur}",
            leader.username,
          ),
        );
      } else if (ecart <= 2) {
        lines.push(
          pickFlavor(narratifs.course_serree, jour)
            .replaceAll("{joueur1}", leader.username)
            .replaceAll("{joueur2}", rankingApres[1].username),
        );
      }
    }
  }

  if (rankingApres.length >= 3) {
    const dernier = rankingApres[rankingApres.length - 1];
    if (rankingApres[0].position - dernier.position >= 10) {
      lines.push(
        pickFlavor(narratifs.traine, jour + 1).replaceAll(
          "{joueur}",
          dernier.username,
        ),
      );
    }
  }

  for (const l of closureLignes || []) {
    if (l.type === "objet" && l.effet === "echange") {
      lines.push(
        pickFlavor(narratifs.echange, jour + 2)
          .replaceAll("{a}", nomDe(l.discordId))
          .replaceAll("{b}", nomDe(l.cibleId)),
      );
    } else if (l.type === "objet" && l.effet === "renvoi") {
      lines.push(
        pickFlavor(narratifs.renvoi, jour + 3)
          .replaceAll("{a}", nomDe(l.discordId))
          .replaceAll("{b}", nomDe(l.cibleId)),
      );
    } else if (l.type === "sort" && l.autreEchangeId) {
      lines.push(
        pickFlavor(narratifs.echange, jour + 5)
          .replaceAll("{a}", nomDe(l.cibleId))
          .replaceAll("{b}", nomDe(l.autreEchangeId)),
      );
    }
  }

  if (!lines.length) lines.push(pickFlavor(narratifs.calme, jour));
  return lines.slice(0, 3);
}

// ── Bilan de clôture (lignes factuelles, pas de narratif pour l'instant) ──

// Un joueur ne doit voir, dans son Journal, que les événements qui le
// concernent DIRECTEMENT (auteur, cible, ou tiers entraîné par un échange
// aléatoire de sort) — jamais le bilan complet de tout le monde.
function filterLignesForPlayer(lignes, discordId) {
  return lignes.filter((l) => l.discordId === discordId || l.cibleId === discordId || l.autreEchangeId === discordId);
}

// Bilan formulé du point de vue du joueur qui consulte (`moiId`) : "Tu
// avances de 4", "X te fait reculer de 3"... plutôt que son propre pseudo.
function formatBilanLignes(lignes, joueurs, config, moiId) {
  if (!lignes.length) return [];
  const nomDe = (id) => joueurs[id]?.username || "?";
  const texte = lignes
    .map((l) => {
      const auteur = l.discordId === moiId;
      const cible = l.cibleId === moiId;
      switch (l.type) {
        case "de": {
          const de = config.des[l.deId];
          const arrivee = l.positionDe != null ? ` (case ${l.positionDe})` : "";
          const c = l.caseSpeciale != null ? config.cases_speciales?.[l.caseSpeciale] : null;
          const effet = c ? ` · ${c.emoji} ${c.label} : ${effetCaseTexte(c)}` : "";
          return `${de?.emoji || "🎲"} Tu as fait ${l.valeur}${arrivee}${effet}`;
        }
        case "objet":
          if (l.effet === "avance")
            return `${config.objets[l.itemId]?.emoji || "🚀"} ${auteur ? "Tu avances" : `${nomDe(l.discordId)} avance`} de ${l.valeur}`;
          if (l.effet === "recul") {
            const emoji = config.objets[l.itemId]?.emoji || "💣";
            if (auteur) return `${emoji} Tu fais reculer ${nomDe(l.cibleId)} de ${l.valeur}`;
            if (cible) return `${emoji} ${nomDe(l.discordId)} te fait reculer de ${l.valeur}`;
            return `${emoji} ${nomDe(l.discordId)} fait reculer ${nomDe(l.cibleId)} de ${l.valeur}`;
          }
          if (l.effet === "echange") {
            if (auteur) return `🍌 Tu échanges ta place avec ${nomDe(l.cibleId)}`;
            if (cible) return `🍌 ${nomDe(l.discordId)} échange sa place avec toi`;
            return `🍌 ${nomDe(l.discordId)} échange sa place avec ${nomDe(l.cibleId)}`;
          }
          if (l.effet === "renvoi") {
            if (auteur) return `⭐ L'Étoile de ${nomDe(l.cibleId)} renvoie ton objet, tu recules de ${l.valeur}`;
            if (cible) return `⭐ Ton Étoile renvoie l'objet de ${nomDe(l.discordId)}, qui recule de ${l.valeur}`;
            return `⭐ L'Étoile de ${nomDe(l.cibleId)} renvoie l'objet de ${nomDe(l.discordId)}, qui recule de ${l.valeur}`;
          }
          if (l.effet === "rembourse")
            return `${config.objets[l.itemId]?.emoji || "🎒"} ${config.objets[l.itemId]?.label || "Objet"} sans cible : ${l.valeur} Or remboursés`;
          return null;
        case "sort": {
          if (l.effet === "bloque") {
            if (cible) return `⭐ Ton Étoile te protège : le sort de ${nomDe(l.discordId)} n'a aucun effet`;
            if (auteur) return `⭐ ${nomDe(l.cibleId)} est protégé(e) par son Étoile : ton sort n'a aucun effet`;
            return `⭐ ${nomDe(l.cibleId)} est protégé(e) par son Étoile, le sort de ${nomDe(l.discordId)} n'a aucun effet`;
          }
          let tiers = "";
          if (l.autreEchangeId) {
            if (cible) tiers = ` (tu échanges ta place avec ${nomDe(l.autreEchangeId)} au passage !)`;
            else if (l.autreEchangeId === moiId) tiers = ` (tu échanges ta place avec ${nomDe(l.cibleId)} au passage !)`;
            else tiers = ` (${nomDe(l.cibleId)} et ${nomDe(l.autreEchangeId)} échangent leurs places au passage !)`;
          }
          const clone =
            l.valeurClone == null
              ? ""
              : l.valeurClone > 0
                ? ` (${auteur ? "tu avances" : `${nomDe(l.discordId)} avance`} encore de ${l.valeurClone})`
                : " (sans effet, pas de dé lancé)";
          const lanceur = auteur ? "Tu lances" : `${nomDe(l.discordId)} lance`;
          return `✨ ${lanceur} un sort sur ${cible ? "toi" : nomDe(l.cibleId)} : *${l.sortLabel}*${clone}${tiers}`;
        }
        default:
          return null;
      }
    })
    .filter(Boolean);
  return texte.length ? ["", "**Ce qui t'est arrivé hier**", ...texte] : [];
}

// ── Embeds ───────────────────────────────────────────────────────────

function buildAnnonceEmbed(config) {
  return {
    title: "🏁 Mario Clash — Les moteurs chauffent…",
    description: [
      "Une course pas comme les autres s'annonce sur l'Arène : dés, objets spéciaux et sorts capricieux décideront qui franchira la ligne d'arrivée en tête !",
      "",
      `📅 **${config.duree_jours} jours de course**, à partir de demain — chaque jour tu peux lancer le dé, aller à la boutique pour utiliser ton objet et lancer un sort.`,
      "",
      "Plus d'infos ? Clique sur *Règles* ci-dessous.",
    ].join("\n"),
    color: MARIOCLASH_COLOR,
    image: { url: illustrationUrl() },
    footer: { text: `La course commence demain à ${formatUtcTimeAsParis(8)}.` },
  };
}

// Classement détaillé et bilan factuel vivent dans le bouton [📜 Journal]
// (voir buildJournalEmbed) — le message public affiche à la place un
// résumé narratif du jour (buildResumeLignes), pour rester vivant sans
// noyer l'essentiel sous les chiffres.
function buildJourEmbed(jour, config, resumeLignes) {
  return {
    title: `🏁 Mario Clash — Jour ${jour}/${config.duree_jours}`,
    description: resumeLignes.join("\n"),
    color: MARIOCLASH_COLOR,
    image: { url: boardImageUrl(jour) },
    footer: {
      text: [
        `Actions avant ${formatUtcTimeAsParis(8)} demain. Une seule fois chacune par jour.`,
        jour > 1 ? "Plateau à la clôture d'hier, positions en direct dans le Journal." : null,
      ]
        .filter(Boolean)
        .join("\n"),
    },
  };
}

// ── Bouton [📜 Journal] — éphémère : classement courant (public, pareil
// pour tout le monde) + bilan PERSONNEL de la veille (seulement les
// événements où le joueur qui consulte est impliqué, comme auteur, cible,
// ou tiers entraîné par un échange aléatoire de sort).
// `deLances` : Set des joueurs ayant déjà lancé le dé aujourd'hui (coche ✅),
// pour expliquer l'écart avec le plateau du message public, figé à la clôture.
function buildJournalEmbed(jour, config, joueurs, bilanLignes, discordId, deLances) {
  const lines = [...formatRankingLines(joueurs, config, { limit: 20, inclureId: discordId, deLances })];
  if (deLances?.size) lines.push("", "✅ a déjà lancé le dé aujourd'hui");
  const moi = joueurs[discordId];
  if (moi) lines.push("", ...etatPersonnelLignes(moi, config));
  const bilanPersonnel = filterLignesForPlayer(bilanLignes || [], discordId);
  if (bilanPersonnel.length)
    lines.push(...formatBilanLignes(bilanPersonnel, joueurs, config, discordId));
  return {
    title: `📜 Journal — Jour ${jour}/${config.duree_jours}`,
    description: lines.join("\n"),
    color: MARIOCLASH_COLOR,
  };
}

function formatMancheLine(record, isCurrent, isBest) {
  const marker = isBest ? "🏆 " : "";
  const suffix = isCurrent ? " *(cette manche)*" : "";
  return `${marker}Manche ${record.manche} — vainqueur **${record.vainqueur}** (case ${record.positionFinale})${suffix}`;
}

function buildManchesSection(manches, currentManche) {
  if (!manches.length) return [];
  const best = manches.reduce((a, b) =>
    b.positionFinale > a.positionFinale ? b : a,
  );
  return [
    "",
    "**📊 Manches précédentes**",
    ...manches.map((m) =>
      formatMancheLine(m, m.manche === currentManche, m.manche === best.manche),
    ),
  ];
}

function buildFinEmbed(joueurs, config, manches, currentManche) {
  const ranking = sortedRanking(joueurs);
  const meilleurePosition = ranking[0]?.position ?? 0;
  const vainqueurs = ranking.filter((j) => j.position === meilleurePosition);
  const titreVainqueur =
    vainqueurs.length > 1
      ? `Égalité entre ${vainqueurs.map((j) => j.username).join(", ")} !`
      : `**${vainqueurs[0]?.username || "Personne"}** l'emporte !`;

  return {
    title: "🏆 Mario Clash — Course terminée !",
    description: [
      `Après ${config.duree_jours} jours de course effrénée, le drapeau à damier tombe — ${titreVainqueur}`,
      "",
      "**Classement final**",
      ...formatRankingLines(joueurs, config, { limit: 10, detailed: false }),
      ...buildManchesSection(manches, currentManche),
      "",
      "Merci à tous les pilotes qui ont participé à cette course !",
    ].join("\n"),
    color: 0xf1c40f,
    image: { url: illustrationUrl() },
  };
}

// Description de chaque effet écrite en dur (pas générée depuis config.objets)
// — le libellé exact voulu ("tu avances de 4 cases", "l'adversaire choisi
// recule de 3"...) ne se déduit pas proprement des champs bruts de la
// config (cible/avance/recul/echange/invincible).
const OBJET_EFFET_TEXTE = {
  accelerateur: "tu avances de 4 cases",
  bombe: "l'adversaire choisi recule de 3",
  etoile: "renvoie les objets adverses ce jour (l'attaquant recule de 3) et bloque les sorts",
  banane: "échange ta place avec un adversaire choisi (10 cases devant toi au maximum)",
  carapace: "le joueur en tête à la clôture recule de 5 (si c'est toi, elle frappe le 2e)",
};

function describeDe(de) {
  const cases =
    de.min === de.max
      ? `toujours ${de.min} cases`
      : `${de.min} ${de.max - de.min === 1 ? "ou" : "à"} ${de.max} cases`;
  return `${cases}, +${de.or} Or`;
}

function describeCaseSpeciale(c) {
  if (c.avance > 0) return `avance de ${c.avance}`;
  if (c.avance < 0) return `recule de ${-c.avance}`;
  if (c.or > 0) return `+${c.or} Or`;
  if (c.or < 0) return `perd ${-c.or} Or`;
  return "";
}

// Même effet, formulé à la 2e personne pour la réponse au lancer.
function effetCaseTexte(c) {
  if (c.avance > 0) return `tu avances de ${c.avance} cases`;
  if (c.avance < 0) return `tu recules de ${-c.avance} cases`;
  if (c.or > 0) return `tu gagnes ${c.or} Or`;
  if (c.or < 0) return `tu perds ${c.or * -1} Or`;
  return "rien ne se passe";
}

// Regroupées par type (label identique) : "🔥 Feu (cases 20, 45) : recule de 3".
function buildCasesSpecialesLines(config) {
  const groupes = new Map();
  for (const [numero, c] of Object.entries(config.cases_speciales || {})) {
    const groupe = groupes.get(c.label) || { c, numeros: [] };
    groupe.numeros.push(numero);
    groupes.set(c.label, groupe);
  }
  return [...groupes.values()].map(
    ({ c, numeros }) =>
      `${c.emoji} **${c.label}** (case${numeros.length > 1 ? "s" : ""} ${numeros.join(", ")}) : ${describeCaseSpeciale(c)}`,
  );
}

// Déplacements possibles au dé aujourd'hui, tous dés confondus, en tenant
// compte d'un Gel (1 case) ou d'une Rage (bonus) posés par le sort d'hier
// — même calcul que rollDiceForPlayer().
function avancesPossibles(joueur, config) {
  if (joueur.gel) return [1];
  const avances = new Set();
  for (const de of Object.values(config.des)) {
    for (let v = de.min; v <= de.max; v++) avances.add(v + (joueur.rage || 0));
  }
  return [...avances].sort((a, b) => a - b);
}

// Cases spéciales atteignables au dé aujourd'hui — affichées au moment de
// choisir son dé.
function casesSpecialesDevant(joueur, config) {
  const lignes = [];
  for (const pas of avancesPossibles(joueur, config)) {
    const numero = joueur.position + pas;
    const c = config.cases_speciales?.[numero];
    if (c) lignes.push(`${c.emoji} case ${numero} (${c.label}, ${describeCaseSpeciale(c)})`);
  }
  return lignes;
}

function etatDeLigne(joueur) {
  if (joueur.gel) return "🧊 Gelé : ton dé ne fera avancer que d'1 case aujourd'hui.";
  if (joueur.rage) return `😡 Rage : +${joueur.rage} cases sur ton dé aujourd'hui.`;
  return null;
}

function concentrationLigne(joueur, config) {
  const niveau = joueur.concentration || 0;
  const retires = config.sorts
    .filter((s) => s.retire_concentration && s.retire_concentration <= niveau)
    .map((s) => s.nom || s.label);
  const suffixe = retires.length ? ` (${retires.join(" et ")} retiré${retires.length > 1 ? "s" : ""} de ton prochain sort)` : "";
  return `🔋 Concentration : ${niveau}/${config.concentration_max}${suffixe}`;
}

// Première case spéciale devant le joueur, avec la distance qui l'en sépare.
function prochaineCaseLigne(joueur, config) {
  const numero = Object.keys(config.cases_speciales || {})
    .map(Number)
    .filter((n) => n > joueur.position)
    .sort((a, b) => a - b)[0];
  if (numero == null) return null;
  const c = config.cases_speciales[numero];
  const distance = numero - joueur.position;
  return `🎯 Prochaine case spéciale : ${c.emoji} ${c.label} (case ${numero}, dans ${distance} case${distance > 1 ? "s" : ""})`;
}

function etatPersonnelLignes(joueur, config) {
  return [etatDeLigne(joueur), prochaineCaseLigne(joueur, config), concentrationLigne(joueur, config)].filter(Boolean);
}

function buildDiceSelect(jour, config) {
  return [
    {
      type: 1,
      components: [
        {
          type: 3,
          custom_id: `marioclash_dice_select:${jour}`,
          placeholder: "Choisis ton dé",
          options: Object.entries(config.des).map(([id, d]) => ({
            label: d.label,
            description: describeDe(d),
            value: id,
            emoji: { name: d.emoji },
          })),
        },
      ],
    },
  ];
}

const SORT_TYPE_EMOJI = { negatif: "🔻", positif: "✅", neutre: "🔄" };

function buildReglesEmbed(config) {
  const objetsLines = Object.entries(config.objets).map(
    ([id, o]) =>
      `${o.emoji} **${o.label}** (${o.cout} Or) : ${OBJET_EFFET_TEXTE[id] || ""}`,
  );
  const sortsLines = config.sorts.map(
    (s) =>
      `${SORT_TYPE_EMOJI[s.type] || "•"} ${s.label}${s.retire_concentration ? ` *(retiré dès Concentration ${s.retire_concentration})*` : ""}`,
  );
  const desLines = Object.values(config.des).map(
    (d) => `${d.emoji} **${d.label}** : ${describeDe(d)}`,
  );
  return {
    title: "📖 Règles — Mario Clash",
    description: [
      "Chaque jour, choisis librement parmi :",
      "🎲 **Lancer le dé** : choisis ton dé parmi",
      ...desLines,
      "🛍️ **Boutique** — achète 1 objet spécial ; l'objet est utilisé automatiquement dès l'achat (cible à choisir s'il vise un adversaire), effet appliqué à la clôture.",
      "✨ **Lancer un sort** — toujours sur toi-même, effet aléatoire annoncé immédiatement mais appliqué à la clôture.",
      `🔋 **Concentration** : chaque jour sans sort charge ta jauge (${config.concentration_max} max). Chaque niveau retire un effet négatif de ton prochain sort, puis la jauge retombe à 0.`,
      "",
      "**Ordre de résolution**",
      "1. 🎲 **Dé** : appliqué tout de suite.",
      "2. 🎁 **Objets** : appliqués au bilan du jour (la Carapace bleue en dernier).",
      "3. ✨ **Sorts** : appliqués au bilan du jour, après les objets.",
      "Tu peux lancer ton sort avant ton dé : il s'applique quand même après.",
      "",
      "**Objets spéciaux**",
      ...objetsLines,
      "",
      "**Sorts possibles** *(1 tiré au hasard)*",
      ...sortsLines,
      "",
      "**Cases spéciales** *(seulement si ton dé s'y arrête)*",
      ...buildCasesSpecialesLines(config),
    ].join("\n"),
    color: MARIOCLASH_COLOR,
  };
}

// ── Composants ───────────────────────────────────────────────────────

function buildUtilityRow() {
  return {
    type: 1,
    components: [
      {
        type: 2,
        style: 3,
        label: "Règles",
        emoji: { name: "📖" },
        custom_id: "marioclash_regles",
      },
    ],
  };
}

function buildJourComponents(jour) {
  const actionRow = {
    type: 1,
    components: [
      {
        type: 2,
        style: 2,
        label: "Lancer le dé",
        emoji: { name: "🎲" },
        custom_id: `marioclash_dice:${jour}`,
      },
      {
        type: 2,
        style: 2,
        label: "Boutique",
        emoji: { name: "🛍️" },
        custom_id: `marioclash_boutique:${jour}`,
      },
      {
        type: 2,
        style: 2,
        label: "Lancer un sort",
        emoji: { name: "✨" },
        custom_id: `marioclash_spell:${jour}`,
      },
    ],
  };
  const utilityRow = {
    type: 1,
    components: [
      {
        type: 2,
        style: 3,
        label: "Règles",
        emoji: { name: "📖" },
        custom_id: "marioclash_regles",
      },
      {
        type: 2,
        style: 2,
        label: "Journal",
        emoji: { name: "📜" },
        custom_id: "marioclash_journal",
      },
    ],
  };
  return [actionRow, utilityRow];
}

function buildBoutiqueSelect(jour, config, joueur) {
  return [
    {
      type: 1,
      components: [
        {
          type: 3,
          custom_id: `marioclash_boutique_select:${jour}`,
          placeholder: `Tu as ${joueur.points} Or`,
          options: Object.entries(config.objets).map(([id, o]) => ({
            label: `${o.label} — ${o.cout} Or`.slice(0, 100),
            value: id,
            emoji: { name: o.emoji },
          })),
        },
      ],
    },
  ];
}

function buildTargetSelectRow(customId, candidats) {
  const options = candidats
    .slice(0, 25)
    .map((j) => ({ label: j.username.slice(0, 100), value: j.discordId }));
  return [
    {
      type: 1,
      components: [
        {
          type: 3,
          custom_id: customId,
          placeholder: "Choisis une cible",
          options,
        },
      ],
    },
  ];
}

// ── Publication quotidienne (appelée uniquement par scripts/postMarioClash.js) ──

export async function postMarioClash(
  channelId,
  {
    dryRun = false,
    noPing = false,
    isPublic = false,
    requireActiveState = false,
    force = false,
  } = {},
) {
  const config = await loadMarioClashConfig();
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
  if (state && state.channelId !== channelId) {
    return { wrongChannel: true, activeChannelId: state.channelId };
  }
  if (!state && requireActiveState) {
    return { skipped: true };
  }

  // 1) Aucun état -> jour de présentation
  if (!state) {
    const embed = buildAnnonceEmbed(config);
    const components = [buildUtilityRow()];
    if (dryRun) {
      const pingRoleId = !noPing
        ? await getRoleIdByName(MINI_JEUX_ROLE_NAME)
        : null;
      return { dryRun: true, phase: "annonce", embed, components, pingRoleId };
    }
    return publishAndWriteState(channelId, null, {
      phase: "annonce",
      jour: null,
      embed,
      components,
      noPing,
      estAnnonce: true,
    });
  }

  // 2) Transition présentation -> Jour 1 : rien à clôturer, pas d'historique
  // à comparer — juste un mot d'ambiance de départ.
  if (state.phase === "annonce") {
    const jour = 1;
    const narratifs = await loadNarratifs();
    const embed = buildJourEmbed(jour, config, [
      pickFlavor(narratifs.depart, 1),
    ]);
    const components = buildJourComponents(jour);
    if (dryRun) return { dryRun: true, phase: "jour", jour, embed, components };
    return publishAndWriteState(channelId, state, {
      phase: "jour",
      jour,
      embed,
      components,
      noPing: true,
      estAnnonce: false,
    });
  }

  // 3) Clôture normale d'un jour de course — previewCloture() (lecture
  // seule) en dry-run, closeDayAndAdvance() (persiste) sinon ; même forme
  // de retour dans les deux cas (voir marioclash.js).
  const closure = dryRun
    ? await previewCloture(state.jour, config)
    : await closeDayAndAdvance(state.jour, config);

  if (closure.termine) {
    let currentManche = null;
    const ranking = sortedRanking(closure.joueurs);
    if (!dryRun && isPublic) {
      currentManche = await archiveManche({
        vainqueur: ranking[0]?.username || "Personne",
        positionFinale: ranking[0]?.position || 0,
        resolvedAt: new Date().toISOString(),
      });
    }
    const manches = await listManches({ limit: 10 });
    const embed = buildFinEmbed(
      closure.joueurs,
      config,
      manches,
      currentManche,
    );
    if (dryRun) return { dryRun: true, final: true, embed, closure };
    const result = await publishAndWriteState(channelId, state, {
      phase: "jour",
      jour: state.jour,
      embed,
      components: [],
      noPing,
      estAnnonce: false,
      termine: true,
    });
    return { ...result, final: true };
  }

  const narratifs = await loadNarratifs();
  const resumeLignes = buildResumeLignes(
    state.jour,
    closure.joueursAvant,
    closure.joueurs,
    closure.lignes,
    narratifs,
  );
  const embed = buildJourEmbed(closure.jourSuivant, config, resumeLignes);
  const components = buildJourComponents(closure.jourSuivant);
  if (dryRun)
    return {
      dryRun: true,
      jour: closure.jourSuivant,
      embed,
      components,
      closure,
    };
  return publishAndWriteState(channelId, state, {
    phase: "jour",
    jour: closure.jourSuivant,
    embed,
    components,
    noPing: true,
    estAnnonce: false,
  });
}

async function publishAndWriteState(
  channelId,
  previousState,
  { phase, jour, embed, components, noPing, estAnnonce, termine = false },
) {
  const token = process.env.DISCORD_TOKEN;
  if (!token) throw new Error("DISCORD_TOKEN manquant.");

  if (previousState?.messageId && previousState?.channelId) {
    try {
      const delRes = await fetch(
        `https://discord.com/api/v10/channels/${previousState.channelId}/messages/${previousState.messageId}`,
        {
          method: "DELETE",
          headers: { Authorization: `Bot ${token}` },
        },
      );
      if (!delRes.ok && delRes.status !== 404) {
        console.warn(
          `[MarioClash] Échec suppression du message de la veille (${delRes.status}), publication quand même.`,
        );
      }
    } catch (err) {
      console.warn(
        "[MarioClash] Erreur réseau à la suppression du message de la veille:",
        err.message,
      );
    }
  }

  const roleId =
    (estAnnonce || termine) && !noPing
      ? await getRoleIdByName(MINI_JEUX_ROLE_NAME)
      : null;

  const res = await fetch(
    `https://discord.com/api/v10/channels/${channelId}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bot ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        embeds: [embed],
        components,
        ...buildRolePingFields(roleId),
      }),
    },
  );
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
  });

  return { jour, embed, message, termine };
}

// ── Édition en place (réponses éphémères) ───────────────────────────

async function patchOriginal(webhookUrl, payload) {
  if (!webhookUrl) return;
  try {
    await fetch(`${webhookUrl}/messages/@original`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    console.error("[MarioClash] Échec PATCH:", err.message);
  }
}

async function guardActiveDay(webhookUrl, jour) {
  const state = await readState();
  if (
    !state ||
    state.phase !== "jour" ||
    state.termine ||
    String(state.jour) !== String(jour)
  ) {
    await patchOriginal(webhookUrl, {
      content: "La journée a changé entre-temps — regarde le nouveau message !",
      embeds: [],
      components: [],
    });
    return null;
  }
  return state;
}

// ── Bouton [🎲 Lancer le dé] + select du type de dé ──────────────────

export async function handleDiceButton(webhookUrl, jour, discordId, username) {
  try {
    if (!(await guardActiveDay(webhookUrl, jour))) return;
    const config = await loadMarioClashConfig();
    const joueur = await ensureJoueur(discordId, username);
    const actions = await readActions(jour);
    if (actions[discordId]?.dice) {
      await patchOriginal(webhookUrl, {
        content: "🎲 Tu as déjà lancé le dé aujourd'hui.",
        embeds: [],
        components: [],
      });
      return;
    }
    const devant = casesSpecialesDevant(joueur, config);
    const lignes = [`🎲 Tu es case **${joueur.position}**. Choisis ton dé :`];
    const etat = etatDeLigne(joueur);
    if (etat) lignes.push(etat);
    if (devant.length) lignes.push(`Devant toi : ${devant.join(", ")}`);
    await patchOriginal(webhookUrl, {
      content: lignes.join("\n"),
      embeds: [],
      components: buildDiceSelect(jour, config),
    });
  } catch (err) {
    console.error("[MarioClash] Échec bouton dé:", err.message);
  }
}

export async function handleDiceSelect(webhookUrl, jour, discordId, username, deId) {
  try {
    if (!(await guardActiveDay(webhookUrl, jour))) return;
    const config = await loadMarioClashConfig();
    await ensureJoueur(discordId, username);
    const result = await rollDiceForPlayer(Number(jour), discordId, deId, config);
    if (result.status === "alreadyRolled") {
      await patchOriginal(webhookUrl, {
        content: "🎲 Tu as déjà lancé le dé aujourd'hui.",
        embeds: [],
        components: [],
      });
      return;
    }
    if (result.status !== "ok") {
      await patchOriginal(webhookUrl, {
        content: "🎲 Lancer impossible.",
        embeds: [],
        components: [],
      });
      return;
    }
    const arrivee = result.position >= config.case_arrivee ? " 🏁" : "";
    const lignes = [
      `${result.de.emoji} Tu as fait **${result.valeur}** ! Tu avances de la case ${result.positionAvant} à la case **${result.positionDe}**. +${result.pointsGagnes} Or.`,
    ];
    if (result.gel) lignes.push("🧊 Gelé : tu n'avances que d'1 case.");
    else if (result.rage) lignes.push(`😡 Rage : +${result.rage} cases incluses.`);
    if (result.caseSpeciale) {
      const c = result.caseSpeciale;
      lignes.push(`${c.emoji} Case **${c.label}** : ${effetCaseTexte(c)} !`);
    }
    lignes.push(`📍 Case **${result.position}**${arrivee} · ${result.points} Or au total.`);
    await patchOriginal(webhookUrl, {
      content: lignes.join("\n"),
      embeds: [],
      components: [],
    });
  } catch (err) {
    console.error("[MarioClash] Échec select dé:", err.message);
  }
}

// ── Bouton [🛍️ Boutique] + select d'achat ───────────────────────────

export async function handleBoutiqueButton(
  webhookUrl,
  jour,
  discordId,
  username,
) {
  try {
    if (!(await guardActiveDay(webhookUrl, jour))) return;
    const config = await loadMarioClashConfig();
    const joueur = await ensureJoueur(discordId, username);
    if (joueur.objet) {
      await patchOriginal(webhookUrl, {
        content: `🛍️ Tu as déjà acheté ${config.objets[joueur.objet]?.emoji || ""} **${config.objets[joueur.objet]?.label}** aujourd'hui, il s'appliquera à la clôture. Un seul objet par jour.`,
        embeds: [],
        components: [],
      });
      return;
    }
    if (joueur.dernierAchatJour === Number(jour)) {
      await patchOriginal(webhookUrl, {
        content:
          "🛍️ Tu as déjà acheté un objet aujourd'hui — un seul achat par jour.",
        embeds: [],
        components: [],
      });
      return;
    }
    await patchOriginal(webhookUrl, {
      content: "🛍️ Choisis ton objet :",
      embeds: [],
      components: buildBoutiqueSelect(jour, config, joueur),
    });
  } catch (err) {
    console.error("[MarioClash] Échec bouton boutique:", err.message);
  }
}

// Achat ET activation en une seule étape — plus de bouton [🎒 Utiliser
// objet] séparé (décision explicite, simplifie le flux). Objet "soi"
// (Accélérateur/Étoile) : mis en file pour la clôture immédiatement après
// l'achat, aucune cible à choisir. Objet "adversaire" (Bombe/Banane) :
// l'achat est débité tout de suite, puis un select de cible s'affiche —
// même mécanique de clôture qu'avant, juste sans le clic intermédiaire.
export async function handleBoutiqueSelect(
  webhookUrl,
  jour,
  discordId,
  username,
  itemId,
) {
  try {
    if (!(await guardActiveDay(webhookUrl, jour))) return;
    const config = await loadMarioClashConfig();
    const item = config.objets[itemId];
    // Cibles vérifiées AVANT le débit : sans adversaire à portée, l'Or
    // n'est pas dépensé pour rien.
    let candidats = null;
    if (item?.cible === "adversaire") {
      candidats = ciblesObjet(await readJoueurs(), discordId, item);
      if (!candidats.length) {
        await patchOriginal(webhookUrl, {
          content: item.portee
            ? `🛍️ Aucun adversaire à ${item.portee} cases devant toi ou moins : ${item.emoji} **${item.label}** non acheté(e).`
            : `🛍️ Aucun autre joueur à cibler pour l'instant : ${item.emoji} **${item.label}** non acheté(e).`,
          embeds: [],
          components: [],
        });
        return;
      }
    }
    const result = await purchaseItem(
      discordId,
      username,
      itemId,
      Number(jour),
      config,
    );
    if (result.status === "insufficientPoints") {
      await patchOriginal(webhookUrl, {
        content: `🛍️ Pas assez d'Or (tu as ${result.joueur.points} Or, il en faut ${item.cout}).`,
        embeds: [],
        components: [],
      });
      return;
    }
    if (result.status === "alreadyPurchasedToday") {
      await patchOriginal(webhookUrl, {
        content: "🛍️ Tu as déjà acheté un objet aujourd'hui.",
        embeds: [],
        components: [],
      });
      return;
    }
    if (result.status !== "ok") {
      await patchOriginal(webhookUrl, {
        content: "🛍️ Achat impossible.",
        embeds: [],
        components: [],
      });
      return;
    }

    if (item.cible === "leader") {
      await recordItemUse(jour, discordId, null);
      await patchOriginal(webhookUrl, {
        content: `🛍️ Acheté et activé : ${item.emoji} **${item.label}** ! Elle frappera le joueur en tête à la clôture.`,
        embeds: [],
        components: [],
      });
      return;
    }

    if (item.cible === "soi") {
      await recordItemUse(jour, discordId, null);
      await patchOriginal(webhookUrl, {
        content: `🛍️ Acheté et activé : ${item.emoji} **${item.label}** ! Effet appliqué à la clôture.`,
        embeds: [],
        components: [],
      });
      return;
    }

    const components = buildTargetSelectRow(
      `marioclash_item_target:${jour}`,
      candidats,
    );
    await patchOriginal(webhookUrl, {
      content: `🛍️ Acheté : ${item.emoji} **${item.label}** — choisis ta cible :`,
      embeds: [],
      components,
    });
  } catch (err) {
    console.error("[MarioClash] Échec select boutique:", err.message);
  }
}

export async function handleItemTargetSelect(
  webhookUrl,
  jour,
  discordId,
  targetId,
) {
  try {
    if (!(await guardActiveDay(webhookUrl, jour))) return;
    const config = await loadMarioClashConfig();
    const joueur = await readJoueur(discordId);
    if (!joueur?.objet) {
      await patchOriginal(webhookUrl, {
        content: "🎒 Tu ne possèdes plus d'objet.",
        embeds: [],
        components: [],
      });
      return;
    }
    const actions = await readActions(jour);
    if (actions[discordId]?.item) {
      await patchOriginal(webhookUrl, {
        content: "🎒 Tu as déjà activé ton objet aujourd'hui.",
        embeds: [],
        components: [],
      });
      return;
    }
    const item = config.objets[joueur.objet];
    const candidats = ciblesObjet(await readJoueurs(), discordId, item);
    if (!candidats.some((c) => c.discordId === targetId)) {
      await patchOriginal(webhookUrl, {
        content: `${item.emoji} Cible hors de portée, choisis-en une autre :`,
        embeds: [],
        components: buildTargetSelectRow(`marioclash_item_target:${jour}`, candidats),
      });
      return;
    }
    await recordItemUse(jour, discordId, targetId);
    const cible = await readJoueur(targetId);
    await patchOriginal(webhookUrl, {
      content: `${item.emoji} ${item.label} activé sur **${cible?.username || "?"}** — effet révélé à la clôture !`,
      embeds: [],
      components: [],
    });
  } catch (err) {
    console.error("[MarioClash] Échec select cible objet:", err.message);
  }
}

// ── Bouton [✨ Lancer un sort] — toujours sur soi-même, effet totalement
// aléatoire, aucun choix du joueur ; le résultat tiré est annoncé
// immédiatement (même principe que le dé), seule l'application
// (déplacement, blocage éventuel par l'Étoile) reste différée à la
// clôture — voir castSpellForPlayer().

// Le clic sur [✨ Lancer un sort] ne fait qu'afficher une confirmation
// (évite les clics accidentels : le sort est définitif et consomme la
// Concentration) ; le lancer réel passe par handleSpellConfirm().
export async function handleSpellButton(webhookUrl, jour, discordId, username) {
  try {
    if (!(await guardActiveDay(webhookUrl, jour))) return;
    const config = await loadMarioClashConfig();
    const joueur = await ensureJoueur(discordId, username);
    const actions = await readActions(Number(jour));
    if (actions[discordId]?.spell) {
      await patchOriginal(webhookUrl, {
        content: "✨ Tu as déjà lancé un sort aujourd'hui.",
        embeds: [],
        components: [],
      });
      return;
    }
    const niveau = joueur?.concentration || 0;
    await patchOriginal(webhookUrl, {
      content: [
        "✨ Lancer un sort maintenant ? Il est tiré au hasard et ne peut pas être annulé.",
        niveau ? `🔋 Ta Concentration (${niveau}/${config.concentration_max}) sera consommée.` : null,
      ]
        .filter(Boolean)
        .join("\n"),
      embeds: [],
      components: [
        {
          type: 1,
          components: [
            {
              type: 2,
              style: 3,
              label: "Confirmer",
              emoji: { name: "✨" },
              custom_id: `marioclash_spell_confirm:${jour}`,
            },
            {
              type: 2,
              style: 2,
              label: "Annuler",
              custom_id: "marioclash_spell_cancel",
            },
          ],
        },
      ],
    });
  } catch (err) {
    console.error("[MarioClash] Échec bouton sort:", err.message);
  }
}

export async function handleSpellConfirm(webhookUrl, jour, discordId, username) {
  try {
    if (!(await guardActiveDay(webhookUrl, jour))) return;
    const config = await loadMarioClashConfig();
    await ensureJoueur(discordId, username);
    const result = await castSpellForPlayer(Number(jour), discordId, config);
    if (result.status === "alreadyCast") {
      await patchOriginal(webhookUrl, {
        content: "✨ Tu as déjà lancé un sort aujourd'hui.",
        embeds: [],
        components: [],
      });
      return;
    }
    await patchOriginal(webhookUrl, {
      content: [
        result.concentration
          ? `🔋 Concentration ${result.concentration}/${config.concentration_max} utilisée.`
          : null,
        `✨ Sort lancé sur toi-même : *${result.sort.label}*. Appliqué à la clôture du jour !`,
      ]
        .filter(Boolean)
        .join("\n"),
      embeds: [],
      components: [],
    });
  } catch (err) {
    console.error("[MarioClash] Échec confirmation sort:", err.message);
  }
}

// ── Bouton [📜 Journal] (éphémère) — classement courant + bilan de la veille ──

export async function handleJournal(webhookUrl, discordId) {
  try {
    const state = await readState();
    if (!state || state.phase !== "jour") {
      await patchOriginal(webhookUrl, {
        content: "Aucun journal disponible pour l'instant.",
        embeds: [],
        components: [],
      });
      return;
    }
    const config = await loadMarioClashConfig();
    const joueurs = await readJoueurs();
    const veille =
      state.jour > 1 ? await getHistoriqueEntry(state.jour - 1) : null;
    const actions = await readActions(state.jour);
    const deLances = new Set(
      Object.entries(actions)
        .filter(([, a]) => a?.dice)
        .map(([id]) => id),
    );
    const embed = buildJournalEmbed(
      state.jour,
      config,
      joueurs,
      veille?.lignes,
      discordId,
      deLances,
    );
    await patchOriginal(webhookUrl, { embeds: [embed], components: [] });
  } catch (err) {
    console.error("[MarioClash] Échec Journal:", err.message);
  }
}

// ── Bouton [📖 Règles] (éphémère, statique) ──────────────────────────

export async function handleRegles(webhookUrl) {
  try {
    const config = await loadMarioClashConfig();
    await patchOriginal(webhookUrl, {
      embeds: [buildReglesEmbed(config)],
      components: [],
    });
  } catch (err) {
    console.error("[MarioClash] Échec Règles:", err.message);
  }
}
