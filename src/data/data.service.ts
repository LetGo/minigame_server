import { CLIENT_INSTANCE_PATTERN } from '../auth/client-instance.js';
import { createHash, randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, HttpException, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { Request } from 'express';
import { AppConfig } from '../config.js';
import { Infrastructure } from '../infrastructure.js';

export class DataService {
  constructor(private readonly config: AppConfig, private readonly infrastructure: Infrastructure) {}

  private async readRequest(request: Request) {
    const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.get('authorization') ?? '');
    if (!match || Buffer.from(match[1]!, 'base64url').toString('base64url') !== match[1]) throw new UnauthorizedException('SESSION_INVALID');
    const token = match[1]!, digest = createHash('sha256').update(token).digest('hex');
    let raw: string | null;
    try {
      raw = await this.infrastructure.redis.withCommandOptions({ abortSignal: AbortSignal.timeout(3000) }).get(`minigame:session:${digest}`);
    } catch { throw new ServiceUnavailableException('DATA_STORAGE_UNAVAILABLE'); }
    let session: { userId?: unknown; appId?: unknown; clientInstanceId?: unknown; sessionId?: unknown };
    try { session = JSON.parse(raw ?? 'null'); } catch { throw new UnauthorizedException('SESSION_INVALID'); }
    if (!session || session.appId !== this.config.appId || typeof session.userId !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(session.userId)) throw new UnauthorizedException('SESSION_INVALID');
    let rate: [number, number];
    try {
      rate = await this.infrastructure.redis.withCommandOptions({ abortSignal: AbortSignal.timeout(3000) }).eval(
        "local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],60) end; return {n,redis.call('TTL',KEYS[1])}",
        { keys: [`minigame:data-rate:${this.config.appId}:${session.userId}`], arguments: [] }) as [number, number];
    } catch { throw new ServiceUnavailableException('DATA_STORAGE_UNAVAILABLE'); }
    if (rate[0] > 60) {
      request.res?.setHeader('Retry-After', String(Math.max(rate[1], 1)));
      throw new HttpException('DATA_RATE_LIMITED', 429);
    }
    if (Object.keys(request.query).length) throw new BadRequestException('INVALID_DATA_REQUEST');
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    return { userId: session.userId,
      clientInstanceId: typeof session.clientInstanceId === 'string' && CLIENT_INSTANCE_PATTERN.test(session.clientInstanceId) ? session.clientInstanceId : null,
      sessionId: typeof session.sessionId === 'string' && uuid.test(session.sessionId) ? session.sessionId : null,
      payload: request.body as unknown };
  }

  async save(request: Request) {
    const context = await this.readRequest(request);
    const input = context.payload as { version: number; data: string };
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).sort().join(',') !== 'data,version' ||
        !Number.isInteger(input.version) || input.version < 0 || input.version > 2147483646 ||
        typeof input.data !== 'string' || Buffer.from(input.data, 'utf8').toString('utf8') !== input.data || Buffer.byteLength(input.data, 'utf8') > 65536) throw new BadRequestException('INVALID_SAVE_DATA');
    try { JSON.parse(input.data); } catch { throw new BadRequestException('INVALID_SAVE_DATA'); }
    let result;
    try {
      result = input.version === 0 ?
        await this.infrastructure.pool.query<{ version: number; updated_at: Date }>(
          `WITH saved AS (INSERT INTO game_saves (user_id, data, version) VALUES ($1,$2,1) ON CONFLICT (user_id) DO NOTHING RETURNING version, updated_at), audit AS (INSERT INTO game_save_access_events(id,app_id,user_id,operation,version,client_instance_id,session_id) SELECT $3,$4,$1,'save',version,$5,$6 FROM saved) SELECT * FROM saved`,
          [context.userId, input.data, randomUUID(), this.config.appId, context.clientInstanceId, context.sessionId]) :
        await this.infrastructure.pool.query<{ version: number; updated_at: Date }>(
          `WITH saved AS (UPDATE game_saves SET data=$2,version=version+1,updated_at=now() WHERE user_id=$1 AND version=$3 RETURNING version, updated_at), audit AS (INSERT INTO game_save_access_events(id,app_id,user_id,operation,version,client_instance_id,session_id) SELECT $4,$5,$1,'save',version,$6,$7 FROM saved) SELECT * FROM saved`,
          [context.userId, input.data, input.version, randomUUID(), this.config.appId, context.clientInstanceId, context.sessionId]);
    } catch { throw new ServiceUnavailableException('DATA_STORAGE_UNAVAILABLE'); }
    const row = result.rows[0];
    if (!row) throw new ConflictException('SAVE_VERSION_CONFLICT');
    return { version: row.version, updatedAt: row.updated_at.toISOString() };
  }

  async get(request: Request) {
    const context = await this.readRequest(request);
    if (!context.payload || typeof context.payload !== 'object' || Array.isArray(context.payload) || Object.keys(context.payload).length) {
      throw new BadRequestException('INVALID_DATA_REQUEST');
    }
    let result;
    try {
      result = await this.infrastructure.pool.query<{ data: string; version: number; updated_at: Date }>(
        `WITH snapshot AS MATERIALIZED (SELECT data, version, updated_at FROM game_saves WHERE user_id=$1), audit AS (INSERT INTO game_save_access_events(id,app_id,user_id,operation,version,client_instance_id,session_id) VALUES ($2,$3,$1,'get',coalesce((SELECT version FROM snapshot),0),$4,$5)) SELECT * FROM snapshot`, [context.userId, randomUUID(), this.config.appId, context.clientInstanceId, context.sessionId]);
    } catch { throw new ServiceUnavailableException('DATA_STORAGE_UNAVAILABLE'); }
    const row = result.rows[0];
    return row ?
      { exists: true, version: row.version, data: row.data, updatedAt: row.updated_at.toISOString() } :
      { exists: false, version: 0, data: null, updatedAt: null };
  }
}
