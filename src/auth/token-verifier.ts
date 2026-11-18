import { readFileSync } from 'node:fs';
import { errors, importSPKI, type JWTPayload, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { type AppConfig } from '../config/config';
import { AuthenticationError, KeyServiceUnavailableError, type Principal } from './principal';
import { remoteKeySet } from './remote-key-set';

export const TOKEN_VERIFIER = Symbol('TOKEN_VERIFIER');

const ALGORITHM = 'RS256';

export class TokenVerifier {
  constructor(
    private readonly key: JWTVerifyGetKey,
    private readonly issuer: string,
    private readonly audience: string,
  ) {}

  static async fromConfig(config: AppConfig): Promise<TokenVerifier> {
    return new TokenVerifier(await resolveKey(config), config.JWT_ISSUER, config.JWT_AUDIENCE);
  }

  async verify(token: string): Promise<Principal> {
    const payload = await this.verifyPayload(token);
    if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
      throw new AuthenticationError('Token has no subject');
    }
    return { subject: payload.sub, scopes: parseScopes(payload) };
  }

  private async verifyPayload(token: string): Promise<JWTPayload> {
    try {
      const { payload } = await jwtVerify(token, this.key, {
        issuer: this.issuer,
        audience: this.audience,
        algorithms: [ALGORITHM],
        requiredClaims: ['exp', 'sub'],
        clockTolerance: 5,
      });
      return payload;
    } catch (error) {
      if (error instanceof KeyServiceUnavailableError) {
        throw error;
      }
      if (error instanceof errors.JOSEError) {
        throw new AuthenticationError(`Invalid token: ${error.code}`);
      }
      throw error;
    }
  }
}

function parseScopes(payload: JWTPayload): ReadonlySet<string> {
  const scope = payload.scope;
  if (typeof scope !== 'string') {
    return new Set();
  }
  return new Set(scope.split(' ').filter((item) => item.length > 0));
}

async function resolveKey(config: AppConfig): Promise<JWTVerifyGetKey> {
  if (config.JWT_JWKS_URL !== undefined) {
    return remoteKeySet(new URL(config.JWT_JWKS_URL));
  }
  if (config.JWT_PUBLIC_KEY_FILE !== undefined) {
    const key = await importSPKI(readFileSync(config.JWT_PUBLIC_KEY_FILE, 'utf8'), ALGORITHM);
    return () => key;
  }
  if (config.JWT_PUBLIC_KEY !== undefined) {
    const key = await importSPKI(config.JWT_PUBLIC_KEY.replaceAll('\\n', '\n'), ALGORITHM);
    return () => key;
  }
  throw new Error('No JWT verification key configured');
}
