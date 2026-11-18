import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import express, { type Request, type Response } from 'express';
import { type Observable } from 'rxjs';
import { MalformedRequestError, PayloadTooLargeError, UnsupportedMediaTypeError } from './problem';

export const BODY_LIMIT = '64kb';

const readRaw = express.raw({ type: () => true, limit: BODY_LIMIT });

function statusOf(error: unknown): number | null {
  if (typeof error === 'object' && error !== null && 'status' in error) {
    return typeof error.status === 'number' ? error.status : null;
  }
  return null;
}

function toBodyError(error: unknown): Error {
  const status = statusOf(error);
  if (status === 413) {
    return new PayloadTooLargeError(`Request body exceeds ${BODY_LIMIT}`);
  }
  if (status === 415) {
    return new UnsupportedMediaTypeError('Unsupported request body encoding');
  }
  if (status !== null && status < 500) {
    return new MalformedRequestError('Request body could not be read');
  }
  return error instanceof Error ? error : new Error(String(error));
}

function readBody(request: Request, response: Response): Promise<void> {
  return new Promise((resolve, reject) => {
    readRaw(request, response, (error?: unknown) => {
      if (error === undefined || error === null) {
        resolve();
        return;
      }
      reject(toBodyError(error));
    });
  });
}

@Injectable()
export class RequestBodyInterceptor implements NestInterceptor {
  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    if (context.getType() !== 'http') {
      return next.handle();
    }
    const http = context.switchToHttp();
    await readBody(http.getRequest<Request>(), http.getResponse<Response>());
    return next.handle();
  }
}
