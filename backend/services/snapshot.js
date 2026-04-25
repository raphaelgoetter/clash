// ============================================================
// snapshot.js — helper for recording daily decksUsed snapshots from a
// river race log. File-based storage under data/snapshots.
// ============================================================

import fs from "fs/promises";
import path from "path";

import { fileURLToPath } from "url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));

import { parisOffsetMs, warResetOffsetMs } from "./dateUtils.js";
const DATA_SNAP_DIR = path.resolve(__dirname, "..", "..", "data", "snapshots");
const TMP_SNAP_DIR = path.join("/tmp", "clash-snapshots");
const RETENTION_DAYS = 60;

async function ensureDirectory(dir) {
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch (_) {}
}

function snapshotFilename(clanTag, useTmp = false) {
  const clean = clanTag.replace(/[^A-Za-z0-9]/g, "");
  return path.join(useTmp ? TMP_SNAP_DIR : DATA_SNAP_DIR, `${clean}.json`);
}

async function readJsonFile(file) {
  const txt = await fs.readFile(file, "utf-8");
  return JSON.parse(txt);
}

async function fileMtime(file) {
  try {
    return (await fs.stat(file)).mtimeMs;
  } catch (_) {
    return 0;
  }
}

async function fileStat(file) {
  try {
    return await fs.stat(file);
  } catch (_) {
    return null;
  }
}

function convertLegacySnapshots(raw, clanTag = null) {
  // Legacy format: array of { week, date, warDay, decks, _cumul, ... }
  // Convert to new format: [{ week, days: [{ warDay, realDay, snapshots:[...], decks: {...} }] }]
  const byWeek = new Map();
  for (const entry of Array.isArray(raw) ? raw : []) {
    const week = entry.week ?? "unknown";
    const dayKey = entry.date;
    const warDay = entry.warDay ?? getWarDayName(dayKey);
    const takenAt =
      entry._snapshotTakenAt ?? entry._generatedAt ?? `${dayKey}T12:00:00Z`;
    const weekObj = byWeek.get(week) ?? { week, days: [] };
    weekObj.days.push({
      warDay,
      realDay: dayKey,
      snapshots: [{ type: "legacy", takenAt, decks: entry.decks ?? {} }],
      decks: { ...(entry.decks ?? {}) },
    });
    byWeek.set(week, weekObj);
  }
  return Array.from(byWeek.values()).map((w) => {
    const week = {
      week: w.week,
      days: w.days,
    };
    return fillWeekDays(week, clanTag);
  });
}

function normalizeSnapshots(raw, clanTag = null) {
  if (!raw) return [];
  if (!Array.isArray(raw)) return [];
  if (raw.length === 0) return [];

  const actualizeDay = (day) => {
    const timestamp =
      day.snapshotTime ||
      day.snapshotBackupTime ||
      day.hourlyCumul?.[0]?.takenAt;
    if (!timestamp) return day;
    const info = getWarDayInfo(new Date(timestamp), clanTag);
    if (!info) return day;
    if (day.warDay && day.realDay) return day;
    return {
      ...day,
      warDay: day.warDay ?? info.warDay,
      realDay: day.realDay ?? info.realDay,
    };
  };

  const mergeDayEntries = (existing, incoming) => {
    const latestSnapshotTime = [existing.snapshotTime, incoming.snapshotTime]
      .filter(Boolean)
      .sort()
      .pop();
    const latestBackupTime = [
      existing.snapshotBackupTime,
      incoming.snapshotBackupTime,
    ]
      .filter(Boolean)
      .sort()
      .pop();
    const mergeHourly = [
      ...(existing.hourlyCumul ?? []),
      ...(incoming.hourlyCumul ?? []),
    ];
    const hourlyCumul = Array.from(
      mergeHourly
        .reduce((map, entry) => {
          if (entry?.takenAt) map.set(entry.takenAt, entry);
          return map;
        }, new Map())
        .values(),
    ).sort((a, b) => new Date(a.takenAt) - new Date(b.takenAt));

    return {
      ...existing,
      ...incoming,
      snapshotTime:
        latestSnapshotTime ?? existing.snapshotTime ?? incoming.snapshotTime,
      snapshotBackupTime:
        latestBackupTime ??
        existing.snapshotBackupTime ??
        incoming.snapshotBackupTime,
      decks:
        Object.keys(incoming.decks ?? {}).length > 0
          ? incoming.decks
          : (existing.decks ?? {}),
      _cumul: mergeMaps(existing._cumul ?? {}, incoming._cumul ?? {}),
      _cumulFame: mergeMaps(
        existing._cumulFame ?? {},
        incoming._cumulFame ?? {},
      ),
      hourlyCumul,
    };
  };

  const rebucketDays = (week) => {
    const entries = (week.days ?? []).map((d) => actualizeDay(d));
    const byWarDay = new Map();
    for (const day of entries) {
      const key = day.warDay || "unknown";
      if (!byWarDay.has(key)) {
        byWarDay.set(key, { ...day });
      } else {
        byWarDay.set(key, mergeDayEntries(byWarDay.get(key), day));
      }
    }
    return { ...week, days: Array.from(byWarDay.values()) };
  };

  // Already new format (weeks with days array)
  if (raw[0].week && Array.isArray(raw[0].days)) {
    return raw.map((w) => fillWeekDays(rebucketDays(w), clanTag));
  }

  // Legacy format (flat list) -> convert
  return convertLegacySnapshots(raw, clanTag);
}

