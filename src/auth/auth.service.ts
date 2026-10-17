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

  async login(code: string) {
    const { openid } = await this.wechat.exchange(code);
    let client: PoolClient | undefined;
    let sessionKey: string | undefined;
    let sessionStored = false;
    let discardClient = false;
    try {
      client = await this.infrastructure.pool.connect();
      await client.query('BEGIN');
      // The upsert locks this user until the session and first-login flag are confirmed.
      const result = await client.query<{ id: string; first_login_completed: boolean }>(
        `INSERT INTO game_users (app_id, open_id, first_login_completed) VALUES ($1, $2, false)
         ON CONFLICT (app_id, open_id) DO UPDATE SET last_login_at = now()
         RETURNING id, first_login_completed`,
        [this.config.appId, openid],
      );
      const user = result.rows[0];
      if (!user) throw new Error('User upsert failed');
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
      // Capture the successful login's DB time after acquiring the user lock.
      // Daily activity and registration commit together; Redis/storage failures roll both back.
      await client.query(
        `WITH login AS (
           UPDATE game_users SET last_login_at=clock_timestamp() WHERE id=$1
           RETURNING app_id,id,last_login_at
         ) INSERT INTO game_daily_logins(app_id,user_id,activity_date,first_login_at)
           SELECT app_id,id,(last_login_at AT TIME ZONE 'Asia/Shanghai')::date,last_login_at FROM login
           ON CONFLICT (app_id,activity_date,user_id) DO NOTHING`,
        [user.id],
      );
      await client.query('COMMIT');
      return { accessToken, tokenType: 'Bearer', expiresIn: this.config.sessionTtlSeconds, isNewUser, user: { id: user.id, openid } };
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
