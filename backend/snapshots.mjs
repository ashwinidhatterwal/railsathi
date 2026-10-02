import {aggregate, ApiError, VIEW_INTERVAL} from './core.mjs';
export const CACHE_CONTROL='public, max-age=5, s-maxage=5, must-revalidate';
export const validTripId=id=>/^\d{5}_\d{4}-\d{2}-\d{2}$/.test(id||'');

// Read again after observations to detect a concurrent mutation. Revisions also
// prevent a delayed publisher from overwriting a newer public snapshot.
export async function makeSnapshot(store,id,now=Date.now()){
 if(!validTripId(id))throw new ApiError(400,'Invalid journey');
 for(let attempt=0;attempt<4;attempt++){
  const before=await store.trip(id);
  if(!before||before.expiresAt<=now)throw new ApiError(404,'Journey ended');
  const rows=await store.observations(id),after=await store.trip(id);
  if(!after||(before.revision||0)!==(after.revision||0))continue;
  return {version:1,tripId:id,revision:after.revision||0,snapshotAt:now,
   expiresAt:after.expiresAt,viewIntervalMs:VIEW_INTERVAL,...aggregate(rows,now)};
 }
 throw new ApiError(503,'Position changing; try again shortly');
}

export async function publishSnapshot(store,bucket,id){
 if(!bucket||!id)return false;
 const key='live/'+id+'.json';
 for(let attempt=0;attempt<4;attempt++){
  const old=await bucket.get(key),previous=old?await old.json():null;
  const next=await makeSnapshot(store,id);
  if(previous&&previous.revision>=next.revision)return true;
  const onlyIf=old?{etagMatches:old.etag}:new Headers({'If-None-Match':'*'});
  const result=await bucket.put(key,JSON.stringify(next),{onlyIf,httpMetadata:{contentType:'application/json',cacheControl:CACHE_CONTROL}});
  if(result)return true;
 }
 throw new Error('Concurrent snapshot publication did not settle');
}
