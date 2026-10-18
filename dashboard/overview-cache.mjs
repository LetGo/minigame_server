// Server-side only: one bounded overview snapshot and one in-flight query per game/server.
// HTTP remains no-store, and the caller must authenticate before requesting this cache.
const ttlMs=30000,dayMs=86400000,beijingOffsetMs=8*3600000;
const beijingDay=ms=>new Date(ms+beijingOffsetMs).toISOString().slice(0,10);
export function createOverviewCache({appId,load,now=Date.now}){
 let entry=null,pending=null;
 return async function overview(){
  // An old-day query finishing after midnight must be discarded and retried once.
  for(let attempt=0;attempt<2;attempt++){
   const at=now(),day=beijingDay(at),key=appId+':'+day;
   if(entry?.key===key&&at>=entry.startedAt&&at<entry.expiresAt)return entry.value;
   if(!pending){
    entry=null;const startedAt=at;
    pending=Promise.resolve().then(()=>load(appId)).then(value=>{
     const generated=Date.parse(value?.generatedAt),finishedAt=now();
     if(!value||!/^\d{4}-\d{2}-\d{2}$/.test(value.today??'')||!Number.isFinite(generated))throw new Error('Invalid overview snapshot');
     const expiresAt=Math.min(startedAt+ttlMs,generated+ttlMs,Date.parse(value.today+'T00:00:00+08:00')+dayMs);
     if(value.today===beijingDay(finishedAt)&&finishedAt>=startedAt&&finishedAt<expiresAt)entry={key:appId+':'+value.today,startedAt,expiresAt,value};
     return value;
    }).finally(()=>{pending=null;});
   }
   const value=await pending;
   if(value.today===beijingDay(now()))return value;
  }
  throw new Error('Overview day unavailable');
 };
}
