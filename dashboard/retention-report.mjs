import {constants} from 'node:fs';
import {open, mkdir, lstat, rename, unlink} from 'node:fs/promises';
import {isAbsolute, join, parse} from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {isDeepStrictEqual} from 'node:util';

// Aggregates only: no user identifiers leave the read-only database snapshot.
export const RETENTION_PERIODS = Object.freeze([1, 3, 5, 7, 14, 20, 30]);
const DAY = 86400000;
const addDays = (date, days) => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);
const iso = value => new Date(value).toISOString();

const COLLECT_SQL = `
WITH moment AS MATERIALIZED (
  SELECT transaction_timestamp() AS at
), settings AS MATERIALIZED (
  SELECT at AS generated_at, (at AT TIME ZONE 'Asia/Shanghai')::date - 1 AS as_of_date,
    m.coverage_start, m.tracking_started_at
  FROM moment CROSS JOIN game_analytics_metadata m WHERE m.id = true
), registrations AS MATERIALIZED (
  SELECT u.id, u.app_id, (u.created_at AT TIME ZONE 'Asia/Shanghai')::date AS cohort_date
  FROM game_users u CROSS JOIN settings s
  WHERE u.app_id = $1 AND u.first_login_completed
    AND u.created_at >= (s.as_of_date - ($2::int - 1))::timestamp AT TIME ZONE 'Asia/Shanghai'
    AND u.created_at < (s.as_of_date + 1)::timestamp AT TIME ZONE 'Asia/Shanghai'
), sizes AS (
  SELECT cohort_date, count(*)::int AS cohort_size FROM registrations GROUP BY cohort_date
), returns AS (
  SELECT r.cohort_date, p.day, count(*)::int AS returned
  FROM registrations r CROSS JOIN unnest(ARRAY[1,3,5,7,14,20,30]) AS p(day)
  JOIN game_daily_logins l ON l.app_id = r.app_id AND l.user_id = r.id
    AND l.activity_date = r.cohort_date + p.day
  CROSS JOIN settings s
  WHERE l.activity_date BETWEEN s.coverage_start AND s.as_of_date
  GROUP BY r.cohort_date, p.day
)
SELECT (s.as_of_date - n)::text AS cohort_date, p.day,
  coalesce(z.cohort_size,0)::int AS cohort_size, coalesce(r.returned,0)::int AS returned,
  s.as_of_date::text, s.generated_at, s.coverage_start::text, s.tracking_started_at
FROM settings s CROSS JOIN generate_series(0,$2::int-1) AS g(n)
CROSS JOIN unnest(ARRAY[1,3,5,7,14,20,30]) AS p(day)
LEFT JOIN sizes z ON z.cohort_date = s.as_of_date - n
LEFT JOIN returns r ON r.cohort_date = s.as_of_date - n AND r.day = p.day
ORDER BY cohort_date DESC, p.day`;

function summaries(cohorts) {
  return RETENTION_PERIODS.map(day => {
    const cells = cohorts.flatMap(c => c.cells.filter(cell => cell.day === day && cell.status === 'complete'));
    const cohortSize = cells.reduce((sum,c) => sum + c.cohortSize, 0);
    const returned = cells.reduce((sum,c) => sum + c.returned, 0);
    return {day, cohortSize, returned, rate:cohortSize ? returned / cohortSize : null, cohortDays:cells.length};
  });
}

