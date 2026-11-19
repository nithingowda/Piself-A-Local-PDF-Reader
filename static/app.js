/* PiShelf browser client: library UI, PDF rendering, touch gestures, and saved progress.
 * Rendering work is queued and bounded to protect mobile and tablet memory.
 * Keep gesture coordinates and page numbers synchronized when modifying this file.
 */
const $=id=>document.getElementById(id);
const defaults={sort:'issue',siteTheme:'light',theme:'dark',mode:'scroll',quality:'1.5',density:'compact',interval:'15',motion:true,gestures:true};
let prefs={...defaults};try{const stored=JSON.parse(localStorage.getItem('pishelf-settings')||'{}');for(const k in defaults)if(k in stored)prefs[k]=stored[k];}catch{}
let collections=[],collectionFilter='',collectionSets=new Map();
let categories=[],sourceFilter='',seriesFilter='',tagFilter='',visibleLimit=60;
let library=[],saved={},filter='all',category='',syncing=false,current=null,documentPDF=null,page=1,zoom=1,rotation=0,generation=0,layoutEpoch=0,layoutReady=false;
let cssZoomBase=1;
let saveChain=Promise.resolve(),pollTimer,toastTimer,scrollTimer,resizeTimer,scrollFrame,issueItem;
const pendingSaves=new Map();
/** el: Support the PiShelf reader or library interface. */
function el(tag,cls,text){const n=document.createElement(tag);if(cls)n.className=cls;if(text)n.textContent=text;return n;}
/** toast: Support the PiShelf reader or library interface. */
function toast(message){$('toast').textContent=message;$('toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').hidden=true,5000);}
/** api: Support the PiShelf reader or library interface. */
async function api(path,data){const r=await fetch(path,data===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data),keepalive:JSON.stringify(data).length<60000});let value;try{value=await r.json();}catch{throw Error('Could not reach PiShelf. Check the connection.');}if(!r.ok)throw Error(value.error||'Request failed.');return value;}
/** persist: Support the PiShelf reader or library interface. */
function persist(id,patch){
 saved[id]={...saved[id],...patch};if('page' in patch)saved[id].lastRead=Date.now()/1000;
 pendingSaves.set(id,{...pendingSaves.get(id),...patch});
 saveChain=saveChain.catch(()=>{}).then(async()=>{
  const update=pendingSaves.get(id);if(!update)return;pendingSaves.delete(id);
  try{await api('/api/progress',{id,...update});}
  catch(e){pendingSaves.set(id,{...update,...pendingSaves.get(id)});toast('Reading changes are not saved yet. Reconnect to retry.');}
 });return saveChain;
}
/** confirm Action: Support the PiShelf reader or library interface. */
function confirmAction(title,message,label){return new Promise(resolve=>{const d=$('confirm-dialog');$('confirm-title').textContent=title;$('confirm-text').textContent=message;$('confirm-yes').textContent=label;const done=v=>{d.close();resolve(v);};$('confirm-no').onclick=()=>done(false);$('confirm-yes').onclick=()=>done(true);d.oncancel=e=>{e.preventDefault();done(false);};d.showModal();});}
const pdfURL=i=>'/'+(i.source||'magazines')+'/' +i.path.split('/').map(encodeURIComponent).join('/');
const finished=i=>!!saved[i.id]?.completed||(saved[i.id]?.page>=saved[i.id]?.total&&!!saved[i.id]?.total);
const fileSize=n=>n<1048576?Math.max(1,Math.round(n/1024))+' KB':(n/1048576).toFixed(1)+' MB';
const thumbs=new Map();let coverQueue=[],coverBusy=false;
const coverURL=item=>'/api/covers/'+item.coverKey;
/** cache Thumb: Support the PiShelf reader or library interface. */
function cacheThumb(key,data){if(thumbs.size>=120){const oldest=thumbs.keys().next().value;const url=thumbs.get(oldest);if(url?.startsWith('blob:'))URL.revokeObjectURL(url);thumbs.delete(oldest);}thumbs.set(key,data);}
/** covers: Support the PiShelf reader or library interface. */
async function covers(){
 if(coverBusy)return;coverBusy=true;
 try{while(coverQueue.length){
  if(!$('reader').hidden)break;
  const {item,button}=coverQueue.shift();if(!button.isConnected)continue;
  try{
   const key=item.coverKey;let data=thumbs.get(key);
   if(!data){
    let response=await fetch(coverURL(item));
    if(response.status===404)response=await fetch('/api/render-page?source='+encodeURIComponent(pdfURL(item))+'&page=1&width=400');
    if(!response.ok)throw Error('Cover unavailable: HTTP '+response.status);
    data=URL.createObjectURL(await response.blob());cacheThumb(key,data);
   }
   if(button.isConnected){const img=el('img');img.src=data;img.alt='';img.decoding='async';button.replaceChildren(img);}
  }catch{button.classList.add('cover-unavailable');}
 }}finally{coverBusy=false;}
}
/** date Label: Support the PiShelf reader or library interface. */
function dateLabel(item){if(!item.issueDate)return '';const date=new Date(item.issueDate+(item.issueDate.length===7?'-01':'')+'T12:00:00');return Number.isNaN(date.valueOf())?'':date.toLocaleDateString(undefined,{year:'numeric',month:'long',...(item.issueDate.length===10?{day:'numeric'}:{})});}
/** select Series: Support the PiShelf reader or library interface. */
function selectSeries(value){seriesFilter=value;category=tagFilter='';filter='all';$('search').value='';$('tag-filter').value='';$('series-filter').value=value;visibleLimit=60;drawLibrary();}
/** select Tag: Support the PiShelf reader or library interface. */
function selectTag(value){tagFilter=value;$('tag-filter').value=value;visibleLimit=60;drawLibrary();}
/** update Filter Options: Support the PiShelf reader or library interface. */
function updateFilterOptions(){
 $('collections').replaceChildren();const live=new Set(library.map(i=>i.id));for(const collection of collections){const count=collection.items.filter(id=>live.has(id)).length;const button=el('button','category',collection.name+' · '+count);button.classList.toggle('active',collectionFilter===collection.id);button.onclick=()=>{collectionFilter=collection.id;sourceFilter=seriesFilter=tagFilter=category='';filter='all';$('search').value='';$('source-filter').value='';visibleLimit=60;updateFilterOptions();drawLibrary();};$('collections').append(button);}
 for(const [id,values,value,label] of [['series-filter',[...new Set(library.filter(i=>!sourceFilter||i.source===sourceFilter).map(i=>i.series).filter(Boolean))].sort(),seriesFilter,'All publications'],['tag-filter',[...new Set(library.flatMap(i=>i.tags||[]))].sort(),tagFilter,'All tags']]){
  const select=$(id);select.replaceChildren(new Option(label,''));for(const name of values)select.add(new Option(name,name));select.value=value;
 }
 $('categories').replaceChildren();
 for(const cat of categories.filter(c=>!sourceFilter||c.source===sourceFilter)){
  const name=cat.path==='.'?'Uncategorised':cat.path.replaceAll('/',' / '),b=el('button','category',name+(!sourceFilter?' · '+cat.source:''));
  b.classList.toggle('active',category===cat.path&&sourceFilter===cat.source);
  b.onclick=()=>{category=cat.path;sourceFilter=cat.source;$('source-filter').value=sourceFilter;visibleLimit=60;updateFilterOptions();drawLibrary();};$('categories').append(b);
 }
}
const coverObserver=new IntersectionObserver(entries=>{for(const e of entries)if(e.isIntersecting){coverObserver.unobserve(e.target);coverQueue.push({item:e.target.item,button:e.target});covers();}},{rootMargin:'100px'});
/** card For: Support the PiShelf reader or library interface. */
function cardFor(item,target){
 const s=saved[item.id]||{},card=el('article','card'),cover=el('button','cover');cover.setAttribute('aria-label','Read '+item.title);cover.append(el('span','placeholder',item.title));cover.onclick=()=>openMagazine(item);cover.item=item;
 const heading=el('div','card-head');heading.append(el('h2','',dateLabel(item)||item.title));const star=el('button','favorite',s.favorite?'★':'☆');star.setAttribute('aria-label','Favourite '+item.title);star.setAttribute('aria-pressed',!!s.favorite);star.onclick=()=>{persist(item.id,{favorite:!saved[item.id]?.favorite});drawLibrary();};heading.append(star);
 const more=el('button','more','•••');more.setAttribute('aria-label','Options for '+item.title);more.onclick=()=>showIssue(item);heading.append(more);
 const seriesButton=el('button','series-link',item.series||item.title);seriesButton.onclick=()=>selectSeries(item.series||item.title);card.append(cover,seriesButton,heading);const chips=el('div','tag-chips');for(const tag of item.tags||[]){const b=el('button','tag-chip',tag);b.onclick=()=>selectTag(tag);chips.append(b);}card.append(chips);
 card.append(el('div','meta',finished(item)?'Finished':s.page?`Page ${s.page} of ${s.total}`:`${item.category==='.'?(item.source==='newspapers'?'Newspaper':'Magazine'):item.category} · ${fileSize(item.size)}`));
 if(s.page||s.completed){const bar=el('div','progress'),fill=el('span');fill.style.width=(finished(item)?100:Math.min(100,s.page/s.total*100))+'%';bar.append(fill);card.append(bar);}target.append(card);coverObserver.observe(cover);
}
/** draw Library: Support the PiShelf reader or library interface. */
function drawLibrary(){
 coverObserver.disconnect();coverQueue=[];$('grid').replaceChildren();$('resume-grid').replaceChildren();$('count').textContent=library.length;
 $('shelf-label').textContent=collections.find(c=>c.id===collectionFilter)?.name||category||({all:'All publications',reading:'Continue reading',favorites:'Favourites',unread:'Unread',completed:'Finished'}[filter]);
 const q=$('search').value.trim().toLowerCase();const terms=q.split(/\s+/).filter(Boolean);const items=library.filter(i=>(!collectionFilter||collectionSets.get(collectionFilter)?.has(i.id))&&(!sourceFilter||i.source===sourceFilter)&&(!seriesFilter||i.series===seriesFilter)&&(!tagFilter||(i.tags||[]).includes(tagFilter))&&(!category||i.category===category)&&terms.every(term=>(i.title+' '+i.series+' '+dateLabel(i)+' '+i.issueDate+' '+i.category+' '+(i.tags||[]).join(' ')).toLowerCase().includes(term))).filter(i=>filter==='all'||filter==='favorites'&&saved[i.id]?.favorite||filter==='reading'&&saved[i.id]?.page&&!finished(i)||filter==='unread'&&!saved[i.id]?.page&&!finished(i)||filter==='completed'&&finished(i));
 const order=filter==='reading'?'recent':$('sort').value;items.sort((a,b)=>order==='title'?a.title.localeCompare(b.title):order==='recent'?(saved[b.id]?.lastRead||0)-(saved[a.id]?.lastRead||0):order==='size'?b.size-a.size:order==='issue'?(b.issueDate||'').localeCompare(a.issueDate||'')||b.modified-a.modified:b.modified-a.modified);
 items.slice(0,visibleLimit).forEach(i=>cardFor(i,$('grid')));$('load-more').hidden=items.length<=visibleLimit;$('active-filters').textContent=[collections.find(c=>c.id===collectionFilter)?.name,sourceFilter,seriesFilter,tagFilter&&'#'+tagFilter,category,`${items.length} issues`].filter(Boolean).join(' · ');
 const recent=library.filter(i=>saved[i.id]?.page&&!finished(i)).sort((a,b)=>(saved[b.id].lastRead||0)-(saved[a.id].lastRead||0)).slice(0,6);
 $('resume-section').hidden=filter!=='all'||!!category||!!q||!!sourceFilter||!!seriesFilter||!!tagFilter||!!collectionFilter||!recent.length;if(!$('resume-section').hidden)recent.forEach(i=>cardFor(i,$('resume-grid')));
 if(!items.length){const empty=el('div','empty');empty.append(el('h2','',library.length?'No matching issues.':'Your reading room is ready.'),el('p','',library.length?'Try another category, search or filter.':'Copy PDFs into your magazine folder. They appear automatically, with subfolders as categories.'));$('grid').append(empty);}
}
/** refresh: Support the PiShelf reader or library interface. */
async function refresh(quiet=false){
 if(syncing||!$('reader').hidden)return;syncing=true;if(!quiet)$('status').textContent='Scanning your PDF folder…';
 try{await saveChain;if(pendingSaves.size){for(const [id,patch] of [...pendingSaves])await persist(id,patch);if(pendingSaves.size)throw Error('Reading progress is waiting to sync.');}
 const [next,state,cats,shelves]=await Promise.all([api('/api/library'+(quiet?'':'?refresh=1')),api('/api/progress'),api('/api/categories'),api('/api/collections')]);const collectionsChanged=JSON.stringify(shelves)!==JSON.stringify(collections)||JSON.stringify(cats)!==JSON.stringify(categories);categories=cats;collections=shelves;collectionSets=new Map(collections.map(c=>[c.id,new Set(c.items)]));if(collectionFilter&&!collectionSets.has(collectionFilter))collectionFilter='';const changed=collectionsChanged||JSON.stringify(next)!==JSON.stringify(library)||JSON.stringify(state)!==JSON.stringify(saved);library=next;saved=state;
 if(changed||!quiet){if(category&&!categories.some(c=>c.path===category&&(!sourceFilter||c.source===sourceFilter)))category='';updateFilterOptions();drawLibrary();}$('status').textContent='';
 }catch(e){$('status').textContent=e.message||'Could not reach your Pi. Retrying…';}finally{syncing=false;}
}
/** clear Progress: Support the PiShelf reader or library interface. */
async function clearProgress(id){await saveChain;if(!await confirmAction(id?'Clear reading progress?':'Clear all reading progress?',id?'This issue will return to Unread. Its bookmarks and favourite status stay.':'This resets reading positions for the entire shared library. PDFs, bookmarks and favourites stay.','Clear progress'))return;try{await api('/api/progress/clear',id?{id}:{});if(id)pendingSaves.delete(id);else pendingSaves.clear();await refresh();toast('Reading progress cleared.');}catch(e){toast(e.message);}}
/** show Issue: Support the PiShelf reader or library interface. */
function showIssue(item){issueItem=item;$('issue-title').textContent=item.title;$('issue-info').textContent=item.path+' · '+fileSize(item.size);const box=$('issue-actions');box.replaceChildren();
 function action(label,fn,cls=''){const b=el('button',cls,label);b.onclick=async()=>{try{await fn();}catch(e){toast(e.message);}};box.append(b);}
 action(saved[item.id]?.page?'Continue reading':'Read magazine',()=>{$('issue-dialog').close();openMagazine(item);});
 action('Read from the beginning',()=>{$('issue-dialog').close();openMagazine(item,1);});
 const download=el('a','action-link','Download PDF');download.href=pdfURL(item)+'?download=1';download.download=item.title+'.pdf';box.append(download);
 action('Edit filename, category & tags',()=>{$('issue-dialog').close();openEdit(item);});
 action('Mark as finished',async()=>{await persist(item.id,{completed:true});$('issue-dialog').close();drawLibrary();});
 action('Clear reading progress',async()=>{$('issue-dialog').close();await clearProgress(item.id);});
 action('Delete permanently from storage…',async()=>{if(!await confirmAction('Delete PDF permanently?',`“${item.title}” will be deleted from your storage, along with its reading data and collection memberships. This cannot be undone.`,'Delete permanently'))return;await saveChain;if(pendingSaves.size)throw Error('Sync pending changes before deleting.');await api('/api/delete',{id:item.id,confirm:true});$('issue-dialog').close();await refresh();toast('PDF deleted from storage.');},'danger');
 action('Move to Trash…',async()=>{if(!await confirmAction('Move magazine to Trash?',`“${item.title}” will leave your library. You can restore it in Settings → Trash.`,'Move to Trash'))return;await saveChain;await api('/api/trash',{id:item.id});$('issue-dialog').close();await refresh();toast('Moved to Trash. Restore it from Settings.');},'danger');$('issue-dialog').showModal();
}
$('issue-close').onclick=()=>$('issue-dialog').close();
/** load Trash: Support the PiShelf reader or library interface. */
async function loadTrash(){try{const items=await api('/api/trash');$('trash-list').replaceChildren();if(!items.length)$('trash-list').append(el('p','hint','Trash is empty.'));for(const i of items){const row=el('div','trash-row'),text=el('div');text.append(el('strong','',i.title),el('small','',i.path));const b=el('button','','Restore');b.onclick=async()=>{b.disabled=true;try{await api('/api/trash/restore',{token:i.token});await loadTrash();await refresh();toast('Magazine restored.');}catch(e){toast(e.message);b.disabled=false;}};const remove=el('button','danger','Delete permanently');remove.onclick=async()=>{if(!await confirmAction('Delete trashed PDF permanently?',`“${i.title}” will be removed from storage. This cannot be undone.`,'Delete permanently'))return;try{await api('/api/trash/delete',{token:i.token,confirm:true});await loadTrash();await refresh();toast('PDF deleted from storage.');}catch(error){toast(error.message);}};row.append(text,b,remove);$('trash-list').append(row);}}catch(e){$('trash-list').textContent=e.message;}}
/** apply Prefs: Support the PiShelf reader or library interface. */
function applyPrefs(){const sortOptions=[...$('sort').options].map(o=>o.value);if(!sortOptions.includes(prefs.sort))prefs.sort=defaults.sort;$('sort').value=prefs.sort;document.body.dataset.theme=prefs.siteTheme==='system'?(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'):prefs.siteTheme;$('reader').dataset.pageTheme=prefs.theme;document.body.dataset.density=prefs.density;clearInterval(pollTimer);if(+prefs.interval>0)pollTimer=setInterval(()=>{if(!document.hidden)refresh(true);},+prefs.interval*1000);document.querySelector('footer').textContent=(+prefs.interval?`Checks for PDFs every ${prefs.interval} seconds`:'Manual folder refresh')+' · Your files, on your storage';}
/** store Prefs: Support the PiShelf reader or library interface. */
function storePrefs(){try{localStorage.setItem('pishelf-settings',JSON.stringify(prefs));}catch{toast('Browser settings storage is unavailable.');}applyPrefs();}
/** open Settings: Support the PiShelf reader or library interface. */
function openSettings(){for(const k of ['siteTheme','theme','mode','quality','density','interval'])$('pref-'+k).value=prefs[k];$('pref-motion').checked=prefs.motion;$('pref-gestures').checked=prefs.gestures;if(!uploading)populateUploadSources();drawCollectionManager();$('settings').showModal();loadTrash();}
$('settings-open').onclick=openSettings;$('reader-settings').onclick=openSettings;$('settings-close').onclick=()=>$('settings').close();
for(const k of ['siteTheme','theme','mode','quality','density','interval'])$('pref-'+k).onchange=e=>{prefs[k]=e.target.value;storePrefs();if(documentPDF&&(k==='mode'||k==='quality')){$('view-mode').value=prefs.mode;rebuild();}};
$('pref-gestures').onchange=e=>{prefs.gestures=e.target.checked;storePrefs();updateTouchMode();};
$('pref-motion').onchange=e=>{prefs.motion=e.target.checked;storePrefs();};$('clear-all').onclick=()=>{if(documentPDF){toast('Return to the library before clearing all progress.');return;}clearProgress();};$('rescan').onclick=()=>{if(documentPDF){toast('Return to the library to rescan.');return;}refresh();toast('Library scan requested.');};
// Continuous reader: lightweight page placeholders, serialized rendering, bounded canvas memory.
let slots=[],renderQueue=[],renderBusy=false,pageObserver=null;
const dimensions=new Map(),renderedSlots=new Set();
/** update Page UI: Keep the visible PDF page and navigation state in sync. */
function updatePageUI(){if(!documentPDF)return;$('page-number').value=page;$('page-total').textContent='/ '+documentPDF.numPages;$('prev').disabled=page<=1;$('next').disabled=page>=documentPDF.numPages;const marks=saved[current.id]?.bookmarks||[];$('bookmark').textContent=marks.includes(page)?'★':'☆';$('bookmark').setAttribute('aria-pressed',marks.includes(page));}
/** update Bookmarks: Support the PiShelf reader or library interface. */
function updateBookmarks(){const select=$('bookmarks');select.replaceChildren(new Option('Bookmarks',''));for(const n of saved[current.id]?.bookmarks||[])if(n<=documentPDF.numPages)select.add(new Option('Page '+n,n));}
/** remember: Support the PiShelf reader or library interface. */
function remember(){if(!documentPDF||!layoutReady||pinch)return;const patch={page,total:documentPDF.numPages,zoom,rotation,mode:$('view-mode').value},previous=saved[current.id]||{};if(Object.entries(patch).every(([k,v])=>previous[k]===v))return;persist(current.id,patch);}
/** page Width: Keep the visible PDF page and navigation state in sync. */
function pageWidth(){const available=Math.max(200,$('page-area').clientWidth-40);return Math.min(available,1100)*zoom;}
/** Initial zoom that fits the complete PDF page inside the reader viewport. */
function fitEntirePageZoom(n){
 const d=dimensions.get(n)||dimensions.get(1);
 if(!d)return 1;
 const area=$('page-area'),swapped=rotation%180!==0;
 const width=swapped?d.height:d.width,height=swapped?d.width:d.height;
 const availableWidth=Math.max(100,area.clientWidth-32);
 const availableHeight=Math.max(100,area.clientHeight-32);
 const baseWidth=Math.min(Math.max(200,area.clientWidth-40),1100);
 return Math.max(.1,Math.min(availableWidth/baseWidth,availableHeight*width/(baseWidth*height)));
}
/** size Slot: Support the PiShelf reader or library interface. */
function sizeSlot(slot,n){const d=dimensions.get(n)||dimensions.get(1)||{width:420,height:580};const swapped=rotation%180!==0;const w=swapped?d.height:d.width,h=swapped?d.width:d.height;slot.style.width=pageWidth()+'px';slot.style.height=pageWidth()*h/w+'px';}
/** enqueue: Manage PDF page rendering and canvas lifecycle. */
function enqueue(slot){
 if(!slot||!slot.isConnected||slot.dataset.ready==='yes'||slot.dataset.queued==='yes')return;
 slot.dataset.queued='yes';
 renderQueue.push({slot,g:generation,epoch:layoutEpoch});
 // Keep the page being read ahead of offscreen prefetch jobs.
 renderQueue.sort((a,b)=>Math.abs(Number(a.slot.dataset.page)-page)-Math.abs(Number(b.slot.dataset.page)-page));
 renderPages();
}
/** render Pages: Manage PDF page rendering and canvas lifecycle. */
async function renderPages(){
 if(renderBusy)return;renderBusy=true;
 try{while(renderQueue.length){
  const {slot,g,epoch}=renderQueue.shift();
  if(g!==generation||epoch!==layoutEpoch||!slot.isConnected||!documentPDF)continue;
  const n=+slot.dataset.page;
  try{
   const pdfPage=await documentPDF.getPage(n);
   if(g!==generation||epoch!==layoutEpoch||!slot.isConnected)continue;
   const natural=pdfPage.getViewport({scale:1});
   const area=$('page-area');
   const before=slot.getBoundingClientRect();
   const above=before.bottom<=area.getBoundingClientRect().top;
   dimensions.set(n,{width:natural.width,height:natural.height});
   sizeSlot(slot,n);
   if(above&&!pinch)area.scrollTop+=slot.getBoundingClientRect().height-before.height;
   const cssWidth=parseFloat(slot.style.width);
   const viewport=pdfPage.getViewport({scale:1,rotation});
   // Limit memory on phones while preserving extra detail for tablet screens.
   const maxPixels=matchMedia('(max-width: 700px)').matches?4500000:7000000;
   const scale=Math.min(cssWidth*Math.min(devicePixelRatio||1,2)/viewport.width,Math.sqrt(maxPixels/(viewport.width*viewport.height)));
   const view=pdfPage.getViewport({scale,rotation});
   const canvas=document.createElement('canvas');
   canvas.width=Math.max(1,Math.ceil(view.width));canvas.height=Math.max(1,Math.ceil(view.height));
   canvas.style.cssText='display:block;width:100%;height:100%';
   await pdfPage.render({canvasContext:canvas.getContext('2d',{alpha:false}),viewport:view}).promise;
   if(g!==generation||epoch!==layoutEpoch||!slot.isConnected){canvas.width=0;canvas.height=0;continue;}
   slot.replaceChildren(canvas);slot.dataset.ready='yes';slot.dataset.queued='no';renderedSlots.add(slot);trimCanvases();$('reader-status').textContent='';
  }catch(e){slot.dataset.queued='no';if(g===generation&&epoch===layoutEpoch){slot.replaceChildren(el('p','page-placeholder','Page '+n+' could not render.'));const retry=el('button','','Retry');retry.onclick=()=>enqueue(slot);slot.append(retry);$('reader-status').textContent='PDF rendering failed: '+e.message;}}
 }
 }finally{renderBusy=false;if(renderQueue.length)renderPages();}
}
/** trim Canvases: Manage PDF page rendering and canvas lifecycle. */
function trimCanvases(){if(pinch||Math.abs(zoom-cssZoomBase)>.01)return;const area=$('page-area').getBoundingClientRect();for(const slot of renderedSlots){const rect=slot.getBoundingClientRect();if(Math.abs(+slot.dataset.page-page)>2&&(rect.bottom<area.top||rect.top>area.bottom)){for(const c of slot.querySelectorAll('canvas')){c.width=0;c.height=0;}slot.replaceChildren(el('span','page-placeholder','Page '+slot.dataset.page));slot.dataset.ready='no';renderedSlots.delete(slot);}}}
/** track Scroll: Keep the visible PDF page and navigation state in sync. */
function trackScroll(){
 if(pinch||performance.now()<pinchScrollLockUntil||!layoutReady||!documentPDF||$('view-mode').value!=='scroll'||!slots.length)return;
 const area=$('page-area'),target=area.scrollTop+Math.min(area.clientHeight*.35,240);let low=0,high=slots.length-1;
 while(low<high){const mid=Math.ceil((low+high)/2);if(slots[mid].offsetTop<=target)low=mid;else high=mid-1;}
 const n=+slots[low].dataset.page;if(n!==page){page=n;updatePageUI();}
 for(let i=Math.max(0,low-2);i<slots.length&&slots[i].offsetTop<area.scrollTop+area.clientHeight+300;i++)enqueue(slots[i]);trimCanvases();
 clearTimeout(scrollTimer);scrollTimer=setTimeout(remember,750);
}
$('page-area').addEventListener('scroll',()=>{if(!scrollFrame)scrollFrame=requestAnimationFrame(()=>{scrollFrame=null;trackScroll();});},{passive:true});
/** rebuild: Manage PDF page rendering and canvas lifecycle. */
async function rebuild(){if(!documentPDF)return;$('pages').style.zoom='';$('pages').style.transform='';$('pages').style.transformOrigin='';cssZoomBase=zoom;updateTouchMode();const g=generation,epoch=++layoutEpoch;layoutReady=false;pageObserver?.disconnect();renderQueue=[];for(const c of $('pages').querySelectorAll('canvas')){c.width=0;c.height=0;}$('pages').replaceChildren();slots=[];renderedSlots.clear();
 if(g!==generation||epoch!==layoutEpoch)return;
 const single=$('view-mode').value==='single',count=documentPDF.numPages;const fragment=document.createDocumentFragment();for(let n=single?page:1;n<=(single?page:count);n++){const slot=el('div','pdf-slot');slot.dataset.page=n;slot.setAttribute('aria-label','PDF page '+n);sizeSlot(slot,n);slot.append(el('span','page-placeholder','Page '+n));slots.push(slot);fragment.append(slot);}$('pages').append(fragment);
 pageObserver=new IntersectionObserver(entries=>{for(const e of entries)if(e.isIntersecting)enqueue(e.target);},{root:$('page-area'),rootMargin:'500px'});slots.forEach(s=>pageObserver.observe(s));
 layoutReady=true;const target=slots.find(s=>+s.dataset.page===page);if(target){$('page-area').scrollTop=target.offsetTop-20;enqueue(target);}updatePageUI();updateBookmarks();remember();}
let pdfjsModulePromise;
/** pdf Engine: Support the PiShelf reader or library interface. */
async function pdfEngine(){
 if(!pdfjsModulePromise)pdfjsModulePromise=import('https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs').then(module=>{
  module.GlobalWorkerOptions.workerSrc='https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs';
  return module;
 });
 return pdfjsModulePromise;
}
/** open Magazine: Support the PiShelf reader or library interface. */
async function openMagazine(item,start){
 current=item;const g=++generation;const reading=saved[item.id]||{};
 zoom=1;rotation=reading.rotation||0;dimensions.clear();
 $('reader').hidden=false;document.body.classList.add('reader-open');setReaderFocus(true);
 $('library').hidden=true;$('reader-title').textContent=item.title;
 $('view-mode').value=reading.mode||prefs.mode;$('pages').replaceChildren();
 $('reader-status').textContent='Opening PDF…';
 try{
  const engine=await pdfEngine();
  const task=engine.getDocument({url:pdfURL(item),withCredentials:false});
  const doc=await task.promise;
  if(g!==generation){await doc.destroy();return;}
  documentPDF=doc;
  page=Math.max(1,Math.min(start||reading.page||1,doc.numPages));
  $('page-number').max=doc.numPages;
  // Load page dimensions once; page images are rendered only as needed.
  for(let n=1;n<=doc.numPages;n++){
   if(g!==generation)return;
   const p=await doc.getPage(n),v=p.getViewport({scale:1});
   dimensions.set(n,{width:v.width,height:v.height});
  }
  // Start with the entire page visible and a small margin on every side.
  zoom=fitEntirePageZoom(page);
  await rebuild();$('page-area').focus({preventScroll:true});
 }catch(e){if(g===generation)$('reader-status').textContent='Could not open PDF: '+e.message;}
}
/** move: Support the PiShelf reader or library interface. */
function move(n){if(!documentPDF)return;remember();page=Math.max(1,Math.min(documentPDF.numPages,n));updatePageUI();if($('view-mode').value==='single')rebuild();else{const slot=slots[page-1];enqueue(slot);$('page-area').scrollTo({top:slot.offsetTop-20,behavior:prefs.motion&&!matchMedia('(prefers-reduced-motion: reduce)').matches?'smooth':'auto'});clearTimeout(scrollTimer);scrollTimer=setTimeout(remember,500);}}
/** close Reader: Support the PiShelf reader or library interface. */
async function closeReader(){resetPinch();clearTimeout(scrollTimer);remember();++generation;++layoutEpoch;layoutReady=false;pageObserver?.disconnect();renderQueue=[];const oldDoc=documentPDF;documentPDF=null;if(oldDoc?.destroy)oldDoc.destroy().catch(()=>{});$('reader').hidden=true;document.body.classList.remove('reader-open');$('library').hidden=false;$('pages').replaceChildren();slots=[];renderedSlots.clear();if(document.fullscreenElement)document.exitFullscreen().catch(()=>{});drawLibrary();refresh(true);}
$('back').onclick=closeReader;$('prev').onclick=()=>move(page-1);$('next').onclick=()=>move(page+1);$('page-number').onchange=e=>move(parseInt(e.target.value)||1);
$('minus').onclick=()=>{zoom=Math.max(.5,zoom-.25);rebuild();};$('plus').onclick=()=>{zoom=Math.min(3,zoom+.25);rebuild();};$('fit').onclick=()=>{zoom=1;rebuild();};$('fit-page').onclick=()=>{if(!documentPDF)return;const d=dimensions.get(page)||dimensions.get(1);if(!d)return;const ratio=rotation%180?d.width/d.height:d.height/d.width;zoom=Math.max(.1,Math.min(1,($('page-area').clientHeight-20)/(Math.min(Math.max(200,$('page-area').clientWidth-40),1100)*ratio)));rebuild();};$('rotate').onclick=()=>{rotation=(rotation+90)%360;rebuild();};$('view-mode').onchange=()=>{prefs.mode=$('view-mode').value;storePrefs();rebuild();};
$('bookmark').onclick=()=>{if(!documentPDF)return;const marks=saved[current.id]?.bookmarks||[];persist(current.id,{bookmarks:marks.includes(page)?marks.filter(n=>n!==page):[...marks,page].sort((a,b)=>a-b)});updatePageUI();updateBookmarks();};$('bookmarks').onchange=e=>{if(e.target.value)move(+e.target.value);e.target.value='';};
$('fullscreen').onclick=async()=>{try{if(document.fullscreenElement)await document.exitFullscreen();else await $('reader').requestFullscreen();}catch{toast('Fullscreen is unavailable in this browser.');}};
let searchTimer;$('search').oninput=()=>{clearTimeout(searchTimer);searchTimer=setTimeout(()=>{visibleLimit=60;drawLibrary();},150);};$('sort').onchange=e=>{prefs.sort=e.target.value;storePrefs();drawLibrary();};$('refresh').onclick=()=>refresh();document.querySelectorAll('[data-filter]').forEach(b=>b.onclick=()=>{filter=b.dataset.filter;category=collectionFilter='';visibleLimit=60;document.querySelectorAll('.tab,.category').forEach(t=>t.classList.toggle('active',t===b));drawLibrary();});
document.addEventListener('keydown',e=>{if($('reader').hidden||document.querySelector('dialog[open]')||/INPUT|SELECT/.test(e.target.tagName))return;if(e.key==='ArrowRight'){e.preventDefault();move(page+1);}if(e.key==='ArrowLeft'){e.preventDefault();move(page-1);}if(e.key==='Escape'&&!document.fullscreenElement)closeReader();if(e.key.toLowerCase()==='b')$('bookmark').click();if(e.key.toLowerCase()==='c'){e.preventDefault();toggleReaderControls();}});
window.addEventListener('resize',()=>{clearTimeout(resizeTimer);resizeTimer=setTimeout(()=>{if(documentPDF){resetPinch();rebuild();}},250);});
document.addEventListener('visibilitychange',()=>{if(document.hidden)remember();else{for(const [id,patch] of [...pendingSaves])persist(id,patch);refresh(true);}});window.addEventListener('pagehide',remember);
// Library editing and backup controls.
let editing=null;
/** open Edit: Support the PiShelf reader or library interface. */
function openEdit(item){editing=item;$('edit-filename').value=item.path.split('/').pop();$('edit-series').value=item.series||'';$('edit-date').value=item.issueDate||'';$('edit-tags').value=(item.tags||[]).join(', ');$('edit-error').textContent='';$('edit-category').replaceChildren();for(const cat of categories.filter(c=>c.source===item.source))$('edit-category').add(new Option(cat.path==='.'?'Uncategorised':cat.path,cat.path));$('edit-category').value=item.category;$('edit-collection-options').replaceChildren();if(!collections.length)$('edit-collection-options').append(el('p','hint','Create a collection from the library sidebar first.'));for(const collection of collections){const label=el('label','check'),input=el('input');input.type='checkbox';input.value=collection.id;input.checked=collection.items.includes(item.id);label.append(input,document.createTextNode(collection.name));$('edit-collection-options').append(label);}$('edit-dialog').showModal();}
$('edit-close').onclick=()=>$('edit-dialog').close();
$('edit-form').onsubmit=async e=>{e.preventDefault();const button=e.submitter;button.disabled=true;try{await saveChain;if(pendingSaves.size)throw Error('Wait until reading progress has synced before renaming.');await api('/api/issue/edit',{id:editing.id,filename:$('edit-filename').value.trim(),series:$('edit-series').value.trim(),issueDate:$('edit-date').value.trim(),category:$('edit-category').value,collectionIds:[...document.querySelectorAll('#edit-collection-options input:checked')].map(i=>i.value),tags:$('edit-tags').value.split(',').map(t=>t.trim()).filter(Boolean)});$('edit-dialog').close();await refresh();toast('Issue updated. Bookmarks and progress retained.');}catch(error){$('edit-error').textContent=error.message;}finally{button.disabled=false;}};
$('category-create').onclick=()=>{$('category-source').value=sourceFilter||'magazines';$('category-error').textContent='';$('category-name').value='';$('category-dialog').showModal();};
$('category-close').onclick=()=>$('category-dialog').close();
$('category-form').onsubmit=async e=>{e.preventDefault();e.submitter.disabled=true;try{await api('/api/categories',{source:$('category-source').value,path:$('category-name').value.trim()});$('category-dialog').close();await refresh();toast('Category created. Move issues into it using Edit issue.');}catch(error){$('category-error').textContent=error.message;}finally{e.submitter.disabled=false;}};
$('source-filter').onchange=e=>{sourceFilter=e.target.value;category='';seriesFilter='';visibleLimit=60;updateFilterOptions();drawLibrary();};
$('series-filter').onchange=e=>selectSeries(e.target.value);$('tag-filter').onchange=e=>selectTag(e.target.value);
$('filters-clear').onclick=()=>{sourceFilter=seriesFilter=tagFilter=category=collectionFilter='';filter='all';$('source-filter').value='';$('search').value='';visibleLimit=60;document.querySelectorAll('.tab').forEach(b=>b.classList.toggle('active',b.dataset.filter==='all'));updateFilterOptions();drawLibrary();};
$('load-more').onclick=()=>{visibleLimit+=60;drawLibrary();};
$('backup-export').onclick=async()=>{try{if(documentPDF)remember();await saveChain;if(pendingSaves.size)throw Error('Reconnect and sync your reading progress before backing up.');const data=await api('/api/backup');data.preferences={...prefs};const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));const link=el('a');link.href=url;link.download='pishelf-backup-'+new Date().toISOString().slice(0,10)+'.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);toast('Reading backup downloaded. Back up PDF folders separately.');}catch(error){toast(error.message);}};
$('backup-import').onclick=()=>{if(documentPDF){toast('Return to the library before restoring a backup.');return;}$('backup-file').click();};
$('backup-file').onchange=async e=>{const file=e.target.files[0];e.target.value='';if(!file)return;try{if(file.size>5*1024*1024)throw Error('Backup must be under 5 MB.');const data=JSON.parse(await file.text());if(data.format!=='pishelf-backup'||data.version!==1)throw Error('Select a PiShelf reading backup.');if(!await confirmAction('Restore reading backup?','Matching reading records and metadata will be replaced. Other records and your PDFs are kept.','Restore backup'))return;await saveChain;if(pendingSaves.size)throw Error('Sync pending reading progress before restoring.');await api('/api/backup/restore',data);if(data.preferences){for(const key in defaults){const value=data.preferences[key];if(key==='motion'||key==='gestures'){if(typeof value==='boolean')prefs[key]=value;}else if(key==='sort'){if([...$('sort').options].some(o=>o.value===value))prefs.sort=value;}else if($('pref-'+key)&&[...$('pref-'+key).options].some(o=>o.value===value))prefs[key]=value;}storePrefs();}await refresh();toast('Backup restored.');}catch(error){toast(error.message);}};
// Uploads stream one File at a time; the browser never reads the entire file into JS memory.
let uploadXHR=null,uploading=false,uploadCancelled=false;
/** populate Upload Sources: Support the PiShelf reader or library interface. */
function populateUploadSources(){const selected=$('upload-source').value;const sources=[...new Set(categories.map(c=>c.source))];$('upload-source').replaceChildren(...sources.map(s=>new Option(s==='newspapers'?'Newspapers':'Magazines',s)));if(sources.includes(selected))$('upload-source').value=selected;populateUploadCategories();}
/** populate Upload Categories: Support the PiShelf reader or library interface. */
function populateUploadCategories(){const source=$('upload-source').value;$('upload-category').replaceChildren(...categories.filter(c=>c.source===source).map(c=>new Option(c.path==='.'?'Uncategorised':c.path,c.path)));}
$('upload-source').onchange=populateUploadCategories;
/** upload File: Support the PiShelf reader or library interface. */
function uploadFile(file,source,category){return new Promise((resolve,reject)=>{const xhr=uploadXHR=new XMLHttpRequest();xhr.open('POST','/api/upload?'+new URLSearchParams({source,category,filename:file.name}));xhr.setRequestHeader('Content-Type','application/pdf');xhr.upload.onprogress=e=>{if(e.lengthComputable)$('upload-progress').value=Math.round(e.loaded/e.total*100);};xhr.onload=()=>{let result;try{result=JSON.parse(xhr.responseText);}catch{}if(xhr.status>=200&&xhr.status<300)resolve(result);else reject(Error(result?.error||'Upload failed. Check the server or proxy upload limit.'));};xhr.onerror=()=>reject(Error('Upload connection failed.'));xhr.onabort=()=>reject(Error('Upload cancelled.'));xhr.send(file);});}
$('upload-cancel').onclick=()=>{uploadCancelled=true;uploadXHR?.abort();};
$('upload-start').onclick=async()=>{if(uploading)return;if(documentPDF){toast('Return to the library before uploading PDFs.');return;}const files=[...$('upload-files').files];if(!files.length){toast('Choose one or more PDFs first.');return;}if(files.some(f=>!f.name.toLowerCase().endsWith('.pdf')||f.size===0||f.size>512*1024*1024)){toast('Choose PDF files up to 512 MiB each.');return;}uploading=true;uploadCancelled=false;$('upload-start').disabled=true;$('upload-files').disabled=true;$('upload-source').disabled=true;$('upload-category').disabled=true;$('upload-cancel').hidden=false;$('upload-progress').hidden=false;const source=$('upload-source').value,category=$('upload-category').value;let completed=0;try{for(const file of files){if(uploadCancelled)break;$('upload-status').textContent=`Uploading ${completed+1}/${files.length}: ${file.name}`;$('upload-progress').value=0;await uploadFile(file,source,category);completed++;}$('upload-status').textContent=`${completed} PDF${completed===1?'':'s'} uploaded.`;}catch(error){$('upload-status').textContent=`${completed} uploaded. ${error.message}`;}finally{uploading=false;uploadXHR=null;$('upload-start').disabled=false;$('upload-files').disabled=false;$('upload-source').disabled=false;$('upload-category').disabled=false;$('upload-cancel').hidden=true;$('upload-progress').hidden=true;if(completed===files.length)$('upload-files').value='';await refresh();}};
$('collection-create').onclick=()=>{$('collection-name').value='';$('collection-error').textContent='';$('collection-dialog').showModal();};
$('collection-close').onclick=()=>$('collection-dialog').close();
$('collection-form').onsubmit=async e=>{e.preventDefault();e.submitter.disabled=true;try{await api('/api/collections',{name:$('collection-name').value});$('collection-dialog').close();await refresh();toast('Collection created. Add issues through their Edit options.');}catch(error){$('collection-error').textContent=error.message;}finally{e.submitter.disabled=false;}};
/** reload Collections: Support the PiShelf reader or library interface. */
async function reloadCollections(){collections=await api('/api/collections');collectionSets=new Map(collections.map(c=>[c.id,new Set(c.items)]));if(collectionFilter&&!collectionSets.has(collectionFilter))collectionFilter='';updateFilterOptions();if($('reader').hidden)drawLibrary();drawCollectionManager();}
/** draw Collection Manager: Support the PiShelf reader or library interface. */
function drawCollectionManager(){const box=$('collection-manager');box.replaceChildren();if(!collections.length)box.append(el('p','hint','Create a collection in the library sidebar, then add issues using Edit issue.'));for(const collection of collections){const row=el('div','collection-row'),input=el('input');input.value=collection.name;input.maxLength=80;input.setAttribute('aria-label','Collection name: '+collection.name);const save=el('button','','Rename'),remove=el('button','danger','Remove');save.onclick=async()=>{try{await api('/api/collections',{action:'rename',id:collection.id,name:input.value});await reloadCollections();}catch(error){toast(error.message);}};remove.onclick=async()=>{if(!await confirmAction('Remove collection?','Only this shelf is removed. Your PDFs and reading progress are kept.','Remove collection'))return;try{await api('/api/collections',{action:'delete',id:collection.id});await reloadCollections();}catch(error){toast(error.message);}};row.append(input,save,remove);box.append(row);}}
// Double-tap controls remain available even when swipe/pinch gestures are disabled.
const gesturePointers=new Set();let gestureStart=null,lastTap=null,lastTouchTime=-Infinity,pinch=null,pinchFrame=0,suppressTapUntil=0;
/** update Touch Mode: Handle touch zoom while maintaining the reader position. */
function updateTouchMode(){$('page-area').classList.toggle('gesture-navigation',!!prefs.gestures&&zoom<=1);}
/** toggle Reader Controls: Support the PiShelf reader or library interface. */
function toggleReaderControls(){setReaderFocus(!$('reader').classList.contains('focused'));}
/** touch Pair: Handle touch zoom while maintaining the reader position. */
function touchPair(touches){const a=touches[0],b=touches[1];return {distance:Math.hypot(a.clientX-b.clientX,a.clientY-b.clientY),x:(a.clientX+b.clientX)/2,y:(a.clientY+b.clientY)/2};}
/** reset Pinch: Handle touch zoom while maintaining the reader position. */
function resetPinch(){cancelAnimationFrame(pinchFrame);pinchFrame=0;$('pages').style.transform='';$('pages').style.transformOrigin='';$('pages').style.willChange='';pinch=null;}
/** finish Pinch: Handle touch zoom while maintaining the reader position. */
// Ignore scroll-based page detection while a pinch settles on mobile Safari.
let pinchScrollLockUntil=0;
/** Finish pinch without destroying canvases or changing the selected PDF page. */
function finishPinch(cancelled=false){
 if(!pinch)return;
 const state=pinch;
 resetPinch();
 pinchScrollLockUntil=performance.now()+700;
 suppressTapUntil=performance.now()+500;
 lastTap=null;gestureStart=null;gesturePointers.clear();
 if(cancelled||!documentPDF||state.g!==generation)return;
 const next=Math.max(fitEntirePageZoom(state.page),Math.round(state.nextZoom*100)/100);
 if(Math.abs(next-zoom)<.01)return;
 const slot=slots.find(s=>+s.dataset.page===state.page),area=$('page-area');
 if(!slot)return;
 zoom=next;page=state.page;
 // CSS zoom reuses the existing high-resolution canvas instead of rebuilding.
 $('pages').style.zoom=String(zoom/cssZoomBase);
 const after=slot.getBoundingClientRect();
 area.scrollLeft+=after.left+state.fx*after.width-state.x;
 area.scrollTop+=after.top+state.fy*after.height-state.y;
 // A zoomed page wider than the viewport must cover it horizontally:
 // never leave a large blank gutter when the pinch midpoint moves.
 const viewport=area.getBoundingClientRect();
 const pageRect=slot.getBoundingClientRect();
 if(pageRect.width>=viewport.width){
  if(pageRect.left>viewport.left)area.scrollLeft+=pageRect.left-viewport.left;
  else if(pageRect.right<viewport.right)area.scrollLeft-=viewport.right-pageRect.right;
 }
 updateTouchMode();updatePageUI();remember();
}
$('page-area').addEventListener('touchstart',e=>{
 if(e.touches.length!==2||!prefs.gestures||!documentPDF||!layoutReady)return;
 e.preventDefault();lastTap=null;gestureStart=null;clearTimeout(scrollTimer);
 const point=touchPair(e.touches),area=$('page-area'),rect=area.getBoundingClientRect();
 const slot=slots.find(s=>{const r=s.getBoundingClientRect();return point.x>=r.left&&point.x<=r.right&&point.y>=r.top&&point.y<=r.bottom;})||slots.find(s=>+s.dataset.page===page);
 if(!slot||point.distance<10)return;const r=slot.getBoundingClientRect();
 pinch={g:generation,distance:point.distance,startZoom:zoom,nextZoom:zoom,page:+slot.dataset.page,fx:Math.max(0,Math.min(1,(point.x-r.left)/r.width)),fy:Math.max(0,Math.min(1,(point.y-r.top)/r.height)),x:point.x,y:point.y,startX:point.x,startY:point.y};
 $('pages').style.transformOrigin=`${point.x-$('pages').getBoundingClientRect().left}px ${point.y-$('pages').getBoundingClientRect().top}px`;$('pages').style.willChange='transform';
},{passive:false});
$('page-area').addEventListener('touchmove',e=>{
 if(!pinch)return;e.preventDefault();if(e.touches.length!==2)return;
 const point=touchPair(e.touches);pinch.nextZoom=Math.max(fitEntirePageZoom(pinch.page),Math.min(3,pinch.startZoom*point.distance/pinch.distance));pinch.x=point.x;pinch.y=point.y;
 if(!pinchFrame)pinchFrame=requestAnimationFrame(()=>{pinchFrame=0;if(pinch)$('pages').style.transform=`translate(${pinch.x-pinch.startX}px, ${pinch.y-pinch.startY}px) scale(${pinch.nextZoom/pinch.startZoom})`;});
},{passive:false});
$('page-area').addEventListener('touchend',e=>{if(pinch&&e.touches.length<2){e.preventDefault();finishPinch();}},{passive:false});
$('page-area').addEventListener('touchcancel',()=>finishPinch(true),{passive:true});
$('page-area').addEventListener('pointerdown',e=>{if(e.pointerType!=='touch')return;lastTouchTime=performance.now();gesturePointers.add(e.pointerId);if(gesturePointers.size===1)gestureStart={x:e.clientX,y:e.clientY,time:performance.now(),multi:false};else if(gestureStart)gestureStart.multi=true;},{passive:true});
$('page-area').addEventListener('pointercancel',e=>{gesturePointers.delete(e.pointerId);gestureStart=null;lastTap=null;},{passive:true});
$('page-area').addEventListener('pointerup',e=>{
 gesturePointers.delete(e.pointerId);if(e.pointerType!=='touch'||pinch||performance.now()<suppressTapUntil||!gestureStart||gestureStart.multi||gesturePointers.size)return;
 const start=gestureStart;gestureStart=null;const dx=e.clientX-start.x,dy=e.clientY-start.y,elapsed=performance.now()-start.time;
 if(prefs.gestures&&documentPDF&&zoom<=1&&Math.abs(dx)>70&&Math.abs(dx)>Math.abs(dy)*2&&elapsed<700){move(page+(dx<0?1:-1));lastTap=null;return;}
 if(Math.hypot(dx,dy)<18&&elapsed<300){const now=performance.now();if(lastTap&&now-lastTap.time<320&&Math.hypot(e.clientX-lastTap.x,e.clientY-lastTap.y)<35){toggleReaderControls();lastTap=null;}else lastTap={time:now,x:e.clientX,y:e.clientY};}else lastTap=null;
},{passive:true});
$('page-area').addEventListener('dblclick',e=>{if(performance.now()-lastTouchTime>600){e.preventDefault();toggleReaderControls();}});
$('reader-accessibility-controls').onclick=toggleReaderControls;
/** set Reader Focus: Support the PiShelf reader or library interface. */
function setReaderFocus(focused){$('reader').classList.toggle('focused',focused);$('reader-accessibility-controls').setAttribute('aria-expanded',String(!focused));if(focused&&$('reader').contains(document.activeElement))$('page-area').focus({preventScroll:true});}
$('reader-focus').onclick=()=>setReaderFocus(true);
matchMedia('(prefers-color-scheme: dark)').addEventListener('change',()=>{if(prefs.siteTheme==='system')applyPrefs();});
applyPrefs();refresh();
