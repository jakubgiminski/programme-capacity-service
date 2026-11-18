import { createServer, type Server } from 'node:http';
import { type AddressInfo } from 'node:net';
import { exportJWK, generateKeyPair, type KeyLike, SignJWT } from 'jose';
import { AuthenticationError, KeyServiceUnavailableError } from './principal';
import { remoteKeySet } from './remote-key-set';
import { TokenVerifier } from './token-verifier';

const ISSUER = 'https://issuer.test';
const AUDIENCE = 'programme-capacity-service';

function sign(key: KeyLike, kid: string): Promise<string> {
  return new SignJWT({ scope: 'capacity:read' })
    .setProtectedHeader({ alg: 'RS256', kid })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setSubject('erp-service')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(key);
}

function listen(server: Server): Promise<URL> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve(new URL(`http://127.0.0.1:${String(port)}/jwks.json`));
    });
  });
}

describe('TokenVerifier with a remote JWKS', () => {
  let privateKey: KeyLike;
  let jwk: Record<string, unknown>;
  let server: Server;
  let url: URL;

  beforeAll(async () => {
    const pair = await generateKeyPair('RS256');
    privateKey = pair.privateKey;
    jwk = { ...(await exportJWK(pair.publicKey)), kid: 'key-1', alg: 'RS256', use: 'sig' };
    server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ keys: [jwk] }));
    });
    url = await listen(server);
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it('verifies tokens signed by a key from the key set', async () => {
    const verifier = new TokenVerifier(remoteKeySet(url), ISSUER, AUDIENCE);

    const principal = await verifier.verify(await sign(privateKey, 'key-1'));

    expect(principal.subject).toBe('erp-service');
    expect([...principal.scopes]).toEqual(['capacity:read']);
  });

  it('rejects tokens whose key is not in the key set as unauthenticated', async () => {
    const verifier = new TokenVerifier(remoteKeySet(url), ISSUER, AUDIENCE);

    await expect(verifier.verify(await sign(privateKey, 'unknown'))).rejects.toBeInstanceOf(
      AuthenticationError,
    );
  });

  it('reports an unreachable key set as unavailable rather than unauthenticated', async () => {
    const closed = createServer();
    const unreachable = await listen(closed);
    await new Promise((resolve) => closed.close(resolve));
    const verifier = new TokenVerifier(remoteKeySet(unreachable), ISSUER, AUDIENCE);

    await expect(verifier.verify(await sign(privateKey, 'key-1'))).rejects.toBeInstanceOf(
      KeyServiceUnavailableError,
    );
  });

  it('times out a key set whose response body stalls', async () => {
    const stalled = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.write('{"keys":');
    });
    const stalledUrl = await listen(stalled);
    const verifier = new TokenVerifier(
      remoteKeySet(stalledUrl, { timeoutMs: 200 }),
      ISSUER,
      AUDIENCE,
    );
    const started = Date.now();
    try {
      await expect(verifier.verify(await sign(privateKey, 'key-1'))).rejects.toBeInstanceOf(
        KeyServiceUnavailableError,
      );
      expect(Date.now() - started).toBeLessThan(2_000);
    } finally {
      stalled.closeAllConnections();
      await new Promise((resolve) => stalled.close(resolve));
    }
  });

  it('recovers on the same verifier once a stalled key set endpoint answers again', async () => {
    let stall = true;
    const flaky = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      if (stall) {
        response.write('{"keys":');
        return;
      }
      response.end(JSON.stringify({ keys: [jwk] }));
    });
    const flakyUrl = await listen(flaky);
    const verifier = new TokenVerifier(
      remoteKeySet(flakyUrl, { timeoutMs: 200 }),
      ISSUER,
      AUDIENCE,
    );
    const token = await sign(privateKey, 'key-1');
    try {
      await expect(verifier.verify(token)).rejects.toBeInstanceOf(KeyServiceUnavailableError);
      stall = false;

      await expect(verifier.verify(token)).resolves.toMatchObject({ subject: 'erp-service' });
    } finally {
      flaky.closeAllConnections();
      await new Promise((resolve) => flaky.close(resolve));
    }
  });

  it('refetches the key set for an unknown key after the cooldown to pick up rotations', async () => {
    const rotated = await generateKeyPair('RS256');
    const rotatedJwk = {
      ...(await exportJWK(rotated.publicKey)),
      kid: 'key-2',
      alg: 'RS256',
      use: 'sig',
    };
    let published = [jwk];
    let requests = 0;
    const rotating = createServer((_request, response) => {
      requests += 1;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ keys: published }));
    });
    const rotatingUrl = await listen(rotating);
    const verifier = new TokenVerifier(
      remoteKeySet(rotatingUrl, { cooldownMs: 0 }),
      ISSUER,
      AUDIENCE,
    );
    try {
      await verifier.verify(await sign(privateKey, 'key-1'));
      published = [jwk, rotatedJwk];

      await expect(verifier.verify(await sign(rotated.privateKey, 'key-2'))).resolves.toMatchObject(
        { subject: 'erp-service' },
      );
      await verifier.verify(await sign(privateKey, 'key-1'));
      expect(requests).toBe(2);
    } finally {
      await new Promise((resolve) => rotating.close(resolve));
    }
  });

  it('reports a key set endpoint that answers with an error status as unavailable', async () => {
    const failing = createServer((_request, response) => {
      response.writeHead(503);
      response.end();
    });
    const failingUrl = await listen(failing);
    const verifier = new TokenVerifier(remoteKeySet(failingUrl), ISSUER, AUDIENCE);
    try {
      await expect(verifier.verify(await sign(privateKey, 'key-1'))).rejects.toBeInstanceOf(
        KeyServiceUnavailableError,
      );
    } finally {
      await new Promise((resolve) => failing.close(resolve));
    }
  });
});
