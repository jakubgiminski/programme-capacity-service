import { createLocalJWKSet, errors, type JSONWebKeySet, type JWTVerifyGetKey } from 'jose';
import { KeyServiceUnavailableError } from './principal';

export interface RemoteKeySetOptions {
  readonly timeoutMs: number;
  readonly cooldownMs: number;
  readonly maxAgeMs: number;
}

const DEFAULT_OPTIONS: RemoteKeySetOptions = {
  timeoutMs: 5_000,
  cooldownMs: 30_000,
  maxAgeMs: 600_000,
};

type LocalKeySet = ReturnType<typeof createLocalJWKSet>;

export function remoteKeySet(
  url: URL,
  options: Partial<RemoteKeySetOptions> = {},
): JWTVerifyGetKey {
  const { timeoutMs, cooldownMs, maxAgeMs } = { ...DEFAULT_OPTIONS, ...options };
  let keys: LocalKeySet | null = null;
  let fetchedAt = 0;
  let loading: Promise<LocalKeySet> | null = null;

  async function download(): Promise<LocalKeySet> {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'error',
      headers: { accept: 'application/json' },
    });
    if (response.status !== 200) {
      throw new Error(`JWKS endpoint responded with HTTP ${String(response.status)}`);
    }
    const loaded = createLocalJWKSet((await response.json()) as JSONWebKeySet);
    keys = loaded;
    fetchedAt = Date.now();
    return loaded;
  }

  function load(): Promise<LocalKeySet> {
    loading ??= download().finally(() => {
      loading = null;
    });
    return loading;
  }

  async function current(): Promise<LocalKeySet> {
    if (keys !== null && Date.now() - fetchedAt < maxAgeMs) {
      return keys;
    }
    try {
      return await load();
    } catch (error) {
      throw new KeyServiceUnavailableError(error);
    }
  }

  return async (header, token) => {
    const known = await current();
    try {
      return await known(header, token);
    } catch (error) {
      if (!(error instanceof errors.JWKSNoMatchingKey) || Date.now() - fetchedAt < cooldownMs) {
        throw error;
      }
    }
    const refreshed = await load().catch((error: unknown) => {
      throw new KeyServiceUnavailableError(error);
    });
    return refreshed(header, token);
  };
}
