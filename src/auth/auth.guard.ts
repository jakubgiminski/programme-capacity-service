import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { type Request } from 'express';
import { AuthenticationError, AuthorizationError, type Principal } from './principal';
import { REQUIRED_SCOPE } from './require-scope.decorator';
import { TOKEN_VERIFIER, type TokenVerifier } from './token-verifier';

export interface AuthenticatedRequest extends Request {
  principal?: Principal;
}

const BEARER = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/;

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(TOKEN_VERIFIER) private readonly verifier: TokenVerifier,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const match = BEARER.exec(request.headers.authorization ?? '');
    if (match?.[1] === undefined) {
      throw new AuthenticationError('Missing bearer token');
    }
    const principal = await this.verifier.verify(match[1]);
    request.principal = principal;

    const requiredScope = this.reflector.getAllAndOverride<string | undefined>(REQUIRED_SCOPE, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (requiredScope === undefined) {
      throw new AuthorizationError(null);
    }
    if (!principal.scopes.has(requiredScope)) {
      throw new AuthorizationError(requiredScope);
    }
    return true;
  }
}
