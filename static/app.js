/* PiShelf browser client — navigation guide
 *
 * Find these named functions to work on a feature:
 *   Library: refresh(), drawLibrary(), cardFor(), updateFilterOptions()
 *   Settings: applyPrefs(), openSettings(), storePrefs()
 *   Reader: openMagazine(), rebuild(), move(), closeReader()
 *   WebP / memory: renderPages(), preloadMagazineNeighbors(),
 *                  cancelAllSharpImages(), trimCanvases()
 *   Navigation: trackScroll(), showThumbnailRange(), updatePageUI()
 *   State: persist(), remember(), clearProgress()
 *
 * Invariants:
 * - Keep pinch/gesture coordinate math untouched when tuning image loading.
 * - Each async image response checks generation/layoutEpoch before displaying.
 * - Release decoded offscreen images; never release during an active pinch.
 * - A missing optional control must not prevent refresh() from starting.
 */
const $=id=>document.getElementById(id);
const defaults={sort:'issue',siteTheme:'light',theme:'dark',mode:'scroll',quality:'1.5',density:'compact',gestures:true,readerBrightness:75,comfort:'custom',epubTheme:'light',epubFontSize:100};
let prefs={...defaults};try{const stored=JSON.parse(localStorage.getItem('pishelf-settings')||'{}');for(const k in defaults)if(k in stored)prefs[k]=stored[k];}catch{}
let collections=[],collectionFilter='',collectionSets=new Map();
let categories=[],sourceFilter='',seriesFilter='',tagFilter='',visibleLimit=60;
let library=[],saved={},filter='all',category='',syncing=false,current=null,documentPDF=null,page=1,zoom=1,rotation=0,generation=0,layoutEpoch=0,layoutReady=false;
let cssZoomBase=1;
let saveChain=Promise.resolve(),toastTimer,scrollTimer,resizeTimer,scrollFrame,issueItem;
const pendingSaves=new Map();
/** el: Support the PiShelf reader or library interface. */
function el(tag,cls,text){const n=document.createElement(tag);if(cls)n.className=cls;if(text)n.textContent=text;return n;}
/** toast: Support the PiShelf reader or library interface. */
function toast(message){$('toast').textContent=message;$('toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').hidden=true,5000);}
/** api: Support the PiShelf reader or library interface. */
let signedInUser=null;
async function api(path,data){
 const body=data===undefined?null:JSON.stringify(data);
 const options=body===null?{}:{method:'POST',headers:{'Content-Type':'application/json','X-PiShelf-CSRF':signedInUser?.csrf||''},body,keepalive:body.length<60000};
 const r=await fetch(path,options);
 if(r.status===401){location.replace('/login.html');throw Error('Session expired. Sign in again.');}
 let value;try{value=await r.json();}catch{throw Error('Could not reach PiShelf. Check the connection.');}
 if(!r.ok)throw Error(value.error||'Request failed.');
 return value;
}
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
const isEpub=item=>item.format==='epub'||item.path.toLowerCase().endsWith('.epub');
const started=i=>!!(saved[i.id]?.page||saved[i.id]?.epubCfi);
const finished=i=>!!saved[i.id]?.completed||(!!saved[i.id]?.total&&saved[i.id]?.total>1&&saved[i.id]?.page>=saved[i.id]?.total);
const itemKind=i=>i.source==='books'?'Book':i.source==='newspapers'?'Newspaper':'Magazine';
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
   // EPUB falls back to its title placeholder when no cover is embedded.
  try{
   const key=item.coverKey;let data=thumbs.get(key);
   if(!data){
    let response=await fetch(coverURL(item));
    if(response.status===404){
     // The old /api/render-page route does not exist. Use the supported
     // WebP first-page renderer for every PDF source (including newspapers
     // and PDF books), and the embedded-cover endpoint for EPUB books.
     const fallback=isEpub(item)
      ?'/api/epub-cover/'+encodeURIComponent(item.id)
      :'/api/page-image/'+encodeURIComponent(item.id)+'/1?width=400';
     response=await fetch(fallback);
    }
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
 const s=saved[item.id]||{},card=el('article','card'),cover=el('button','cover');cover.setAttribute('aria-label','Read '+item.title);cover.append(el('span','placeholder',item.title));cover.onclick=()=>openDocument(item);cover.item=item;if(isEpub(item))cover.classList.add('epub-cover');
 const heading=el('div','card-head');heading.append(el('h2','',item.source==='books'?item.title:dateLabel(item)||item.title));const star=el('button','favorite',s.favorite?'★':'☆');star.setAttribute('aria-label','Favourite '+item.title);star.setAttribute('aria-pressed',!!s.favorite);star.onclick=()=>{persist(item.id,{favorite:!saved[item.id]?.favorite});drawLibrary();};heading.append(star);
 const more=el('button','more','•••');more.setAttribute('aria-label','Options for '+item.title);more.onclick=()=>showIssue(item);heading.append(more);
 const seriesButton=el('button','series-link',item.series||item.title);seriesButton.onclick=()=>selectSeries(item.series||item.title);card.append(cover,seriesButton,heading);const chips=el('div','tag-chips');for(const tag of item.tags||[]){const b=el('button','tag-chip',tag);b.onclick=()=>selectTag(tag);chips.append(b);}card.append(chips);
 card.append(el('div','meta',finished(item)?'Finished':s.epubCfi&&isEpub(item)?`EPUB · ${s.page&&s.total?Math.round(s.page/s.total*100)+'%':'Reading'}`:s.page?`Page ${s.page} of ${s.total}`:`${item.category==='.'?itemKind(item):item.category} · ${item.format.toUpperCase()} · ${fileSize(item.size)}`));
 if(s.page||s.epubCfi||s.completed){const bar=el('div','progress'),fill=el('span');fill.style.width=(finished(item)?100:Math.min(100,(s.page||0)/(s.total||1)*100))+'%';bar.append(fill);card.append(bar);}target.append(card);coverObserver.observe(cover);
}
/** draw Library: Support the PiShelf reader or library interface. */
// === Library grid ===========================================================
// Only create cards for the current visibleLimit; covers are loaded lazily.
function drawLibrary(){
 coverObserver.disconnect();coverQueue=[];$('grid').replaceChildren();$('resume-grid').replaceChildren();$('count').textContent=library.length;
 $('shelf-label').textContent=collections.find(c=>c.id===collectionFilter)?.name||category||({all:'All publications',reading:'Continue reading',favorites:'Favourites',unread:'Unread',completed:'Finished'}[filter]);
 const q=$('search').value.trim().toLowerCase();const terms=q.split(/\s+/).filter(Boolean);const items=library.filter(i=>(!collectionFilter||collectionSets.get(collectionFilter)?.has(i.id))&&(!sourceFilter||i.source===sourceFilter)&&(!seriesFilter||i.series===seriesFilter)&&(!tagFilter||(i.tags||[]).includes(tagFilter))&&(!category||i.category===category)&&terms.every(term=>(i.title+' '+i.series+' '+dateLabel(i)+' '+i.issueDate+' '+i.category+' '+(i.tags||[]).join(' ')).toLowerCase().includes(term))).filter(i=>filter==='all'||filter==='favorites'&&saved[i.id]?.favorite||filter==='reading'&&started(i)&&!finished(i)||filter==='unread'&&!started(i)&&!finished(i)||filter==='completed'&&finished(i));
 const order=filter==='reading'?'recent':$('sort').value;items.sort((a,b)=>order==='title'?a.title.localeCompare(b.title):order==='recent'?(saved[b.id]?.lastRead||0)-(saved[a.id]?.lastRead||0):order==='size'?b.size-a.size:order==='issue'?(b.issueDate||'').localeCompare(a.issueDate||'')||b.modified-a.modified:b.modified-a.modified);
 items.slice(0,visibleLimit).forEach(i=>cardFor(i,$('grid')));$('load-more').hidden=items.length<=visibleLimit;$('active-filters').textContent=[collections.find(c=>c.id===collectionFilter)?.name,sourceFilter,seriesFilter,tagFilter&&'#'+tagFilter,category,`${items.length} items`].filter(Boolean).join(' · ');
 const recent=library.filter(i=>started(i)&&!finished(i)).sort((a,b)=>(saved[b.id].lastRead||0)-(saved[a.id].lastRead||0)).slice(0,6);
 $('resume-section').hidden=filter!=='all'||!!category||!!q||!!sourceFilter||!!seriesFilter||!!tagFilter||!!collectionFilter||!recent.length;if(!$('resume-section').hidden)recent.forEach(i=>cardFor(i,$('resume-grid')));
 if(!items.length){const empty=el('div','empty');empty.append(el('h2','',library.length?'No matching items.':'Your reading room is ready.'),el('p','',library.length?'Try another category, search or filter.':'Copy PDFs or EPUB books into your configured library folders. Subfolders become categories.'));$('grid').append(empty);}
}
/** refresh: Support the PiShelf reader or library interface. */
// === Library refresh =======================================================
// The explicit refresh=1 query requests a filesystem rescan on page reload.
// Keep this independent of optional Settings controls (see PR #24).
async function refresh(quiet=false){
 if(syncing||!$('reader').hidden||!$('epub-reader').hidden)return;syncing=true;if(!quiet)$('status').textContent='Scanning your library folders…';
 try{await saveChain;if(pendingSaves.size){for(const [id,patch] of [...pendingSaves])await persist(id,patch);if(pendingSaves.size)throw Error('Reading progress is waiting to sync.');}
 const [next,state,cats,shelves]=await Promise.all([api('/api/library?refresh=1'),api('/api/progress'),api('/api/categories'),api('/api/collections')]);const collectionsChanged=JSON.stringify(shelves)!==JSON.stringify(collections)||JSON.stringify(cats)!==JSON.stringify(categories);categories=cats;collections=shelves;collectionSets=new Map(collections.map(c=>[c.id,new Set(c.items)]));if(collectionFilter&&!collectionSets.has(collectionFilter))collectionFilter='';const changed=collectionsChanged||JSON.stringify(next)!==JSON.stringify(library)||JSON.stringify(state)!==JSON.stringify(saved);library=next;saved=state;
 if(changed||!quiet){if(category&&!categories.some(c=>c.path===category&&(!sourceFilter||c.source===sourceFilter)))category='';updateFilterOptions();drawLibrary();}$('status').textContent='';
 }catch(e){$('status').textContent=e.message||'Could not reach your Pi. Retrying…';}finally{syncing=false;}
}
/** clear Progress: Support the PiShelf reader or library interface. */
async function clearProgress(id){await saveChain;if(!await confirmAction(id?'Clear reading progress?':'Clear all reading progress?',id?'This issue will return to Unread. Its bookmarks and favourite status stay.':'This resets reading positions for the entire shared library. PDFs, bookmarks and favourites stay.','Clear progress'))return;try{await api('/api/progress/clear',id?{id}:{});if(id)pendingSaves.delete(id);else pendingSaves.clear();await refresh();toast('Reading progress cleared.');}catch(e){toast(e.message);}}
/** show Issue: Support the PiShelf reader or library interface. */
function showIssue(item){issueItem=item;$('issue-title').textContent=item.title;$('issue-info').textContent=item.path+' · '+fileSize(item.size);const box=$('issue-actions');box.replaceChildren();
 function action(label,fn,cls=''){const b=el('button',cls,label);b.onclick=async()=>{try{await fn();}catch(e){toast(e.message);}};box.append(b);}
 action(started(item)?'Continue reading':'Read '+itemKind(item).toLowerCase(),()=>{$('issue-dialog').close();openDocument(item);});
 action('Read from the beginning',()=>{$('issue-dialog').close();openDocument(item,1);});
 const download=el('a','action-link','Download '+item.format.toUpperCase());download.href=pdfURL(item)+'?download=1';download.download=item.title+'.'+item.format;box.append(download);
 action('Edit filename, category & tags',()=>{$('issue-dialog').close();openEdit(item);});
 action('Mark as finished',async()=>{await persist(item.id,{completed:true});$('issue-dialog').close();drawLibrary();});
 action('Clear reading progress',async()=>{$('issue-dialog').close();await clearProgress(item.id);});
 action('Delete permanently from storage…',async()=>{if(!await confirmAction('Delete PDF permanently?',`“${item.title}” will be deleted from your storage, along with its reading data and collection memberships. This cannot be undone.`,'Delete permanently'))return;await saveChain;if(pendingSaves.size)throw Error('Sync pending changes before deleting.');await api('/api/delete',{id:item.id,confirm:true});$('issue-dialog').close();await refresh();toast('PDF deleted from storage.');},'danger');
 action('Move to Trash…',async()=>{if(!await confirmAction('Move document to Trash?',`“${item.title}” will leave your library. You can restore it in Settings → Trash.`,'Move to Trash'))return;await saveChain;await api('/api/trash',{id:item.id});$('issue-dialog').close();await refresh();toast('Moved to Trash. Restore it from Settings.');},'danger');$('issue-dialog').showModal();
}
$('issue-close').onclick=()=>$('issue-dialog').close();
/** load Trash: Support the PiShelf reader or library interface. */
async function loadTrash(){try{const items=await api('/api/trash');$('trash-list').replaceChildren();if(!items.length)$('trash-list').append(el('p','hint','Trash is empty.'));for(const i of items){const row=el('div','trash-row'),text=el('div');text.append(el('strong','',i.title),el('small','',i.path));const b=el('button','','Restore');b.onclick=async()=>{b.disabled=true;try{await api('/api/trash/restore',{token:i.token});await loadTrash();await refresh();toast('Magazine restored.');}catch(e){toast(e.message);b.disabled=false;}};const remove=el('button','danger','Delete permanently');remove.onclick=async()=>{if(!await confirmAction('Delete trashed PDF permanently?',`“${i.title}” will be removed from storage. This cannot be undone.`,'Delete permanently'))return;try{await api('/api/trash/delete',{token:i.token,confirm:true});await loadTrash();await refresh();toast('PDF deleted from storage.');}catch(error){toast(error.message);}};row.append(text,b,remove);$('trash-list').append(row);}}catch(e){$('trash-list').textContent=e.message;}}
/** apply Prefs: Support the PiShelf reader or library interface. */
function applyPrefs(){const sortOptions=[...$('sort').options].map(o=>o.value);if(!sortOptions.includes(prefs.sort))prefs.sort=defaults.sort;$('sort').value=prefs.sort;document.body.dataset.theme=prefs.siteTheme==='system'?(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'):prefs.siteTheme;$('reader').dataset.pageTheme=prefs.theme;document.body.dataset.density=prefs.density;const brightness=Math.max(35,Math.min(100,Number(prefs.readerBrightness)||75));$('reader').style.setProperty('--reader-brightness',String(brightness/100));$('reader-night-toggle').setAttribute('aria-pressed',String(prefs.theme==='night'||prefs.theme==='amoled'));$('reader-night-toggle').textContent=prefs.theme==='night'||prefs.theme==='amoled'?'☀ Day':'☾ Night';document.querySelector('footer').textContent='PDF library updates when the page reloads · Your files, on your storage';}
/** store Prefs: Support the PiShelf reader or library interface. */
function storePrefs(){try{localStorage.setItem('pishelf-settings',JSON.stringify(prefs));}catch{toast('Browser settings storage is unavailable.');}applyPrefs();}
/** open Settings: Support the PiShelf reader or library interface. */
function openSettings(){$('pref-comfort').value=prefs.comfort||'custom';$('pref-readerBrightness').value=prefs.readerBrightness;$('reader-brightness-value').textContent=prefs.readerBrightness+'%';for(const k of ['siteTheme','theme','mode','quality','density'])$('pref-'+k).value=prefs[k];$('pref-gestures').checked=prefs.gestures;if(!uploading)populateUploadSources();drawCollectionManager();drawCategoryManager();activateSettingsTab('upload');prepareFolderPathSettings();$('settings').showModal();loadTrash();loadWebPCacheStats();}
// Reading comfort presets are display-only and never alter PDF bytes.
const comfortPresets={daylight:{theme:'light',readerBrightness:100},bedtime:{theme:'night',readerBrightness:55},amoled:{theme:'amoled',readerBrightness:80}};
$('pref-comfort').onchange=e=>{
 const name=e.target.value;
 if(comfortPresets[name]){
  Object.assign(prefs,comfortPresets[name]);
  $('pref-theme').value=prefs.theme;
  $('pref-readerBrightness').value=prefs.readerBrightness;
  $('reader-brightness-value').textContent=prefs.readerBrightness+'%';
 }
 prefs.comfort=name;
 storePrefs();
};
// Quick night mode preserves the previous daytime theme when toggled off.
let lastDayTheme=['light','sepia','dark'].includes(prefs.theme)?prefs.theme:'light';
$('reader-night-toggle').onclick=()=>{
 if(prefs.theme==='night'||prefs.theme==='amoled')prefs.theme=lastDayTheme;
 else{lastDayTheme=prefs.theme;prefs.theme='night';}
 prefs.comfort='custom';storePrefs();
};
$('pref-readerBrightness').oninput=e=>{
 prefs.readerBrightness=Math.max(35,Math.min(100,Number(e.target.value)||75));prefs.comfort='custom';$('pref-comfort').value='custom';
 $('reader-brightness-value').textContent=prefs.readerBrightness+'%';
 applyPrefs();
};
$('pref-readerBrightness').onchange=()=>storePrefs();
$('settings-open').onclick=openSettings;$('reader-settings').onclick=openSettings;$('settings-close').onclick=()=>{folderAccessPin='';$('settings').close();};
for(const k of ['siteTheme','theme','mode','quality','density'])$('pref-'+k).onchange=e=>{prefs[k]=e.target.value;if(k==='theme'){prefs.comfort='custom';$('pref-comfort').value='custom';}if(k==='theme'&&['light','sepia','dark'].includes(prefs.theme))lastDayTheme=prefs.theme;storePrefs();if(documentPDF&&(k==='mode'||k==='quality')){$('view-mode').value=prefs.mode;rebuild();}};
$('pref-gestures').onchange=e=>{prefs.gestures=e.target.checked;storePrefs();updateTouchMode();};
$('clear-all').onclick=()=>{if(documentPDF){toast('Return to the library before clearing all progress.');return;}clearProgress();};$('rescan').onclick=()=>{if(documentPDF){toast('Return to the library to rescan.');return;}refresh();toast('Library scan requested.');};

/* Non-destructive PDF annotations. Coordinates are fractions of the page slot,
   so zoom, rotation layout and responsive sizing cannot displace the marks. */
let annotationDocument='',annotationItems=[],annotationActive=false,annotationStroke=null;
const annotationKey=id=>'pishelf:annotations:v1:'+id;
let annotationSaveQueue=Promise.resolve(),annotationLoadEpoch=0;
async function annotationLoad(id){
 const epoch=++annotationLoadEpoch;
 annotationDocument=id;annotationItems=[];annotationDrawAll();annotationList();
 try{
  const serverItems=await api('/api/annotations?id='+encodeURIComponent(id));
  if(epoch!==annotationLoadEpoch||annotationDocument!==id)return;
  annotationItems=Array.isArray(serverItems)?serverItems:[];
  // One-time migration of old browser-local pen/highlighter marks.
  const old=localStorage.getItem(annotationKey(id));
  if(old&&!annotationItems.length){
   const legacy=JSON.parse(old);
   if(Array.isArray(legacy)){
    const marks=legacy.filter(x=>['pen','highlight','note'].includes(x.type)).map(x=>x.type==='note'?{type:'note',page:x.page,text:x.text}:{type:x.type,page:x.page,color:x.color,points:x.points});
    if(marks.length){annotationItems=marks;await annotationStore();}
   }
  }
  if(old&&epoch===annotationLoadEpoch)localStorage.removeItem(annotationKey(id));
  annotationDrawAll();annotationList();
 }catch(e){if(epoch===annotationLoadEpoch)toast('Could not load account highlights: '+e.message);}
}
function annotationStore(){
 if(!annotationDocument)return Promise.resolve();
 const id=annotationDocument;
 const items=annotationItems.filter(x=>['pen','highlight','note'].includes(x.type)).map(x=>x.type==='note'?{type:'note',page:x.page,text:x.text}:{type:x.type,page:x.page,color:x.color,points:x.points});
 annotationDrawAll();annotationList();
 annotationSaveQueue=annotationSaveQueue.catch(()=>{}).then(async()=>{
  try{await api('/api/annotations',{id,items});}
  catch(e){toast('Could not sync highlights: '+e.message);throw e;}
 });
 return annotationSaveQueue;
}
function annotationLayer(slot){
 let layer=slot.querySelector('.annotation-layer');
 if(!layer){layer=document.createElementNS('http://www.w3.org/2000/svg','svg');layer.setAttribute('viewBox','0 0 1000 1000');layer.setAttribute('preserveAspectRatio','none');layer.classList.add('annotation-layer');slot.append(layer);}
 return layer;
}
function annotationPoint(event,slot){
 const r=slot.getBoundingClientRect();
 return [Math.max(0,Math.min(1000,Math.round((event.clientX-r.left)/r.width*1000))),Math.max(0,Math.min(1000,Math.round((event.clientY-r.top)/r.height*1000)))];
}
function annotationElement(item){
 const ns='http://www.w3.org/2000/svg';
 let el;
 if(item.type==='circle'){el=document.createElementNS(ns,'ellipse');el.setAttribute('cx',(item.points[0][0]+item.points[1][0])/2);el.setAttribute('cy',(item.points[0][1]+item.points[1][1])/2);el.setAttribute('rx',Math.abs(item.points[1][0]-item.points[0][0])/2);el.setAttribute('ry',Math.abs(item.points[1][1]-item.points[0][1])/2);}
 else{el=document.createElementNS(ns,'polyline');el.setAttribute('points',item.points.map(p=>p.join(',')).join(' '));}
 el.setAttribute('fill','none');el.setAttribute('stroke',item.color||'#FBF719');
 el.setAttribute('stroke-width',item.type==='highlight'?'26':item.type==='pen'?'5':'7');
 el.setAttribute('stroke-linecap','round');el.setAttribute('stroke-linejoin','round');
 if(item.type==='highlight')el.setAttribute('opacity','.42');
 return el;
}
// Replace rendered pixels while retaining the SVG annotation overlay.
function replacePagePixels(slot,...nodes){
 const overlay=slot.querySelector('.annotation-layer');
 slot.replaceChildren(...nodes);
 if(overlay)slot.append(overlay);
}
function annotationDrawAll(){
 if(!documentPDF)return;
 for(const slot of slots){
  const layer=annotationLayer(slot);layer.replaceChildren();
  for(const item of annotationItems)if(item.page===Number(slot.dataset.page)&&Array.isArray(item.points)&&item.points.length>1)layer.append(annotationElement(item));
 }
}
function annotationList(){
 const list=$('annotation-list');if(!list)return;list.replaceChildren();
 annotationItems.forEach((item,index)=>{
  const row=document.createElement('div');row.className='annotation-entry';
  const go=document.createElement('button');go.type='button';go.textContent='Page '+item.page+' · '+(item.type==='note'?item.text:item.type);go.onclick=()=>move(item.page);
  const remove=document.createElement('button');remove.type='button';remove.textContent='Delete';remove.setAttribute('aria-label','Delete annotation on page '+item.page);
  remove.onclick=()=>{annotationItems.splice(index,1);annotationStore();};
  row.append(go,remove);list.append(row);
 });
}
function annotationTool(){return annotationActive?$('annotation-tool').value:'none';}
function annotationToggle(enabled){
 annotationActive=enabled;$('annotation-panel').hidden=!enabled;
 $('annotation-toggle').setAttribute('aria-pressed',String(enabled));
 $('page-area').classList.toggle('annotation-editing',enabled&&annotationTool()!=='none');
}
$('annotation-toggle').onclick=()=>annotationToggle(!annotationActive);
$('annotation-close').onclick=()=>annotationToggle(false);
$('annotation-tool').onchange=()=>{$('page-area').classList.toggle('annotation-editing',annotationTool()!=='none');};
$('annotation-save-note').onclick=()=>{
 if(!documentPDF||!current)return;
 const text=$('annotation-note').value.trim();if(!text)return;
 annotationItems.push({type:'note',page,text});$('annotation-note').value='';annotationStore();
};
$('annotation-undo').onclick=()=>{
 for(let i=annotationItems.length-1;i>=0;i--)if(annotationItems[i].page===page){annotationItems.splice(i,1);annotationStore();return;}
};
$('annotation-export').onclick=()=>{
 if(!current)return;
 const lines=['# Notes: '+current.title,''];
 for(const item of annotationItems){lines.push('## Page '+item.page);lines.push(item.type==='note'?item.text:'- '+item.type+' mark ('+(item.color||'')+')');lines.push('');}
 const blob=new Blob([lines.join('\n')],{type:'text/markdown;charset=utf-8'});
 const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='pishelf-notes-'+String(current.title).replace(/[^a-z0-9_-]+/gi,'-').slice(0,60)+'.md';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
};
$('page-area').addEventListener('pointerdown',event=>{
 const tool=annotationTool();if(tool==='none'||!documentPDF||event.button!==0||event.pointerType==='touch'&&event.isPrimary===false)return;
 const slot=event.target.closest('.pdf-slot');if(!slot)return;
 event.preventDefault();event.stopPropagation();
 annotationStroke={id:event.pointerId,slot,tool,points:[annotationPoint(event,slot)],color:$('annotation-color').value};
 $('page-area').setPointerCapture(event.pointerId);
},true);
$('page-area').addEventListener('pointermove',event=>{
 const a=annotationStroke;if(!a||a.id!==event.pointerId)return;
 event.preventDefault();event.stopPropagation();
 const p=annotationPoint(event,a.slot);
 if(a.tool==='pen'||a.tool==='highlight'){if(a.points.length<1000)a.points.push(p);}
 else a.points[1]=p;
 annotationDrawAll();
 const preview={type:a.tool,points:a.points,color:a.color};
 if(preview.points.length>1)annotationLayer(a.slot).append(annotationElement(preview));
},true);
function annotationFinish(event){
 const a=annotationStroke;if(!a||a.id!==event.pointerId)return;
 event.preventDefault();event.stopPropagation();annotationStroke=null;
 if(a.points.length===1)a.points.push(annotationPoint(event,a.slot));
 annotationItems.push({type:a.tool,page:Number(a.slot.dataset.page),color:a.color,points:a.points});
 annotationStore();
 if($('page-area').hasPointerCapture(event.pointerId))$('page-area').releasePointerCapture(event.pointerId);
}
$('page-area').addEventListener('pointerup',annotationFinish,true);
$('page-area').addEventListener('pointercancel',event=>{if(annotationStroke?.id===event.pointerId){annotationStroke=null;annotationDrawAll();}},true);

// Continuous reader: lightweight page placeholders, serialized rendering, bounded canvas memory.
let slots=[],renderQueue=[],renderBusy=false,pageObserver=null;
const dimensions=new Map(),renderedSlots=new Set();
/** update Page UI: Keep the visible PDF page and navigation state in sync. */
function updatePageUI(){if(!documentPDF)return;const percent=Math.round(page/documentPDF.numPages*100);$('reader-progress-fill').style.width=percent+'%';document.querySelector('.reader-progress').setAttribute('aria-valuenow',String(percent));$('page-number').value=page;$('reader-page-slider').max=documentPDF.numPages;$('reader-page-slider').value=page;$('reader-page-slider-label').textContent=page+' / '+documentPDF.numPages+' · '+percent+'%';$('page-total').textContent='/ '+documentPDF.numPages;$('prev').disabled=page<=1;$('next').disabled=isBookSpread()?(page===1?documentPDF.numPages===1:spreadStart(page)+1>=documentPDF.numPages):page>=documentPDF.numPages;$('book-turn-prev').disabled=page<=1;$('book-turn-next').disabled=$('next').disabled;const marks=saved[current.id]?.bookmarks||[];$('bookmark').textContent=marks.includes(page)?'★':'☆';$('bookmark').setAttribute('aria-pressed',marks.includes(page));}
// Scrub previews page numbers without rerendering dozens of pages while
// dragging; the final change uses the existing move() navigation path.
$('reader-page-slider').addEventListener('input',e=>{
 if(!documentPDF)return;
 $('reader-page-slider-label').textContent=e.target.value+' / '+documentPDF.numPages+' · '+Math.round(Number(e.target.value)/documentPDF.numPages*100)+'%';
});
$('reader-page-slider').addEventListener('change',e=>{
 if(!documentPDF)return;
 move(Math.max(1,Math.min(documentPDF.numPages,Number(e.target.value)||1)));
});
/** update Bookmarks: Support the PiShelf reader or library interface. */
function updateBookmarks(){const select=$('bookmarks');select.replaceChildren(new Option('Bookmarks',''));for(const n of saved[current.id]?.bookmarks||[])if(n<=documentPDF.numPages)select.add(new Option('Page '+n,n));}
/** remember: Support the PiShelf reader or library interface. */
function remember(){if(!documentPDF||!layoutReady||pinch)return;const patch={page,total:documentPDF.numPages,zoom,rotation,mode:$('view-mode').value},previous=saved[current.id]||{};if(Object.entries(patch).every(([k,v])=>previous[k]===v))return;persist(current.id,patch);}
/** page Width: Keep the visible PDF page and navigation state in sync. */
function isBookSpread(){return $('view-mode').value==='book';}
/** A book's first PDF page is its cover; subsequent spreads are 2–3, 4–5, etc. */
function spreadStart(n){const clamped=Math.max(1,Math.min(documentPDF?.numPages||1,Math.floor(n)||1));return clamped===1?1:2+2*Math.floor((clamped-2)/2);}
function spreadPages(n){const first=spreadStart(n),last=documentPDF?.numPages||1;return first===1?[1]:[first,first+1].filter(p=>p<=last);}
function bookPageBaseWidth(){
 const available=Math.max(200,$('page-area').clientWidth-40);
 return Math.max(90,Math.min(550,(available-12)/2));
}
let automaticFit=null;
function defaultPagedFit(){
 const mode=$('view-mode').value;
 return mode==='single'||mode==='book'?'page':null;
}
function heightFitZoom(n){
 const d=dimensions.get(n)||dimensions.get(1);
 if(!d)return fitEntirePageZoom(n);
 const area=$('page-area'),swapped=rotation%180!==0;
 const base=Math.min(Math.max(200,area.clientWidth-40),1100);
 return area.clientHeight*(swapped?d.height:d.width)/(base*(swapped?d.width:d.height));
}
function pageWidth(){
 const available=Math.max(200,$('page-area').clientWidth-40);
 return (isBookSpread()?bookPageBaseWidth():Math.min(available,1100))*zoom;
}
/** Fit the *entire* current book spread rather than measuring only one page.
 * Width includes the gutter and padding. Height accounts for both aspect ratios.
 * Page 1 is a single cover; later spreads contain at most two PDF pages.
 */
function fitEntirePageZoom(n){
 const area=$('page-area'),swapped=rotation%180!==0;
 if(isBookSpread()){
  const pages=spreadPages(n),base=bookPageBaseWidth();
  const compact=matchMedia('(max-width:600px)').matches;
  const gap=compact?4:8,paddingX=compact?10:32,paddingY=compact?16:36;
  const maxHeight=Math.max(...pages.map(p=>{
   const d=dimensions.get(p)||dimensions.get(1)||{width:420,height:580};
   const w=swapped?d.height:d.width,h=swapped?d.width:d.height;
   return base*h/Math.max(1,w);
  }));
  const availableWidth=Math.max(80,area.clientWidth-12);
  const availableHeight=Math.max(80,area.clientHeight-12);
  const widthScale=(availableWidth-paddingX-gap*(pages.length-1))/(base*pages.length);
  const heightScale=(availableHeight-paddingY)/maxHeight;
  return Math.max(.1,Math.min(widthScale,heightScale));
 }
 const d=dimensions.get(n)||dimensions.get(1);
 if(!d)return 1;
 const width=swapped?d.height:d.width,height=swapped?d.width:d.height;
 const inset=Math.min(16,Math.max(4,Math.round(area.clientWidth*.015)));
 const availableWidth=Math.max(100,area.clientWidth-inset*2);
 const availableHeight=Math.max(100,area.clientHeight-inset*2);
 const baseWidth=Math.min(Math.max(200,area.clientWidth-40),1100);
 return Math.max(.1,Math.min(availableWidth/baseWidth,availableHeight*width/(baseWidth*height)));
}
/** Resolve real PDF dimensions before a new book spread is displayed.
 * Image prefetch provides decoded pixels but not PDF page aspect ratios.
 * Using a prior page's dimensions makes the new spread briefly small and then
 * jump when the background dimension scan finally reaches these pages.
 */
async function primeSpreadDimensions(pages,doc=documentPDF,g=generation){
 if(typeof doc?.getPage!=='function')return;
 await Promise.allSettled(pages.filter(n=>!dimensions.has(n)).map(async n=>{
  const pdfPage=await doc.getPage(n);
  if(g!==generation||documentPDF!==doc)return;
  const view=pdfPage.getViewport({scale:1});
  dimensions.set(n,{width:view.width,height:view.height});
 }));
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
// === WebP-first reader ======================================================
// Render queue is serialized to bound concurrent decoding. A 960px preview
// appears first, then a sharper WebP may replace it if the slot is still valid.
async function renderPages(){
 if(renderBusy)return;renderBusy=true;
 try{while(renderQueue.length){
  const {slot,g,epoch}=renderQueue.shift();
  if(g!==generation||epoch!==layoutEpoch||!slot.isConnected||!documentPDF)continue;
  const n=+slot.dataset.page;
  try{
   // Prefer cached magazine images; retain PDF.js rendering as a fallback.
   if(current?.id){
    const prefetched=takeDecodedPreview(n);
    const img=prefetched||document.createElement('img');
    img.alt='Magazine page '+n;
    img.decoding='async';
    img.style.cssText='display:block;width:100%;height:100%;object-fit:contain';
    const width=zoom>1.6?2800:zoom>0.85?1600:960;
    const url='/api/page-image/'+encodeURIComponent(current.id)+'/'+n+'?width='+width;
    const previewUrl='/api/page-image/'+encodeURIComponent(current.id)+'/'+n+'?width=960';
    try{
     if(!prefetched){
      await new Promise((resolve,reject)=>{
       img.onload=resolve;img.onerror=reject;img.src=width>960?previewUrl:url;
      });
     }
     if(g!==generation||epoch!==layoutEpoch||!slot.isConnected)continue;
     replacePagePixels(slot,img);slot.dataset.ready='yes';slot.dataset.queued='no';
     if(width>960){
      cancelSharpImage(slot);
      const sharp=new Image();
      sharp.decoding='async';sharp.alt=img.alt;sharp.style.cssText=img.style.cssText;
      pendingSharpImages.set(slot,sharp);
      sharp.onload=()=>{
       pendingSharpImages.delete(slot);
       sharp.onload=null;sharp.onerror=null;
       if(g===generation&&epoch===layoutEpoch&&slot.isConnected&&slot.firstChild===img&&!pinch){
        replacePagePixels(slot,sharp);
       }else{
        // A stale response must not retain a decoded 2800px image.
        sharp.src='';
       }
      };
      sharp.onerror=()=>{pendingSharpImages.delete(slot);sharp.onload=null;sharp.onerror=null;};
      sharp.src=url;
     }
     renderedSlots.add(slot);trimCanvases();if(n===page)preloadMagazineNeighbors();$('reader-status').textContent='';
     continue;
    }catch(error){img.src='';}
   }
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
   replacePagePixels(slot,canvas);slot.dataset.ready='yes';slot.dataset.queued='no';renderedSlots.add(slot);trimCanvases();$('reader-status').textContent='';
  }catch(e){slot.dataset.queued='no';if(g===generation&&epoch===layoutEpoch){replacePagePixels(slot,el('p','page-placeholder','Page '+n+' could not render.'));const retry=el('button','','Retry');retry.onclick=()=>enqueue(slot);slot.append(retry);$('reader-status').textContent='PDF rendering failed: '+e.message;}}
 }
 }finally{renderBusy=false;if(renderQueue.length)renderPages();}
}
/** trim Canvases: Manage PDF page rendering and canvas lifecycle. */
// Keep only nearby magazine images decoded in Safari; page navigation preloads
// the next two pages and the previous page without allocating large canvases.
// Decoded 960px previews for adjacent pages. Each cache entry owns a
// settleable promise, so navigating away cannot leave a page turn hanging.
let imagePrefetches=new Map();
const pendingSharpImages=new Map();
function cancelSharpImage(slot){
 const image=pendingSharpImages.get(slot);
 if(!image)return;
 image.onload=null;image.onerror=null;image.src='';
 pendingSharpImages.delete(slot);
}
function cancelAllSharpImages(){
 for(const slot of pendingSharpImages.keys())cancelSharpImage(slot);
}
function discardDecodedPreview(n,entry){
 if(imagePrefetches.get(n)===entry)imagePrefetches.delete(n);
 entry.cancelled=true;entry.img.onload=null;entry.img.onerror=null;
 if(!entry.transferred)entry.img.src='';
 entry.finish(false);
}
function ensureDecodedPreview(n){
 if(!documentPDF||!current?.id||n<1||n>documentPDF.numPages)return Promise.resolve(false);
 const existing=imagePrefetches.get(n);
 if(existing?.id===current.id&&!existing.cancelled)return existing.promise;
 if(existing)discardDecodedPreview(n,existing);
 const img=new Image();img.decoding='async';
 let resolvePromise;
 const entry={id:current.id,img,ready:false,cancelled:false,transferred:false,settled:false,finish:null,promise:null};
 entry.promise=new Promise(resolve=>{resolvePromise=resolve;});
 entry.finish=ok=>{if(!entry.settled){entry.settled=true;resolvePromise(ok);}};
 imagePrefetches.set(n,entry);
 img.onload=async()=>{
  try{if(typeof img.decode==='function')await img.decode();}catch{}
  if(entry.cancelled)return;
  entry.ready=img.naturalWidth>0&&img.naturalHeight>0;
  entry.finish(entry.ready);
 };
 img.onerror=()=>{
  if(entry.cancelled)return;
  entry.finish(false);
  if(imagePrefetches.get(n)===entry)imagePrefetches.delete(n);
 };
 img.src='/api/page-image/'+encodeURIComponent(entry.id)+'/'+n+'?width=960';
 return entry.promise;
}
// Transfer the decoded original, instead of creating another image whose
// onload would delay the newly turned page.
function takeDecodedPreview(n){
 const entry=imagePrefetches.get(n);
 if(!entry||!entry.ready||entry.id!==current?.id)return null;
 imagePrefetches.delete(n);
 entry.transferred=true;entry.img.onload=null;entry.img.onerror=null;
 return entry.img;
}
function neighborPreviewPages(){
 if(!documentPDF)return [];
 const count=documentPDF.numPages;
 if(isBookSpread()){
  const start=spreadStart(page),previous=start<=2?1:start-2;
  const next=start===1?2:start+2;
  return [...new Set([
   ...(previous<start?spreadPages(previous):[]),
   ...(next<=count?spreadPages(next):[])
  ].filter(n=>n>=1&&n<=count))];
 }
 return [page-2,page-1,page+1,page+2].filter(n=>n>=1&&n<=count);
}
function preloadMagazineNeighbors(){
 if(!documentPDF||!current?.id)return;
 const wanted=new Set(neighborPreviewPages());
 // When the first page of a new book spread is installed, its companion
 // might still be queued. Never evict that ALREADY decoded image before the
 // second slot takes it. Do not start duplicate requests for queued slots.
 if(isBookSpread())for(const n of spreadPages(page)){
  const slot=slots.find(candidate=>Number(candidate.dataset.page)===n);
  if(slot?.dataset.ready!=='yes'&&imagePrefetches.has(n))wanted.add(n);
 }
 for(const [n,entry] of imagePrefetches)if(!wanted.has(n))discardDecodedPreview(n,entry);
 for(const n of wanted)void ensureDecodedPreview(n);
}
function clearMagazinePrefetches(){
 for(const [n,entry] of imagePrefetches)discardDecodedPreview(n,entry);
 imagePrefetches.clear();
}
function trimCanvases(){if(pinch||Math.abs(zoom-cssZoomBase)>.01)return;const area=$('page-area').getBoundingClientRect();for(const slot of renderedSlots){const rect=slot.getBoundingClientRect();if(Math.abs(+slot.dataset.page-page)>2&&(rect.bottom<area.top||rect.top>area.bottom)){cancelSharpImage(slot);for(const c of slot.querySelectorAll('canvas')){c.width=0;c.height=0;}for(const img of slot.querySelectorAll('img')){img.src='';}replacePagePixels(slot,el('span','page-placeholder','Page '+slot.dataset.page));slot.dataset.ready='no';renderedSlots.delete(slot);}}}
/** track Scroll: Keep the visible PDF page and navigation state in sync. */
let lastCanvasTrim=0;
function trackScroll(){
 if(pinch||performance.now()<pinchScrollLockUntil||!layoutReady||!documentPDF||$('view-mode').value!=='scroll'||!slots.length)return;
 const area=$('page-area'),target=area.scrollTop+Math.min(area.clientHeight*.35,240);let low=0,high=slots.length-1;
 while(low<high){const mid=Math.ceil((low+high)/2);if(slots[mid].offsetTop<=target)low=mid;else high=mid-1;}
 const n=+slots[low].dataset.page;if(n!==page){page=n;updatePageUI();preloadMagazineNeighbors();}
 for(let i=Math.max(0,low-2),end=area.scrollTop+area.clientHeight+300;i<slots.length&&slots[i].offsetTop<end;i++)enqueue(slots[i]);if(performance.now()-lastCanvasTrim>250){lastCanvasTrim=performance.now();trimCanvases();}
 clearTimeout(scrollTimer);scrollTimer=setTimeout(remember,750);
}
$('page-area').addEventListener('scroll',()=>{if(!scrollFrame)scrollFrame=requestAnimationFrame(()=>{scrollFrame=null;trackScroll();});},{passive:true});
// Preload fewer pages on low-memory devices and more on desktop, without
// changing the active page or forcing full-size images into thumbnail views.
function readerPrefetchMargin(){
 const memory=Number(navigator.deviceMemory)||4;
 const height=$('page-area').clientHeight||600;
 return Math.round(Math.min(memory<=2?240:900,Math.max(240,height*(memory<=2?.35:.8))))+'px';
}
/** rebuild: Manage PDF page rendering and canvas lifecycle. */
async function rebuild(){if(!documentPDF)return;cancelAllSharpImages();$('pages').style.zoom='';$('pages').style.transform='';$('pages').style.transformOrigin='';cssZoomBase=zoom;updateTouchMode();const g=generation,epoch=++layoutEpoch;layoutReady=false;pageObserver?.disconnect();renderQueue=[];clearCurl();
 if(automaticFit){
  const fittedPage=page;
  await primeSpreadDimensions(isBookSpread()?spreadPages(page):[page]);
  if(g!==generation||epoch!==layoutEpoch||page!==fittedPage)return;
  zoom=automaticFit==='height'?heightFitZoom(page):fitEntirePageZoom(page);
  cssZoomBase=zoom;updateTouchMode();
 }
 if(g!==generation||epoch!==layoutEpoch)return;
 for(const c of $('pages').querySelectorAll('canvas')){c.width=0;c.height=0;}$('pages').replaceChildren();slots=[];renderedSlots.clear();
 const mode=$('view-mode').value,count=documentPDF.numPages,fragment=document.createDocumentFragment();
 if(mode==='book'){
  page=spreadStart(page);
  const spread=el('div','book-spread');
  spread.setAttribute('aria-label','Open book pages '+spreadPages(page).join(' and '));
  spread.dataset.start=page;
  for(const n of spreadPages(page)){
   const slot=el('div','pdf-slot');
   slot.dataset.page=n;slot.setAttribute('aria-label','PDF page '+n);
   sizeSlot(slot,n);slot.append(el('span','page-placeholder','Page '+n));
   slots.push(slot);spread.append(slot);
  }
  fragment.append(spread);
 }else{
  for(let n=mode==='single'?page:1;n<=(mode==='single'?page:count);n++){
   const slot=el('div','pdf-slot');slot.dataset.page=n;
   slot.setAttribute('aria-label','PDF page '+n);sizeSlot(slot,n);
   slot.append(el('span','page-placeholder','Page '+n));slots.push(slot);fragment.append(slot);
  }
 }
 $('pages').classList.toggle('paged-layout',mode!=='scroll');
 $('pages').classList.toggle('book-layout',mode==='book');
 $('reader').classList.toggle('book-mode',mode==='book');
 $('pages').append(fragment);
 annotationDrawAll();
 pageObserver=new IntersectionObserver(entries=>{for(const e of entries)if(e.isIntersecting)enqueue(e.target);},{root:$('page-area'),rootMargin:readerPrefetchMargin()});slots.forEach(s=>pageObserver.observe(s));
 layoutReady=true;const target=slots.find(s=>+s.dataset.page===page);
 if(target){$('page-area').scrollTop=mode==='scroll'?target.offsetTop-20:0;enqueue(target);}
 if(automaticFit){const area=$('page-area');area.scrollLeft=(area.scrollWidth-area.clientWidth)/2;}
 if(isBookSpread())for(const slot of slots)enqueue(slot);
 updatePageUI();updateBookmarks();remember();}
let pdfjsModulePromise;
/** pdf Engine: Support the PiShelf reader or library interface. */
async function pdfEngine(){
 if(!pdfjsModulePromise)pdfjsModulePromise=import('https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs').then(module=>{
  module.GlobalWorkerOptions.workerSrc='https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs';
  return module;
 });
 return pdfjsModulePromise;
}
/* EPUB and PDF have separate rendering engines, so PDF pinch zoom and
 * WebP page caching never interact with an EPUB's reflowable iframe. */
let epubController=null,epubGeneration=0,epubHistoryActive=false;
function openDocument(item,start){return isEpub(item)?openEpubBook(item,start):openMagazine(item,start);}

/* Read aloud: text-based PDFs and reflowable EPUBs use the device's voices. */
let pdfSpeech=null,epubSpeech=null,speechModule=null;
async function speechEngine(){
 if(!speechModule)speechModule=import('./read-aloud.js');
 return speechModule;
}
const EDGE_VOICES=[
 ['en-IN-NeerjaNeural','Neerja · Indian English (Female)'],
 ['en-IN-PrabhatNeural','Prabhat · Indian English (Male)'],
 ['en-US-AriaNeural','Aria · US English (Female)'],
 ['en-US-GuyNeural','Guy · US English (Male)'],
 ['en-GB-SoniaNeural','Sonia · British English (Female)'],
 ['en-GB-RyanNeural','Ryan · British English (Male)'],
 ['en-AU-NatashaNeural','Natasha · Australian English (Female)']
];
// Keep the user's preferred voice across PDF/EPUB and browser reloads.
const VOICE_STORAGE_KEY='pishelf-edge-voice';
function preferredSpeechVoice(){
 try{const value=localStorage.getItem(VOICE_STORAGE_KEY);if(EDGE_VOICES.some(([id])=>id===value))return value;}catch{}
 return 'en-IN-NeerjaNeural';
}
function speechVoices(kind){
 const select=$(kind+'-read-voice');if(!select)return;
 select.replaceChildren(...EDGE_VOICES.map(([id,label])=>new Option(label,id)));
 select.value=preferredSpeechVoice();
}
// Drag only from the player background: buttons and settings remain clickable.
function enableSpeechDrag(kind){
 const player=$(kind+'-speech-player');
 if(player.dataset.draggable)return;
 player.dataset.draggable='true';
 let drag=null;
 player.addEventListener('pointerdown',event=>{
  if(event.button!==0||event.target.closest('button,select,label,input,.read-aloud-panel'))return;
  const rect=player.getBoundingClientRect();
  drag={id:event.pointerId,dx:event.clientX-rect.left,dy:event.clientY-rect.top};
  player.setPointerCapture(event.pointerId);
 });
 player.addEventListener('pointermove',event=>{
  if(!drag||drag.id!==event.pointerId)return;
  const x=Math.max(0,Math.min(innerWidth-player.offsetWidth,event.clientX-drag.dx));
  const y=Math.max(0,Math.min(innerHeight-player.offsetHeight,event.clientY-drag.dy));
  player.style.setProperty('left',x+'px','important');
  player.style.setProperty('top',y+'px','important');
  player.style.setProperty('bottom','auto','important');
  player.style.setProperty('transform','none','important');
 });
 const end=event=>{if(drag?.id===event.pointerId)drag=null;};
 player.addEventListener('pointerup',end);player.addEventListener('pointercancel',end);
}
function speechPlayer(kind,visible){
 if(!visible)clearReadingMark();
 const root=$(kind==='pdf'?'reader':'epub-reader');
 const player=$(kind+'-speech-player');
 player.hidden=!visible;
 root.classList.toggle('speech-immersive',visible);
 $(kind+'-read-toggle').setAttribute('aria-expanded',String(visible));
 if(!visible)$(kind+'-read-panel').hidden=true;
}
function wireSpeech(kind,controller){
 enableSpeechDrag(kind);
 controller.setVoice(preferredSpeechVoice());
 const panel=$(kind+'-read-panel');
 $(kind+'-read-toggle').onclick=()=>beginSpeechPick(kind);
 $(kind+'-read-main').onclick=()=>controller.paused?controller.play():controller.pause();
 $(kind+'-read-back').onclick=()=>controller.seek(-10);
 $(kind+'-read-forward').onclick=()=>controller.seek(10);
 $(kind+'-read-close').onclick=()=>{controller.stop();speechPlayer(kind,false);};
 $(kind+'-read-more').onclick=()=>{panel.hidden=!panel.hidden;};
 $(kind+'-read-play').onclick=()=>controller.play();
 $(kind+'-read-pause').onclick=()=>controller.paused?controller.play():controller.pause();
 $(kind+'-read-stop').onclick=()=>{controller.stop();speechPlayer(kind,false);};
 $(kind+'-read-rate').onchange=e=>controller.setRate(e.target.value);
 $(kind+'-read-voice').onchange=e=>{const selected=e.target.value;try{localStorage.setItem(VOICE_STORAGE_KEY,selected);}catch{}controller.setVoice(selected);speechVoices(kind==='pdf'?'epub':'pdf');};
 speechVoices(kind);
}
let readingMark=null,readingMarkText='',readingMarkPage=0,readingMarkIndex=-1;
function clearReadingMark(){
 if(readingMark){readingMark.remove();readingMark=null;}
 if(window.CSS?.highlights)CSS.highlights.delete('pishelf-reading');
 readingMarkText='';readingMarkPage=0;readingMarkIndex=-1;
}
// PDF images have no selectable text layer; use PDF.js text item coordinates.
let pdfSpeechItems=null,pdfSpeechItemsPage=0,pdfSpeechStartIndex=0;
async function markPdfReading(text,progress){
 if(!documentPDF||!text)return;
 const currentPage=pdfSpeechCurrentPage();
 const slot=Array.from($('pages').querySelectorAll('[data-page]')).find(el=>+el.dataset.page===currentPage);
 if(!slot)return;
 const words=text.trim().split(/\s+/),wordIndex=Math.floor(Math.max(0,Math.min(.999,progress))*words.length);
 if(readingMarkText===text&&readingMarkPage===currentPage&&readingMarkIndex===wordIndex)return;
 if(readingMarkText!==text||readingMarkPage!==currentPage){
  readingMark?.remove();readingMark=null;readingMarkText=text;readingMarkPage=currentPage;readingMarkIndex=-1;
 }
 readingMarkIndex=wordIndex;
 try{
  const pdfPage=await documentPDF.getPage(currentPage);
  if(pdfSpeechItemsPage!==currentPage||!pdfSpeechItems){
   pdfSpeechItems=(await pdfPage.getTextContent()).items.filter(item=>item.str?.trim());
   pdfSpeechItemsPage=currentPage;
  }
  if(readingMarkText!==text||readingMarkPage!==currentPage)return;
  const items=pdfSpeechItems;
  const anchor=words.slice(0,5).find(word=>word.length>3)?.toLowerCase();
  const start=items.findIndex((item,i)=>i>=pdfSpeechStartIndex&&anchor&&item.str.toLowerCase().includes(anchor));
  if(start<0)return;
  let remaining=wordIndex,item=items[start];
  for(const candidate of items.slice(start)){
   item=candidate;remaining-=Math.max(1,candidate.str.trim().split(/\s+/).length);
   if(remaining<0)break;
  }
  const viewport=pdfPage.getViewport({scale:1,rotation});
  const pt=viewport.convertToViewportPoint(item.transform[4],item.transform[5]);
  const overlay=readingMark||document.createElement('div');
  overlay.className='speech-page-highlight';
  overlay.style.left=Math.max(0,pt[0]/viewport.width*100)+'%';
  overlay.style.top=Math.max(0,(pt[1]-Math.abs(item.height||12))/viewport.height*100)+'%';
  overlay.style.width=Math.max(2,Math.min(100,item.width/viewport.width*100))+'%';
  overlay.style.height=Math.max(1.5,Math.abs(item.height||12)/viewport.height*100)+'%';
  if(!overlay.isConnected)slot.append(overlay);
  readingMark=overlay;
 }catch{}
}
function markEpubReading(text,progress=0){
 if(!epubController)return;
 const iframe=$('epub-page').querySelector('iframe'),doc=iframe?.contentDocument;
 if(!doc||!text)return;
 const view=doc.defaultView;
 if(!view?.CSS?.highlights||!view.Highlight)return;
 view.CSS.highlights.delete('pishelf-reading');
 const words=text.trim().split(/\s+/);
 const needle=words[Math.min(words.length-1,Math.floor(Math.max(0,Math.min(.999,progress))*words.length))]?.toLowerCase();
 if(!needle)return;
 const walker=doc.createTreeWalker(doc.body,NodeFilter.SHOW_TEXT);
 let node;
 while((node=walker.nextNode())){
  const hay=node.textContent.toLowerCase(),idx=hay.indexOf(needle);
  if(idx>=0){const range=doc.createRange();range.setStart(node,idx);range.setEnd(node,Math.min(node.length,idx+needle.length));view.CSS.highlights.set('pishelf-reading',new view.Highlight(range));break;}
 }
}
function speechState(kind,state){
 if(state.notice){toast(state.notice);return;}
 if(state.spokenText!==undefined){if(kind==='pdf')void markPdfReading(state.spokenText,state.readingProgress||0);else markEpubReading(state.spokenText,state.readingProgress||0);return;}
 if(state.error){toast('Read aloud: '+state.error);return;}
 $(kind+'-read-play').textContent=state.active?'Reading…':'▶ Read aloud';
 $(kind+'-read-main').textContent=state.paused||!state.active?'▶':'⏸';
 $(kind+'-read-main').setAttribute('aria-label',state.paused||!state.active?'Resume reading':'Pause reading');
 $(kind+'-read-pause').textContent=state.paused?'Resume':'Pause';
 // Keep the mini-player visible after errors or natural completion; only Close dismisses it.
}
// One-shot starting positions. Subsequent pages read from the beginning.
let pdfSpeechStart=null,pdfSpeechPage=null;
// Speech page is independent of the spread's first page and scroll-mode viewport.
function pdfSpeechCurrentPage(){return pdfSpeechPage||page;}
function showPdfSpeechPage(n){
 if(!documentPDF)return;
 const visible=Array.from($('pages').querySelectorAll('[data-page]'));
 const target=visible.find(slot=>Number(slot.dataset.page)===n);
 if(target){
  // A visible page (including right-hand book pages) must not trigger rebuild.
  if($('view-mode').value==='scroll')target.scrollIntoView({block:'nearest',behavior:'auto'});
  return;
 }
 move(n);
}

// Only accept a page tap after the reader explicitly asks for a starting point.
let speechPickMode=null;
function speechPickNotice(kind){
 let notice=document.getElementById('speech-pick-notice');
 if(!notice){
  notice=document.createElement('div');notice.id='speech-pick-notice';
  notice.className='speech-pick-notice';notice.setAttribute('role','status');
  const message=document.createElement('span');message.id='speech-pick-message';
  const cancel=document.createElement('button');cancel.type='button';cancel.textContent='Cancel';
  cancel.onclick=()=>cancelSpeechPick();
  notice.append(message,cancel);document.body.append(notice);
 }
 document.getElementById('speech-pick-message').textContent='Tap the '+(kind==='pdf'?'PDF page':'EPUB text')+' where reading should start';
 notice.hidden=false;
}
function cancelSpeechPick(){
 speechPickMode=null;
 const notice=document.getElementById('speech-pick-notice');
 if(notice)notice.hidden=true;
 document.body.classList.remove('speech-picking');
}
function beginSpeechPick(kind){
 pdfSpeech?.stop();epubSpeech?.stop();
 pdfSpeechPage=null;pdfSpeechStart=null;
 speechPickMode=kind;
 document.body.classList.add('speech-picking');
 speechPickNotice(kind);
}
async function readPdfFromTap(event){
 if(speechPickMode!=='pdf'||!documentPDF||!event.isTrusted||event.target.closest('button,a,input,select,textarea'))return;
 const slot=event.target.closest('[data-page]');
 if(!slot||!$('reader').contains(slot)||!slot.getBoundingClientRect().width)return;
 const targetPage=Number(slot.dataset.page);
 if(!Number.isInteger(targetPage)||targetPage<1)return;
 const rect=slot.getBoundingClientRect();
 const pdfPage=await documentPDF.getPage(targetPage);
 const viewport=pdfPage.getViewport({scale:1,rotation});
 const rawItems=(await pdfPage.getTextContent()).items;
 const items=rawItems.map((item,index)=>({...item,sourceIndex:index})).filter(item=>item.str?.trim());
 if(!items.length){toast('This page has no selectable text for Read Aloud.');return;}
 // Choose the nearest text line by vertical distance, then horizontal position.
 const x=(event.clientX-rect.left)/rect.width*viewport.width;
 const y=(event.clientY-rect.top)/rect.height*viewport.height;
 let index=0,best=Infinity;
 items.forEach((item,i)=>{
  const pt=viewport.convertToViewportPoint(item.transform[4],item.transform[5]);
  const distance=Math.abs(pt[1]-y)*2+Math.max(0,pt[0]-x,x-pt[0]-item.width);
  if(distance<best){best=distance;index=i;}
 });
 // Show the chosen text immediately, even while the network voice loads.
 clearReadingMark();
 const selection=document.createElement('div');
 selection.className='speech-tap-selection';
 const chosen=items[index],point=viewport.convertToViewportPoint(chosen.transform[4],chosen.transform[5]);
 selection.style.left=Math.max(0,point[0]/viewport.width*100)+'%';
 selection.style.top=Math.max(0,(point[1]-Math.abs(chosen.height||12))/viewport.height*100)+'%';
 selection.style.width=Math.max(3,Math.min(100,(chosen.width||40)/viewport.width*100))+'%';
 selection.style.height=Math.max(1.5,Math.abs(chosen.height||12)/viewport.height*100)+'%';
 slot.append(selection);
 readingMark=selection;
 cancelSpeechPick();
 pdfSpeech?.stop();
 pdfSpeechStart={page:targetPage,index:items[index].sourceIndex};
 pdfSpeechPage=targetPage;
 // Do not navigate: the user has tapped the page already in view.
 showPdfSpeechPage(targetPage);
 await startPdfSpeech();
 speechPlayer('pdf',true);
 pdfSpeech.play();
}
$('pages').addEventListener('click',event=>{void readPdfFromTap(event);});
async function startPdfSpeech(){
 const {createReadAloud}=await speechEngine();
 if(pdfSpeech)return;
 pdfSpeech=createReadAloud({
  getCsrfToken:()=>signedInUser?.csrf||'',
  async getText(){
   if(!documentPDF)return '';
   const speechPage=pdfSpeechCurrentPage();
   const pdfPage=await documentPDF.getPage(speechPage);
   const content=await pdfPage.getTextContent();
   // Read from the tapped page, not the first page of a book spread.
   const start=pdfSpeechStart?.page===speechPage?pdfSpeechStart.index:0;
   pdfSpeechStart=null;
   pdfSpeechItemsPage=0;pdfSpeechItems=null;
   pdfSpeechStartIndex=start;
   return content.items.slice(start).map(item=>(item.str||'')+(item.hasEOL?'\n':' ')).join('').trim();
  },
  async next(){
   const currentPage=pdfSpeechCurrentPage();
   if(!documentPDF||currentPage>=documentPDF.numPages)return false;
   pdfSpeechPage=currentPage+1;
   showPdfSpeechPage(pdfSpeechPage);
   return true;
  },
  onState:state=>speechState('pdf',state)
 });
 wireSpeech('pdf',pdfSpeech);
}
async function startEpubSpeech(){
 const {createReadAloud}=await speechEngine();
 if(epubSpeech)return;
 epubSpeech=createReadAloud({
  getCsrfToken:()=>signedInUser?.csrf||'',
  getText(){return epubController?.readAloudText()||'';},
  next(){return epubController?.readAloudNext()||false;},
  onState:state=>speechState('epub',state)
 });
 wireSpeech('epub',epubSpeech);
}
$('pdf-read-toggle').onclick=()=>beginSpeechPick('pdf');
$('epub-read-toggle').onclick=()=>beginSpeechPick('epub');


async function closeEpubBook({fromHistory=false}={}){
 cancelSpeechPick();epubSpeech?.stop();
 if($('epub-reader').hidden)return;
 if(!fromHistory&&epubHistoryActive){epubHistoryActive=false;history.back();}
 ++epubGeneration;
 if(epubController){epubController.destroy();epubController=null;}
 $('epub-page').replaceChildren();
 $('epub-reader').hidden=true;document.body.classList.remove('epub-open');
 $('library').hidden=false;drawLibrary();refresh(true);
}
window.addEventListener('popstate',()=>{if(!$('epub-reader').hidden){epubHistoryActive=false;closeEpubBook({fromHistory:true});}});
async function openEpubBook(item,start){
 epubSpeech?.stop();
 if($('epub-reader').hidden){history.pushState({pishelfEpub:true},'',location.href);epubHistoryActive=true;}
 const g=++epubGeneration;
 if(epubController){epubController.destroy();epubController=null;}
 const initial=saved[item.id]||{};
 $('library').hidden=true;$('epub-reader').hidden=false;document.body.classList.add('epub-open');
 $('epub-title').textContent=item.title;
 $('epub-page').replaceChildren();
 $('epub-chapters').replaceChildren(new Option('Chapters',''));
 $('epub-position').textContent='Opening…';
 $('epub-status').textContent='Loading EPUB…';
 $('epub-slider').disabled=true;
 $('epub-theme').value=prefs.epubTheme||'light';
 try{
  const module=await import('./epub-reader.js');
  if(g!==epubGeneration)return;
  const controller=await module.createEpubReader({
   url:pdfURL(item),container:$('epub-page'),
   cfi:start===1?'':initial.epubCfi||'',
   theme:prefs.epubTheme||'light',fontSize:prefs.epubFontSize||100,
   canSelectSpeechText:()=>speechPickMode==='epub',
   onTextTap:async()=>{
    if(g!==epubGeneration||speechPickMode!=='epub')return;
    cancelSpeechPick();
    await startEpubSpeech();
    epubSpeech.stop();
    speechPlayer('epub',true);
    epubSpeech.play();
   },
   onLocation:update=>{
    if(g!==epubGeneration)return;
    const {percentage,locationsReady,...patch}=update;
    if(patch.epubCfi&&patch.epubCfi.length<=2048){
     persist(item.id,patch);
    }
    const percent=Math.max(0,Math.min(100,Math.round(percentage*100)));
    $('epub-position').textContent=locationsReady?percent+'% read':'Reading';
    $('epub-slider').disabled=!locationsReady;
    $('epub-slider').value=percent;
   },
   onChapters:toc=>{
    if(g!==epubGeneration)return;
    function appendChapters(items,level=0){
     for(const item of items||[]){
      if(item.href)$('epub-chapters').add(new Option('  '.repeat(level)+(item.label||'Chapter'),item.href));
      if(item.subitems)appendChapters(item.subitems,level+1);
     }
    }
    appendChapters(toc);
   },
   onStatus:message=>{if(g===epubGeneration)$('epub-status').textContent=message;}
  });
  if(g!==epubGeneration){controller.destroy();return;}
  epubController=controller;
  $('epub-status').textContent='';
 }catch(error){
  if(g===epubGeneration)$('epub-status').textContent='Could not open EPUB: '+error.message;
 }
}
$('epub-back').onclick=()=>closeEpubBook();
$('epub-settings').onclick=openSettings;
$('epub-prev').onclick=()=>epubController?.prev().catch(error=>toast(error.message));
$('epub-next').onclick=()=>epubController?.next().catch(error=>toast(error.message));
$('epub-slider').addEventListener('change',e=>epubController?.goPercent(Number(e.target.value)).catch(error=>toast(error.message)));
$('epub-chapters').onchange=e=>{
 if(e.target.value)epubController?.display(e.target.value).catch(error=>toast(error.message));
 e.target.value='';
};
$('epub-font-smaller').onclick=()=>adjustEpubFont(-10);
$('epub-font-larger').onclick=()=>adjustEpubFont(10);
function adjustEpubFont(amount){
 prefs.epubFontSize=Math.max(70,Math.min(190,(prefs.epubFontSize||100)+amount));
 epubController?.setFontSize(prefs.epubFontSize);storePrefs();
 toast('Book text size: '+prefs.epubFontSize+'%');
}
$('epub-theme').onchange=e=>{
 prefs.epubTheme=e.target.value;
 epubController?.setTheme(prefs.epubTheme);
 storePrefs();
};

/** open Magazine: Support the PiShelf reader or library interface. */
// Give the browser a reader history entry so Back returns to the library
// instead of navigating away from PiShelf. Never create one per page.
let readerHistoryActive=false;
window.addEventListener('popstate',()=>{
 if(!$('reader').hidden){
  readerHistoryActive=false;
  closeReader({fromHistory:true});
 }
});
async function openMagazine(item,start){
 pdfSpeech?.stop();
 if($('reader').hidden){
  history.pushState({pishelfReader:true},'',location.href);
  readerHistoryActive=true;
 }
 clearMagazinePrefetches();cancelAllSharpImages();current=item;const g=++generation;const reading=saved[item.id]||{};
 zoom=1;rotation=reading.rotation||0;dimensions.clear();
 $('reader').hidden=false;document.body.classList.add('reader-open');setReaderFocus(true);
 $('library').hidden=true;$('reader-title').textContent=item.title;
 $('view-mode').value=['scroll','single','book'].includes(reading.mode||prefs.mode)?(reading.mode||prefs.mode):'scroll';$('pages').replaceChildren();
 $('reader-status').textContent='Opening PDF…';
 try{
  const engine=await pdfEngine();
  const task=engine.getDocument({url:pdfURL(item),withCredentials:false});
  const doc=await task.promise;
  if(g!==generation){await doc.destroy();return;}
  documentPDF=doc;
  await annotationLoad(item.id);
  if(g!==generation||documentPDF!==doc)return;
  page=Math.max(1,Math.min(start||reading.page||1,doc.numPages));
  $('page-number').max=doc.numPages;
  // Open immediately using the current page dimensions. Hydrate other page
  // sizes in small idle batches to avoid blocking large magazines on startup.
  const first=await doc.getPage(page),firstView=first.getViewport({scale:1});
  if(g!==generation)return;
  dimensions.set(page,{width:firstView.width,height:firstView.height});
  if(page!==1){
   const cover=await doc.getPage(1),v=cover.getViewport({scale:1});
   if(g!==generation)return;
   dimensions.set(1,{width:v.width,height:v.height});
  }
  // Size both book pages using their real PDF dimensions before the first
  // paint; otherwise the companion page can resize after it appears.
  if(isBookSpread())await primeSpreadDimensions(spreadPages(page),doc,g);
  if(g!==generation||documentPDF!==doc)return;
  // Start with the entire page visible and a small margin on every side.
  automaticFit=defaultPagedFit();zoom=fitEntirePageZoom(page);
  await rebuild();$('page-area').focus({preventScroll:true});
  // Read remaining dimensions in the background. Adjust slot heights while
  // preserving the reader's current scroll anchor when pages above it change.
  (async()=>{
   for(let n=1;n<=doc.numPages;n++){
    if(g!==generation||documentPDF!==doc)return;
    if(!dimensions.has(n)){
     try{
      const pdfPage=await doc.getPage(n),v=pdfPage.getViewport({scale:1});
      if(g!==generation||documentPDF!==doc)return;
      dimensions.set(n,{width:v.width,height:v.height});
      const slot=slots.find(el=>+el.dataset.page===n);
      if(slot&&!pinch){
       const area=$('page-area'),before=slot.getBoundingClientRect(),top=area.getBoundingClientRect().top;
       sizeSlot(slot,n);
       if(before.bottom<=top)area.scrollTop+=slot.getBoundingClientRect().height-before.height;
      }
     }catch{return;} // PDF.js fallback still handles missing dimensions
    }
    if(n%4===0)await new Promise(resolve=>setTimeout(resolve,0));
   }
  })();

 }catch(e){if(g===generation)$('reader-status').textContent='Could not open PDF: '+e.message;}
}
/** move: Support the PiShelf reader or library interface. */
function move(n){
 if(!documentPDF)return;
 const oldPage=page;
 const target=Math.max(1,Math.min(documentPDF.numPages,Number(n)||1));
 page=isBookSpread()?spreadStart(target):target;
 if(page===oldPage)return;
 automaticFit='page';
 updatePageUI();
 rebuild();
}
/** Instant page navigation, one spread per step in Two-page Book mode. */
function turnBook(direction){
 if(!documentPDF)return;
 if(!isBookSpread()){move(page+direction);return;}
 const start=spreadStart(page);
 const target=direction>0?(start===1?2:start+2):(start<=2?1:start-2);
 if(target<1||target>documentPDF.numPages||spreadStart(target)===start)return;
 move(target);
}
/** close Reader: Support the PiShelf reader or library interface. */
async function closeReader({fromHistory=false}={}){
 cancelSpeechPick();pdfSpeech?.stop();pdfSpeechPage=null;
 annotationToggle(false);annotationStroke=null;clearCurl();
 if(!fromHistory&&readerHistoryActive){
  readerHistoryActive=false;
  // Back triggers popstate and returns to the existing library history entry.
  history.back();
 }
 clearMagazinePrefetches();cancelAllSharpImages();resetPinch();clearTimeout(scrollTimer);clearTimeout(immersiveTimer);remember();++generation;++layoutEpoch;layoutReady=false;pageObserver?.disconnect();renderQueue=[];const oldDoc=documentPDF;documentPDF=null;if(oldDoc?.destroy)oldDoc.destroy().catch(()=>{});$('reader').hidden=true;document.body.classList.remove('reader-open');$('library').hidden=false;$('pages').replaceChildren();slots=[];renderedSlots.clear();if(document.fullscreenElement)document.exitFullscreen().catch(()=>{});drawLibrary();refresh(true);}
// Thumbnail browser: load only the visible part of a bounded thumbnail list.
// === Thumbnail navigator ====================================================
// 60 pages per batch; IntersectionObserver loads only visible thumbnails.
function showThumbnailRange(begin){
 if(!documentPDF||!current)return;
 const grid=$('thumbnail-grid');grid.replaceChildren();
 const count=documentPDF.numPages;
 begin=Math.max(1,Math.min(begin,Math.max(1,count-59)));
 const end=Math.min(count,begin+59);
 const nav=document.createElement('div');
 nav.className='thumbnail-navigation';
 const previous=document.createElement('button'),next=document.createElement('button');
 previous.textContent='← Previous 60';next.textContent='Next 60 →';
 previous.disabled=begin===1;next.disabled=end===count;
 previous.onclick=()=>showThumbnailRange(begin-60);
 next.onclick=()=>showThumbnailRange(begin+60);
 const jump=document.createElement('input');
 jump.type='number';jump.min='1';jump.max=String(count);jump.value=String(page);
 jump.setAttribute('aria-label','Jump to thumbnail page');jump.className='thumbnail-jump';
 jump.addEventListener('change',()=>{
  const target=Math.max(1,Math.min(count,Math.trunc(Number(jump.value)||page)));
  showThumbnailRange(Math.floor((target-1)/60)*60+1);
 });
 nav.append(previous,document.createTextNode('Pages '+begin+'–'+end+' of '+count),jump,next);
 grid.append(nav);
 for(let n=begin;n<=end;n++){
  const button=document.createElement('button');
  button.type='button';button.setAttribute('aria-label','Go to page '+n);
  if(n===page)button.setAttribute('aria-current','page');
  button.title='Open page '+n;
  const img=document.createElement('img');
  img.loading='lazy';img.decoding='async';img.alt='';
  // Assign src only near the visible thumbnail grid; Safari's lazy loading
  // does not always prevent every eager request inside a modal.
  img.dataset.src='/api/page-image/'+encodeURIComponent(current.id)+'/'+n+'?width=320';
  button.append(img,document.createTextNode('Page '+n));
  button.onclick=()=>{$('thumbnail-dialog').close();move(n);};
  grid.append(button);
 }
 // Observe thumbnails in the modal's own scrolling viewport.
 thumbnailObserver?.disconnect();
 thumbnailObserver=new IntersectionObserver(entries=>{
  for(const entry of entries){
   if(!entry.isIntersecting)continue;
   const image=entry.target;
   if(image.dataset.src){image.src=image.dataset.src;delete image.dataset.src;}
   thumbnailObserver?.unobserve(image);
  }
 },{root:grid,rootMargin:'180px'});
 grid.querySelectorAll('img[data-src]').forEach(img=>thumbnailObserver.observe(img));
}
let thumbnailObserver=null;
$('page-thumbnails').onclick=()=>{
 if(!documentPDF)return;
 showThumbnailRange(Math.floor((page-1)/60)*60+1);
 $('thumbnail-dialog').showModal();
};
$('thumbnail-close').onclick=()=>$('thumbnail-dialog').close();
$('thumbnail-dialog').addEventListener('close',()=>{thumbnailObserver?.disconnect();thumbnailObserver=null;$('thumbnail-grid').replaceChildren();});
async function loadWebPCacheStats(){
 try{
  const stats=await api('/api/webp-cache');
  $('cache-stats').textContent='Cached '+stats.files+' images · '+(stats.bytes/1048576).toFixed(1)+' MB / '+(stats.limit/1048576).toFixed(0)+' MB';
 }catch(e){$('cache-stats').textContent='Cache statistics unavailable: '+e.message;}
}
$('cache-clear').onclick=async()=>{
 if(!await confirmAction('Clear WebP cache?','Images will be converted again when you read magazines. Original PDFs are safe.','Clear cache'))return;
 try{const result=await api('/api/webp-cache/clear',{});toast('Removed '+result.removed+' cached images.');loadWebPCacheStats();}
 catch(e){toast(e.message);}
};
$('back').onclick=closeReader;$('prev').onclick=()=>turnFromControl(-1);$('next').onclick=()=>turnFromControl(1);$('book-turn-prev').onclick=()=>turnFromControl(-1);$('book-turn-next').onclick=()=>turnFromControl(1);$('page-number').onchange=e=>move(parseInt(e.target.value)||1);
/** Button zoom keeps the page point under the viewport center visible.
 * rebuild() recreates page slots and normally scrolls to the page top; restore
 * a fractional anchor afterwards to avoid jumping left or losing the paragraph.
 * Two-finger pinch geometry is intentionally separate and unchanged.
 */
// A lightweight overlay: update text only when the rounded percentage changes.
// A single timeout handles dismissal; no reflow or PDF redraw is needed.
let zoomBadgeTimer=0,zoomBadgePercent=null;
function showZoomBadge(value=zoom){
 if(!documentPDF)return;
 const badge=$('reader-zoom-badge');
 if(!badge)return;
 const percent=Math.round(value*100);
 if(!Number.isFinite(percent))return;
 if(percent!==zoomBadgePercent){badge.textContent=percent+'%';zoomBadgePercent=percent;}
 badge.classList.add('visible');
 clearTimeout(zoomBadgeTimer);
 zoomBadgeTimer=setTimeout(()=>{badge.classList.remove('visible');zoomBadgeTimer=0;},2000);
}
async function zoomWithControls(targetZoom){
 automaticFit=null;
 if(!documentPDF||pinch||!layoutReady)return;
 const area=$('page-area'),view=area.getBoundingClientRect();
 const centerX=view.left+view.width/2,centerY=view.top+view.height/2;
 const spreadMode=isBookSpread();
 const anchorElement=spreadMode
  ?$('pages').querySelector('.book-spread')
  :slots.find(candidate=>{
    const rect=candidate.getBoundingClientRect();
    return rect.top<=centerY&&rect.bottom>=centerY;
   })||slots.find(candidate=>Number(candidate.dataset.page)===page);
 if(!anchorElement)return;
 const rect=anchorElement.getBoundingClientRect();
 const anchor={
  number:spreadMode?spreadStart(page):Number(anchorElement.dataset.page),
  x:Math.max(0,Math.min(1,(centerX-rect.left)/Math.max(1,rect.width))),
  y:Math.max(0,Math.min(1,(centerY-rect.top)/Math.max(1,rect.height)))
 };
 const minimum=fitEntirePageZoom(anchor.number);
 const next=Math.max(minimum,Math.min(3,Number(targetZoom)));
 if(!Number.isFinite(next))return;
 const fits=spreadMode&&next<=minimum+0.001;
 // Re-center even when the user is already at minimum and has panned sideways.
 if(Math.abs(next-zoom)<0.001&&!fits)return;
 const original=documentPDF,g=generation;
 page=anchor.number;zoom=next;
 if(typeof showZoomBadge==='function')showZoomBadge(next);
 pinchScrollLockUntil=performance.now()+500;
 await rebuild();
 if(g!==generation||documentPDF!==original)return;
 if(fits){
  // The spread is CSS-centered when it fits; scroll offsets must not override it.
  area.scrollLeft=0;area.scrollTop=0;
 }else{
  const updated=spreadMode?$('pages').querySelector('.book-spread')
   :slots.find(candidate=>Number(candidate.dataset.page)===anchor.number);
  if(updated){
   const changed=updated.getBoundingClientRect();
   area.scrollLeft+=changed.left+changed.width*anchor.x-centerX;
   area.scrollTop+=changed.top+changed.height*anchor.y-centerY;
  }
 }
 updatePageUI();remember();
}
$('minus').onclick=()=>zoomWithControls(zoom-.25);
$('plus').onclick=()=>zoomWithControls(zoom+.25);
// Desktop PDF navigation: use the existing PDF zoom pipeline, not browser zoom.
const desktopZoomArea=$('page-area');
let desktopZoomWheelTimer=0,desktopZoomWheelTarget=null,desktopDrag=null;
desktopZoomArea.addEventListener('wheel',event=>{
 if(!documentPDF||$('reader').hidden||!(event.ctrlKey||event.metaKey))return;
 event.preventDefault();
 if(!layoutReady||pinch)return;
 const base=desktopZoomWheelTarget??zoom;
 desktopZoomWheelTarget=Math.max(fitEntirePageZoom(page),Math.min(3,base*Math.exp(-event.deltaY*.002)));
 clearTimeout(desktopZoomWheelTimer);
 desktopZoomWheelTimer=setTimeout(()=>{const target=desktopZoomWheelTarget;desktopZoomWheelTarget=null;if(target!==null)void zoomWithControls(target);},55);
},{passive:false});
document.addEventListener('keydown',event=>{
 if(!documentPDF||$('reader').hidden||document.querySelector('dialog[open]')||
   /INPUT|TEXTAREA|SELECT/.test(event.target?.tagName)||event.target?.isContentEditable||
   !(event.ctrlKey||event.metaKey)||event.altKey)return;
 const key=event.key;
 if(key==='+'||key==='='||key==='Add'){event.preventDefault();void zoomWithControls(zoom+.25);}
 else if(key==='-'||key==='_'||key==='Subtract'){event.preventDefault();void zoomWithControls(zoom-.25);}
 else if(key==='0'){event.preventDefault();automaticFit='page';void rebuild();}
});
desktopZoomArea.addEventListener('pointerdown',event=>{
 if(event.pointerType!=='mouse'||event.button!==0||!documentPDF||pinch||
   zoom<=fitEntirePageZoom(page)+.01)return;
 desktopDrag={id:event.pointerId,x:event.clientX,y:event.clientY,left:desktopZoomArea.scrollLeft,top:desktopZoomArea.scrollTop};
 desktopZoomArea.setPointerCapture(event.pointerId);
 desktopZoomArea.classList.add('desktop-panning');
});
desktopZoomArea.addEventListener('pointermove',event=>{
 if(!desktopDrag||event.pointerId!==desktopDrag.id)return;
 desktopZoomArea.scrollLeft=desktopDrag.left-(event.clientX-desktopDrag.x);
 desktopZoomArea.scrollTop=desktopDrag.top-(event.clientY-desktopDrag.y);
});
function endDesktopPan(event){if(!desktopDrag||event.pointerId!==desktopDrag.id)return;
 desktopDrag=null;desktopZoomArea.classList.remove('desktop-panning');
 if(desktopZoomArea.hasPointerCapture(event.pointerId))desktopZoomArea.releasePointerCapture(event.pointerId);
}
desktopZoomArea.addEventListener('pointerup',endDesktopPan);
desktopZoomArea.addEventListener('pointercancel',endDesktopPan);

$('fit-height').onclick=()=>{
 if(!documentPDF)return;
 if($('view-mode').value!=='single')$('view-mode').value='single';
 automaticFit='height';rebuild();
 showZoomBadge(heightFitZoom(page));
};
function fitWidthZoom(){
 const area=$('page-area');
 if(!isBookSpread())return area.clientWidth/Math.min(Math.max(200,area.clientWidth-40),1100);
 const count=spreadPages(page).length,compact=matchMedia('(max-width:600px)').matches;
 return (area.clientWidth-(compact?10:32)-(count-1)*(compact?4:8))/(count*bookPageBaseWidth());
}
$('fit').onclick=()=>zoomWithControls(fitWidthZoom());
$('fit-page').onclick=()=>zoomWithControls(fitEntirePageZoom(page));$('rotate').onclick=()=>{rotation=(rotation+90)%360;rebuild();};$('view-mode').onchange=()=>{prefs.mode=$('view-mode').value;automaticFit=defaultPagedFit();storePrefs();if(documentPDF){if(isBookSpread())page=spreadStart(page);zoom=fitEntirePageZoom(page);rebuild();}};
$('bookmark').onclick=()=>{if(!documentPDF)return;const marks=saved[current.id]?.bookmarks||[];persist(current.id,{bookmarks:marks.includes(page)?marks.filter(n=>n!==page):[...marks,page].sort((a,b)=>a-b)});updatePageUI();updateBookmarks();};$('bookmarks').onchange=e=>{if(e.target.value)move(+e.target.value);e.target.value='';};
$('fullscreen').onclick=async()=>{try{if(document.fullscreenElement)await document.exitFullscreen();else await $('reader').requestFullscreen();}catch{toast('Fullscreen is unavailable in this browser.');}};
let searchTimer;$('search').oninput=()=>{clearTimeout(searchTimer);searchTimer=setTimeout(()=>{visibleLimit=60;drawLibrary();},150);};$('sort').onchange=e=>{prefs.sort=e.target.value;storePrefs();drawLibrary();};$('refresh').onclick=()=>refresh();document.querySelectorAll('[data-filter]').forEach(b=>b.onclick=()=>{filter=b.dataset.filter;category=collectionFilter='';visibleLimit=60;document.querySelectorAll('.tab,.category').forEach(t=>t.classList.toggle('active',t===b));drawLibrary();});
document.addEventListener('keydown',e=>{if($('reader').hidden||document.querySelector('dialog[open]')||/INPUT|SELECT/.test(e.target.tagName))return;if(e.key==='ArrowRight'){e.preventDefault();turnFromControl(1);}if(e.key==='ArrowLeft'){e.preventDefault();turnFromControl(-1);}if(e.key==='Escape'&&!document.fullscreenElement)closeReader();if(e.key.toLowerCase()==='b')$('bookmark').click();if(e.key.toLowerCase()==='c'){e.preventDefault();toggleReaderControls();}});
let lastReaderWidth=0,lastReaderHeight=0;
new ResizeObserver(entries=>{
 const rect=entries[0]?.contentRect;
 if(!rect)return;
 const width=Math.round(rect.width),height=Math.round(rect.height);
 if(width===lastReaderWidth&&height===lastReaderHeight)return;
 lastReaderWidth=width;lastReaderHeight=height;
 clearTimeout(resizeTimer);
 resizeTimer=setTimeout(()=>{if(documentPDF&&layoutReady&&!pinch)rebuild();},120);
}).observe($('page-area'));
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
$('backup-import').onclick=()=>{if(documentPDF||!$('epub-reader').hidden){toast('Return to the library before restoring a backup.');return;}$('backup-file').click();};
$('backup-file').onchange=async e=>{const file=e.target.files[0];e.target.value='';if(!file)return;try{if(file.size>5*1024*1024)throw Error('Backup must be under 5 MB.');const data=JSON.parse(await file.text());if(data.format!=='pishelf-backup'||data.version!==1)throw Error('Select a PiShelf reading backup.');if(!await confirmAction('Restore reading backup?','Matching reading records and metadata will be replaced. Other records and your PDFs are kept.','Restore backup'))return;await saveChain;if(pendingSaves.size)throw Error('Sync pending reading progress before restoring.');await api('/api/backup/restore',data);if(data.preferences){for(const key in defaults){const value=data.preferences[key];if(key==='gestures'){if(typeof value==='boolean')prefs[key]=value;}else if(key==='sort'){if([...$('sort').options].some(o=>o.value===value))prefs.sort=value;}else if($('pref-'+key)&&[...$('pref-'+key).options].some(o=>o.value===value))prefs[key]=value;}storePrefs();}await refresh();toast('Backup restored.');}catch(error){toast(error.message);}};
// Uploads stream one File at a time; the browser never reads the entire file into JS memory.
let uploadXHR=null,uploading=false,uploadCancelled=false;
/** populate Upload Sources: Support the PiShelf reader or library interface. */
function populateUploadSources(){const selected=$('upload-source').value;const sources=[...new Set(categories.map(c=>c.source))];$('upload-source').replaceChildren(...sources.map(s=>new Option(s==='newspapers'?'Newspapers':s==='books'?'Books':'Magazines',s)));if(sources.includes(selected))$('upload-source').value=selected;populateUploadCategories();}
/** populate Upload Categories: Support the PiShelf reader or library interface. */
function populateUploadCategories(){const source=$('upload-source').value;$('upload-category').replaceChildren(...categories.filter(c=>c.source===source).map(c=>new Option(c.path==='.'?'Uncategorised':c.path,c.path)));}
$('upload-source').onchange=populateUploadCategories;
/** upload File: Support the PiShelf reader or library interface. */
function uploadFile(file,source,category){return new Promise((resolve,reject)=>{const xhr=uploadXHR=new XMLHttpRequest();xhr.open('POST','/api/upload?'+new URLSearchParams({source,category,filename:file.name}));xhr.setRequestHeader('Content-Type',file.name.toLowerCase().endsWith('.epub')?'application/epub+zip':'application/pdf');
// Send the same session-bound CSRF token as the JSON API. Uploads use
// XMLHttpRequest to show progress; they must not bypass server security.
xhr.setRequestHeader('X-PiShelf-CSRF',signedInUser?.csrf||'');xhr.upload.onprogress=e=>{if(e.lengthComputable)$('upload-progress').value=Math.round(e.loaded/e.total*100);};xhr.onload=()=>{if(xhr.status===401){location.replace('/login.html');reject(Error('Session expired. Sign in again.'));return;}let result;try{result=JSON.parse(xhr.responseText);}catch{}if(xhr.status>=200&&xhr.status<300)resolve(result);else reject(Error(result?.error||'Upload failed. Check the server or proxy upload limit.'));};xhr.onerror=()=>reject(Error('Upload connection failed.'));xhr.onabort=()=>reject(Error('Upload cancelled.'));xhr.send(file);});}
$('upload-cancel').onclick=()=>{uploadCancelled=true;uploadXHR?.abort();};
$('upload-start').onclick=async()=>{if(uploading)return;if(documentPDF||!$('epub-reader').hidden){toast('Return to the library before uploading.');return;}const files=[...$('upload-files').files];if(!files.length){toast('Choose PDF files or EPUB books first.');return;}if(files.some(f=>{const ext=f.name.toLowerCase().split('.').pop();return (ext!=='pdf'&&!(ext==='epub'&&$('upload-source').value==='books'))||f.size===0||f.size>(ext==='epub'?100:512)*1024*1024;})){toast('Choose PDFs (max 512 MiB) or EPUB books (max 100 MiB, Books only).');return;}uploading=true;uploadCancelled=false;$('upload-start').disabled=true;$('upload-files').disabled=true;$('upload-source').disabled=true;$('upload-category').disabled=true;$('upload-cancel').hidden=false;$('upload-progress').hidden=false;const source=$('upload-source').value,category=$('upload-category').value;let completed=0;try{for(const file of files){if(uploadCancelled)break;$('upload-status').textContent=`Uploading ${completed+1}/${files.length}: ${file.name}`;$('upload-progress').value=0;await uploadFile(file,source,category);completed++;}$('upload-status').textContent=`${completed} file${completed===1?'':'s'} uploaded.`;}catch(error){$('upload-status').textContent=`${completed} uploaded. ${error.message}`;}finally{uploading=false;uploadXHR=null;$('upload-start').disabled=false;$('upload-files').disabled=false;$('upload-source').disabled=false;$('upload-category').disabled=false;$('upload-cancel').hidden=true;$('upload-progress').hidden=true;if(completed===files.length)$('upload-files').value='';await refresh();}};
$('collection-create').onclick=()=>{$('collection-name').value='';$('collection-error').textContent='';$('collection-dialog').showModal();};
$('collection-close').onclick=()=>$('collection-dialog').close();
$('collection-form').onsubmit=async e=>{e.preventDefault();e.submitter.disabled=true;try{await api('/api/collections',{name:$('collection-name').value});$('collection-dialog').close();await refresh();toast('Collection created. Add issues through their Edit options.');}catch(error){$('collection-error').textContent=error.message;}finally{e.submitter.disabled=false;}};
/** reload Collections: Support the PiShelf reader or library interface. */
async function reloadCollections(){collections=await api('/api/collections');collectionSets=new Map(collections.map(c=>[c.id,new Set(c.items)]));if(collectionFilter&&!collectionSets.has(collectionFilter))collectionFilter='';updateFilterOptions();if($('reader').hidden)drawLibrary();drawCollectionManager();}
/** draw Collection Manager: Support the PiShelf reader or library interface. */
let folderAccessPin='';
async function prepareFolderPathSettings(){
 const tab=$('settings-tab-paths');tab.hidden=signedInUser?.role!=='admin';if(tab.hidden)return;
 folderAccessPin='';$('settings-paths-form').hidden=true;$('settings-paths-pin').value='';
 $('settings-paths-pin-status').textContent='';$('settings-paths-status').textContent='';
 try{const status=await api('/api/admin/paths/pin');$('settings-paths-setup').hidden=status.configured;$('settings-paths-locked').hidden=!status.configured;}
 catch(error){$('settings-paths-pin-status').textContent=error.message;}
}
$('settings-paths-set-pin').onclick=async()=>{const password=$('settings-paths-password').value,pin=$('settings-paths-new-pin').value;
 try{await api('/api/admin/paths/pin',{password,pin});$('settings-paths-password').value='';$('settings-paths-new-pin').value='';await prepareFolderPathSettings();toast('Access PIN configured.');}catch(error){toast(error.message);}
};
$('settings-paths-unlock').onclick=async()=>{const pin=$('settings-paths-pin').value;
 try{await api('/api/admin/paths/verify',{pin});folderAccessPin=pin;const paths=await api('/api/admin/paths');const form=$('settings-paths-form');for(const key of ['magazines','newspapers','books'])form.elements[key].value=paths[key]||'';form.hidden=false;$('settings-paths-locked').hidden=true;$('settings-paths-pin').value='';}catch(error){$('settings-paths-pin-status').textContent=error.message;}
};
$('settings-paths-form').onsubmit=async event=>{event.preventDefault();const form=event.currentTarget;const button=form.querySelector('[type=submit]');button.disabled=true;
 try{await api('/api/admin/paths',{...Object.fromEntries(new FormData(form)),pin:folderAccessPin});$('settings-paths-status').textContent='Saved. Restart PiShelf to apply new folders.';}catch(error){$('settings-paths-status').textContent=error.message;}finally{button.disabled=false;}
};
function activateSettingsTab(name){
 document.querySelectorAll('[data-settings-tab]').forEach(button=>{const active=button.dataset.settingsTab===name;button.setAttribute('aria-selected',String(active));button.tabIndex=active?0:-1;});
 document.querySelectorAll('.settings-panel').forEach(panel=>{panel.hidden=panel.id!=='settings-panel-'+name;});
}
document.querySelectorAll('[data-settings-tab]').forEach(button=>{button.addEventListener('click',()=>activateSettingsTab(button.dataset.settingsTab));button.addEventListener('keydown',event=>{if(!['ArrowRight','ArrowLeft','Home','End'].includes(event.key))return;event.preventDefault();const tabs=[...document.querySelectorAll('[data-settings-tab]')];const index=tabs.indexOf(button);const next=event.key==='Home'?0:event.key==='End'?tabs.length-1:(index+(event.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length;activateSettingsTab(tabs[next].dataset.settingsTab);tabs[next].focus();});});
function drawCategoryManager(){
 const box=$('category-manager'),select=$('category-manage-select');if(!box||!select)return;
 const previous=select.value,entries=categories.filter(c=>c.path!=='.');
 select.replaceChildren(new Option('Choose a category…',''),...entries.map(c=>new Option(c.source+' / '+c.path,c.source+'|'+c.path)));
 if(entries.some(c=>c.source+'|'+c.path===previous))select.value=previous;
 const render=()=>{
  box.replaceChildren();const cat=entries.find(c=>c.source+'|'+c.path===select.value);if(!cat)return;
  const used=library.some(item=>item.source===cat.source&&(item.category===cat.path||item.category.startsWith(cat.path+'/')));
  const nested=entries.some(item=>item.source===cat.source&&item.path.startsWith(cat.path+'/'));
  const blocked=used||nested;
  const row=el('div','collection-row'),name=el('input');name.value=cat.path.split('/').pop();name.maxLength=200;name.setAttribute('aria-label','New category name');
  const edit=el('button','','Rename'),remove=el('button','danger','Delete');edit.type=remove.type='button';
  edit.disabled=remove.disabled=blocked;
  const warning=blocked?'Move all documents and remove subcategories before editing or deleting.':'Only the empty category folder will change; no documents are affected.';
  edit.title=remove.title=warning;
  edit.onclick=async()=>{const nextName=name.value.trim();if(!nextName||nextName==='.'||nextName==='..'||nextName.includes('/')||nextName.includes('\\\\')){toast('Enter a valid category name without slashes.');return;}
   const parent=cat.path.includes('/')?cat.path.slice(0,cat.path.lastIndexOf('/')+1):'';const newPath=parent+nextName;
   if(newPath===cat.path)return;
   try{await api('/api/categories',{action:'rename',source:cat.source,path:cat.path,newPath});await refresh();populateUploadSources();drawCategoryManager();select.value=cat.source+'|'+newPath;select.dispatchEvent(new Event('change'));toast('Category renamed.');}catch(error){toast(error.message);}
  };
  remove.onclick=async()=>{if(!await confirmAction('Delete empty category?','Only the empty category folder will be removed. Your PDFs and EPUB books are safe.','Delete category'))return;
   try{await api('/api/categories',{action:'delete',source:cat.source,path:cat.path});await refresh();populateUploadSources();drawCategoryManager();toast('Category removed.');}catch(error){toast(error.message);}
  };
  row.append(name,edit,remove);box.append(row,el('p','hint',warning));
 };
 select.onchange=render;render();
}
function drawCollectionManager(){const box=$('collection-manager');box.replaceChildren();if(!collections.length)box.append(el('p','hint','Create a collection in the library sidebar, then add issues using Edit issue.'));for(const collection of collections){const row=el('div','collection-row'),input=el('input');input.value=collection.name;input.maxLength=80;input.setAttribute('aria-label','Collection name: '+collection.name);const save=el('button','','Rename'),remove=el('button','danger','Remove');save.onclick=async()=>{try{await api('/api/collections',{action:'rename',id:collection.id,name:input.value});await reloadCollections();}catch(error){toast(error.message);}};remove.onclick=async()=>{if(!await confirmAction('Remove collection?','Only this shelf is removed. Your PDFs and reading progress are kept.','Remove collection'))return;try{await api('/api/collections',{action:'delete',id:collection.id});await reloadCollections();}catch(error){toast(error.message);}};row.append(input,save,remove);box.append(row);}}
// Double-tap controls remain available even when swipe/pinch gestures are disabled.
const gesturePointers=new Set();let gestureStart=null,lastTap=null,lastTouchTime=-Infinity,pinch=null,pinchFrame=0,suppressTapUntil=0;
/** update Touch Mode: Handle touch zoom while maintaining the reader position. */
function updateTouchMode(){const area=$('page-area');area.classList.toggle('gesture-navigation',!!prefs.gestures&&!!documentPDF&&zoom<=fitEntirePageZoom(page)+.04);area.classList.toggle('zoomed-in',!!documentPDF&&zoom>fitEntirePageZoom(page)+.01);}
/** toggle Reader Controls: Support the PiShelf reader or library interface. */
let immersiveTimer=null;
function scheduleImmersiveHide(){
 clearTimeout(immersiveTimer);
 if(!documentPDF||$('reader').hidden)return;
 immersiveTimer=setTimeout(()=>{if(documentPDF&&!$('settings').open)setReaderFocus(true);},4500);
}
function toggleReaderControls(){
 const hide=!$('reader').classList.contains('focused');
 setReaderFocus(hide);
 if(!hide)scheduleImmersiveHide();
}
/** touch Pair: Handle touch zoom while maintaining the reader position. */
function touchPair(touches){const a=touches[0],b=touches[1];return {distance:Math.hypot(a.clientX-b.clientX,a.clientY-b.clientY),x:(a.clientX+b.clientX)/2,y:(a.clientY+b.clientY)/2};}
/** reset Pinch: Handle touch zoom while maintaining the reader position. */
function resetPinch(){cancelAnimationFrame(pinchFrame);pinchFrame=0;const active=pinch?.slot;if(active){active.style.transform='';active.style.transformOrigin='';active.style.willChange='';} $('pages').style.transform='';$('pages').style.transformOrigin='';$('pages').style.willChange='';pinch=null;}
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
 const minimum=fitEntirePageZoom(state.page);
 const next=Math.max(minimum,Math.min(Math.max(3,state.startZoom),Math.round(state.nextZoom*100)/100));
 const slot=slots.find(s=>+s.dataset.page===state.page),area=$('page-area');
 if(!slot)return;
 // Capture the PDF point under the fingers before modifying layout.
 const fx=state.fx,fy=state.fy;
 automaticFit=null;zoom=next;page=isBookSpread()?spreadStart(state.page):state.page;
 showZoomBadge(next);
 // Resize the actual page boxes. CSS zoom on the entire pages wrapper
 // creates a large scrollable gutter in iOS Safari and breaks pinch-out.
 $('pages').style.zoom='';
 cssZoomBase=zoom;
 updateTouchMode();
 for(const item of slots)sizeSlot(item,+item.dataset.page);
 const after=slot.getBoundingClientRect();
 area.scrollLeft+=after.left+fx*after.width-state.x;
 area.scrollTop+=after.top+fy*after.height-state.y;
 // At the minimum pinch scale the entire book spread fits. Let CSS center
 // both pages instead of keeping stale one-page horizontal scroll offsets.
 if(isBookSpread()&&zoom<=minimum+.01){
  area.scrollLeft=0;area.scrollTop=0;
 }
 // Keep the zoomed page covering the viewport when it is wider than it.
 const view=area.getBoundingClientRect(),rect=slot.getBoundingClientRect();
 if(rect.width>=view.width){
  if(rect.left>view.left)area.scrollLeft+=rect.left-view.left;
  else if(rect.right<view.right)area.scrollLeft-=view.right-rect.right;
 }
 // Upgrade the current image when magnified, without changing the page box.
 const image=slot.querySelector('img');
 if(image&&current?.id){
  const width=zoom>1.6?2800:zoom>0.85?1600:960;
  const url='/api/page-image/'+encodeURIComponent(current.id)+'/'+state.page+'?width='+width;
  if(!image.src.endsWith(url))image.src=url;
 }
 updatePageUI();remember();
}
$('page-area').addEventListener('touchstart',e=>{
 if(e.touches.length!==2||!prefs.gestures||!documentPDF||!layoutReady)return;
 
 e.preventDefault();lastTap=null;gestureStart=null;clearTimeout(scrollTimer);
 const point=touchPair(e.touches),area=$('page-area'),rect=area.getBoundingClientRect();
 const slot=slots.find(s=>{const r=s.getBoundingClientRect();return point.x>=r.left&&point.x<=r.right&&point.y>=r.top&&point.y<=r.bottom;})||slots.find(s=>+s.dataset.page===page);
 if(!slot||point.distance<10)return;const r=slot.getBoundingClientRect();
 pinch={slot,g:generation,distance:point.distance,startZoom:zoom,nextZoom:zoom,page:+slot.dataset.page,fx:Math.max(0,Math.min(1,(point.x-r.left)/r.width)),fy:Math.max(0,Math.min(1,(point.y-r.top)/r.height)),x:point.x,y:point.y,startX:point.x,startY:point.y};
 if($('view-mode').value==='scroll'){
  // Preview the entire continuous stack together; scaling only one slot
  // leaves the following page visually detached until touchend.
  const pages=$('pages'),bounds=pages.getBoundingClientRect();
  pinch.previewStack=true;
  pages.style.transformOrigin=`${point.x-bounds.left}px ${point.y-bounds.top}px`;
  pages.style.willChange='transform';
 }else{
  slot.style.transformOrigin=`${point.x-r.left}px ${point.y-r.top}px`;slot.style.willChange='transform';
 }
},{passive:false});
$('page-area').addEventListener('touchmove',e=>{
 if(!pinch)return;e.preventDefault();if(e.touches.length!==2)return;
 const point=touchPair(e.touches);pinch.nextZoom=Math.max(fitEntirePageZoom(pinch.page),Math.min(Math.max(3,pinch.startZoom),pinch.startZoom*point.distance/pinch.distance));pinch.x=point.x;pinch.y=point.y;
 if(!pinchFrame)pinchFrame=requestAnimationFrame(()=>{
  pinchFrame=0;if(!pinch)return;
  showZoomBadge(pinch.nextZoom);
  const slot=pinch.slot,area=$('page-area');
  const scale=pinch.nextZoom/pinch.startZoom;
  if(pinch.previewStack){
   // A single composited transform keeps every page in sync while pinching.
   $('pages').style.transform=`translate(${pinch.x-pinch.startX}px, ${pinch.y-pinch.startY}px) scale(${scale})`;
   return;
  }
  let dx=pinch.x-pinch.startX,dy=pinch.y-pinch.startY;
  slot.style.transform=`translate(${dx}px, ${dy}px) scale(${scale})`;
  // Constrain the temporary pinch preview to the viewport, not the page list.
  const view=area.getBoundingClientRect(),rect=slot.getBoundingClientRect();
  if(rect.width>=view.width){
   if(rect.left>view.left)dx-=rect.left-view.left;
   else if(rect.right<view.right)dx+=view.right-rect.right;
  }else dx+=(view.left+view.width/2)-(rect.left+rect.width/2);
  slot.style.transform=`translate(${dx}px, ${dy}px) scale(${scale})`;
 });
},{passive:false});
$('page-area').addEventListener('touchend',e=>{if(pinch&&e.touches.length<2){e.preventDefault();finishPinch();}},{passive:false});
$('page-area').addEventListener('touchcancel',()=>finishPinch(true),{passive:true});
// Draw the peeled sheet over the live slot while the finger moves. The
// underlying reader retains ownership of decoded previews and sharp images.
let curl=null;
function clearCurl(){
 if(!curl)return;
 cancelAnimationFrame(curl.frame);
 curl.canvas.remove();
 curl=null;
}
function beginCurl(direction,start){
 if(rotation||$('view-mode').value==='scroll'||matchMedia('(prefers-reduced-motion: reduce)').matches)return;
 const spread=isBookSpread();
 const target=spread?(direction>0?(page===1?2:page+2):(page<=2?1:page-2)):page+direction;
 if(target===page||target<1||target>documentPDF.numPages)return;
 const visible=spread?spreadPages(page):[page],incoming=spread?spreadPages(target):[target];
 const edge=pages=>direction>0?pages[pages.length-1]:pages[0];
 const slot=slots.find(item=>Number(item.dataset.page)===edge(visible));
 const front=slot?.querySelector('img,canvas'),preview=imagePrefetches.get(edge(incoming));
 if(!front||!preview?.ready)return;
 const rect=slot.getBoundingClientRect(),canvas=document.createElement('canvas');
 const opposite=spread&&slots.length===2?slots[direction>0?0:1].getBoundingClientRect():null;
 const reverse=spread?imagePrefetches.get(direction>0?incoming[0]:incoming[incoming.length-1]):null;
 const book=opposite&&reverse?.ready&&incoming.length===2;
 const bounds=book?{left:Math.min(rect.left,opposite.left),top:Math.min(rect.top,opposite.top),
  width:Math.max(rect.right,opposite.right)-Math.min(rect.left,opposite.left),
  height:Math.max(rect.bottom,opposite.bottom)-Math.min(rect.top,opposite.top)}:rect;
 const scale=Math.min(devicePixelRatio||1,2,1200/Math.max(bounds.width,bounds.height));
 canvas.width=Math.max(1,Math.round(bounds.width*scale));
 canvas.height=Math.max(1,Math.round(bounds.height*scale));
 const ctx=canvas.getContext('2d');
 if(!ctx)return;
 canvas.setAttribute('aria-hidden','true');
 Object.assign(canvas.style,{position:'fixed',pointerEvents:'none',left:bounds.left+'px',top:bounds.top+'px',
  width:bounds.width+'px',height:bounds.height+'px',filter:getComputedStyle(front).filter,zIndex:'1'});
 $('reader').append(canvas);
 curl={canvas,ctx,book,reverse:reverse?.img,opposite,bounds,front,under:preview.img,rect,direction,progress:0,frame:0,
  tilt:start.y<rect.top+rect.height/2?1:-1,slot,epoch:layoutEpoch,origin:page};
}
function drawCurl(progress){
 const {ctx,canvas,front,under,direction,tilt}=curl;
 const w=canvas.width,h=canvas.height;
 curl.progress=progress;
 ctx.setTransform(1,0,0,1,0,0);
 if(curl.book){
  const {rect,opposite,bounds,reverse}=curl;
  ctx.clearRect(0,0,w,h);
  ctx.scale(w/bounds.width,h/bounds.height);
  ctx.translate(-bounds.left,-bounds.top);
  ctx.drawImage(under,rect.left,rect.top,rect.width,rect.height);
  const angle=Math.PI*progress,spine=direction>0?(rect.left+opposite.right)/2:(rect.right+opposite.left)/2;
  const landing=(1-Math.cos(angle))/2;
  const height=rect.height+(opposite.height-rect.height)*landing;
  const top=rect.top+(opposite.top-rect.top)*landing;
  const span=(rect.width+(opposite.width-rect.width)*landing);
  // Project narrow strips of the leaf so the free edge bows as it crosses the spine.
  const strips=48;
  function projected(u){return spine+direction*u*span*Math.cos(angle-.24*Math.sin(angle)*u);}
  for(let i=0;i<strips;i++){
   const u=i/strips,v=(i+1)/strips,x=projected(u),next=projected(v);
   const frontFacing=(next-x)*direction>0,img=frontFacing?front:reverse;
   const iw=img.naturalWidth||img.width,ih=img.naturalHeight||img.height;
   const source=(next>x?u:1-v)*iw,lift=16*Math.sin(angle)*u;
   ctx.drawImage(img,source,0,iw/strips,ih,Math.min(x,next),top-lift,Math.abs(next-x)+.65,height+2*lift);
   ctx.fillStyle='rgba(0,0,0,'+(.22*Math.sin(angle)*(1-u))+')';
   ctx.fillRect(Math.min(x,next),top-lift,Math.abs(next-x)+.65,height+2*lift);
  }
  return;
 }
 ctx.fillStyle='white';ctx.fillRect(0,0,w,h);
 ctx.drawImage(under,0,0,w,h);
 // Reflect the lifted portion across an inclined crease. Flatten the
 // crease at either endpoint so the first and last frames meet the page.
 const slope=tilt*.23*Math.sin(Math.PI*progress)*Math.min(1,w/h);
 const middle=direction>0?w*(1-progress):w*progress;
 const top=middle-slope*h/2,bottom=middle+slope*h/2;
 const fixed=direction>0?0:w,loose=w-fixed;
 function clipSide(edge){
  ctx.beginPath();ctx.moveTo(edge,0);ctx.lineTo(top,0);
  ctx.lineTo(bottom,h);ctx.lineTo(edge,h);ctx.closePath();ctx.clip();
 }
 ctx.save();clipSide(fixed);ctx.drawImage(front,0,0,w,h);ctx.restore();
 const k=2/(1+slope*slope);
 ctx.save();ctx.transform(1-k,k*slope,k*slope,1-k*slope*slope,k*top,-k*slope*top);
 clipSide(loose);ctx.fillStyle='#f6f3ed';ctx.fillRect(0,0,w,h);
 ctx.globalAlpha=.16;ctx.drawImage(front,0,0,w,h);ctx.globalAlpha=1;
 const shade=ctx.createLinearGradient(top,0,top+direction*w*.16,-direction*w*.16*slope);
 shade.addColorStop(0,'rgba(0,0,0,.28)');shade.addColorStop(.5,'rgba(255,255,255,.5)');
 shade.addColorStop(1,'rgba(0,0,0,.04)');ctx.fillStyle=shade;ctx.fillRect(0,0,w,h);ctx.restore();
}
function turnFromControl(direction){
 if(curl)return;
 if(documentPDF){
  beginCurl(direction,{y:$('page-area').getBoundingClientRect().bottom});
  if(curl){drawCurl(0);settleCurl(true);return;}
 }
 turnBook(direction);
}
function settleCurl(commit){
 const active=curl,initial=active.progress,end=commit?1:0,start=performance.now();
 function frame(now){
  if(active!==curl)return;
  if(!active.slot.isConnected||active.epoch!==layoutEpoch||active.origin!==page||!documentPDF){clearCurl();return;}
  const t=Math.min(1,(now-start)/(active.book?480:220));
  drawCurl(initial+(end-initial)*(1-(1-t)**3));
  if(t<1){active.frame=requestAnimationFrame(frame);return;}
  clearCurl();
  if(commit)turnBook(active.direction);
 }
 active.frame=requestAnimationFrame(frame);
}
$('page-area').addEventListener('pointerdown',e=>{
 if(e.pointerType!=='touch')return;
 clearCurl();lastTouchTime=performance.now();gesturePointers.add(e.pointerId);
 if(gesturePointers.size===1)
  gestureStart={x:e.clientX,y:e.clientY,time:performance.now(),multi:false};
 else if(gestureStart)gestureStart.multi=true;
},{passive:true});
$('page-area').addEventListener('pointermove',e=>{
 if(!gestureStart||gestureStart.multi||!gesturePointers.has(e.pointerId)||pinch||
    !documentPDF||!prefs.gestures||zoom>fitEntirePageZoom(page)+.04)return;
 const dx=e.clientX-gestureStart.x,dy=e.clientY-gestureStart.y;
 if(!curl&&Math.abs(dx)>10&&Math.abs(dx)>2*Math.abs(dy))beginCurl(dx<0?1:-1,gestureStart);
 if(curl)drawCurl(Math.max(0,Math.min(1,-curl.direction*dx/curl.bounds.width)));
},{passive:true});
$('page-area').addEventListener('pointercancel',e=>{
 clearCurl();gesturePointers.delete(e.pointerId);gestureStart=null;lastTap=null;
},{passive:true});
$('page-area').addEventListener('pointerup',e=>{
 gesturePointers.delete(e.pointerId);
 if(e.pointerType!=='touch'||pinch||performance.now()<suppressTapUntil
    ||!gestureStart||gestureStart.multi||gesturePointers.size)return;
 const start=gestureStart;gestureStart=null;
 const dx=e.clientX-start.x,dy=e.clientY-start.y,elapsed=performance.now()-start.time;
 if(curl){settleCurl(curl.progress>=.32||(curl.progress>.08&&elapsed<300));lastTap=null;return;}
 if(prefs.gestures&&documentPDF&&zoom<=fitEntirePageZoom(page)+.04
    &&Math.abs(dx)>70&&Math.abs(dx)>Math.abs(dy)*2&&elapsed<700){
  turnBook(dx<0?1:-1);lastTap=null;return;
 }
 if(Math.hypot(dx,dy)<18&&elapsed<300){
  const now=performance.now();
  if(lastTap&&now-lastTap.time<320&&Math.hypot(e.clientX-lastTap.x,e.clientY-lastTap.y)<35){toggleReaderControls();lastTap=null;}
  else lastTap={time:now,x:e.clientX,y:e.clientY};
 }else lastTap=null;
},{passive:true});
$('page-area').addEventListener('dblclick',e=>{if(performance.now()-lastTouchTime>600){e.preventDefault();toggleReaderControls();}});
$('reader-accessibility-controls').onclick=toggleReaderControls;
/** set Reader Focus: Support the PiShelf reader or library interface. */
function setReaderFocus(focused){$('reader').classList.toggle('focused',focused);$('reader-focus').setAttribute('aria-pressed',String(focused));$('reader-focus').textContent=focused?'Show controls':'Immersive';$('reader-accessibility-controls').setAttribute('aria-expanded',String(!focused));if(focused&&$('reader').contains(document.activeElement))$('page-area').focus({preventScroll:true});}
$('reader-focus').onclick=()=>{setReaderFocus(true);};
$('page-area').addEventListener('click',e=>{if(!documentPDF||pinch||curl||performance.now()<suppressTapUntil)return;if($('reader').classList.contains('focused')){setReaderFocus(false);scheduleImmersiveHide();}}, {passive:true});
matchMedia('(prefers-color-scheme: dark)').addEventListener('change',()=>{if(prefs.siteTheme==='system')applyPrefs();});
// === Session bootstrap ======================================================
// The server is authoritative: hiding controls is only a UX improvement;
// every mutation and PDF request is checked again on the backend.
(async()=>{
 try{
  signedInUser=await api('/api/auth/me');
  // Account controls belong in the existing Settings dialog, not in a
  // floating overlay that obscures the PDF reader on small screens.
  $('account-identity').textContent='Signed in as '+signedInUser.username;
  $('account-role').textContent=signedInUser.role==='admin'?'Administrator':'Reader';
  $('account-manage-users').hidden=signedInUser.role!=='admin';
  $('account-logout').onclick=async()=>{
   try{await api('/api/auth/logout',{});}finally{location.replace('/login.html');}
  };
  $('account-change-password').onclick=()=>{
   const dialog=document.createElement('dialog');
   dialog.setAttribute('aria-label','Change password');
   dialog.className='account-password-dialog';
   const form=document.createElement('form');
   const title=document.createElement('h2');title.textContent='Change password';
   const currentLabel=document.createElement('label');currentLabel.textContent='Current password';
   const current=document.createElement('input');current.type='password';current.autocomplete='current-password';current.required=true;currentLabel.append(current);
   const nextLabel=document.createElement('label');nextLabel.textContent='New password (12+ characters)';
   const next=document.createElement('input');next.type='password';next.autocomplete='new-password';next.minLength=12;next.required=true;nextLabel.append(next);
   const confirmLabel=document.createElement('label');confirmLabel.textContent='Confirm new password';
   const confirm=document.createElement('input');confirm.type='password';confirm.autocomplete='new-password';confirm.minLength=12;confirm.required=true;confirmLabel.append(confirm);
   const error=document.createElement('p');error.setAttribute('role','alert');
   const actions=document.createElement('div');actions.className='confirm-buttons';
   const submit=document.createElement('button');submit.textContent='Update password';submit.type='submit';submit.className='primary';
   const cancel=document.createElement('button');cancel.textContent='Cancel';cancel.type='button';cancel.onclick=()=>dialog.close();
   actions.append(cancel,submit);form.append(title,currentLabel,nextLabel,confirmLabel,error,actions);
   dialog.append(form);document.body.append(dialog);
   dialog.addEventListener('close',()=>dialog.remove(),{once:true});
   form.onsubmit=async event=>{
    event.preventDefault();
    if(next.value!==confirm.value){error.textContent='New passwords do not match.';return;}
    submit.disabled=true;error.textContent='';
    try{await api('/api/auth/change-password',{current_password:current.value,new_password:next.value});location.replace('/login.html');}
    catch(e){error.textContent=e.message;current.value='';next.value='';confirm.value='';submit.disabled=false;}
   };
   // Close Settings before opening the password modal so mobile Safari does
   // not stack two modal dialogs on top of one another.
   $('settings').close();
   dialog.showModal();
  };
  applyPrefs();await refresh();
 }catch(e){console.error('PiShelf startup:',e);}
})();
