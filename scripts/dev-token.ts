import { existsSync, readFileSync } from 'node:fs';
import { importPKCS8, SignJWT } from 'jose';
import { privateKeyPath } from './dev-keys';
import { argument, DEFAULT_AUDIENCE, DEFAULT_ISSUER, runScript } from './script-runner';

export interface DevTokenOptions {
  readonly scope: string;
  readonly subject: string;
  readonly ttlSeconds: number;
}

export async function signDevToken(options: DevTokenOptions): Promise<string> {
  const keyPath = privateKeyPath();
  if (!existsSync(keyPath)) {
    throw new Error(`No dev signing key at ${keyPath}; run "pnpm keys:dev" first`);
  }
  const privateKey = await importPKCS8(readFileSync(keyPath, 'utf8'), 'RS256');
  return new SignJWT({ scope: options.scope })
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuer(process.env.JWT_ISSUER ?? DEFAULT_ISSUER)
    .setAudience(process.env.JWT_AUDIENCE ?? DEFAULT_AUDIENCE)
    .setSubject(options.subject)
    .setIssuedAt()
    .setExpirationTime(`${options.ttlSeconds}s`)
    .sign(privateKey);
}

if (require.main === module) {
  runScript(async () => {
    const ttlSeconds = Number(argument('ttl') ?? '3600');
    if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0) {
      throw new Error('--ttl must be a positive number of seconds');
    }
    const token = await signDevToken({
      scope: argument('scope') ?? 'capacity:read capacity:write',
      subject: argument('sub') ?? 'local-developer',
      ttlSeconds,
    });
    process.stdout.write(`${token}\n`);
  });
}
