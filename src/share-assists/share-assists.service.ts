import { createHash } from 'node:crypto';
import { BadRequestException, HttpException, NotFoundException, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { Request } from 'express';
import { AppConfig } from '../config.js';
import { Infrastructure } from '../infrastructure.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHARE_ID = 'diapig_invite';

export class ShareAssistsService {
  constructor(private readonly config: AppConfig, private readonly infrastructure: Infrastructure) {}

  private async storage<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation(); }
    catch (error) {
      if (error instanceof HttpException) throw error;
      throw new ServiceUnavailableException('SHARE_ASSIST_STORAGE_UNAVAILABLE');
    }
  }

  private async session(request: Request): Promise<string> {
    const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.get('authorization') ?? '');
    if (!match || Buffer.from(match[1]!, 'base64url').toString('base64url') !== match[1]) throw new UnauthorizedException('SESSION_INVALID');
    const raw = await this.storage(() => this.infrastructure.redis.withCommandOptions({ abortSignal: AbortSignal.timeout(3000) })
      .get('minigame:session:' + createHash('sha256').update(match[1]!).digest('hex')));
    let session: { appId?: unknown; userId?: unknown } | null;
    try { session = JSON.parse(raw ?? 'null'); } catch { throw new UnauthorizedException('SESSION_INVALID'); }
    if (!session || typeof session !== 'object' || session.appId !== this.config.appId || typeof session.userId !== 'string' || !UUID.test(session.userId)) {
      throw new UnauthorizedException('SESSION_INVALID');
    }
    const userId = session.userId.toLowerCase();
    const user = await this.storage(() => this.infrastructure.pool.query(
      'SELECT id FROM game_users WHERE app_id=$1 AND id=$2 AND first_login_completed', [this.config.appId, userId]));
    if (!user.rowCount) throw new UnauthorizedException('SESSION_INVALID');
    const rate = await this.storage(() => this.infrastructure.redis.withCommandOptions({ abortSignal: AbortSignal.timeout(3000) }).eval(
      "local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],60) end; return {n,redis.call('TTL',KEYS[1])}",
      { keys: [`minigame:share-assist-rate:${this.config.appId}:${userId}`], arguments: [] })) as [number, number];
    if (rate[0] > 60) {
      request.res?.setHeader('Retry-After', String(Math.max(1, rate[1])));
      throw new HttpException('SHARE_ASSIST_RATE_LIMITED', 429);
    }
    return userId;
  }

  private body(request: Request, report: boolean): Record<string, unknown> {
    const body: unknown = request.body;
    const allowed = report ? ['shareId', 'inviterUid'] : ['shareId'];
    if (Object.keys(request.query).length || !body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).some(key => !allowed.includes(key)) || allowed.some(key => !Object.hasOwn(body, key))) {
      throw new BadRequestException('INVALID_SHARE_ASSIST_REQUEST');
    }
    const input = body as Record<string, unknown>;
    if (input.shareId !== SHARE_ID || (report && (typeof input.inviterUid !== 'string' || !UUID.test(input.inviterUid)))) {
      throw new BadRequestException('INVALID_SHARE_ASSIST_REQUEST');
    }
    return input;
  }

  async report(request: Request) {
    const helperUid = await this.session(request);
    const inviterUid = (this.body(request, true).inviterUid as string).toLowerCase();
    if (inviterUid === helperUid) return { shareId: SHARE_ID, accepted: false, reason: 'SELF_ASSIST' };
    return this.storage(async () => {
      const client = await this.infrastructure.pool.connect();
      let discard = false;
      try {
        await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
        const inviter = await client.query('SELECT id FROM game_users WHERE app_id=$1 AND id=$2 AND first_login_completed',
          [this.config.appId, inviterUid]);
        if (!inviter.rowCount) throw new NotFoundException('SHARE_ASSIST_INVITER_NOT_FOUND');
        // One DB wall-clock value supplies both stored timestamp and daily idempotency key.
        const moment = (await client.query<{ at: string; date: string }>(
          `WITH moment AS MATERIALIZED (SELECT clock_timestamp() AS at)
           SELECT at::text,to_char(at AT TIME ZONE 'Asia/Shanghai','YYYY-MM-DD') AS date FROM moment`)).rows[0]!;
        const params = [this.config.appId, SHARE_ID, inviterUid, helperUid, moment.at];
        const inserted = await client.query<{ recorded_at: Date; date: string }>(
          `INSERT INTO game_share_assists(app_id,share_id,inviter_user_id,helper_user_id,recorded_at)
           VALUES($1,$2,$3,$4,$5::timestamptz)
           ON CONFLICT(app_id,share_id,inviter_user_id,activity_date,helper_user_id) DO NOTHING
           RETURNING recorded_at,to_char(activity_date,'YYYY-MM-DD') AS date`, params);
        // A separate READ COMMITTED statement sees a concurrently committed conflict winner.
        const row = inserted.rows[0] ?? (await client.query<{ recorded_at: Date; date: string }>(
          `SELECT recorded_at,to_char(activity_date,'YYYY-MM-DD') AS date FROM game_share_assists
           WHERE app_id=$1 AND share_id=$2 AND inviter_user_id=$3 AND helper_user_id=$4 AND activity_date=$5::date`,
          [this.config.appId, SHARE_ID, inviterUid, helperUid, moment.date])).rows[0];
        if (!row) throw new Error('Share assist receipt unavailable');
        await client.query('COMMIT');
        return { shareId: SHARE_ID, accepted: true, date: row.date, recordedAt: row.recorded_at.toISOString(), alreadyRecorded: !inserted.rowCount };
      } catch (error) {
        try { await client.query('ROLLBACK'); } catch { discard = true; }
        throw error;
      } finally { client.release(discard); }
    });
  }

  async summary(request: Request) {
    const userId = await this.session(request);
    this.body(request, false);
    const result = await this.storage(() => this.infrastructure.pool.query<{ date: string; reset_at: Date; count: string }>(
      `WITH moment AS MATERIALIZED (SELECT clock_timestamp() AS at), day AS (
         SELECT (at AT TIME ZONE 'Asia/Shanghai')::date AS date FROM moment
       ) SELECT to_char(day.date,'YYYY-MM-DD') AS date,
         ((day.date+1)::timestamp AT TIME ZONE 'Asia/Shanghai') AS reset_at,
         (SELECT count(*) FROM game_share_assists WHERE app_id=$1 AND share_id=$2
           AND inviter_user_id=$3 AND activity_date=day.date) AS count FROM day`,
      [this.config.appId, SHARE_ID, userId]));
    const row = result.rows[0]!;
    return { shareId: SHARE_ID, date: row.date, assistUserCount: Number(row.count), resetAt: row.reset_at.toISOString() };
  }
}
