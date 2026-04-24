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
  fallbackWarDays = [],
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
  if (!prevSnap) return null;
  const prevCumulFame = prevSnap?._cumulFame ?? {};
  const debugDelta = [];
  const cumulFameLive = allParts
    .filter((p) => currentMemberTags.has(p.tag))
    .reduce((sum, p) => {
      const live = p.fame ?? 0;
      const prev = prevCumulFame[p.tag] ?? 0;
      debugDelta.push({
        tag: p.tag,
        name: p.name,
        live,
        prev,
        delta: live - prev,
      });
      return sum + live;
    }, 0);
  const cumulFameSnapshot = Object.values(prevCumulFame).reduce(
    (sum, value) => sum + (typeof value === "number" ? value : 0),
    0,
  );
  const delta = cumulFameLive - cumulFameSnapshot;
  const snapshotTime =
    prevSnap.snapshotTime || prevSnap.snapshotBackupTime || null;
  const snapshotBackupTime = prevSnap.snapshotBackupTime || null;
  let diffMin = null;
  if (snapshotTime && prevSnap.gdcPeriod?.start) {
    const snapshotMs = new Date(snapshotTime).getTime();
    const resetMs = new Date(prevSnap.gdcPeriod.start).getTime();
    if (!Number.isNaN(snapshotMs) && !Number.isNaN(resetMs)) {
      diffMin = Math.round((snapshotMs - resetMs) / 60000);
    }
  }
  let warning = null;
  if (delta <= 0) {
    warning = "snapshot suspect or corrupted";
  } else if (diffMin != null && diffMin > 90) {
    warning = "snapshot appears late / after reset";
  }
  return {
    weekSnaps: weekSnaps.map((s, i) => {
      const snapshotCount = s?.decks
        ? Object.values(s.decks).reduce(
            (sum, value) => sum + (typeof value === "number" ? value : 0),
            0,
          )
        : null;
      const fallbackCount =
        fallbackWarDays?.[i]?.snapshotCount != null
          ? fallbackWarDays[i].snapshotCount
          : (fallbackWarDays?.[i]?.totalCount ?? null);
      return {
        day: i,
        snapshotTime: s?.snapshotTime || s?.snapshotBackupTime || null,
        decks: s?.decks || null,
        _cumulFame: s?._cumulFame || null,
        snapshotCount: snapshotCount != null ? snapshotCount : fallbackCount,
      };
    }),
    warDayIndex,
    warSnapshotDays,
    debugDelta,
    clanTag,
    snapshotTime,
    snapshotBackupTime,
    cumulFameLive,
    cumulFameSnapshot,
    delta,
    diffMin,
    warning,
  };
}
