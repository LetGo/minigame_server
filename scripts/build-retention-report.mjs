import {Pool} from 'pg';
import {isAbsolute, normalize, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {realpathSync} from 'node:fs';
import {readEnv} from '../ops/staging-admin.mjs';
import {collectRetentionReport, publishRetentionReport} from '../dashboard/retention-report.mjs';

export const DEFAULT_RETENTION_REPORT_DIR = '/home/ubuntu/.hermes/workspace/projects/minigame_server/runtime/analytics/retention';
export function loadRetentionReportConfig(env, args = []) {
  try {
    if(args.length !== 0 && !(args.length === 2 && args[0] === '--output-dir'))throw new Error();
    const outputDir = args[1] ?? env.DASHBOARD_RETENTION_REPORT_DIR ?? DEFAULT_RETENTION_REPORT_DIR;
    if(typeof outputDir !== 'string' || !isAbsolute(outputDir) || normalize(outputDir) !== outputDir || outputDir.endsWith('/') || outputDir.includes('\0'))throw new Error();
    const database = new URL(env.DATABASE_URL);
    if(database.protocol !== 'postgresql:' || database.hostname !== '127.0.0.1' || database.port !== '15440' || database.pathname !== '/minigame' || database.username !== 'minigame_dashboard_app' || !database.password || database.search || database.hash)throw new Error();
    if(!/^wx[a-f0-9]{16}$/.test(env.DASHBOARD_APP_ID) || env.DASHBOARD_ENVIRONMENT !== 'production')throw new Error();
    return {databaseUrl:env.DATABASE_URL,appId:env.DASHBOARD_APP_ID,outputDir};
  } catch {throw new Error('Invalid retention configuration');}
}
export function createRetentionPool(config) {
  const pool = new Pool({connectionString:config.databaseUrl,max:1,connectionTimeoutMillis:3000,
    statement_timeout:60000,idle_in_transaction_session_timeout:65000,
    options:'-c default_transaction_read_only=on -c jit=off'});
  pool.on('error',()=>{});
  return pool;
}
export async function main(args = process.argv.slice(2)) {
  // Never load .env (writer). This established helper enforces credential mode 0600.
  const env = readEnv(resolve('.env.dashboard'));
  const config = loadRetentionReportConfig(env,args);
  const pool = createRetentionPool(config);
  try {
    const report = await collectRetentionReport(pool,config.appId);
    const saved = await publishRetentionReport(config.outputDir,report);
    console.log(JSON.stringify({status:'retention_report_ready',asOfDate:saved.asOfDate,historyDays:saved.historyDays}));
  } finally {await pool.end();}
}
// systemd invokes this CLI through current/, while Node resolves import.meta.url.
export function isMainModule(entryPath = process.argv[1], moduleUrl = import.meta.url) {
  if(!entryPath)return false;
  try {return realpathSync(resolve(entryPath)) === realpathSync(fileURLToPath(moduleUrl));}
  catch {return false;}
}
if(isMainModule()) {
  main().catch(()=>{console.error('Retention report unavailable: generation failed (sensitive details suppressed)');process.exitCode=1;});
}
