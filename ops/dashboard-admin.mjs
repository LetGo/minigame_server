// Explicit production-only dashboard provisioning. Never print credentials.
import assert from 'node:assert/strict';import {randomBytes,scryptSync} from 'node:crypto';
import {existsSync,writeFileSync} from 'node:fs';import {resolve} from 'node:path';import {pathToFileURL} from 'node:url';import {Pool} from 'pg';
import {readEnv} from './staging-admin.mjs';
export function assertProduction(env){const d=new URL(env.DATABASE_URL),r=new URL(env.REDIS_URL);assert.equal(d.hostname,'127.0.0.1');assert.equal(d.port,'15440');assert.equal(d.pathname,'/minigame');assert.equal(d.username,'minigame_app');assert.equal(r.hostname,'127.0.0.1');assert.equal(r.port,'16390');assert.equal(env.PORT,'18740');assert.equal(env.HOST,'127.0.0.1');assert.match(env.WECHAT_APP_ID,/^wx[a-f0-9]{16}$/);}
async function main(){assert.equal(process.argv[2],'prepare','only prepare is supported');assert(!existsSync('.env.dashboard')&&!existsSync('.env.dashboard.access'),'refuse credential replacement');const env=readEnv('.env');assertProduction(env);const infra=readEnv('.env.production.infrastructure');
 const pool=new Pool({host:'127.0.0.1',port:15440,database:'minigame',user:'minigame_owner',password:infra.POSTGRES_PASSWORD,max:1,connectionTimeoutMillis:3000,statement_timeout:15000});
 const password=randomBytes(18).toString('base64url'),salt=randomBytes(16).toString('hex'),hash=scryptSync(password,salt,64).toString('hex'),dbPassword=randomBytes(32).toString('hex');
 const db=new URL(env.DATABASE_URL);db.username='minigame_dashboard_app';db.password=dbPassword;const redis=new URL(env.REDIS_URL);redis.pathname='/1';
 const config={NODE_ENV:'production',HOST:'127.0.0.1',PORT:'18742',DASHBOARD_USER:'admin',DASHBOARD_PASSWORD_HASH:salt+':'+hash,DASHBOARD_APP_ID:env.WECHAT_APP_ID,DASHBOARD_ORIGIN:'https://sub2api.wdaveh5game.com',DASHBOARD_BASE_PATH:'/h5dashboard/',DASHBOARD_ENVIRONMENT:'production',DATABASE_URL:db.href,REDIS_URL:redis.href};
 try{const {migrate}=await import(pathToFileURL(resolve('tmp/dashboard-rollout/candidate-dist/database/migrate.js')).href);await migrate(pool,resolve('migrations'));
 await pool.query('GRANT SELECT,INSERT ON game_daily_logins TO minigame_app');
 assert.equal((await pool.query("SELECT 1 FROM pg_roles WHERE rolname='minigame_dashboard_app'")).rowCount,0,'refuse changing an existing role');
 await pool.query('BEGIN');
 try{await pool.query(`CREATE ROLE minigame_dashboard_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '${dbPassword}'`);
 await pool.query('GRANT CONNECT ON DATABASE minigame TO minigame_dashboard_app');await pool.query('GRANT USAGE ON SCHEMA public TO minigame_dashboard_app');
 await pool.query('GRANT SELECT ON game_users,game_saves,game_profiles,game_invitations,game_daily_logins,game_analytics_metadata TO minigame_dashboard_app');
 await pool.query('ALTER ROLE minigame_dashboard_app SET default_transaction_read_only = on');await pool.query("ALTER ROLE minigame_dashboard_app SET statement_timeout = '5000ms'");await pool.query("ALTER ROLE minigame_dashboard_app SET idle_in_transaction_session_timeout = '5000ms'");await pool.query('COMMIT');}catch(e){await pool.query('ROLLBACK');throw e;}
 writeFileSync('.env.dashboard',Object.entries(config).map(([k,v])=>k+'='+JSON.stringify(v)).join('\n')+'\n',{mode:0o600,flag:'wx'});
 writeFileSync('.env.dashboard.access',`DASHBOARD_USER=admin\nDASHBOARD_PASSWORD=${password}\n`,{mode:0o600,flag:'wx'});
 }finally{await pool.end();}
 const runtime=new Pool({connectionString:db.href,connectionTimeoutMillis:3000});try{for(const table of ['game_users','game_saves','game_profiles','game_invitations','game_daily_logins','game_analytics_metadata']){const rights=(await runtime.query("SELECT has_table_privilege(current_user,$1,'SELECT') AS can_read,has_table_privilege(current_user,$1,'INSERT,UPDATE,DELETE') AS can_write,has_schema_privilege(current_user,'public','CREATE') AS can_ddl",[table])).rows[0];assert(rights.can_read);assert(!rights.can_write&&!rights.can_ddl);}assert.equal((await runtime.query('SHOW default_transaction_read_only')).rows[0].default_transaction_read_only,'on');console.log(JSON.stringify({dashboardProvisioned:true,readonlyVerified:true,credentialsStored0600:true,migration005Applied:true}));}finally{await runtime.end();}
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url)main().catch(()=>{console.error('Dashboard provisioning failed; sensitive details suppressed');process.exitCode=1;});
