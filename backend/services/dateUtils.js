// ============================================================
// dateUtils.js — Utilitaires de dates, décalages timezone et
// clés de journées de guerre GDC.
// ============================================================

export const MS_PER_DAY = 1000 * 60 * 60 * 24;

/** Décalage UTC→Paris en ms pour une date donnée (+3 600 000 hiver, +7 200 000 été) */
export function parisOffsetMs(date = new Date()) {
  const p = new Date(date.toLocaleString('en-US', { timeZone: 'Europe/Paris' }));
  const u = new Date(date.toLocaleString('en-US', { timeZone: 'UTC' }));
  return p - u;
}

/**
 * Nombre de ms à soustraire à un timestamp UTC pour obtenir le « jour GDC » (reset 9h40 UTC).
 * La guerre de clan bascule à 9h40 UTC quelle que soit la saison (CET/CEST).
 */
export function warResetOffsetMs() {
  return (9 * 60 + 40) * 60 * 1000;
}

/**
 * Parse a Clash Royale timestamp string (YYYYMMDDTHHmmss.000Z) into a Date.
 * @param {string} ts
 * @returns {Date}
 */
export function parseClashDate(ts) {
  if (!ts) return new Date(0);
  // Format: 20240315T123456.000Z → standard ISO-ish
  const iso = ts.replace(
    /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})\.(\d{3})Z$/,
    '$1-$2-$3T$4:$5:$6.$7Z'
  );
  return new Date(iso);
}

/**
 * Return the war-day key (YYYY-MM-DD) for a timestamp, accounting for the
 * 10:40 UTC daily reset. Any battle before 10:40 UTC belongs to the previous war day.
 * @param {Date|string} dateOrTs
 * @returns {string}
 */
export function warDayKey(dateOrTs) {
  const d = dateOrTs instanceof Date ? dateOrTs : parseClashDate(dateOrTs);
  return new Date(d.getTime() - warResetOffsetMs(d)).toISOString().slice(0, 10);
}
