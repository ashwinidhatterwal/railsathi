import {INTERVAL, EXPIRE} from './core.mjs';

export class MemoryStore {
 constructor(){this.trips=new Map();this.ss=new Map();this.obs=new Map();this.leases=new Map()}
 async trip(id){return this.trips.get(id)}
 async putTrip(t){this.trips.set(t.id,{revision:0,...t})}
 async bumpRevision(id){const t=this.trips.get(id);if(t)this.trips.set(id,{...t,revision:(t.revision||0)+1})}
 async session(h){return this.ss.get(h)}
 async putSession(s){this.ss.set(s.tokenHash,s)}
 async sessions(id){return [...this.ss.values()].filter(s=>s.tripId===id)}
 async reserve(h,now,interval=INTERVAL){const s=this.ss.get(h);if(!s||s.expiresAt<=now||(s.lastReceivedAt&&now-s.lastReceivedAt<interval-1000))return false;this.ss.set(h,{...s,lastReceivedAt:now});return true}
 async primary(id,h,now,leaseMs){const p=this.leases.get(id);if(p&&p.until>now&&p.hash!==h)return false;this.leases.set(id,{hash:h,until:now+leaseMs});return true}
 async observation(h){return this.obs.get(h)}
 async putObservation(p){const s=this.ss.get(p.tokenHash);if(s?.lastReceivedAt===p.receivedAt)this.obs.set(p.tokenHash,p)}
 async observations(id){return [...this.obs.values()].filter(p=>p.tripId===id)}
 async removeSession(h){this.ss.delete(h);this.obs.delete(h);for(const [id,p] of this.leases)if(p.hash===h)this.leases.delete(id)}
 async cleanup(now){
  const expiredTrips=[...this.trips.values()].filter(t=>t.expiresAt<=now).map(t=>t.id);
  const changedTrips=[...new Set([...this.obs.values()].filter(p=>now-p.receivedAt>EXPIRE).map(p=>p.tripId))];
  for(const [h,p] of this.obs)if(now-p.receivedAt>EXPIRE)this.obs.delete(h);
  for(const id of changedTrips)await this.bumpRevision(id);
  for(const [h,s] of this.ss)if(s.expiresAt<=now)await this.removeSession(h);
  for(const id of expiredTrips)this.trips.delete(id);
  return {changedTrips:changedTrips.filter(id=>!expiredTrips.includes(id)),expiredTrips};
 }
}

export class D1Store {
 constructor(db){this.db=db}
 async get(table,key){const r=await this.db.prepare(`SELECT data FROM ${table} WHERE id=?`).bind(key).first();return r?JSON.parse(r.data):null}
 async put(table,key,tripId,data){await this.db.prepare(`INSERT INTO ${table}(id,trip_id,data) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,trip_id=excluded.trip_id`).bind(key,tripId,JSON.stringify(data)).run()}
 async list(table,id){const r=await this.db.prepare(`SELECT data FROM ${table} WHERE trip_id=?`).bind(id).all();return r.results.map(r=>JSON.parse(r.data))}
 trip(id){return this.get('trips',id)}
 putTrip(t){return this.put('trips',t.id,t.id,{revision:0,...t})}
 async bumpRevision(id){await this.db.prepare("UPDATE trips SET data=json_set(data,'$.revision',COALESCE(json_extract(data,'$.revision'),0)+1) WHERE id=?").bind(id).run()}
 session(h){return this.get('sessions',h)}
 putSession(s){return this.put('sessions',s.tokenHash,s.tripId,s)}
 sessions(id){return this.list('sessions',id)}
 observation(h){return this.get('observations',h)}
 async reserve(h,now,interval=INTERVAL){const r=await this.db.prepare("UPDATE sessions SET data=json_set(data,'$.lastReceivedAt',?) WHERE id=? AND json_extract(data,'$.expiresAt')>? AND (json_extract(data,'$.lastReceivedAt')=0 OR json_extract(data,'$.lastReceivedAt')<=?)").bind(now,h,now,now-interval+1000).run();return r.meta.changes===1}
 async primary(id,h,now,leaseMs){const r=await this.db.prepare('INSERT INTO live_leases(trip_id,token_hash,lease_until) VALUES(?,?,?) ON CONFLICT(trip_id) DO UPDATE SET token_hash=excluded.token_hash,lease_until=excluded.lease_until WHERE live_leases.lease_until<=? OR live_leases.token_hash=?').bind(id,h,now+leaseMs,now,h).run();return r.meta.changes===1}
 async putObservation(p){await this.db.prepare("INSERT INTO observations(id,trip_id,data) SELECT ?,?,? WHERE EXISTS (SELECT 1 FROM sessions WHERE id=? AND json_extract(data,'$.lastReceivedAt')=?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,trip_id=excluded.trip_id").bind(p.tokenHash,p.tripId,JSON.stringify(p),p.tokenHash,p.receivedAt).run()}
 observations(id){return this.list('observations',id)}
 async removeSession(h){await this.db.batch([this.db.prepare('DELETE FROM sessions WHERE id=?').bind(h),this.db.prepare('DELETE FROM observations WHERE id=?').bind(h),this.db.prepare('DELETE FROM live_leases WHERE token_hash=?').bind(h)])}
 async cleanup(now){
  const expired=await this.db.prepare("SELECT id FROM trips WHERE json_extract(data,'$.expiresAt')<=?").bind(now).all();
  const changed=await this.db.prepare("SELECT DISTINCT trip_id FROM observations WHERE json_extract(data,'$.receivedAt')<?").bind(now-EXPIRE).all();
  await this.db.batch([
   this.db.prepare("DELETE FROM observations WHERE json_extract(data,'$.receivedAt')<?").bind(now-EXPIRE),
   this.db.prepare("DELETE FROM sessions WHERE json_extract(data,'$.expiresAt')<=?").bind(now),
   this.db.prepare('DELETE FROM live_leases WHERE lease_until<=?').bind(now),
   this.db.prepare("DELETE FROM trips WHERE json_extract(data,'$.expiresAt')<=?").bind(now)]);
  const expiredTrips=expired.results.map(r=>r.id),changedTrips=changed.results.map(r=>r.trip_id).filter(id=>!expiredTrips.includes(id));
  for(const id of changedTrips)await this.bumpRevision(id);
  return {changedTrips,expiredTrips};
 }
}
