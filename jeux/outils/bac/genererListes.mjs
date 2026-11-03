// Génère les listes de mots du Petit Bac (jeux/data/bac/<thème>.json) à
// partir de sources publiques vérifiables (jamais de liste écrite de
// mémoire) :
// - catégories du Wiktionnaire (animaux, fruits et légumes, métiers, sports) ;
//   mots de Kévina : annexes du Wiktionnaire (Animaux communs, Métiers,
//   Sports) et listes de Wikipédia (fruits, légumes) ;
// - pays : mledoze/countries (noms français, membres de l'ONU) et
//   umpirsky/country-list (CLDR), plus quelques noms d'usage (ALIAS_PAYS) ;
// - villes : villes du monde de Wikidata (population, nom français) et
//   communes de France de l'API geo.api.gouv.fr ;
// - prénoms : fichier des prénoms de l'INSEE (naissances depuis 1900) ;
// - mythologie, personnages de jeu vidéo : Wikidata (classes, notoriété =
//   nombre de langues de Wikipédia, première apparition) ;
// - inventions : liste relue à la main (inventions.txt), candidats tirés de
//   Wikidata et des listes d'inventions de Wikipédia ;
// - cartes Clash : jeux/data/cardNames.json (noms français).
// Fréquence d'usage (choix de Kévina) : Lexique 3.83 (lexique.org).
//
// Chaque fichier : { nom, mots: [mots acceptés], kevina: [mots courants,
// ceux que Kévina peut répondre] }. Les entrées composées sont réduites à
// leur mot principal (« merle de Lawrence » → « merle », retirée s'il est
// déjà dans la liste) : la validation accepte une réponse composée dont le
// mot principal est dans la liste (bacRules.js).
//
// Usage : node jeux/outils/bac/genererListes.mjs [thème…]
// Téléchargements mis en cache dans le dossier temporaire du système.
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";
import { normaliser, MOTS_VIDES_TETE } from "../../services/bacRules.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RACINE = path.resolve(__dirname, "..", "..", "..");
const SORTIE = path.join(RACINE, "jeux", "data", "bac");
const CACHE = path.join(os.tmpdir(), "bac-sources");
fs.mkdirSync(CACHE, { recursive: true });
fs.mkdirSync(SORTIE, { recursive: true });

const UA = { "User-Agent": "TrustRoyaleBot/1.0 (mini-jeux Discord ; Petit Bac)" };
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

// Fichier téléchargé une fois (cache)
async function telecharger(url, nom) {
  const f = path.join(CACHE, nom);
  if (!fs.existsSync(f)) {
    const r = await fetch(url, { headers: UA });
    if (!r.ok) throw new Error(`${url} : ${r.status}`);
    fs.writeFileSync(f, Buffer.from(await r.arrayBuffer()));
  }
  return f;
}

// ── Wiktionnaire (catégories, récursif, ralenti : l'API limite le débit) ──

async function api(params, hote = "fr.wiktionary.org") {
  for (let essai = 0; essai < 8; essai++) {
    await pause(400);
    const u = new URL(`https://${hote}/w/api.php`);
    u.search = new URLSearchParams({ ...params, format: "json" });
    const t = await (await fetch(u, { headers: UA })).text();
    try {
      return JSON.parse(t);
    } catch {
      await pause(5000 * (essai + 1));
    }
  }
  throw new Error("API du Wiktionnaire indisponible");
}

async function membres(cat, type) {
  const out = [];
  let cont = null;
  do {
    // Pages : articles seulement (espace de noms 0, pas les « Thésaurus:… »)
    const ns = type === "page" ? { cmnamespace: "0" } : {};
    const j = await api({ action: "query", list: "categorymembers", cmtitle: `Catégorie:${cat}`, cmtype: type, cmlimit: "500", ...ns, ...(cont ? { cmcontinue: cont } : {}) });
    out.push(...j.query.categorymembers.map((m) => m.title.replace(/^Catégorie:/, "")));
    cont = j.continue?.cmcontinue;
  } while (cont);
  return out;
}

