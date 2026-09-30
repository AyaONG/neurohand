import { expect, it } from 'vitest';
import { MovementEvents } from '../src/movement-feedback';
import { getFeedback } from '../src/feedback';
import type { Attempt } from '../src/attempts';
// Presentation fixture only: no fabricated records are written to app storage.
const attempt = (id: string, outcome: Attempt['outcome'], exerciseId: Attempt['exerciseId'] = 'opposition') => ({ attemptId:id, outcome, exerciseId, endReason: outcome === 'completed' ? 'confirmed' : 'tracking', metrics:{kind:'closure', progress:1} }) as Attempt;
it.each(['pinch','grip','hold','opposition','ring'] as const)('one completed event for %s; never replayed after reload', exercise => {
 const log = { historyComplete:true,records:[] as Attempt[],active:null };const events=new MovementEvents(log);
 log.records.push(attempt('one','completed',exercise));const e=events.update(log,1000)!;
 expect(e).toMatchObject({completed:true,text:'Выполнено'});
 expect(events.update(log,1010)).toBe(e);
 expect(new MovementEvents(log).update(log,2000)).toBeNull();
 for(const at of [1000,1200,1899]) expect(getFeedback({event:e,exercise,timestampMs:at,visible:true,error:null,phase:'IDLE',success:null,instruction:'Следующее'}).celebrating).toBe(true);
 expect(getFeedback({event:e,exercise,timestampMs:1900,visible:true,error:null,phase:'IDLE',success:null,instruction:'Следующее'}).celebrating).toBe(false);
 expect(getFeedback({event:e,exercise,timestampMs:1050,visible:false,error:null,phase:'IDLE',success:null,instruction:'Следующее'}).text).toContain('Рука не видна');
});
it('full progress, partials, unscorable and skips are not rewards',()=>{
 const events=new MovementEvents(null);const log={historyComplete:true,records:[attempt('partial','partial')],active:null};
 expect(events.update(log,1000)).toMatchObject({completed:false,text:expect.stringContaining('Попытка сохранена')});
 log.records.push(attempt('lost','unscorable'));expect(events.update(log,2000)).toMatchObject({completed:false,text:expect.stringContaining('Не удалось оценить движение')});
 log.records.push(attempt('skip','cancelled'));expect(events.update(log,3000)!.id).toBe('lost');
});
