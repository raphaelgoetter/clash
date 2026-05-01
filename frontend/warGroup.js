// ============================================================
// warGroup.js — Rendu de la carte "War Group" / "Groupe de GDC"
// Affiche les clans du groupe de GDC actuel (API currentriverrace.clans[])
// ============================================================

// Tags des clans de la famille — utilisés pour les liens TrustRoyale internes.
const FAMILY_TAGS = new Set(["Y8JUPC9C", "LRQP20V9", "QU9UQJRL"]);

/**
 * Retourne l'URL RoyaleAPI de la page war/race d'un clan.
 * Conservé pour usage futur éventuel.
 * @param {string} tag — tag avec ou sans '#'
 */
// function royaleApiRaceUrl(tag) {
//   const clean = tag.replace('#', '');
//   return `https://royaleapi.com/clan/${clean}/war/race`;
// }

/**
 * Retourne l'URL TrustRoyale pour n'importe quel clan.
 * @param {string} tag
 */
function trustUrl(tag) {
  const clean = tag.replace("#", "").toUpperCase();
  return `/?mode=clan&tag=%23${clean}`;
}

/**
 * Formate un nombre avec séparateur de milliers.
 * @param {number} n
 */
function fmtNum(n) {
  return typeof n === "number" ? n.toLocaleString("fr-FR") : "—";
}

/**
 * Construit et injecte la carte "War Group" dans le DOM.
 *
 * @param {object} data — réponse de /api/clan/:tag/analysis
 * @param {Function} t  — fonction de traduction
 */
