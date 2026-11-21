// The transparent glyphs share the preview's coordinate system. Browser ranges
// then provide character offsets, selection handles and native clipboard access.
export function buildTextSurface(content,viewport,transform){
 const layer=document.createElement('div');
 layer.className='pdf-text-surface';
 const measure=document.createElement('canvas').getContext('2d');
 for(const [index,item] of content.items.entries()){
  if(!item.str)continue;
  const [a,b,c,d,x,y]=transform(viewport.transform,item.transform);
  const height=Math.hypot(c,d);
  if(!height)continue;
  const font=content.styles[item.fontName]||{};
  const family=font.fontFamily||'sans-serif';
  const ascent=font.ascent??(font.descent!=null?1+font.descent:.8);
  const angle=Math.atan2(b,a)+(font.vertical?Math.PI/2:0);
  const span=document.createElement('span');
  span.dataset.item=index;
  span.dir=item.dir||'auto';
  span.textContent=item.str;
  measure.font='100px '+family;
  const measured=measure.measureText(item.str).width*height/100;
  const width=Math.abs(font.vertical?item.height:item.width)*viewport.scale;
  Object.assign(span.style,{
   left:100*(x+Math.sin(angle)*height*ascent)/viewport.width+'%',
   top:100*(y-Math.cos(angle)*height*ascent)/viewport.height+'%',
   fontFamily:family,fontSize:100*height/viewport.width+'cqw',
   transform:'rotate('+angle+'rad) scaleX('+(width&&measured?width/measured:1)+')'
  });
  layer.append(span,document.createTextNode(item.hasEOL?'\n':' '));
 }
 return layer;
}

export function selectedPassage(selection){
 if(!selection?.rangeCount||selection.isCollapsed)return null;
 const range=selection.getRangeAt(0);
 const surface=range.startContainer.parentElement?.closest('.pdf-text-surface');
 if(!surface||!surface.contains(range.endContainer))return null;
 const text=range.toString().trim();
 if(!text)return null;
 const bounds=surface.getBoundingClientRect();
 const boxes=Array.from(range.getClientRects()).filter(r=>r.width&&r.height).map(r=>({
  x:(r.left-bounds.left)/bounds.width,y:(r.top-bounds.top)/bounds.height,
  w:r.width/bounds.width,h:r.height/bounds.height
 }));
 if(!boxes.length)return null;
 const page=Number(surface.parentElement.dataset.page);
 const edge=node=>node.parentElement.dataset.item??Array.prototype.indexOf.call(surface.childNodes,node)+'s';
 const key=[page,edge(range.startContainer),range.startOffset,edge(range.endContainer),range.endOffset].join(':');
 const parts=[];
 for(const span of surface.querySelectorAll('span[data-item]')){
  const node=span.firstChild;
  if(!node||!range.intersectsNode(node))continue;
  const start=node===range.startContainer?range.startOffset:0;
  const end=node===range.endContainer?range.endOffset:node.length;
  if(end>start)parts.push({item:Number(span.dataset.item),start,end});
 }
 return {text,boxes,page,anchor:boxes[0],key,parts};
}


export function selectionsOverlap(a,b){
 if(a.page!==b.page)return false;
 const parts=entry=>entry.parts||entry.id.split(',').map(item=>({item:Number(item),start:0,end:Infinity}));
 const occupied=new Map(parts(a).map(part=>[part.item,part]));
 return parts(b).some(part=>{
  const other=occupied.get(part.item);
  return other&&other.start<part.end&&part.start<other.end;
 });
}
