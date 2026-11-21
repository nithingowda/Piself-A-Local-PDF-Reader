import {pdfSpeechLayout} from './pdf-reading-order.js';

// Turn the existing PDF.js text layout into independent selectable passages.
// Coordinates are normalized to the PDF viewport and work on WebP previews.
export function numberedPdfParagraphs(ordered,viewport){
 const measured=ordered.map((item,index)=>{
  if(Number.isFinite(item.x)&&Number.isFinite(item.y))return item;
  const [x,y]=viewport.convertToViewportPoint(item.transform[4],item.transform[5]);
  return {...item,x,y,sourceIndex:item.sourceIndex??index,boxHeight:Math.abs(item.height||12),
   boxWidth:Math.abs(item.width||20),readingColumn:item.readingColumn??0,readingRegion:item.readingRegion??0};
 });
 const {text,spans}=pdfSpeechLayout(measured);
 if(!text.trim()||!viewport.width||!viewport.height)return [];
 const groups=[];
 let start=0;
 for(let i=0;i<=text.length;i++){
  if(i<text.length&&text[i]!=='\n')continue;
  const end=i,source=text.slice(start,end).trim();
  if(source){
   const included=spans.filter(span=>span.end>start&&span.start<end);
   const boxes=included.map(span=>{
    const item=span.item;
    const [x,y]=viewport.convertToViewportPoint(item.transform[4],item.transform[5]);
    const width=Math.max(3,Math.abs(item.width||25));
    const height=Math.max(7,Math.abs(item.height||12));
    return {x,y:y-height,w:width,h:height,sourceIndex:item.sourceIndex};
   });
   if(boxes.length){
    const anchor=boxes.reduce((a,box)=>box.y<a.y||(box.y===a.y&&box.x<a.x)?box:a,boxes[0]);
    groups.push({
     id:included.map(span=>span.item.sourceIndex).join(','),
     text:source,anchor:{x:anchor.x/viewport.width,y:anchor.y/viewport.height},
     boxes:boxes.map(box=>({
      x:box.x/viewport.width,y:box.y/viewport.height,
      w:box.w/viewport.width,h:box.h/viewport.height
     }))
    });
   }
  }
  start=i+1;
 }
 return groups;
}

export function paragraphAtPoint(paragraphs,x,y,viewport){
 let chosen=null,nearest=Infinity;
 for(const paragraph of paragraphs){
  for(const box of paragraph.boxes){
   const left=box.x*viewport.width,top=box.y*viewport.height;
   const right=left+box.w*viewport.width,bottom=top+box.h*viewport.height;
   const dx=Math.max(left-x,0,x-right),dy=Math.max(top-y,0,y-bottom);
   const distance=Math.hypot(dx,dy);
   if(distance<nearest){nearest=distance;chosen=paragraph;}
  }
 }
 // Don't select text across a large photograph or empty gutter.
 return nearest<=Math.max(20,viewport.height*.02)?chosen:null;
}

export function reorderParagraphs(items,at,direction){
 const to=at+direction;
 if(!Number.isInteger(at)||!Number.isInteger(direction)||
  at<0||at>=items.length||to<0||to>=items.length)return items.slice();
 const copy=items.slice();
 [copy[at],copy[to]]=[copy[to],copy[at]];
 return copy;
}
