// Debug : détail du matchup du dernier combat d'un joueur
import "dotenv/config";
import { fetchBattleLog } from "../backend/services/clashApi.js";
import { computeDeckMatchupDetail } from "../backend/services/battleLogUtils.js";
const tag = process.argv[2] ?? "#VYV82Q0G2";
const idx = Number(process.argv[3] ?? 0);
const log = await fetchBattleLog(tag);
const b = log[idx];
console.log(b.type, b.battleTime, b.opponent[0].name);
console.log(b.team[0].cards.map((c) => `${c.name} ${c.level}/${c.maxLevel} ${c.rarity}`).join(" | "));
console.log(b.opponent[0].cards.map((c) => `${c.name} ${c.level}/${c.maxLevel} ${c.rarity}`).join(" | "));
const d = await computeDeckMatchupDetail(b);
console.log(d.matchup, d.breakdown);
for (const k of ["layer1", "layer2", "layer3", "layer4"]) console.log(`--${k}\n${d.reasons[k]}`);