// `specs` : [[catégorie, profondeur]] ; `exclues` : sous-catégories ignorées.
async function wiktionnaire(cle, specs, exclues = []) {
  const f = path.join(CACHE, `wikt-${cle}.json`);
  if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, "utf8"));
  const mots = new Set();
  const vues = new Set(exclues);
  async function parcourir(cat, p) {
    if (vues.has(cat)) return;
    vues.add(cat);
    (await membres(cat, "page")).forEach((x) => mots.add(x));
    if (p > 0) for (const s of await membres(cat, "subcat")) await parcourir(s, p - 1);
  }
  for (const [cat, p] of specs) await parcourir(cat, p);
  const liste = [...mots];
  fs.writeFileSync(f, JSON.stringify(liste));
  return liste;
}

// Articles liés depuis une page (annexe du Wiktionnaire, liste de
// Wikipédia), en minuscules : listes faites à la main, sources des mots de
// Kévina.
async function liens(titre, hote = "fr.wiktionary.org") {
  const f = path.join(CACHE, `liens-${normaliser(hote + titre)}.json`);
  if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, "utf8"));
  const out = [];
  let cont = null;
  do {
    const j = await api({ action: "query", prop: "links", titles: titre, plnamespace: "0", pllimit: "500", ...(cont ? { plcontinue: cont } : {}) }, hote);
    for (const p of Object.values(j.query.pages)) out.push(...(p.links ?? []).map((l) => l.title));
    cont = j.continue?.plcontinue;
  } while (cont);
  fs.writeFileSync(f, JSON.stringify(out));
  return out;
}

// Mots de Kévina : les mots acceptés présents dans des listes faites à la
// main (`pages` : [titre, hôte]). Écarte les sens secondaires des
// catégories (« bois », « lune » parmi les animaux). `courant` : aussi
// d'usage courant (fréquence Lexique, mots simples), pour les longues
// annexes (formes rares : « cria », « garbon »).
async function kevinaDepuis(mots, pages, { courant = false } = {}) {
  const choisis = new Set();
  for (const [titre, hote] of pages) for (const l of await liens(titre, hote)) choisis.add(normaliser(l));
  return (courant ? await courants(mots, SEUIL_FREQ) : mots).filter((m) => choisis.has(normaliser(m)));
}

// ── Wikidata (requêtes SPARQL, en cache) ──

async function sparql(cle, requete) {
  const f = path.join(CACHE, `wd-${cle}.json`);
  if (!fs.existsSync(f)) {
    for (let essai = 0; ; essai++) {
      const r = await fetch(`https://query.wikidata.org/sparql?format=json&query=${encodeURIComponent(requete)}`, { headers: { ...UA, Accept: "application/sparql-results+json" } });
      const t = await r.text();
      try {
        JSON.parse(t);
        fs.writeFileSync(f, t);
        break;
      } catch {
        if (essai >= 3) throw new Error(`Wikidata (${cle}) : ${t.slice(0, 100)}`);
        await pause(10000);
      }
    }
  }
  return JSON.parse(fs.readFileSync(f, "utf8")).results.bindings.map((b) => ({
    id: b.x.value.split("/").pop(),
    fr: b.fr.value,
    en: b.en?.value ?? null,
    liens: Number(b.liens?.value ?? 0),
  }));
}

// Nom d'un élément : français, sinon multilingue (Wikidata range désormais
// le nom de beaucoup de personnes dans « mul », sans libellé « fr » :
// Arnold Schwarzenegger, Leonardo DiCaprio), sinon anglais ; `?en` : anglais.
const LIBELLE = `OPTIONAL { ?x rdfs:label ?lfr . FILTER(LANG(?lfr) = "fr") }
      OPTIONAL { ?x rdfs:label ?lmul . FILTER(LANG(?lmul) = "mul") }
      OPTIONAL { ?x rdfs:label ?en . FILTER(LANG(?en) = "en") }
      BIND(COALESCE(?lfr, ?lmul, ?en) AS ?fr) FILTER(BOUND(?fr))`;

// Éléments d'une classe (et de ses sous-classes) avec leur nom français,
// anglais et le nombre de langues de Wikipédia qui ont un article
const deClasse = (cle, classe) =>
  sparql(
    cle,
    `SELECT ?x ?fr ?en ?liens WHERE {
      ?x wdt:P31/wdt:P279* wd:${classe} ; wikibase:sitelinks ?liens .
      ${LIBELLE}
    }`,
  );

