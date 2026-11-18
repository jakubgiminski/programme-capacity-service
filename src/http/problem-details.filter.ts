import { type ArgumentsHost, Catch, type ExceptionFilter, Logger } from '@nestjs/common';
import { type Request, type Response } from 'express';
import { sendProblem } from './send-problem';
import { toProblem } from './problem-mapping';

@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemDetailsFilter.name);

  catch(error: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();
    const problem = toProblem(error);
    if (problem.status >= 500) {
      this.logger.error({ err: error }, 'Unhandled error while processing request');
    }
    sendProblem(request, response, problem);
  }
}
