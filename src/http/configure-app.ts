import { type NestExpressApplication } from '@nestjs/platform-express';
import express, { type NextFunction, type Request, type Response } from 'express';
import { resolveCorrelationId } from '../logging/logging.module';
import { problemType } from './problem';
import { sendProblem } from './send-problem';

export const BODY_LIMIT = '64kb';

function isHttpError(error: unknown): error is { status: number } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    typeof error.status === 'number'
  );
}

function bodyErrorHandler(
  error: unknown,
  request: Request,
  response: Response,
  next: NextFunction,
): void {
  if (!isHttpError(error) || error.status >= 500) {
    next(error);
    return;
  }
  if (error.status === 413) {
    sendProblem(request, response, {
      type: problemType('payload-too-large'),
      title: 'Payload Too Large',
      status: 413,
      detail: `Request body exceeds ${BODY_LIMIT}`,
    });
    return;
  }
  if (error.status === 415) {
    sendProblem(request, response, {
      type: problemType('unsupported-media-type'),
      title: 'Unsupported Media Type',
      status: 415,
      detail: 'Unsupported content encoding',
    });
    return;
  }
  sendProblem(request, response, {
    type: problemType('malformed-request'),
    title: 'Bad Request',
    status: 400,
    detail: 'Request body could not be read',
  });
}

export function configureApp(app: NestExpressApplication): void {
  app.disable('x-powered-by');
  app.use((request: Request, response: Response, next: NextFunction) => {
    resolveCorrelationId(request, response);
    next();
  });
  app.use(express.raw({ type: () => true, limit: BODY_LIMIT }));
  app.use(bodyErrorHandler);
}
