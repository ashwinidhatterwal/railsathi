import {handle} from './core.mjs';
import {D1Store} from './store.mjs';
import {makeSnapshot,publishSnapshot,CACHE_CONTROL} from './snapshots.mjs';
export default {
 async fetch(req,env){
  const url=new URL(req.url),store=new D1Store(env.DB);
  if(url.pathname.startsWith('/snapshots/')){
   // Pilot fallback. This still invokes a Worker: production uses R2's custom
   // domain directly, advertised through SNAPSHOT_BASE_URL on journey lookup.
   try{
    if(req.method!=='GET')return new Response(null,{status:405});
    const id=url.pathname.slice(11).replace(/\.json$/,'');
    return new Response(JSON.stringify(await makeSnapshot(store,id)),{headers:{'Content-Type':'application/json','Cache-Control':CACHE_CONTROL,'Access-Control-Allow-Origin':'*'}});
   }catch(e){return new Response(JSON.stringify({error:e.status?e.message:'Server error'}),{status:e.status||500,headers:{'Content-Type':'application/json','Cache-Control':'no-store','Access-Control-Allow-Origin':'*'}})}
  }
  if(!url.pathname.startsWith('/api/'))return env.ASSETS.fetch(req);
  const origin=req.headers.get('origin');
  const allowed=!origin||origin===url.origin||origin==='https://appassets.androidplatform.net'||origin===env.WEB_ORIGIN;
  const headers={'Content-Type':'application/json','Cache-Control':'no-store','Vary':'Origin','Access-Control-Allow-Origin':allowed?(origin||url.origin):url.origin,'Access-Control-Allow-Methods':'GET,POST,DELETE,OPTIONS','Access-Control-Allow-Headers':'Content-Type,Authorization'};
  if(!allowed)return new Response(JSON.stringify({error:'Origin not allowed'}),{status:403,headers});
  if(req.method==='OPTIONS')return new Response(null,{status:204,headers});
  try{
   const data=await handle(req,store,env);
   const id=url.pathname==='/api/admin/trips'?data.id:data.tripId;
   if(id&&env.SNAPSHOTS&&['POST','DELETE'].includes(req.method)&&url.pathname!=='/api/join'){
    // Await publication so failure is visible without rejecting accepted GPS.
    try{await publishSnapshot(store,env.SNAPSHOTS,id);data.snapshotPublished=true}
    catch{data.snapshotPublished=false;console.error('Snapshot publication failed for journey',id)}
   }
   return new Response(JSON.stringify(data),{headers});
  }catch(e){return new Response(JSON.stringify({error:e.status?e.message:'Server error'}),{status:e.status||500,headers})}
 },
 async scheduled(event,env){
  const store=new D1Store(env.DB),result=await store.cleanup(Date.now());
  if(env.SNAPSHOTS){
   for(let i=0;i<result.expiredTrips.length;i+=1000)await env.SNAPSHOTS.delete(result.expiredTrips.slice(i,i+1000).map(id=>'live/'+id+'.json'));
   for(const id of result.changedTrips)await publishSnapshot(store,env.SNAPSHOTS,id);
  }
 }
};
