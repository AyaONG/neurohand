import { afterEach, expect, it, vi } from 'vitest';
import { configureReportOwner, pdfButton } from '../src/report-actions';
import { createSession } from '../src/session';
const mocked=vi.hoisted(()=>({create:vi.fn()}));
vi.mock('../src/report-pdf',()=>({createReportPdf:mocked.create,reportFilename:()=> 'NeuroHand_Report_2026-09-30.pdf'}));
afterEach(()=>{vi.unstubAllGlobals();configureReportOwner(()=>()=>true);});
it('captures the owner before asynchronous PDF work and discards stale A → B → A completions',async()=>{
 let generation=1;configureReportOwner(()=>{const n=generation;return()=>n===generation;});
 const click=vi.fn();
 class Node { disabled=false; textContent=''; children:Node[]=[]; handler=async()=>{};setAttribute(){};append(...n:Node[]){this.children.push(...n);}addEventListener(_s:string,f:()=>Promise<void>){this.handler=f;}click=click; }
 vi.stubGlobal('document',{createElement:()=>new Node()});
 const pending=Promise.withResolvers<Uint8Array>();mocked.create.mockReturnValue(pending.promise);
 const node=pdfButton([createSession()]) as unknown as Node;
 const done=node.children[0].handler();await vi.waitFor(()=>expect(mocked.create).toHaveBeenCalled());
 generation=3;pending.resolve(new Uint8Array([1,2,3]));await done;expect(click).not.toHaveBeenCalled();
});
