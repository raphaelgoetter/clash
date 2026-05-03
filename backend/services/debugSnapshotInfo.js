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
  currentRaceClanFame = null,
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
  if (!hasSnapshotData(prevPrevSnap)) {
    const fallbackIndex = warDayIndex - 2;
    if (
      fallbackIndex >= 0 &&
      hasSnapshotData(fallbackWarDays?.[fallbackIndex])
    ) {
      prevPrevSnap = fallbackWarDays[fallbackIndex];
    } else if (Array.isArray(fallbackWarDays) && fallbackWarDays.length > 0) {
      for (let i = fallbackWarDays.length - 1; i >= 0; i--) {
        if (hasSnapshotData(fallbackWarDays[i])) {
          prevPrevSnap = fallbackWarDays[i];
          break;
        }
      }
    }
  }

  const sumFame = (fameMap) =>
    Object.values(fameMap ?? {}).reduce(
      (sum, value) => sum + (typeof value === "number" ? value : 0),
      0,
    );

  const hasFame = (fameMap) =>
    fameMap &&
    Object.values(fameMap).some((value) => typeof value === "number");

  const computeDailyScore = (daySnap, prevDaySnap) => {
    if (!hasFame(daySnap?._cumulFame)) return null;
    const currentSummed = sumFame(daySnap._cumulFame);
    if (!hasFame(prevDaySnap?._cumulFame)) return currentSummed;
    const prevSummed = sumFame(prevDaySnap._cumulFame);
    return Math.max(0, currentSummed - prevSummed);
  };

  const normalizeTag = (tag) =>
    `#${String(tag ?? "")
      .replace(/^#/, "")
      .toUpperCase()}`;

  const normalizedMemberTags = new Set(
    Array.from(currentMemberTags || []).map((tag) => normalizeTag(tag)),
  );
  const prevCumulFame = prevSnap._cumulFame ?? {};
  const prevPrevCumulFame = prevPrevSnap?._cumulFame ?? {};
  const prevCumulFameByTag = new Map(
    Object.entries(prevCumulFame).map(([tag, value]) => [
      normalizeTag(tag),
      value,
    ]),
  );
  const prevPrevCumulFameByTag = new Map(
    Object.entries(prevPrevCumulFame).map(([tag, value]) => [
      normalizeTag(tag),
      value,
    ]),
  );
  const debugDelta = [];
  let cumulDecksLive = 0;
  const cumulFameLive = allParts
    .filter((p) => normalizedMemberTags.has(normalizeTag(p.tag)))
    .reduce((sum, p) => {
      const live = p.fame ?? 0;
      const decksUsedToday = Number.isFinite(p.decksUsedToday)
        ? p.decksUsedToday
        : 0;
      cumulDecksLive += decksUsedToday;
      const key = normalizeTag(p.tag);
      const prev = prevCumulFameByTag.get(key) ?? 0;
      const delta = live - prev;
      debugDelta.push({
        tag: p.tag,
        name: p.name,
        live,
        prev,
        delta,
        decksUsedToday,
      });
      return sum + live;
    }, 0);
  const rawClanFameTotal = Number.isFinite(currentRaceClanFame)
    ? currentRaceClanFame
    : null;
  const clanFameTotalDiff =
    rawClanFameTotal != null ? rawClanFameTotal - cumulFameLive : null;
  const effectiveCumulFameLive =
    rawClanFameTotal != null && rawClanFameTotal > cumulFameLive
      ? rawClanFameTotal
      : cumulFameLive;
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
    ? effectiveCumulFameLive - cumulFameSnapshotValid
    : null;
  const livePlayersWithDecks = debugDelta.filter(
    (d) => d.decksUsedToday > 0,
  ).length;
  const livePlayersWithDecksAndNoFameDiff = debugDelta.filter(
    (d) => d.decksUsedToday > 0 && d.delta === 0,
  ).length;
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
  const snapshotJ1DailyFame = (() => {
    if (!hasPrevCumulFame) return null;
    if (Object.keys(prevPrevCumulFame).length > 0) {
      return Math.max(0, cumulFameSnapshot - cumulFamePrevPrevSnapshot);
    }
    if (warDayIndex === 1) {
      return cumulFameSnapshot;
    }
    return null;
  })();
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
  } else if (delta < 0) {
    warning = "snapshot suspect or corrupted";
  } else if (cumulDecksLive > 0 && delta === 0) {
    warning =
      "Points non comptabilisés aujourd'hui : GDC déjà gagnée prématurément";
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
    cumulDecksLive,
    livePlayersWithDecks,
    livePlayersWithDecksAndNoFameDiff,
    rawClanFameTotal,
    clanFameTotalDiff,
    effectiveCumulFameLive,
    cumulFameLiveSource:
      rawClanFameTotal != null && rawClanFameTotal > cumulFameLive
        ? "clanTotal"
        : "participantsSum",
    liveFameDeltaZeroWithDecks:
      cumulDecksLive > 0 && delta === 0 && hasPrevCumulFame,
    delta,
    diffMin,
    warning,
    // ── Champs snapshot pré-reset (T−2 min) ──────────────────────────
    ...buildPreResetFields(
      prevSnap,
      prevPrevSnap,
      normalizedMemberTags,
      allParts,
      hasFame,
      sumFame,
    ),
  };
}

