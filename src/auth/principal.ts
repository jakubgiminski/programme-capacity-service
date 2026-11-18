export const Scope = {
  Read: 'capacity:read',
  Write: 'capacity:write',
} as const;

export type Scope = (typeof Scope)[keyof typeof Scope];

export interface Principal {
  readonly subject: string;
  readonly scopes: ReadonlySet<string>;
}

export class AuthenticationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthenticationError';
  }
}

export class AuthorizationError extends Error {
  constructor(readonly requiredScope: string | null) {
    super(
      requiredScope === null
        ? 'Route has no declared scope and is denied by default'
        : `Missing required scope ${requiredScope}`,
    );
    this.name = 'AuthorizationError';
  }
}
