import { type DynamicModule, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { AuthModule } from './auth/auth.module';
import { CapacityModule } from './capacity/capacity.module';
import { type AppConfig } from './config/config';
import { ConfigModule } from './config/config.module';
import { DatabaseModule } from './database/database.module';
import { FxModule } from './fx/fx.module';
import { HealthModule } from './health/health.module';
import { ProblemDetailsFilter } from './http/problem-details.filter';
import { LoggingModule } from './logging/logging.module';
import { TreasuryModule } from './treasury/treasury.module';

@Module({})
export class AppModule {
  static register(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [
        ConfigModule.register(config),
        LoggingModule.register(config),
        DatabaseModule.register(config),
        FxModule.register(config),
        AuthModule.register(config),
        CapacityModule,
        TreasuryModule.register(config),
        HealthModule,
      ],
      providers: [{ provide: APP_FILTER, useClass: ProblemDetailsFilter }],
    };
  }
}
