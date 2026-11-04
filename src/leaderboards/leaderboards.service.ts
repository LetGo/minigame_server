import {createHash,randomUUID} from 'node:crypto';
import {BadRequestException,HttpException,Logger,ServiceUnavailableException,UnauthorizedException} from '@nestjs/common';
import type {Request} from 'express';
import type {PoolClient,QueryResult} from 'pg';
import type {AppConfig} from '../config.js';
import {Infrastructure} from '../infrastructure.js';

type Board='stage'|'boss';
type Score={user_id:string;value:number};
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const READY='__ready__';
const MINIMUM:Readonly<Record<Board,number>>={stage:101,boss:30};
const PROJECT=`
if redis.call('GET',KEYS[2]) ~= ARGV[3] or redis.call('ZSCORE',KEYS[1],'__ready__') ~= '-1' then return {} end
if tonumber(ARGV[2]) >= tonumber(ARGV[4]) then redis.call('ZADD',KEYS[1],'GT',ARGV[2],ARGV[1]) end
local score=redis.call('ZSCORE',KEYS[1],ARGV[1])
local rank=redis.call('ZREVRANK',KEYS[1],ARGV[1])
return {score or ARGV[2],rank and rank+1 or -1}
`;

const READ=`
if redis.call('GET',KEYS[2]) ~= ARGV[2] or redis.call('ZSCORE',KEYS[1],'__ready__') ~= '-1' then return {} end
local top=redis.call('ZRANGE',KEYS[1],0,29,'REV','WITHSCORES')
local rank=redis.call('ZREVRANK',KEYS[1],ARGV[1])
local score=redis.call('ZSCORE',KEYS[1],ARGV[1])
return {top,rank and rank+1 or -1,score or '-1'}
`;

