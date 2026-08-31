const ascii = value => String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[\u2013\u2014]/g, '-').replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/[^\x09\x0a\x0d\x20-\x7e]/g, ' ');
const escapePdf = value => value.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
const wrap = (line, width = 94) => { const words=line.trim().split(/\s+/).filter(Boolean);if(!words.length)return[''];const rows=[];let current='';for(const word of words){if(!current)current=word;else if(`${current} ${word}`.length<=width)current+=` ${word}`;else{rows.push(current);current=word;}}if(current)rows.push(current);return rows; };
const plainInline = value => String(value || '')
  .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
  .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label, url) => `${label}: ${url}`)
  .replace(/\*\*([^*]+)\*\*/g, '$1')
  .replace(/__([^_]+)__/g, '$1')
  .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '$1')
  .replace(/`([^`]+)`/g, '$1');

// Small dependency-free renderer with an ATS-readable text layer. It keeps the
// generated application package deterministic while providing clear hierarchy.
export function renderTextPdf(markdown) {
  const logical=ascii(markdown).split(/\r?\n/).flatMap(raw=>{const heading=/^(#{1,3})\s+(.+)$/.exec(raw),bullet=/^\s*[-*]\s+(.+)$/.exec(raw);if(heading)return[{text:plainInline(heading[2]),kind:`h${heading[1].length}`}];if(bullet)return wrap(`- ${plainInline(bullet[1])}`,92).map(text=>({text,kind:'bullet'}));const clean=plainInline(raw);return wrap(clean,94).map(text=>({text,kind:text?'body':'blank'}));});
  const pages=[];let page=[];for(const line of logical){const keepWithNext={h1:3,h2:3,h3:4}[line.kind]||1;if(page.length&&page.length+keepWithNext>62){pages.push(page);page=[];}if(line.kind==='h1'&&page.length)page.push({text:'',kind:'blank'});page.push(line);if(['h1','h2'].includes(line.kind))page.push({text:'',kind:'blank'});if(page.length>=62){pages.push(page);page=[];}}if(page.length)pages.push(page);if(!pages.length)pages.push([{text:'',kind:'blank'}]);
  const objects=[null];const add=body=>{objects.push(body);return objects.length-1;};const catalogId=add(''),pagesId=add(''),fontId=add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'),boldFontId=add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>');const pageIds=[];
  for(const pageLines of pages){let y=756;const commands=[];for(const line of pageLines){const size=line.kind==='h1'?16:line.kind==='h2'?11:line.kind==='h3'?9.5:8.5,leading=line.kind==='h1'?18:line.kind==='h2'?13:line.kind==='blank'?5:10,font=['h1','h2','h3'].includes(line.kind)?'F2':'F1';if(line.text)commands.push(`BT /${font} ${size} Tf 54 ${y} Td (${escapePdf(line.text)}) Tj ET`);if(line.kind==='h1')commands.push(`0.15 0.28 0.4 RG 54 ${y-5} m 558 ${y-5} l S`);y-=leading;}const stream=commands.join('\n');const contentId=add(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);pageIds.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontId} 0 R /F2 ${boldFontId} 0 R >> >> /Contents ${contentId} 0 R >>`));}
  objects[catalogId]=`<< /Type /Catalog /Pages ${pagesId} 0 R >>`;objects[pagesId]=`<< /Type /Pages /Kids [${pageIds.map(id=>`${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;let pdf='%PDF-1.4\n';const offsets=[0];for(let id=1;id<objects.length;id++){offsets[id]=Buffer.byteLength(pdf);pdf+=`${id} 0 obj\n${objects[id]}\nendobj\n`;}const xref=Buffer.byteLength(pdf);pdf+=`xref\n0 ${objects.length}\n0000000000 65535 f \n`;for(let id=1;id<objects.length;id++)pdf+=`${String(offsets[id]).padStart(10,'0')} 00000 n \n`;pdf+=`trailer\n<< /Size ${objects.length} /Root ${catalogId} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;return Buffer.from(pdf,'ascii');
}
