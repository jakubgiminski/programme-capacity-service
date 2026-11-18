import { type NestExpressApplication } from '@nestjs/platform-express';
import { type NextFunction, type Request, type Response } from 'express';
import { resolveCorrelationId } from '../logging/logging.module';
import { RequestBodyInterceptor } from './request-body.interceptor';

export function configureApp(app: NestExpressApplication): void {
  app.disable('x-powered-by');
  app.use((request: Request, response: Response, next: NextFunction) => {
    resolveCorrelationId(request, response);
    next();
  });
  app.useGlobalInterceptors(new RequestBodyInterceptor());
}
