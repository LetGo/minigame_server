import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import {sendCheckin,scheduleContext,scheduledTargets,type Clock} from './checkin-sender.js';
type DB=Pick<Pool,'query'>;
type Delivery={send(openid:string,page?:string):Promise<void>};
export async function previewDailyCheckin(db:DB,{appId}:{appId:string},clock?:Clock){
 const context=await scheduleContext(db,clock);let eligibleCount=0,cursor:string|null=null;
 for(;;){const rows=await scheduledTargets(db,appId,context.now,cursor,1000);eligibleCount+=rows.length;if(rows.length<1000)break;cursor=rows.at(-1)!.id;}
 return {today:context.today,inWindow:context.inWindow,eligibleCount,clientReportIsNotVerifiedCredit:true};
}
export async function runDailyCheckin(pool:Pool,delivery:Delivery,{appId,delayMs=300}:{appId:string;delayMs?:number},clock?:Clock){
 if(!/^wx[a-f0-9]{16}$/.test(appId)||!Number.isFinite(delayMs)||delayMs<0)throw Error('INVALID_DAILY_CHECKIN_OPTIONS');
 const result={today:'',sent:0,failed:0,unknown:0,skipped:0,attempted:0,stopped:false,stopReason:null as string|null,outsideWindow:false,lockBusy:false};
 const c=await pool.connect();let locked=false,discard=false;
 try{
  const context=await scheduleContext(c,clock);result.today=context.today;
  if(!context.inWindow){result.outsideWindow=true;return result;}
  locked=(await c.query<{locked:boolean}>("SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked",['daily-checkin:'+appId])).rows[0]!.locked;
  if(!locked){result.lockBusy=true;return result;}
  let cursor:string|null=null;
  for(;;){
   const now=await scheduleContext(c,clock);if(now.today!==result.today||!now.inWindow){result.outsideWindow=true;break;}
   const targets=await scheduledTargets(c,appId,now.now,cursor,100);if(!targets.length)break;
   for(const target of targets){
    cursor=target.id;
    if(result.attempted>0&&delayMs)await new Promise(r=>setTimeout(r,delayMs));
    try{
     const receipt=await sendCheckin(pool,delivery,{appId,userId:target.id,requestId:randomUUID(),scheduledDate:result.today},clock);
     result.attempted++;
     const verified=(await c.query<{state:string}>('SELECT state FROM game_subscription_sends WHERE app_id=$1 AND request_id=$2',[appId,receipt.requestId])).rows[0];
     if(!verified||verified.state!==receipt.state)throw Error('SUBSCRIPTION_RECEIPT_READBACK_FAILED');
     if(receipt.state==='sent')result.sent++;
     else if(receipt.state==='failed'){
      result.failed++;
      // Only a definitive per-user no-consent response is safe to continue past.
      if(receipt.upstreamCode!==43101){result.stopped=true;result.stopReason='upstream_failure';break;}
     }else{result.unknown++;result.stopped=true;result.stopReason='uncertain_delivery';break;}
    }catch(error){
     const message=(error as Error)?.message;
     if(message==='SUBSCRIPTION_SCHEDULE_OUTSIDE_WINDOW'){result.outsideWindow=true;break;}
     if(['SUBSCRIPTION_SCHEDULE_INELIGIBLE','SUBSCRIPTION_NOT_ACCEPTED','SUBSCRIPTION_SEND_PENDING','SUBSCRIPTION_USER_NOT_FOUND'].includes(message)){result.skipped++;continue;}
     result.stopped=true;result.stopReason='storage_or_reservation_uncertain';break;
    }
   }
   if(result.stopped||result.outsideWindow)break;
  }
 }catch{result.stopped=true;result.stopReason='storage_unavailable';}
 finally{
  if(locked){try{await c.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',['daily-checkin:'+appId]);}catch{discard=true;result.stopped=true;result.stopReason='lock_release_uncertain';}}
  c.release(discard);
 }
 return result;
}
