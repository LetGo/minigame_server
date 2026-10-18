import assert from 'node:assert/strict';
import {test} from 'node:test';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {Pool} from 'pg';

test('only dashboard pool connections disable JIT while preserving bounded pooling and SQL timeouts',async t=>{
 const url='postgresql://minigame_test:local_integration_only@127.0.0.1:15439/minigame_test';
 const control=new Pool({connectionString:url,max:1});t.after(()=>control.end());
 const original=(await control.query('SHOW jit')).rows[0].jit;
 const module=await import(pathToFileURL(resolve('dashboard/server.mjs')).href);
 assert.equal(typeof module.createDashboardPool,'function','dedicated dashboard pool must configure session-only jit=off');
 const pool=module.createDashboardPool(url);t.after(()=>pool.end());assert.equal(pool.options.max,4);
 const clients=await Promise.all(Array.from({length:4},()=>pool.connect()));
 try{for(const client of clients){await client.query('BEGIN READ ONLY');
  assert.equal((await client.query('SHOW jit')).rows[0].jit,'off');
  assert.equal((await client.query('SHOW statement_timeout')).rows[0].statement_timeout,'5s');
  assert.equal((await client.query('SHOW transaction_read_only')).rows[0].transaction_read_only,'on');
  await client.query('ROLLBACK');
 }}finally{clients.forEach(client=>client.release());}
 assert.equal((await control.query('SHOW jit')).rows[0].jit,original,'unrelated DB sessions and global configuration remain unchanged');
});
