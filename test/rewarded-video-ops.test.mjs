import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';

test('new dashboard provisioning explicitly grants video SELECT without widening write rights',()=>{
 const source=readFileSync('ops/dashboard-admin.mjs','utf8');
 assert.match(source,/GRANT SELECT ON [^;`]*\bgame_rewarded_video_events\b[^;`]* TO minigame_dashboard_app/);
 assert.match(source,/\['game_users'[^\]]*'game_rewarded_video_events'/,'new table must be included in readonly permission verification');
 assert.doesNotMatch(source,/GRANT[^;`]*(?:INSERT|UPDATE|DELETE)[^;`]*ON[^;`]*game_rewarded_video_events/);
 assert.match(source,/default_transaction_read_only = on/);
});

test('staging provisioning grants video runtime only SELECT and INSERT',()=>{
 const source=readFileSync('ops/staging-admin.mjs','utf8');
 assert.match(source,/GRANT SELECT, INSERT ON game_rewarded_video_events TO minigame_staging_app/);
 assert.doesNotMatch(source,/GRANT[^;`]*(?:UPDATE|DELETE)[^;`]*ON[^;`]*game_rewarded_video_events/);
});
