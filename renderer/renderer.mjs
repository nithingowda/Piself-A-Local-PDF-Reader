import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {resolve,sep} from 'node:path';
import {getDocument} from 'pdfjs-dist/legacy/build/pdf.mjs';
import {createCanvas} from '@napi-rs/canvas';

const roots=['/magazines','/newspapers'];
const allowed=file=>typeof file==='string'&&roots.some(root=>file.startsWith(root+sep)&&resolve(file).startsWith(root+sep));
const send=(res,status,data,type='application/json')=>{res.writeHead(status,{'Content-Type':type,'Content-Length':data.length,'Cache-Control':'private, max-age=300','X-Content-Type-Options':'nosniff'});res.end(data);};
http.createServer(async(req,res)=>{
 if(req.method!=='POST'||req.url!=='/render'){res.writeHead(404);res.end();return;}
 let bytes=0,chunks=[];
 try{
  for await(const chunk of req){bytes+=chunk.length;if(bytes>8192)throw Error('Request too large');chunks.push(chunk);}
  const {file,page=1,width=1200,rotation=0,info=false,format='jpeg'}=JSON.parse(Buffer.concat(chunks).toString());
  if(!allowed(file))throw Error('Invalid file');
  const pdfBytes=new Uint8Array(await readFile(file));
  const task=getDocument({data:pdfBytes,useSystemFonts:true,isEvalSupported:false,disableFontFace:true});
  let doc;
  try{
   doc=await task.promise;
   if(info){
    const dimensions=[];
    for(let n=1;n<=doc.numPages;n++){const p=await doc.getPage(n);const v=p.getViewport({scale:1});dimensions.push({width:v.width,height:v.height});p.cleanup();}
    send(res,200,Buffer.from(JSON.stringify({numPages:doc.numPages,dimensions})));return;
   }
   const n=Number(page),w=Number(width),angle=Number(rotation);
   if(!Number.isInteger(n)||n<1||n>doc.numPages||!Number.isFinite(w)||w<100||w>2600||![0,90,180,270].includes(angle))throw Error('Invalid render parameters');
   const p=await doc.getPage(n),natural=p.getViewport({scale:1,rotation:angle});
   const scale=Math.min(w/natural.width,Math.sqrt(8000000/(natural.width*natural.height)));
   const viewport=p.getViewport({scale,rotation:angle});
   const canvas=createCanvas(Math.max(1,Math.ceil(viewport.width)),Math.max(1,Math.ceil(viewport.height)));
   await p.render({canvasContext:canvas.getContext('2d'),viewport}).promise;
   const png=format==='png';const image=png?await canvas.encode('png'):await canvas.encode('jpeg',85);
   send(res,200,Buffer.from(image),png?'image/png':'image/jpeg');
  }finally{if(doc)await doc.destroy();else await task.destroy().catch(()=>{});}
 }catch(error){const message=String(error?.message||error);console.error('PDF render error:',message);send(res,422,Buffer.from(JSON.stringify({error:message}))); }
}).listen(3001,'0.0.0.0',()=>console.log('PDF.js image renderer listening on 3001'));
