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

  // Masquer la card si pas de données
  if (!Array.isArray(raceGroup) || raceGroup.length === 0) {
    container.classList.add('hidden');
    return;
  }
  container.classList.remove('hidden');

  // Titre
  const titleEl = container.querySelector('.card-title');
  if (titleEl) titleEl.textContent = `${t('warGroupTitle')}`;

  // Trier : last war fame décroissant
  const sorted = [...raceGroup].sort((a, b) => (b.lastWarFame ?? 0) - (a.lastWarFame ?? 0));

  const tbody = container.querySelector('.war-group-list');
  if (!tbody) return;

  const rows = sorted.map((clan, idx) => {
    const cleanTag = (clan.tag ?? '').replace('#', '').toUpperCase();
    const isOwn = cleanTag === ownTag;
    const url = trustUrl(cleanTag);
    const isFamilyMember = FAMILY_TAGS.has(cleanTag);

    const nameHtml = `<a href="${url}" class="${isFamilyMember ? 'war-group-family-link' : 'war-group-external-link'}">${clan.name ?? clan.tag}</a>`;

    const displayRank = clan.rank ?? (idx + 1);
    const rankBadge = `<span class="war-group-rank">#${displayRank}</span>`;

    const membersVal = clan.members != null ? `${clan.members}/50` : '—';
    const trophiesVal = clan.clanWarTrophies != null ? `🏆 ${fmtNum(clan.clanWarTrophies)}` : '—';
    const prevWarVal = clan.prevWarFame != null ? `${fmtNum(clan.prevWarFame)}` : '—';
    
    let trendIcon = '';
    if (clan.lastWarFame != null && clan.prevWarFame != null) {
      if (clan.lastWarFame > clan.prevWarFame) trendIcon = ' 📈';
      else if (clan.lastWarFame < clan.prevWarFame) trendIcon = ' 📉';
    }
    const lastWarVal = clan.lastWarFame != null ? `${fmtNum(clan.lastWarFame)}${trendIcon}` : '—';

    return `<tr class="war-group-row${isOwn ? ' war-group-own' : ''}">
      <td class="war-group-rank-cell">${rankBadge}</td>
      <td class="war-group-name">${nameHtml}</td>
      <td class="war-group-members">${membersVal}</td>
      <td class="war-group-trophies">${trophiesVal}</td>
      <td class="war-group-prev-war">${prevWarVal}</td>
      <td class="war-group-last-war">${lastWarVal}</td>
    </tr>`;
  }).join('');

  tbody.innerHTML = `
    <thead>
      <tr>
        <th class="war-group-rank-cell"></th>
        <th class="war-group-name">${t('labelName')}</th>
        <th class="war-group-members">${t('labelMembers')}</th>
        <th class="war-group-trophies">${t('labelWarTrophies')}</th>
        <th class="war-group-prev-war">${t('warGroupPrevWar')}</th>
        <th class="war-group-last-war">${t('warGroupLastWar')}</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>`;
}
