// Page de relecture « Intrus de l'inventaire » (servie par ../demoValidation.js).
// Vue Planches : liste compacte (vignettes 64 px, intrus en premier),
// alertes, décision ; « Régler » ouvre la planche rendue par le serveur
// (code de production) et les réglages des 4 objets. Vue Objets : catalogue
// filtrable (netteté, style, jeu, étiquette, réserve) et exclusion en lot.

const API = "/api/intrus/demo";
const NETTETE_RATIO_ALERTE = 3.5;
const $ = (id) => document.getElementById(id);

const etat = {
  data: null,
  objetsById: new Map(),
  rangDansStyle: new Map(),
  vue: "planches",
};

// ── Données ───────────────────────────────────────────────────────────
const styleDe = (o) => o.style ?? o.analyse.styleAuto;

function indexer() {
  etat.objetsById = new Map(etat.data.objets.map((o) => [o.id, o]));
  // Rang de netteté au sein du même style (0 % = le plus flou du style) : le
  // score brut n'est comparable qu'entre icônes de style proche.
  const parStyle = new Map();
  for (const o of etat.data.objets) {
    const s = styleDe(o);
    if (!parStyle.has(s)) parStyle.set(s, []);
    parStyle.get(s).push(o);
  }
  etat.rangDansStyle.clear();
  for (const liste of parStyle.values()) {
    liste.sort((a, b) => a.analyse.nettete - b.analyse.nettete);
    liste.forEach((o, i) => etat.rangDansStyle.set(o.id, liste.length > 1 ? Math.round((i / (liste.length - 1)) * 100) : 100));
  }
}

async function charger() {
  const res = await fetch(`${API}/state`);
  if (!res.ok) throw new Error("chargement impossible");
  etat.data = await res.json();
  indexer();
  initFiltres();
  rendre();
}

async function patcherObjets(ids, patch) {
  const res = await fetch(`${API}/objets`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids, patch }),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "enregistrement impossible");
  const { objets } = await res.json();
  for (const maj of objets) {
    const local = etat.objetsById.get(maj.id);
    for (const cle of ["accentuation", "style", "etiquettes", "exclu"]) {
      if (cle in maj) local[cle] = maj[cle];
      else delete local[cle];
    }
  }
  indexer();
}

async function enregistrerDecision(manche, statut, commentaire) {
  const res = await fetch(`${API}/decision`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: manche.id, statut, commentaire }),
  });
  if (!res.ok) throw new Error("décision non enregistrée");
  etat.data.decisions = (await res.json()).decisions;
  rendreResume();
}

// ── Carte d'objet (partagée par les deux vues) ────────────────────────
function etiquettesConnues() {
  return [...new Set(etat.data.objets.flatMap((o) => o.etiquettes ?? []))].sort();
}

function majDatalist() {
  $("etiquettes").replaceChildren(...etiquettesConnues().map((t) => Object.assign(document.createElement("option"), { value: t })));
}

