import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {Pool} from 'pg';
import {migrate} from '../src/database/migrate.js';

const url='postgresql://minigame_test:local_integration_only@127.0.0.1:15439/minigame_test';
test('invited registrations are a live subset of each Beijing registration-day cohort',async t=>{
 const pool=new Pool({connectionString:url});t.after(()=>pool.end());await migrate(pool);await pool.query('TRUNCATE game_users CASCADE');
 const {overview}=await import(pathToFileURL(resolve('dashboard/queries.mjs')).href);
 const app='wx3333333333333333',foreign='wx4444444444444444';
 const days=(await pool.query("SELECT (clock_timestamp() AT TIME ZONE 'Asia/Shanghai')::date::text today,((clock_timestamp() AT TIME ZONE 'Asia/Shanghai')::date-1)::text yesterday")).rows[0];
 const make=async(name:string,offset:string,completed=true,appId=app)=>(await pool.query(`WITH day AS (SELECT (clock_timestamp() AT TIME ZONE 'Asia/Shanghai')::date::timestamp AT TIME ZONE 'Asia/Shanghai' start)
 INSERT INTO game_users(app_id,open_id,created_at,last_login_at,first_login_completed) SELECT $1,$2,start+$3::interval,start+$3::interval,$4 FROM day RETURNING id`,[appId,name,offset,completed])).rows[0].id;
 const inviter=await make('inviter','-3 days'),unclaimed=await make('unclaimed','0 seconds'),claimed=await make('claimed','1 second');
 const direct=await make('direct','2 seconds'),unfinished=await make('unfinished','3 seconds',false),yesterday=await make('late-report','-1 millisecond'),future=await make('tomorrow','1 day');
 const otherInviter=await make('foreign-inviter','-3 days',true,foreign),otherInvitee=await make('foreign-invitee','0 seconds',true,foreign);
 const before=await overview(pool,app);assert.equal(before.metrics.newUsers,3);assert.equal(before.metrics.invitedNewUsers,0,'no invitation bindings means zero, not missing field');
 const bind=async(invitee:string,appId=app,source=inviter,reward=false)=>pool.query('INSERT INTO game_invitations(app_id,inviter_user_id,invitee_user_id,claim_id,reward_claimed_at) VALUES($1,$2,$3,$4,$5)',[appId,source,invitee,reward?randomUUID():null,reward?new Date():null]);
 await bind(unclaimed);await bind(claimed,app,inviter,true);await bind(unfinished);await bind(yesterday);await bind(future);await bind(otherInvitee,foreign,otherInviter);
 const result=await overview(pool,app);assert.equal(result.metrics.newUsers,3);assert.equal(result.metrics.invitedNewUsers,2,'claimed and unclaimed both count; incomplete/future/foreign registrations do not');
 assert.equal(result.history.find((d:any)=>d.date===days.today).invitedNewUsers,2);
 assert.equal(result.history.find((d:any)=>d.date===days.yesterday).invitedNewUsers,1,'late invitation report belongs to registration day, including 1ms before Beijing midnight');
 assert(result.history.every((d:any)=>Number.isInteger(d.invitedNewUsers)&&d.invitedNewUsers>=0&&d.invitedNewUsers<=d.newUsers));
 const foreignResult=await overview(pool,foreign);assert.equal(foreignResult.metrics.invitedNewUsers,1);assert.equal(foreignResult.metrics.newUsers,1);
 const empty=await overview(pool,'wx5555555555555555');assert.equal(empty.metrics.invitedNewUsers,0);assert(empty.history.every((d:any)=>d.invitedNewUsers===0));
 await bind(direct);const refreshed=await overview(pool,app);assert.equal(refreshed.metrics.newUsers,3);assert.equal(refreshed.metrics.invitedNewUsers,3,'late binding becomes visible on next refresh without a new registration');
 assert.equal((await pool.query('SELECT count(*)::int n FROM game_invitations WHERE app_id=$1 AND invitee_user_id=$2',[app,direct])).rows[0].n,1);
});
