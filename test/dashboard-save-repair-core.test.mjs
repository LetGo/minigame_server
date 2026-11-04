import assert from 'node:assert/strict';
import {test} from 'node:test';
test('raw token replacement survives escaped keys, mixed nested values, Unicode and size growth',async()=>{
 const {buildSaveRepair}=await import('../dashboard/save-repair.mjs');
 const raw=String.raw`{ "D\u0069a" : 3, "_getDia":3309, "_useDia":3300, "Is_Remove_AD_All":false, "文字":"[{}] 😀 \\\\ \\\" end", "mixed":[{"z":[false,null,"}]"]}]}\n`.replace(/\\n$/,'\n');
 const expected=raw.replace(' : 3,',' : 4,').replace('"_getDia":3309','"_getDia":3312');
 assert.equal(buildSaveRepair(raw,{addDia:1}).data,expected);
 const base='{"Dia":9,"_getDia":27,"_useDia":0,"Is_Remove_AD_All":true,"padding":""}';
 const atLimit=base.replace('"padding":""','"padding":"'+'x'.repeat(65536-Buffer.byteLength(base))+'"');assert.equal(Buffer.byteLength(atLimit),65536);
 assert.throws(()=>buildSaveRepair(atLimit,{addDia:1}),/SAVE_REPAIR_INVALID_REQUEST/);
});
test('rollback failure discards the client while preserving the original operation error',async()=>{
 const {createSaveRepair}=await import('../dashboard/save-repair.mjs');const operationError=new Error('original operation failed'),rollbackError=new Error('rollback failed');let released;
 const client={async query(sql){if(sql==='ROLLBACK')throw rollbackError;if(sql.startsWith('SELECT request_hash'))throw operationError;return {rows:[]};},release(error){released=error;}};
 const service=createSaveRepair({pool:{},writePool:{connect:async()=>client},appId:'test_app',enabled:true});
 await assert.rejects(()=>service.apply({openid:'o-test',version:1,fingerprint:'a'.repeat(64),changes:{addDia:1},requestId:'11111111-1111-4111-8111-111111111111',reason:'测试'},'admin'),error=>error===operationError);
 assert.equal(released,rollbackError,'unknown transaction state must not return to the pool');
});
test('rejects unsafe or fractional numeric text before rounding and refuses arbitrary-field writes',async()=>{
 const {buildSaveRepair}=await import('../dashboard/save-repair.mjs');
 const raw='{"Dia":3,"_getDia":3309,"_useDia":3300,"Is_Remove_AD_All":false}';
 for(const value of ['3.0000000000000001','9007199254740992','1e309','-1','null','"3"'])assert.throws(()=>buildSaveRepair(raw.replace('"Dia":3,','"Dia":'+value+','),{addDia:1}),/SAVE_REPAIR_INVALID_SAVE/);
 for(const change of [{Dia:100},{_getDia:10},{_useDia:0},{addDia:-1},{addDia:0.5},{addDia:'10'},{addDia:Number.MAX_SAFE_INTEGER},{removeAds:1},{}])assert.throws(()=>buildSaveRepair(raw,change),/SAVE_REPAIR_INVALID_REQUEST/);
 for(const data of ['null','[]','{}',raw.replace('"Dia":3','"Dia":3,"Dia":4'),raw.replace('"Dia":3','"Dia":3,"D\\u0069a":4')])assert.throws(()=>buildSaveRepair(data,{addDia:1}),/SAVE_REPAIR_INVALID_SAVE/);
 assert.throws(()=>buildSaveRepair(raw,{addDia:0,removeAds:false}),/SAVE_REPAIR_INVALID_REQUEST/);
});
test('repairs only selected root value tokens, retaining every other byte and integer precision',async()=>{
 const {buildSaveRepair}=await import('../dashboard/save-repair.mjs');
 const raw='{\n "Dia":3,"_getDia":3309,"_useDia":3300, "Is_Remove_AD_All":false, "big":900719925474099312345,"nested":{"Dia":999},"escaped":"a\\\"b"\n}\n';
 const r=buildSaveRepair(raw,{removeAds:true,addDia:100});
 assert.equal(r.data,raw.replace('"Dia":3,','"Dia":103,').replace('"_getDia":3309','"_getDia":3609').replace('"Is_Remove_AD_All":false','"Is_Remove_AD_All":true'));
 assert.deepEqual(r.before,{Is_Remove_AD_All:false,Dia:3,_getDia:3309,_useDia:3300});
 assert.deepEqual(r.after,{Is_Remove_AD_All:true,Dia:103,_getDia:3609,_useDia:3300});
});
