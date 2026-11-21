/* Spatial reading order for PDF.js text items.
 * Magazine PDFs often store headlines after body copy in their content stream.
 * Sort major vertical regions first, then read each column top-to-bottom.
 * No OCR or image analysis is performed.
 */
// Skip running issue metadata printed in the bottom margin, not article copy.
// PDF.js may return a footer as one text item or several separate fragments.
function stripRunningFooters(items,viewport){
 const bottom=items.filter(item=>item.y>=viewport.height*.94);
 if(!bottom.length)return items;
 const baselines=[],tolerance=Math.max(5,viewport.height*.008);
 for(const item of bottom.sort((a,b)=>a.y-b.y||a.x-b.x)){
  let line=baselines.find(line=>Math.abs(line.y-item.y)<=tolerance);
  if(!line){line={y:item.y,parts:[]};baselines.push(line);}
  line.parts.push(item);
 }
 const excluded=new Set();
 for(const line of baselines){
  const text=line.parts.sort((a,b)=>a.x-b.x).map(item=>item.str.trim()).join(' ').replace(/\s+/g,' ');
  const date=/\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+(?:19|20)\d{2}\b/i.test(text);
  const publication=/\bNew\s+Scientist\b/i.test(text);
  const pageSeparator=/^\d{1,4}\s*[|•·–—]\s*/u.test(text);
  // Constrain to short, bottom-margin metadata; don't drop an article line
  // solely because its sentence mentions a date.
  if(text.length<=110&&((date&&(publication||pageSeparator))||(publication&&pageSeparator)))
   for(const item of line.parts)excluded.add(item.sourceIndex);
 }
 return excluded.size?items.filter(item=>!excluded.has(item.sourceIndex)):items;
}

// A magazine page can contain two separate multi-column stories stacked vertically.
// Find the blank horizontal band preceding a new short section label + larger title.
// This is a cheap text-geometry heuristic; image previews remain untouched.
export function splitPdfArticleBands(items,viewport){
 const byY=[...items].sort((a,b)=>a.y-b.y||a.x-b.x);
 if(byY.length<3)return [byY];
 const heights=byY.map(item=>item.boxHeight||12).sort((a,b)=>a-b);
 const medianHeight=Math.max(8,heights[Math.floor(heights.length/2)]||12);
 const boundaries=[];
 for(let i=1;i<byY.length;i++){
  const before=byY[i-1],after=byY[i];
  const gap=after.y-before.y;
  const center=(after.y+before.y)/2;
  if(gap<=0||center<viewport.height*.2||center>viewport.height*.9)continue;
  const large=gap>=Math.max(55,viewport.height*.09);
  const meaningful=gap>=Math.max(17,medianHeight*1.6);
  if(!large&&!meaningful)continue;
  if(i<2||byY.length-i<2)continue;
  // A new article's section label starts at the left margin and is usually
  // a short word (Physics, Health, Technology), above a much larger headline.
  const first=after.str.trim();
  const leftMargin=after.x<=viewport.width*.18;
  const categoryLike=first.length<=26&&first.split(/\s+/).length<=3&&
   /^[\p{L}][\p{L}\s&/-]*$/u.test(first);
  const titleAfter=byY.slice(i).some(item=>
   item.y>after.y&&item.y-after.y<Math.max(68,viewport.height*.09)&&
   item.x<viewport.width*.38&&
   (item.boxHeight>=after.boxHeight*1.28||
    (item.str.length>=first.length+18&&item.boxHeight>=after.boxHeight))
  );
  if(large||(meaningful&&leftMargin&&categoryLike&&titleAfter))
   boundaries.push(center);
 }
 // Keep bands in visual order, and perform independent column detection inside
 // each. Otherwise bottom Health text can be interleaved with Physics columns.
 const bands=[];
 let lower=-Infinity;
 for(const upper of boundaries){
  const band=byY.filter(item=>item.y>=lower&&item.y<upper);
  if(band.length)bands.push(band);
  lower=upper;
 }
 const last=byY.filter(item=>item.y>=lower);
 if(last.length)bands.push(last);
 return bands;
}

