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
    const f = path.join(CACHE, "villes-wikidata.json");
    if (!fs.existsSync(f)) {
      const q = `SELECT ?ville ?fr ?en ?liens WHERE {
        ?ville wdt:P31/wdt:P279* wd:Q515 ; wdt:P1082 ?pop ; wikibase:sitelinks ?liens .
        FILTER(?pop >= 100000)
        ?ville rdfs:label ?fr . FILTER(LANG(?fr) = "fr")
        OPTIONAL { ?ville rdfs:label ?en . FILTER(LANG(?en) = "en") }
      }`;
      const r = await fetch(`https://query.wikidata.org/sparql?format=json&query=${encodeURIComponent(q)}`, { headers: { ...UA, Accept: "application/sparql-results+json" } });
      if (!r.ok) throw new Error(`Wikidata : ${r.status}`);
      fs.writeFileSync(f, await r.text());
    }
    const monde = JSON.parse(fs.readFileSync(f, "utf8")).results.bindings.map((b) => ({ fr: b.fr.value, en: b.en?.value, liens: Number(b.liens.value) }));
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
