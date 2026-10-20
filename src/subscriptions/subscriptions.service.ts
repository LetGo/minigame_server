import {createHash} from 'node:crypto';
import {BadRequestException,ConflictException,HttpException,ServiceUnavailableException,UnauthorizedException} from '@nestjs/common';
import type {Request} from 'express';
import type {AppConfig} from '../config.js';
import {Infrastructure} from '../infrastructure.js';
import {CHECKIN_TEMPLATE_ID,CHECKIN_TEMPLATE_NUMBER,buildCheckinMessage} from './checkin-template.js';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Report={event_id:string;template_id:string;status:string;recorded_at:Date};
export class SubscriptionsService {
 constructor(private readonly config:AppConfig,private readonly infrastructure:Infrastructure){}
 private async storage<T>(fn:()=>Promise<T>):Promise<T>{try{return await fn();}catch(error){if(error instanceof HttpException)throw error;throw new ServiceUnavailableException('SUBSCRIPTION_STORAGE_UNAVAILABLE');}}
 private async session(request:Request){
  return this.storage(async()=>{
   const match=/^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.get('authorization')??'');
   if(!match||Buffer.from(match[1]!,'base64url').toString('base64url')!==match[1])throw new UnauthorizedException('SESSION_INVALID');
   const redis=this.infrastructure.redis.withCommandOptions({abortSignal:AbortSignal.timeout(3000)});
   const raw=await redis.get('minigame:session:'+createHash('sha256').update(match[1]!).digest('hex'));
   let value:{appId?:unknown;userId?:unknown}|null;
   try{value=JSON.parse(raw??'null');}catch{throw new UnauthorizedException('SESSION_INVALID');}
   if(!value||typeof value!=='object'||value.appId!==this.config.appId||typeof value.userId!=='string'||!UUID.test(value.userId))throw new UnauthorizedException('SESSION_INVALID');
   const userId=value.userId;
   if(!(await this.infrastructure.pool.query('SELECT id FROM game_users WHERE app_id=$1 AND id=$2 AND first_login_completed',[this.config.appId,userId])).rowCount)throw new UnauthorizedException('SESSION_INVALID');
   const rate=await redis.eval("local n=redis.call('INCR',KEYS[1]);if n==1 then redis.call('EXPIRE',KEYS[1],60) end;return {n,redis.call('TTL',KEYS[1])}",{keys:[`minigame:subscribe-rate:${this.config.appId}:${userId}`],arguments:[]}) as [number,number];
   if(rate[0]>60){request.res?.setHeader('Retry-After',String(Math.max(1,rate[1])));throw new HttpException('SUBSCRIPTION_RATE_LIMITED',429);}
   return userId;
  });
 }
 private body(request:Request,report:boolean){
  const v:unknown=request.body;
  if(Object.keys(request.query).length||!v||typeof v!=='object'||Array.isArray(v))throw new BadRequestException('INVALID_SUBSCRIPTION_REQUEST');
  const b=v as Record<string,unknown>;
  if(Object.keys(b).sort().join(',')!==(report?'eventId,status,templateId':''))throw new BadRequestException('INVALID_SUBSCRIPTION_REQUEST');
  if(report&&(typeof b.eventId!=='string'||!UUID.test(b.eventId)||b.templateId!==CHECKIN_TEMPLATE_ID||!['accept','reject','ban','filter'].includes(b.status as string)))throw new BadRequestException('INVALID_SUBSCRIPTION_REQUEST');
  return b as {eventId:string;templateId:string;status:string};
 }
 async template(request:Request){
  await this.session(request);this.body(request,false);
  const payload=buildCheckinMessage('preview_only','index',this.config.subscribeMiniprogramState??'trial');
  return {templateId:CHECKIN_TEMPLATE_ID,templateNumber:CHECKIN_TEMPLATE_NUMBER,type:'once',miniprogramState:payload.miniprogram_state,data:payload.data};
 }
 async report(request:Request){
  const uid=await this.session(request),body=this.body(request,true);
  return this.storage(async()=>{
   const c=await this.infrastructure.pool.connect();let discard=false;
   try{
    await c.query('BEGIN');
    const inserted=await c.query<Report>('INSERT INTO game_subscription_reports(app_id,user_id,event_id,template_id,status) VALUES($1,$2,$3,$4,$5) ON CONFLICT(app_id,user_id,event_id) DO NOTHING RETURNING event_id,template_id,status,recorded_at',[this.config.appId,uid,body.eventId,body.templateId,body.status]);
    const row=inserted.rows[0]??(await c.query<Report>('SELECT event_id,template_id,status,recorded_at FROM game_subscription_reports WHERE app_id=$1 AND user_id=$2 AND event_id=$3',[this.config.appId,uid,body.eventId])).rows[0];
    if(!row)throw new Error('Missing subscription receipt');
    if(row.template_id!==body.templateId||row.status!==body.status)throw new ConflictException('SUBSCRIPTION_REPORT_CONFLICT');
    await c.query('COMMIT');return {eventId:row.event_id,templateId:row.template_id,status:row.status,recordedAt:row.recorded_at.toISOString(),alreadyRecorded:!inserted.rowCount};
   }catch(error){try{await c.query('ROLLBACK');}catch{discard=true;}throw error;}finally{c.release(discard);}
  });
 }
}
