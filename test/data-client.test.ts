import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { runInNewContext } from 'node:vm';
// @ts-expect-error JavaScript distributable source has no TypeScript declarations.
import { createDataClient } from '../client/data-client.mjs';
const token = Buffer.alloc(32, 7).toString('base64url');

test('client directly exchanges JSON over HTTPS with Bearer and needs no random API', async () => {
  const sent: any[]=[];
  const empty={exists:false,version:0,data:null,updatedAt:null};
  const saved={version:1,updatedAt:'2026-10-16T14:00:00.000Z'};
  const wx={request(options:any) {
    assert.equal(options.method,'POST');
    assert.equal(options.header.Authorization,'Bearer '+token);
    assert.equal(options.header['content-type'],'application/json');
    assert.match(options.url,/^https:/);
    sent.push({url:options.url,data:options.data});
    options.success({statusCode:200,data:options.url.endsWith('/get')?empty:saved});
  }};
  const store=createDataClient({wx,accessToken:token});
  assert.deepEqual(await store.get(),empty);
  assert.deepEqual(await store.save('{ "big":9007199254740993123,"text":"中🚀" }',0),saved);
  assert.deepEqual(sent,[
    {url:'https://sub2api.wdaveh5game.com/h5login/api/data/get',data:{}},
    {url:'https://sub2api.wdaveh5game.com/h5login/api/data/save',data:{version:0,data:'{ "big":9007199254740993123,"text":"中🚀" }'}}
  ]);
});

test('client rejects non-object and legacy-envelope success responses', async () => {
  for (const data of ['<html>proxy error</html>',null,[],{v:1,nonce:'old',ts:1,ciphertext:'old',tag:'old'}]) {
    const store=createDataClient({wx:{request(o:any){o.success({statusCode:200,data});}},accessToken:token});
    await assert.rejects(store.get(),/INVALID_DATA_RESPONSE/);
  }
});

test('client validates raw JSON, UTF8 size, surrogates and version before sending', async () => {
  let calls=0;
  const store=createDataClient({wx:{request(o:any){calls++;o.success({statusCode:200,data:{version:1,updatedAt:'2026-10-16T14:00:00.000Z'}});}},accessToken:token});
  for (const [data,version] of [[{},0],['{}',-1],['{}',1.5],['{}','0'],['{}',2147483647],['not-json',0],
    ['"'+String.fromCharCode(0xd800)+'"',0],['{'+'\t'.repeat(65535)+'}',0],[JSON.stringify('中'.repeat(21845)),0]]) {
    await assert.rejects(store.save(data,version),/INVALID_SAVE_DATA/);
  }
  assert.equal(calls,0);
  await store.save('{'+'\t'.repeat(65534)+'}',0);
  assert.equal(calls,1);
});

test('client requires valid Bearer token and HTTPS and accepts a custom HTTPS host', () => {
  const wx={request(){}};
  for (const baseUrl of ['http://safe.example/h5login','https://safe.example/h5login?token=x','https://u:p@safe.example/h5login','https://safe.example/other']) {
    assert.throws(()=>createDataClient({wx,accessToken:token,baseUrl}),/INVALID_CLIENT_OPTIONS/);
  }
  for (const accessToken of [undefined,'bad','a'.repeat(42)+'B','a'.repeat(44)]) {
    assert.throws(()=>createDataClient({wx,accessToken}),/INVALID_CLIENT_OPTIONS/);
  }
  assert.throws(()=>createDataClient({wx:{},accessToken:token}),/INVALID_CLIENT_OPTIONS/);
  assert.doesNotThrow(()=>createDataClient({wx,accessToken:token,baseUrl:'https://other.example:8443/h5login'}));
});

test('client exposes API errors and Retry-After, handles proxy/network errors, never automatically retries', async () => {
  for (const header of [{'Retry-After':'12'},{'retry-after':'12'}]) {
    let calls=0;
    const store=createDataClient({wx:{request(o:any){calls++;o.success({statusCode:429,data:{message:'DATA_RATE_LIMITED'},header});}},accessToken:token});
    await assert.rejects(store.get(),(e:any)=>e.statusCode===429 && e.apiMessage==='DATA_RATE_LIMITED' && e.retryAfter==='12');
    assert.equal(calls,1);
  }
  let calls=0;
  const failed=createDataClient({wx:{request(o:any){calls++;o.fail({errMsg:'sensitive transport detail'});}},accessToken:token});
  await assert.rejects(failed.save('{}',0),/DATA_NETWORK_ERROR/); assert.equal(calls,1);
  const proxy=createDataClient({wx:{request(o:any){o.success({statusCode:502,data:'<html>upstream error</html>'});}},accessToken:token});
  await assert.rejects(proxy.get(),(e:any)=>e.statusCode===502 && e.message==='DATA_REQUEST_FAILED');
});

test('CommonJS SDK runs without Node, encoding, random or crypto globals', async () => {
  const bundle=await build({entryPoints:['client/data-client.mjs'],bundle:true,platform:'browser',format:'cjs',target:'es2020',write:false});
  const mod={exports:{} as any};
  runInNewContext(bundle.outputFiles[0]!.text,{module:mod,exports:mod.exports,Buffer:undefined,process:undefined,atob:undefined,TextEncoder:undefined,TextDecoder:undefined,crypto:undefined});
  assert.deepEqual(Object.keys(mod.exports),['createDataClient']);
  const sent:any[]=[];
  const wx={request(o:any){
    sent.push(JSON.parse(JSON.stringify(o.data)));
    o.success({statusCode:200,data:o.url.endsWith('/get')?{exists:false,version:0,data:null,updatedAt:null}:{version:1,updatedAt:'2026-10-16T14:00:00.000Z'}});
  }};
  const store=mod.exports.createDataClient({wx,accessToken:token});
  assert.equal((await store.get()).exists,false);
  assert.equal((await store.save('{"中文":"🚀"}',0)).version,1);
  assert.deepEqual(sent,[{},{version:0,data:'{"中文":"🚀"}'}]);
});
