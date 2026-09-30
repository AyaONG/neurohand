import type { Session } from './session';
import type { ReportOptions } from './report-model';
let captureOwner: () => () => boolean = () => () => true;
export function configureReportOwner(capture: () => () => boolean) { captureOwner=capture; }
export function pdfButton(sessions: Session[], options: ReportOptions = {}): HTMLElement {
 const wrapper=document.createElement('div'), button=document.createElement('button'), notice=document.createElement('p');
 button.textContent='Скачать отчёт PDF'; notice.setAttribute('role','status');
 const valid=captureOwner();
 button.addEventListener('click',async()=>{
  if(button.disabled || !valid())return;
  const snapshot=structuredClone(sessions);button.disabled=true;notice.textContent='Готовим отчёт…';
  try {
   const {createReportPdf,reportFilename}=await import('./report-pdf');
   if(!valid())return;
   const bytes=await createReportPdf(snapshot,options);
   if(!valid())return;
   const blob=new Blob([new Uint8Array(bytes)],{type:'application/pdf'}), url=URL.createObjectURL(blob), link=document.createElement('a');
   link.href=url;link.download=reportFilename();link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
   notice.textContent='Отчёт PDF скачан. Для переноса истории используй резервную копию JSON.';
  } catch { if(valid())notice.textContent='Не удалось создать PDF. История сохранена; попробуй ещё раз.'; }
  finally {if(valid())button.disabled=false;}
 });
 wrapper.append(button,notice);return wrapper;
}