async function loadSnapshots(clanTag) {
  await ensureDirectory(TMP_SNAP_DIR);
  const tmpFile = snapshotFilename(clanTag, true);
  const dataFile = snapshotFilename(clanTag, false);

  const tmpMtime = await fileMtime(tmpFile);
  const dataMtime = await fileMtime(dataFile);
  const tmpMtimeIso = tmpMtime > 0 ? new Date(tmpMtime).toISOString() : null;
  const dataMtimeIso = dataMtime > 0 ? new Date(dataMtime).toISOString() : null;
  const debugMeta = {
    clanTag,
    tmpFile,
    tmpMtime: tmpMtimeIso,
    dataFile,
    dataMtime: dataMtimeIso,
  };

  if (tmpMtime > 0 && tmpMtime >= dataMtime) {
    try {
      const raw = await readJsonFile(tmpFile);
      console.warn("[snapshot] loadSnapshots using tmp file", debugMeta);
      return normalizeSnapshots(raw, clanTag);
    } catch (err) {
      console.warn(
        "[snapshot] loadSnapshots tmp file invalid, falling back to data file",
        { ...debugMeta, error: err.message },
      );
      // tmp file invalid or corrupted, fallback to data file below.
    }
  }

  if (dataMtime > 0) {
    try {
      const raw = await readJsonFile(dataFile);
      const snaps = normalizeSnapshots(raw, clanTag);
      console.warn("[snapshot] loadSnapshots using data file", debugMeta);
      try {
        await ensureDirectory(TMP_SNAP_DIR);
        await fs.writeFile(tmpFile, JSON.stringify(raw, null, 2));
      } catch (_) {
        // ignore, /tmp may be unavailable in some environments
      }
      return snaps;
    } catch (err) {
      console.warn(
        "[snapshot] loadSnapshots data file invalid, falling back to tmp file",
        { ...debugMeta, error: err.message },
      );
      // data file invalid or absent, fallback to tmp if available.
    }
  }

  if (tmpMtime > 0) {
    try {
      const raw = await readJsonFile(tmpFile);
      console.warn(
        "[snapshot] loadSnapshots using tmp file as final fallback",
        debugMeta,
      );
      return normalizeSnapshots(raw, clanTag);
    } catch (err) {
      console.warn(
        "[snapshot] loadSnapshots final tmp fallback invalid, returning empty",
        { ...debugMeta, error: err.message },
      );
      // fallback to empty
    }
  }

  console.warn("[snapshot] loadSnapshots no snapshot file found", debugMeta);
  return [];
}

async function saveSnapshots(clanTag, weeks) {
  // _cumul est persisté sur disque : il sert à calculer le delta quotidien
  // au run suivant (baseCumul = _cumul du jour précédent). Le stripper
  // provoquait rawDaily = cumulatif total au lieu du vrai delta du jour.
  await ensureDirectory(TMP_SNAP_DIR);
  const tmpFile = snapshotFilename(clanTag, true);
  try {
    await fs.writeFile(tmpFile, JSON.stringify(weeks || [], null, 2));
    return;
  } catch (err) {
    // If /tmp is unavailable, fallback to the repo data folder when writable.
  }

  const dataFile = snapshotFilename(clanTag, false);
  try {
    await ensureDirectory(DATA_SNAP_DIR);
    await fs.writeFile(dataFile, JSON.stringify(weeks || [], null, 2));
  } catch (_) {
    // ignore write failure, snapshot persistence is best-effort
  }
}

/**
 * Return a (Paris-local) date string YYYY-MM-DD for a given Date.
 */
