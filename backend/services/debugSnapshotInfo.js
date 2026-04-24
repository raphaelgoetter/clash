// backend/services/debugSnapshotInfo.js
// Centralise la construction du bloc debugSnapshotInfo pour le debug-panel

/**
 * Construit le bloc détaillé pour le debug-panel frontend.
 * @param {Object} params - Tous les objets nécessaires à l'analyse (voir clan.js)
 * @returns {Object} debugSnapshotInfo
 */
export function buildDebugSnapshotInfo({
  weekSnaps,
  warDayIndex,
  currentMemberTags,
  allParts,
  warSnapshotDays,
  clanTag,
}) {
  // Sécurité : tous les paramètres doivent être fournis
  if (
    !weekSnaps ||
    !Array.isArray(weekSnaps) ||
    warDayIndex == null ||
    !currentMemberTags ||
    !allParts
  ) {
    return null;
  }
  // Extraction du snapshot J-1
  const prevSnap = weekSnaps[warDayIndex - 1];
  const prevCumulFame = prevSnap?._cumulFame ?? {};
  const debugDelta = [];
  allParts
    .filter((p) => currentMemberTags.has(p.tag))
    .forEach((p) => {
      const prev = prevCumulFame[p.tag] ?? 0;
      const live = p.fame ?? 0;
      debugDelta.push({
        tag: p.tag,
        name: p.name,
        live,
        prev,
        delta: live - prev,
      });
    });
  return {
    weekSnaps: weekSnaps.map((s, i) => ({
      day: i,
      snapshotTime: s?.snapshotTime || s?.snapshotBackupTime || null,
      decks: s?.decks || null,
      _cumulFame: s?._cumulFame || null,
    })),
    warDayIndex,
    warSnapshotDays,
    debugDelta,
    clanTag,
  };
}
