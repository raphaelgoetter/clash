// ============================================================
// composantsV2.js — Conversion de vues écrites comme des embeds en
// message Components V2 (Pont du Troll, Robinson).
// Discord limite la hauteur d'une image d'embed (~300 px sur ordinateur),
// une galerie (type 12) l'affiche bien plus grande. Un conteneur à liseré
// par embed : titre ###, texte, galerie, texte `apres` sous l'image, pied
// en petit ; boutons dans le dernier conteneur.
// ⚠️ Ni `content` ni `embeds` en V2 : le ping éventuel est un bloc texte en
// tête, avec `allowed_mentions`.
// ============================================================

export const IS_COMPONENTS_V2 = 1 << 15;
// Limite de texte sur l'ensemble du message (4 000 caractères)
const TEXTE_MAX = 4000;

export function versV2(embeds, components = [], roleId = null, couleurDefaut = 0x5865f2) {
  const blocs = [];
  if (roleId) blocs.push({ type: 10, content: `<@&${roleId}>` });
  embeds.forEach((embed, i) => {
    const texte = [embed.title ? `### ${embed.title}` : null, embed.description].filter(Boolean).join("\n");
    blocs.push({
      type: 17,
      accent_color: embed.color ?? couleurDefaut,
      components: [
        { type: 10, content: texte.slice(0, TEXTE_MAX) },
        ...(embed.image?.url ? [{ type: 12, items: [{ media: { url: embed.image.url } }] }] : []),
        ...(embed.apres ? [{ type: 10, content: embed.apres.slice(0, TEXTE_MAX) }] : []),
        ...(embed.footer?.text ? [{ type: 10, content: `-# ${embed.footer.text}` }] : []),
        ...(i === embeds.length - 1 ? components : []),
      ],
    });
  });
  return {
    flags: IS_COMPONENTS_V2,
    components: blocs,
    ...(roleId ? { allowed_mentions: { parse: [], roles: [roleId] } } : {}),
  };
}