function carteObjet(o, { lettre = "", intrus = false, apresMaj = () => {} } = {}) {
  const el = $("tpl-carte").content.firstElementChild.cloneNode(true);
  const img = el.querySelector("img");
  const acc = el.querySelector(".acc");
  const accVal = el.querySelector(".acc-val");
  const style = el.querySelector(".style");
  const etiq = el.querySelector(".etiq");
  const exclu = el.querySelector(".exclu");
  const niveau = o.accentuation ?? 0;
  const seuil = Number($("f-seuil").value);

  el.classList.toggle("is-exclu", Boolean(o.exclu));
  el.classList.toggle("is-intrus", intrus);
  el.classList.toggle("is-flou", seuil > 0 && o.analyse.nettete < seuil);
  el.querySelector(".lettre").textContent = lettre;
  img.src = `${API}/icone/${encodeURIComponent(o.id)}.png?acc=${niveau}`;
  img.alt = o.nom;
  el.querySelector(".carte-nom").textContent = o.nom;
  el.querySelector(".carte-jeu").textContent = `${o.jeu}${o.manche ? ` · ${o.manche}` : " · réserve"}`;
  el.querySelector(".carte-mesures").textContent =
    `Netteté ${o.analyse.nettete} · rang ${etat.rangDansStyle.get(o.id)} % dans son style`;

  acc.max = String(etat.data.maxAccentuation);
  acc.value = String(niveau);
  accVal.textContent = String(niveau);
  // Aperçu immédiat pendant le glissement, enregistrement au relâchement.
  acc.addEventListener("input", () => {
    accVal.textContent = acc.value;
    img.src = `${API}/icone/${encodeURIComponent(o.id)}.png?acc=${acc.value}`;
  });
  acc.addEventListener("change", () => sauver([o.id], { accentuation: Number(acc.value) }, apresMaj));

  const auto = etat.data.styles[o.analyse.styleAuto];
  style.replaceChildren(
    Object.assign(document.createElement("option"), { value: "", textContent: `Auto (${auto})` }),
    ...Object.entries(etat.data.styles).map(([v, t]) => Object.assign(document.createElement("option"), { value: v, textContent: t })),
  );
  style.value = o.style ?? "";
  style.addEventListener("change", () => sauver([o.id], { style: style.value || null }, apresMaj));

  etiq.value = (o.etiquettes ?? []).join(", ");
  etiq.addEventListener("change", () =>
    sauver([o.id], { etiquettes: etiq.value.split(",") }, () => {
      majDatalist();
      apresMaj();
    }),
  );

  exclu.checked = Boolean(o.exclu);
  exclu.addEventListener("change", () => sauver([o.id], { exclu: exclu.checked }, apresMaj));
  return el;
}

function sauver(ids, patch, apres) {
  patcherObjets(ids, patch).then(apres).catch((err) => alert(`Erreur : ${err.message}`));
}

// ── Vue Planches (liste compacte) ─────────────────────────────────────
const RAISONS_VISUEL = {
  "trio-clone": "les 3 objets du jeu sont des variantes quasi identiques",
  silhouette: "la silhouette de l'intrus tranche avec le trio",
  structure: "l'intrus se distingue visuellement du trio",
};
const LIBELLES_STATUT = { valide: "Validée", refuse: "Refusée", a_revoir: "Non tranchée" };

function statutDe(manche) {
  return etat.data.decisions[manche.id]?.statut ?? "a_revoir";
}

function alertesDe(manche) {
  const objets = manche.ids.map((id) => etat.objetsById.get(id)).filter(Boolean);
  const alertes = (manche.visuel?.raisons ?? []).map((r) => `Intrus visible : ${RAISONS_VISUEL[r] ?? r}`);
  // Familles comme assemblerManches.js : aplat et peint se recouvrent.
  const famille = (o) => (["aplat", "peint"].includes(styleDe(o)) ? "illustre" : styleDe(o));
  if (new Set(objets.map(famille)).size > 1) {
    alertes.push(`Styles mélangés (${[...new Set(objets.map((o) => etat.data.styles[styleDe(o)]))].join(", ")})`);
  }
  const scores = objets.map((o) => o.analyse.nettete);
  const ratio = Math.max(...scores) / Math.max(Math.min(...scores), 0.01);
  if (ratio >= NETTETE_RATIO_ALERTE) alertes.push(`Netteté inégale (rapport ${ratio.toFixed(1)})`);
  for (const o of objets.filter((x) => x.exclu)) alertes.push(`Objet exclu : ${o.nom}`);
  return alertes;
}

function manchesVisibles() {
  const statut = $("f-statut").value;
  const avecAlerte = $("f-alertes").checked;
  return etat.data.manches.filter(
    (m) => (statut === "toutes" || statutDe(m) === statut) && (!avecAlerte || alertesDe(m).length > 0),
  );
}

const el = (tag, props = {}, ...enfants) => {
  const n = Object.assign(document.createElement(tag), props);
  n.append(...enfants);
  return n;
};

