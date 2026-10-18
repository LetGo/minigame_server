import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {Pool} from 'pg';
import {migrate} from '../src/database/migrate.js';

test('overview exposes a fresh database snapshot time and renders it in Beijing time',async t=>{
 const pool=new Pool({connectionString:'postgresql://minigame_test:local_integration_only@127.0.0.1:15439/minigame_test'});
 t.after(()=>pool.end());await migrate(pool);
 const {overview}=await import(pathToFileURL(resolve('dashboard/queries.mjs')).href);
 const before=(await pool.query('SELECT clock_timestamp() AS at')).rows[0].at.getTime();
 const first=await overview(pool,'wx0000000000000000');
 const after=(await pool.query('SELECT clock_timestamp() AS at')).rows[0].at.getTime();
 assert.equal(typeof first.generatedAt,'string','overview must return generatedAt instead of leaving 更新于 blank');
 assert.match(first.generatedAt,/^\d{4}-\d{2}-\d{2}T/);
 const timestamp=Date.parse(first.generatedAt);assert(Number.isFinite(timestamp));
 assert(timestamp>=before&&timestamp<=after,'generatedAt must come from this database query');
 const day=(await pool.query("SELECT ($1::timestamptz AT TIME ZONE 'Asia/Shanghai')::date::text AS d",[first.generatedAt])).rows[0].d;
 assert.equal(first.today,day,'date and timestamp must use the same snapshot');
 await pool.query('SELECT pg_sleep(0.02)');const second=await overview(pool,'wx0000000000000000');
 assert(Date.parse(second.generatedAt)>timestamp,'successful refresh advances the generation time');
 class Element{children:Element[]=[];className='';value='';append(...items:Element[]){this.children.push(...items);}replaceChildren(...items:Element[]){this.children=[...items];}set textContent(value:string){this.value=String(value);this.children=[];}get textContent():string{return this.value+this.children.map(x=>x.textContent).join('');}}
 const js=await readFile(resolve('dashboard/public/app.js'),'utf8'),view=new Element();
 const render=runInNewContext(js.slice(0,js.indexOf("$('login-form').addEventListener"))+';renderOverview',{document:{getElementById:()=>view,createElement:()=>new Element()}});
 render(first);let label=view.children.find(e=>e.textContent.includes('更新于'));assert(label);
 assert(label.textContent.includes(new Date(first.generatedAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})),'real response must render a Beijing timestamp');
 assert.doesNotMatch(label.textContent,/更新于 —|Invalid Date/);
 render({...second,generatedAt:'2026-10-18T16:00:01.000Z'});label=view.children.find(e=>e.textContent.includes('更新于'));assert(label);
 assert.match(label.textContent,/2026\/10\/19 00:00:01/,'UTC timestamp must display the next Beijing day, independent of browser timezone');
});
