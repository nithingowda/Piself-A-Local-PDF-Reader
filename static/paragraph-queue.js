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
 // Manual picks follow contiguous printed lines, even when narration
 // would join an unfinished sentence to text in another column.
 let region=0,lineStart=null,lineEnd=0,margin=Infinity;
 const localItems=measured.map((item,index)=>{
  const prev=measured[index-1];
  if(prev){
   const height=Math.max(1,Math.min(prev.boxHeight,item.boxHeight));
   const dy=item.y-prev.y;
   const newLine=dy>height*.55;
   // A trailing word in another font belongs to its printed line.
   const gapX=newLine?Math.max(item.x-lineEnd,lineStart.x-item.x-item.boxWidth):
    item.x-prev.x-prev.boxWidth;
   const aligned=Math.abs(item.x-lineStart.x)<=height*.85;
   const sameSize=Math.abs(item.boxHeight-lineStart.boxHeight)<=height*.15;
   const changedFont=item.fontName&&lineStart.fontName&&item.fontName!==lineStart.fontName;
   const headingChange=newLine&&changedFont&&(!sameSize||lineStart===prev);
   const indent=newLine&&item.x>margin+height*.65&&/[.!?…]["”’)]*$/.test(prev.str.trim());
   const maxLineGap=height*(aligned&&sameSize?2.3:1.8);
   const boundary=item.readingRegion!==prev.readingRegion||item.readingColumn!==prev.readingColumn||
    dy < -height*.65||dy>maxLineGap||gapX>height*1.4||headingChange||indent;
   if(boundary){region++;margin=Infinity;}
   if(newLine||boundary)lineStart=null;
  }
  if(!lineStart){lineStart=item;lineEnd=item.x;margin=Math.min(margin,item.x);}
  lineEnd=Math.max(lineEnd,item.x+item.boxWidth);
  return {...item,sourceRegion:item.readingRegion,readingRegion:region};
 });
 const {text,spans}=pdfSpeechLayout(localItems);
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
     font:included[0].item.fontName,column:included[0].item.readingColumn,region:included[0].item.sourceRegion,
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
 if(!chosen||nearest>Math.max(20,viewport.height*.02))return null;
 const parts=[chosen];
 const index=paragraphs.indexOf(chosen);
 for(let i=index+1;i<paragraphs.length;i++){
  const next=paragraphs[i];
  const prev=parts.at(-1);
  const last=prev.boxes.at(-1),first=next.boxes[0];
  const height=Math.min(last.h,first.h);
  const gap=first.y-last.y-last.h;
  if(next.region!==prev.region||next.font!==prev.font||Math.abs(first.h-last.h)>height*.12)break;
  if(next.column===prev.column){
   if(gap<0||gap>height*1.8||
      Math.abs(next.anchor.x-prev.anchor.x)*viewport.width>height*viewport.height*1.6)break;
  }else{
   // Follow a wrapped sentence only into the adjacent column of this region.
   const continuation=next.column===prev.column+1&&first.x>prev.anchor.x&&
    first.y<last.y-height&&typeof prev.font==='string'&&
    /[\p{L}\p{N},;–—-]$/u.test(prev.text.trimEnd())&&/^\p{Ll}/u.test(next.text.trimStart());
   if(!continuation)break;
  }
  parts.push(next);
 }
 if(parts.length===1)return chosen;
 return {...chosen,id:parts.map(p=>p.id).join(','),text:parts.map(p=>p.text).join('\n'),
  boxes:parts.flatMap(p=>p.boxes)};
}

export function reorderParagraphs(items,at,direction){
 const to=at+direction;
 if(!Number.isInteger(at)||!Number.isInteger(direction)||
  at<0||at>=items.length||to<0||to>=items.length)return items.slice();
 const copy=items.slice();
 [copy[at],copy[to]]=[copy[to],copy[at]];
 return copy;
}
