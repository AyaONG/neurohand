import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { HandGeometry } from '../src/geometry';
import { readPinch, calibrate } from '../src/validator';
import { createSession } from '../src/session';
import { withFlow, closeGoal } from '../src/flow';
import { createProgram, beginProgram, stepProgram, programInstruction, guidedTarget } from '../src/program';
import { holdGoalIndex } from '../src/hold-target';
import { sceneModel } from '../src/scenes';
import { parseSession } from '../src/storage';
const g=(name:string)=>HandGeometry.create(JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`,import.meta.url),'utf8')),640,480)!;
const open=g('grip_open'), fist=g('grip_closed');const wall=(n:number)=>new Date(1790726400000+n).toISOString();
function harness(last=false){
 const s=withFlow(createSession('hold-test',wall(0)));s.currentExercise='hold';const f=s.attempts!.flow!;f.cursor=last?12:10;
 f.goals.forEach((goal,i)=>{if(i<f.cursor){goal.reason='manual_skip';goal.endedAt=wall(0);}});
 let p=beginProgram(createProgram(s)),time=0;p.calibration=calibrate([open]);
 function frame(hand:HandGeometry|null=open,inside=true,dt=20){time+=dt;const target=guidedTarget(640,480,holdGoalIndex(p.session));p=stepProgram(p,{timestampMs:time,wallTime:wall(time),geometry:hand,fullHand:!!hand,pinch:hand?readPinch(hand,time):null,palm:inside?target:{x:0,y:0},target});expect(parseSession(p.session)).not.toBeNull();return p;}
 function run(ms:number,hand:HandGeometry|null=open,inside=true){for(let i=0;i<ms;i+=20)frame(hand,inside);return p;}
 run(1400,open,false);
 return {frame,run,get p(){return p;},set p(v){p=v;}};
}
it('actual hold controller preserves short edge noise without crediting it; sustained exit and closed fist reset',()=>{
 const h=harness();h.run(800);const before=h.p.hold.holdMs;expect(before).toBeGreaterThan(500);
 h.run(80,open,false);expect(h.p.hold.holdMs).toBe(before);h.frame();expect(h.p.hold.holdMs).toBe(before);h.frame();expect(h.p.hold.holdMs).toBe(before+20);
 h.run(200,open,false);expect(h.p.hold.holdMs).toBe(0);expect(h.p.holdResets.at(-1)?.reason).toBe('outside');
 h.run(300,open,false);h.run(600);h.frame(fist);expect(h.p.hold.holdMs).toBe(0);expect(h.p.holdResets.at(-1)?.reason).toBe('openness');
 expect(JSON.stringify(h.p.session)).not.toContain('holdResets');
});
it('short tracking noise freezes; sustained tracking loss and a long frame gap never finish a hold',()=>{
 const h=harness();h.run(800);const before=h.p.hold.holdMs;h.run(80,null);h.frame();expect(h.p.hold.holdMs).toBe(before);
 h.run(200,null);expect(h.p.hold.holdMs).toBe(0);expect(h.p.holdResets.at(-1)?.reason).toBe('tracking');
 h.run(300,open,false);h.run(500);h.frame(open,true,1000);expect(h.p.hold.holdMs).toBe(0);expect(h.p.holdResets.at(-1)?.reason).toBe('frame_gap');
 expect(h.p.session.exercises.hold.reps).toBe(0);
});
it('repeated short noise has a finite cumulative budget, not a renewable allowance',()=>{
 const h=harness();h.run(400);
 for(let i=0;i<4;i++){h.run(80,open,false);h.run(40);}
 expect(h.p.holdResets.some(e=>e.reason==='outside')).toBe(true);expect(h.p.session.exercises.hold.reps).toBe(0);
});
it('last confirmed goal finishes once after feedback/countdown without requiring another open gesture',()=>{
 const h=harness(true);h.run(2200);expect(h.p.session.attempts!.records.filter(a=>a.outcome==='completed')).toHaveLength(1);
 expect(h.p.phase).toBe('transition');h.run(4200,fist);expect(h.p.phase).toBe('summary');
 const final=h.p;h.run(4000,fist);expect(h.p).toBe(final);expect(h.p.session.exercises.hold.reps).toBe(1);
 expect(h.p.session.attempts!.records[0].rulesVersion).toBe('hold-stable-v2');
});
it('drawn and measured target use goal index after skips, independent of completed count',()=>{
 const h=harness(true);expect(holdGoalIndex(h.p.session)).toBe(2);expect(h.p.session.exercises.hold.reps).toBe(0);
 const targets=[0,1,2].map(i=>guidedTarget(640,480,i));
 const model=sceneModel(640,480,{exercise:'hold',holdGoalIndex:2,holdCompleted:[],completed:0,timestampMs:0,reducedMotion:true,pinchPoint:null,palm:null,openPalm:true,openness:1,targets,holdProgress:0,flight:null});
 expect(model.targets.find(t=>t.active)).toMatchObject(targets[2]);expect(model.targets.filter(t=>t.completed)).toHaveLength(0);
});
it.each([[999,3],[1000,2],[1999,2],[2000,1],[2999,1],[3000,null]] as const)('countdown at %i ms has no extra one', (elapsed,digit)=>{
 const s=closeGoal(withFlow(createSession('count',wall(0))),'manual_skip',wall(0));
 let p=createProgram(s);p={...p,phase:'transition',lastTimestamp:10,lastValidTimestamp:10,calibration:calibrate([open])};
 p=stepProgram(p,{timestampMs:10+elapsed,wallTime:wall(10+elapsed),geometry:open,fullHand:true,pinch:readPinch(open,10+elapsed),palm:null,target:null});
 if(digit)expect(programInstruction(p,elapsed)).toMatch(new RegExp(` · ${digit}$`));
 else {expect(p.phase).toBe('preparing');expect(programInstruction(p,elapsed)).toBe('Покажи раскрытую ладонь');}
});

it('stationary presence after rearming cannot earn a hold without an observed movement',()=>{
 const h=harness();h.p={...h.p,attemptObserver:{baseline:null,candidateSince:null,candidateWall:null,returnSince:null,samples:[],waitingOpen:true}};
 h.run(3200);expect(h.p.session.exercises.hold.reps).toBe(0);expect(h.p.session.attempts!.records).toHaveLength(0);
 h.run(400,open,false);h.run(2400);expect(h.p.session.exercises.hold.reps).toBe(1);
});
