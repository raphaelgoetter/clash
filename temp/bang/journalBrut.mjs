import dotenv from "dotenv";
dotenv.config();
const { readPartie } = await import("../../backend/services/bang.js");
const p = await readPartie();
const noms = Object.fromEntries(Object.entries(p.joueurs).map(([id, j]) => [id, j.username]));
for (const e of p.journal) {
  const o = { ...e };
  for (const k of ["p", "s", "v"]) if (o[k]) o[k] = noms[o[k]] ?? o[k];
  if (o.ids) o.ids = o.ids.map((i) => noms[i] ?? i);
  console.log(JSON.stringify(o));
}
