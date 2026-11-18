import { join } from 'node:path';
import { Test } from '@nestjs/testing';
import { type NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from 'nestjs-pino';
import { exportSPKI, generateKeyPair, type KeyLike, SignJWT } from 'jose';
import { AppModule } from '../../src/app.module';
import { type AppConfig, loadConfig } from '../../src/config/config';
import { configureApp } from '../../src/http/configure-app';
import { type TestDatabase } from './test-database';

export const TEST_ISSUER = 'https://issuer.test';
export const TEST_AUDIENCE = 'programme-capacity-service';

export interface TokenOptions {
  scope?: string;
  subject?: string | null;
  issuer?: string;
  audience?: string;
  expiresIn?: string | number;
  key?: KeyLike;
  algorithm?: string;
}

export interface TestApp {
  app: NestExpressApplication;
  config: AppConfig;
  token(options?: TokenOptions): Promise<string>;
  close(): Promise<void>;
}

export async function createTestApp(
  database: TestDatabase,
  overrides: Record<string, string | undefined> = {},
): Promise<TestApp> {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const config = loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: database.url,
    DATABASE_POOL_MAX: '20',
    KAFKA_ENABLED: 'false',
    FX_RATES_FILE: join(__dirname, '../../config/fx-rates.json'),
    JWT_ISSUER: TEST_ISSUER,
    JWT_AUDIENCE: TEST_AUDIENCE,
    JWT_PUBLIC_KEY: await exportSPKI(publicKey),
    ...overrides,
  });
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule.register(config)],
  }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({
    bodyParser: false,
    bufferLogs: true,
  });
  app.useLogger(app.get(Logger));
  configureApp(app);
  await app.init();

  async function token(options: TokenOptions = {}): Promise<string> {
    const jwt = new SignJWT({ scope: options.scope ?? 'capacity:read capacity:write' })
      .setProtectedHeader({ alg: options.algorithm ?? 'RS256' })
      .setIssuer(options.issuer ?? TEST_ISSUER)
      .setAudience(options.audience ?? TEST_AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(options.expiresIn ?? '5m');
    if (options.subject !== null) {
      jwt.setSubject(options.subject ?? 'erp-service');
    }
    return jwt.sign(options.key ?? privateKey);
  }

  return { app, config, token, close: () => app.close() };
}
