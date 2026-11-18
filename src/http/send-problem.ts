import { type Request, type Response } from 'express';
import { type Problem, PROBLEM_CONTENT_TYPE } from './problem';

export function sendProblem(request: Request, response: Response, problem: Problem): void {
  const correlationId = (request as Request & { id?: unknown }).id;
  if (problem.status === 401) {
    response.setHeader('WWW-Authenticate', 'Bearer error="invalid_token"');
  }
  response
    .status(problem.status)
    .type(PROBLEM_CONTENT_TYPE)
    .send(
      JSON.stringify({
        ...problem,
        instance: request.originalUrl,
        ...(typeof correlationId === 'string' ? { correlationId } : {}),
      }),
    );
}