function parisDateKey(date = new Date()) {
  const p = new Date(
    date.toLocaleString("en-US", { timeZone: "Europe/Paris" }),
  );
  const y = p.getFullYear();
  const m = String(p.getMonth() + 1).padStart(2, "0");
  const d = String(p.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Build a UTC timestamp representing `YYYY-MM-DD` at `hh:mm` in Paris local time.
 */
function parisTimeUtcMs(dateKey, hour = 0, minute = 0) {
  const [y, m, d] = (dateKey ?? "").split("-").map(Number);
  if (!y || !m || !d) return null;
  const utcMs = Date.UTC(y, m - 1, d, hour, minute);
  // Compute offset for midday to avoid DST boundary issues
  const offset = parisOffsetMs(new Date(`${dateKey}T12:00:00Z`));
  return utcMs - offset;
}

/**
 * Retourne le timestamp UTC (ms) correspondant au début d'une journée GDC.
 * Par défaut 09:40 UTC ; peut être surchargé par clan (ex. Y8JUPC9C → 09:52 UTC).
 */
function warPeriodStartUtcMs(realDay, clanTag = null) {
  const [y, m, d] = (realDay ?? "").split("-").map(Number);
  if (!y || !m || !d) return null;
  const offsetMs = warResetOffsetMs(clanTag);
  const h = Math.floor(offsetMs / 3_600_000);
  const min = (offsetMs % 3_600_000) / 60_000;
  return Date.UTC(y, m - 1, d, h, min, 0);
}

/**
 * For a given timestamp, return the war day (thu/fri/sat/sun) and the corresponding
 * local calendar date (Paris) for that war day.
 *
 * A war day runs from the clan's reset UTC until the next day exactly 24h later.
 */
function getWarDayInfo(date = new Date(), clanTag = null) {
  const utc = date instanceof Date ? date : new Date(date);
  const resetUtcMs = warResetOffsetMs(clanTag);

  const utcMidnight = Date.UTC(
    utc.getUTCFullYear(),
    utc.getUTCMonth(),
    utc.getUTCDate(),
  );
  let dayStartUtc = utcMidnight + resetUtcMs;
  if (utc.getTime() < dayStartUtc) {
    dayStartUtc -= MS_PER_DAY;
  }

  const warDate = new Date(dayStartUtc);
  const names = [
    "sunday",
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
  ];
  const warDay = names[warDate.getUTCDay()];
  const warDays = ["thursday", "friday", "saturday", "sunday"];
  if (!warDays.includes(warDay)) return null;

  return {
    warDay,
    realDay: warDate.toISOString().slice(0, 10),
  };
}

function getWarDayName(warDayKey) {
  const names = [
    "sunday",
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
  ];
  const d = new Date(`${warDayKey}T12:00:00Z`);
  return names[d.getUTCDay()] ?? null;
}

const MS_PER_DAY = 1000 * 60 * 60 * 24;
const WAR_DAYS = ["thursday", "friday", "saturday", "sunday"];

function mergeMaps(a = {}, b = {}) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) {
    out[k] = Math.max(out[k] ?? 0, v ?? 0);
  }
  return out;
}

function clampDeckValues(decks = {}) {
  const normalized = Object.entries(decks)
    .filter(([, v]) => Number.isFinite(v) && v >= 0)
    .map(([k, v]) => [k, Math.min(4, Math.max(0, Math.round(v)))]);

  // Keep top 50 contributors to avoid impossible sums (>200) and membership overflow.
  const prioritized = normalized
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 50);

  return Object.fromEntries(prioritized);
}

function isValidSnapshotTimestamp(day, timestamp) {
  if (!timestamp || !day?.gdcPeriod?.start) return false;
  return (
    timestamp.slice(0, 10) === day.realDay || timestamp >= day.gdcPeriod.start
  );
}

function hasValidSnapshotTime(day) {
  return (
    isValidSnapshotTimestamp(day, day.snapshotTime) ||
    isValidSnapshotTimestamp(day, day.snapshotBackupTime)
  );
}

function makeEmptyDay(warDay, realDay = null, clanTag = null) {
  const gdcPeriod = realDay
    ? {
        start: new Date(warPeriodStartUtcMs(realDay, clanTag)).toISOString(),
        end: new Date(
          warPeriodStartUtcMs(realDay, clanTag) + MS_PER_DAY - 1,
        ).toISOString(),
      }
    : null;

  return {
    warDay,
    realDay,
    gdcPeriod,
    snapshotTime: null,
    snapshotBackupTime: null,
    decks: {},
    hourlyCumul: [],
    _cumulFame: {},
    periodType: null,
  };
}

