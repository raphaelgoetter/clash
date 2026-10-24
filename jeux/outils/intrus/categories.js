// ============================================================
// categories.js — Catégorie d'un objet du jeu "Intrus de l'inventaire",
// déduite de son nom (français ou anglais) par mots-clés. Sert à proposer
// en priorité un intrus ou un remplaçant de même nature que le trio (une
// baie parmi des baies), ce que la seule ressemblance visuelle ne voit pas.
// Indicatif : null si aucun mot-clé ne correspond.
// ============================================================

import { normalizeAnswer } from "@clash/commun/textNormalize.js";

const CATEGORIES = {
  baie: ["baie", "berry", "berries", "cerise", "cherry", "framboise", "fraise", "strawberry", "raisin", "grape"],
  fleur: ["fleur", "flower", "lily", "lys", "violet", "violette", "bloom", "rose", "tulip", "tulipe", "sunflower", "tournesol", "orchid", "orchidee", "lotus", "cecilia", "princess", "princesse", "lavender", "lavande", "muguet", "jacinthe", "anemone", "cosmos", "herbe", "herb"],
  champignon: ["champignon", "champi", "mushroom", "shroom"],
  potion: ["potion", "elixir", "fiole", "flask", "vial", "philtre", "tonic", "drink", "boisson"],
  poisson: ["poisson", "fish", "tuna", "thon", "shark", "requin", "carp", "carpe", "squid", "calmar", "octopus", "pieuvre", "crab", "crabe", "shrimp", "crevette", "bass", "salmon", "saumon", "eel", "anguille", "surgeonfish", "bonefish", "rockfish"],
  minerai: ["minerai", "ore", "lingot", "ingot", "bar", "cristal", "crystal", "gemme", "gem", "jade", "quartz", "pierre", "stone", "shard", "eclat", "fragment", "rock", "roche"],
  coffre: ["coffre", "chest", "caisse", "crate", "box", "boite"],
  bonbon: ["bonbon", "candy", "sucette", "lollipop", "sucre", "sugar", "cookie", "gateau", "cake", "donut"],
  anneau: ["anneau", "ring", "bague"],
  amulette: ["amulette", "amulet", "talisman", "pendentif", "pendant", "medaillon", "collier", "necklace", "brooch", "broche", "charm"],
  cape: ["cape", "cloak", "manteau"],
  masque: ["masque", "mask", "hood", "capuchon"],
  arme: ["epee", "sword", "lame", "blade", "dague", "dagger", "hache", "axe", "arc", "bow", "fusil", "rifle", "gun", "pistolet", "marteau", "hammer", "lance", "spear", "baton", "staff", "sceptre", "scepter", "mitrailleuse", "mitraillette"],
  balle: ["ball", "balle"],
  tissu: ["etoffe", "tissu", "cloth", "bolt", "rouleau", "laine", "wool", "soie", "silk"],
  piece: ["piece", "coin", "monnaie", "jeton", "token", "orbe", "orb"],
  leurre: ["leurre", "lure", "encens", "incense"],
};

const INDEX = new Map(Object.entries(CATEGORIES).flatMap(([cat, mots]) => mots.map((m) => [m, cat])));

// Mots-clés d'au moins 5 lettres reconnus aussi en fin de mot composé
// (« Cloudberries », « Moonstone », « Fulgurbloom »).
const SUFFIXES = [...INDEX.keys()].filter((m) => m.length >= 5);

export function categorieDe(objet) {
  const mots = normalizeAnswer(`${objet.nom} ${objet.nomVO ?? ""}`).split(" ");
  for (const mot of mots) {
    const cat = INDEX.get(mot) ?? INDEX.get(mot.replace(/s$/, ""));
    if (cat) return cat;
  }
  for (const mot of mots) {
    const suffixe = SUFFIXES.find((m) => mot.endsWith(m));
    if (suffixe) return INDEX.get(suffixe);
  }
  return null;
}

/** Catégorie majoritaire (au moins 2 objets sur 3) d'un trio, sinon null. */
export function categorieDuTrio(trio) {
  const compte = new Map();
  for (const o of trio) {
    const c = categorieDe(o);
    if (c) compte.set(c, (compte.get(c) ?? 0) + 1);
  }
  const [cat, n] = [...compte.entries()].sort((a, b) => b[1] - a[1])[0] ?? [null, 0];
  return n >= 2 ? cat : null;
}
