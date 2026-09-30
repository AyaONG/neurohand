import { PDFDocument, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { reportLines, type ReportOptions } from './report-model';
import type { Session } from './session';
/** Entirely local generation; fontBytes can be injected by isolated verification. */
export async function createReportPdf(sessions: Session[], options: ReportOptions = {}, fontBytes?: Uint8Array): Promise<Uint8Array> {
  if (!fontBytes) {
    const response = await fetch(`${import.meta.env.BASE_URL}fonts/NotoSans-Regular.ttf`);
    if (!response.ok) throw new Error('Не удалось загрузить шрифт отчёта. Повтори скачивание при подключении к сети.');
    fontBytes = new Uint8Array(await response.arrayBuffer());
  }
  const pdf = await PDFDocument.create(); pdf.registerFontkit(fontkit);
  const font = await pdf.embedFont(fontBytes, { subset: true });
  pdf.setTitle('NeuroHand - отчёт о занятиях'); pdf.setCreator('NeuroHand');
  let page = pdf.addPage([595.28,841.89]), y = 791;
  const margin = 44, width = 507;
  function nextPage() { page = pdf.addPage([595.28,841.89]); y=791; }
  for (const line of reportLines(sessions,options)) {
    const size = line.style === 'title' ? 21 : line.style === 'heading' ? 12 : 10;
    const leading = size * 1.5;
    const text = line.text.replace(/[–—‑]/g,'-').replace(/→/g,'/');
    const words = text.split(/\s+/); const wrapped: string[] = []; let current='';
    for (const word of words) {
      if (font.widthOfTextAtSize(current ? current+' '+word : word,size) <= width) current += (current ? ' ' : '')+word;
      else {
        if (current) wrapped.push(current); current='';
        for (const char of word) { if(font.widthOfTextAtSize(current+char,size)>width){wrapped.push(current);current='';} current+=char; }
      }
    }
    if(current)wrapped.push(current);
    if (line.style === 'heading') { y-=9; if(y < 90 + Math.min(3,wrapped.length)*leading)nextPage(); }
    if (wrapped.length * leading < 650 && y - wrapped.length * leading < 50) nextPage();
    for (const text of wrapped) {
      if(y < 60)nextPage();
      page.drawText(text,{x:margin,y,size,font,color:line.style === 'muted' ? rgb(.34,.39,.44) : line.style === 'heading' ? rgb(.03,.32,.38) : rgb(.09,.14,.20)}); y-=leading;
    }
    y-=3;
  }
  const pages = pdf.getPages();
  pages.forEach((p,i)=>{
    p.drawLine({start:{x:margin,y:40},end:{x:551,y:40},thickness:.5,color:rgb(.75,.8,.82)});
    p.drawText(`NeuroHand | ${i+1} / ${pages.length}`,{x:margin,y:25,size:9,font,color:rgb(.34,.39,.44)});
  });
  return pdf.save();
}
export function reportFilename(date = new Date()) {
 return `NeuroHand_Report_${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}.pdf`;
}