export function resolveSnapshotType(now, clanTag = null, overrideType = null) {
  const type = String(overrideType ?? "auto").toLowerCase();
  if (type === "primary" || type === "backup") return type;

  const utc = now instanceof Date ? now : new Date(now);
  const resetUtcMs = warResetOffsetMs(clanTag);
  const utcMidnight = Date.UTC(
    utc.getUTCFullYear(),
    utc.getUTCMonth(),
    utc.getUTCDate(),
  );
  const todayResetUtc = utcMidnight + resetUtcMs;
  const warDayStartUtc =
    utc.getTime() < todayResetUtc ? todayResetUtc - MS_PER_DAY : todayResetUtc;
  const minutesSinceWarDayStart = (utc.getTime() - warDayStartUtc) / 60000;

  return minutesSinceWarDayStart <= 90 ? "backup" : "primary";
}

function fillWeekDays(week, clanTag = null) {
  // Ensure week.days contains exactly one entry per war day (thu→sun), ordered.
  const byWarDay = new Map((week.days ?? []).map((d) => [d.warDay, d]));

  // Try to infer a reference date if any day has a realDay.
  let refWarDay = null;
  let refRealDay = null;
  for (const wd of WAR_DAYS) {
    const d = byWarDay.get(wd);
    if (d?.realDay) {
      refWarDay = wd;
      refRealDay = d.realDay;
      break;
    }
  }

  const refIndex = refWarDay ? WAR_DAYS.indexOf(refWarDay) : -1;
  const refDate = refRealDay ? new Date(`${refRealDay}T12:00:00Z`) : null;

  const days = WAR_DAYS.map((wd, idx) => {
    const existing = byWarDay.get(wd);
    let realDay = existing?.realDay ?? null;
    if (!realDay && refDate && refIndex !== -1) {
      const delta = idx - refIndex;
      realDay = new Date(refDate.getTime() + delta * MS_PER_DAY)
        .toISOString()
        .slice(0, 10);
    }

    const day = existing ? { ...existing } : makeEmptyDay(wd, realDay, clanTag);
    day.warDay = wd;
    day.realDay = realDay;

    // Fenêtre temporelle UTC de la journée GDC : reset UTC → lendemain même heure.
    if (realDay) {
      const startMs = warPeriodStartUtcMs(realDay, clanTag);
      const endMs = startMs ? startMs + MS_PER_DAY - 1 : null;
      day.gdcPeriod =
        startMs && endMs
          ? {
              start: new Date(startMs).toISOString(),
              end: new Date(endMs).toISOString(),
            }
          : null;
    }

    // Ensure mandatory fields exist
    day.snapshotTime = day.snapshotTime ?? null;
    day.snapshotBackupTime = day.snapshotBackupTime ?? null;
    day.decks = day.decks ?? {};
    day.hourlyCumul = day.hourlyCumul ?? [];
    day._cumul = day._cumul ?? {};
    day._cumulFame = day._cumulFame ?? {};
    day.periodType = day.periodType ?? null;

    return day;
  });

  week.days = days;
  return week;
}

export async function getSnapshotFileDebug(clanTag) {
  await ensureDirectory(TMP_SNAP_DIR);
  const tmpFile = snapshotFilename(clanTag, true);
  const dataFile = snapshotFilename(clanTag, false);
  const tmpStat = await fileStat(tmpFile);
  const dataStat = await fileStat(dataFile);
  const tmpMtime = tmpStat?.mtimeMs ?? 0;
  const dataMtime = dataStat?.mtimeMs ?? 0;

  return {
    clanTag,
    tmpFile,
    dataFile,
    tmpExists: tmpMtime > 0,
    dataExists: dataMtime > 0,
    tmpMtime: tmpMtime > 0 ? new Date(tmpMtime).toISOString() : null,
    dataMtime: dataMtime > 0 ? new Date(dataMtime).toISOString() : null,
    tmpSize: tmpStat?.size ?? null,
    dataSize: dataStat?.size ?? null,
    selectedSource:
      tmpMtime > 0 && tmpMtime >= dataMtime
        ? "tmp"
        : dataMtime > 0
          ? "data"
          : tmpMtime > 0
            ? "tmp"
            : "none",
  };
}

/**
 * Enregistre les combats GDC du jour pour chaque participant.
 * `decks` = combats effectués aujourd'hui seulement (0–4 par joueur).
 * `_cumul` = total hebdo depuis l'API (conservé pour calculer le delta du jour suivant).
 *
 * @param {string} clanTag
 * @param {{tag:string,decksUsed:number}[]} participantData
 *        participants de /currentriverrace (decksUsed = cumul depuis jeudi)
 */
