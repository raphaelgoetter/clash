import { fetchPlayer, fetchBattleLog, fetchCurrentRace, fetchClanMembers } from '../backend/services/clashApi.js';
import { buildFamilyWarHistory, findRecentFamilyTransfer, mergeWarHistoryWithTransfer } from '../backend/services/analysisService.js';

(async () => {
  const tag = '#88QP9CJU';
  const player = await fetchPlayer(tag);
  const battleLog = await fetchBattleLog(tag);
  const members = await fetchClanMembers(player.clan.tag);
  const lastSeen = members.find((m) => m.tag === tag)?.lastSeen;
  console.log('player', player.name, player.clan.tag, 'lastSeen', lastSeen);

  const currentRace = await fetchCurrentRace(player.clan.tag);
  const warHistory = await buildFamilyWarHistory(player.tag, player.clan.tag, currentRace, battleLog);
  console.log('warHistory weeks', warHistory?.weeks?.length, 'streak', warHistory?.streakInCurrentClan, 'completed', warHistory?.completedParticipation);

  const prevWeeks = warHistory.weeks.filter((w) => !w.isCurrent);
  const hasFullWeek = prevWeeks.some((w) => (w.decksUsed ?? 0) >= 16);
  const oldRule = warHistory.streakInCurrentClan >= 2 && warHistory.completedParticipation >= 2;
  const hasEnoughHistory = hasFullWeek || oldRule;
  console.log('hasFullWeek', hasFullWeek, 'oldRule', oldRule, 'hasEnoughHistory', hasEnoughHistory);

  const transfer = await findRecentFamilyTransfer(player.tag, player.clan.tag);
  console.log('transfer candidate', transfer);
  if (transfer && !hasEnoughHistory && transfer.transferWeek) {
    const merged = mergeWarHistoryWithTransfer(warHistory, transfer.transferWeek, transfer.fromClanTag);
    console.log('merged weeks', merged.weeks.length, 'merged.transferFromClan', merged.transferFromClan);
  }
})().catch((e) => { console.error('ERR', e); process.exit(1); });
