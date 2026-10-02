import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {handle,hash} from '../backend/core.mjs';
import {MemoryStore,D1Store} from '../backend/store.mjs';
import {makeSnapshot,publishSnapshot} from '../backend/snapshots.mjs';
import {acceptSnapshot,reportStatus} from '../web/live.mjs';
import worker from '../backend/worker.mjs';
const now=Date.now(),env={ADMIN_KEY:'test'},id='12915_2026-10-02';
const request=(path,body,token,method=body?'POST':'GET')=>new Request('https://test.local'+path,{method,headers:{...(token?{Authorization:'Bearer '+token}:{}),'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
const position=(t=now,speed=20,lon=77.2)=>({lat:28.6,lon,accuracy:10,timestamp:t,speed,bearing:90});
async function setup(store=new MemoryStore(),options=env){
 const trip=await handle(request('/api/admin/trips',{train:'12915',date:'2026-10-02',name:'Live pilot'},options.ADMIN_KEY),store,options,now);
 const join=()=>handle(request('/api/join',{tripId:trip.id,code:trip.contributorCode}),store,options,now);
 return {store,trip,join};
}
function sqlite(){
 const db=new DatabaseSync(':memory:');db.exec(fs.readFileSync(new URL('../backend/schema.sql',import.meta.url),'utf8'));
 const adapter={prepare(sql){let values=[];return {bind(...v){values=v;return this},async first(){return db.prepare(sql).get(...values)||null},async all(){return {results:db.prepare(sql).all(...values)}},async run(){return {meta:db.prepare(sql).run(...values)}}}},async batch(statements){db.exec('BEGIN');try{const r=[];for(const s of statements)r.push(await s.run());db.exec('COMMIT');return r}catch(e){db.exec('ROLLBACK');throw e}}};
 return {adapter,db};
}
class Bucket {
 constructor(){this.objects=new Map();this.writes=0;this.delay=null}
 async get(key){const x=this.objects.get(key);return x?{etag:x.etag,json:async()=>JSON.parse(x.body)}:null}
 async put(key,body,options){if(this.delay)await this.delay(JSON.parse(body));const x=this.objects.get(key),c=options.onlyIf;if(c instanceof Headers){if(c.get('If-None-Match')==='*'&&x)return null}else if(c.etagMatches!==x?.etag)return null;const etag=String(++this.writes);this.objects.set(key,{body,etag,options});return {etag}}
 async delete(keys){for(const key of Array.isArray(keys)?keys:[keys])this.objects.delete(key)}
}
for(const type of ['memory','sqlite']){
 test(type+': primary selection, standby cadence and failover',async()=>{
  const sql=type==='sqlite'?sqlite():null,{store,join}=await setup(sql?new D1Store(sql.adapter):undefined);
  const a=await join(),b=await join();
  const first=await handle(request('/api/positions',position(),a.token),store,env,now);assert.equal(first.role,'primary');assert.equal(first.uploadIntervalMs,15000);
  assert.equal((await handle(request('/api/positions',position(),b.token),store,env,now)).role,'standby');
  await assert.rejects(handle(request('/api/positions',position(now+15000),b.token),store,env,now+15000),e=>e.status===429);
  const promoted=await handle(request('/api/positions',position(now+60000),b.token),store,env,now+60000);assert.equal(promoted.role,'primary');
  assert.equal((await handle(request('/api/positions',position(now+61000),a.token),store,env,now+61000)).role,'standby');
  sql?.db.close();
 });
 test(type+': stationary throttling resumes on movement and stop releases lease',async()=>{
  const sql=type==='sqlite'?sqlite():null,{store,join}=await setup(sql?new D1Store(sql.adapter):undefined),a=await join(),b=await join();
  await handle(request('/api/positions',position(now,0),a.token),store,env,now);
  const stopped=await handle(request('/api/positions',position(now+15000,0),a.token),store,env,now+15000);assert.equal(stopped.uploadIntervalMs,60000);
  const moving=await handle(request('/api/positions',position(now+30000,20,77.201),a.token),store,env,now+30000);assert.equal(moving.uploadIntervalMs,15000);
  await handle(request('/api/session',null,a.token,'DELETE'),store,env,now+31000);
  assert.equal((await handle(request('/api/positions',position(now+32000),b.token),store,env,now+32000)).role,'primary');
  assert.equal(await store.session(await hash(a.token)),type==='sqlite'?null:undefined);sql?.db.close();
 });
}
test('snapshots omit private session data and advertise a direct CDN URL',async()=>{
 const {store,trip,join}=await setup(),a=await join();await handle(request('/api/positions',position(),a.token),store,env,now);
 const data=await makeSnapshot(store,id,now);assert.equal(data.position.tokenHash,undefined);assert.equal(data.position.tripId,undefined);assert.equal(data.codeHash,undefined);
 const found=await handle(request('/api/trips?train=12915&date=2026-10-02'),store,{...env,SNAPSHOT_BASE_URL:'https://positions.example.com/'},now);
 assert.equal(found.snapshotUrl,'https://positions.example.com/live/'+id+'.json');assert.equal(found.serverTime,now);
 assert.equal(acceptSnapshot(data,trip,null,now),data);
});
test('cached snapshots never reset the GPS age or move revisions backwards',()=>{
 const trip={id,expiresAt:now+1000000},base={version:1,tripId:id,revision:2,snapshotAt:now,expiresAt:trip.expiresAt,position:position()};
 assert.equal(reportStatus(base.position,now+46000,trip.expiresAt),'stale');
 assert.equal(reportStatus(base.position,now+121000,trip.expiresAt),'lost');
 assert.equal(acceptSnapshot({...base,revision:1},trip,base,now+46000),base);
 assert.throws(()=>acceptSnapshot({...base,tripId:'other'},trip,base,now));
 assert.throws(()=>acceptSnapshot({...base,position:{...base.position,speed:200}},trip,null,now));
});
test('a delayed publisher cannot overwrite a newer snapshot',async()=>{
 const {store,join}=await setup(),a=await join(),bucket=new Bucket();
 await publishSnapshot(store,bucket,id);
 await handle(request('/api/positions',position(),a.token),store,env,now);
 let release,entered;const blocked=new Promise(r=>release=r),arrived=new Promise(r=>entered=r);
 bucket.delay=async data=>{if(data.revision===1){entered();await blocked}};
 const delayed=publishSnapshot(store,bucket,id);await arrived;
 await handle(request('/api/session',null,a.token,'DELETE'),store,env,now+1);
 await publishSnapshot(store,bucket,id);release();await delayed;
 const snapshot=await(await bucket.get('live/'+id+'.json')).json();assert.equal(snapshot.revision,2);assert.equal(snapshot.position,null);
});
test('production Worker publishes through R2 and cleanup removes expired public objects',async()=>{
 const {adapter,db}=sqlite(),bucket=new Bucket(),options={ADMIN_KEY:'test',DB:adapter,SNAPSHOTS:bucket,SNAPSHOT_BASE_URL:'https://positions.example.com'};
 const call=async req=>{const r=await worker.fetch(req,options);assert.equal(r.status,200);return r.json()};
 const t=await call(request('/api/admin/trips',{train:'12915',date:'2026-10-02',name:'Worker pilot'},'test'));
 const s=await call(request('/api/join',{tripId:id,code:t.contributorCode}));
 const result=await call(request('/api/positions',position(Date.now()),s.token));assert.equal(result.snapshotPublished,true);
 assert.equal((await(await bucket.get('live/'+id+'.json')).json()).contributors,1);
 await call(request('/api/session',null,s.token,'DELETE'));assert.equal((await(await bucket.get('live/'+id+'.json')).json()).position,null);
 const old=JSON.parse(db.prepare('SELECT data FROM trips WHERE id=?').get(id).data);old.expiresAt=Date.now()-1;db.prepare('UPDATE trips SET data=? WHERE id=?').run(JSON.stringify(old),id);
 await worker.scheduled({},options);assert.equal(await bucket.get('live/'+id+'.json'),null);db.close();
});
test('cleanup clears expired GPS and advances the snapshot revision',async()=>{
 const {adapter,db}=sqlite(),{store,join}=await setup(new D1Store(adapter)),a=await join();
 await handle(request('/api/positions',position(),a.token),store,env,now);
 const before=await makeSnapshot(store,id,now),result=await store.cleanup(now+121000);
 assert.deepEqual(result.changedTrips,[id]);const after=await makeSnapshot(store,id,now+121000);assert.equal(after.position,null);assert.ok(after.revision>before.revision);db.close();
});