export class LeaderboardsService {
 private readonly rebuilding=new Map<Board,Promise<void>>();
 private timer:ReturnType<typeof setInterval>|undefined;
 private working:Promise<void>|undefined;
 private stopped=false;
 private warned=false;
 private readonly logger=new Logger('Leaderboards');
 private redisGeneration=0;
 private epochPromise:Promise<string>|undefined;
 private readonly onRedisReady=()=>{this.redisGeneration++;this.epochPromise=undefined;};
 constructor(private readonly config:AppConfig,private readonly infrastructure:Infrastructure){this.infrastructure.redis.on('ready',this.onRedisReady);}
 private epoch():Promise<string>{
  if(this.epochPromise)return this.epochPromise;
  const generation=this.redisGeneration;
  const loaded=this.redis().info('server').then(info=>{
   const runId=/^run_id:([^\r\n]+)/m.exec(info)?.[1];
   if(!runId||generation!==this.redisGeneration)throw new ServiceUnavailableException('LEADERBOARD_REBUILDING');
   return runId;
  });
  this.epochPromise=loaded;
  void loaded.catch(()=>{if(this.epochPromise===loaded)this.epochPromise=undefined;});
  return loaded;
 }
 // Bind readiness to both Redis process and the per-board qualification policy.
 private async indexEpoch(type:Board){return `${await this.epoch()}:min=${MINIMUM[type]}`;}
 private epochKey(type:Board){return this.key(type)+':epoch';}
 private async ready(type:Board,epoch:string){
  return await this.redis().eval("if redis.call('GET',KEYS[2])==ARGV[1] and redis.call('ZSCORE',KEYS[1],'__ready__')=='-1' then return 1 end;return 0",{keys:[this.key(type),this.epochKey(type)],arguments:[epoch]})===1;
 }
 private activate(){
  if(this.timer||this.stopped)return;
  // Lazy activation keeps existing endpoints usable before this feature's grants.
  this.timer=setInterval(()=>{
   if(this.working||this.stopped)return;
   this.working=this.drain().then(()=>{this.warned=false;}).catch(()=>{
    if(!this.warned)this.logger.warn('Leaderboard synchronization unavailable; durable scores retained for retry');
    this.warned=true;
   }).finally(()=>{this.working=undefined;});
  },1000);this.timer.unref();
 }
 async onModuleDestroy(){
  this.stopped=true;if(this.timer)clearInterval(this.timer);
  await this.working;await Promise.allSettled(this.rebuilding.values());this.infrastructure.redis.off('ready',this.onRedisReady);
 }
 private async drain(){
  for(const type of ['stage','boss'] as const){
   if(this.stopped)return;
   const pending=await this.infrastructure.pool.query<Score>('SELECT user_id,value FROM game_leaderboard_scores WHERE app_id=$1 AND board_type=$2 AND dirty ORDER BY user_id LIMIT 100',[this.config.appId,type]);
   if(!pending.rows.length)continue;
   await this.ensureReady(type);
   for(const row of pending.rows){if(this.stopped)return;await this.project(type,row.user_id,row.value);}
  }
 }
 private key(type:Board){return `minigame:leaderboard:${this.config.appId}:${type}`;}
 private lock(type:Board){return `minigame:leaderboard-lock:${this.config.appId}:${type}`;}
 private redis(){return this.infrastructure.redis.withCommandOptions({abortSignal:AbortSignal.timeout(3000)});}
 private async storage<T>(fn:()=>Promise<T>):Promise<T>{
  try{return await fn();}catch(error){if(error instanceof HttpException)throw error;throw new ServiceUnavailableException('LEADERBOARD_STORAGE_UNAVAILABLE');}
 }
 private async transaction<T>(fn:(client:PoolClient)=>Promise<T>):Promise<T>{
  const client=await this.infrastructure.pool.connect();let discard=false;
  try{await client.query('BEGIN');const result=await fn(client);await client.query('COMMIT');return result;}
  catch(error){try{await client.query('ROLLBACK');}catch{discard=true;}throw error;}
  finally{client.release(discard);}
 }
 private async session(request:Request,operation:'report'|'list'){
  const match=/^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.get('authorization')??'');
  if(!match||Buffer.from(match[1]!,'base64url').toString('base64url')!==match[1])throw new UnauthorizedException('SESSION_INVALID');
  const raw=await this.redis().get('minigame:session:'+createHash('sha256').update(match[1]!).digest('hex'));
  let session:{userId?:unknown;appId?:unknown}|null;
  try{session=JSON.parse(raw??'null');}catch{throw new UnauthorizedException('SESSION_INVALID');}
  if(!session||typeof session!=='object'||session.appId!==this.config.appId||typeof session.userId!=='string'||!UUID.test(session.userId))throw new UnauthorizedException('SESSION_INVALID');
  const row=(await this.infrastructure.pool.query<{id:string}>('SELECT id FROM game_users WHERE app_id=$1 AND id=$2 AND first_login_completed',[this.config.appId,session.userId])).rows[0];
  if(!row)throw new UnauthorizedException('SESSION_INVALID');
  const rate=await this.redis().eval("local n=redis.call('INCR',KEYS[1]);if n==1 then redis.call('EXPIRE',KEYS[1],60) end;return {n,redis.call('TTL',KEYS[1])}",{keys:[`minigame:leaderboard-rate:${this.config.appId}:${operation}:${row.id}`],arguments:[]}) as [number,number];
  if(rate[0]>60){request.res?.setHeader('Retry-After',String(Math.max(1,rate[1])));throw new HttpException('LEADERBOARD_RATE_LIMITED',429);}
  return row.id;
 }
 private body(request:Request,report:boolean){
  const input:unknown=request.body;
  if(Object.keys(request.query).length||!input||typeof input!=='object'||Array.isArray(input))throw new BadRequestException('INVALID_LEADERBOARD_REQUEST');
  const value=input as Record<string,unknown>;
  if(Object.keys(value).sort().join(',')!==(report?'type,value':'type')||!['stage','boss'].includes(value.type as string)||(report&&(!Number.isInteger(value.value)||Number(value.value)<0||Number(value.value)>2147483647)))throw new BadRequestException('INVALID_LEADERBOARD_REQUEST');
  this.activate();return {type:value.type as Board,value:value.value as number};
 }
 private async ensureReady(type:Board):Promise<void>{
  if(await this.ready(type,await this.indexEpoch(type)))return;
  const existing=this.rebuilding.get(type);if(existing)return existing;
  const rebuilding=this.rebuild(type).finally(()=>this.rebuilding.delete(type));
  this.rebuilding.set(type,rebuilding);return rebuilding;
 }
 private async rebuild(type:Board){
  const generation=randomUUID(),temporary=this.key(type)+':building:'+generation,owner=this.key(type)+':rebuild-owner',deadline=Date.now()+60000,epoch=await this.indexEpoch(type);
  try{
   await this.transaction(async client=>{
    const locked=(await client.query<{locked:boolean}>('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS locked',[this.lock(type)])).rows[0]!.locked;
    if(!locked)throw new ServiceUnavailableException('LEADERBOARD_REBUILDING');
    if(await this.ready(type,epoch))return;
    // A newer PG lock owner replaces this token if our DB connection is lost.
    await this.redis().set(owner,generation,{EX:120});
    await this.redis().zAdd(temporary,{score:-1,value:READY});await this.redis().expire(temporary,120);
    let after:string|null=null,count=0;
    for(;;){
     if(Date.now()>deadline)throw new ServiceUnavailableException('LEADERBOARD_REBUILDING');
     const page:QueryResult<Score>=await client.query<Score>('SELECT user_id,value FROM game_leaderboard_scores WHERE app_id=$1 AND board_type=$2 AND ($3::uuid IS NULL OR user_id>$3) AND value>=$4 ORDER BY user_id LIMIT 1000',[this.config.appId,type,after,MINIMUM[type]]);
     if(!page.rows.length)break;
     await this.redis().zAdd(temporary,page.rows.map(r=>({score:r.value,value:r.user_id})));
     count+=page.rows.length;after=page.rows[page.rows.length-1]!.user_id;
    }
    // The exclusive PG board lock blocks score commits until this atomic swap.
    if(await this.indexEpoch(type)!==epoch)throw new ServiceUnavailableException('LEADERBOARD_REBUILDING');
    const published=await this.redis().eval("if redis.call('GET',KEYS[3])~=ARGV[1] or redis.call('ZCARD',KEYS[1])~=tonumber(ARGV[2]) or redis.call('ZSCORE',KEYS[1],'__ready__')~='-1' then return 0 end;redis.call('RENAME',KEYS[1],KEYS[2]);redis.call('PERSIST',KEYS[2]);redis.call('SET',KEYS[4],ARGV[3]);redis.call('DEL',KEYS[3]);return 1",{keys:[temporary,this.key(type),owner,this.epochKey(type)],arguments:[generation,String(count+1),epoch]});
    if(published!==1)throw new ServiceUnavailableException('LEADERBOARD_REBUILDING');
   });
  }finally{await this.redis().eval("redis.call('UNLINK',KEYS[1]);if redis.call('GET',KEYS[2])==ARGV[1] then redis.call('DEL',KEYS[2]) end;return 1",{keys:[temporary,owner],arguments:[generation]}).catch(()=>{});}
 }
 private async project(type:Board,userId:string,value:number){
  const result=await this.redis().eval(PROJECT,{keys:[this.key(type),this.epochKey(type)],arguments:[userId,String(value),await this.indexEpoch(type),String(MINIMUM[type])]}) as Array<string|number>;
  if(result.length!==2)throw new ServiceUnavailableException('LEADERBOARD_REBUILDING');
  await this.infrastructure.pool.query('UPDATE game_leaderboard_scores SET dirty=false WHERE app_id=$1 AND board_type=$2 AND user_id=$3 AND value=$4 AND dirty',[this.config.appId,type,userId,value]);
  return {value:Number(result[0]),rank:Number(result[1])<0?null:Number(result[1])};
 }
 async list(request:Request){return this.storage(async()=>{
  const userId=await this.session(request,'list'),{type}=this.body(request,false);
  let snapshot=await this.redis().eval(READ,{keys:[this.key(type),this.epochKey(type)],arguments:[userId,await this.indexEpoch(type)]}) as unknown as [string[],number,string]|[];
  if(snapshot.length===0){await this.ensureReady(type);snapshot=await this.redis().eval(READ,{keys:[this.key(type),this.epochKey(type)],arguments:[userId,await this.indexEpoch(type)]}) as unknown as [string[],number,string]|[];}
  if(snapshot.length===0)throw new ServiceUnavailableException('LEADERBOARD_REBUILDING');
  const [top,rank,score]=snapshot,entries:Array<{userId:string;rank:number;value:number}>=[];
  for(let i=0;i<top.length;i+=2){if(top[i]!==READY)entries.push({userId:top[i]!,rank:entries.length+1,value:Number(top[i+1])});}
  const ids=[...new Set([userId,...entries.map(r=>r.userId)])];
  const profiles=await this.infrastructure.pool.query<{id:string;nickname:string|null;avatar_url:string|null;stored_value:number|null}>('SELECT u.id,p.nickname,p.avatar_url,s.value AS stored_value FROM game_users u LEFT JOIN game_profiles p ON p.user_id=u.id LEFT JOIN game_leaderboard_scores s ON s.app_id=u.app_id AND s.user_id=u.id AND s.board_type=$3 AND u.id=$4 WHERE u.app_id=$1 AND u.id=ANY($2::uuid[])',[this.config.appId,ids,type,userId]);
  const byId=new Map(profiles.rows.map(p=>[p.id,{nickname:p.nickname??'游客',avatarUrl:p.avatar_url??''}]));
  const profile=(id:string)=>byId.get(id)??{nickname:'游客',avatarUrl:''};
  return {type,entries:entries.map(r=>({...r,...profile(r.userId)})),self:{userId,rank:rank<0?null:rank,value:Number(score)<0?(profiles.rows.find(p=>p.id===userId)?.stored_value??null):Number(score),...profile(userId)}};
 });}
 async report(request:Request){return this.storage(async()=>{
  const userId=await this.session(request,'report'),{type,value}=this.body(request,true);
  await this.ensureReady(type);
  const persisted=await this.transaction(async client=>{
   await client.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))',[this.lock(type)]);
   const updated=await client.query<Score>('INSERT INTO game_leaderboard_scores(app_id,board_type,user_id,value) VALUES($1,$2,$3,$4) ON CONFLICT(app_id,board_type,user_id) DO UPDATE SET value=EXCLUDED.value,dirty=true,updated_at=clock_timestamp() WHERE game_leaderboard_scores.value<EXCLUDED.value RETURNING user_id,value',[this.config.appId,type,userId,value]);
   const row=updated.rows[0]??(await client.query<Score>('SELECT user_id,value FROM game_leaderboard_scores WHERE app_id=$1 AND board_type=$2 AND user_id=$3',[this.config.appId,type,userId])).rows[0];
   if(!row)throw new Error('Missing score receipt');return {value:row.value,improved:!!updated.rowCount};
  });
  const projected=await this.project(type,userId,persisted.value);
  return {type,...projected,improved:persisted.improved};
 });}
}
