// Rang « ex aequo » d'une entrée dans une liste déjà triée (classement
// « 1, 2, 2, 4 ») : rang de la première entrée à égalité avec elle.
// `critere` : clé de score (égalité si même valeur), ou fonction (a, b) =>
// booléen quand le jeu a son propre départage (ex. Blackjack : points puis
// cartes piochées). L'ordre d'affichage des ex aequo reste celui de la liste.
export function rangExAequo(sortedList, index, critere = "points") {
  const egal = typeof critere === "function" ? critere : (a, b) => a[critere] === b[critere];
  const entry = sortedList[index];
  return sortedList.findIndex((e) => egal(e, entry)) + 1;
}
