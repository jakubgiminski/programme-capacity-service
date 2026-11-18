import { type DynamicModule, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { type AppConfig } from '../config/config';
import { AuthGuard } from './auth.guard';
import { TOKEN_VERIFIER, TokenVerifier } from './token-verifier';

@Module({})
export class AuthModule {
  static register(config: AppConfig): DynamicModule {
    return {
      module: AuthModule,
      providers: [
        { provide: TOKEN_VERIFIER, useFactory: () => TokenVerifier.fromConfig(config) },
        { provide: APP_GUARD, useClass: AuthGuard },
      ],
    };
  }
}
