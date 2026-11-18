import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { exportPKCS8, exportSPKI, generateKeyPair } from 'jose';
import { runScript } from './script-runner';

export function devKeysDir(): string {
  return process.env.DEV_KEYS_DIR ?? '.dev-keys';
}

export async function ensureDevKeys(directory = devKeysDir()): Promise<boolean> {
  const privatePath = join(directory, 'private.pem');
  const publicPath = join(directory, 'public.pem');
  if (existsSync(privatePath) && existsSync(publicPath)) {
    return false;
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
  writeFileSync(privatePath, await exportPKCS8(privateKey), { mode: 0o600 });
  writeFileSync(publicPath, await exportSPKI(publicKey), { mode: 0o644 });
  return true;
}

if (require.main === module) {
  runScript(async () => {
    const created = await ensureDevKeys();
    process.stdout.write(
      created
        ? `Generated a dev RS256 key pair in ${devKeysDir()}\n`
        : `Dev keys already present in ${devKeysDir()}\n`,
    );
  });
}
