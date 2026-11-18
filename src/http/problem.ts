export const PROBLEM_CONTENT_TYPE = 'application/problem+json';

export interface Problem {
  type: string;
  title: string;
  status: number;
  detail?: string;
  [extension: string]: unknown;
}

export function problemType(code: string): string {
  return `/problems/${code}`;
}

export class RequestValidationError extends Error {
  constructor(readonly errors: { path: string; message: string }[]) {
    super('Request validation failed');
    this.name = 'RequestValidationError';
  }
}

export class MalformedRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MalformedRequestError';
  }
}

export class UnsupportedMediaTypeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedMediaTypeError';
  }
}

export class ServiceUnavailableError extends Error {
  constructor(
    message: string,
    readonly extensions: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ServiceUnavailableError';
  }
}
