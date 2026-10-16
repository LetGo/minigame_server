import { Logger } from '@nestjs/common';
import { createApplication } from './application.js';
import { loadConfig } from './config.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const app = await createApplication(config);
  app.enableShutdownHooks();
  try {
    await app.listen(config.port, config.host);
  } catch {
    await app.close();
    throw new Error('Unable to bind login API');
  }
  new Logger('Bootstrap').log(`Login API listening on ${config.host}:${config.port}/h5login/api/auth/wechat-login`);
}

void main().catch(() => {
  // Do not print config, upstream errors, request bodies, or connection URLs.
  new Logger('Bootstrap').error('Startup failed; check environment, migrations and dependencies');
  process.exitCode = 1;
});