export async function recordSnapshot(
  clanTag,
  participantData,
  week = null,
  options = {},
) {
  if (!participantData || participantData.length === 0) return;

  const now = options.now ? new Date(options.now) : new Date();
  const paris = new Date(
    now.toLocaleString("en-US", { timeZone: "Europe/Paris" }),
  );

  const resetUtcMs = warResetOffsetMs(clanTag);
  const utcMidnight = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );
  const todayResetUtc = utcMidnight + resetUtcMs;
  const warDayStartUtc =
    now.getTime() < todayResetUtc ? todayResetUtc - MS_PER_DAY : todayResetUtc;
  const minutesSinceWarDayStart = (now.getTime() - warDayStartUtc) / 60000;
  // Snapshot taken in the first 90 minutes after a war-day reset is a backup
  // snapshot for the previous day. Later runs during the same war day report
  // the current day's data and should not be treated as a backup.
  const snapshotType = resolveSnapshotType(now, clanTag, options.snapshotType);

  const warInfo = getWarDayInfo(now, clanTag);
  if (!warInfo) return; // outside of war period (mon-wed after reset)

  const { warDay, realDay } = warInfo;

  // weekly cumulative totals from currentriverrace
  const currentCumul = {};
  const currentCumulFame = {};
  participantData.forEach((p) => {
    currentCumul[p.tag] = p.decksUsed || 0;
    currentCumulFame[p.tag] = p.fame || 0;
  });

  const history = await loadSnapshots(clanTag);

  const weekId = week ?? "unknown";
  let weekEntry = history.find((w) => w.week === weekId);
  if (!weekEntry) {
    weekEntry = { week: weekId, days: [] };
    history.push(weekEntry);
  }

  // Ensure we have exactly four ordered war days (thu→sun).
  const existing = new Map((weekEntry.days ?? []).map((d) => [d.warDay, d]));
  const baseDate = new Date(`${realDay}T12:00:00Z`);
  const baseIndex = WAR_DAYS.indexOf(warDay);

  weekEntry.days = WAR_DAYS.map((wd, idx) => {
    const existingDay = existing.get(wd);
    const day = existingDay ? { ...existingDay } : makeEmptyDay(wd, null);

    // Infer the real calendar date for each war day based on the current war day.
    if (baseIndex !== -1) {
      day.realDay = new Date(
        baseDate.getTime() + (idx - baseIndex) * MS_PER_DAY,
      )
        .toISOString()
        .slice(0, 10);
    }

    // Ensure required fields exist
    day.snapshotTime = day.snapshotTime ?? null;
    day.snapshotBackupTime = day.snapshotBackupTime ?? null;
    day.decks = day.decks ?? {};
    day._cumul = day._cumul ?? {};
    day._cumulFame = day._cumulFame ?? {};
    day.periodType = day.periodType ?? null;

    return day;
  });

  const dayEntry = weekEntry.days[baseIndex];
  if (!dayEntry) return; // should not happen

  // Ensure the real day matches the computed one (Paris date of the war day)
  dayEntry.realDay = realDay;

  // Fenêtre temporelle UTC de la journée GDC : reset UTC → lendemain même heure.
  if (realDay) {
    const startMs = warPeriodStartUtcMs(realDay, clanTag);
    const endMs = startMs ? startMs + MS_PER_DAY - 1 : null;
    dayEntry.gdcPeriod =
      startMs && endMs
        ? {
            start: new Date(startMs).toISOString(),
            end: new Date(endMs).toISOString(),
          }
        : null;
  }

  // Determine decks for this snapshot (delta since yesterday)
  const prevDayIndex = WAR_DAYS.indexOf(warDay) - 1;
  const prevDay = prevDayIndex >= 0 ? weekEntry.days[prevDayIndex] : null;
  const baseCumul = prevDay?._cumul ?? {};

  const baseCumulHasData = Object.keys(baseCumul).length > 0;

  const rawDaily = {};
  const daily = {};
  for (const tag of Object.keys(currentCumul)) {
    const delta = Math.max(0, currentCumul[tag] - (baseCumul[tag] ?? 0));
    rawDaily[tag] = delta;
    daily[tag] = Math.min(4, delta);
  }

  const hasCurrentDayPrimarySnapshot = Boolean(dayEntry.snapshotTime);
  const preserveCurrentDaySnapshot =
    snapshotType === "backup" && hasCurrentDayPrimarySnapshot;

  const computeSnapshotCount = (decks = {}) =>
    Object.values(decks).reduce(
      (s, v) => s + (typeof v === "number" ? v : 0),
      0,
    );

  if (preserveCurrentDaySnapshot && !Number.isFinite(dayEntry.snapshotCount)) {
    dayEntry.snapshotCount = computeSnapshotCount(dayEntry.decks);
  }

  if (!preserveCurrentDaySnapshot) {
    // Si baseCumul est fiable (non vide), on utilise le delta exact comme source
    // de vérité — cela permet de corriger des valeurs gonflées lors de runs
    // précédents où baseCumul était absent. Sinon, on garde le max (sécurité).
    const newDecks = clampDeckValues(
      baseCumulHasData ? daily : mergeMaps(dayEntry.decks, daily),
    );
    if (
      Object.keys(newDecks).length === 0 &&
      Object.keys(dayEntry.decks ?? {}).length > 0
    ) {
      // Préserve les données déjà enregistrées pour le jour si la nouvelle
      // capture ne contient aucune valeur.
      dayEntry.decks = dayEntry.decks;
    } else {
      dayEntry.decks = newDecks;
    }
    dayEntry.snapshotCount = computeSnapshotCount(dayEntry.decks);
  }

  dayEntry._cumul = mergeMaps(dayEntry._cumul ?? {}, currentCumul);
  dayEntry._cumulFame = mergeMaps(dayEntry._cumulFame ?? {}, currentCumulFame);
  dayEntry.periodType = options.periodType ?? dayEntry.periodType ?? null;

  const cutoff = Date.now() - RETENTION_DAYS * 24 * 3600 * 1000;
  const filtered = history.filter((w) =>
    w.days.some((d) => d.realDay && new Date(d.realDay).getTime() >= cutoff),
  );

  if (snapshotType === "backup") {
    if (hasCurrentDayPrimarySnapshot) {
      dayEntry.snapshotBackupTime = now.toISOString();
    }

    const prevIndex = baseIndex - 1;
    const prevDayEntry = prevIndex >= 0 ? weekEntry.days[prevIndex] : null;
    const prevPrevIndex = baseIndex - 2;
    const prevPrevDayEntry =
      prevPrevIndex >= 0 ? weekEntry.days[prevPrevIndex] : null;
    const prevPrevCumul = prevPrevDayEntry?._cumul ?? {};

    // Backup snapshot taken soon after reset can be used to recover the
    // previous day's totals if they are missing.
    if (prevDayEntry && minutesSinceWarDayStart <= 90) {
      const inferredPrevDayDecks = {};
      for (const tag of Object.keys(currentCumul)) {
        const delta = Math.max(
          0,
          currentCumul[tag] - (prevPrevCumul[tag] ?? 0),
        );
        if (delta > 0) inferredPrevDayDecks[tag] = Math.min(4, delta);
      }
      if (Object.keys(inferredPrevDayDecks).length > 0) {
        prevDayEntry.decks = clampDeckValues(
          Object.keys(prevDayEntry.decks ?? {}).length > 0
            ? mergeMaps(prevDayEntry.decks, inferredPrevDayDecks)
            : inferredPrevDayDecks,
        );
      }
      prevDayEntry._cumul = mergeMaps(prevDayEntry._cumul ?? {}, currentCumul);
      prevDayEntry.snapshotCount = computeSnapshotCount(prevDayEntry.decks);
      prevDayEntry.snapshotBackupTime =
        prevDayEntry.snapshotBackupTime ?? now.toISOString();
      if (!Number.isFinite(prevDayEntry.snapshotCount)) {
        prevDayEntry.snapshotCount = computeSnapshotCount(prevDayEntry.decks);
      }
    }

    // Si on a un baseCumul valide : certains decks du backup peuvent appartenir
    // au jour précédent (joués dans les dernières secondes avant le reset).
    if (baseCumulHasData && prevDayEntry) {
      for (const tag of Object.keys(rawDaily)) {
        const overflow = Math.max(0, rawDaily[tag] - 4);
        if (overflow <= 0) continue;

        // Transfer overflow to previous day (but clamp to 4)
        prevDayEntry.decks = mergeMaps(prevDayEntry.decks, {
          [tag]: Math.min(4, (prevDayEntry.decks?.[tag] ?? 0) + overflow),
        });

        // Keep max 4 for the current day (the rest is considered previous day)
        daily[tag] = Math.min(4, daily[tag]);
      }
      // Ensure `decks` does not grow beyond 50 players and remains inside 0-4 per player.
      prevDayEntry.decks = clampDeckValues(prevDayEntry.decks);
    }

    // Le snapshot backup est pris juste après le reset : currentCumulFame reflète
    // l'état exact de fin de journée GDC J-1. On l'écrit sur le jour précédent pour
    // permettre un calcul précis de la fame du jour courant.
    if (prevDayEntry && minutesSinceWarDayStart <= 90) {
      prevDayEntry._cumulFame = mergeMaps(
        prevDayEntry._cumulFame ?? {},
        currentCumulFame,
      );
      prevDayEntry.snapshotCount = computeSnapshotCount(prevDayEntry.decks);
    }

    await saveSnapshots(clanTag, filtered);
    return;
  }

  if (snapshotType === "primary") {
    dayEntry.snapshotTime = now.toISOString();
  } else {
    dayEntry.snapshotBackupTime = now.toISOString();
  }

  dayEntry._cumul = mergeMaps(dayEntry._cumul ?? {}, currentCumul);
  dayEntry._cumulFame = mergeMaps(dayEntry._cumulFame ?? {}, currentCumulFame);
  dayEntry.periodType = options.periodType ?? dayEntry.periodType ?? null;

  // Historique intraday : un point par heure (dédoublonné sur 30 min) — primary seulement.
  dayEntry.hourlyCumul = dayEntry.hourlyCumul ?? [];
  const lastEntry = dayEntry.hourlyCumul[dayEntry.hourlyCumul.length - 1];
  const DEDUP_MS = 30 * 60 * 1000;
  if (
    !lastEntry ||
    now.getTime() - new Date(lastEntry.takenAt).getTime() >= DEDUP_MS
  ) {
    const dailyTotal = Object.keys(currentCumul).reduce(
      (s, tag) =>
        s + Math.min(4, Math.max(0, currentCumul[tag] - (baseCumul[tag] ?? 0))),
      0,
    );
    dayEntry.hourlyCumul.push({
      takenAt: now.toISOString(),
      total: dailyTotal,
    });
  }

  dayEntry.snapshotCount = computeSnapshotCount(dayEntry.decks);
  await saveSnapshots(clanTag, filtered);
}