export async function collectRetentionReport(pool, appId, options = {}) {
  const {historyDays = 120} = options;
  if (!/^wx[a-f0-9]{16}$/.test(appId) || !Number.isInteger(historyDays) || historyDays < 1 || historyDays > 366 || Object.keys(options).some(key => key !== 'historyDays')) throw new Error('Invalid retention configuration');
  const client = await pool.connect();
  let destroyed = false;
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    if ((await client.query('SHOW transaction_read_only')).rows[0]?.transaction_read_only !== 'on') throw new Error('Retention transaction must be read-only');
    const {rows} = await client.query(COLLECT_SQL, [appId, historyDays]);
    const first = rows[0];
    const cohorts = [];
    for (let n = 0; n < historyDays; n++) {
      const date = addDays(first.as_of_date, -n);
      const group = rows.filter(row => row.cohort_date === date);
      const newUsers = Number(group[0].cohort_size);
      const cells = RETENTION_PERIODS.map(day => {
        const observationDate = addDays(date, day);
        const status = observationDate > first.as_of_date ? 'pending' : observationDate < first.coverage_start ? 'uncovered' : newUsers === 0 ? 'empty' : 'complete';
        const returned = status === 'complete' ? Number(group.find(row => Number(row.day) === day).returned) : status === 'empty' ? 0 : null;
        return {day, observationDate, status, returned, cohortSize:newUsers, rate:status === 'complete' ? returned / newUsers : null};
      });
      cohorts.push({date, newUsers, cells});
    }
    const report = {schemaVersion:1, appId, environment:'production', timezone:'Asia/Shanghai',
      asOfDate:first.as_of_date, generatedAt:iso(first.generated_at), coverageStart:first.coverage_start,
      trackingStartedAt:iso(first.tracking_started_at), historyDays, periods:[...RETENTION_PERIODS], cohorts, summary:summaries(cohorts)};
    await client.query('COMMIT');
    return report;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { destroyed = true; client.release(true); }
    throw error;
  } finally { if (!destroyed) client.release(); }
}

const unavailable = () => Object.assign(new Error('Retention report unavailable'), {code:'RETENTION_REPORT_UNAVAILABLE'});
const integer = n => Number.isSafeInteger(n) && n >= 0;
const validDate = d => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) && Number.isFinite(Date.parse(d)) && new Date(d).toISOString().slice(0,10) === d;
const validInstant = d => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(d) && validDate(d.slice(0,10)) && Number.isFinite(Date.parse(d));
const keys = (object, expected) => object && typeof object === 'object' && !Array.isArray(object) && Object.keys(object).sort().join(',') === expected.split(' ').sort().join(',');
const same = (a,b) => JSON.stringify(a) === JSON.stringify(b);
export function validateRetentionReport(report, appId = report?.appId) {
  try {
    const require = condition => {if(!condition)throw unavailable();};
    require(keys(report,'schemaVersion appId environment timezone asOfDate generatedAt coverageStart trackingStartedAt historyDays periods cohorts summary'));
    require(/^wx[a-f0-9]{16}$/.test(appId) && report.appId === appId);
    require(report.schemaVersion === 1 && report.environment === 'production' && report.timezone === 'Asia/Shanghai');
    require(validDate(report.asOfDate) && validDate(report.coverageStart) && validInstant(report.generatedAt) && validInstant(report.trackingStartedAt));
    require(report.asOfDate === addDays(new Date(Date.parse(report.generatedAt)+8*3600000).toISOString().slice(0,10),-1));
    require(Date.parse(report.trackingStartedAt) <= Date.parse(report.generatedAt));
    require(Number.isInteger(report.historyDays) && report.historyDays >= 1 && report.historyDays <= 366);
    require(same(report.periods,RETENTION_PERIODS) && Array.isArray(report.cohorts) && report.cohorts.length === report.historyDays);
    report.cohorts.forEach((cohort,n) => {
      require(keys(cohort,'date newUsers cells') && cohort.date === addDays(report.asOfDate,-n) && integer(cohort.newUsers));
      require(Array.isArray(cohort.cells) && cohort.cells.length === RETENTION_PERIODS.length);
      cohort.cells.forEach((cell,index) => {
        require(keys(cell,'day observationDate status returned cohortSize rate'));
        const day = RETENTION_PERIODS[index], observationDate = addDays(cohort.date,day);
        const status = observationDate > report.asOfDate ? 'pending' : observationDate < report.coverageStart ? 'uncovered' : cohort.newUsers === 0 ? 'empty' : 'complete';
        require(cell.day === day && cell.observationDate === observationDate && cell.status === status && cell.cohortSize === cohort.newUsers);
        if(status === 'complete') require(integer(cell.returned) && cell.returned <= cohort.newUsers && cell.rate === cell.returned/cohort.newUsers);
        else require(cell.returned === (status === 'empty' ? 0 : null) && cell.rate === null);
      });
    });
    const expected = summaries(report.cohorts);
    require(Array.isArray(report.summary) && report.summary.length === expected.length);
    report.summary.forEach((row,index) => {require(keys(row,'day cohortSize returned rate cohortDays'));for(const key of Object.keys(expected[index]))require(row[key] === expected[index][key]);});
    return report;
  } catch { throw unavailable(); }
}

