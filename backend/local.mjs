import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import {handle} from './core.mjs';
import {MemoryStore} from './store.mjs';
import {makeSnapshot,CACHE_CONTROL} from './snapshots.mjs';
const store=new MemoryStore(),file=new URL('./local-data.json',import.meta.url),snapshots=new Map();
try{const x=JSON.parse(await fs.readFile(file));store.trips=new Map(x.trips);store.ss=new Map(x.sessions);store.obs=new Map(x.observations);store.leases=new Map(x.leases||[])}catch{}
for(const [id,t] of store.trips)if(t.expiresAt>Date.now())snapshots.set(id,await makeSnapshot(store,id));
const root=path.resolve('web'),types={'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.webmanifest':'application/manifest+json'};
let persist=Promise.resolve();
http.createServer(async(req,res)=>{
 try{
  const url=new URL(req.url,'http://localhost:8787');
  if(url.pathname.startsWith('/snapshots/')){
   if(req.method!=='GET')throw Object.assign(new Error('Method not allowed'),{status:405});
   const id=url.pathname.slice(11).replace(/\.json$/,''),data=snapshots.get(id);
   if(!data)throw Object.assign(new Error('No published snapshot'),{status:404});
   res.writeHead(200,{'Content-Type':'application/json','Cache-Control':CACHE_CONTROL,'Access-Control-Allow-Origin':'*'});res.end(JSON.stringify(data));return;
  }
  if(url.pathname.startsWith('/api/')){
   let body='';for await(const chunk of req){body+=chunk;if(body.length>400000)throw Object.assign(new Error('Payload too large'),{status:413})}
   const request=new Request(url,{method:req.method,headers:req.headers,...(['GET','HEAD'].includes(req.method)?{}:{body})});
   const data=await handle(request,store,{ADMIN_KEY:process.env.ADMIN_KEY});
   if(!['GET','HEAD'].includes(req.method)){
    const id=url.pathname==='/api/admin/trips'?data.id:data.tripId;
    if(id)snapshots.set(id,await makeSnapshot(store,id));
    const bytes=JSON.stringify({trips:[...store.trips],sessions:[...store.ss],observations:[...store.obs],leases:[...store.leases]});
    persist=persist.catch(()=>{}).then(()=>fs.writeFile(file,bytes));await persist;
   }
   res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(data));return;
  }
  const p=path.resolve(root,'.'+decodeURIComponent(url.pathname==='/'?'/index.html':url.pathname));
  if(!p.startsWith(root+path.sep))throw Object.assign(new Error('Not found'),{status:404});
  const bytes=await fs.readFile(p);res.writeHead(200,{'Content-Type':types[path.extname(p)]||'application/octet-stream'});res.end(bytes);
 }catch(e){res.writeHead(e.status||404,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify({error:e.message}))}
}).listen(8787,'0.0.0.0',()=>console.log('RailSaathi: http://localhost:8787 (set ADMIN_KEY to enable journey creation)'));