export function orderPdfSpeechItems(items,viewport){
 const measured=items.map((item,sourceIndex)=>{
  const p=viewport.convertToViewportPoint(item.transform[4],item.transform[5]);
  return {...item,sourceIndex,x:p[0],y:p[1],boxWidth:Math.abs(item.width||0),boxHeight:Math.abs(item.height||12)};
 }).filter(item=>item.str?.trim()&&Number.isFinite(item.x)&&Number.isFinite(item.y));
 const content=stripRunningFooters(measured,viewport);
 if(content.length<2)return content;
 // Read one article band at a time before sorting that band's columns.
 const groups=splitPdfArticleBands(content,viewport);
 function columnSorted(group,region){
  // Keep reading-order metadata for paragraph continuation across columns.
  const tagged=(sorted,getColumn)=>sorted.map(item=>({...item,readingRegion:region,readingColumn:getColumn(item)}));
  if(group.length<3)return tagged([...group].sort((a,b)=>a.y-b.y||a.x-b.x),()=>0);
  // Determine column starts using repeated left-aligned text origins.
  // Bounding-box gutters fail when PDF text boxes overlap neighboring columns.
  const tolerance=Math.max(5,viewport.width*.018);
  const starts=[];
  for(const item of [...group].sort((a,b)=>a.x-b.x)){
   const anchor=starts.find(entry=>Math.abs(entry.x-item.x)<=tolerance);
   if(anchor){anchor.x=(anchor.x*anchor.count+item.x)/(anchor.count+1);anchor.count++;}
   else starts.push({x:item.x,count:1});
  }
  // A genuine column begins at the same x on multiple lines.
  const minimumCount=Math.max(2,Math.floor(group.length*.06));
  const candidates=starts.filter(entry=>entry.count>=minimumCount)
   .sort((a,b)=>b.count-a.count||a.x-b.x);
  const columns=[]; // Newspapers can use four narrow columns on one page.
  for(const candidate of candidates){
   if(columns.every(other=>Math.abs(other.x-candidate.x)>viewport.width*.17))
    columns.push(candidate);
   if(columns.length===4)break;
  }
  columns.sort((a,b)=>a.x-b.x);
  // If there are not enough repeated starts, preserve vertical order rather
  // than incorrectly reading a row across multiple columns.
  if(columns.length<2)return tagged([...group].sort((a,b)=>a.y-b.y||a.x-b.x),()=>0);
  const boundaries=columns.slice(1).map((entry,i)=>(columns[i].x+entry.x)/2);
  const column=item=>boundaries.filter(boundary=>item.x>=boundary).length;
  return tagged([...group].sort((a,b)=>column(a)-column(b)||a.y-b.y||a.x-b.x),column);
 }
 return groups.flatMap((group,region)=>columnSorted(group,region));
}

// PDF.js hasEOL marks visual line wraps, not paragraph breaks.
// Join nearby lines within each column, but separate headings and paragraph gaps.
export function pdfSpeechLayout(items){
 let text='',previous=null;
 const spans=[];
 for(const item of items){
  const fragment=String(item.str||'').trim();
  if(!fragment)continue;
  if(previous){
   const lineGap=Math.abs(item.y-previous.y);
   const height=Math.max(8,previous.boxHeight||12,item.boxHeight||12);
   const changedRegion=item.readingRegion!==previous.readingRegion;
   const changedColumn=item.readingColumn!==previous.readingColumn;
   const completedSentence=/[.!?…]["”’)\]]*$/u.test(String(previous.str||'').trim());
   // Continue unfinished sentences into the next newspaper column.
   const paragraphBreak=changedRegion||
    (changedColumn?completedSentence:lineGap>height*2.4||item.y<previous.y-height*.8);
   const hyphenated=/[A-Za-z]-$/.test(previous.str||'');
   if(paragraphBreak)text+='\n';
   else if(hyphenated){
    text=text.slice(0,-1);
    if(spans.length)spans[spans.length-1].end--;
   }else text+=' ';
  }
  const start=text.length;
  text+=fragment;
  spans.push({item,start,end:text.length});
  previous=item;
 }
 return {text:text.trim(),spans};
}

export function pdfSpeechText(items){
 return pdfSpeechLayout(items).text;
}
