/* Spatial reading order for PDF.js text items.
 * Magazine PDFs often store headlines after body copy in their content stream.
 * Sort major vertical regions first, then read each column top-to-bottom.
 * No OCR or image analysis is performed.
 */
export function orderPdfSpeechItems(items,viewport){
 const measured=items.map((item,sourceIndex)=>{
  const p=viewport.convertToViewportPoint(item.transform[4],item.transform[5]);
  return {...item,sourceIndex,x:p[0],y:p[1],boxWidth:Math.abs(item.width||0),boxHeight:Math.abs(item.height||12)};
 }).filter(item=>item.str?.trim()&&Number.isFinite(item.x)&&Number.isFinite(item.y));
 if(measured.length<2)return measured;
 // A large vertical gap separates the headline/image region from article copy.
 const byY=[...measured].sort((a,b)=>a.y-b.y||a.x-b.x);
 let cutoff=null,maxGap=Math.max(48,viewport.height*.10);
 for(let i=1;i<byY.length;i++){
  const gap=byY[i].y-byY[i-1].y;
  if(gap>maxGap&&i>=1&&byY.length-i>=2){
   cutoff=(byY[i].y+byY[i-1].y)/2;maxGap=gap;
  }
 }
 const groups=cutoff===null?[measured]:[
  measured.filter(item=>item.y<cutoff),
  measured.filter(item=>item.y>=cutoff)
 ];
 function columnSorted(group){
  if(group.length<3)return [...group].sort((a,b)=>a.y-b.y||a.x-b.x);
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
  const columns=[];
  for(const candidate of candidates){
   if(columns.every(other=>Math.abs(other.x-candidate.x)>viewport.width*.17))
    columns.push(candidate);
   if(columns.length===3)break;
  }
  columns.sort((a,b)=>a.x-b.x);
  // If there are not enough repeated starts, preserve vertical order rather
  // than incorrectly reading a row across multiple columns.
  if(columns.length<2)return [...group].sort((a,b)=>a.y-b.y||a.x-b.x);
  const boundaries=columns.slice(1).map((entry,i)=>(columns[i].x+entry.x)/2);
  const column=item=>boundaries.filter(boundary=>item.x>=boundary).length;
  return [...group].sort((a,b)=>column(a)-column(b)||a.y-b.y||a.x-b.x);
 }
 return groups.flatMap(columnSorted);
}

export function pdfSpeechText(items){
 return items.map(item=>(item.str||'')+(item.hasEOL?'\n':' ')).join('').trim();
}
