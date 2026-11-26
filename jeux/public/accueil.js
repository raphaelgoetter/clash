// Page d'accueil de Kévina : verbe du titre qui change, et heure des
// mini-jeux calculée selon la saison (crons à heure UTC fixe : 19h à Paris
// en hiver, 20h à l'heure d'été).

const VERBES = ["deviner", "bluffer", "survivre", "parier", "s'allier", "gagner"];

function animerVerbe() {
  const el = document.getElementById("verbe");
  if (!el || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  let i = 0;
  setInterval(() => {
    el.classList.add("sort");
    setTimeout(() => {
      i = (i + 1) % VERBES.length;
      el.textContent = VERBES[i];
      el.classList.remove("sort");
    }, 250);
  }, 2200);
}

function heureDeParis() {
  for (const el of document.querySelectorAll("[data-heure-utc]")) {
    const maintenant = new Date();
    const date = new Date(Date.UTC(maintenant.getUTCFullYear(), maintenant.getUTCMonth(), maintenant.getUTCDate(), Number(el.dataset.heureUtc)));
    const heure = new Intl.DateTimeFormat("fr-FR", { timeZone: "Europe/Paris", hour: "numeric" }).format(date);
    el.textContent = heure.replace(/\s/g, "");
  }
}

// Galerie : les flèches calent l'image suivante ou précédente sur le bord
// gauche (images de largeurs différentes) ; elles se grisent aux extrémités.
// Le défilement au doigt ou au pavé reste natif.
function galerie() {
  const piste = document.getElementById("galerie");
  if (!piste) return;
  const boutons = document.querySelectorAll(".galerie-bouton");
  const items = [...piste.querySelectorAll(".galerie-item")];
  // Position de défilement qui cale chaque image sur le bord gauche
  const positions = () => {
    const base = piste.getBoundingClientRect().left - piste.scrollLeft;
    return items.map((i) => i.getBoundingClientRect().left - base);
  };
  const majBoutons = () => {
    const fin = piste.scrollWidth - piste.clientWidth - 4;
    for (const b of boutons) b.disabled = b.dataset.sens === "-1" ? piste.scrollLeft <= 4 : piste.scrollLeft >= fin;
  };
  for (const b of boutons) {
    b.addEventListener("click", () => {
      const pos = positions();
      const x = piste.scrollLeft;
      const cible = b.dataset.sens === "1" ? pos.find((p) => p > x + 4) : pos.filter((p) => p < x - 4).at(-1);
      piste.scrollTo({ left: cible ?? (b.dataset.sens === "1" ? piste.scrollWidth : 0) });
      // Filet de sécurité si l'événement de défilement n'arrive pas
      setTimeout(majBoutons, 450);
    });
  }
  piste.addEventListener("scroll", majBoutons, { passive: true });
  piste.addEventListener("scrollend", majBoutons);
  addEventListener("resize", majBoutons);
  majBoutons();
}

heureDeParis();
animerVerbe();
galerie();
