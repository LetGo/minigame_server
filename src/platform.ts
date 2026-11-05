import { createServer, type ServerResponse } from 'node:http';
import { Logger, type LoggerService } from '@nestjs/common';
import { createApplication } from './application.js';
import type { WechatClient } from './auth/wechat.client.js';
import { Infrastructure } from './infrastructure.js';
import { PLATFORM_APP_ID, type PlatformConfig } from './platform-config.js';

// Deliberate public contract: never map readiness, legacy aliases or arbitrary
// Express paths into an application's internal namespace.
const PUBLIC_ROUTES = new Set([
  'auth/wechat-login', 'data/save', 'data/get', 'users/profile', 'users/source-scene',
  'invites/report', 'invites/list', 'invites/claim', 'analytics/rewarded-video/completed',
  'leaderboards/report', 'leaderboards/list', 'share-assists/report', 'share-assists/summary',
  'subscriptions/checkin/template', 'subscriptions/checkin/report',
]);
function reply(res: ServerResponse, statusCode: number, message: string): void {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Connection': 'close' });
  res.end(JSON.stringify({ statusCode, message }));
}

// Nest's default lifecycle logger serializes raw rejected Error values. A
// platform process never forwards arguments from framework/dependency logs.
const SAFE_LOGGER: LoggerService = {
  log() {}, warn() { process.stderr.write('MINIGAME_PLATFORM_WARNING\n'); },
  error() { process.stderr.write('MINIGAME_PLATFORM_ERROR\n'); },
};

export async function createPlatform(config: PlatformConfig, overrides: { wechat?: Record<string, WechatClient> } = {}) {
  Logger.overrideLogger(SAFE_LOGGER);
  const apps = new Map<string, Awaited<ReturnType<typeof createApplication>>>();
  let closed = false;
  let closePromise: Promise<void> | undefined;
  let listenPromise: Promise<void> | undefined;
  const server = createServer({ requestTimeout: 15000, headersTimeout: 10000, keepAliveTimeout: 5000, maxHeaderSize: 16384 }, (req, res) => {
    if (closed) { reply(res, 503, 'PLATFORM_UNAVAILABLE'); return; }
    if (req.method === 'GET' && req.url === '/internal/ready') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end('{"ready":true}'); return;
    }
    const url = req.url ?? '';
    const path = url.split('?', 1)[0]!;
    if (path !== '/minigame/api' && !path.startsWith('/minigame/api/')) { reply(res, 404, 'NOT_FOUND'); return; }
    const values: string[] = [];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      if (req.rawHeaders[i]!.toLowerCase() === 'x-minigame-appid') values.push(req.rawHeaders[i + 1]!);
    }
    if (!values.length) { reply(res, 400, 'APP_ID_REQUIRED'); return; }
    if (values.length !== 1 || !PLATFORM_APP_ID.test(values[0]!)) { reply(res, 400, 'APP_ID_INVALID'); return; }
    const app = apps.get(values[0]!);
    if (!app) { reply(res, 404, 'APP_NOT_REGISTERED'); return; }
    const route = path.slice('/minigame/api/'.length);
    if (req.method !== 'POST' || !PUBLIC_ROUTES.has(route)
      || (route.startsWith('subscriptions/') && !config.games.find(game => game.appId === values[0])?.subscribeMessagesEnabled)) {
      reply(res, 404, 'NOT_FOUND'); return;
    }
    req.url = '/h5login/api' + url.slice('/minigame/api'.length);
    app.getHttpAdapter().getInstance()(req, res);
  });
  // Node otherwise truncates rawHeaders after its default count, which could
  // hide a duplicate selector beyond that boundary. Byte limits still apply.
  server.maxHeadersCount = 0;
  server.setTimeout(30000, socket => socket.destroy());
  server.on('clientError', (_error, socket) => {
    if (!socket.writable) { socket.destroy(); return; }
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  });
  let initialized = false;
  let stopping = false;
  const onSignal = () => {
    stopping = true;
    if (initialized) void close().catch(() => { process.exitCode = 1; });
  };
  async function close(): Promise<void> {
    if (closePromise) return closePromise;
    closed = true;
    process.removeListener('SIGTERM', onSignal);
    process.removeListener('SIGINT', onSignal);
    closePromise = (async () => {
      let failed = false;
      if (listenPromise) await listenPromise.catch(() => {});
      if (server.listening) {
        await new Promise<void>(resolve => {
          const timer = setTimeout(() => server.closeAllConnections(), 5000);
          timer.unref();
          server.close(() => { clearTimeout(timer); resolve(); });
          server.closeIdleConnections();
        });
      }
      // Never skip later apps if a lifecycle hook rejects. Explicit fallback also
      // covers an init() failure before Nest registers shutdown hooks.
      for (const app of [...apps.values()].reverse()) {
        try { await app.close(); } catch { failed = true; }
        try { await app.get(Infrastructure).onApplicationShutdown(); } catch { failed = true; }
      }
      apps.clear();
      if (failed) throw new Error('Platform shutdown failed');
    })();
    return closePromise;
  }
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);
  try {
    if (config.host !== '127.0.0.1' || !Number.isInteger(config.port) || config.port < 0 || config.port > 65535
      || !Array.isArray(config.games) || !config.games.length || config.games.length > 32) throw new Error();
    for (const game of config.games) {
      if (!PLATFORM_APP_ID.test(game.appId) || apps.has(game.appId) || stopping) throw new Error();
      const app = await createApplication({ ...game, host: '127.0.0.1', trustLocalProxy: true }, { wechat: overrides.wechat?.[game.appId] });
      apps.set(game.appId, app);
      await app.init();
      if (stopping) throw new Error();
    }
    initialized = true;
  } catch {
    await close().catch(() => {});
    throw new Error('Platform startup failed');
  }
  return {
    server, address: () => server.address(), close,
    listen: async (): Promise<void> => {
      if (closed) throw new Error('Platform is closed');
      if (server.listening) return;
      if (!listenPromise) {
        listenPromise = new Promise<void>((resolve, reject) => {
          const onError = () => { server.removeListener('listening', onListening); reject(new Error('Platform listen failed')); };
          const onListening = () => { server.removeListener('error', onError); resolve(); };
          server.once('error', onError);
          server.once('listening', onListening);
          server.listen(config.port, '127.0.0.1');
        });
      }
      try { await listenPromise; }
      catch { await close().catch(() => {}); throw new Error('Platform listen failed'); }
    },
  };
}
