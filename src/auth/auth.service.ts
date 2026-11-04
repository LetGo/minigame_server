import { createHash, randomBytes } from 'node:crypto';
import { ServiceUnavailableException } from '@nestjs/common';
import { PoolClient } from 'pg';
import { AppConfig } from '../config.js';
import { Infrastructure } from '../infrastructure.js';
import { WechatClient } from './wechat.client.js';

export class AuthService {
  constructor(
    private readonly config: AppConfig,
    private readonly infrastructure: Infrastructure,
    private readonly wechat: WechatClient,
  ) {}

  async login(code: string, clientVersion?: string, scene?: number) {
    const { openid } = await this.wechat.exchange(code);
    let client: PoolClient | undefined;
    let sessionKey: string | undefined;
    let sessionStored = false;
    let discardClient = false;
    try {
      client = await this.infrastructure.pool.connect();
      await client.query('BEGIN');
      // The upsert locks this user until the session and first-login flag are confirmed.
      // A supplied version replaces the stored one; an omitted (NULL) version keeps it,
      // so reporting is monotonic in "latest supplied value" order, never cleared by
      // a legacy client. The parameter is intentionally uncast: an explicit
      // ::varchar(64) would silently truncate overlong input, while the column's own
      // assignment check rejects it.
      const result = await client.query<{ id: string; first_login_completed: boolean }>(
        `INSERT INTO game_users (app_id, open_id, first_login_completed, last_client_version) VALUES ($1, $2, false, $3)
         ON CONFLICT (app_id, open_id) DO UPDATE SET last_login_at = now(),
           last_client_version = COALESCE(EXCLUDED.last_client_version, game_users.last_client_version)
         RETURNING id, first_login_completed`,
        [this.config.appId, openid, clientVersion ?? null],
      );
      const user = result.rows[0];
      if (!user) throw new Error('User upsert failed');
      // Restore stored display data for this app's authenticated UID, not from WeChat/code input.
      // Read before issuing a session so a profile-storage error rolls registration back.
      const profileResult = await client.query<{ nickname: string | null; avatar_url: string | null }>(
        `SELECT p.nickname, p.avatar_url FROM game_profiles p
         JOIN game_users u ON u.id=p.user_id WHERE u.id=$1 AND u.app_id=$2`,
        [user.id, this.config.appId],
      );
      const profile = profileResult.rows[0];
      const isNewUser = !user.first_login_completed;
      const accessToken = randomBytes(32).toString('base64url');
      sessionKey = `minigame:session:${createHash('sha256').update(accessToken).digest('hex')}`;
      const stored = await this.infrastructure.redis.withCommandOptions({ abortSignal: AbortSignal.timeout(3000) }).set(
        sessionKey,
        JSON.stringify({ userId: user.id, appId: this.config.appId, issuedAt: new Date().toISOString(), isNewUser }),
        { EX: this.config.sessionTtlSeconds, NX: true },
      );
      if (stored !== 'OK') throw new Error('Session creation failed');
      sessionStored = true;
      if (isNewUser) {
        await client.query('UPDATE game_users SET first_login_completed = true WHERE id = $1', [user.id]);
      }
      // The first launch scene is written once, by the database clock, inside this same
      // transaction. Only a genuinely new registration fills the empty slot: completed
      // historical users keep NULL instead of being backfilled, and an existing scene is
      // never replaced or used to refuse a login.
      if (isNewUser && scene !== undefined) {
        await client.query(
          `UPDATE game_users SET source_scene = $1, source_scene_reported_at = clock_timestamp()
           WHERE id = $2 AND app_id = $3 AND source_scene IS NULL`,
          [scene, user.id, this.config.appId],
        );
      }
      // Capture the successful login's DB time after acquiring the user lock, then write
      // today's deduplicated DAU row and this visit's append-only scene event from that one
      // reading: both rows carry the exact last_login_at assigned here, never an
      // application-clock value. Daily activity, event and registration commit together, so
      // Redis/storage failures roll all of them back.
      await client.query(
        `WITH login AS (
           UPDATE game_users SET last_login_at=clock_timestamp() WHERE id=$1
           RETURNING app_id,id,last_login_at
         ), daily AS (
           INSERT INTO game_daily_logins(app_id,user_id,activity_date,first_login_at)
             SELECT app_id,id,(last_login_at AT TIME ZONE 'Asia/Shanghai')::date,last_login_at FROM login
             ON CONFLICT (app_id,activity_date,user_id) DO NOTHING
         ), event AS (
           INSERT INTO game_login_events(app_id,user_id,login_at,scene)
             SELECT app_id,id,last_login_at,$2 FROM login
         )
         SELECT 1`,
        [user.id, scene ?? null],
      );
      await client.query('COMMIT');
      return { accessToken, tokenType: 'Bearer', expiresIn: this.config.sessionTtlSeconds, isNewUser,
        user: { id: user.id, openid, nickname: profile?.nickname ?? null, avatarUrl: profile?.avatar_url ?? null } };
    } catch {
      if (client) {
        try { await client.query('ROLLBACK'); } catch { discardClient = true; }
      }
      if (sessionStored && sessionKey) {
        try {
          await this.infrastructure.redis.withCommandOptions({ abortSignal: AbortSignal.timeout(3000) }).del(sessionKey);
        } catch { /* Best effort: no failed login token is returned to the client. */ }
      }
      throw new ServiceUnavailableException('LOGIN_STORAGE_UNAVAILABLE');
    } finally {
      client?.release(discardClient);
    }
  }
}
