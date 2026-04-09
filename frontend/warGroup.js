// ============================================================
// warGroup.js — Rendu de la carte "War Group" / "Groupe de GDC"
// Affiche les clans du groupe de GDC actuel (API currentriverrace.clans[])
// ============================================================

// Tags des clans de la famille — utilisés pour les liens TrustRoyale internes.
const FAMILY_TAGS = new Set(['Y8JUPC9C', 'LRQP20V9', 'QU9UQJRL']);

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
  const clean = tag.replace('#', '').toUpperCase();
  return `/?mode=clan&tag=%23${clean}`;
}

/**
 * Formate un nombre avec séparateur de milliers.
 * @param {number} n
 */
function fmtNum(n) {
  return typeof n === 'number' ? n.toLocaleString('fr-FR') : '—';
}

/**
 * Construit et injecte la carte "War Group" dans le DOM.
 *
 * @param {object} data — réponse de /api/clan/:tag/analysis
 * @param {Function} t  — fonction de traduction
 */
export function renderRaceGroupCard(data, t) {
  const container = document.getElementById('card-war-group');
  if (!container) return;

  const raceGroup = data.raceGroup;
  const ownTag = (data.clan?.tag ?? '').replace('#', '').toUpperCase();
  const isWarPeriod = data.isWarPeriod === true;

  // Masquer la card si pas de données
  if (!Array.isArray(raceGroup) || raceGroup.length === 0) {
    container.classList.add('hidden');
    return;
  }
  container.classList.remove('hidden');

  // Titre et Description
  const titleEl = container.querySelector('.card-title');
  if (titleEl) titleEl.textContent = t('warGroupTitle');
  const descEl = container.querySelector('#war-group-description');
  if (descEl) descEl.textContent = t('warGroupDescription');

  // Trier : par projection si GDC active, sinon par last war fame décroissant
  const sorted = [...raceGroup].sort((a, b) => {
    if (isWarPeriod && b.projectedFame != null && a.projectedFame != null) {
      return b.projectedFame - a.projectedFame;
    }
    return (b.lastWarFame ?? 0) - (a.lastWarFame ?? 0);
  });

  const tbody = container.querySelector('.war-group-list');
  if (!tbody) return;

  const rows = sorted.map((clan, idx) => {
    const cleanTag = (clan.tag ?? '').replace('#', '').toUpperCase();
    const isOwn = cleanTag === ownTag;
    const url = trustUrl(cleanTag);
    const isFamilyMember = FAMILY_TAGS.has(cleanTag);

    const nameHtml = `<a href="${url}" class="${isFamilyMember ? 'war-group-family-link' : 'war-group-external-link'}">${clan.name ?? clan.tag}</a>`;

    const displayRank = isWarPeriod ? (clan.projectedRank ?? idx + 1) : (clan.rank ?? (idx + 1));
    const rankBadge = `<span class="war-group-rank">#${displayRank}</span>`;

    const trophiesVal = clan.clanWarTrophies != null ? `🏆 ${fmtNum(clan.clanWarTrophies)}` : '—';
    const prevWarVal = clan.prevWarFame != null ? `${fmtNum(clan.prevWarFame)}` : '—';
    
    let trendIcon = '';
    if (clan.lastWarFame != null && clan.prevWarFame != null) {
      if (clan.lastWarFame > clan.prevWarFame) trendIcon = '<span style="color: mediumseagreen;"> ⬆</span>';
      else if (clan.lastWarFame < clan.prevWarFame) trendIcon = '<span style="color: tomato;"> ⬇</span>';
    }
    const lastWarVal = clan.lastWarFame != null ? `${fmtNum(clan.lastWarFame)}${trendIcon}` : '—';

    // Nouvelles colonnes GDC
    const decksNowHtml = isWarPeriod ? `<td class="war-group-decks-now">${clan.decksToday != null ? clan.decksToday : '—'}</td>` : '';
    const avgPtsHtml = isWarPeriod ? `<td class="war-group-avg-pts">${clan.ptsPerDeck != null ? clan.ptsPerDeck.toFixed(1) : '—'}</td>` : '';
    
    let projectionHtml = '';
    if (isWarPeriod) {
      const projVal = clan.projectedFame != null ? fmtNum(Math.round(clan.projectedFame)) : '—';
      const rankKey = `warGroupRank${clan.projectedRank}`;
      const projRankLabel = clan.projectedRank ? ` <span class="war-group-proj-rank">(${t(rankKey) || clan.projectedRank})</span>` : '';
      projectionHtml = `<td class="war-group-projection">${projVal}${projRankLabel}</td>`;
    }

    return `<tr class="war-group-row${isOwn ? ' war-group-own' : ''}">
      <td class="war-group-rank-cell">${rankBadge}</td>
      <td class="war-group-name">${nameHtml}</td>
      <td class="war-group-trophies">${trophiesVal}</td>
      <td class="war-group-prev-war">${prevWarVal}</td>
      <td class="war-group-last-war">${lastWarVal}</td>
      ${decksNowHtml}
      ${avgPtsHtml}
      ${projectionHtml}
    </tr>`;
  }).join('');

  const headers = `
    <thead>
      <tr>
        <th class="war-group-rank-cell"></th>
        <th class="war-group-name">${t('labelName')}</th>
        <th class="war-group-trophies">${t('labelWarTrophies')}</th>
        <th class="war-group-prev-war">${t('warGroupPrevWar')}</th>
        <th class="war-group-last-war">${t('warGroupLastWar')}</th>
        ${isWarPeriod ? `<th class="war-group-decks-now">${t('warGroupDecksToday')}</th>` : ''}
        ${isWarPeriod ? `<th class="war-group-avg-pts">${t('warGroupPtsPerDeck')}</th>` : ''}
        ${isWarPeriod ? `<th class="war-group-projection">${t('warGroupProjection')}</th>` : ''}
      </tr>
    </thead>
  `;

  tbody.innerHTML = `${headers}<tbody>${rows}</tbody>`;
}
