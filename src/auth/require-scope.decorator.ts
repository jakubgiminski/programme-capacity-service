import { SetMetadata } from '@nestjs/common';
import { type Scope } from './principal';

export const REQUIRED_SCOPE = 'auth:required-scope';

export const RequireScope = (scope: Scope) => SetMetadata(REQUIRED_SCOPE, scope);