/**
 * Return snapshot entries matching a particular week identifier (or all if
 * week is null). Returned array is sorted ascending by date.
 */
export async function getSnapshotsForWeek(clanTag, week = null) {
  const history = await loadSnapshots(clanTag);
  if (!history.length) return [];

  // Un snapshot est valide si snapshotTime ou snapshotBackupTime tombe le même
  // jour calendaire que realDay (captures pré-reset incluses), ou bien si un
  // snapshotCount manuel a été fourni. Les snapshots non GDC sont rejetés.
  const isValidSnapshot = (d) => {
    if (d.periodType != null && d.periodType !== "warDay") return false;
    if (!d.gdcPeriod?.start) return false;
    const hasValidTime = hasValidSnapshotTime(d);
    const hasManualCount = Number.isFinite(d.snapshotCount);
    return hasValidTime || hasManualCount;
  };

  const formatDay = (weekId, d) => {
    const deckSum =
      d?.decks && Object.keys(d.decks).length > 0
        ? Object.values(d.decks).reduce(
            (s, v) => s + (typeof v === "number" ? v : 0),
            0,
          )
        : null;
    const snapshotCount = isValidSnapshot(d)
      ? Number.isFinite(d.snapshotCount)
        ? d.snapshotCount
        : deckSum
      : null;
    return {
      week: weekId,
      date: d.realDay,
      warDay: d.warDay,
      decks: isValidSnapshot(d) ? d.decks : {},
      snapshotCount: snapshotCount ?? null,
      // _cumulFame n'est utile que si le snapshot est valide : un snapshot pris
      // avant le reset GDC (periodType=training) contient des données de la semaine
      // précédente qui corrompent le calcul du delta de fame du jour.
      _cumulFame: isValidSnapshot(d) ? (d._cumulFame ?? {}) : {},
      hourlyCumul: d.hourlyCumul ?? [],
      snapshotTime: isValidSnapshot(d) ? (d.snapshotTime ?? null) : null,
      snapshotBackupTime: isValidSnapshot(d)
        ? (d.snapshotBackupTime ?? null)
        : null,
    };
  };

  if (week == null) {
    return history
      .flatMap((w) => (w.days ?? []).map((d) => formatDay(w.week, d)))
      .sort((a, b) => (a.date ?? "").localeCompare(b.date ?? ""));
  }

  const weekEntry = history.find((w) => w.week === week);
  if (!weekEntry) return [];
  return (weekEntry.days ?? [])
    .map((d) => ({
      ...formatDay(weekEntry.week, d),
      gdcPeriod: d.gdcPeriod ?? null,
    }))
    .sort((a, b) => (a.date ?? "").localeCompare(b.date ?? ""));
}

