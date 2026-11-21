/* PiShelf EPUB reader. Lazy-loaded only when opening a .epub book.
 * epub.js 0.3.93 renders reflowable pages into sandboxed iframes. It does
 * not enable scripted EPUB contents. The original PDF/WebP reader is separate.
 */
let scriptsLoading=null;
function loadExternal(url,globalName){
 if(window[globalName])return Promise.resolve();
 return new Promise((resolve,reject)=>{
  const script=document.createElement('script');
  script.src=url;script.async=true;
  script.onload=()=>window[globalName]?resolve():reject(Error('EPUB reader dependency unavailable.'));
  script.onerror=()=>reject(Error('Could not load the EPUB reader. An internet connection is needed the first time.'));
  document.head.append(script);
 });
}
async function loadEngine(){
 if(!scriptsLoading)scriptsLoading=(async()=>{
  await loadExternal('https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js','JSZip');
  await loadExternal('https://cdn.jsdelivr.net/npm/epubjs@0.3.93/dist/epub.min.js','ePub');
 })().catch(error=>{scriptsLoading=null;throw error;});
 return scriptsLoading;
}
const readerColors={
 light:{body:{background:'#ffffff',color:'#242424'},a:{color:'#3267a8'}},
 sepia:{body:{background:'#f1e7d0',color:'#3c342c'},a:{color:'#705734'}},
 night:{body:{background:'#1c1c1c',color:'#eee3d3'},a:{color:'#b7cdfa'}},
 amoled:{body:{background:'#000000',color:'#e6e6e6'},a:{color:'#a9cfff'}}
};
export async function createEpubReader({url,container,cfi,theme='light',fontSize=100,onLocation,onChapters,onStatus,onTextTap,canSelectSpeechText=()=>false}){
 await loadEngine();
 const book=window.ePub(url);
 let dead=false,locationsReady=false,latestCfi='',lastPercentage=0;
 const rendition=book.renderTo(container,{width:'100%',height:'100%',flow:'paginated',spread:'none',allowScriptedContent:false});
 for(const [name,colors] of Object.entries(readerColors))rendition.themes.register(name,colors);
 function setTheme(value){rendition.themes.select(readerColors[value]?value:'light');}
 function setFontSize(value){rendition.themes.fontSize(String(Math.max(70,Math.min(190,value)))+'%');}
 function emitLocation(){
  if(dead)return;
  const current=rendition.currentLocation(),start=current?.start;
  if(!start?.cfi)return;
  latestCfi=start.cfi;
  const progress={epubCfi:latestCfi};
  if(locationsReady){
   let n=Number(book.locations.locationFromCfi(latestCfi));
   if(!Number.isFinite(n)||n<0)n=0;
   const count=Math.max(2,book.locations.total||2);
   progress.page=Math.max(1,Math.min(count,n+1));progress.total=count;
   lastPercentage=progress.page/count;
  }else if(Number.isFinite(start.percentage)){
   lastPercentage=Math.max(0,Math.min(1,start.percentage));
  }
  onLocation({...progress,percentage:lastPercentage,locationsReady});
 }
 // EPUB is rendered inside an iframe. Attach listeners when each chapter is displayed.
 let speechStartNode=null,selectedSpeechBlock=null;
 rendition.on('rendered',()=>{
  for(const content of rendition.getContents()||[]){
   const doc=content.document;
   if(!doc?.body||doc.body.dataset.pishelfTapToRead)return;
   doc.body.dataset.pishelfTapToRead='1';
   const style=doc.createElement('style');
   style.textContent='.pishelf-tap-selected{outline:2px solid #ed9a19!important;background:rgba(255,193,54,.3)!important;border-radius:3px}.pishelf-numbered-paragraph{position:relative;outline:2px solid #f0a620!important;background:rgba(255,193,54,.20)!important}.pishelf-numbered-paragraph.pishelf-speaking{outline:none!important;background:rgba(44,190,242,.34)!important}.pishelf-numbered-paragraph::before{content:attr(data-pishelf-paragraph-number);position:absolute;top:0;left:0;transform:translate(-95%,-25%);background:transparent;opacity:.72;color:#30240d;padding:0;font-size:9px;line-height:9px;font-weight:600}';
   style.textContent+='@media(max-width:650px), (pointer:coarse) and (max-height:500px){.pishelf-numbered-paragraph{outline:none!important}.pishelf-tap-selected{background:transparent!important;outline:none!important}.pishelf-numbered-paragraph.pishelf-speaking::before{color:#186382}.pishelf-numbered-paragraph::before{transform:translateY(-100%)}}';
   style.textContent+='::highlight(pishelf-reading){background:rgba(44,190,242,.34)}';
   doc.head?.append(style);
   doc.addEventListener('click',event=>{
    if(event.detail>1||!canSelectSpeechText()||!event.isTrusted||event.target.closest('a,button,input,select,textarea'))return;
    const block=event.target.closest('h1,h2,h3,h4,h5,h6,p,blockquote,li');
    if(!block||!block.textContent?.trim())return;
    selectedSpeechBlock?.classList.remove('pishelf-tap-selected');
    selectedSpeechBlock=block;
    speechStartNode=block;
    onTextTap?.(block.textContent.trim(),block);
   });
  }
 });
 rendition.on('relocated',emitLocation);
 setTheme(theme);setFontSize(fontSize);
 try{await rendition.display(cfi||undefined);}
 catch(error){
  if(!cfi){rendition.destroy();book.destroy();throw error;}
  // CFI can become invalid if a book was replaced after progress was saved.
  await rendition.display();
 }
 if(dead)return {destroy(){}};
 const navigation=await book.loaded.navigation.catch(()=>null);
 if(!dead&&navigation?.toc)onChapters(navigation.toc);
 onStatus('Preparing book progress…');
 // Location indexing is intentionally asynchronous. First page opens without
 // blocking on indexing the complete book.
 const indexing=book.locations.generate(1600).then(()=>{
  if(dead)return;
  locationsReady=true;onStatus('');
  emitLocation();
 }).catch(()=>{if(!dead)onStatus('Reading is available; percentage navigation is unavailable for this EPUB.');});
 return {
  clearSpeechStart(){speechStartNode=null;},
  clearReadingHighlight(){
   selectedSpeechBlock?.classList.remove('pishelf-tap-selected');
   for(const content of rendition.getContents()||[]){
    content.document?.defaultView?.CSS?.highlights?.delete('pishelf-reading');
   }
  },
  next(){return rendition.next();},
  async readAloudNext(){const before=rendition.currentLocation()?.start?.cfi;await rendition.next();const after=rendition.currentLocation()?.start?.cfi;return Boolean(after&&after!==before);},
  readAloudText(){
   const contents=rendition.getContents();
   return (contents||[]).map(c=>{
    const body=c.document?.body;if(!body)return '';
    // DOM order includes h1–h6, which innerText can omit in some EPUB layouts.
    const blocks=body.querySelectorAll('h1,h2,h3,h4,h5,h6,p,blockquote,li');
    if(!blocks.length)return body.textContent||'';
    const visible=Array.from(blocks).filter(node=>!node.closest('nav,[hidden],[aria-hidden="true"]'));
    const start=speechStartNode?visible.indexOf(speechStartNode):0;
    if(speechStartNode&&start>=0)speechStartNode=null;
    return visible.slice(Math.max(0,start)).map(node=>node.textContent?.trim()||'').filter(Boolean).join('\n');
   }).filter(Boolean).join('\n').trim();
  },
  prev(){return rendition.prev();},
  display(location){return rendition.display(location);},
  goPercent(percent){
   if(!locationsReady)return Promise.resolve(false);
   const p=Math.max(0,Math.min(1,percent/100));
   const target=book.locations.cfiFromPercentage(p);
   return target?rendition.display(target):Promise.resolve(false);
  },
  setTheme,
  setFontSize,
  get percent(){return lastPercentage;},
  get indexed(){return locationsReady;},
  destroy(){dead=true;rendition.destroy();book.destroy();void indexing;}
 };
}