// Libellés français des classes directes de chaque élément
async function classesDirectes(cle, ids) {
  const f = path.join(CACHE, `wd-classes-${cle}.json`);
  if (!fs.existsSync(f)) {
    const out = {};
    for (let i = 0; i < ids.length; i += 150) {
      await pause(1000);
      const v = ids
        .slice(i, i + 150)
        .map((x) => `wd:${x}`)
        .join(" ");
      const q = `SELECT ?x ?cl WHERE { VALUES ?x { ${v} } ?x wdt:P31 ?c . ?c rdfs:label ?cl . FILTER(LANG(?cl) = "fr") }`;
      const r = await fetch(`https://query.wikidata.org/sparql?format=json&query=${encodeURIComponent(q)}`, { headers: { ...UA, Accept: "application/sparql-results+json" } });
      for (const b of JSON.parse(await r.text()).results.bindings) (out[b.x.value.split("/").pop()] ??= []).push(b.cl.value);
    }
    fs.writeFileSync(f, JSON.stringify(out));
  }
  return JSON.parse(fs.readFileSync(f, "utf8"));
}

// Noms propres (personnages, villes, groupes) : sans parenthèses (« Steve
// (Minecraft) »), lettres, chiffres, espaces, apostrophes, points, tirets et
// « & / ! + » (« AC/DC », « Simon & Garfunkel ») seulement ; doublons à la normalisation près retirés, triés.
function nomsPropres(liste) {
  const u = new Map();
  for (const brut of liste) {
    const m = brut && brut.replace(/\s*\(.*?\)\s*/g, " ").trim();
    if (m && /^[\p{L}\d\s'’.&/!+-]+$/u.test(m) && normaliser(m).length >= 2 && !u.has(normaliser(m))) u.set(normaliser(m), m);
  }
  return [...u.values()].sort((a, b) => a.localeCompare(b, "fr"));
}

// ── Lexique 3.83 : fréquence (par million de mots, films + livres) ──

let _freq = null;
async function frequences() {
  if (_freq) return _freq;
  const f = await telecharger("http://www.lexique.org/databases/Lexique383/Lexique383.tsv", "Lexique383.tsv");
  const lignes = fs.readFileSync(f, "utf8").split("\n");
  const entete = lignes[0].split("\t");
  const [iOrtho, iFilms, iLivres] = ["ortho", "freqfilms2", "freqlivres"].map((c) => entete.indexOf(c));
  _freq = new Map();
  for (const l of lignes.slice(1)) {
    const c = l.split("\t");
    if (!c[iOrtho]) continue;
    const v = (Number(c[iFilms]) || 0) + (Number(c[iLivres]) || 0);
    _freq.set(c[iOrtho], Math.max(_freq.get(c[iOrtho]) ?? 0, v));
  }
  return _freq;
}

// ── Réduction des entrées composées ──

// Mot principal d'une entrée composée : premier mot, après les adjectifs
// de tête (« grand ara bleu » → « ara »).
function tete(entree) {
  const mots = entree.split(/\s+/);
  const k = mots.findIndex((m) => !MOTS_VIDES_TETE.has(normaliser(m)));
  return k < 0 ? null : mots[k];
}

// Mots simples gardés tels quels ; composés réduits à leur mot principal,
// retirés si celui-ci est déjà présent. Seulement des lettres, espaces,
// tirets et apostrophes (ni chiffres, ni « : » ou « / » de pages annexes),
// au moins 2 lettres.
function reduire(entrees) {
  const valide = (m) => m && /^[\p{L}\s'’-]+$/u.test(m) && normaliser(m).length >= 2;
  const simples = entrees.filter((e) => !/\s/.test(e) && valide(e));
  const vus = new Set(simples.map(normaliser));
  const out = [...simples];
  for (const e of entrees.filter((x) => /\s/.test(x))) {
    const t = tete(e);
    if (!valide(t) || vus.has(normaliser(t))) continue;
    vus.add(normaliser(t));
    out.push(t);
  }
  // Doublons à la normalisation près (casse, accents) : la première forme
  const uniques = new Map();
  for (const m of out) if (!uniques.has(normaliser(m))) uniques.set(normaliser(m), m);
  return [...uniques.values()].sort((a, b) => a.localeCompare(b, "fr"));
}

// Mots courants (Kévina) : mots simples assez fréquents
async function courants(mots, seuil) {
  const freq = await frequences();
  return mots.filter((m) => !/[\s]/.test(m) && (freq.get(m.toLowerCase()) ?? 0) >= seuil);
}

// Majuscules d'un nom propre écrit en capitales (« JEAN-PIERRE » → « Jean-Pierre »)
const capitaliser = (s) => s.toLowerCase().replace(/(^|[-\s'])(\p{L})/gu, (_, a, b) => a + b.toUpperCase());

// ── Thèmes ──

const SEUIL_FREQ = 1;

const THEMES = {
  async animaux() {
    const e = await wiktionnaire(
      "animaux",
      [
        ["Animaux en français", 0],
        ["Noms alternatifs des animaux en français", 0],
        ["Mammifères en français", 2],
        ["Oiseaux en français", 2],
        ["Reptiles en français", 2],
        ["Amphibiens en français", 2],
        ["Poissons en français", 1],
        ["Insectes en français", 2],
        ["Crustacés en français", 1],
        ["Arthropodes en français", 0],
        ["Mollusques en français", 2],
        ["Animaux femelles en français", 0],
        ["Animaux mâles en français", 0],
        ["Jeunes animaux en français", 0],
        ["Méduses en français", 0],
        ["Échinodermes en français", 2],
        ["Vers en français", 1],
        ["Dinosaures en français", 0],
      ],
      ["Mammifères fossiles en français"],
    );
    const mots = reduire(e);
    return { nom: "Animaux", mots, kevina: await kevinaDepuis(mots, [["Annexe:Animaux communs en français"]], { courant: true }) };
  },

  async fruits() {
    const e = await wiktionnaire("fruits", [
      ["Fruits en français", 1],
      ["Légumes en français", 1],
    ]);
    const mots = reduire(e);
    const wp = "fr.wikipedia.org";
    return { nom: "Fruits et légumes", mots, kevina: await kevinaDepuis(mots, [["Liste de fruits", wp], ["Liste de légumes", wp]]) };
  },

  async metiers() {
    const e = await wiktionnaire(
      "metiers",
      [["Métiers en français", 2]],
      ["Criminels et délinquants en français", "Mots en français suffixés avec -rice", "Diminutifs de métiers en français"],
    );
    const mots = reduire(e);
    return { nom: "Métiers", mots, kevina: await kevinaDepuis(mots, [["Annexe:Métiers en français"]], { courant: true }) };
  },

  async sports() {
    const e = await wiktionnaire("sports", [["Sports en français", 2]]);
    const mots = reduire(e);
    return { nom: "Sports", mots, kevina: await kevinaDepuis(mots, [["Annexe:Sports en français"], ["Annexe:Sports olympiques"]]) };
  },

  async mythologie() {
    // Divinités, personnages mythologiques et créatures légendaires (Wikidata).
    // Kévina : article dans au moins 40 langues, classe divine, héroïque ou
    // créature, jamais un personnage biblique ni un ange (les personnages
    // mythologiques de Wikidata en comptent beaucoup).
    const tous = [
      ...(await deClasse("divinites", "Q178885")),
      ...(await deClasse("personnages-mythologiques", "Q4271324")),
      ...(await deClasse("creatures-legendaires", "Q2239243")),
    ];
    const connus = [...new Map(tous.filter((x) => x.liens >= 40).map((x) => [x.id, x])).values()];
    const classes = await classesDirectes("mythologie", connus.map((x) => x.id));
    const mythique = /divinit|déesse|dieu|déité|titan|mytholog|devî|créature|chimère|monstre|dragon|nymphe|géant|légendaire|héros|olympien/i;
    const exclu = /bible|ange|archange|être humain|personnage historique/i;
    const kevina = connus.filter((x) => (classes[x.id] ?? []).some((c) => mythique.test(c)) && !(classes[x.id] ?? []).some((c) => exclu.test(c)));
    // Mots acceptés : au moins 2 langues (écarte les entrées très obscures)
    return { nom: "Mythologie", mots: nomsPropres(tous.filter((x) => x.liens >= 2).map((x) => x.fr)), kevina: nomsPropres(kevina.map((x) => x.fr)) };
  },

  async jeuxvideo() {
    // Personnages de jeu vidéo et Pokémon (Wikidata), noms français et
    // anglais, plus le dernier mot des noms composés (« Princesse Peach » :
    // « Peach », « Lara Croft » : « Croft »). Kévina : personnages nés dans
    // un jeu vidéo (première apparition), article dans au moins 10 langues,
    // et Pokémon dans au moins 30 (Pikachu, Salamèche…). Les personnages de
    // films ou de BD qui ont eu leur jeu (Mickey, Luke Skywalker) restent
    // acceptés mais Kévina ne les donne pas.
    const persos = await deClasse("personnages-jeu-video", "Q1569167");
    const pokemon = await deClasse("pokemon", "Q3966183");
    const nes = await sparql(
      "personnages-nes-jeu-video",
      `SELECT DISTINCT ?x ?fr ?liens WHERE {
        ?x wdt:P31/wdt:P279* wd:Q1569167 ; wikibase:sitelinks ?liens ; wdt:P4584 ?w .
        ?w wdt:P31/wdt:P279* wd:Q7889 .
        ${LIBELLE}
      }`,
    );
    const noms = [...persos, ...pokemon].flatMap((x) => [x.fr, x.en]).filter(Boolean);
    const derniers = noms.map((n) => n.replace(/\s*\(.*?\)\s*/g, " ").trim().split(/\s+/)).filter((m) => m.length > 1).map((m) => m.at(-1));
    return {
      nom: "Personnages de jeu vidéo",
      mots: nomsPropres([...noms, ...derniers]),
      kevina: nomsPropres([...nes.filter((x) => x.liens >= 10), ...pokemon.filter((x) => x.liens >= 30)].map((x) => x.fr)),
    };
  },

  async transports() {
    // Wiktionnaire : véhicules, bateaux, engins de glisse et vélos. Kévina : mots des thésaurus
    // (véhicule, bateau, avion), faits à la main (la catégorie « Véhicules »
    // contient des sens secondaires : « visa », « pelle »).
    const vehicules = await wiktionnaire("vehicules", [["Véhicules en français", 1]]);
    // Engins de glisse (trottinette, skateboard) et vélos, acceptés aussi
    const glisse = await wiktionnaire("glisse-velos", [["Sports de glisse en français", 0], ["Vélos en français", 0]]);
    const bateaux = await wiktionnaire("bateaux", [["Bateaux en français", 0]]);
    // Thésaurus : filtre des mots de Kévina seulement (ils contiennent aussi
    // du vocabulaire associé : « ancre », « pilote », « mer »)
    const thesaurus = [["Thésaurus:véhicule/français"], ["Thésaurus:bateau/français"], ["Thésaurus:avion/français"], ["Thésaurus:train/français"]];
    const mots = reduire([...vehicules, ...bateaux, ...glisse]);
    // Mots des thésaurus qui ne désignent pas un véhicule en usage courant
    const AMBIGUS = new Set(["aile", "annexe", "batterie", "piste", "plate", "voile", "nacelle", "véhicule", "bâtiment", "nef", "pointu", "corsaire", "vapeur", "char", "vaisseau"]);
    const kevina = (await kevinaDepuis(mots, thesaurus, { courant: true })).filter((m) => !AMBIGUS.has(m.toLowerCase()));
    return { nom: "Moyens de transport", mots, kevina };
  },

  async autos() {
    // Constructeurs et marques automobiles (Wikidata), noms français et
    // anglais, et formes courtes : sans suffixe d'entreprise (« Ford Motor
    // Company » : « Ford »), partie avant le trait d'union (« Mercedes-Benz » :
    // « Mercedes »). Kévina : article dans au moins 30 langues, ni camions,
    // ni motos, ni groupes (classes Wikidata).
    const l = [...(await deClasse("constructeurs-automobiles", "Q786820")), ...(await deClasse("marques-automobiles", "Q44294"))];
    const SUFFIXES = /\s+(Group|Groupe|Motor Company|Motor Corporation|Motors?|Automobiles?|Automotive|Corporation|Company|Cars|AG|S\.p\.A\.|SpA|S\.A\.|SA|Ltd\.?|Inc\.?|GmbH|Holding|North America)$/i;
    const court = (n) => {
      let m = n;
      while (SUFFIXES.test(m)) m = m.replace(SUFFIXES, "");
      return m.trim();
    };
    const noms = l.flatMap((x) => [x.fr, x.en]).filter(Boolean);
    const formes = noms.flatMap((n) => [n, court(n), court(n).split("-")[0]]);
    const connus = [...new Map(l.filter((x) => x.liens >= 30).map((x) => [x.id, x])).values()];
    const classes = await classesDirectes("autos", connus.map((x) => x.id));
    const horsSujet = /camion|poids lourd|moto|bus|autocar|tracteur|utilitaire|groupe|conglomérat|holding|société mère|filiale|division|armement|aéronautique/i;
    // Kévina : nom d'usage (sans suffixe juridique, « General Motors » gardé
    // entier), ni usines (« Zavod »), ni écuries de course
    const juridique = /\s+(AG|S\.p\.A\.|SpA|S\.A\.|SA|Ltd\.?|Limited|Inc\.?|GmbH|Corporation|Company)$/i;
    const kevina = connus
      .filter((x) => !(classes[x.id] ?? []).some((c) => horsSujet.test(c)) && !/\b(Group|Groupe|Holding|Stellantis|Zavod|Avtomobilny|F1|Team|Racing)\b/i.test(x.fr))
      .map((x) => x.fr.replace(juridique, "").trim());
    return { nom: "Marques automobiles", mots: nomsPropres(formes), kevina: nomsPropres(kevina) };
  },

  async inventions() {
    // Liste relue à la main (jeux/outils/bac/inventions.txt, une invention
    // par ligne ; candidats tirés de Wikidata et des listes d'inventions de
    // Wikipédia, aucune source propre n'existant). Kévina : inventions d'un
    // seul mot, d'usage courant.
    const lignes = fs
      .readFileSync(path.join(__dirname, "inventions.txt"), "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));
    const uniques = new Map();
    for (const m of lignes) if (!uniques.has(normaliser(m))) uniques.set(normaliser(m), m);
    const mots = [...uniques.values()].sort((a, b) => a.localeCompare(b, "fr"));
    return { nom: "Inventions", mots, kevina: await courants(mots, SEUIL_FREQ) };
  },

  async acteurs() {
    // Acteurs et actrices (Wikidata : acteur, de cinéma ou de télévision ;
    // article dans au moins 25 langues). Seul le nom de famille compte
    // (bacRules.js) : `personnes` = noms complets. Kévina : au moins 70
    // langues et 10 films, ni chanteurs (au moins 10 œuvres interprétées)
    // ni réalisateurs.
    const acteurs = await personnesDeMetiers("acteurs", ACTEUR, 25);
    const connus = acteurs.filter((x) => x.liens >= 70);
    const films = await compter("films", connus.map((x) => x.id), "P161");
    const oeuvres = await compter("oeuvres", connus.map((x) => x.id), "P175");
    const cineastes = new Set((await personnesDeMetiers("realisateurs", REALISATEUR, 40)).map((x) => x.id));
    const kevina = connus.filter((x) => films[x.id] >= 10 && oeuvres[x.id] < 10 && !cineastes.has(x.id));
    return { nom: "Acteurs et actrices", mots: [], personnes: nomsPropres(acteurs.map((x) => x.fr)), kevina: nomsPropres(kevina.map((x) => x.fr)) };
  },

  async musique() {
    // Chanteurs, chanteuses, rappeurs (seul le nom de famille compte) et
    // groupes (leur nom), article dans au moins 25 langues (groupes : 40).
    // Kévina : au moins 70 langues et 10 œuvres interprétées, pas les
    // acteurs (au moins 10 films).
    const chanteurs = await personnesDeMetiers("chanteurs", CHANTEUR, 25);
    const connus = chanteurs.filter((x) => x.liens >= 70);
    const oeuvres = await compter("oeuvres", connus.map((x) => x.id), "P175");
    const films = await compter("films", connus.map((x) => x.id), "P161");
    const groupes = await sparql(
      "groupes",
      `SELECT DISTINCT ?x ?fr ?liens WHERE {
        ?x wdt:P31/wdt:P279* wd:Q215380 ; wikibase:sitelinks ?liens . FILTER(?liens >= 40)
        ${LIBELLE}
      }`,
    );
    const kevina = [...connus.filter((x) => oeuvres[x.id] >= 10 && films[x.id] < 10), ...groupes.filter((x) => x.liens >= 70)];
    return {
      nom: "Musique (chanteurs et groupes)",
      mots: nomsPropres(groupes.map((x) => x.fr)),
      personnes: nomsPropres(chanteurs.map((x) => x.fr)),
      kevina: nomsPropres(kevina.map((x) => x.fr)),
    };
  },

  async pays() {
    const monde = JSON.parse(fs.readFileSync(await telecharger("https://raw.githubusercontent.com/mledoze/countries/master/countries.json", "countries.json"), "utf8"));
    const cldr = JSON.parse(fs.readFileSync(await telecharger("https://raw.githubusercontent.com/umpirsky/country-list/master/data/fr/country.json", "cldr-fr.json"), "utf8"));
    // « Congo (Rép. dém.) » → « Congo »
    const propre = (n) => n.replace(/\s*\(.*\)\s*/g, "").trim();
    const kevina = [...new Set(monde.filter((p) => p.unMember).map((p) => propre(p.translations.fra.common)))];
    const tous = [
      ...kevina,
      ...monde.flatMap((p) => [p.translations.fra.common, p.translations.fra.official]).map(propre),
      ...Object.values(cldr).map(propre),
      ...ALIAS_PAYS,
    ];
    // Îles : aussi sans « Île(s) » (« Pitcairn », « Tokelau », « Maurice »)
    tous.push(...tous.map((m) => m && m.replace(/^Îles?\s+(?:(?:de|du|des)\s+|d['’]\s*)?/u, "")).filter((m, i) => m && m !== tous[i]));
    const uniques = new Map();
    for (const m of tous) if (m && !uniques.has(normaliser(m))) uniques.set(normaliser(m), m);
    return { nom: "Pays", mots: [...uniques.values()].sort((a, b) => a.localeCompare(b, "fr")), kevina: kevina.sort((a, b) => a.localeCompare(b, "fr")) };
  },

  async villes() {
    // Villes du monde de 100 000 habitants et plus (Wikidata, nom français
    // et anglais) et communes de France de 20 000 habitants et plus. Kévina :
    // villes connues (article dans au moins 150 langues de Wikipédia) et
    // communes de France de 100 000 habitants et plus.
    const monde = await sparql(
      "villes",
      `SELECT ?x ?fr ?en ?liens WHERE {
        ?x wdt:P31/wdt:P279* wd:Q515 ; wdt:P1082 ?pop ; wikibase:sitelinks ?liens .
        FILTER(?pop >= 100000)
        ${LIBELLE}
      }`,
    );
    const communes = JSON.parse(fs.readFileSync(await telecharger("https://geo.api.gouv.fr/communes?fields=nom,population&format=json", "communes.json"), "utf8"));
    const tri = (l) => {
      const u = new Map();
      for (const m of l) if (m && /^[\p{L}\s'’.-]+$/u.test(m) && !u.has(normaliser(m))) u.set(normaliser(m), m);
      return [...u.values()].sort((a, b) => a.localeCompare(b, "fr"));
    };
    return {
      nom: "Villes",
      mots: tri([...monde.flatMap((v) => [v.fr, v.en]), ...communes.filter((c) => c.population >= 20000).map((c) => c.nom)]),
      kevina: tri([...monde.filter((v) => v.liens >= 150).map((v) => v.fr), ...communes.filter((c) => c.population >= 100000).map((c) => c.nom)]),
    };
  },

  async prenoms() {
    const zip = await telecharger("https://www.insee.fr/fr/statistiques/fichier/2540004/nat2021_csv.zip", "nat2021_csv.zip");
    const csv = execFileSync("unzip", ["-p", zip], { maxBuffer: 1 << 28 }).toString("utf8");
    const total = new Map();
    for (const l of csv.split("\n").slice(1)) {
      const [, p, , n] = l.split(";");
      if (!p || p.startsWith("_")) continue;
      total.set(p, (total.get(p) ?? 0) + Number(n));
    }
    const liste = (seuil) => [...total].filter(([, n]) => n >= seuil).map(([p]) => capitaliser(p)).sort((a, b) => a.localeCompare(b, "fr"));
    // Au moins 500 naissances depuis 1900 (environ 5 000 prénoms) ; Kévina : 20 000
    return { nom: "Prénoms", mots: liste(500), kevina: liste(20000) };
  },

  async clash() {
    const cartes = JSON.parse(fs.readFileSync(path.join(RACINE, "jeux", "data", "cardNames.json"), "utf8"));
    const fr = [...new Set(cartes.map((c) => c.fr))].sort((a, b) => a.localeCompare(b, "fr"));
    // Noms anglais acceptés aussi (souvent employés en jeu)
    const mots = [...new Set([...fr, ...cartes.map((c) => c.cardKey)])].sort((a, b) => a.localeCompare(b, "fr"));
    return { nom: "Cartes Clash Royale", mots, kevina: fr };
  },
};

// Personnes ayant l'un des métiers (P106) et un article dans au moins `min`
// langues : une requête par métier et par tranche de notoriété (une requête
// unique dépasse le délai de Wikidata et revient tronquée).
const TRANCHES = [15, 20, 25, 30, 40, 60, 100, 100000];
async function personnesDeMetiers(cle, metiers, min) {
  const tous = new Map();
  for (const o of metiers) {
    for (let k = 0; k < TRANCHES.length - 1; k++) {
      const [a, b] = [TRANCHES[k], TRANCHES[k + 1]];
      if (b <= min) continue;
      const l = await sparql(
        `${cle}-${o}-${a}`,
        `SELECT DISTINCT ?x ?fr ?liens WHERE {
          ?x wdt:P106 wd:${o} ; wikibase:sitelinks ?liens . FILTER(?liens >= ${Math.max(a, min)} && ?liens < ${b})
          ${LIBELLE}
        }`,
      );
      for (const x of l) if (!tous.has(x.id)) tous.set(x.id, x);
    }
  }
  return [...tous.values()];
}

// Nombre d'éléments qui renvoient à chaque personne par `propriete` (P161 :
// films où elle joue, P175 : œuvres qu'elle interprète), par lots.
async function compter(cle, ids, propriete) {
  const f = path.join(CACHE, `wd-compte-${cle}.json`);
  const out = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : {};
  const manquants = ids.filter((id) => !(id in out));
  for (let i = 0; i < manquants.length; i += 100) {
    await pause(500);
    const lot = manquants.slice(i, i + 100);
    const q = `SELECT ?x (COUNT(DISTINCT ?f) AS ?n) WHERE { VALUES ?x { ${lot.map((x) => `wd:${x}`).join(" ")} } ?f wdt:${propriete} ?x } GROUP BY ?x`;
    const r = await fetch(`https://query.wikidata.org/sparql?format=json&query=${encodeURIComponent(q)}`, { headers: { ...UA, Accept: "application/sparql-results+json" } });
    for (const id of lot) out[id] = 0;
    for (const b of JSON.parse(await r.text()).results.bindings) out[b.x.value.split("/").pop()] = Number(b.n.value);
  }
  fs.writeFileSync(f, JSON.stringify(out));
  return out;
}

const ACTEUR = ["Q33999", "Q10800557", "Q10798782"]; // acteur, de cinéma, de télévision
const CHANTEUR = ["Q177220", "Q2252262", "Q488205"]; // chanteur, rappeur, auteur-compositeur-interprète
const REALISATEUR = ["Q2526255"];

// Noms d'usage absents des listes officielles (nations constitutives,
// anciens noms, formes courtes)
const ALIAS_PAYS = [
  "Angleterre",
  "Écosse",
  "Pays de Galles",
  "Irlande du Nord",
  "Hollande",
  "Myanmar",
  "République tchèque",
  "Vietnam",
  "Cap-Vert",
  "Maurice",
  "Palau",
  "Bélarus",
  "Swaziland",
  "Timor-Leste",
  "Vatican",
  "Corée",
  "Congo-Brazzaville",
  "Congo-Kinshasa",
  "El Salvador",
  "Zaïre",
  "Taïwan",
  "Kosovo",
  "Palestine",
];

const demandes = process.argv.slice(2);
for (const id of demandes.length ? demandes : Object.keys(THEMES)) {
  const t = await THEMES[id]();
  fs.writeFileSync(path.join(SORTIE, `${id}.json`), `${JSON.stringify(t, null, 0)}\n`);
  console.log(`${id} : ${t.mots.length} mots acceptés, ${t.kevina.length} pour Kévina`);
}
