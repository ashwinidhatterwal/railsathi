export const INTERVAL=15000, VIEW_INTERVAL=10000, STANDBY_INTERVAL=60000, FRESH=45000, EXPIRE=120000;
export class ApiError extends Error {constructor(status,message){super(message);this.status=status}}
export const check=(v,s,m)=>{if(!v)throw new ApiError(s,m)};
export const hash=async s=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s)))).map(b=>b.toString(16).padStart(2,'0')).join('');
export const token=()=>crypto.randomUUID()+crypto.randomUUID();
export function distance(a,b){const r=Math.PI/180,dlat=(b.lat-a.lat)*r,dlon=(b.lon-a.lon)*r;const h=Math.sin(dlat/2)**2+Math.cos(a.lat*r)*Math.cos(b.lat*r)*Math.sin(dlon/2)**2;return 6371000*2*Math.atan2(Math.sqrt(h),Math.sqrt(1-h))}
export function validatePosition(p,now){check(p&&[p.lat,p.lon,p.accuracy,p.timestamp].every(Number.isFinite),400,'Invalid location');check(Math.abs(p.lat)<=90&&Math.abs(p.lon)<=180,400,'Coordinates out of range');check(p.accuracy>0&&p.accuracy<=150,400,'Precise GPS needed (accuracy ≤150 metres)');check(p.timestamp<=now+10000&&now-p.timestamp<=30000,400,'Location too old; get a fresh GPS fix');check(p.speed==null||(Number.isFinite(p.speed)&&p.speed>=0&&p.speed<=100),400,'Invalid speed');check(p.bearing==null||(Number.isFinite(p.bearing)&&p.bearing>=0&&p.bearing<360),400,'Invalid bearing')}
export function normalizeTrip(b,now){check(/^\d{5}$/.test(b.train),400,'Use a five-digit train number');check(/^\d{4}-\d{2}-\d{2}$/.test(b.date)&&Number.isFinite(Date.parse(b.date+'T00:00:00Z'))&&new Date(b.date+'T00:00:00Z').toISOString().startsWith(b.date),400,'Invalid journey start date');check(typeof b.name==='string'&&b.name.trim().length>0&&b.name.length<=100,400,'Name required');const expiresAt=b.expiresAt??now+24*3600000;check(Number.isFinite(expiresAt)&&expiresAt>now&&expiresAt<=now+7*86400000,400,'Expiry must be within seven days');let route=b.route??null;if(route){check(Array.isArray(route)&&route.length>=2&&route.length<=10000,400,'Route needs 2–10000 [longitude,latitude] coordinates');check(route.every(p=>Array.isArray(p)&&p.length===2&&p.every(Number.isFinite)&&Math.abs(p[0])<=180&&Math.abs(p[1])<=90),400,'Invalid route geometry')};return {id:b.train+'_'+b.date,train:b.train,date:b.date,name:b.name.trim(),expiresAt,route}}
export function aggregate(rows,now){const active=rows.filter(r=>now-r.receivedAt<=EXPIRE&&now-r.timestamp<=EXPIRE);if(!active.length)return {position:null,contributors:0,quality:'unavailable'};let winner=null,best=0;for(const a of active){const group=active.filter(b=>distance(a,b)<=Math.max(600,(Math.abs(a.timestamp-b.timestamp)*(Math.max(a.speed??0,b.speed??0,35)))+a.accuracy+b.accuracy));if(group.length>best||(group.length===best&&(!winner||a.timestamp>winner.timestamp))){winner=a;best=group.length}};if(active.length>1&&best<=active.length/2)return {position:null,contributors:active.length,quality:'conflicting'};const {tokenHash,previous,tripId,...position}=winner;return {position,contributors:best,quality:now-winner.timestamp>(winner.speed!=null&&winner.speed<1?90000:FRESH)?'stale':best>1?'corroborated':'single-contributor'}}
export async function handle(request,store,env,now=Date.now()){
 const u=new URL(request.url),path=u.pathname,method=request.method;
 const json=async()=>{check(Number(request.headers.get('content-length')??0)<400000,413,'Payload too large');const txt=await request.text();check(txt.length<400000,413,'Payload too large');try{return JSON.parse(txt)}catch{throw new ApiError(400,'Invalid JSON')}};
 if(path==='/api/health')return {ok:true,intervalMs:INTERVAL};
 if(path==='/api/admin/trips'&&method==='POST'){check(env.ADMIN_KEY&&request.headers.get('authorization')==='Bearer '+env.ADMIN_KEY,401,'Admin authentication required');const trip=normalizeTrip(await json(),now);check(!(await store.trip(trip.id)),409,'Journey already exists');const code=token();await store.putTrip({...trip,codeHash:await hash(code)});return {...trip,contributorCode:code}}
 if(path==='/api/trips'&&method==='GET'){check(/^\d{5}$/.test(u.searchParams.get('train')??'')&&/^\d{4}-\d{2}-\d{2}$/.test(u.searchParams.get('date')??''),400,'Train and journey start date required');const t=await store.trip(u.searchParams.get('train')+'_'+u.searchParams.get('date'));check(t&&t.expiresAt>now,404,'No active journey. An onboard contributor must set up this journey first.');const {codeHash,revision,...safe}=t;return {...safe,serverTime:now,viewIntervalMs:VIEW_INTERVAL,snapshotUrl:env.SNAPSHOT_BASE_URL?env.SNAPSHOT_BASE_URL.replace(/\/$/,'')+'/live/'+t.id+'.json':'/snapshots/'+t.id+'.json'}}
 if(path==='/api/join'&&method==='POST'){const b=await json();const t=await store.trip(b.tripId);check(t&&t.expiresAt>now,404,'Journey ended');check(typeof b.code==='string'&&await hash(b.code)===t.codeHash,403,'Wrong contributor code');check((await store.sessions(t.id)).length<20,429,'Contributor limit reached');const secret=token();await store.putSession({tokenHash:await hash(secret),tripId:t.id,expiresAt:t.expiresAt,lastReceivedAt:0});return {token:secret,expiresAt:t.expiresAt,intervalMs:INTERVAL}}
 if(path==='/api/positions'&&method==='POST'){
  const auth=request.headers.get('authorization')??'';
  check(auth.startsWith('Bearer '),401,'Sharing session required');
  const s=await store.session(await hash(auth.slice(7)));
  check(s&&s.expiresAt>now,401,'Sharing session ended');
  check(!s.lastReceivedAt||now-s.lastReceivedAt>=INTERVAL-1000,429,'Wait for the next upload slot');
  const b=await json();validatePosition(b,now);
  const old=await store.observation(s.tokenHash);
  if(old){check(b.timestamp>old.timestamp,409,'Out-of-order location');check(distance(old,b)<=100*(b.timestamp-old.timestamp)/1000+old.accuracy+b.accuracy+200,400,'Implausible movement')}
  const stationary=!!old&&b.speed!=null&&b.speed<1&&old.speed!=null&&old.speed<1&&b.accuracy<=50&&distance(old,b)<20;
  const primary=await store.primary(s.tripId,s.tokenHash,now,stationary?90000:45000);
  const interval=primary?INTERVAL:STANDBY_INTERVAL;
  check(await store.reserve(s.tokenHash,now,interval),429,'Wait for the next upload slot');
  const p={tokenHash:s.tokenHash,tripId:s.tripId,lat:b.lat,lon:b.lon,accuracy:b.accuracy,timestamp:b.timestamp,receivedAt:now,speed:b.speed??null,bearing:b.bearing??null};
  await store.putObservation(p);await store.bumpRevision(s.tripId);
  const uploadIntervalMs=primary&&!stationary?INTERVAL:STANDBY_INTERVAL;
  return {ok:true,tripId:s.tripId,role:primary?'primary':'standby',stationary,uploadIntervalMs,nextUploadAt:now+uploadIntervalMs};
 }
 if(path==='/api/session'&&method==='DELETE'){
  const auth=request.headers.get('authorization')??'';check(auth.startsWith('Bearer '),401,'Session required');
  const h=await hash(auth.slice(7)),s=await store.session(h);await store.removeSession(h);
  if(s)await store.bumpRevision(s.tripId);return {ok:true,tripId:s?.tripId??null};
 }
 if(path==='/api/state'&&method==='GET'){const t=await store.trip(u.searchParams.get('tripId'));check(t&&t.expiresAt>now,404,'Journey ended');return {...aggregate(await store.observations(t.id),now),serverTime:now,expiresAt:t.expiresAt,intervalMs:VIEW_INTERVAL}}
 throw new ApiError(404,'Not found');
}
