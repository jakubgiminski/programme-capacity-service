import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import { parse as parseContentType } from 'content-type';
import { type Request } from 'express';
import { type z } from 'zod';
import { MalformedRequestError, UnsupportedMediaTypeError } from './problem';
import { ZodValidationPipe } from './zod-validation.pipe';

const UTF8 = new Set(['utf-8', 'utf8']);

function assertJsonMediaType(request: Request): void {
  let parsed: ReturnType<typeof parseContentType>;
  try {
    parsed = parseContentType(request);
  } catch {
    throw new UnsupportedMediaTypeError('Request body must be application/json');
  }
  if (parsed.type !== 'application/json') {
    throw new UnsupportedMediaTypeError('Request body must be application/json');
  }
  const charset = parsed.parameters.charset;
  if (charset !== undefined && !UTF8.has(charset.toLowerCase())) {
    throw new UnsupportedMediaTypeError('Request body must be UTF-8 encoded JSON');
  }
}

function decodeUtf8(body: unknown): string {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.alloc(0);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new MalformedRequestError('Request body is not valid UTF-8');
  }
}

function readJson(request: Request): unknown {
  assertJsonMediaType(request);
  const text = decodeUtf8(request.body);
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
