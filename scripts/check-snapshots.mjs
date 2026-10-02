// A real deployment check. Does not create journeys or upload location data.
const url=process.argv[2];if(!url||new URL(url).protocol!=='https:')throw new Error('Usage: node scripts/check-snapshots.mjs https://positions.example.com/live/TRAIN_DATE.json');
for(let i=0;i<2;i++){
 const response=await fetch(url,{headers:{Origin:'https://appassets.androidplatform.net'},signal:AbortSignal.timeout(10000)});
 const value=await response.json();console.log(JSON.stringify({status:response.status,cache:response.headers.get('cf-cache-status'),age:response.headers.get('age'),cors:response.headers.get('access-control-allow-origin'),cacheControl:response.headers.get('cache-control'),revision:value.revision,gpsAgeSeconds:value.position?Math.round((Date.now()-value.position.timestamp)/1000):null}));
 if(!response.ok||value.version!==1)process.exitCode=1;
}