/**
 * Return snapshots for multiple week identifiers in a single file read.
 * Retourne un objet { [weekId]: snap[] } pour chaque weekId demandé.
 */
export async function getSnapshotsForWeeks(clanTag, weeks) {
  const history = await loadSnapshots(clanTag);
  const result = Object.fromEntries(weeks.map((w) => [w, []]));
  if (!history.length) return result;

  // Même validation que getSnapshotsForWeek.
  const isValidSnapshot = (d) => {
    if (d.periodType != null && d.periodType !== "warDay") return false;
    if (!d.gdcPeriod?.start) return false;
    const hasValidTime = hasValidSnapshotTime(d);
    const hasManualCount = Number.isFinite(d.snapshotCount);
    return hasValidTime || hasManualCount;
  };

  const formatDay = (weekId, d) => {
    const deckSum =
      d?.decks && Object.keys(d.decks).length > 0
        ? Object.values(d.decks).reduce(
            (s, v) => s + (typeof v === "number" ? v : 0),
            0,
          )
        : null;
    const snapshotCount = isValidSnapshot(d)
      ? Number.isFinite(d.snapshotCount)
        ? d.snapshotCount
        : deckSum
      : null;
    return {
      week: weekId,
      date: d.realDay,
      warDay: d.warDay,
      decks: isValidSnapshot(d) ? d.decks : {},
      snapshotCount: snapshotCount ?? null,
      // _cumulFame n'est utile que si le snapshot est valide : un snapshot pris
      // avant le reset GDC (periodType=training) contient des données de la semaine
      // précédente qui corrompent le calcul du delta de fame du jour.
      _cumulFame: isValidSnapshot(d) ? (d._cumulFame ?? {}) : {},
      hourlyCumul: d.hourlyCumul ?? [],
      snapshotTime: isValidSnapshot(d) ? (d.snapshotTime ?? null) : null,
      snapshotBackupTime: isValidSnapshot(d)
        ? (d.snapshotBackupTime ?? null)
        : null,
      gdcPeriod: d.gdcPeriod ?? null,
    };
  };

  for (const weekEntry of history) {
    if (!result.hasOwnProperty(weekEntry.week)) continue;
    result[weekEntry.week] = (weekEntry.days ?? [])
      .map((d) => formatDay(weekEntry.week, d))
      .sort((a, b) => (a.date ?? "").localeCompare(b.date ?? ""));
  }
  return result;
}

