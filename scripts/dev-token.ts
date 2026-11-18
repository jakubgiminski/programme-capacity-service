import { existsSync, readFileSync } from 'node:fs';
import { importPKCS8, SignJWT } from 'jose';
import { privateKeyPath } from './dev-keys';
import { argument, DEFAULT_AUDIENCE, DEFAULT_ISSUER, runScript } from './script-runner';

runScript(async () => {
  const keyPath = privateKeyPath();
  if (!existsSync(keyPath)) {
    throw new Error(`No dev signing key at ${keyPath}; run "pnpm keys:dev" first`);
  }
  const privateKey = await importPKCS8(readFileSync(keyPath, 'utf8'), 'RS256');
  const ttlSeconds = Number(argument('ttl') ?? '3600');
  if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0) {
    throw new Error('--ttl must be a positive number of seconds');
  }
  const token = await new SignJWT({
    scope: argument('scope') ?? 'capacity:read capacity:write',
  })
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuer(process.env.JWT_ISSUER ?? DEFAULT_ISSUER)
    .setAudience(process.env.JWT_AUDIENCE ?? DEFAULT_AUDIENCE)
    .setSubject(argument('sub') ?? 'local-developer')
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(privateKey);
  process.stdout.write(`${token}\n`);
});
