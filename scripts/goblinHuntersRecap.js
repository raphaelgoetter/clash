#!/usr/bin/env node
// goblinHuntersRecap.js
// Compte-rendu détaillé de la partie Goblin Hunters en cours ou tout juste
// terminée, à partir des jours clôturés (historique + carnets d'indices) :
// votes au Château (camp des votants/cibles, votes contre son camp),
// combats (attaques contre son camp), éliminations, enquêtes, absences.
// Lecture seule, aucune écriture Redis. ⚠️ Usage ADMIN UNIQUEMENT — révèle
// les camps/rôles, ne jamais partager en cours de partie.
//
// Le détail des votes (qui a voté pour qui) n'existe que pour les jours
// dont l'historique contient `actions` (archivées depuis le 2026-09-30) :
// pour les jours antérieurs, seuls les votes REÇUS par cible sont connus.
//
// Usage : node scripts/goblinHuntersRecap.js

import dotenv from "dotenv";
dotenv.config({ path: "./.env" });

import {
  loadGoblinHuntersConfig,
  readState,
  listHistorique,
  readPlayerIndices,
} from "../backend/services/goblinhunters.js";

const VICTOIRES = {
  gobelins_parite: "Gobelins (parité atteinte)",
  chasseurs_gobelins_elimines: "Villageois (tous les Gobelins éliminés)",
  chasseurs_survie: "Villageois (survie jusqu'au dernier jour)",
};

const pct = (n, total) => (total ? `${Math.round((n / total) * 100)} %` : "—");

// Camp/rôle d'un joueur un jour donné : un Villageois converti par le
// Gobelin-zombie reste Villageois le jour de sa conversion (appliquée à la
// clôture), Gobelin sans rôle ensuite.
const campAt = (j, jour) =>
  j.converti ? (jour > j.converti ? "gobelin" : "chasseur") : j.camp;
const roleAt = (j, jour) =>
  j.converti ? (jour > j.converti ? null : j.roleOrigine) : j.role;

// Même logique que extractVote() côté service (primary prioritaire,
// secondary pour l'Éclaireur).
const voteOf = (action) =>
  [action?.primary, action?.secondary].find(
    (a) => a?.lieu === "chateau" && a.cibleId,
  )?.cibleId ?? null;

