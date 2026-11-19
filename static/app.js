import * as pdfjs from './vendor/pdf.min.mjs';
pdfjs.GlobalWorkerOptions.workerSrc='./vendor/pdf.worker.min.mjs';
const $=id=>document.getElementById(id);
const defaults={siteTheme:'light',theme:'dark',mode:'scroll',quality:'1.5',density:'compact',interval:'15',motion:true};
let prefs={...defaults};try{const stored=JSON.parse(localStorage.getItem('pishelf-settings')||'{}');for(const k in defaults)if(k in stored)prefs[k]=stored[k];}catch{}
let categories=[],sourceFilter='',seriesFilter='',tagFilter='',visibleLimit=60;
let library=[],saved={},filter='all',category='',syncing=false,current=null,documentPDF=null,page=1,zoom=1,rotation=0,generation=0,layoutEpoch=0,layoutReady=false;
let saveChain=Promise.resolve(),pollTimer,toastTimer,scrollTimer,resizeTimer,scrollFrame,issueItem;
const pendingSaves=new Map();
function el(tag,cls,text){const n=document.createElement(tag);if(cls)n.className=cls;if(text)n.textContent=text;return n;}
function toast(message){$('toast').textContent=message;$('toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').hidden=true,5000);}
async function api(path,data){const r=await fetch(path,data===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data),keepalive:JSON.stringify(data).length<60000});let value;try{value=await r.json();}catch{throw Error('Could not reach PiShelf. Check the connection.');}if(!r.ok)throw Error(value.error||'Request failed.');return value;}
function persist(id,patch){
 saved[id]={...saved[id],...patch};if('page' in patch)saved[id].lastRead=Date.now()/1000;
 pendingSaves.set(id,{...pendingSaves.get(id),...patch});$('save-state').textContent='Saving…';
 saveChain=saveChain.catch(()=>{}).then(async()=>{
  const update=pendingSaves.get(id);if(!update)return;pendingSaves.delete(id);
  try{await api('/api/progress',{id,...update});$('save-state').textContent='Progress saved on Pi';}
  catch(e){pendingSaves.set(id,{...update,...pendingSaves.get(id)});$('save-state').textContent='Not saved · reconnect to your Pi to retry';toast(e.message);}
 });return saveChain;
}
function confirmAction(title,message,label){return new Promise(resolve=>{const d=$('confirm-dialog');$('confirm-title').textContent=title;$('confirm-text').textContent=message;$('confirm-yes').textContent=label;const done=v=>{d.close();resolve(v);};$('confirm-no').onclick=()=>done(false);$('confirm-yes').onclick=()=>done(true);d.oncancel=e=>{e.preventDefault();done(false);};d.showModal();});}
const pdfURL=i=>'/'+(i.source||'magazines')+'/' +i.path.split('/').map(encodeURIComponent).join('/');
const options=i=>({url:pdfURL(i),isEvalSupported:false});
const finished=i=>!!saved[i.id]?.completed||(saved[i.id]?.page>=saved[i.id]?.total&&!!saved[i.id]?.total);
const fileSize=n=>n<1048576?Math.max(1,Math.round(n/1024))+' KB':(n/1048576).toFixed(1)+' MB';
const thumbs=new Map();let coverQueue=[],coverBusy=false,coverCacheWarned=false;
const coverURL=item=>'/api/covers/'+item.coverKey;
function cacheThumb(key,data){if(thumbs.size>=120){const oldest=thumbs.keys().next().value;const url=thumbs.get(oldest);if(url?.startsWith('blob:'))URL.revokeObjectURL(url);thumbs.delete(oldest);}thumbs.set(key,data);}
async function covers(){
 if(coverBusy)return;coverBusy=true;
 try{while(coverQueue.length){
  if(!$('reader').hidden)break;
  const {item,button}=coverQueue.shift();if(!button.isConnected)continue;
  let doc;
  try{
   const key=item.coverKey;let data=thumbs.get(key);
   if(!data){
    const response=await fetch(coverURL(item));
    if(response.ok)data=URL.createObjectURL(await response.blob());
    else if(response.status===404){
     doc=await pdfjs.getDocument({...options(item),disableAutoFetch:true,disableStream:true}).promise;
     const p=await doc.getPage(1),v=p.getViewport({scale:260/p.getViewport({scale:1}).width}),c=document.createElement('canvas');
     c.width=Math.ceil(v.width);c.height=Math.ceil(v.height);
     await p.render({canvasContext:c.getContext('2d'),viewport:v}).promise;
     const blob=await new Promise(resolve=>c.toBlob(resolve,'image/jpeg',.78));
     if(!blob)throw Error('Cover could not be generated');
     data=URL.createObjectURL(blob);
     try{const upload=await fetch(coverURL(item),{method:'POST',headers:{'Content-Type':'image/jpeg'},body:blob});if(!upload.ok)throw Error();}catch{if(!coverCacheWarned){coverCacheWarned=true;toast('Covers are visible, but could not be saved on the Pi. Check data-volume permissions.');}}
     c.width=0;c.height=0;
    }else throw Error('Cover cache unavailable');
    cacheThumb(key,data);
   }
   if(button.isConnected){const img=el('img');img.src=data;img.alt='';img.decoding='async';button.replaceChildren(img);}
  }catch{button.classList.add('cover-unavailable');}finally{if(doc)await doc.destroy();}
 }}finally{coverBusy=false;}
}
function dateLabel(item){if(!item.issueDate)return '';const date=new Date(item.issueDate+(item.issueDate.length===7?'-01':'')+'T12:00:00');return Number.isNaN(date.valueOf())?'':date.toLocaleDateString(undefined,{year:'numeric',month:'long',...(item.issueDate.length===10?{day:'numeric'}:{})});}
function selectSeries(value){seriesFilter=value;category=tagFilter='';filter='all';$('search').value='';$('tag-filter').value='';$('series-filter').value=value;visibleLimit=60;drawLibrary();}
function selectTag(value){tagFilter=value;$('tag-filter').value=value;visibleLimit=60;drawLibrary();}
function updateFilterOptions(){
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
function cardFor(item,target){
 const s=saved[item.id]||{},card=el('article','card'),cover=el('button','cover');cover.setAttribute('aria-label','Read '+item.title);cover.append(el('span','placeholder',item.title));cover.onclick=()=>openMagazine(item);cover.item=item;
 const heading=el('div','card-head');heading.append(el('h2','',dateLabel(item)||item.title));const star=el('button','favorite',s.favorite?'★':'☆');star.setAttribute('aria-label','Favourite '+item.title);star.setAttribute('aria-pressed',!!s.favorite);star.onclick=()=>{persist(item.id,{favorite:!saved[item.id]?.favorite});drawLibrary();};heading.append(star);
 const more=el('button','more','•••');more.setAttribute('aria-label','Options for '+item.title);more.onclick=()=>showIssue(item);heading.append(more);
 const seriesButton=el('button','series-link',item.series||item.title);seriesButton.onclick=()=>selectSeries(item.series||item.title);card.append(cover,seriesButton,heading);const chips=el('div','tag-chips');for(const tag of item.tags||[]){const b=el('button','tag-chip',tag);b.onclick=()=>selectTag(tag);chips.append(b);}card.append(chips);
 card.append(el('div','meta',finished(item)?'Finished':s.page?`Page ${s.page} of ${s.total}`:`${item.category==='.'?(item.source==='newspapers'?'Newspaper':'Magazine'):item.category} · ${fileSize(item.size)}`));
 if(s.page||s.completed){const bar=el('div','progress'),fill=el('span');fill.style.width=(finished(item)?100:Math.min(100,s.page/s.total*100))+'%';bar.append(fill);card.append(bar);}target.append(card);coverObserver.observe(cover);
}
function drawLibrary(){
 coverObserver.disconnect();coverQueue=[];$('grid').replaceChildren();$('resume-grid').replaceChildren();$('count').textContent=library.length;
 $('shelf-label').textContent=category||({all:'All publications',reading:'Continue reading',favorites:'Favourites',unread:'Unread',completed:'Finished'}[filter]);
 const q=$('search').value.trim().toLowerCase();const terms=q.split(/\s+/).filter(Boolean);const items=library.filter(i=>(!sourceFilter||i.source===sourceFilter)&&(!seriesFilter||i.series===seriesFilter)&&(!tagFilter||(i.tags||[]).includes(tagFilter))&&(!category||i.category===category)&&terms.every(term=>(i.title+' '+i.series+' '+dateLabel(i)+' '+i.issueDate+' '+i.category+' '+(i.tags||[]).join(' ')).toLowerCase().includes(term))).filter(i=>filter==='all'||filter==='favorites'&&saved[i.id]?.favorite||filter==='reading'&&saved[i.id]?.page&&!finished(i)||filter==='unread'&&!saved[i.id]?.page&&!finished(i)||filter==='completed'&&finished(i));
 const order=filter==='reading'?'recent':$('sort').value;items.sort((a,b)=>order==='title'?a.title.localeCompare(b.title):order==='recent'?(saved[b.id]?.lastRead||0)-(saved[a.id]?.lastRead||0):order==='size'?b.size-a.size:order==='issue'?(b.issueDate||'').localeCompare(a.issueDate||'')||b.modified-a.modified:b.modified-a.modified);
 items.slice(0,visibleLimit).forEach(i=>cardFor(i,$('grid')));$('load-more').hidden=items.length<=visibleLimit;$('active-filters').textContent=[sourceFilter,seriesFilter,tagFilter&&'#'+tagFilter,category,`${items.length} issues`].filter(Boolean).join(' · ');
 const recent=library.filter(i=>saved[i.id]?.page&&!finished(i)).sort((a,b)=>(saved[b.id].lastRead||0)-(saved[a.id].lastRead||0)).slice(0,6);
 $('resume-section').hidden=filter!=='all'||!!category||!!q||!!sourceFilter||!!seriesFilter||!!tagFilter||!recent.length;if(!$('resume-section').hidden)recent.forEach(i=>cardFor(i,$('resume-grid')));
 if(!items.length){const empty=el('div','empty');empty.append(el('h2','',library.length?'No matching issues.':'Your reading room is ready.'),el('p','',library.length?'Try another category, search or filter.':'Copy PDFs into your magazine folder. They appear automatically, with subfolders as categories.'));$('grid').append(empty);}
}
async function refresh(quiet=false){
 if(syncing||!$('reader').hidden)return;syncing=true;if(!quiet)$('status').textContent='Scanning your PDF folder…';
 try{await saveChain;if(pendingSaves.size){for(const [id,patch] of [...pendingSaves])await persist(id,patch);if(pendingSaves.size)throw Error('Reading progress is waiting to sync.');}
 const [next,state,cats]=await Promise.all([api('/api/library'+(quiet?'':'?refresh=1')),api('/api/progress'),api('/api/categories')]);categories=cats;const changed=JSON.stringify(next)!==JSON.stringify(library)||JSON.stringify(state)!==JSON.stringify(saved);library=next;saved=state;
 if(changed||!quiet){if(category&&!categories.some(c=>c.path===category&&(!sourceFilter||c.source===sourceFilter)))category='';updateFilterOptions();drawLibrary();}$('status').textContent='';
 }catch(e){$('status').textContent=e.message||'Could not reach your Pi. Retrying…';}finally{syncing=false;}
}
async function clearProgress(id){await saveChain;if(!await confirmAction(id?'Clear reading progress?':'Clear all reading progress?',id?'This issue will return to Unread. Its bookmarks and favourite status stay.':'This resets reading positions for the entire shared library. PDFs, bookmarks and favourites stay.','Clear progress'))return;try{await api('/api/progress/clear',id?{id}:{});if(id)pendingSaves.delete(id);else pendingSaves.clear();await refresh();toast('Reading progress cleared.');}catch(e){toast(e.message);}}
function showIssue(item){issueItem=item;$('issue-title').textContent=item.title;$('issue-info').textContent=item.path+' · '+fileSize(item.size);const box=$('issue-actions');box.replaceChildren();
 function action(label,fn,cls=''){const b=el('button',cls,label);b.onclick=async()=>{try{await fn();}catch(e){toast(e.message);}};box.append(b);}
 action(saved[item.id]?.page?'Continue reading':'Read magazine',()=>{$('issue-dialog').close();openMagazine(item);});
 action('Read from the beginning',()=>{$('issue-dialog').close();openMagazine(item,1);});
 const download=el('a','action-link','Download PDF');download.href=pdfURL(item)+'?download=1';download.download=item.title+'.pdf';box.append(download);
 action('Edit filename, category & tags',()=>{$('issue-dialog').close();openEdit(item);});
 action('Mark as finished',async()=>{await persist(item.id,{completed:true});$('issue-dialog').close();drawLibrary();});
 action('Clear reading progress',async()=>{$('issue-dialog').close();await clearProgress(item.id);});
 action('Delete magazine…',async()=>{if(!await confirmAction('Move magazine to Trash?',`“${item.title}” will leave your library. You can restore it in Settings → Trash.`,'Move to Trash'))return;await saveChain;await api('/api/trash',{id:item.id});$('issue-dialog').close();await refresh();toast('Moved to Trash. Restore it from Settings.');},'danger');$('issue-dialog').showModal();
}
$('issue-close').onclick=()=>$('issue-dialog').close();
async function loadTrash(){try{const items=await api('/api/trash');$('trash-list').replaceChildren();if(!items.length)$('trash-list').append(el('p','hint','Trash is empty.'));for(const i of items){const row=el('div','trash-row'),text=el('div');text.append(el('strong','',i.title),el('small','',i.path));const b=el('button','','Restore');b.onclick=async()=>{b.disabled=true;try{await api('/api/trash/restore',{token:i.token});await loadTrash();await refresh();toast('Magazine restored.');}catch(e){toast(e.message);b.disabled=false;}};row.append(text,b);$('trash-list').append(row);}}catch(e){$('trash-list').textContent=e.message;}}
function applyPrefs(){document.body.dataset.theme=prefs.siteTheme==='system'?(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'):prefs.siteTheme;$('reader').dataset.pageTheme=prefs.theme;document.body.dataset.density=prefs.density;clearInterval(pollTimer);if(+prefs.interval>0)pollTimer=setInterval(()=>{if(!document.hidden)refresh(true);},+prefs.interval*1000);document.querySelector('footer').textContent=(+prefs.interval?`Checks for PDFs every ${prefs.interval} seconds`:'Manual folder refresh')+' · Progress saved on your Pi';}
function storePrefs(){try{localStorage.setItem('pishelf-settings',JSON.stringify(prefs));}catch{toast('Browser settings storage is unavailable.');}applyPrefs();}
function openSettings(){for(const k of ['siteTheme','theme','mode','quality','density','interval'])$('pref-'+k).value=prefs[k];$('pref-motion').checked=prefs.motion;$('settings').showModal();loadTrash();}
$('settings-open').onclick=openSettings;$('reader-settings').onclick=openSettings;$('settings-close').onclick=()=>$('settings').close();
for(const k of ['siteTheme','theme','mode','quality','density','interval'])$('pref-'+k).onchange=e=>{prefs[k]=e.target.value;storePrefs();if(documentPDF&&(k==='mode'||k==='quality')){$('view-mode').value=prefs.mode;rebuild();}};
$('pref-motion').onchange=e=>{prefs.motion=e.target.checked;storePrefs();};$('clear-all').onclick=()=>{if(documentPDF){toast('Return to the library before clearing all progress.');return;}clearProgress();};$('rescan').onclick=()=>{if(documentPDF){toast('Return to the library to rescan.');return;}refresh();toast('Library scan requested.');};
// Continuous reader: lightweight page placeholders, serialized rendering, bounded canvas memory.
let slots=[],renderQueue=[],renderBusy=false,activeRender=null,loadTask=null,pageObserver=null;
const dimensions=new Map();
function updatePageUI(){if(!documentPDF)return;$('page-number').value=page;$('page-total').textContent='/ '+documentPDF.numPages;$('prev').disabled=page<=1;$('next').disabled=page>=documentPDF.numPages;const marks=saved[current.id]?.bookmarks||[];$('bookmark').textContent=marks.includes(page)?'★':'☆';$('bookmark').setAttribute('aria-pressed',marks.includes(page));}
function updateBookmarks(){const select=$('bookmarks');select.replaceChildren(new Option('Bookmarks',''));for(const n of saved[current.id]?.bookmarks||[])if(n<=documentPDF.numPages)select.add(new Option('Page '+n,n));}
function remember(){if(!documentPDF||!layoutReady)return;persist(current.id,{page,total:documentPDF.numPages});}
function pageWidth(){const available=Math.max(200,$('page-area').clientWidth-40);return Math.min(available,1100)*zoom;}
function sizeSlot(slot,n){const d=dimensions.get(n)||dimensions.get(1)||{width:420,height:580};const swapped=rotation%180!==0;const w=swapped?d.height:d.width,h=swapped?d.width:d.height;slot.style.width=pageWidth()+'px';slot.style.height=pageWidth()*h/w+'px';}
function enqueue(slot){if(slot.dataset.ready==='yes'||slot.dataset.queued==='yes')return;slot.dataset.queued='yes';renderQueue.push({slot,g:generation,epoch:layoutEpoch});renderPages();}
async function renderPages(){if(renderBusy)return;renderBusy=true;try{while(renderQueue.length){const {slot,g,epoch}=renderQueue.shift();slot.dataset.queued='no';if(g!==generation||epoch!==layoutEpoch||!slot.isConnected||!documentPDF)continue;const doc=documentPDF,n=+slot.dataset.page;if(Math.abs(n-page)>3){const rect=slot.getBoundingClientRect(),area=$('page-area').getBoundingClientRect();if(rect.bottom<area.top-700||rect.top>area.bottom+700)continue;}let pdfPage;try{
 pdfPage=await doc.getPage(n);if(g!==generation||epoch!==layoutEpoch)continue;const raw=pdfPage.getViewport({scale:1});dimensions.set(n,{width:raw.width,height:raw.height});
 const before=slot.getBoundingClientRect().height;sizeSlot(slot,n);if(n<page)$('page-area').scrollTop+=slot.getBoundingClientRect().height-before;
 const natural=pdfPage.getViewport({scale:1,rotation:(pdfPage.rotate+rotation)%360});const displayWidth=parseFloat(slot.style.width),scale=displayWidth/natural.width;
 const density=Math.min(devicePixelRatio||1,+prefs.quality);const pixels=natural.width*natural.height*scale*scale*density*density;const cap=Math.min(1,Math.sqrt(5000000/pixels));const viewport=pdfPage.getViewport({scale:scale*density*cap,rotation:(pdfPage.rotate+rotation)%360});
 const canvas=document.createElement('canvas');canvas.width=Math.floor(viewport.width);canvas.height=Math.floor(viewport.height);canvas.setAttribute('aria-label',`Page ${n} of ${doc.numPages}`);canvas.style.width='100%';canvas.style.height='100%';
 activeRender=pdfPage.render({canvasContext:canvas.getContext('2d'),viewport});await activeRender.promise;activeRender=null;
 if(g!==generation||epoch!==layoutEpoch||!slot.isConnected){canvas.width=0;canvas.height=0;continue;}
 slot.replaceChildren(canvas);slot.dataset.ready='yes';trimCanvases();$('reader-status').textContent='';
 }catch(e){if(g===generation&&epoch===layoutEpoch&&e.name!=='RenderingCancelledException'){slot.replaceChildren(el('p','page-placeholder',`Page ${n} could not load.`));const retry=el('button','','Retry');retry.onclick=()=>enqueue(slot);slot.append(retry);}}finally{if(pdfPage)pdfPage.cleanup();} }
 }finally{renderBusy=false;}}
function trimCanvases(){for(const slot of slots){if(Math.abs(+slot.dataset.page-page)>3&&slot.dataset.ready==='yes'){for(const c of slot.querySelectorAll('canvas')){c.width=0;c.height=0;}slot.replaceChildren(el('span','page-placeholder','Page '+slot.dataset.page));slot.dataset.ready='no';}}}
function trackScroll(){if(!layoutReady||!documentPDF||$('view-mode').value!=='scroll')return;const area=$('page-area'),target=area.getBoundingClientRect().top+Math.min(area.clientHeight*.35,240);let best=slots[0];for(const s of slots){if(s.getBoundingClientRect().top<=target)best=s;else break;}if(best){const n=+best.dataset.page;if(n!==page){page=n;updatePageUI();}}trimCanvases();clearTimeout(scrollTimer);scrollTimer=setTimeout(remember,400);}
$('page-area').addEventListener('scroll',()=>{if(!scrollFrame)scrollFrame=requestAnimationFrame(()=>{scrollFrame=null;trackScroll();});},{passive:true});
async function rebuild(){if(!documentPDF)return;const g=generation,epoch=++layoutEpoch;layoutReady=false;pageObserver?.disconnect();renderQueue=[];if(activeRender)activeRender.cancel();for(const c of $('pages').querySelectorAll('canvas')){c.width=0;c.height=0;}$('pages').replaceChildren();slots=[];
 const first=await documentPDF.getPage(1);if(g!==generation||epoch!==layoutEpoch)return;const v=first.getViewport({scale:1});dimensions.set(1,{width:v.width,height:v.height});
 const single=$('view-mode').value==='single',count=documentPDF.numPages;const fragment=document.createDocumentFragment();for(let n=single?page:1;n<=(single?page:count);n++){const slot=el('div','pdf-slot');slot.dataset.page=n;slot.setAttribute('aria-label','PDF page '+n);sizeSlot(slot,n);slot.append(el('span','page-placeholder','Page '+n));slots.push(slot);fragment.append(slot);}$('pages').append(fragment);
 pageObserver=new IntersectionObserver(entries=>{for(const e of entries)if(e.isIntersecting)enqueue(e.target);},{root:$('page-area'),rootMargin:'700px'});slots.forEach(s=>pageObserver.observe(s));
 layoutReady=true;const target=slots.find(s=>+s.dataset.page===page);if(target){$('page-area').scrollTop=target.offsetTop-20;enqueue(target);}updatePageUI();updateBookmarks();remember();}
async function openMagazine(item,start){
 current=item;const g=++generation;zoom=1;rotation=0;dimensions.clear();$('reader').hidden=false;document.body.classList.add('reader-open');setReaderFocus(true);$('library').hidden=true;$('reader-title').textContent=item.title;$('original').href=pdfURL(item);$('view-mode').value=prefs.mode;$('pages').replaceChildren();$('reader-status').textContent='Opening magazine…';$('save-state').textContent='';
 try{loadTask=pdfjs.getDocument(options(item));loadTask.onPassword=(update,reason)=>{const password=prompt(reason===1?'Password for this PDF:':'Incorrect password. Try again:');if(password===null){loadTask.destroy();$('reader-status').textContent='Password entry cancelled. Return to the library to try again.';}else update(password);};const doc=await loadTask.promise;if(g!==generation){await doc.destroy();return;}documentPDF=doc;page=Math.max(1,Math.min(start||saved[item.id]?.page||1,doc.numPages));$('page-number').max=doc.numPages;await rebuild();$('page-area').focus();}
 catch(e){if(g===generation)$('reader-status').textContent='Could not open this PDF. Try Open PDF or return to the library.';}
}
function move(n){if(!documentPDF)return;remember();page=Math.max(1,Math.min(documentPDF.numPages,n));updatePageUI();if($('view-mode').value==='single')rebuild();else{const slot=slots[page-1];enqueue(slot);$('page-area').scrollTo({top:slot.offsetTop-20,behavior:prefs.motion&&!matchMedia('(prefers-reduced-motion: reduce)').matches?'smooth':'auto'});clearTimeout(scrollTimer);scrollTimer=setTimeout(remember,500);}}
async function closeReader(){clearTimeout(scrollTimer);remember();++generation;++layoutEpoch;layoutReady=false;pageObserver?.disconnect();renderQueue=[];activeRender?.cancel();const old=documentPDF;documentPDF=null;if(old)await old.destroy();else if(loadTask)await loadTask.destroy();$('reader').hidden=true;document.body.classList.remove('reader-open');$('library').hidden=false;$('pages').replaceChildren();slots=[];if(document.fullscreenElement)document.exitFullscreen().catch(()=>{});drawLibrary();refresh(true);}
$('back').onclick=closeReader;$('prev').onclick=()=>move(page-1);$('next').onclick=()=>move(page+1);$('page-number').onchange=e=>move(parseInt(e.target.value)||1);
$('minus').onclick=()=>{zoom=Math.max(.5,zoom-.25);rebuild();};$('plus').onclick=()=>{zoom=Math.min(2.5,zoom+.25);rebuild();};$('fit').onclick=()=>{zoom=1;rebuild();};$('fit-page').onclick=()=>{if(!documentPDF)return;const d=dimensions.get(page)||dimensions.get(1);if(!d)return;const ratio=rotation%180?d.width/d.height:d.height/d.width;zoom=Math.min(1,($('page-area').clientHeight-20)/(Math.min(Math.max(200,$('page-area').clientWidth-40),1100)*ratio));rebuild();};$('rotate').onclick=()=>{rotation=(rotation+90)%360;rebuild();};$('view-mode').onchange=()=>{prefs.mode=$('view-mode').value;storePrefs();rebuild();};
$('bookmark').onclick=()=>{if(!documentPDF)return;const marks=saved[current.id]?.bookmarks||[];persist(current.id,{bookmarks:marks.includes(page)?marks.filter(n=>n!==page):[...marks,page].sort((a,b)=>a-b)});updatePageUI();updateBookmarks();};$('bookmarks').onchange=e=>{if(e.target.value)move(+e.target.value);e.target.value='';};
$('fullscreen').onclick=async()=>{try{if(document.fullscreenElement)await document.exitFullscreen();else await $('reader').requestFullscreen();}catch{toast('Fullscreen is unavailable in this browser.');}};
let searchTimer;$('search').oninput=()=>{clearTimeout(searchTimer);searchTimer=setTimeout(()=>{visibleLimit=60;drawLibrary();},150);};$('sort').onchange=drawLibrary;$('refresh').onclick=()=>refresh();document.querySelectorAll('[data-filter]').forEach(b=>b.onclick=()=>{filter=b.dataset.filter;category='';visibleLimit=60;document.querySelectorAll('.tab,.category').forEach(t=>t.classList.toggle('active',t===b));drawLibrary();});
document.addEventListener('keydown',e=>{if($('reader').hidden||document.querySelector('dialog[open]')||/INPUT|SELECT/.test(e.target.tagName))return;if(e.key==='ArrowRight'){e.preventDefault();move(page+1);}if(e.key==='ArrowLeft'){e.preventDefault();move(page-1);}if(e.key==='Escape'&&!document.fullscreenElement)closeReader();if(e.key.toLowerCase()==='b')$('bookmark').click();});
window.addEventListener('resize',()=>{clearTimeout(resizeTimer);resizeTimer=setTimeout(()=>{if(documentPDF)rebuild();},250);});
document.addEventListener('visibilitychange',()=>{if(document.hidden)remember();else{for(const [id,patch] of [...pendingSaves])persist(id,patch);refresh(true);}});window.addEventListener('pagehide',remember);
// Library editing and backup controls.
let editing=null;
function openEdit(item){editing=item;$('edit-filename').value=item.path.split('/').pop();$('edit-series').value=item.series||'';$('edit-date').value=item.issueDate||'';$('edit-tags').value=(item.tags||[]).join(', ');$('edit-error').textContent='';$('edit-category').replaceChildren();for(const cat of categories.filter(c=>c.source===item.source))$('edit-category').add(new Option(cat.path==='.'?'Uncategorised':cat.path,cat.path));$('edit-category').value=item.category;$('edit-dialog').showModal();}
$('edit-close').onclick=()=>$('edit-dialog').close();
$('edit-form').onsubmit=async e=>{e.preventDefault();const button=e.submitter;button.disabled=true;try{await saveChain;if(pendingSaves.size)throw Error('Wait until reading progress has synced before renaming.');await api('/api/issue/edit',{id:editing.id,filename:$('edit-filename').value.trim(),series:$('edit-series').value.trim(),issueDate:$('edit-date').value.trim(),category:$('edit-category').value,tags:$('edit-tags').value.split(',').map(t=>t.trim()).filter(Boolean)});$('edit-dialog').close();await refresh();toast('Issue updated. Bookmarks and progress retained.');}catch(error){$('edit-error').textContent=error.message;}finally{button.disabled=false;}};
$('category-create').onclick=()=>{$('category-source').value=sourceFilter||'magazines';$('category-error').textContent='';$('category-name').value='';$('category-dialog').showModal();};
$('category-close').onclick=()=>$('category-dialog').close();
$('category-form').onsubmit=async e=>{e.preventDefault();e.submitter.disabled=true;try{await api('/api/categories',{source:$('category-source').value,path:$('category-name').value.trim()});$('category-dialog').close();await refresh();toast('Category created. Move issues into it using Edit issue.');}catch(error){$('category-error').textContent=error.message;}finally{e.submitter.disabled=false;}};
$('source-filter').onchange=e=>{sourceFilter=e.target.value;category='';seriesFilter='';visibleLimit=60;updateFilterOptions();drawLibrary();};
$('series-filter').onchange=e=>selectSeries(e.target.value);$('tag-filter').onchange=e=>selectTag(e.target.value);
$('filters-clear').onclick=()=>{sourceFilter=seriesFilter=tagFilter=category='';filter='all';$('source-filter').value='';$('search').value='';visibleLimit=60;document.querySelectorAll('.tab').forEach(b=>b.classList.toggle('active',b.dataset.filter==='all'));updateFilterOptions();drawLibrary();};
$('load-more').onclick=()=>{visibleLimit+=60;drawLibrary();};
$('backup-export').onclick=async()=>{try{if(documentPDF)remember();await saveChain;if(pendingSaves.size)throw Error('Reconnect and sync your reading progress before backing up.');const data=await api('/api/backup');data.preferences={...prefs};const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));const link=el('a');link.href=url;link.download='pishelf-backup-'+new Date().toISOString().slice(0,10)+'.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);toast('Reading backup downloaded. Back up PDF folders separately.');}catch(error){toast(error.message);}};
$('backup-import').onclick=()=>{if(documentPDF){toast('Return to the library before restoring a backup.');return;}$('backup-file').click();};
$('backup-file').onchange=async e=>{const file=e.target.files[0];e.target.value='';if(!file)return;try{if(file.size>5*1024*1024)throw Error('Backup must be under 5 MB.');const data=JSON.parse(await file.text());if(data.format!=='pishelf-backup'||data.version!==1)throw Error('Select a PiShelf reading backup.');if(!await confirmAction('Restore reading backup?','Matching reading records and metadata will be replaced. Other records and your PDFs are kept.','Restore backup'))return;await saveChain;if(pendingSaves.size)throw Error('Sync pending reading progress before restoring.');await api('/api/backup/restore',data);if(data.preferences){for(const key in defaults){const value=data.preferences[key];if(key==='motion'){if(typeof value==='boolean')prefs[key]=value;}else if($('pref-'+key)&&[...$('pref-'+key).options].some(o=>o.value===value))prefs[key]=value;}storePrefs();}await refresh();toast('Backup restored.');}catch(error){toast(error.message);}};
function setReaderFocus(focused){$('reader').classList.toggle('focused',focused);$('reader-tools').setAttribute('aria-expanded',String(!focused));$('reader-tools').textContent=focused?'☰ Controls':'✕ Hide controls';}
$('reader-tools').onclick=()=>setReaderFocus(!$('reader').classList.contains('focused'));
$('reader-focus').onclick=()=>setReaderFocus(true);
matchMedia('(prefers-color-scheme: dark)').addEventListener('change',()=>{if(prefs.siteTheme==='system')applyPrefs();});
applyPrefs();refresh();
