import { type NestExpressApplication } from '@nestjs/platform-express';
import express, { type NextFunction, type Request, type Response } from 'express';
import { problemType } from './problem';
import { sendProblem } from './send-problem';

const JSON_BODY_LIMIT = '64kb';

function isHttpError(error: unknown): error is { status: number; type?: string } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    typeof error.status === 'number'
  );
}

export function configureApp(app: NestExpressApplication): void {
  app.disable('x-powered-by');
  app.use(express.json({ limit: JSON_BODY_LIMIT }));
  app.use((error: unknown, request: Request, response: Response, next: NextFunction) => {
    if (!isHttpError(error) || error.status >= 500) {
      next(error);
      return;
    }
    const tooLarge = error.status === 413;
    sendProblem(request, response, {
      type: problemType(tooLarge ? 'payload-too-large' : 'malformed-request'),
      title: tooLarge ? 'Payload Too Large' : 'Bad Request',
      status: error.status,
      detail: tooLarge
        ? `Request body exceeds ${JSON_BODY_LIMIT}`
        : 'Request body is not valid JSON',
    });
  });
}
