import {createHash} from 'node:crypto';
import {BadRequestException,ConflictException,HttpException,ServiceUnavailableException,UnauthorizedException} from '@nestjs/common';
import {Request} from 'express';
import {AppConfig} from '../config.js';
import {Infrastructure} from '../infrastructure.js';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type EventRow={event_id:string;user_id:string;placement:string;recorded_at:Date};
export class RewardedVideoService {
 constructor(private readonly config:AppConfig,private readonly infrastructure:Infrastructure) {}
 private async storage<T>(operation:()=>Promise<T>):Promise<T> {
  try{return await operation();}catch(error){if(error instanceof HttpException)throw error;throw new ServiceUnavailableException('REWARDED_VIDEO_STORAGE_UNAVAILABLE');}
 }
 private async session(request:Request):Promise<string> {
  const match=/^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.get('authorization')??'');
  if(!match||Buffer.from(match[1]!,'base64url').toString('base64url')!==match[1])throw new UnauthorizedException('SESSION_INVALID');
  const raw=await this.storage(()=>this.infrastructure.redis.withCommandOptions({abortSignal:AbortSignal.timeout(3000)}).get('minigame:session:'+createHash('sha256').update(match[1]!).digest('hex')));
  let session:{appId?:unknown;userId?:unknown}|null;
  try{session=JSON.parse(raw??'null');}catch{throw new UnauthorizedException('SESSION_INVALID');}
  if(!session||typeof session!=='object'||session.appId!==this.config.appId||typeof session.userId!=='string'||!UUID.test(session.userId))throw new UnauthorizedException('SESSION_INVALID');
  const userId=session.userId;
  const user=await this.storage(()=>this.infrastructure.pool.query('SELECT id FROM game_users WHERE app_id=$1 AND id=$2 AND first_login_completed',[this.config.appId,userId]));
  if(!user.rowCount)throw new UnauthorizedException('SESSION_INVALID');
  const rate=await this.storage(()=>this.infrastructure.redis.withCommandOptions({abortSignal:AbortSignal.timeout(3000)}).eval(
   "local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],60) end; return {n,redis.call('TTL',KEYS[1])}",
   {keys:[`minigame:rewarded-video-rate:${this.config.appId}:${userId}`],arguments:[]}
  )) as [number,number];
  if(rate[0]>60){request.res?.setHeader('Retry-After',String(Math.max(1,rate[1])));throw new HttpException('REWARDED_VIDEO_RATE_LIMITED',429);}
  return userId;
 }
 private validate(placement:string,info:unknown):string {
  const invalid=():never=>{throw new BadRequestException('INVALID_REWARDED_VIDEO_REQUEST');};
  const text=(value:string)=>!value.includes('\u0000')&&Buffer.from(value,'utf8').toString('utf8')===value;
  if([...placement].length<1||[...placement].length>64||placement.trim()!==placement||/[\u0000-\u001f\u007f-\u009f]/.test(placement)||!text(placement)||Buffer.byteLength(placement)>256)invalid();
  if(!info||typeof info!=='object'||Array.isArray(info))invalid();
  const visit=(value:unknown,depth:number):void=>{
   if(typeof value==='string'){if(!text(value))invalid();return;}
   if(value===null||typeof value==='boolean')return;
   if(typeof value==='number'){if(!Number.isFinite(value))invalid();return;}
   if(typeof value!=='object'||depth>8)invalid();
   for(const [key,item] of Object.entries(value as object)){if(!text(key))invalid();visit(item,depth+1);}
  };
  visit(info,0);
  const serialized=JSON.stringify(info);if(Buffer.byteLength(serialized,'utf8')>8192)invalid();
  return serialized;
 }
 async completed(request:Request) {
  const userId=await this.session(request),body:unknown=request.body;
  if(Object.keys(request.query).length||!body||typeof body!=='object'||Array.isArray(body))throw new BadRequestException('INVALID_REWARDED_VIDEO_REQUEST');
  const input=body as Record<string,unknown>;
  if(Object.keys(input).some(k=>!['eventId','placement','clientInfo'].includes(k))||typeof input.eventId!=='string'||!UUID.test(input.eventId)||typeof input.placement!=='string')throw new BadRequestException('INVALID_REWARDED_VIDEO_REQUEST');
  const eventId=input.eventId,placement=input.placement,clientInfo=this.validate(placement,input.clientInfo===undefined?{}:input.clientInfo);
  return this.storage(async()=>{
   const client=await this.infrastructure.pool.connect();let discard=false;
   try{
    await client.query('BEGIN');
    const inserted=await client.query<EventRow>('INSERT INTO game_rewarded_video_events(app_id,user_id,event_id,placement,client_info) VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT(app_id,user_id,event_id) DO NOTHING RETURNING event_id,user_id,placement,recorded_at',[this.config.appId,userId,eventId,placement,clientInfo]);
    const row=inserted.rows[0]??(await client.query<EventRow&{same_payload:boolean}>('SELECT event_id,user_id,placement,recorded_at,(placement=$4 AND client_info=$5::jsonb) AS same_payload FROM game_rewarded_video_events WHERE app_id=$1 AND user_id=$2 AND event_id=$3',[this.config.appId,userId,eventId,placement,clientInfo])).rows[0];
    if(!row)throw new Error('Event receipt unavailable');
    if(!inserted.rowCount&&'same_payload' in row&&!row.same_payload)throw new ConflictException('REWARDED_VIDEO_EVENT_CONFLICT');
    await client.query('COMMIT');
    return {eventId:row.event_id,userId:row.user_id,placement:row.placement,recordedAt:row.recorded_at.toISOString(),alreadyRecorded:!inserted.rowCount};
   }catch(error){try{await client.query('ROLLBACK');}catch{discard=true;}throw error;}finally{client.release(discard);}
  });
 }
}
