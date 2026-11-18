import { type DynamicModule, Module } from '@nestjs/common';
import { CapacityModule } from './capacity/capacity.module';
import { type AppConfig } from './config/config';
import { ConfigModule } from './config/config.module';
import { DatabaseModule } from './database/database.module';
import { FxModule } from './fx/fx.module';
import { LoggingModule } from './logging/logging.module';

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
        CapacityModule,
      ],
    };
  }
}