function vignette(o, intrus, onRemplacer) {
  const img = el("img", { src: `${API}/icone/${encodeURIComponent(o.id)}.png?acc=${o.accentuation ?? 0}`, alt: o.nom, loading: "lazy", title: `${o.nom} (${o.jeu})` });
  const bouton = el("button", { className: "remplacer", textContent: "↻", title: "Remplacer cet objet" });
  bouton.addEventListener("click", onRemplacer);
  return el("figure", { className: intrus ? "is-intrus" : "" }, img, el("figcaption", { textContent: o.nom }), bouton);
}

// Choix d'un remplaçant pour la position `index` (0 = intrus) : compatibles
// d'abord (même style, netteté comparable, intrus non visible), puis les
// autres en pointillés avec la raison.
async function ouvrirChoix(manche, index, zone, apres) {
  zone.hidden = false;
  const recherche = el("input", { placeholder: "Rechercher (nom ou jeu : baie, fleur, Elden Ring…)" });
  const fermer = el("button", { className: "neutre", textContent: "Fermer" });
  fermer.addEventListener("click", () => (zone.hidden = true));
  const titre = el("div", { className: "muted" });
  const choix = el("div", { className: "lp-choix" });
  zone.replaceChildren(el("div", { className: "lp-recherche" }, recherche, fermer), titre, choix);

  const charger = async () => {
    titre.textContent = "Recherche des remplaçants…";
    const q = encodeURIComponent(recherche.value.trim());
    const res = await fetch(`${API}/remplacants/${manche.id}/${index}?q=${q}`);
    if (!res.ok) throw new Error("remplaçants indisponibles");
    const { remplacants } = await res.json();
    titre.textContent = `Remplacer ${index === 0 ? "l'intrus" : `l'objet ${"ABCD"[index]}`} : ${remplacants.length} proposition(s) hors manche, ★ = même catégorie que la manche`;
    choix.replaceChildren(
      ...remplacants.map((r) => {
        const b = el(
          "button",
          { className: `remplacant${r.problemes.length ? " douteux" : ""}`, title: r.problemes.join(", ") || "compatible" },
          el("img", { src: `${API}/icone/${encodeURIComponent(r.id)}.png?acc=${r.accentuation}`, alt: r.nom, loading: "lazy" }),
          el("span", { textContent: `${r.memeCategorie ? "★ " : ""}${r.nom}` }),
          el("span", { className: "muted", textContent: index === 0 ? r.jeu : `net. ${r.nettete}` }),
          ...(r.problemes.length ? [el("span", { className: "probleme", textContent: r.problemes.join(", ") })] : []),
        );
        b.addEventListener("click", () => remplacerObjet(manche, index, r.id).then(apres).catch((err) => alert(err.message)));
        return b;
      }),
    );
  };
  let minuterie = null;
  recherche.addEventListener("input", () => {
    clearTimeout(minuterie);
    minuterie = setTimeout(() => charger().catch((err) => alert(err.message)), 300);
  });
  await charger();
}

async function remplacerObjet(manche, index, id) {
  const res = await fetch(`${API}/remplacer`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ gameId: manche.id, index, id }),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "remplacement impossible");
  const nouvelle = (await res.json()).manche;
  etat.objetsById.get(manche.ids[index]).manche = null;
  etat.objetsById.get(id).manche = nouvelle.id;
  etat.data.manches[etat.data.manches.indexOf(manche)] = nouvelle;
  return nouvelle;
}

