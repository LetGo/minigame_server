import { createHash } from 'node:crypto';
import { BadRequestException, ConflictException, HttpException, NotFoundException, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { Request } from 'express';
import { PoolClient } from 'pg';
import { AppConfig } from '../config.js';
import { Infrastructure } from '../infrastructure.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
type Session = { userId: string; isNewUser: boolean };
type Invitation = { inviter_user_id: string; claim_id: string | null; reward_claimed_at: Date | null };
type PageRow = { invitee_user_id: string; nickname: string | null; avatar_url: string | null;
  invited_at: string; cursor_time: string; claim_id: string | null; reward_claimed_at: string | null };

export class InvitesService {
  constructor(private readonly config: AppConfig, private readonly infrastructure: Infrastructure) {}

  private async database<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation(); }
    catch (error) {
      if (error instanceof HttpException) throw error;
      throw new ServiceUnavailableException('INVITE_STORAGE_UNAVAILABLE');
    }
  }

  private async transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    return this.database(async () => {
      const client = await this.infrastructure.pool.connect();
      let discard = false;
      try {
        await client.query('BEGIN');
        const result = await operation(client);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        try { await client.query('ROLLBACK'); } catch { discard = true; }
        throw error;
      } finally { client.release(discard); }
    });
  }

  private async session(request: Request): Promise<Session> {
    const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.get('authorization') ?? '');
    if (!match || Buffer.from(match[1]!, 'base64url').toString('base64url') !== match[1]) throw new UnauthorizedException('SESSION_INVALID');
    let raw: string | null;
    try {
      const digest = createHash('sha256').update(match[1]!).digest('hex');
      raw = await this.infrastructure.redis.withCommandOptions({ abortSignal: AbortSignal.timeout(3000) }).get(`minigame:session:${digest}`);
    } catch { throw new ServiceUnavailableException('INVITE_STORAGE_UNAVAILABLE'); }
    let value: { userId?: unknown; appId?: unknown; isNewUser?: unknown } | null;
    try { value = JSON.parse(raw ?? 'null'); } catch { throw new UnauthorizedException('SESSION_INVALID'); }
    if (!value || typeof value !== 'object' || value.appId !== this.config.appId || typeof value.userId !== 'string' || !UUID.test(value.userId)
      || (value.isNewUser !== undefined && typeof value.isNewUser !== 'boolean')) throw new UnauthorizedException('SESSION_INVALID');
    const userId = value.userId;
    const exists = await this.database(() => this.infrastructure.pool.query(
      'SELECT id FROM game_users WHERE id=$1 AND app_id=$2', [userId, this.config.appId]));
    if (!exists.rowCount) throw new UnauthorizedException('SESSION_INVALID');
    let rate: [number, number];
    try {
      rate = await this.infrastructure.redis.withCommandOptions({ abortSignal: AbortSignal.timeout(3000) }).eval(
        "local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],60) end; return {n,redis.call('TTL',KEYS[1])}",
        { keys: [`minigame:invite-rate:${this.config.appId}:${userId}`], arguments: [] }) as [number, number];
    } catch { throw new ServiceUnavailableException('INVITE_STORAGE_UNAVAILABLE'); }
    if (rate[0] > 60) {
      request.res?.setHeader('Retry-After', String(Math.max(rate[1], 1)));
      throw new HttpException('INVITE_RATE_LIMITED', 429);
    }
    if (Object.keys(request.query).length) throw new BadRequestException('INVALID_INVITE_REQUEST');
    return { userId, isNewUser: value.isNewUser === true };
  }

  private body(request: Request, allowed: string[], required: string[]): Record<string, unknown> {
    const body: unknown = request.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(body, key))) {
      throw new BadRequestException('INVALID_INVITE_REQUEST');
    }
    return body as Record<string, unknown>;
  }

  private uid(value: unknown): string {
    if (typeof value !== 'string' || !UUID.test(value)) throw new BadRequestException('INVALID_INVITE_REQUEST');
    return value;
  }

  async profile(request: Request) {
    const { userId } = await this.session(request);
    const { nickname, avatarUrl } = this.body(request, ['nickname', 'avatarUrl'], ['nickname', 'avatarUrl']);
    if (typeof nickname !== 'string' || [...nickname].length < 1 || [...nickname].length > 64 || !nickname.trim() || CONTROL.test(nickname)
      || Buffer.from(nickname, 'utf8').toString('utf8') !== nickname || typeof avatarUrl !== 'string'
      || avatarUrl.length < 1 || avatarUrl.length > 2048 || CONTROL.test(avatarUrl) || avatarUrl.trim() !== avatarUrl
      || Buffer.from(avatarUrl, 'utf8').toString('utf8') !== avatarUrl) throw new BadRequestException('INVALID_PROFILE');
    try {
      const url = new URL(avatarUrl);
      if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) throw new Error('Invalid avatar URL');
    } catch { throw new BadRequestException('INVALID_PROFILE'); }
    await this.database(() => this.infrastructure.pool.query(
      `INSERT INTO game_profiles(user_id,nickname,avatar_url) VALUES($1,$2,$3)
       ON CONFLICT(user_id) DO UPDATE SET nickname=EXCLUDED.nickname,avatar_url=EXCLUDED.avatar_url,updated_at=now()`,
      [userId, nickname, avatarUrl]));
    return { user: { id: userId, nickname, avatarUrl } };
  }

  async report(request: Request) {
    const actor = await this.session(request);
    const inviterUid = this.uid(this.body(request, ['inviterUid'], ['inviterUid']).inviterUid);
    if (inviterUid.toLowerCase() === actor.userId.toLowerCase()) return { accepted: false, reason: 'SELF_INVITE' };
    return this.transaction(async client => {
      // Serialize all competing reports for this invitee, including retries through other sessions.
      const locked = await client.query('SELECT id FROM game_users WHERE id=$1 AND app_id=$2 FOR UPDATE', [actor.userId, this.config.appId]);
      if (!locked.rowCount) throw new UnauthorizedException('SESSION_INVALID');
      const existing = await client.query<Invitation>(
        'SELECT inviter_user_id,claim_id,reward_claimed_at FROM game_invitations WHERE invitee_user_id=$1 AND app_id=$2',
        [actor.userId, this.config.appId]);
      const prior = existing.rows[0];
      if (prior) {
        if (prior.inviter_user_id !== inviterUid.toLowerCase()) return { accepted: false, reason: 'ALREADY_ATTRIBUTED' };
        return { accepted: true, alreadyBound: true, rewardClaimed: prior.claim_id !== null };
      }
      if (!actor.isNewUser) return { accepted: false, reason: 'NOT_NEW_USER' };
      const inviter = await client.query(
        `SELECT id FROM game_users WHERE id=$1 AND app_id=$2
         AND created_at <= (SELECT created_at FROM game_users WHERE id=$3 AND app_id=$2)`,
        [inviterUid, this.config.appId, actor.userId]);
      if (!inviter.rowCount) throw new NotFoundException('INVITER_NOT_FOUND');
      await client.query('INSERT INTO game_invitations(app_id,inviter_user_id,invitee_user_id) VALUES($1,$2,$3)',
        [this.config.appId, inviterUid, actor.userId]);
      return { accepted: true, alreadyBound: false, rewardClaimed: false };
    });
  }

  private cursor(value: unknown): [boolean, string, string] | null {
    if (value === undefined || value === null) return null;
    try {
      if (typeof value !== 'string' || value.length > 512 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid cursor');
      const decoded = Buffer.from(value, 'base64url');
      if (decoded.toString('base64url') !== value) throw new Error('Invalid cursor');
      const parsed: unknown = JSON.parse(decoded.toString('utf8'));
      if (!Array.isArray(parsed) || parsed.length !== 3 || typeof parsed[0] !== 'boolean' || typeof parsed[1] !== 'string'
        || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(parsed[1]) || parsed[1].startsWith('0000')
        || typeof parsed[2] !== 'string' || !UUID.test(parsed[2])) throw new Error('Invalid cursor');
      if (new Date(parsed[1]).toISOString() !== parsed[1].slice(0, 23) + 'Z') throw new Error('Invalid cursor');
      return [parsed[0], parsed[1], parsed[2]];
    } catch { throw new BadRequestException('INVALID_INVITE_CURSOR'); }
  }

  async list(request: Request) {
    const { userId } = await this.session(request);
    const body = this.body(request, ['cursor', 'limit'], []);
    const limit = body.limit === undefined ? 20 : body.limit;
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new BadRequestException('INVALID_INVITE_REQUEST');
    const cursor = this.cursor(body.cursor);
    // One SQL snapshot for both page and whole-list summary; preserve microseconds inside the opaque cursor.
    const result = await this.database(() => this.infrastructure.pool.query<{
      page: PageRow[]; summary: { total: number; claimed: number; unclaimed: number };
    }>(
      `WITH owned AS MATERIALIZED (
         SELECT i.invitee_user_id,i.invited_at,i.claim_id,i.reward_claimed_at,p.nickname,p.avatar_url
         FROM game_invitations i LEFT JOIN game_profiles p ON p.user_id=i.invitee_user_id
         WHERE i.app_id=$1 AND i.inviter_user_id=$2
       )
       SELECT COALESCE((SELECT json_agg(paged ORDER BY (paged.claim_id IS NOT NULL) ASC,paged.invited_at DESC,paged.invitee_user_id DESC) FROM (
         SELECT owned.*,to_char(invited_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_time
         FROM owned WHERE $3::boolean IS NULL OR (claim_id IS NOT NULL)>$3::boolean
           OR ((claim_id IS NOT NULL)=$3::boolean AND (invited_at,invitee_user_id)<($4::timestamptz,$5::uuid))
         ORDER BY (claim_id IS NOT NULL) ASC,invited_at DESC,invitee_user_id DESC LIMIT $6
       ) paged),'[]'::json) AS page,
       (SELECT json_build_object('total',count(*)::int,'claimed',count(claim_id)::int,
         'unclaimed',count(*)::int-count(claim_id)::int) FROM owned) AS summary`,
      [this.config.appId, userId, cursor?.[0] ?? null, cursor?.[1] ?? null, cursor?.[2] ?? null, limit + 1],
    ));
    const { page, summary } = result.rows[0]!;
    const displayed = page.slice(0, limit);
    const last = displayed.at(-1);
    return {
      items: displayed.map(row => ({ inviteeUid: row.invitee_user_id, nickname: row.nickname, avatarUrl: row.avatar_url,
        invitedAt: new Date(row.invited_at).toISOString(), rewardClaimed: row.claim_id !== null,
        rewardClaimedAt: row.reward_claimed_at ? new Date(row.reward_claimed_at).toISOString() : null, claimId: row.claim_id })),
      summary,
      nextCursor: page.length > limit && last ? Buffer.from(JSON.stringify([last.claim_id !== null, last.cursor_time, last.invitee_user_id])).toString('base64url') : null,
    };
  }

  async claim(request: Request) {
    const { userId } = await this.session(request);
    const inviteeUid = this.uid(this.body(request, ['inviteeUid'], ['inviteeUid']).inviteeUid);
    const row = await this.transaction(async client => {
      // Serialize every claim for this inviter across sessions/processes, not just this invitee.
      const owner = await client.query('SELECT id FROM game_users WHERE app_id=$1 AND id=$2 FOR UPDATE', [this.config.appId, userId]);
      if (!owner.rowCount) throw new UnauthorizedException('SESSION_INVALID');
      const existing = await client.query<{ claim_id: string | null; reward_claimed_at: Date | null }>(
        'SELECT claim_id,reward_claimed_at FROM game_invitations WHERE app_id=$1 AND inviter_user_id=$2 AND invitee_user_id=$3',
        [this.config.appId, userId, inviteeUid]);
      const invitation = existing.rows[0];
      if (!invitation) throw new NotFoundException('INVITATION_NOT_FOUND');
      // A retry returns the original receipt even when today's quota is already exhausted.
      if (invitation.claim_id !== null) return { claim_id: invitation.claim_id, reward_claimed_at: invitation.reward_claimed_at! };
      // Capture DB wall time AFTER acquiring the inviter lock; count and write against that same day.
      const quota = await client.query<{ claim_time: string; claimed: number }>(
        `WITH moment AS MATERIALIZED (SELECT clock_timestamp() AS claim_time), bounds AS (
           SELECT claim_time,
             ((claim_time AT TIME ZONE 'Asia/Shanghai')::date)::timestamp AT TIME ZONE 'Asia/Shanghai' AS day_start,
             (((claim_time AT TIME ZONE 'Asia/Shanghai')::date + 1)::timestamp AT TIME ZONE 'Asia/Shanghai') AS day_end
           FROM moment
         ) SELECT claim_time::text, (SELECT count(*)::int FROM game_invitations
           WHERE app_id=$1 AND inviter_user_id=$2 AND reward_claimed_at>=bounds.day_start AND reward_claimed_at<bounds.day_end) AS claimed
         FROM bounds`, [this.config.appId, userId]);
      const { claim_time, claimed } = quota.rows[0]!;
      if (claimed >= 50) throw new ConflictException('INVITE_DAILY_CLAIM_LIMIT');
      const result = await client.query<{ claim_id: string; reward_claimed_at: Date }>(
        `UPDATE game_invitations SET claim_id=gen_random_uuid(),reward_claimed_at=$4::timestamptz
         WHERE app_id=$1 AND inviter_user_id=$2 AND invitee_user_id=$3 RETURNING claim_id,reward_claimed_at`,
        [this.config.appId, userId, inviteeUid, claim_time]);
      return result.rows[0]!;
    });
    return { claimId: row.claim_id, rewardClaimed: true, rewardClaimedAt: row.reward_claimed_at.toISOString() };
  }
}
