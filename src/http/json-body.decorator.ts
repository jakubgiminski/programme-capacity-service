import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import { type Request } from 'express';
import { type z } from 'zod';
import { MalformedRequestError, UnsupportedMediaTypeError } from './problem';
import { ZodValidationPipe } from './zod-validation.pipe';

const CHARSET = /;\s*charset\s*=\s*"?([^";\s]+)"?/i;

function readJson(request: Request): unknown {
  if (request.is('application/json') === false || request.is('application/json') === null) {
    throw new UnsupportedMediaTypeError('Request body must be application/json');
  }
  const charset = CHARSET.exec(request.headers['content-type'] ?? '')?.[1]?.toLowerCase();
  if (charset !== undefined && charset !== 'utf-8' && charset !== 'utf8') {
    throw new UnsupportedMediaTypeError('Request body must be UTF-8 encoded JSON');
  }
  const body: unknown = request.body;
  const text = Buffer.isBuffer(body) ? body.toString('utf8') : '';
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new MalformedRequestError('Request body is not valid JSON');
  }
}

interface JsonBodyOptions {
  schema: z.ZodType;
}

const jsonBody = createParamDecorator((options: JsonBodyOptions, context: ExecutionContext) => {
  const json = readJson(context.switchToHttp().getRequest<Request>());
  return new ZodValidationPipe(options.schema).transform(json);
});

export function JsonBody(schema: z.ZodType): ParameterDecorator {
  return jsonBody({ schema });
}
