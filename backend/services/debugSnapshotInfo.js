// backend/services/debugSnapshotInfo.js
// Centralise la construction du bloc debugSnapshotInfo pour le debug-panel

/**
 * Construit le bloc détaillé pour le debug-panel frontend.
 * @param {Object} params - Tous les objets nécessaires à l'analyse (voir clan.js)
 * @returns {Object} debugSnapshotInfo
 *   - scoreJeudi: number|null
 *   - scoreVendredi: number|null
 *   - scoreSamedi: number|null
 *   - scoreDimanche: number|null
 *   - dailyScores: {
 *       jeudi: number|null,
 *       vendredi: number|null,
 *       samedi: number|null,
 *       dimanche: number|null,
 *     }
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
  // Extraction du snapshot J-1.
  // Si l'entrée adjacente est manquante, chercher le dernier snapshot valide antérieur.
  const hasSnapshotData = (snap) =>
    !!snap &&
    (!!snap.snapshotTime ||
      !!snap.snapshotBackupTime ||
      Number.isFinite(snap.snapshotCount) ||
      (snap.decks && Object.keys(snap.decks).length > 0) ||
      (typeof snap.totalCount === "number" && snap.totalCount > 0));

  let prevSnap = weekSnaps[warDayIndex - 1] ?? null;
  if (!hasSnapshotData(prevSnap)) {
    for (let i = warDayIndex - 2; i >= 0; i--) {
      if (hasSnapshotData(weekSnaps[i])) {
        prevSnap = weekSnaps[i];
        break;
      }
    }
  }

  if (!hasSnapshotData(prevSnap)) {
    for (let i = warDayIndex - 2; i >= 0; i--) {
      if (hasSnapshotData(fallbackWarDays?.[i])) {
        prevSnap = fallbackWarDays[i];
        break;
      }
    }
  }

  const fallbackPrevDay = fallbackWarDays?.[warDayIndex - 1] ?? null;
  if (!hasSnapshotData(prevSnap) && hasSnapshotData(fallbackPrevDay)) {
    prevSnap = fallbackPrevDay;
  }
  if (!prevSnap) return null;

  let prevPrevSnap = weekSnaps[warDayIndex - 2] ?? null;
  if (!hasSnapshotData(prevPrevSnap)) {
    for (let i = warDayIndex - 3; i >= 0; i--) {
      if (hasSnapshotData(weekSnaps[i])) {
        prevPrevSnap = weekSnaps[i];
        break;
      }
    }
  }
  if (
    !hasSnapshotData(prevPrevSnap) &&
    hasSnapshotData(fallbackWarDays?.[warDayIndex - 2])
  ) {
    prevPrevSnap = fallbackWarDays[warDayIndex - 2];
  }

  const sumFame = (fameMap) =>
    Object.values(fameMap ?? {}).reduce(
      (sum, value) => sum + (typeof value === "number" ? value : 0),
      0,
    );

  const computeDailyScore = (daySnap, prevDaySnap) => {
    if (!daySnap?._cumulFame) return null;
    const currentSummed = sumFame(daySnap._cumulFame);
    if (!prevDaySnap?._cumulFame) return currentSummed;
    const prevSummed = sumFame(prevDaySnap._cumulFame);
    return Math.max(0, currentSummed - prevSummed);
  };

  const prevCumulFame = prevSnap._cumulFame ?? {};
  const prevPrevCumulFame = prevPrevSnap?._cumulFame ?? {};
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
  const cumulFamePrevPrevSnapshot = Object.values(prevPrevCumulFame).reduce(
    (sum, value) => sum + (typeof value === "number" ? value : 0),
    0,
  );
  const hasPrevCumulFame = Object.keys(prevCumulFame).length > 0;
  const cumulFameSnapshotValid = hasPrevCumulFame ? cumulFameSnapshot : null;
  const delta = hasPrevCumulFame
    ? cumulFameLive - cumulFameSnapshotValid
    : null;
  const scoreJeudi = computeDailyScore(weekSnaps[0], null);
  const scoreVendredi = computeDailyScore(weekSnaps[1], weekSnaps[0]);
  const scoreSamedi = computeDailyScore(weekSnaps[2], weekSnaps[1]);
  const scoreDimanche = computeDailyScore(weekSnaps[3], weekSnaps[2]);
  const dailyScores = {
    jeudi: scoreJeudi,
    vendredi: scoreVendredi,
    samedi: scoreSamedi,
    dimanche: scoreDimanche,
  };
  const snapshotJ1DailyFame =
    hasPrevCumulFame && Object.keys(prevPrevCumulFame).length > 0
      ? Math.max(0, cumulFameSnapshot - cumulFamePrevPrevSnapshot)
      : null;
  const snapshotTime =
    prevSnap.snapshotTime ||
    prevSnap.snapshotBackupTime ||
    fallbackPrevDay?.snapshotTime ||
    fallbackPrevDay?.snapshotBackupTime ||
    null;
  const snapshotBackupTime =
    prevSnap.snapshotBackupTime || fallbackPrevDay?.snapshotBackupTime || null;
  const hasSnapshotCount =
    Number.isFinite(prevSnap.snapshotCount) ||
    (prevSnap.decks && Object.keys(prevSnap.decks).length > 0) ||
    Number.isFinite(fallbackPrevDay?.snapshotCount);
  const fallbackSnapshotCount = Number.isFinite(fallbackPrevDay?.snapshotCount)
    ? fallbackPrevDay.snapshotCount
    : null;
  const fallbackTotalCount =
    typeof fallbackPrevDay?.totalCount === "number"
      ? fallbackPrevDay.totalCount
      : null;
  const hasFallbackSnapshotCount =
    fallbackSnapshotCount != null ||
    (fallbackTotalCount != null && fallbackTotalCount > 0);
  const hasValidSnapshot =
    Boolean(snapshotTime) || hasSnapshotCount || hasFallbackSnapshotCount;
  let diffMin = null;
  if (snapshotTime && prevSnap.gdcPeriod?.end) {
    const snapshotMs = new Date(snapshotTime).getTime();
    const endMs = new Date(prevSnap.gdcPeriod.end).getTime();
    if (!Number.isNaN(snapshotMs) && !Number.isNaN(endMs)) {
      diffMin = Math.round((snapshotMs - endMs) / 60000);
    }
  }
  let warning = null;
  if (!hasValidSnapshot) {
    warning = "missing valid J-1 snapshot";
  } else if (!hasPrevCumulFame) {
    warning = "missing J-1 cumulFame (snapshot decks available)";
  } else if (delta <= 0) {
    warning = "snapshot suspect or corrupted";
  } else if (diffMin != null && diffMin > 90) {
    warning = "snapshot appears >90 min after reset";
  }
  return {
    weekSnaps: weekSnaps.map((s, i) => {
      const snapshotCount =
        s?.decks && Object.keys(s.decks).length > 0
          ? Object.values(s.decks).reduce(
              (sum, value) => sum + (typeof value === "number" ? value : 0),
              0,
            )
          : Number.isFinite(s?.snapshotCount)
            ? s.snapshotCount
            : null;
      const fallbackCount =
        fallbackWarDays?.[i]?.snapshotCount != null
          ? fallbackWarDays[i].snapshotCount
          : (fallbackWarDays?.[i]?.totalCount ?? null);
      const effectiveSnapshotCount =
        snapshotCount != null && snapshotCount > 0
          ? snapshotCount
          : fallbackCount;
      return {
        day: i,
        snapshotTime: s?.snapshotTime || s?.snapshotBackupTime || null,
        decks: s?.decks || null,
        _cumulFame: s?._cumulFame || null,
        snapshotCount: effectiveSnapshotCount,
        snapshotCountSource:
          snapshotCount != null && snapshotCount > 0
            ? "raw"
            : fallbackCount != null
              ? "fallback"
              : "missing",
      };
    }),
    warDayIndex,
    warSnapshotDays,
    debugDelta,
    clanTag,
    snapshotTime,
    snapshotBackupTime,
    cumulFameLive,
    cumulFameSnapshot: cumulFameSnapshotValid,
    snapshotJ1DailyFame,
    scoreJeudi,
    scoreVendredi,
    scoreSamedi,
    scoreDimanche,
    dailyScores,
    snapshotJ1PrevPrevCumulFame: cumulFamePrevPrevSnapshot,
    delta,
    diffMin,
    warning,
  };
}
