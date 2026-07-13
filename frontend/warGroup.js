// ============================================================
// warGroup.js — Rendu de la carte "War Group" / "Groupe de GDC"
// Affiche les clans du groupe de GDC actuel (API currentriverrace.clans[])
// ============================================================

import { roundProjectedFame } from "../backend/services/projectionFormat.js";
import { RACE_FINISH_LINE } from "../backend/services/warStandings.js";

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
  return `/clan/${clean}`;
}

/**
 * Formate un nombre avec séparateur de milliers.
 * @param {number} n
 */
function fmtNum(n) {
  return typeof n === "number" ? n.toLocaleString("fr-FR") : "—";
}

function fmtPct(ratio) {
  return typeof ratio === "number" && Number.isFinite(ratio)
    ? `${Math.round(ratio * 100)}%`
    : "—";
}

function fmtProjection(projectedFame, decksToday, targetDecksToday) {
  const rounded = roundProjectedFame(
    projectedFame,
    decksToday,
    targetDecksToday,
  );
  return rounded != null ? fmtNum(rounded) : "—";
}

/**
 * Construit et injecte la carte "War Group" dans le DOM.
 *
 * @param {object} data — réponse de /api/clan/:tag/analysis
 */
export function renderRaceGroupCard(data, timerHelper) {
  const container = document.getElementById("card-war-group");
  if (!container) return;

  const raceGroup = data.raceGroup;
  const ownTag = (data.clan?.tag ?? "").replace("#", "").toUpperCase();
  // Garde calendaire : jeu–dim seulement (0=dim, 4=jeu, 5=ven, 6=sam)
  // Primauté sur le cache statique qui peut contenir isWarPeriod=true depuis le week-end.
  const _resetMs = (data.clan?.warResetUtcMinutes ?? 580) * 60 * 1000;
  const _dow = new Date(Date.now() - _resetMs).getUTCDay();
  const _calendarIsWar = _dow === 0 || _dow >= 4;
  const isWarPeriod = _calendarIsWar && data.isWarPeriod === true;
  const isColosseum = data.isColosseum === true;
  const warDayIndex = data.clanWarSummary?.daysFromThu ?? 0;
  const showEngagement = isWarPeriod && warDayIndex > 0;

  // Masquer la card si pas de données
  if (!Array.isArray(raceGroup) || raceGroup.length === 0) {
    container.classList.add("hidden");
    return;
  }
  container.classList.remove("hidden");

  // Titre et Description
  const titleEl = container.querySelector(".card-title");
  if (titleEl) titleEl.textContent = "Groupe de GDC actuel";
  const descEl = container.querySelector("#war-group-description");
  if (descEl)
    descEl.textContent = "Comparez les 5 clans du groupe de GDC actuel";

  // Trier : par victoire assurée puis projection en période de GDC (les deux
  // types de semaine), sinon par last war fame décroissant. La progression
  // réelle du bateau (GDC normale) est affichée à part, dans la colonne
  // "Bateau" — voir backend/services/warStandings.js.
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

      // Le tableau est déjà trié selon le bon critère par type de semaine
      // (cf. `sorted` ci-dessus) : la position post-tri fait foi.
      const displayRank = isWarPeriod ? idx + 1 : (clan.rank ?? idx + 1);
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

      const engagementEstimate = clan.warParticipationEstimate ?? null;
      const engagementVal = fmtPct(engagementEstimate?.ratio);

      const targetVal = clan.targetDecksToday ?? 200;
      const decksTodayVal = clan.decksToday ?? 0;
      const maxDecks = 200;

      // Calcul des segments de la barre (en superposition)
      const currentPct = Math.min(100, (decksTodayVal / maxDecks) * 100);
      const targetPct = Math.min(100, (targetVal / maxDecks) * 100);

      let decksNowHtml = "";
      if (isWarPeriod) {
        const engagementTooltip = `${engagementEstimate?.activeMembers ?? "—"} membres ayant joué au moins 1 deck cette semaine / ${engagementEstimate?.rosterSize ?? "—"} dans le clan`;
        const tooltipText = `${decksTodayVal} decks / objectif de ${targetVal}`;
        decksNowHtml = `${showEngagement ? `<td class="war-group-engagement" title="${engagementTooltip}">${engagementVal}</td>` : ""}
        <td class="war-group-decks-now" title="${tooltipText}">
          <div class="wg-pbar-track">
            <div class="wg-pbar-fill wg-pbar-current" style="width: ${currentPct}%"></div>
            <div class="wg-pbar-fill wg-pbar-target" style="width: ${targetPct}%"></div>
            <div class="wg-pbar-value">${decksTodayVal}</div>
          </div>
        </td>`;
      }

      const currentPtsHtml = isWarPeriod
        ? `<td class="war-group-current-pts">${
            isColosseum
              ? clan.currentFame != null
                ? fmtNum(Math.round(clan.currentFame))
                : "—"
              : clan.clanScore != null
                ? fmtNum(Math.round(clan.clanScore))
                : "—"
          }</td>`
        : "";
      const avgPtsHtml = isWarPeriod
        ? `<td class="war-group-avg-pts">${clan.ptsPerDeck != null ? clan.ptsPerDeck.toFixed(2) : "—"}</td>`
        : "";

      let projectionHtml = "";
      if (isWarPeriod) {
        const isClinched = clan.isClinchedWin;
        let projVal;
        if (isClinched) {
          const title = isColosseum
            ? "Victoire mathématiquement assurée"
            : `Ligne d'arrivée franchie (progression bateau : ${fmtNum(RACE_FINISH_LINE)} pts)`;
          projVal = `<span class="war-group-clinched" title="${title}">✅ Victoire</span>`;
        } else {
          // Projection du classement/trophées de fin de journée (pts de bataille
          // extrapolés) — distincte du classement affiché par le rang (#1..#5),
          // qui lui reflète la vraie position (bateau en GDC normale, cumul en
          // Colisée). Voir backend/services/warStandings.js.
          projVal = fmtProjection(clan.projectedFame, decksTodayVal, targetVal);
        }
        projectionHtml = `<td class="war-group-projection">${projVal}</td>`;
      }

      // Colonne "Bateau" — GDC normale uniquement. Reflète la vraie position de
      // course (progression du bateau vers la ligne d'arrivée à 10000), distincte
      // de la projection du jour affichée ci-dessus. Voir warStandings.js.
      let boatHtml = "";
      if (isWarPeriod && !isColosseum) {
        const boatVal =
          clan.raceProgress != null
            ? `${fmtNum(clan.raceProgress)} / ${fmtNum(RACE_FINISH_LINE)}`
            : "—";
        boatHtml = `<td class="war-group-boat">${boatVal}</td>`;
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
      ${boatHtml}
    </tr>`;
    })
    .join("");

  const headers = `
    <thead>
      <tr>
        <th class="war-group-rank-cell"></th>
        <th class="war-group-name">Nom</th>
        ${!isWarPeriod ? `<th class="war-group-trophies">Trophées de guerre</th>` : ""}
        ${!isWarPeriod ? `<th class="war-group-prev-war">n-2 GDC</th>` : ""}
        ${!isWarPeriod ? `<th class="war-group-last-war">Dernière GDC</th>` : ""}
        ${showEngagement ? `<th class="war-group-engagement">Engagement</th>` : ""}
        ${isWarPeriod ? `<th class="war-group-decks-now">Decks <span>${timerHelper(data.clan?.warResetUtcMinutes)}</span></th>` : ""}
        ${isWarPeriod ? `<th class="war-group-current-pts">${isColosseum ? "Pts actuels" : "Pts"}</th>` : ""}
        ${isWarPeriod ? `<th class="war-group-avg-pts">Pts / Deck</th>` : ""}
        ${isWarPeriod ? `<th class="war-group-projection">Projection</th>` : ""}
        ${isWarPeriod && !isColosseum ? `<th class="war-group-boat">Bateau</th>` : ""}
      </tr>
    </thead>
  `;

  table.innerHTML = `${headers}<tbody>${rows}</tbody>`;
}
