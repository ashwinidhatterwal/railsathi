import {BACKEND_URL} from './config.mjs';import {acceptSnapshot,reportStatus,VIEW_INTERVAL,UPLOAD_INTERVAL} from './live.mjs';
import {TrainMap} from './map.mjs';import {predict,along} from './motion.mjs';
const $=id=>document.getElementById(id),map=new TrainMap($('map'));let trip=null,state=null,demo=false,poll=null,watch=null,uploadTimer=null,latest=null,secret=null,lastUpload=0,sharingUntil=0,offset=0,toastTimer,refreshBusy=false,nextRefresh=0,refreshFailures=0,uploadBusy=false,uploadInterval=UPLOAD_INTERVAL,uploadRole='primary',nextAttempt=0;
let api=BACKEND_URL||localStorage.getItem('backend')||'',language=localStorage.getItem('language')||'en';
const today=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());$('date').value=today();
const say=s=>{clearTimeout(toastTimer);$('toast').textContent=s;$('toast').hidden=false;toastTimer=setTimeout(()=>$('toast').hidden=true,6000)};
function translate(){document.documentElement.lang=language;document.querySelectorAll('[data-en]').forEach(e=>e.textContent=e.dataset[language]);$('language').textContent=language==='en'?'हिं':'EN'}translate();$('language').onclick=()=>{language=language==='en'?'hi':'en';localStorage.setItem('language',language);translate()};
async function call(path,body,method=body?'POST':'GET',auth){const r=await fetch(api+path,{method,headers:{...(body?{'Content-Type':'application/json'}:{}),...(auth?{Authorization:'Bearer '+auth}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(15000),cache:'no-store'});const b=await r.json();if(!r.ok)throw new Error(b.error||'Connection failed');return b}
if(BACKEND_URL)$('settings').hidden=true;
$('settings').onclick=()=>{$('api-url').value=api;$('settings-dialog').showModal()};$('save-settings').onclick=()=>{const value=$('api-url').value.trim().replace(/\/$/,'');if(value){try{const u=new URL(value);if(u.protocol!=='https:'&&!(u.protocol==='http:'&&['localhost','127.0.0.1'].includes(u.hostname)&&!window.Android))throw 0}catch{say('Enter a valid HTTPS backend address');return}}if(isSharing()){say('Stop sharing before changing the backend');return}api=value;localStorage.setItem('backend',api);$('settings-dialog').close();say('Connection saved')};
function isSharing(){return !!secret||!!window.Android?.isSharing()}
function showTrip(){ $('journey-name').textContent=trip.name;$('description').textContent=`${trip.train} · Journey starts ${trip.date}`;map.route=trip.route;$('stats').hidden=false; $('demo-tag').hidden=!demo;$('demo').textContent=demo?'Exit demo':'Try demo';$('onboard').disabled=demo;}
async function refresh(){
 if(!trip||demo||document.hidden||refreshBusy||Date.now()<nextRefresh)return;
 const selected=trip;refreshBusy=true;
 try{
  const url=new URL(selected.snapshotUrl,api||location.origin);
  if(url.protocol!=='https:'&&!(url.protocol==='http:'&&['localhost','127.0.0.1'].includes(url.hostname)))throw new Error('Invalid snapshot address');
  // Default HTTP caching preserves the CDN. No timestamp query or no-store.
  const response=await fetch(url.href,{signal:AbortSignal.timeout(6000)});
  if(!response.ok)throw new Error('Position temporarily unavailable');
  const value=await response.json();
  if(trip!==selected||demo)return;
  state=acceptSnapshot(value,selected,state,Date.now()+offset);
  refreshFailures=0;nextRefresh=0;
  if(state.position&&!map.position)map.center=[state.position.lon,state.position.lat];
 }catch(e){
  if(trip===selected){refreshFailures++;nextRefresh=Date.now()+Math.min(60000,VIEW_INTERVAL*2**Math.min(refreshFailures-1,3));if(refreshFailures===1)say(e.message+' · retaining the last GPS report')}
 }finally{refreshBusy=false}
}
$('search-form').onsubmit=async e=>{e.preventDefault();if(isSharing()){say('Stop sharing before switching trains');return}const b=e.submitter;b.disabled=true;try{const next=await call('/api/trips?train='+$('train').value+'&date='+$('date').value);demo=false;trip=next;offset=next.serverTime-Date.now();nextRefresh=0;refreshFailures=0;state=null;map.position=null;map.point=null;showTrip();await refresh();clearInterval(poll);poll=setInterval(refresh,VIEW_INTERVAL);history.replaceState(null,'','?train='+trip.train+'&date='+trip.date)}catch(e){say(e.message)}finally{b.disabled=false}};
let demoStart=0;const demoRoute=Array.from({length:160},(_,i)=>[77.16+i*.00065,28.6+Math.sin(i/22)*.012+i*.00008]);
$('demo').onclick=()=>{if(isSharing()){say('Stop sharing first');return}clearInterval(poll);if(demo){demo=false;trip=null;state=null;map.position=null;map.point=null;map.route=null;$('demo-tag').hidden=true;$('stats').hidden=true;$('journey-name').textContent='Choose a train to follow';$('description').textContent='Live journeys require an onboard contributor.';$('demo').textContent='Try demo';$('onboard').disabled=false;return}demo=true;state=null;trip={id:'demo',train:'DEMO',date:today(),name:'See the journey in motion',route:demoRoute};demoStart=Date.now();map.point=null;map.center=demoRoute[0];map.follow=true;map.zoom=13;showTrip();$('description').textContent='Synthetic route · demonstration only'};
$('zoom-in').onclick=()=>map.changeZoom(1);$('zoom-out').onclick=()=>map.changeZoom(-1);$('recenter').onclick=()=>map.follow=true;
$('share').onclick=async()=>{if(!trip||demo){say('Select a live journey first');return}const url=new URL(api||location.origin);url.search='?train='+trip.train+'&date='+trip.date;try{if(navigator.share)await navigator.share({title:trip.name,url:url.href});else{await navigator.clipboard.writeText(url.href);say('Journey link copied')}}catch(e){if(e.name!=='AbortError')say('Could not share link')}};
$('onboard').onclick=()=>{if(!trip||demo){say('Select your live journey first');return}if(isSharing()){say('Already sharing this journey');return}$('consent').checked=false;$('code').value='';$('join-dialog').showModal()};
function setSharing(on,text){$('sharing').hidden=!on;$('sharing-status').textContent=text||'GPS sharing active · every 15 seconds';$('onboard').disabled=on||demo}
let nativeWasSharing=false;window.nativeSharingStatus=(active,text)=>{setSharing(active,text);if(!active&&nativeWasSharing)say(text);nativeWasSharing=active};
async function upload(){
 if(!secret||uploadBusy)return;
 if(Date.now()>=sharingUntil){await stop();say('Sharing session expired');return}
 if(!latest||Date.now()-latest.timestamp>30000){setSharing(true,'Waiting for a fresh GPS fix…');return}
 const cadence=uploadRole==='primary'&&latest.speed>2?UPLOAD_INTERVAL:uploadInterval;
 if(Date.now()<nextAttempt||Date.now()-lastUpload<cadence)return;
 const session=secret;uploadBusy=true;
 try{
  const result=await call('/api/positions',latest,'POST',session);
  if(secret!==session)return;
  lastUpload=Date.now();uploadRole=result.role;uploadInterval=result.uploadIntervalMs;nextAttempt=0;
  setSharing(true,result.snapshotPublished===false?'GPS received · public update delayed':uploadRole==='standby'?'Backup contributor · checking every 60 seconds':result.stationary?'Train stationary · checking every 60 seconds':'GPS sent · every 15 seconds');
 }catch(e){if(secret===session){nextAttempt=Date.now()+15000;setSharing(true,'Upload failed · retrying after 15 seconds');say(e.message)}}finally{uploadBusy=false}
}
async function stop(){if(window.Android){window.Android.stopSharing();setSharing(false);return}const token=secret;secret=null;clearInterval(uploadTimer);if(watch!==null)navigator.geolocation.clearWatch(watch);watch=null;latest=null;setSharing(false);if(token)try{await call('/api/session',null,'DELETE',token);await refresh()}catch{say('Sharing stopped on this phone. Last report expires within 2 minutes.')}}
$('stop').onclick=stop;
$('start-sharing').onclick=async()=>{if(!$('consent').checked){say('Please agree to location sharing');return}if(!api&&window.Android){say('Set your backend URL first');return}const btn=$('start-sharing');btn.disabled=true;try{const s=await call('/api/join',{tripId:trip.id,code:$('code').value.trim()});sharingUntil=Math.min(s.expiresAt,Date.now()+12*3600000);$('code').value='';$('join-dialog').close();if(window.Android){window.Android.startSharing(api,s.token,trip.id,sharingUntil);setSharing(true,'Waiting for Android location permission…')}else{if(!navigator.geolocation)throw new Error('Geolocation unavailable');secret=s.token;lastUpload=0;uploadRole='primary';uploadInterval=UPLOAD_INTERVAL;nextAttempt=0;setSharing(true,'Waiting for precise GPS…');watch=navigator.geolocation.watchPosition(p=>{latest={lat:p.coords.latitude,lon:p.coords.longitude,accuracy:p.coords.accuracy,timestamp:p.timestamp,speed:p.coords.speed,bearing:p.coords.heading};upload()},e=>{say(e.message);stop()},{enableHighAccuracy:true,maximumAge:5000,timeout:30000});uploadTimer=setInterval(upload,5000)}}catch(e){say(e.message)}finally{btn.disabled=false}};
function frame(){const now=Date.now()+offset;let p;if(demo){const d=((Date.now()-demoStart)/1000*70)%9000,position=along(demoRoute,d);map.setTrain(position);$('quality').textContent='DEMO · SIMULATED';$('speed').textContent='252';$('age').textContent='Demo';$('people').textContent='0'}else if(state?.position){p=state.position;const age=Math.max(0,(now-p.timestamp)/1000),status=reportStatus(p,now,trip.expiresAt),position=predict(p,trip.route,now);position.stale=status!=='fresh';map.setTrain(position);$('quality').textContent=status==='ended'?'JOURNEY ENDED':status==='lost'?'SIGNAL LOST · MARKER FROZEN':status==='stale'?'STALE · ESTIMATE PAUSED':position.estimated?'ESTIMATED BETWEEN GPS REPORTS':state.quality==='corroborated'?'GPS · MULTIPLE CONTRIBUTORS':'GPS · SINGLE CONTRIBUTOR';$('speed').textContent=p.speed==null?'—':Math.round(p.speed*3.6);$('age').textContent=age<60?`${Math.floor(age)}s`:`${Math.floor(age/60)}m`;$('people').textContent=state.contributors}else if(trip){map.position=null;$('quality').textContent=state?.quality==='conflicting'?'CONFLICTING REPORTS':'WAITING FOR ONBOARD GPS';$('speed').textContent='—';$('age').textContent='—';$('people').textContent=state?.contributors??0}requestAnimationFrame(frame)}requestAnimationFrame(frame);
document.addEventListener('visibilitychange',()=>{if(!document.hidden){nextRefresh=0;refresh()}});if(window.Android?.isSharing())setSharing(true,'GPS sharing active · stop here to end');const params=new URLSearchParams(location.search);if(params.has('train')){$('train').value=params.get('train');$('date').value=params.get('date')||today();$('search-form').requestSubmit()};if('serviceWorker'in navigator&&!window.Android)navigator.serviceWorker.register('./sw.js').catch(()=>{});
