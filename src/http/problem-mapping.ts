import { HttpException, HttpStatus } from '@nestjs/common';
import { DatabaseError } from 'pg';
import {
  AuthenticationError,
  AuthorizationError,
  KeyServiceUnavailableError,
} from '../auth/principal';
import {
  CapacityError,
  InsufficientCapacityError,
  OverReleaseError,
} from '../capacity/domain/errors';
import {
  MalformedRequestError,
  PayloadTooLargeError,
  type Problem,
  problemType,
  RequestValidationError,
  ServiceUnavailableError,
  UnsupportedMediaTypeError,
} from './problem';

const CAPACITY_STATUS: Record<string, number> = {
  'program-not-found': HttpStatus.NOT_FOUND,
  'reservation-not-found': HttpStatus.NOT_FOUND,
  'invoice-conflict': HttpStatus.CONFLICT,
  'treasury-owned-reservation': HttpStatus.CONFLICT,
  'insufficient-capacity': HttpStatus.CONFLICT,
  'release-conflict': HttpStatus.CONFLICT,
  'reservation-already-released': HttpStatus.CONFLICT,
  'fx-rate-unavailable': HttpStatus.UNPROCESSABLE_ENTITY,
  'over-release': HttpStatus.UNPROCESSABLE_ENTITY,
  'release-currency-mismatch': HttpStatus.UNPROCESSABLE_ENTITY,
  'amount-out-of-range': HttpStatus.UNPROCESSABLE_ENTITY,
  'invalid-amount': HttpStatus.UNPROCESSABLE_ENTITY,
};

const TITLES: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  409: 'Conflict',
  413: 'Payload Too Large',
  415: 'Unsupported Media Type',
  422: 'Unprocessable Content',
  500: 'Internal Server Error',
  503: 'Service Unavailable',
};

function titleFor(status: number): string {
  return TITLES[status] ?? 'Error';
}

function capacityProblem(error: CapacityError): Problem {
  const status = CAPACITY_STATUS[error.code] ?? HttpStatus.UNPROCESSABLE_ENTITY;
  const problem: Problem = {
    type: problemType(error.code),
    title: titleFor(status),
    status,
    detail: error.message,
  };
  if (error instanceof InsufficientCapacityError) {
    return {
      ...problem,
      requested: { amount: error.requestedMinor.toString(), currency: error.currency },
      available: { amount: error.availableMinor.toString(), currency: error.currency },
    };
  }
  if (error instanceof OverReleaseError) {
    return {
      ...problem,
      requestedAmount: error.requestedMinor.toString(),
      outstandingAmount: error.outstandingMinor.toString(),
    };
  }
  return problem;
}

const DATABASE_TIMEOUT_CODES = new Set(['55P03', '57014']);

function isDatabaseTimeout(error: unknown): boolean {
  return (
    error instanceof DatabaseError &&
    error.code !== undefined &&
    DATABASE_TIMEOUT_CODES.has(error.code)
  );
}

export function toProblem(error: unknown): Problem {
  if (error instanceof CapacityError) {
    return capacityProblem(error);
  }
  if (error instanceof RequestValidationError) {
    return {
      type: problemType('validation-failed'),
      title: titleFor(400),
      status: 400,
      detail: error.message,
      errors: error.errors,
    };
  }
  if (error instanceof MalformedRequestError) {
    return {
      type: problemType('malformed-request'),
      title: titleFor(400),
      status: 400,
      detail: error.message,
    };
  }
  if (error instanceof PayloadTooLargeError) {
    return {
      type: problemType('payload-too-large'),
      title: titleFor(413),
      status: 413,
      detail: error.message,
    };
  }
  if (error instanceof UnsupportedMediaTypeError) {
    return {
      type: problemType('unsupported-media-type'),
      title: titleFor(415),
      status: 415,
      detail: error.message,
    };
  }
  if (error instanceof ServiceUnavailableError) {
    return {
      type: problemType('service-unavailable'),
      title: titleFor(503),
      status: 503,
      detail: error.message,
      ...error.extensions,
    };
  }
  if (isDatabaseTimeout(error)) {
    return {
      type: problemType('service-unavailable'),
      title: titleFor(503),
      status: 503,
      detail: 'The request timed out waiting for the database; retry later',
    };
  }
  if (error instanceof KeyServiceUnavailableError) {
    return {
      type: problemType('authentication-unavailable'),
      title: titleFor(503),
      status: 503,
      detail: 'Token verification keys are temporarily unavailable',
    };
  }
  if (error instanceof AuthenticationError) {
    return {
      type: problemType('unauthenticated'),
      title: titleFor(401),
      status: 401,
      detail: error.message,
    };
  }
  if (error instanceof AuthorizationError) {
    return {
      type: problemType('forbidden'),
      title: titleFor(403),
      status: 403,
      detail: error.message,
    };
  }
  if (error instanceof HttpException) {
    const status = error.getStatus();
    return {
      type: status === 404 ? problemType('not-found') : 'about:blank',
      title: titleFor(status),
      status,
      detail: status >= 500 ? 'Unexpected error' : error.message,
    };
  }
  return {
    type: 'about:blank',
    title: titleFor(500),
    status: 500,
    detail: 'Unexpected error',
  };
}
