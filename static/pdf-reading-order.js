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
  // Horizontal bands with no glyphs are likely multi-column gutters.
  const bins=200,occupied=new Uint8Array(bins);
  for(const item of group){
   const begin=Math.max(0,Math.min(bins-1,Math.floor(item.x/viewport.width*bins)));
   const end=Math.max(begin,Math.min(bins-1,Math.ceil((item.x+item.boxWidth)/viewport.width*bins)));
   for(let i=begin;i<=end;i++)occupied[i]=1;
  }
  const gutters=[];
  for(let i=0;i<bins;){
   if(occupied[i]){i++;continue;}
   const begin=i;while(i<bins&&!occupied[i])i++;
   const middle=(begin+i)/2;
   if(i-begin>=4&&middle>bins*.17&&middle<bins*.83)gutters.push({middle,width:i-begin});
  }
  // Favor the two widest separated gutters; never create more than 3 columns.
  const selected=[];
  for(const gap of gutters.sort((a,b)=>b.width-a.width)){
   if(selected.every(other=>Math.abs(other.middle-gap.middle)>bins*.18))selected.push(gap);
   if(selected.length===2)break;
  }
  const boundaries=selected.map(gap=>gap.middle/bins*viewport.width).sort((a,b)=>a-b);
  const column=item=>boundaries.filter(x=>item.x>=x).length;
  return [...group].sort((a,b)=>column(a)-column(b)||a.y-b.y||a.x-b.x);
 }
 return groups.flatMap(columnSorted);
}

export function pdfSpeechText(items){
 return items.map(item=>(item.str||'')+(item.hasEOL?'\n':' ')).join('').trim();
}
