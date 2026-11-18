import { randomUUID } from 'node:crypto';
import { createPublicKey } from 'node:crypto';
import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { exportPKCS8, generateKeyPair } from 'jose';
import { runScript } from './script-runner';

export function devKeysDir(): string {
  return process.env.DEV_KEYS_DIR ?? '.dev-keys';
}

export function privateKeyPath(directory = devKeysDir()): string {
  return join(directory, 'private.pem');
}

function temporaryPath(target: string): string {
  return `${target}.${randomUUID()}.tmp`;
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST';
}

function publishExclusively(target: string, content: string, mode: number): boolean {
  const temporary = temporaryPath(target);
  writeFileSync(temporary, content, { mode, flag: 'wx' });
  try {
    linkSync(temporary, target);
    return true;
  } catch (error) {
    if (isAlreadyExists(error)) {
      return false;
    }
    throw error;
  } finally {
    unlinkSync(temporary);
  }
}

function publishAtomically(target: string, content: string, mode: number): void {
  const temporary = temporaryPath(target);
  writeFileSync(temporary, content, { mode, flag: 'wx' });
  renameSync(temporary, target);
}

export async function ensureDevKeys(directory = devKeysDir()): Promise<boolean> {
  const privatePath = privateKeyPath(directory);
  const publicPath = join(directory, 'public.pem');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  let created = false;
  if (!existsSync(privatePath)) {
    const { privateKey } = await generateKeyPair('RS256', { extractable: true });
    created = publishExclusively(privatePath, await exportPKCS8(privateKey), 0o600);
  }
  if (created || !existsSync(publicPath)) {
    const publicKey = createPublicKey(readFileSync(privatePath, 'utf8'));
    publishAtomically(
      publicPath,
      publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      0o644,
    );
  }
  return created;
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
