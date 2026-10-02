export const VIEW_INTERVAL=10000, UPLOAD_INTERVAL=15000, PREDICTION_LIMIT=30000;
export function acceptSnapshot(value,trip,previous,now){
 if(value?.version!==1||value.tripId!==trip.id||!Number.isInteger(value.revision)||value.revision<0||!Number.isFinite(value.snapshotAt)||value.snapshotAt>now+10000||value.expiresAt!==trip.expiresAt)throw new Error('Invalid position snapshot');
 if(previous&&value.revision<previous.revision)return previous;
 if(previous&&value.revision===previous.revision&&value.snapshotAt<previous.snapshotAt)return previous;
 const p=value.position;
 if(p&&(![p.lat,p.lon,p.timestamp,p.accuracy].every(Number.isFinite)||Math.abs(p.lat)>90||Math.abs(p.lon)>180||p.timestamp>now+10000||p.accuracy<=0||p.accuracy>150||!(p.speed==null||Number.isFinite(p.speed)&&p.speed>=0&&p.speed<=100)||!(p.bearing==null||Number.isFinite(p.bearing)&&p.bearing>=0&&p.bearing<360)))throw new Error('Invalid GPS report');
 return value;
}
export function reportStatus(position,now,expiresAt){
 if(now>=expiresAt)return 'ended';
 const age=now-position.timestamp;
 if(age>120000)return 'lost';
 if(age>(position.speed!=null&&position.speed<1?90000:45000))return 'stale';
 return 'fresh';
}
