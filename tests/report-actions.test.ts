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

it('the download handler generates current data as a real PDF, attaches the link and uses application/pdf',async()=>{
 const { readFileSync }=await import('node:fs');const actual=await vi.importActual<typeof import('../src/report-pdf')>('../src/report-pdf');
 const font=new Uint8Array(readFileSync(new URL('../public/fonts/NotoSans-Regular.ttf',import.meta.url)));
 mocked.create.mockImplementation((s,o)=>actual.createReportPdf(s,o,font));
 const nodes:any[]=[];const attached:any[]=[];let downloaded:any;let output:Blob|undefined;
 class Node {disabled=false;textContent='';children:Node[]=[];href='';download='';handler=async()=>{};setAttribute(){};append(...n:Node[]){this.children.push(...n);}addEventListener(_s:string,f:()=>Promise<void>){this.handler=f;}click(){downloaded=this;expect(attached).toContain(this);}remove(){};}
 vi.stubGlobal('document',{body:{append:(n:any)=>attached.push(n)},createElement:()=>{const n=new Node();nodes.push(n);return n;}});
 vi.spyOn(URL,'createObjectURL').mockImplementation(blob=>{output=blob as Blob;return 'blob:local-test';});
 const s={...createSession('current-data','2026-10-01T10:00:00Z'),status:'stopped' as const,endedAt:'2026-10-01T10:02:00Z',hand:'left' as const};
 const control=pdfButton(()=>[s],{filterLabel:'Выбранный период'}) as unknown as Node;
 await control.children[0].handler();expect(downloaded.download).toMatch(/\.pdf$/);expect(output!.type).toBe('application/pdf');
 expect(new TextDecoder().decode((await output!.arrayBuffer()).slice(0,5))).toBe('%PDF-');expect(mocked.create.mock.lastCall![0][0]).toMatchObject({id:'current-data',hand:'left'});
 vi.restoreAllMocks();
});
it('empty results and generator errors never fall back to JSON',async()=>{
 mocked.create.mockClear();const click=vi.fn();
 class Node {disabled=false;textContent='';children:Node[]=[];handler=async()=>{};setAttribute(){};append(...n:Node[]){this.children.push(...n);}addEventListener(_s:string,f:()=>Promise<void>){this.handler=f;}click=click;}
 vi.stubGlobal('document',{createElement:()=>new Node()});
 const empty=pdfButton([]) as unknown as Node;await empty.children[0].handler();expect(mocked.create).not.toHaveBeenCalled();expect(empty.children[1].textContent).toContain('пока нет');
 mocked.create.mockRejectedValueOnce(Error('failed'));const control=pdfButton([createSession()]) as unknown as Node;
 await control.children[0].handler();expect(click).not.toHaveBeenCalled();expect(control.children[1].textContent).toContain('Не удалось создать PDF');
});
