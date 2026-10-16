import { createHash } from 'node:crypto';
import { CanActivate, ExecutionContext, HttpException, Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { Request, Response } from 'express';
import { AppConfig, CONFIG } from '../config.js';
import { Infrastructure } from '../infrastructure.js';

const CONSUME = `
local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return {n, redis.call('TTL', KEYS[1])}
`;

@Injectable()
export class LoginRateGuard implements CanActivate {
  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(Infrastructure) private readonly infrastructure: Infrastructure,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const ip = request.ip ?? request.socket.remoteAddress ?? 'unknown';
    const digest = createHash('sha256').update(ip).digest('hex');
    let count: number;
    let ttl: number;
    try {
      const result = await this.infrastructure.redis.withCommandOptions({ abortSignal: AbortSignal.timeout(3000) }).eval(CONSUME, {
        keys: [`minigame:login-rate:${this.config.appId}:${digest}`],
        arguments: [String(this.config.loginRateWindowSeconds)],
      }) as [number, number];
      [count, ttl] = result;
    } catch {
      throw new ServiceUnavailableException('LOGIN_STORAGE_UNAVAILABLE');
    }
    if (count > this.config.loginRateLimit) {
      context.switchToHttp().getResponse<Response>().setHeader('Retry-After', String(Math.max(ttl, 1)));
      throw new HttpException('LOGIN_RATE_LIMITED', 429);
    }
    return true;
  }
}
