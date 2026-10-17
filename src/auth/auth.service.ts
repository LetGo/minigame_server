import { createHash, randomBytes } from 'node:crypto';
import { ServiceUnavailableException } from '@nestjs/common';
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
    try {
      const result = await this.infrastructure.pool.query<{ id: string }>(
        `INSERT INTO game_users (app_id, open_id) VALUES ($1, $2)
         ON CONFLICT (app_id, open_id) DO UPDATE SET last_login_at = now()
         RETURNING id`,
        [this.config.appId, openid],
      );
      const user = result.rows[0];
      if (!user) throw new Error('User upsert failed');
      const accessToken = randomBytes(32).toString('base64url');
      const digest = createHash('sha256').update(accessToken).digest('hex');
      const stored = await this.infrastructure.redis.withCommandOptions({ abortSignal: AbortSignal.timeout(3000) }).set(
        `minigame:session:${digest}`,
        JSON.stringify({ userId: user.id, appId: this.config.appId, issuedAt: new Date().toISOString() }),
        { EX: this.config.sessionTtlSeconds, NX: true },
      );
      if (stored !== 'OK') throw new Error('Session creation failed');
      return { accessToken, tokenType: 'Bearer', expiresIn: this.config.sessionTtlSeconds, user: { id: user.id, openid } };
    } catch {
      throw new ServiceUnavailableException('LOGIN_STORAGE_UNAVAILABLE');
    }
  }
}
