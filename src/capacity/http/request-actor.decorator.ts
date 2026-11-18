import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import { type AuthenticatedRequest } from '../../auth/auth.guard';
import { AuthenticationError } from '../../auth/principal';
import { type Actor } from '../application/commands';

export const RequestActor = createParamDecorator(
  (_data: unknown, context: ExecutionContext): Actor => {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest & { id?: unknown }>();
    if (request.principal === undefined) {
      throw new AuthenticationError('Request is not authenticated');
    }
    return {
      subject: request.principal.subject,
      correlationId: typeof request.id === 'string' ? request.id : null,
    };
  },
);