function lignePlanche(manche) {
  const ligne = el("article", { className: `lp ${statutDe(manche)}` });
  const statut = el("b", { textContent: LIBELLES_STATUT[statutDe(manche)] });
  const tete = el(
    "div",
    { className: "lp-tete" },
    el("b", { textContent: manche.id }),
    el("span", { textContent: `${manche.jeu} ⟂ ${manche.jeuIntrus}` }),
    el("span", { className: "muted", textContent: `${etat.data.difficultes[manche.difficulte] ?? manche.difficulte}${manche.theme ? ` · ${manche.theme}` : ""}` }),
    statut,
  );
  const vignettes = el("div", { className: "lp-vignettes" });
  const alertes = el("ul", { className: "alertes" });
  const commentaire = el("input", { placeholder: "Commentaire", value: etat.data.decisions[manche.id]?.commentaire ?? "" });
  const details = el("div", { className: "lp-details", hidden: true });
  const zoneChoix = el("div", { className: "lp-remplacement", hidden: true });
  const apresRemplacement = (nouvelle) => {
    const ligneNeuve = lignePlanche(nouvelle);
    ligne.replaceWith(ligneNeuve);
  };

  const majObjets = () => {
    vignettes.replaceChildren(
      ...manche.ids.map((id, i) =>
        vignette(etat.objetsById.get(id), i === 0, () => ouvrirChoix(manche, i, zoneChoix, apresRemplacement).catch((err) => alert(err.message))),
      ),
    );
    alertes.replaceChildren(...alertesDe(manche).map((a) => el("li", { textContent: a })));
    if (!details.hidden) {
      details.querySelector("img").src = `${API}/planche/${manche.id}.png?v=${Date.now()}`;
    }
  };
  const decider = (valeur) =>
    enregistrerDecision(manche, valeur, commentaire.value.trim())
      .then(() => {
        ligne.className = `lp ${valeur}`;
        statut.textContent = LIBELLES_STATUT[valeur];
        // Une planche validée disparaît aussitôt, sauf si le filtre affiche
        // les validées ; une refusée reste visible pour être corrigée (↻).
        if (valeur === "valide" && !["valide", "toutes"].includes($("f-statut").value)) {
          ligne.remove();
          $("compte-planches").textContent = `${$("liste-planches").querySelectorAll(".lp").length} planche(s) · intrus toujours en premier (cadre doré)`;
        }
      })
      .catch((err) => alert(err.message));
  commentaire.addEventListener("change", () => decider(statutDe(manche)));

  const regler = el("button", { className: "neutre", textContent: "Régler ▾" });
  regler.addEventListener("click", () => {
    details.hidden = !details.hidden;
    if (details.hidden) return;
    details.replaceChildren(
      el("img", { src: `${API}/planche/${manche.id}.png?v=${Date.now()}`, alt: "Planche (intrus en A)" }),
      el("div", { className: "cartes" }, ...manche.ids.map((id, i) => carteObjet(etat.objetsById.get(id), { lettre: "ABCD"[i], intrus: i === 0, apresMaj: majObjets }))),
    );
  });

  const boutons = el(
    "div",
    { className: "boutons" },
    ...[["valide", "ok", "✅ Valider"], ["refuse", "ko", "❌ Refuser"], ["a_revoir", "neutre", "↩️ Non tranché"]].map(([v, c, t]) => {
      const b = el("button", { className: c, textContent: t });
      b.addEventListener("click", () => decider(v));
      return b;
    }),
    regler,
  );
  majObjets();
  ligne.append(tete, el("div", { className: "lp-corps" }, vignettes, el("div", { className: "lp-actions" }, alertes, boutons, commentaire)), zoneChoix, details);
  return ligne;
}

function rendrePlanches() {
  const liste = manchesVisibles();
  $("compte-planches").textContent = `${liste.length} planche(s) · intrus toujours en premier (cadre doré)`;
  $("liste-planches").replaceChildren(...(liste.length ? liste.map(lignePlanche) : [el("div", { className: "vide", textContent: "Aucune planche avec ces filtres." })]));
  rendreResume();
}

// ── Vue Objets ────────────────────────────────────────────────────────
function initFiltres() {
  const jeux = [...new Set(etat.data.objets.map((o) => o.jeu))].sort((a, b) => a.localeCompare(b, "fr"));
  const jeuActuel = $("f-jeu").value;
  $("f-jeu").replaceChildren(
    Object.assign(document.createElement("option"), { value: "", textContent: "Tous" }),
    ...jeux.map((j) => Object.assign(document.createElement("option"), { value: j, textContent: j })),
  );
  $("f-jeu").value = jeuActuel;
  if (!$("f-styles").children.length) {
    $("f-styles").replaceChildren(
      ...Object.entries(etat.data.styles).map(([v, t]) => {
        const label = document.createElement("label");
        const cb = Object.assign(document.createElement("input"), { type: "checkbox", checked: true, value: v });
        cb.addEventListener("change", rendreObjets);
        label.append(cb, ` ${t}`);
        return label;
      }),
    );
  }
  const max = Math.ceil(Math.max(...etat.data.objets.map((o) => o.analyse.nettete)));
  $("f-seuil").max = String(max);
  majDatalist();
}