async function syncDirectory(directory) {
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}
async function readSnapshot(path) {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await handle.stat();
    if (!info.isFile() || info.size > 2_000_000 || (info.mode & 0o777) !== 0o600 || info.nlink !== 1) throw unavailable();
    return JSON.parse(await handle.readFile('utf8'));
  } finally { await handle?.close(); }
}
async function atomicWrite(directory, name, report) {
  const temporary = join(directory, `.retention-${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await handle.writeFile(JSON.stringify(report) + '\n');
    await handle.sync(); await handle.close(); handle = null;
    await rename(temporary, join(directory,name));
    await syncDirectory(directory);
  } finally { await handle?.close(); await unlink(temporary).catch(error => {if(error.code !== 'ENOENT')throw error;}); }
}
async function safeDirectory(directory, create = false) {
  if(typeof directory !== 'string' || !isAbsolute(directory) || directory.split('/').some(part => part === '..' || part === '.'))throw unavailable();
  let current = parse(directory).root;
  for(const component of directory.split('/').filter(Boolean)) {
    current = join(current,component);
    if(create)await mkdir(current,{mode:0o700}).catch(error => {if(error.code !== 'EEXIST')throw error;});
    const info = await lstat(current);
    if(!info.isDirectory() || info.isSymbolicLink())throw unavailable();
  }
  const info = await lstat(directory);
  if((info.mode & 0o777) !== 0o700 || info.uid !== process.getuid())throw unavailable();
}
// Linux flock is released by the kernel even on SIGKILL; no stale lock reclamation race.
async function publicationLock(directory) {
  const handle = await open(join(directory,'.publish.lock'),constants.O_RDWR|constants.O_CREAT|constants.O_NOFOLLOW|constants.O_NONBLOCK,0o600);
  try {
    const info = await handle.stat();
    if(!info.isFile() || info.nlink !== 1 || (info.mode & 0o777) !== 0o600)throw unavailable();
    // fd-only flock syntax is essential: `flock 3 command` would lock a file named 3.
    // The inherited descriptor shares this open-file description with our handle.
    const child = spawn('/usr/bin/flock',['-n','-E','75','3'],{stdio:['ignore','ignore','ignore',handle.fd]});
    const code = await new Promise((resolve,reject) => {child.once('error',reject);child.once('exit',resolve);});
    if(code !== 0)throw unavailable();
    return async () => {await handle.close();};
  } catch(error) {await handle.close();throw error;}
}
export async function loadRetentionReport(directory, appId) {
  try {
    if(typeof appId !== 'string' || !/^wx[a-f0-9]{16}$/.test(appId))throw unavailable();
    await safeDirectory(directory);
    return validateRetentionReport(await readSnapshot(join(directory,'latest.json')),appId);
  } catch { throw unavailable(); }
}
async function optionalSnapshot(path, appId) {
  try {return validateRetentionReport(await readSnapshot(path),appId);} catch(error) {if(error.code === 'ENOENT')return null;throw error;}
}
export async function publishRetentionReport(directory, report) {
  validateRetentionReport(report);
  await safeDirectory(directory,true);
  const unlock = await publicationLock(directory);
  try {
  await safeDirectory(join(directory,'history'),true);
  const latest = await optionalSnapshot(join(directory,'latest.json'),report.appId);
  if(latest && latest.asOfDate > report.asOfDate)throw unavailable();
  if(latest?.asOfDate === report.asOfDate) {
    const history = validateRetentionReport(await readSnapshot(join(directory,'history',latest.asOfDate+'.json')),report.appId);
    if(history.asOfDate !== latest.asOfDate || !isDeepStrictEqual(history,latest))throw unavailable();
    return latest;
  }
  const name = report.asOfDate+'.json';
  const previous = await optionalSnapshot(join(directory,'history',name),report.appId);
  if(previous && previous.asOfDate !== report.asOfDate)throw unavailable();
  const selected = previous ?? report;
  if(!previous)await atomicWrite(join(directory,'history'),name,selected);
  try {
    await atomicWrite(directory,'latest.json',selected);
  } catch(error) {
    // Recovery is armed before rename: directory fsync can fail after visibility changed.
    if(latest)await atomicWrite(directory,'latest.json',latest);
    else {await unlink(join(directory,'latest.json')).catch(e=>{if(e.code !== 'ENOENT')throw e;});await syncDirectory(directory);}
    throw error;
  }
  return selected;
  } finally {await unlock();}
}
