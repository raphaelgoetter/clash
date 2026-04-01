// analysisService.js — Barrel re-exportant tous les sous-modules.
//
// Ce fichier est desormais un point d'entree unique pour la retrocompatibilite.
// Tous les importeurs existants (clan.js, interactions.js, score_estimate.js,
// tests...) continuent de fonctionner sans modification.
//
// Les implementations vivent dans :
//   - dateUtils.js      : helpers dates, timezone, warDayKey, parseClashDate
//   - battleLogUtils.js : filtrage/categorisation/expansion du battle log
//   - warScoring.js     : computeWarScore, computeWarReliabilityFallback
//   - warHistory.js     : buildWarHistory, buildFamilyWarHistory
//   - playerAnalysis.js : analyzePlayer, getPlayerAnalysis, computeIsNewPlayer

export * from './dateUtils.js';
export * from './battleLogUtils.js';
export * from './warScoring.js';
export * from './warHistory.js';
export * from './playerAnalysis.js';
