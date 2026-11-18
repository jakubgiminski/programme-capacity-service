import { randomUUID } from 'node:crypto';
import { type IncomingMessage, type ServerResponse } from 'node:http';
import { type DynamicModule, Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { type AppConfig } from '../config/config';

export const CORRELATION_ID_HEADER = 'x-correlation-id';

const CORRELATION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export function resolveCorrelationId(req: IncomingMessage, res: ServerResponse): string {
  const header = req.headers[CORRELATION_ID_HEADER];
  const candidate = Array.isArray(header) ? header[0] : header;
  const id =
    candidate !== undefined && CORRELATION_ID_PATTERN.test(candidate) ? candidate : randomUUID();
  res.setHeader(CORRELATION_ID_HEADER, id);
  return id;
}

@Module({})
export class LoggingModule {
  static register(config: AppConfig): DynamicModule {
    return {
      module: LoggingModule,
      imports: [
        LoggerModule.forRoot({
          pinoHttp: {
            level: config.LOG_LEVEL,
            genReqId: resolveCorrelationId,
            customAttributeKeys: { reqId: 'correlationId' },
            redact: ['req.headers.authorization', 'req.headers.cookie'],
            autoLogging: { ignore: (req) => req.url === '/health' },
          },
        }),
      ],
    };
  }
}
