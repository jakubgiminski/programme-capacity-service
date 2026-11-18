import { createServer, type Server } from 'node:http';
import { type AddressInfo } from 'node:net';
import { exportJWK, generateKeyPair, type KeyLike, SignJWT } from 'jose';
import { AuthenticationError, KeyServiceUnavailableError } from './principal';
import { remoteKeySet, TokenVerifier } from './token-verifier';

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
  let server: Server;
  let url: URL;

  beforeAll(async () => {
    const pair = await generateKeyPair('RS256');
    privateKey = pair.privateKey;
    const jwk = { ...(await exportJWK(pair.publicKey)), kid: 'key-1', alg: 'RS256', use: 'sig' };
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
});
