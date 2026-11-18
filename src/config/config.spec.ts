import { ConfigValidationError, loadConfig } from './config';

const baseEnv = {
  DATABASE_URL: 'postgres://app:app@localhost:5432/app',
  JWT_ISSUER: 'https://issuer.test',
  JWT_AUDIENCE: 'programme-capacity-service',
  JWT_PUBLIC_KEY_FILE: '.dev-keys/public.pem',
};

describe('loadConfig', () => {
  it('applies defaults for optional settings', () => {
    const config = loadConfig(baseEnv);

    expect(config.PORT).toBe(3000);
    expect(config.LOG_LEVEL).toBe('info');
    expect(config.KAFKA_ENABLED).toBe(true);
    expect(config.KAFKA_BROKERS).toEqual(['localhost:19092']);
  });

  it('parses comma separated brokers and boolean flags', () => {
    const config = loadConfig({
      ...baseEnv,
      KAFKA_BROKERS: 'a:9092, b:9092,',
      KAFKA_ENABLED: 'false',
      PORT: '8080',
    });

    expect(config.KAFKA_BROKERS).toEqual(['a:9092', 'b:9092']);
    expect(config.KAFKA_ENABLED).toBe(false);
    expect(config.PORT).toBe(8080);
  });

  it('accepts TLS and a complete SASL configuration', () => {
    const config = loadConfig({
      ...baseEnv,
      KAFKA_SSL: 'true',
      KAFKA_SASL_MECHANISM: 'scram-sha-512',
      KAFKA_SASL_USERNAME: 'capacity',
      KAFKA_SASL_PASSWORD: 'secret',
      KAFKA_CREATE_TOPICS: 'false',
    });

    expect(config).toMatchObject({
      KAFKA_SSL: true,
      KAFKA_SASL_MECHANISM: 'scram-sha-512',
      KAFKA_CREATE_TOPICS: false,
    });
  });

  it('rejects a partial SASL configuration', () => {
    expect(() => loadConfig({ ...baseEnv, KAFKA_SASL_MECHANISM: 'plain' })).toThrow(
      /KAFKA_SASL_MECHANISM/,
    );
  });

  it('rejects a dead-letter topic equal to the source topic', () => {
    expect(() =>
      loadConfig({ ...baseEnv, KAFKA_TOPIC: 'treasury', KAFKA_DLQ_TOPIC: 'treasury' }),
    ).toThrow(/KAFKA_DLQ_TOPIC must differ/);
  });

  it('rejects a missing database url', () => {
    expect(() => loadConfig({ ...baseEnv, DATABASE_URL: undefined })).toThrow(
      ConfigValidationError,
    );
  });

  it('rejects a non-postgres database url', () => {
    expect(() => loadConfig({ ...baseEnv, DATABASE_URL: 'mysql://localhost/app' })).toThrow(
      /DATABASE_URL/,
    );
  });

  it('rejects invalid boolean flags and ports', () => {
    expect(() => loadConfig({ ...baseEnv, KAFKA_ENABLED: 'yes' })).toThrow(/KAFKA_ENABLED/);
    expect(() => loadConfig({ ...baseEnv, PORT: '70000' })).toThrow(/PORT/);
  });

  it('requires exactly one JWT key source', () => {
    const { JWT_PUBLIC_KEY_FILE, ...withoutKey } = baseEnv;

    expect(() => loadConfig(withoutKey)).toThrow(/exactly one/);
    expect(() =>
      loadConfig({ ...baseEnv, JWT_JWKS_URL: 'https://issuer.test/.well-known/jwks.json' }),
    ).toThrow(/exactly one/);
    expect(
      loadConfig({ ...withoutKey, JWT_JWKS_URL: 'https://issuer.test/jwks' }).JWT_JWKS_URL,
    ).toBe('https://issuer.test/jwks');
  });

  it('requires an issuer and audience', () => {
    expect(() => loadConfig({ ...baseEnv, JWT_ISSUER: undefined })).toThrow(/JWT_ISSUER/);
    expect(() => loadConfig({ ...baseEnv, JWT_AUDIENCE: '' })).toThrow(/JWT_AUDIENCE/);
  });

  it('rejects database urls without a host and brokers without a valid port', () => {
    expect(() =>
      loadConfig({ ...baseEnv, DATABASE_URL: 'postgres:db.internal:5432/capacity' }),
    ).toThrow(/DATABASE_URL/);
    expect(() => loadConfig({ ...baseEnv, KAFKA_BROKERS: 'broker:no-port' })).toThrow(
      /KAFKA_BROKERS/,
    );
    expect(() => loadConfig({ ...baseEnv, KAFKA_BROKERS: 'broker' })).toThrow(/KAFKA_BROKERS/);
    expect(() => loadConfig({ ...baseEnv, KAFKA_BROKERS: 'broker:70000' })).toThrow(
      /KAFKA_BROKERS/,
    );
  });

  it('requires an https JWKS url in production', () => {
    const { JWT_PUBLIC_KEY_FILE, ...withoutKey } = baseEnv;
    const jwks = { ...withoutKey, JWT_JWKS_URL: 'http://issuer.test/jwks' };

    expect(() => loadConfig({ ...jwks, NODE_ENV: 'production' })).toThrow(/https/);
    expect(loadConfig({ ...jwks, NODE_ENV: 'development' }).JWT_JWKS_URL).toBe(
      'http://issuer.test/jwks',
    );
  });

  it('rejects an empty broker list', () => {
    expect(() => loadConfig({ ...baseEnv, KAFKA_BROKERS: ' , ' })).toThrow(/KAFKA_BROKERS/);
  });
});
