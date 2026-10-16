import { Logger, OnApplicationShutdown } from '@nestjs/common';
import { Pool } from 'pg';
import { createClient } from 'redis';
import { AppConfig } from './config.js';

export class Infrastructure implements OnApplicationShutdown {
  readonly pool: Pool;
  readonly redis;
  private readonly logger = new Logger('Infrastructure');

  constructor(config: AppConfig) {
    this.pool = new Pool({
      connectionString: config.databaseUrl,
      max: 5,
      connectionTimeoutMillis: 3000,
      idleTimeoutMillis: 30000,
      statement_timeout: 5000,
      query_timeout: 6000,
      application_name: 'minigame-server',
    });
    this.pool.on('error', () => this.logger.error('PostgreSQL connection error'));
    this.redis = createClient({
      url: config.redisUrl,
      disableOfflineQueue: true,
      commandsQueueMaxLength: 200,
      socket: {
        connectTimeout: 3000,
        reconnectStrategy: retries => retries >= 3 ? new Error('Redis reconnect limit reached') : Math.min(200 * (retries + 1), 1000),
      },
    });
    this.redis.on('error', () => this.logger.error('Redis connection error'));
  }

  async connect(): Promise<void> {
    const results = await Promise.allSettled([
      this.pool.query('SELECT id FROM game_users LIMIT 0'),
      this.redis.connect(),
    ]);
    if (results.some(result => result.status === 'rejected')) {
      await this.onApplicationShutdown();
      throw new Error('Infrastructure startup failed; check database migrations and Redis connectivity');
    }
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.redis.isOpen) this.redis.destroy();
    if (!this.pool.ended) await this.pool.end();
  }
}
