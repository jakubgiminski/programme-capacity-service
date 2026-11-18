import { type DynamicModule, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { type AppConfig } from '../config/config';
import { createDatabase, DATABASE, type Db } from './database';

@Module({})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(@Inject(DATABASE) private readonly db: Db) {}

  static register(config: AppConfig): DynamicModule {
    return {
      module: DatabaseModule,
      global: true,
      providers: [
        {
          provide: DATABASE,
          useFactory: () =>
            createDatabase({
              connectionString: config.DATABASE_URL,
              maxConnections: config.DATABASE_POOL_MAX,
            }),
        },
      ],
      exports: [DATABASE],
    };
  }

  async onApplicationShutdown(): Promise<void> {
    await this.db.destroy();
  }
}