/**
 * Construit les champs de traçabilité du snapshot pré-reset depuis prevSnap.
 * Retourne un objet vide si aucun snapshot pré-reset n'a été enregistré.
 */
function buildPreResetFields(
  prevSnap,
  prevPrevSnap,
  normalizedMemberTags,
  allParts,
  hasFame,
  sumFame,
) {
  const snapshotPreResetTime = prevSnap?.snapshotPreResetTime ?? null;
  if (!snapshotPreResetTime) return {};

  const decksPreReset = prevSnap.decksPreReset ?? null;
  const cumulFamePreReset = prevSnap._cumulFamePreReset ?? null;

  // Total de decks joués au moment du snapshot pré-reset.
  const preResetDecksTotal = decksPreReset
    ? Object.values(decksPreReset).reduce(
        (s, v) => s + (typeof v === "number" ? v : 0),
        0,
      )
    : null;

  // Fame journalière J-1 calculée au moment du snapshot pré-reset.
  const prevPrevCumulFame = prevPrevSnap?._cumulFame ?? {};
  const preResetFameTotal =
    cumulFamePreReset && hasFame(cumulFamePreReset)
      ? Math.max(
          0,
          sumFame(cumulFamePreReset) -
            (hasFame(prevPrevCumulFame) ? sumFame(prevPrevCumulFame) : 0),
        )
      : null;

  // Lookup nom des joueurs depuis les participants live.
  const normalizeTag = (tag) =>
    `#${String(tag ?? "")
      .replace(/^#/, "")
      .toUpperCase()}`;
  const nameByTag = new Map(
    (allParts ?? []).map((p) => [
      normalizeTag(p.tag),
      p.name ?? normalizeTag(p.tag),
    ]),
  );

  // Joueurs avec moins de 4 decks au moment du snapshot pré-reset.
  const preResetMissingDecks = Array.from(normalizedMemberTags ?? [])
    .reduce((acc, tag) => {
      const played = Number.isFinite(decksPreReset?.[tag])
        ? decksPreReset[tag]
        : 0;
      const missing = Math.max(0, 4 - played);
      if (missing > 0) {
        acc.push({ tag, name: nameByTag.get(tag) ?? tag, missing });
      }
      return acc;
    }, [])
    .sort(
      (a, b) => b.missing - a.missing || a.name.localeCompare(b.name, "fr"),
    );

  // Écart decks pré-reset vs snapshot régulier.
  const snapshotCount = prevSnap.snapshotCount ?? null;
  const preResetVsSnapshotDiff =
    preResetDecksTotal != null && snapshotCount != null
      ? preResetDecksTotal - snapshotCount
      : null;

  return {
    snapshotPreResetTime,
    preResetDecksTotal,
    preResetFameTotal,
    preResetMissingDecks,
    preResetVsSnapshotDiff,
  };
}
