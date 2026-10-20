export interface AppConfig {
  host: string;
  port: number;
  appId: string;
  appSecret: string;
  databaseUrl: string;
  redisUrl: string;
  sessionTtlSeconds: number;
  loginRateLimit: number;
  loginRateWindowSeconds: number;
  trustLocalProxy: boolean;
  subscribeMessagesEnabled?: boolean;
  subscribeMiniprogramState?: 'trial' | 'formal';
}

export const CONFIG = Symbol('AppConfig');

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const required = (name: string): string => {
    const value = env[name];
    if (!value || value.trim() !== value) throw new Error(`Invalid ${name}`);
    return value;
  };
  const integer = (name: string, fallback: number, max: number): number => {
    const value = env[name] ?? String(fallback);
    if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > max) {
      throw new Error(`Invalid ${name}`);
    }
    return Number(value);
  };
  const url = (name: string, protocols: string[]): string => {
    const value = required(name);
    try {
      if (!protocols.includes(new URL(value).protocol)) throw new Error();
    } catch {
      throw new Error(`Invalid ${name}`);
    }
    return value;
  };
  const appId = required('WECHAT_APP_ID');
  if (!/^wx[a-f0-9]{16}$/.test(appId)) throw new Error('Invalid WECHAT_APP_ID');
  const proxy = env.TRUST_LOCAL_PROXY ?? 'false';
  if (!['true', 'false'].includes(proxy)) throw new Error('Invalid TRUST_LOCAL_PROXY');
  const subscriptions = env.SUBSCRIBE_MESSAGES_ENABLED ?? 'false';
  if (!['true','false'].includes(subscriptions)) throw new Error('Invalid SUBSCRIBE_MESSAGES_ENABLED');
  const miniprogramState = env.SUBSCRIBE_MINIPROGRAM_STATE ?? 'trial';
  if (miniprogramState !== 'trial' && miniprogramState !== 'formal') throw new Error('Invalid SUBSCRIBE_MINIPROGRAM_STATE');
  const host = env.HOST ?? '127.0.0.1';
  if (!['127.0.0.1', '::1', '0.0.0.0'].includes(host)) throw new Error('Invalid HOST');
  if (proxy === 'true' && host !== '127.0.0.1' && host !== '::1') {
    throw new Error('TRUST_LOCAL_PROXY requires a loopback HOST');
  }
  return {
    host,
    port: integer('PORT', 18740, 65535),
    appId,
    appSecret: required('WECHAT_APP_SECRET'),
    databaseUrl: url('DATABASE_URL', ['postgres:', 'postgresql:']),
    redisUrl: url('REDIS_URL', ['redis:', 'rediss:']),
    sessionTtlSeconds: integer('SESSION_TTL_SECONDS', 604800, 2592000),
    loginRateLimit: integer('LOGIN_RATE_LIMIT', 120, 10000),
    loginRateWindowSeconds: integer('LOGIN_RATE_WINDOW_SECONDS', 60, 3600),
    trustLocalProxy: proxy === 'true',
    subscribeMessagesEnabled: subscriptions === 'true',
    subscribeMiniprogramState: miniprogramState,
  };
}
