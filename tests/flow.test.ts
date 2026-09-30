import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { HandGeometry } from '../src/geometry';
import { readPinch } from '../src/validator';
import { createOppositionSession, createSession } from '../src/session';
import { withFlow, closeGoal } from '../src/flow';
import { beginProgram, createProgram, stepProgram, pauseProgram } from '../src/program';
import { parseSession, ProgressStore } from '../src/storage';
import { routeSession, nextRouteSession } from '../src/route';
const base = JSON.parse(readFileSync(new URL('./fixtures/grip_open.json', import.meta.url), 'utf8'));
const wall = (n: number) => new Date(Date.parse('2026-09-30T00:00:00Z') + n).toISOString();
function geometry(distance?: number, ambiguous = false) {
  const points = base.map((p: any) => ({ ...p, z: 0 }));
  if (distance !== undefined) points[4] = { x: points[12].x, y: points[12].y + distance * 100 / 480, z: 0 };
  if (ambiguous) points[8] = { ...points[12] };
  return HandGeometry.create(points,640,480)!;
}
function harness(automatic = true, basic = false) {
  let p = beginProgram(createProgram(withFlow(basic ? createSession('s',wall(0)) : createOppositionSession([12], 's',wall(0)), automatic))), t = 0;
  function run(ms: number, g: HandGeometry | null = geometry()) {
    for (let i=0; i<ms; i+=20) {
      t+=20; p=stepProgram(p,{ timestampMs:t, wallTime:wall(t), fullHand:!!g, geometry:g, pinch:g ? readPinch(g,t):null,palm:null,target:null });
      expect(parseSession(p.session), `parse at ${t}`).not.toBeNull();
    }
    return p;
  }
  return { run, get p(){ return p; }, set p(v){p=v;}, get time(){return t;} };
}
it('success keeps feedback interval and requires reopening; final route is idempotent', () => {
  const h=harness();h.run(400);h.run(500,geometry(.1));
  expect(h.p.phase).toBe('transition');expect(h.p.session.exercises.opposition!.reps).toBe(1);
  h.run(6000,geometry(.1));expect(h.p.session.attempts!.records).toHaveLength(1);
  h.run(500);h.run(500,geometry(.1));expect(h.p.phase).toBe('transition');
  h.run(4500);expect(h.p.phase).toBe('summary');expect(h.p.session.status).toBe('completed');
  const final=h.p;h.run(1000);expect(h.p).toBe(final);
});
it('two observed failed movements close one goal without a completed or fake skip; survives reload', () => {
  const h=harness();h.run(400);
  for(let i=0;i<2;i++){h.run(500,geometry(.7));h.run(700);}
  expect(h.p.session.attempts!.records.map(a=>a.outcome)).toEqual(['partial','partial']);
  expect(h.p.session.attempts!.flow!.goals[0].reason).toBe('attempt_limit');
  expect(h.p.session.exercises.opposition!.reps).toBe(0);
  const values=new Map<string,string>();const mem={getItem:(k:string)=>values.get(k)??null,setItem:(k:string,v:string)=>{values.set(k,v);}};
  new ProgressStore(() => mem).save(h.p.session,h.time,true);
  h.p=beginProgram(createProgram(new ProgressStore(() => mem).data.current!));h.run(3500);
  expect(h.p.session.opposition!.cursor).toBe(1);expect(h.p.session.attempts!.records).toHaveLength(2);
});
it('partial then success uses two evaluated attempts and a single successful goal', () => {
  const h=harness();h.run(400);h.run(500,geometry(.7));h.run(700);h.run(500,geometry(.1));
  expect(h.p.session.attempts!.records.map(a=>a.outcome)).toEqual(['partial','completed']);
  expect(h.p.session.attempts!.flow!.goals[0].reason).toBe('success');
});
it('goal budget includes waiting after readiness, excludes missing frames and manual pauses, creates no attempt', () => {
  const h=harness();h.run(500);h.run(1000);const before=h.p.session.attempts!.flow!.goals[0].usableMs;
  h.run(10000,null);expect(h.p.session.attempts!.flow!.goals[0].usableMs).toBe(before);
  h.p=pauseProgram(h.p,'manual',wall(h.time));h.run(10000);expect(h.p.phase).toBe('paused');
  expect(h.p.session.attempts!.flow!.goals[0].usableMs).toBe(before);
  h.p=beginProgram(h.p);h.run(21000);
  expect(h.p.session.attempts!.flow!.goals[0].reason).toBe('time_limit');expect(h.p.session.attempts!.records).toHaveLength(0);
});
it('two genuine unscorable starts close a goal, repeated technical goals require continuous recovery', () => {
  const h=harness();h.run(400);
  for(let goal=0;goal<2;goal++) {
    for(let i=0;i<2;i++){h.run(400,geometry(.7));h.run(700,geometry(.1,true));h.run(600);}
    expect(h.p.session.attempts!.flow!.goals[goal].reason).toBe('unscorable_limit');
    if(goal===0) h.run(3500);
  }
  expect(h.p.session.attempts!.flow!.visibilityHelp).toBe(true);
  h.run(10000,null);expect(h.p.phase).toBe('transition');expect(h.p.session.status).toBe('in_progress');
  expect(h.p.session.attempts!.records).toHaveLength(4);
  h.run(2000);h.run(1000,null);h.run(2000);expect(h.p.session.status).toBe('in_progress');
  h.run(1200);expect(h.p.phase).toBe('summary');
});
it('manual choice retains unlimited retries and time',()=>{
 const h=harness(false);h.run(400);for(let i=0;i<3;i++){h.run(500,geometry(.7));h.run(700);}h.run(25000);
 expect(h.p.session.attempts!.flow!.goals[0].reason).toBeNull();expect(h.p.session.opposition!.cursor).toBe(0);
});
it('finite basic goals advance across exercises without inventing successful reps',()=>{
 const h=harness(true,true);h.run(3400);
 for(let i=0;i<13;i++){h.run(20500);h.run(4500);}
 expect(h.p.session.status).toBe('completed');expect(h.p.session.exercises.hold.reps).toBe(0);
 expect(h.p.session.attempts!.records).toHaveLength(0);
});
it('route IDs are durable, next block unique and no legacy links inferred',()=>{
 let s=routeSession({trainingRunId:'route',index:0,blocks:[{id:'one',mode:'ring'},{id:'two',mode:'opposition'}],pairs:[12],ringTip:8},true,'left',wall(0));
 s=closeGoal(s,'manual_skip',wall(10));s.attempts!.flow!.transitionMs=3000;s={...s,status:'completed',paused:true,endedAt:wall(4000)};
 expect(parseSession(s)).not.toBeNull();const next=nextRouteSession(s,[s],wall(4100))!;
 expect(next.id).toBe('two');expect(next.attempts!.route!.trainingRunId).toBe('route');expect(parseSession(next)).not.toBeNull();
 expect(nextRouteSession(s,[s,{...next,status:'stopped',endedAt:wall(5000)}])).toBeNull();
 expect(nextRouteSession({...createSession(),status:'completed'},[])).toBeNull();
});

it('time limit with an active partial preserves observed movement; pause requires new readiness without charging preparation',()=>{
 const h=harness();h.run(400);h.run(400,geometry(.7));
 expect(h.p.session.attempts!.active).not.toBeNull();h.p.session.attempts!.flow!.goals[0].usableMs=19980;
 h.run(20,geometry(.7));expect(h.p.session.attempts!.flow!.goals[0].reason).toBe('time_limit');
 expect(h.p.session.attempts!.records[0]).toMatchObject({outcome:'partial',endReason:'timeout'});
 const other=harness();other.run(400);other.run(500);const ms=other.p.session.attempts!.flow!.goals[0].usableMs;
 other.p=beginProgram(pauseProgram(other.p,'visibility',wall(other.time)));other.run(200);
 expect(other.p.session.attempts!.flow!.goals[0].usableMs).toBe(ms);
});

it('reserves 900 ms for success followed by a full separate three-second transition',()=>{
 const h=harness();h.run(400);h.run(500,geometry(.1));
 h.p.session.attempts!.flow!.transitionMs=900;h.p.transitionClock=null;
 h.run(2980);expect(h.p.session.opposition!.cursor).toBe(0);
 h.run(20);expect(h.p.session.opposition!.cursor).toBe(1);
});
