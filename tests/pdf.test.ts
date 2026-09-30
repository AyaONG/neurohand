import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { createReportPdf, reportFilename } from '../src/report-pdf';
import { reportLines } from '../src/report-model';
import { createOppositionSession, createRingSession, createSession } from '../src/session';
import { withFlow } from '../src/flow';
import { ALL_PAIR_KEYS, pairOf, pairRules, settleOpposition } from '../src/opposition';
import { settleRing } from '../src/ring';
import { goalLink } from '../src/goals';
import { parseSession } from '../src/storage';
import { filterHistory } from '../src/progress';
import type { Attempt } from '../src/attempts';
const wall = (t:number)=>new Date(Date.parse('2026-09-30T10:00:00Z')+t).toISOString();
/** Invented demonstration data only. Never imports user exports or reads localStorage/env. */
function syntheticSessions() {
 let s=withFlow(createOppositionSession([...ALL_PAIR_KEYS],'synthetic-pairs',wall(0),()=>.5));
 for(let i=0;i<20;i++) {
  s.opposition!.cursor=i;s.attempts!.flow!.cursor=i;
  const key=s.opposition!.sequence[i], rule=pairRules(key);
  const outcome = i%4===0 ? 'completed' : i%4===1 ? 'partial' : i%4===2 ? 'unscorable' : 'incomplete';
  const a: Attempt={attemptId:`synthetic-${i}`,...goalLink(s),exerciseId:'opposition',protocolVersion:s.protocolId,recognizerVersion:s.recognitionVersion,hand:s.hand,rulesVersion:rule.version,
   settings:{target:20,holdTargetMs:2000,targetRadiusRatio:.12,maxActiveMs:10000,pairTip:key,pair:pairOf(key),pairRule:rule.version,sequenceIndex:i,partialRatio:.2},
   startedAt:wall(i*5000),lastObservedAt:wall(i*5000+1800),endedAt:wall(i*5000+1800),outcome,endReason:outcome==='completed'?'confirmed':outcome==='unscorable'?'tracking':'returned',
   activeMs:1800,validTrackingMs:1800,interruptions:{count:outcome==='unscorable'?1:0,durationMs:outcome==='unscorable'?600:0},
   metrics:{kind:'closure',startDistance:1,successDistance:rule.close,bestDistance:outcome==='completed'?rule.close:.6,progress:outcome==='completed'?1:.4}};
  s.attempts!.records.push(a);
  s.attempts!.flow!.goals[i]={goalId:a.goalId!,usableMs:20000,ready:true,reason:outcome==='completed'?'success':'time_limit',endedAt:a.endedAt};
 }
 s=settleOpposition(s);s={...s,status:'completed',paused:true,endedAt:wall(110000)};s.attempts!.flow!.transitionMs=3000;
 let ring=withFlow(createRingSession(16,'synthetic-ring',wall(120000)));
 ring.attempts!.records.push({attemptId:'synthetic-ring-attempt',...goalLink(ring),exerciseId:'ring',protocolVersion:ring.protocolId,recognizerVersion:ring.recognitionVersion,hand:ring.hand,rulesVersion:'ring-v1',settings:{target:1,holdTargetMs:2000,targetRadiusRatio:.12,maxActiveMs:15000,ring:ring.ring},startedAt:wall(120000),lastObservedAt:wall(128000),endedAt:wall(128000),outcome:'partial',endReason:'manual',activeMs:8000,validTrackingMs:8000,interruptions:{count:0,durationMs:0},metrics:{kind:'ring',marks:8,returned:false,pathLength:4.3,progress:8/12}});
 ring=settleRing(ring);ring={...ring,status:'stopped',paused:true,endedAt:wall(130000)};
 const legacy={...createSession('synthetic-legacy',wall(140000)),attempts:null,status:'stopped' as const,endedAt:wall(150000),paused:true};
 for(const row of [s,ring,legacy])expect(parseSession(row)).not.toBeNull();
 return [s,ring,legacy];
}
const font = new Uint8Array(readFileSync(new URL('../public/fonts/NotoSans-Regular.ttf',import.meta.url)));
it('creates a real multi-page Cyrillic PDF using the same local generator as the app',async()=>{
 const rows=syntheticSessions();const options={synthetic:true,timeZone:'Asia/Almaty',generatedAt:new Date(wall(160000)),filterLabel:'Изолированный демонстрационный пример: пары, неполное кольцо и старая запись. Все числа вымышлены.'};
 const bytes=await createReportPdf(rows,options,font);expect(new TextDecoder().decode(bytes.slice(0,5))).toBe('%PDF-');
 expect((await PDFDocument.load(bytes)).getPageCount()).toBeGreaterThanOrEqual(4);
 const text=reportLines(rows,options).map(l=>l.text).join('\n');
 expect(text).toContain('8 / 12');expect(text).toContain('нет данных');expect(text).not.toMatch(/synthetic-pairs|attemptId|goalId|unscorable|landmarks/);
 expect(reportFilename(new Date(2026,8,30))).toBe('NeuroHand_Report_2026-09-30.pdf');
 if(process.env.NEUROHAND_PDF_SAMPLE==='1'){mkdirSync('output/pdf',{recursive:true});writeFileSync('output/pdf/NeuroHand_Report_2026-09-30.pdf',bytes);}
});
it('handles empty history and honors selected dates and exercise without pretending unknown attempts are zero',async()=>{
 const rows=syntheticSessions();const filtered=filterHistory(rows,{exercise:'ring',hand:'all',seriesId:'',from:'2026-09-30',to:'2026-09-30'});
 expect(filtered).toHaveLength(1);expect(reportLines(filtered,{exercise:'ring'}).map(l=>l.text).join(' ')).not.toContain('Большой');
 expect(filterHistory(rows,{exercise:'all',hand:'all',seriesId:'',from:'2027-01-01'})).toHaveLength(0);
 const bytes=await createReportPdf([],{},font);expect((await PDFDocument.load(bytes)).getPageCount()).toBe(1);
 expect(reportLines([rows[2]]).map(l=>l.text).join(' ')).toContain('Оценённые попытки, частичные результаты, сбои и пропуски: нет данных');
});
