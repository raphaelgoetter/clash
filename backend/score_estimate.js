import 'dotenv/config';
import {getPlayerAnalysis} from './services/analysisService.js';

function computeFromBreakdown(bd){
  let total=0;
  for(const item of bd){
    switch(item.label){
      case 'War Activity': total += item.score * (12/10); break; // from 10 to 12
      case 'Win Rate (War)': total += item.score * (5/8); break;
      case 'General Activity': total += item.score * (8/5); break;
      default: total += item.score; break;
    }
  }
  return total;
}

(async()=>{
  const tags=['#GV8JYV9GG','#P9JQC00P9'];
  for(const t of tags){
    try{
      const a=await getPlayerAnalysis(t);
      const old=a.reliability.total;
      const newt=computeFromBreakdown(a.reliability.breakdown);
      console.log(t,'old',old,'new approx',newt.toFixed(1),'diff', (newt-old).toFixed(1));
    }catch(e){console.error('err',t,e)}
  }
})();