function objetsVisibles() {
  const seuil = Number($("f-seuil").value);
  const sous = $("f-mode").value === "seulement";
  const jeu = $("f-jeu").value;
  const etiquette = $("f-etiquette").value.trim().toLowerCase();
  const styles = new Set([...$("f-styles").querySelectorAll("input:checked")].map((c) => c.value));
  const reserve = $("f-reserve").checked;
  const exclus = $("f-exclus").checked;
  const tri = $("f-tri").value;
  return etat.data.objets
    .filter((o) => {
      if (seuil > 0 && (sous ? o.analyse.nettete >= seuil : o.analyse.nettete < seuil)) return false;
      if (jeu && o.jeu !== jeu) return false;
      if (etiquette && !(o.etiquettes ?? []).some((t) => t.includes(etiquette))) return false;
      if (!styles.has(styleDe(o))) return false;
      if (reserve && o.manche) return false;
      if (!exclus && o.exclu) return false;
      return true;
    })
    .sort((a, b) => {
      if (tri === "jeu") return a.jeu.localeCompare(b.jeu, "fr") || a.nom.localeCompare(b.nom, "fr");
      const d = a.analyse.nettete - b.analyse.nettete;
      return tri === "nettete-desc" ? -d : d;
    });
}

function rendreObjets() {
  $("f-seuil-val").textContent = $("f-seuil").value;
  const liste = objetsVisibles();
  const enManche = liste.filter((o) => o.manche).length;
  $("compte").textContent = `${liste.length} objet(s) affiché(s), dont ${enManche} dans une manche`;
  $("objets").replaceChildren(...liste.map((o) => carteObjet(o, { apresMaj: rendreResume })));
  rendreResume();
}

async function lot(exclu) {
  const liste = objetsVisibles();
  if (!liste.length) return;
  const enManche = liste.filter((o) => o.manche).length;
  const verbe = exclu ? "Exclure" : "Réintégrer";
  const avert = exclu && enManche ? `\n⚠️ ${enManche} d'entre eux sont dans une manche (à remplacer ensuite).` : "";
  if (!confirm(`${verbe} ${liste.length} objet(s) ?${avert}`)) return;
  await patcherObjets(liste.map((o) => o.id), { exclu });
  rendreObjets();
}

// ── Commun ────────────────────────────────────────────────────────────
function rendreResume() {
  const statuts = etat.data.manches.map(statutDe);
  const n = (s) => statuts.filter((x) => x === s).length;
  const exclus = etat.data.objets.filter((o) => o.exclu).length;
  $("resume").textContent =
    `Manches : ${n("valide")} validées · ${n("refuse")} refusées · ${n("a_revoir")} à revoir · Objets : ${etat.data.objets.length} (${exclus} exclus)`;
}

function rendre() {
  for (const t of document.querySelectorAll(".tab")) t.classList.toggle("is-active", t.dataset.vue === etat.vue);
  $("vue-planches").hidden = etat.vue !== "planches";
  $("vue-objets").hidden = etat.vue !== "objets";
  if (etat.vue === "planches") rendrePlanches();
  else rendreObjets();
}

for (const t of document.querySelectorAll(".tab")) {
  t.addEventListener("click", () => {
    etat.vue = t.dataset.vue;
    rendre();
  });
}
for (const id of ["f-statut", "f-alertes"]) $(id).addEventListener("change", rendrePlanches);
for (const id of ["f-seuil", "f-mode", "f-jeu", "f-etiquette", "f-tri", "f-reserve", "f-exclus"]) {
  $(id).addEventListener("input", rendreObjets);
}
$("exclure-lot").addEventListener("click", () => lot(true).catch((err) => alert(err.message)));
$("reintegrer-lot").addEventListener("click", () => lot(false).catch((err) => alert(err.message)));
charger().catch((err) => {
  $("resume").textContent = `Erreur : ${err.message}`;
});
