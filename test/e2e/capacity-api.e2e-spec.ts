import { generateKeyPair } from 'jose';
import request from 'supertest';
import { type App } from 'supertest/types';
import { createProgram, EUR, USD } from '../support/capacity-fixture';
import { createTestApp, type TestApp } from '../support/test-app';
import { createTestDatabase, type TestDatabase } from '../support/test-database';

describe('Capacity HTTP API (e2e)', () => {
  let database: TestDatabase;
  let testApp: TestApp;
  let server: App;
  let writeToken: string;
  let sequence = 0;

  async function newProgram(limit = 1_000_000n, currency = USD): Promise<string> {
    sequence += 1;
    const id = `PRG-E-${sequence}`;
    await createProgram(database.db, id, currency, limit);
    return id;
  }

  beforeAll(async () => {
    database = await createTestDatabase();
    testApp = await createTestApp(database);
    server = testApp.app.getHttpServer();
    writeToken = await testApp.token();
  });

  afterAll(async () => {
    await testApp.close();
    await database.destroy();
  });

  describe('authentication and authorisation', () => {
    it('rejects requests without a token with a problem document', async () => {
      const response = await request(server).get('/v1/programs/PRG-1/capacity');

      expect(response.status).toBe(401);
      expect(response.headers['content-type']).toMatch(/^application\/problem\+json/);
      expect(response.headers['www-authenticate']).toBe('Bearer error="invalid_token"');
      expect(response.body).toMatchObject({
        type: '/problems/unauthenticated',
        title: 'Unauthorized',
        status: 401,
        instance: '/v1/programs/PRG-1/capacity',
      });
      expect(typeof response.body.correlationId).toBe('string');
    });

    it.each([
      ['a malformed header', () => Promise.resolve('Basic abc')],
      ['a garbage token', () => Promise.resolve('Bearer not-a-jwt')],
      [
        'an expired token',
        async () =>
          `Bearer ${await testApp.token({ expiresIn: Math.floor(Date.now() / 1000) - 60 })}`,
      ],
      ['a wrong issuer', async () => `Bearer ${await testApp.token({ issuer: 'https://evil' })}`],
      ['a wrong audience', async () => `Bearer ${await testApp.token({ audience: 'other' })}`],
      ['a token without subject', async () => `Bearer ${await testApp.token({ subject: null })}`],
      [
        'a token signed by another key',
        async () =>
          `Bearer ${await testApp.token({ key: (await generateKeyPair('RS256')).privateKey })}`,
      ],
      [
        'a token using another algorithm',
        async () =>
          `Bearer ${await testApp.token({
            algorithm: 'ES256',
            key: (await generateKeyPair('ES256')).privateKey,
          })}`,
      ],
    ])('rejects %s', async (_label, header) => {
      const authorization = await header();

      const response = await request(server)
        .get('/v1/programs/PRG-1/capacity')
        .set('Authorization', authorization);

      expect(response.status).toBe(401);
    });

    it('requires the write scope for mutations', async () => {
      const readOnly = await testApp.token({ scope: 'capacity:read' });

      const response = await request(server)
        .post('/v1/programs/PRG-1/reservations')
        .set('Authorization', `Bearer ${readOnly}`)
        .send({ invoiceId: 'INV-1', amount: { amount: '100', currency: 'USD' } });

      expect(response.status).toBe(403);
      expect(response.body).toMatchObject({ type: '/problems/forbidden', status: 403 });
    });

    it('requires the read scope for queries', async () => {
      const writeOnly = await testApp.token({ scope: 'capacity:write' });

      const response = await request(server)
        .get('/v1/programs/PRG-1/capacity')
        .set('Authorization', `Bearer ${writeOnly}`);

      expect(response.status).toBe(403);
    });

    it('protects the health endpoint and reports database status', async () => {
      expect((await request(server).get('/health')).status).toBe(401);

      const response = await request(server)
        .get('/health')
        .set('Authorization', `Bearer ${writeToken}`);

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ status: 'ok', checks: { database: 'up' } });
    });

    it('returns a problem document for unknown routes', async () => {
      const response = await request(server)
        .get('/v1/unknown')
        .set('Authorization', `Bearer ${writeToken}`);

      expect(response.status).toBe(404);
      expect(response.headers['content-type']).toMatch(/^application\/problem\+json/);
    });
  });

  describe('reservations', () => {
    it('reserves capacity, replays idempotently and exposes availability', async () => {
      const programId = await newProgram();
      const body = { invoiceId: 'INV-1', amount: { amount: '100001', currency: 'EUR' } };

      const created = await request(server)
        .post(`/v1/programs/${programId}/reservations`)
        .set('Authorization', `Bearer ${writeToken}`)
        .set('X-Correlation-Id', 'corr-e2e-1')
        .send(body);
      const replay = await request(server)
        .post(`/v1/programs/${programId}/reservations`)
        .set('Authorization', `Bearer ${writeToken}`)
        .send(body);
      const capacity = await request(server)
        .get(`/v1/programs/${programId}/capacity`)
        .set('Authorization', `Bearer ${writeToken}`);

      expect(created.status).toBe(201);
      expect(created.headers['x-correlation-id']).toBe('corr-e2e-1');
      expect(created.body).toMatchObject({
        programId,
        invoiceId: 'INV-1',
        status: 'ACTIVE',
        origin: 'API',
        invoiceAmount: { amount: '100001', currency: 'EUR' },
        booked: { amount: '108502', currency: 'USD' },
        released: { amount: '0', currency: 'USD' },
        outstanding: { amount: '108502', currency: 'USD' },
        fx: { rate: '1.085', source: 'static-seed', asOf: '2026-11-02T00:00:00.000Z' },
      });
      expect(replay.status).toBe(200);
      expect(replay.body).toEqual(created.body);
      expect(capacity.status).toBe(200);
      expect(capacity.body).toEqual({
        programId,
        currency: 'USD',
        limit: { amount: '1000000', currency: 'USD' },
        utilised: { amount: '108502', currency: 'USD' },
        available: { amount: '891498', currency: 'USD' },
        overUtilised: false,
        version: '1',
        updatedAt: expect.any(String),
      });
      const ledger = await database.db
        .selectFrom('ledger_entries')
        .select(['actor', 'correlation_id'])
        .where('program_id', '=', programId)
        .executeTakeFirstOrThrow();
      expect(ledger).toEqual({ actor: 'erp-service', correlation_id: 'corr-e2e-1' });
    });

    it('returns 409 for a conflicting invoice and for insufficient capacity', async () => {
      const programId = await newProgram(1_000n);
      await request(server)
        .post(`/v1/programs/${programId}/reservations`)
        .set('Authorization', `Bearer ${writeToken}`)
        .send({ invoiceId: 'INV-1', amount: { amount: '600', currency: 'USD' } })
        .expect(201);

      const conflict = await request(server)
        .post(`/v1/programs/${programId}/reservations`)
        .set('Authorization', `Bearer ${writeToken}`)
        .send({ invoiceId: 'INV-1', amount: { amount: '601', currency: 'USD' } });
      const insufficient = await request(server)
        .post(`/v1/programs/${programId}/reservations`)
        .set('Authorization', `Bearer ${writeToken}`)
        .send({ invoiceId: 'INV-2', amount: { amount: '401', currency: 'USD' } });

      expect(conflict.status).toBe(409);
      expect(conflict.body.type).toBe('/problems/invoice-conflict');
      expect(insufficient.status).toBe(409);
      expect(insufficient.body).toMatchObject({
        type: '/problems/insufficient-capacity',
        requested: { amount: '401', currency: 'USD' },
        available: { amount: '400', currency: 'USD' },
      });
    });

    it('returns 422 when no FX rate exists and 404 for unknown programmes', async () => {
      const programId = await newProgram(1_000_000n, EUR);

      const noRate = await request(server)
        .post(`/v1/programs/${programId}/reservations`)
        .set('Authorization', `Bearer ${writeToken}`)
        .send({ invoiceId: 'INV-1', amount: { amount: '100', currency: 'CHF' } });
      const unknown = await request(server)
        .get('/v1/programs/PRG-NOPE/capacity')
        .set('Authorization', `Bearer ${writeToken}`);

      expect(noRate.status).toBe(422);
      expect(noRate.body.type).toBe('/problems/fx-rate-unavailable');
      expect(unknown.status).toBe(404);
      expect(unknown.body.type).toBe('/problems/program-not-found');
    });

    it.each([
      [{ invoiceId: 'INV-1', amount: { amount: 100, currency: 'USD' } }, 'amount.amount'],
      [{ invoiceId: 'INV-1', amount: { amount: '1.5', currency: 'USD' } }, 'amount.amount'],
      [{ invoiceId: 'INV-1', amount: { amount: '0', currency: 'USD' } }, 'amount.amount'],
      [{ invoiceId: 'INV-1', amount: { amount: '-5', currency: 'USD' } }, 'amount.amount'],
      [
        { invoiceId: 'INV-1', amount: { amount: '9223372036854775808', currency: 'USD' } },
        'amount.amount',
      ],
      [{ invoiceId: 'INV-1', amount: { amount: '100', currency: 'XYZ' } }, 'amount.currency'],
      [{ invoiceId: 'INV 1', amount: { amount: '100', currency: 'USD' } }, 'invoiceId'],
      [{ amount: { amount: '100', currency: 'USD' } }, 'invoiceId'],
      [{ invoiceId: 'INV-1', amount: { amount: '100', currency: 'USD' }, extra: 1 }, ''],
    ])('rejects invalid body %j with a 400 problem', async (body, path) => {
      const response = await request(server)
        .post('/v1/programs/PRG-1/reservations')
        .set('Authorization', `Bearer ${writeToken}`)
        .send(body);

      expect(response.status).toBe(400);
      expect(response.headers['content-type']).toMatch(/^application\/problem\+json/);
      expect(response.body.type).toBe('/problems/validation-failed');
      expect(response.body.errors).toEqual(
        expect.arrayContaining([expect.objectContaining({ path })]),
      );
    });

    it('rejects malformed JSON and invalid path parameters with 400', async () => {
      const malformed = await request(server)
        .post('/v1/programs/PRG-1/reservations')
        .set('Authorization', `Bearer ${writeToken}`)
        .set('Content-Type', 'application/json')
        .send('{"invoiceId":');
      const badId = await request(server)
        .get(`/v1/programs/${'x'.repeat(65)}/capacity`)
        .set('Authorization', `Bearer ${writeToken}`);

      expect(malformed.status).toBe(400);
      expect(malformed.body.type).toBe('/problems/malformed-request');
      expect(badId.status).toBe(400);
    });
  });

  describe('releases', () => {
    async function reserved(): Promise<string> {
      const programId = await newProgram();
      await request(server)
        .post(`/v1/programs/${programId}/reservations`)
        .set('Authorization', `Bearer ${writeToken}`)
        .send({ invoiceId: 'INV-1', amount: { amount: '300', currency: 'USD' } })
        .expect(201);
      return programId;
    }

    it('releases partially, replays, then fully releases', async () => {
      const programId = await reserved();
      const path = `/v1/programs/${programId}/reservations/INV-1/releases`;

      const partial = await request(server)
        .post(path)
        .set('Authorization', `Bearer ${writeToken}`)
        .send({ releaseId: 'REL-1', amount: { amount: '100', currency: 'USD' } });
      const replay = await request(server)
        .post(path)
        .set('Authorization', `Bearer ${writeToken}`)
        .send({ releaseId: 'REL-1', amount: { amount: '100', currency: 'USD' } });
      const full = await request(server)
        .post(path)
        .set('Authorization', `Bearer ${writeToken}`)
        .send({ releaseId: 'REL-2' });
      const details = await request(server)
        .get(`/v1/programs/${programId}/reservations/INV-1`)
        .set('Authorization', `Bearer ${writeToken}`);

      expect(partial.status).toBe(201);
      expect(partial.body).toMatchObject({
        releaseId: 'REL-1',
        origin: 'API',
        invoiceAmount: { amount: '100', currency: 'USD' },
        freed: { amount: '100', currency: 'USD' },
        reservation: { status: 'PARTIALLY_RELEASED', outstanding: { amount: '200' } },
      });
      expect(replay.status).toBe(200);
      expect(full.status).toBe(201);
      expect(full.body.freed).toEqual({ amount: '200', currency: 'USD' });
      expect(details.body).toMatchObject({
        status: 'RELEASED',
        released: { amount: '300', currency: 'USD' },
        releases: [{ releaseId: 'REL-1' }, { releaseId: 'REL-2' }],
      });
    });

    it('maps release failures to 409 and 422', async () => {
      const programId = await reserved();
      const path = `/v1/programs/${programId}/reservations/INV-1/releases`;
      const send = (body: object) =>
        request(server).post(path).set('Authorization', `Bearer ${writeToken}`).send(body);

      const over = await send({ releaseId: 'REL-1', amount: { amount: '301', currency: 'USD' } });
      const currency = await send({
        releaseId: 'REL-1',
        amount: { amount: '1', currency: 'EUR' },
      });
      await send({ releaseId: 'REL-1' }).expect(201);
      const reused = await send({ releaseId: 'REL-1', amount: { amount: '1', currency: 'USD' } });
      const again = await send({ releaseId: 'REL-2' });
      const missing = await request(server)
        .post(`/v1/programs/${programId}/reservations/INV-404/releases`)
        .set('Authorization', `Bearer ${writeToken}`)
        .send({ releaseId: 'REL-1' });

      expect(over.status).toBe(422);
      expect(over.body).toMatchObject({
        type: '/problems/over-release',
        requestedAmount: '301',
        outstandingAmount: '300',
      });
      expect(currency.status).toBe(422);
      expect(reused.status).toBe(409);
      expect(reused.body.type).toBe('/problems/release-conflict');
      expect(again.status).toBe(409);
      expect(again.body.type).toBe('/problems/reservation-already-released');
      expect(missing.status).toBe(404);
      expect(missing.body.type).toBe('/problems/reservation-not-found');
    });
  });
});