(async () => {
  const state = await readState();
  if (!state?.joueurs?.length) {
    console.log("Aucune partie Goblin Hunters lancée.");
    return;
  }
  const config = await loadGoblinHuntersConfig();
  const { entries } = await listHistorique({ limit: 1000 });
  const jours = entries.sort((a, b) => a.jour - b.jour);
  if (!jours.length) {
    console.log("Aucun jour clôturé pour le moment.");
    return;
  }

  const byId = new Map(state.joueurs.map((j) => [j.discordId, j]));
  const nom = (id) => {
    const j = byId.get(id);
    if (!j) return id;
    return j.bot ? `${j.usernameOrigine} → ${j.username}` : j.username;
  };
  const campLabel = (camp) => `${config.camps[camp].emoji} ${config.camps[camp].labelSingulier}`;
  const lieuLabel = (lieu) => config.lieux[lieu]?.label ?? lieu;
  const roleLabel = (role) => (role ? config.roles[role]?.label ?? role : null);
  const qui = (id, jour) => {
    const j = byId.get(id);
    if (!j) return id;
    const role = roleLabel(roleAt(j, jour));
    return `${nom(id)} (${campLabel(campAt(j, jour))}${role ? `, ${role}` : ""})`;
  };

  // Attaques de toute la partie, reconstruites depuis les carnets d'indices
  // (chaque attaque résolue y est notée côté attaquant).
  const indices = await Promise.all(
    state.joueurs.map(async (j) => [j.discordId, await readPlayerIndices(j.discordId)]),
  );
  const attaquesParJour = {};
  for (const [attackerId, list] of indices) {
    for (const i of list.filter((x) => x.type === "combat")) {
      (attaquesParJour[i.jour] ??= []).push({ attackerId, targetId: i.cibleId, lieu: i.lieu });
    }
  }

  const joursClos = jours.map((e) => e.jour);
  const joursDetailles = jours.filter((e) => e.actions).map((e) => e.jour);
  const dernier = jours.at(-1);

  // ── Compteurs ──────────────────────────────────────────────────────
  const votes = { total: 0, recusParCamp: { chasseur: 0, gobelin: 0 } };
  const votesDetail = { total: 0, parCamp: { chasseur: 0, gobelin: 0 }, contreSonCamp: [], contreImmunise: 0 };
  const votesRecus = {};
  const votesEmis = {};
  const elimVote = [];
  const joursSansElim = [];
  const combat = { total: 0, parCamp: { chasseur: 0, gobelin: 0 }, contreSonCamp: [], auHasard: 0 };
  const attaquesRecues = {};
  const attaquesEmises = {};
  const mortsCombat = [];
  const evenements = [];
  const enquetes = { total: 0, trompeuses: 0, surpeuplee: [], reportes: { chasseur: 0, gobelin: 0 }, cibles: { chasseur: {}, gobelin: {} } };
  const absences = { total: 0, parJour: [] };
  const remplacements = [];
  const frequentation = {};
  let actionsDetaillees = 0;

  for (const e of jours) {
    const { jour } = e;

    // Château
    const tally = e.voteTally ?? {};
    for (const [cibleId, n] of Object.entries(tally)) {
      votes.total += n;
      votes.recusParCamp[campAt(byId.get(cibleId), jour)] += n;
      votesRecus[cibleId] = (votesRecus[cibleId] || 0) + n;
    }
    if (e.eliminationsParVote) elimVote.push({ jour, id: e.eliminationsParVote });
    else if (jour > 1 && Object.keys(tally).length) joursSansElim.push(jour);

    if (e.actions) {
      for (const [voterId, action] of Object.entries(e.actions)) {
        for (const slot of [action.primary, action.secondary]) {
          if (!slot) continue;
          actionsDetaillees++;
          frequentation[slot.lieu] = (frequentation[slot.lieu] || 0) + 1;
        }
        const cibleId = voteOf(action);
        if (!cibleId) continue;
        const voter = byId.get(voterId);
        const cible = byId.get(cibleId);
        votesDetail.total++;
        votesDetail.parCamp[campAt(voter, jour)]++;
        votesEmis[voterId] = (votesEmis[voterId] || 0) + 1;
        if (cibleId === e.immuneId) votesDetail.contreImmunise++;
        if (campAt(voter, jour) === campAt(cible, jour)) {
          votesDetail.contreSonCamp.push({ jour, voterId, cibleId });
        }
      }
    }

    // Combat
    for (const a of attaquesParJour[jour] ?? []) {
      const attacker = byId.get(a.attackerId);
      const target = byId.get(a.targetId);
      combat.total++;
      combat.parCamp[campAt(attacker, jour)]++;
      attaquesEmises[a.attackerId] = (attaquesEmises[a.attackerId] || 0) + 1;
      attaquesRecues[a.targetId] = (attaquesRecues[a.targetId] || 0) + 1;
      // Cible tirée au hasard (aucune cible choisie) : connu seulement pour
      // les jours détaillés.
      const action = e.actions?.[a.attackerId];
      const auHasard =
        action &&
        ![action.primary, action.secondary].some(
          (s) => s?.lieu === a.lieu && s.cibleId === a.targetId,
        );
      if (auHasard) combat.auHasard++;
      if (campAt(attacker, jour) === campAt(target, jour)) {
        combat.contreSonCamp.push({ jour, ...a, auHasard });
      }
    }
    if (e.deathIdCombat) mortsCombat.push({ jour, id: e.deathIdCombat });
    if (e.conversionId) evenements.push(`J${jour} : ${qui(e.conversionId, jour)} converti(e) en Gobelin par le Zombie`);
    if (e.explosifRetaliation?.targetId) {
      evenements.push(`J${jour} : riposte de l'Explosif ${nom(e.explosifRetaliation.gobelinId)} sur ${qui(e.explosifRetaliation.targetId, jour)}`);
    }
    if (e.guetApensReveal) evenements.push(`J${jour} : Guet-Apens déclenché à la mort de ${nom(e.deathIdCombat)}`);

    // Tour de Guet
    if (e.tourDeGuetSurpeuplee) enquetes.surpeuplee.push(jour);
    for (const inv of e.investigations ?? []) {
      enquetes.total++;
      enquetes.reportes[inv.campReporte]++;
      // Nombre d'enquêtes par joueur révélé (un même joueur peut être
      // enquêté par plusieurs enquêteurs).
      const cibles = enquetes.cibles[inv.campReporte];
      cibles[inv.cibleId] = (cibles[inv.cibleId] || 0) + 1;
      if (inv.campReporte !== campAt(byId.get(inv.cibleId), jour)) enquetes.trompeuses++;
    }

    // Absences
    const nbAbsents = e.absents?.length ?? 0;
    absences.total += nbAbsents;
    absences.parJour.push(`J${jour}: ${nbAbsents}`);
    for (const r of e.remplacements ?? []) remplacements.push(`J${jour} : ${r.ancienUsername} → ${r.nouveauUsername}`);
  }

  const top = (counts, n = 3) =>
    Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([id, c]) => `${nom(id)} (${c})`)
      .join(", ") || "—";

  // ── Affichage ─────────────────────────────────────────────────────
  const initiaux = state.joueurs.reduce((acc, j) => {
    const camp = j.converti ? "chasseur" : j.camp;
    acc[camp] = (acc[camp] || 0) + 1;
    return acc;
  }, {});
  const titre = (t) => console.log(`\n━━ ${t} ━━`);
  // Répartition Gobelins/Villageois d'une liste d'éliminations { jour, id }
  const parCamp = (list) => {
    const n = { chasseur: 0, gobelin: 0 };
    for (const { jour, id } of list) n[campAt(byId.get(id), jour)]++;
    return `${n.gobelin} Gobelin(s), ${n.chasseur} Villageois`;
  };

  console.log(`⚠️  SORTIE ADMIN — révèle les camps/rôles, ne jamais partager en cours de partie.\n`);
  console.log(`GOBLIN HUNTERS — compte-rendu`);
  console.log(`Jours clôturés : J${joursClos[0]} → J${dernier.jour}${state.termine ? " (partie terminée)" : ` (partie en cours, jour ${state.jour})`}`);
  console.log(`Vainqueur : ${dernier.victory ? VICTOIRES[dernier.victory] ?? dernier.victory : "—"}`);
  console.log(`Joueurs : ${state.joueurs.length} (${initiaux.chasseur || 0} Villageois, ${initiaux.gobelin || 0} Gobelins au départ)`);
  console.log(`Détail des actions disponible : ${joursDetailles.length ? joursDetailles.map((j) => `J${j}`).join(", ") : "aucun jour"}`);

  titre("Château (votes)");
  console.log(`Votes comptés : ${votes.total}`);
  console.log(`  contre des Villageois : ${votes.recusParCamp.chasseur} (${pct(votes.recusParCamp.chasseur, votes.total)})`);
  console.log(`  contre des Gobelins   : ${votes.recusParCamp.gobelin} (${pct(votes.recusParCamp.gobelin, votes.total)})`);
  console.log(`Éliminés par vote : ${elimVote.length} (${parCamp(elimVote)})`);
  for (const { jour, id } of elimVote) console.log(`  J${jour} : ${qui(id, jour)} (${jours.find((e) => e.jour === jour).voteTally[id]} votes)`);
  console.log(`Jours avec votes mais sans élimination (égalité/quorum) : ${joursSansElim.map((j) => `J${j}`).join(", ") || "aucun"}`);
  console.log(`Joueurs les plus visés : ${top(votesRecus)}`);
  if (joursDetailles.length) {
    const d = votesDetail;
    console.log(`\nSur les jours détaillés (${joursDetailles.map((j) => `J${j}`).join(", ")}) :`);
    console.log(`  Votants : ${d.total} (Villageois ${d.parCamp.chasseur} / ${pct(d.parCamp.chasseur, d.total)}, Gobelins ${d.parCamp.gobelin} / ${pct(d.parCamp.gobelin, d.total)})`);
    console.log(`  Votes contre son propre camp : ${d.contreSonCamp.length} (${pct(d.contreSonCamp.length, d.total)})`);
    for (const v of d.contreSonCamp) console.log(`    J${v.jour} : ${qui(v.voterId, v.jour)} → ${qui(v.cibleId, v.jour)}`);
    if (d.contreImmunise) console.log(`  Votes perdus sur l'immunisé(e) : ${d.contreImmunise}`);
    console.log(`  Plus assidus au Château : ${top(votesEmis)}`);
  } else {
    console.log(`Camp des votants / votes contre son camp : non disponible (aucun jour détaillé)`);
  }

  titre("Combats");
  console.log(`Attaques portées : ${combat.total} (Villageois ${combat.parCamp.chasseur}, Gobelins ${combat.parCamp.gobelin})`);
  console.log(`Attaques contre son propre camp : ${combat.contreSonCamp.length} (${pct(combat.contreSonCamp.length, combat.total)})`);
  for (const a of combat.contreSonCamp) {
    console.log(`  J${a.jour} @ ${lieuLabel(a.lieu)} : ${qui(a.attackerId, a.jour)} → ${qui(a.targetId, a.jour)}${a.auHasard ? " (cible au hasard)" : ""}`);
  }
  if (joursDetailles.length) console.log(`Attaques sur cible tirée au hasard (jours détaillés) : ${combat.auHasard}`);
  console.log(`Morts au combat : ${mortsCombat.length} (${parCamp(mortsCombat)})`);
  for (const { jour, id } of mortsCombat) console.log(`  J${jour} : ${qui(id, jour)}`);
  console.log(`Plus offensifs : ${top(attaquesEmises)}`);
  console.log(`Plus attaqués : ${top(attaquesRecues)}`);

  if (evenements.length) {
    titre("Événements spéciaux");
    evenements.forEach((l) => console.log(l));
  }

  titre("Bilan des morts");
  const morts = [...elimVote, ...mortsCombat];
  console.log(`Total : ${morts.length} (${parCamp(morts)}) : ${elimVote.length} par vote, ${mortsCombat.length} au combat`);

  titre("Tour de Guet");
  const revelés = (camp) =>
    Object.entries(enquetes.cibles[camp])
      .map(([id, n]) => `${nom(id)}${n > 1 ? ` ×${n}` : ""}`)
      .join(", ") || "—";
  console.log(`Enquêtes menées : ${enquetes.total} (dont ${enquetes.trompeuses} au résultat trompeur)`);
  console.log(`  Gobelins démasqués : ${Object.keys(enquetes.cibles.gobelin).length} joueur(s), en ${enquetes.reportes.gobelin} enquête(s) : ${revelés("gobelin")}`);
  console.log(`  Villageois innocentés : ${Object.keys(enquetes.cibles.chasseur).length} joueur(s), en ${enquetes.reportes.chasseur} enquête(s) : ${revelés("chasseur")}`);
  console.log(`Jours surpeuplés (aucune enquête) : ${enquetes.surpeuplee.map((j) => `J${j}`).join(", ") || "aucun"}`);

  if (actionsDetaillees) {
    titre("Fréquentation des lieux (jours détaillés)");
    for (const [lieu, n] of Object.entries(frequentation).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${lieuLabel(lieu)} : ${n} (${pct(n, actionsDetaillees)})`);
    }
  }

  titre("Participation");
  console.log(`Absences : ${absences.total} (${absences.parJour.join(", ")})`);
  console.log(`Remplacements par un bot : ${remplacements.length}`);
  remplacements.forEach((l) => console.log(`  ${l}`));

  titre("Bilan final des joueurs");
  for (const j of state.joueurs) {
    const role = roleLabel(j.converti ? j.roleOrigine : j.role);
    const statut = j.alive ? `vivant(e), ${j.pv}/${j.pvMax} PV` : `éliminé(e) J${j.campReveleAt}`;
    const conversion = j.converti ? `, converti(e) J${j.converti}` : "";
    console.log(`  ${campLabel(j.camp)} ${nom(j.discordId)}${role ? ` [${role}]` : ""} (${statut}${conversion})`);
  }
})();
