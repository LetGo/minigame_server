import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomBytes} from 'node:crypto';
import {Pool} from 'pg';

// Disposable compose.test.yaml instance only. Never reads production environment files.
const TEST_URL='postgresql://minigame_test:local_integration_only@127.0.0.1:15439/minigame_test';
const APP='wx1111111111111111',OTHER='wx2222222222222222';
const NOW='2026-11-02T00:10:00.123456+08:00';
test('real isolated PG retention snapshot: Beijing-day cohorts, every period, coverage, dedupe and weighted samples',async t=>{
 const url=new URL(TEST_URL);assert.equal(url.hostname,'127.0.0.1');assert.equal(url.port,'15439');assert.equal(url.pathname,'/minigame_test');
 const {collectRetentionReport}=await import('../dashboard/retention-report.mjs');
 const admin=new Pool({connectionString:TEST_URL,max:1,connectionTimeoutMillis:3000,statement_timeout:10000});
 const schema='retention_'+randomBytes(6).toString('hex');let pool,rolePool;const role='retention_reader_'+randomBytes(5).toString('hex');let roleCreated=false;
 try{
  assert.equal((await admin.query('SELECT current_database() AS name')).rows[0].name,'minigame_test');
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.query(`CREATE TABLE ${schema}.game_users (LIKE public.game_users INCLUDING ALL)`);
  await admin.query(`CREATE TABLE ${schema}.game_daily_logins (LIKE public.game_daily_logins INCLUDING ALL)`);
  await admin.query(`CREATE TABLE ${schema}.game_analytics_metadata (LIKE public.game_analytics_metadata INCLUDING ALL)`);
  await admin.query(`INSERT INTO ${schema}.game_analytics_metadata VALUES(true,'2026-10-17T23:58:42+08:00','2026-10-17')`);
  pool=new Pool({connectionString:TEST_URL,max:1,options:`-c search_path=${schema} -c jit=off`,statement_timeout:10000});
  const user=async(open,date,complete=true,app=APP)=>(await pool.query('INSERT INTO game_users(app_id,open_id,created_at,last_login_at,first_login_completed) VALUES($1,$2,$3,$3,$4) RETURNING id',[app,open,date,complete])).rows[0].id;
  const login=async(id,date,app=APP,at=date+'T12:00:00+08:00')=>pool.query('INSERT INTO game_daily_logins(app_id,user_id,activity_date,first_login_at) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[app,id,date,at]);
  const a=await user('a','2026-10-01T00:00:00+08:00'), b=await user('b','2026-10-01T23:59:59.999999+08:00');
  const c=await user('c','2026-10-02T00:00:00+08:00');
  const newest=await user('newest','2026-11-01T23:59:59.999999+08:00');
  await user('today','2026-11-02T00:00:00+08:00');
  const incomplete=await user('incomplete','2026-10-31T10:00:00+08:00',false);
  const foreign=await user('foreign','2026-10-31T10:00:00+08:00',true,OTHER);
  const recent=await user('recent','2026-10-31T00:00:00+08:00');
  const silent=await user('silent','2026-10-31T01:00:00+08:00');
  for(const id of [a,b,c])await login(id,'2026-10-31');
  await login(a,'2026-10-31');
  await login(recent,'2026-11-01');await login(incomplete,'2026-11-01');await login(foreign,'2026-11-01',OTHER);
  await login(newest,'2026-11-02',APP,'2026-11-02T00:05:00+08:00'); // today's partial D1 must remain pending
  await pool.query('UPDATE game_users SET last_login_at=$1 WHERE id=$2',[NOW,silent]);
  await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD 'local-retention-reader-only'`);roleCreated=true;
  await admin.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);
  await admin.query(`GRANT SELECT ON ALL TABLES IN SCHEMA ${schema} TO ${role}`);
  const readerUrl=new URL(TEST_URL);readerUrl.username=role;readerUrl.password='local-retention-reader-only';
  rolePool=new Pool({connectionString:readerUrl.href,max:1,options:`-c search_path=${schema} -c default_transaction_read_only=on -c jit=off`,statement_timeout:10000});
  let clocks=0;const sql=[];
  const frozen={async connect(){const conn=await rolePool.connect();return {async query(text,values){sql.push(text);const hits=text.match(/(?:clock|transaction)_timestamp\(\)/g)??[];clocks+=hits.length;return conn.query(text.replace(/(?:clock|transaction)_timestamp\(\)/g,`'${NOW}'::timestamptz`),values);},release(error){conn.release(error);}};}};
  const r=await collectRetentionReport(frozen,APP,{historyDays:40});
  assert.equal(clocks,1,'one authoritative DB timestamp');assert.equal(r.asOfDate,'2026-11-01');assert.equal(r.timezone,'Asia/Shanghai');assert.equal(r.appId,APP);assert.equal(r.historyDays,40);assert.equal(r.cohorts.length,40);assert.deepEqual(r.periods,[1,3,5,7,14,20,30]);
  assert(sql.some(x=>/BEGIN[\s\S]*REPEATABLE READ[\s\S]*READ ONLY/i.test(x)));assert(sql.some(x=>/COMMIT|ROLLBACK/i.test(x)));
  assert(sql.every(x=>!/^\s*(INSERT|UPDATE|DELETE|TRUNCATE|ALTER)\b/i.test(x)));
  const cell=(date,day)=>r.cohorts.find(x=>x.date===date).cells.find(x=>x.day===day);
  await t.test('D30/D20 count exact return day, older registration retained if observation covered',()=>{
   assert.deepEqual(cell('2026-10-01',30),{day:30,observationDate:'2026-10-31',status:'complete',returned:2,cohortSize:2,rate:1});
   assert.equal(cell('2026-10-01',20).status,'complete');assert.equal(cell('2026-10-01',20).returned,0,'D30 return is not cumulative D20');
   assert.equal(cell('2026-10-02',30).returned,0,'October31 is D29, not D30, for October2 cohort');
  });
  await t.test('coverage unknown is null and all seven exact observation-day offsets are correct',()=>{
   assert.equal(cell('2026-10-01',14).status,'uncovered');assert.equal(cell('2026-10-01',14).returned,null);assert.equal(cell('2026-10-01',14).rate,null);
   for(const day of r.periods){const x=cell('2026-10-01',day);assert.equal(x.observationDate,new Date(Date.UTC(2026,9,1+day)).toISOString().slice(0,10));}
  });
  await t.test('partial today is pending; empty cohort differs from genuine zero retention',()=>{
   assert.equal(cell('2026-11-01',1).status,'pending');assert.equal(cell('2026-11-01',1).returned,null);
   assert.equal(cell('2026-10-30',1).status,'empty');assert.equal(cell('2026-10-30',1).rate,null);
   const x=cell('2026-10-31',1);assert.equal(x.cohortSize,2);assert.equal(x.returned,1);assert.equal(x.rate,.5);
   assert(!r.cohorts.some(x=>x.date==='2026-11-02'));
  });
  await t.test('each weighted summary reconciles independently with its eligible cohort cells',()=>{
   for(const s of r.summary){const cells=r.cohorts.flatMap(x=>x.cells).filter(x=>x.day===s.day&&x.status==='complete');const den=cells.reduce((n,x)=>n+x.cohortSize,0),num=cells.reduce((n,x)=>n+x.returned,0);assert.equal(s.cohortSize,den);assert.equal(s.returned,num);assert.equal(s.cohortDays,cells.length);assert.equal(s.rate,den?num/den:null);}
  });
  await t.test('readonly snapshot ignores mutable last-login and keeps microsecond registration edges',()=>{
   assert.equal(r.cohorts.find(x=>x.date==='2026-10-01').newUsers,2);assert.equal(r.cohorts.find(x=>x.date==='2026-10-02').newUsers,1);assert.equal(r.cohorts.find(x=>x.date==='2026-11-01').newUsers,1);assert.equal(cell('2026-10-31',1).returned,1);
  });
 }finally{
  await rolePool?.end();await pool?.end();
  await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  if(roleCreated)await admin.query(`DROP ROLE ${role}`);
  assert.equal((await admin.query('SELECT count(*)::int AS n FROM pg_namespace WHERE nspname=$1',[schema])).rows[0].n,0);await admin.end();
 }
});
