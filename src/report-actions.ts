import type { Session } from './session';
import type { ReportOptions } from './report-model';
let captureOwner: () => () => boolean = () => () => true;
export function configureReportOwner(capture: () => () => boolean) { captureOwner=capture; }
export function pdfButton(sessions: Session[] | (() => Session[]), options: ReportOptions = {}): HTMLElement {
 const wrapper=document.createElement('div'), button=document.createElement('button'), notice=document.createElement('p');
 wrapper.className='pdf-action';
 button.textContent='Скачать отчёт PDF'; notice.setAttribute('role','status');
 notice.textContent=options.filterLabel ?? 'Показанное занятие';
 const valid=captureOwner();
 button.addEventListener('click',async()=>{
  if(button.disabled || !valid())return;
  const snapshot=structuredClone(typeof sessions === 'function' ? sessions() : sessions);
  if(!snapshot.length){notice.textContent='Занятий в этой выборке пока нет. Выбери другой период или закончи занятие.';return;}
  button.disabled=true;notice.textContent='Готовим отчёт…';
  try {
   const {createReportPdf,reportFilename}=await import('./report-pdf');
   if(!valid())return;
   const bytes=await createReportPdf(snapshot,options);
   if(!valid())return;
   if(new TextDecoder().decode(bytes.slice(0,5)) !== '%PDF-') throw Error('invalid PDF');
   const blob=new Blob([new Uint8Array(bytes)],{type:'application/pdf'}), url=URL.createObjectURL(blob), link=document.createElement('a');
   link.href=url;link.download=reportFilename();
   document.body?.append(link);link.click();link.remove?.();setTimeout(()=>URL.revokeObjectURL(url),60000);
   notice.textContent='Отчёт PDF подготовлен для скачивания. Для переноса истории используй резервную копию JSON.';
  } catch { if(valid())notice.textContent='Не удалось создать PDF. История сохранена; попробуй ещё раз.'; }
  finally {if(valid())button.disabled=false;}
 });
 wrapper.append(button,notice);return wrapper;
}
