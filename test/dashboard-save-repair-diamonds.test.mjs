import assert from 'node:assert/strict';
import {test} from 'node:test';
import {buildSaveRepair} from '../dashboard/save-repair.mjs';
const raw=(Dia=20,_getDia=960,_useDia=900)=>JSON.stringify({Dia,_getDia,_useDia,Is_Remove_AD_All:false,untouched:{integer:'900719925474099312345'}});
test('10000 diamond compensation increases balance by 10000 and raw income counter by 30000',()=>{
 const source=raw(),repair=buildSaveRepair(source,{addDia:10000});
 assert.equal(repair.after.Dia,10020);
 assert.equal(repair.after._getDia,30960);
 assert.equal(repair.after._useDia,900);
 assert.equal(repair.after._getDia/3-repair.after._useDia/3,repair.after.Dia);
 assert.deepEqual(repair.delta,{Dia:10000,_getDia:30000,_useDia:0});
 assert.equal(repair.data,source.replace('"Dia":20,','"Dia":10020,').replace('"_getDia":960','"_getDia":30960'));
});

test('diamond amount is a strictly positive int32 integer without coercion or truncation',()=>{
 for(const amount of [0,-1,0.1,1.5,'1','10000','not-a-number',null,true,NaN,Infinity,2147483648,Number.MAX_SAFE_INTEGER,9007199254740992]){
  assert.throws(()=>buildSaveRepair(raw(),{addDia:amount}),/SAVE_REPAIR_INVALID_REQUEST/,'reject '+String(amount));
 }
});
test('inconsistent or non-multiple-of-three ledgers require manual review without auto balancing',()=>{
 for(const source of [raw(21,960,900),raw(20,961,901),raw(20,961,900),raw(20,960,901),raw(0,900,960),raw(2147483648,0,0),raw(0,2147483648,0),raw(0,0,2147483648)]){
  assert.throws(()=>buildSaveRepair(source,{addDia:1}),/SAVE_REPAIR_INVALID_LEDGER/);
 }
 for(const key of ['Dia','_getDia','_useDia'])for(const token of ['-1','1.1','1e3','null','"20"']){
  const original=raw(),match=new RegExp('"'+key+'":\\d+');
  assert.throws(()=>buildSaveRepair(original.replace(match,'"'+key+'":'+token),{addDia:1}),/SAVE_REPAIR_INVALID_SAVE/);
 }
});
test('int32 overflow refuses the whole repair and the exact largest valid grant is accepted',()=>{
 assert.throws(()=>buildSaveRepair(raw(0,0,0),{addDia:715827883}),/SAVE_REPAIR_DIAMOND_OVERFLOW/);
 assert.throws(()=>buildSaveRepair(raw(715827882,2147483646,0),{addDia:1}),/SAVE_REPAIR_DIAMOND_OVERFLOW/);
 const result=buildSaveRepair(raw(0,0,0),{addDia:715827882});
 assert.deepEqual(result.delta,{Dia:715827882,_getDia:2147483646,_useDia:0});
 assert.equal(result.after._getDia,2147483646);
});
