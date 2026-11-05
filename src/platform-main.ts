import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadPlatformConfig } from './platform-config.js';
import { createPlatform } from './platform.js';

export async function main(): Promise<void> {
  const platform = await createPlatform(loadPlatformConfig());
  try {
    await platform.listen();
    process.stdout.write('MINIGAME_PLATFORM_READY\n');
  } catch {
    await platform.close().catch(() => {});
    throw new Error('Platform startup failed');
  }
}

function isEntrypoint(): boolean {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url));
  } catch { return false; }
}

if (isEntrypoint()) {
  void main().catch(() => {
    process.stderr.write('MINIGAME_PLATFORM_STARTUP_FAILED\n');
    process.exitCode = 1;
  });
}
