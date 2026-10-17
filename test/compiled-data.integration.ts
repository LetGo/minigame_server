import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { loadConfig } from '../src/config.js';
import { migrate } from '../src/database/migrate.js';

test('compiled API and distributed SDK round trip over real HTTP with least-privilege PostgreSQL role', async () => {
  const ownerUrl='postgresql://minigame_test:local_integration_only@127.0.0.1:15439/minigame_test';
  const owner=new Pool({connectionString:ownerUrl});
  const role='compiled_test_'+randomBytes(6).toString('hex');
  let app: any;
  try {
    await migrate(owner);
    await owner.query(`CREATE ROLE ${role} LOGIN PASSWORD 'isolated-compiled-test-only'`);
    await owner.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
    await owner.query(`GRANT SELECT, INSERT, UPDATE ON game_users, game_saves TO ${role}`);
    await owner.query(`GRANT SELECT, INSERT ON game_daily_logins TO ${role}`);
    const buildDir=resolve(process.env.MINIGAME_TEST_DIST_DIR ?? 'dist');
    const appModulePath=pathToFileURL(resolve(buildDir,'application.js')).href;
    const wechatModulePath=pathToFileURL(resolve(buildDir,'auth/wechat.client.js')).href;
    const {createApplication}=await import(appModulePath);
    const {WechatClient}=await import(wechatModulePath);
    const config=loadConfig({WECHAT_APP_ID:'wx1111111111111111',WECHAT_APP_SECRET:'compiled-test-only',
      DATABASE_URL:`postgresql://${role}:isolated-compiled-test-only@127.0.0.1:15439/minigame_test`,REDIS_URL:'redis://127.0.0.1:16389/15'});
    const wechat=new WechatClient(config,async()=>Response.json({openid:role,session_key:'explicit-wechat-test-stub'}));
    app=await createApplication(config,{wechat}); await app.listen(0,'127.0.0.1');
    const address=app.getHttpServer().address(); const local=`http://127.0.0.1:${address.port}`;
    const login=await fetch(local+'/h5login/api/auth/wechat-login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code:role})});
    assert.equal(login.status,200);
    const auth=await login.json() as any;
    assert.equal(auth.user.openid,role);
    assert.match(auth.user.id,/^[0-9a-f-]{36}$/);
    assert.doesNotMatch(JSON.stringify(auth),/session_key|explicit-wechat-test-stub|compiled-test-only/);
    const mod={exports:{} as any};
    runInNewContext(await readFile('client/minigame-data-client.js','utf8'),{module:mod,exports:mod.exports,TextEncoder:undefined,TextDecoder:undefined,Buffer:undefined,crypto:undefined});
    const observed: any[]=[];
    const wx={
      // Test-only transport adapter: SDK still generates HTTPS URLs; local test server has no TLS.
      request(options:any){
        const path=new URL(options.url).pathname;
        observed.push({path,body:options.data});
        fetch(local+path,{method:options.method,headers:options.header,body:JSON.stringify(options.data)})
          .then(async r=>options.success({statusCode:r.status,data:await r.json(),header:Object.fromEntries(r.headers)}))
          .catch(()=>options.fail());
      }
    };
    const store=mod.exports.createDataClient({wx,accessToken:auth.accessToken});
    assert.equal((await store.get()).exists,false);
    const data='{ "big":9007199254740993123,"text":"'+'中🚀'.repeat(1400)+'" }\n';
    assert.equal((await store.save(data,0)).version,1);
    const loaded=await store.get(); assert.equal(loaded.version,1); assert.equal(loaded.data,data);
    await assert.rejects(store.save('{}',0),(e:any)=>e.statusCode===409 && e.apiMessage==='SAVE_VERSION_CONFLICT');
    assert.deepEqual(JSON.parse(JSON.stringify(observed.map(r=>r.body))),[{}, {version:0,data}, {}, {version:0,data:'{}'}]);
    for (const r of observed) assert.equal(Object.hasOwn(r.body,'ciphertext'),false);
  } finally {
    if(app)await app.close();
    await owner.query(`DROP OWNED BY ${role}`);
    await owner.query(`DROP ROLE IF EXISTS ${role}`);
    await owner.end();
  }
});