export async function getSnapshots(clanTag) {
  return getSnapshotsForWeek(clanTag, null);
}

/**
 * Return true if we already recorded a snapshot for today (UTC).
 */
export async function hasSnapshotForToday(clanTag) {
  const history = await loadSnapshots(clanTag);
  if (!history.length) return false;
  const today = new Date().toISOString().slice(0, 10);
  return history.some((w) =>
    (w.days ?? []).some(
      (d) => d.realDay === today && (d.snapshotTime || d.snapshotBackupTime),
    ),
  );
}

/**
 * Return the date string of the most recent snapshot written, or null if none exists.
 * The format is ISO (YYYY-MM-DD) which is convenient for comparison on the frontend.
 */
export async function getLastSnapshotDate(clanTag) {
  const history = await loadSnapshots(clanTag);
  if (!history.length) return null;

  const allDays = history.flatMap((w) => w.days ?? []);

  // Prefer the most recent day where a snapshot was taken (primary or backup),
  // not the inferred realDay range for the entire war week.
  const dates = allDays
    .filter((d) => d.realDay && (d.snapshotTime || d.snapshotBackupTime))
    .map((d) => d.realDay)
    .filter(Boolean)
    .sort();

  if (dates.length) return dates[dates.length - 1];

  // Fallback: if no day has a timestamp (shouldn't happen), use any realDay.
  const allRealDays = allDays
    .map((d) => d.realDay)
    .filter(Boolean)
    .sort();
  return allRealDays.length ? allRealDays[allRealDays.length - 1] : null;
}

// expose the directory path so callers can inspect or do manual operations
export const SNAP_DIR_PATH = TMP_SNAP_DIR; // absolute path used internally

function warDayNameFromKey(warDayKey) {
  if (!warDayKey) return null;
  const [y, m, d] = warDayKey.split("-").map(Number);
  if (!y || !m || !d) return null;
  // Interpret the key as a local date (Paris) and compute weekday.
  // Using UTC noon avoids DST issues and ensures day-of-week matches local date.
  const dow = new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay();
  const names = [
    "sunday",
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
  ];
  return names[dow] ?? null;
}

// Expose helpers for computing the war day label (used by UI summaries)
export { getWarDayInfo, getWarDayName, warDayNameFromKey };
