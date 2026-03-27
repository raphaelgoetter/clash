import { fetchPlayer, fetchBattleLog, fetchRaceLog, fetchCurrentRace, fetchClanMembers } from '../backend/services/clashApi.js';
import { analyzePlayer, buildFamilyWarHistory, computeWarScore, computeWarReliabilityFallback, findRecentFamilyTransfer, mergeWarHistoryWithTransfer } from '../backend/services/analysisService.js';
import { expandDuelRounds, filterWarBattles, isWarWin } from '../backend/services/analysisService.js';

(async ()=>{
  try {
    const tag = '#88QP9CJU';
    const player = await fetchPlayer(tag);
    const battleLog=await fetchBattleLog(tag);
    const members=await fetchClanMembers(player.clan.tag);
    const lastSeen=members.find(m=>m.tag===tag)?.lastSeen;

    const analysis = analyzePlayer(player, battleLog || [], lastSeen, false);
    console.log('analysis baseline created');
    const [raceLog, currentRace] = await Promise.all([fetchRaceLog(player.clan.tag), fetchCurrentRace(player.clan.tag).catch(()=>null)]);
    console.log('raceLog length', raceLog?.length, 'currentRace', !!currentRace);
    let analysisWarHistory = await buildFamilyWarHistory(player.tag, player.clan.tag, currentRace, battleLog);
    console.log('initial warHistory', analysisWarHistory?.weeks?.length, 'streak', analysisWarHistory?.streakInCurrentClan);

    const rawWarLog = expandDuelRounds(filterWarBattles(battleLog));
    const gdcWins = rawWarLog.filter(isWarWin).length;
    const warWinRate = rawWarLog.length>=10 ? gdcWins/rawWarLog.length : null;

    let prevWeeks = analysisWarHistory.weeks.filter((w)=>!w.isCurrent);
    let hasFullWeek = prevWeeks.some((w)=>(w.decksUsed??0)>=16);
    const oldRule = analysisWarHistory.streakInCurrentClan>=2 && analysisWarHistory.completedParticipation>=2;
    let hasEnoughHistory = hasFullWeek||oldRule;
    console.log('hasFullWeek', hasFullWeek, 'oldRule', oldRule, 'hasEnoughHistory', hasEnoughHistory);

    const transfer = await findRecentFamilyTransfer(player.tag, player.clan.tag);
    console.log('transfer candidate', transfer);
    if (transfer) {
      if (!hasEnoughHistory && transfer.transferWeek) {
        analysisWarHistory=mergeWarHistoryWithTransfer(analysisWarHistory, transfer.transferWeek, transfer.fromClanTag);
        prevWeeks=analysisWarHistory.weeks.filter((w)=>!w.isCurrent);
        hasFullWeek=prevWeeks.some((w)=>(w.decksUsed??0)>=16);
        hasEnoughHistory=hasFullWeek||oldRule;
        console.log('after merge hasEnoughHistory', hasEnoughHistory);
      }
      analysisWarHistory.isFamilyTransfer=true;
      analysisWarHistory.transferFromClan=transfer.fromClanTag;
      analysisWarHistory.transferWeek=transfer.transferWeek;
      console.log('annotated transfer');
    }

    let analysisWarScore;
    const effectiveWinRate = analysisWarHistory.historicalWinRate ?? warWinRate;
    if (hasEnoughHistory) {
      analysisWarScore = computeWarScore(player, analysisWarHistory, effectiveWinRate, lastSeen, false);
    } else {
      analysisWarScore = computeWarReliabilityFallback(player, rawWarLog, null, lastSeen, false, currentRace?.clan?.participants?.find(p=>p.tag===player.tag)?.decksUsed??0);
    }
    console.log('analysisWarHistory', {isFamilyTransfer:analysisWarHistory.isFamilyTransfer,transferFromClan:analysisWarHistory.transferFromClan,transferWeek:analysisWarHistory.transferWeek?.label});
    console.log('analysisWarScore pct', analysisWarScore.pct, analysisWarScore.verdict);
  } catch (err) {
    console.error('error at getPlayerAnalysis style', err);
  }
})();
