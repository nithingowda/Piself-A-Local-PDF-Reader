/* Manual-only text selection over PDF/WebP previews.
 * No article, headline, footer, column or language inference.
 * The reader extracts precisely the PDF text intersecting a user-drawn area.
 */
export function extractPdfRegion(items,viewport,box){
 const left=Math.min(box.x1,box.x2),right=Math.max(box.x1,box.x2);
 const top=Math.min(box.y1,box.y2),bottom=Math.max(box.y1,box.y2);
 const measured=items.map((item,index)=>{
  const [x,y]=viewport.convertToViewportPoint(item.transform[4],item.transform[5]);
  return {item,index,x,y,width:Math.abs(item.width||0),height:Math.max(6,Math.abs(item.height||12))};
 }).filter(row=>row.item.str?.trim()&&Number.isFinite(row.x)&&Number.isFinite(row.y));
 const within=measured.filter(row=>
  row.x<=right+3&&row.x+row.width>=left-3&&
  row.y+row.height*.25>=top-3&&row.y-row.height<=bottom+3
 );
 if(!within.length)return {text:'',items:[]};
 // Group visual text rows by their PDF baseline, then read left to right.
 // A region should normally contain one column; the user controls regions.
 const lines=[];
 for(const item of within.sort((a,b)=>a.y-b.y||a.x-b.x)){
  let line=lines.find(row=>Math.abs(row.y-item.y)<=Math.max(4,item.height*.5));
  if(!line){line={y:item.y,items:[]};lines.push(line);}
  line.items.push(item);
 }
 lines.sort((a,b)=>a.y-b.y);
 const result=[];
 for(const line of lines){
  line.items.sort((a,b)=>a.x-b.x);
  const words=line.items.map(row=>row.item.str.trim()).filter(Boolean);
  result.push(words.join(' ').replace(/([A-Za-z])-\s+(?=[a-z])\b/g,'$1'));
 }
 return {text:result.join(' ').replace(/\s+/g,' ').trim(),items:within.map(row=>row.item)};
}

export function moveQueueItem(queue,index,step){
 const destination=index+step;
 if(!Number.isInteger(index)||!Number.isInteger(step)||
  index<0||destination<0||destination>=queue.length)return queue.slice();
 const copy=queue.slice();
 const [entry]=copy.splice(index,1);
 copy.splice(destination,0,entry);
 return copy;
}

export function queuePreview(text){
 return String(text||'').replace(/\s+/g,' ').trim();
}