export function renderRaceGroupCard(data, t, timerHelper) {
  const container = document.getElementById("card-war-group");
  if (!container) return;

  const raceGroup = data.raceGroup;
  const ownTag = (data.clan?.tag ?? "").replace("#", "").toUpperCase();
  const isWarPeriod = data.isWarPeriod === true;

  // Masquer la card si pas de données
  if (!Array.isArray(raceGroup) || raceGroup.length === 0) {
    container.classList.add("hidden");
    return;
  }
  container.classList.remove("hidden");

  // Titre et Description
  const titleEl = container.querySelector(".card-title");
  if (titleEl) titleEl.textContent = t("warGroupTitle");
  const descEl = container.querySelector("#war-group-description");
  if (descEl) descEl.textContent = t("warGroupDescription");

  // Trier : par victoire assurée puis projection en période de GDC, sinon par last war fame décroissant
  const sorted = [...raceGroup].sort((a, b) => {
    if (isWarPeriod) {
      const aClinched = a.isClinchedWin ? 1 : 0;
      const bClinched = b.isClinchedWin ? 1 : 0;
      if (aClinched !== bClinched) return bClinched - aClinched;
      if (a.projectedFame != null && b.projectedFame != null) {
        return b.projectedFame - a.projectedFame;
      }
    }
    return (b.lastWarFame ?? 0) - (a.lastWarFame ?? 0);
  });

  const table = container.querySelector(".war-group-table");
  if (!table) return;

  const rows = sorted
    .map((clan, idx) => {
      const cleanTag = (clan.tag ?? "").replace("#", "").toUpperCase();
      const isOwn = cleanTag === ownTag;
      const url = trustUrl(cleanTag);
      const isFamilyMember = FAMILY_TAGS.has(cleanTag);

      const nameHtml = `<a href="${url}" class="${isFamilyMember ? "war-group-family-link" : "war-group-external-link"}">${clan.name ?? clan.tag}</a>`;

      const displayRank = isWarPeriod
        ? clan.isClinchedWin
          ? idx + 1
          : (clan.projectedRank ?? idx + 1)
        : (clan.rank ?? idx + 1);
      const rankBadge = `<span class="war-group-rank">#${displayRank}</span>`;

      const trophiesVal =
        clan.clanWarTrophies != null
          ? `🏆 ${fmtNum(clan.clanWarTrophies)}`
          : "—";
      const prevWarVal =
        clan.prevWarFame != null ? `${fmtNum(clan.prevWarFame)}` : "—";

      let trendIcon = "";
      if (clan.lastWarFame != null && clan.prevWarFame != null) {
        if (clan.lastWarFame > clan.prevWarFame)
          trendIcon = '<span style="color: mediumseagreen;"> ⬆</span>';
        else if (clan.lastWarFame < clan.prevWarFame)
          trendIcon = '<span style="color: tomato;"> ⬇</span>';
      }
      const lastWarVal =
        clan.lastWarFame != null
          ? `${fmtNum(clan.lastWarFame)}${trendIcon}`
          : "—";

      const targetVal = clan.targetDecksToday ?? 200;
      const decksTodayVal = clan.decksToday ?? 0;
      const maxDecks = 200;

      // Calcul des segments de la barre (en superposition)
      const currentPct = Math.min(100, (decksTodayVal / maxDecks) * 100);
      const targetPct = Math.min(100, (targetVal / maxDecks) * 100);

      let decksNowHtml = "";
      if (isWarPeriod) {
        const tooltipText = t("warGroupDecksTooltip")
          .replace("{{decks}}", decksTodayVal)
          .replace("{{target}}", targetVal);
        decksNowHtml = `
        <td class="war-group-decks-now" title="${tooltipText}">
          <div class="wg-pbar-track">
            <div class="wg-pbar-fill wg-pbar-current" style="width: ${currentPct}%"></div>
            <div class="wg-pbar-fill wg-pbar-target" style="width: ${targetPct}%"></div>
            <div class="wg-pbar-value">${decksTodayVal}</div>
          </div>
        </td>`;
      }

      const currentPtsHtml = isWarPeriod
        ? `<td class="war-group-current-pts">${clan.clanScore != null ? fmtNum(Math.round(clan.clanScore)) : "—"}</td>`
        : "";
      const avgPtsHtml = isWarPeriod
        ? `<td class="war-group-avg-pts">${clan.ptsPerDeck != null ? clan.ptsPerDeck.toFixed(2) : "—"}</td>`
        : "";

      let projectionHtml = "";
      if (isWarPeriod) {
        const isClinched =
          clan.isClinchedWin ||
          (isOwn && clan.projectedFame === 0 && clan.decksToday > 0);
        const projVal = isClinched
          ? t("warGroupClinchedLabel")
          : clan.projectedFame != null
            ? fmtNum(Math.round(clan.projectedFame / 100) * 100)
            : "—";
        const clinchedHtml = isClinched
          ? ` <span class="war-group-clinched" title="${t("warGroupClinchedWin")}">${t("warGroupClinchedLabel")}</span>`
          : "";
        projectionHtml = `<td class="war-group-projection">${projVal}${isClinched ? "" : clinchedHtml}</td>`;
      }

      const trophiesHtml = !isWarPeriod
        ? `<td class="war-group-trophies">${trophiesVal}</td>`
        : "";
      const prevWarHtml = !isWarPeriod
        ? `<td class="war-group-prev-war">${prevWarVal}</td>`
        : "";
      const lastWarHtml = !isWarPeriod
        ? `<td class="war-group-last-war">${lastWarVal}</td>`
        : "";

      return `<tr class="war-group-row${isOwn ? " war-group-own" : ""}">
      <td class="war-group-rank-cell">${rankBadge}</td>
      <td class="war-group-name">${nameHtml}</td>
      ${trophiesHtml}
      ${prevWarHtml}
      ${lastWarHtml}
      ${decksNowHtml}
      ${currentPtsHtml}
      ${avgPtsHtml}
      ${projectionHtml}
    </tr>`;
    })
    .join("");

  const headers = `
    <thead>
      <tr>
        <th class="war-group-rank-cell"></th>
        <th class="war-group-name">${t("labelName")}</th>
        ${!isWarPeriod ? `<th class="war-group-trophies">${t("labelWarTrophies")}</th>` : ""}
        ${!isWarPeriod ? `<th class="war-group-prev-war">${t("warGroupPrevWar")}</th>` : ""}
        ${!isWarPeriod ? `<th class="war-group-last-war">${t("warGroupLastWar")}</th>` : ""}
        ${isWarPeriod ? `<th class="war-group-decks-now">${t("warGroupDecksToday")} <span>${timerHelper(data.clan?.warResetUtcMinutes)}</span></th>` : ""}
        ${isWarPeriod ? `<th class="war-group-current-pts">approx. ${t("warGroupCurrentPts")}</th>` : ""}
        ${isWarPeriod ? `<th class="war-group-avg-pts">${t("warGroupPtsPerDeck")}</th>` : ""}
        ${isWarPeriod ? `<th class="war-group-projection">${t("warGroupProjection")}</th>` : ""}
      </tr>
    </thead>
  `;

  table.innerHTML = `${headers}<tbody>${rows}</tbody>`;
}
