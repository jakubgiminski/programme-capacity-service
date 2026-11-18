import { type DynamicModule, Module } from '@nestjs/common';
import { type AppConfig } from '../config/config';
import { FX_RATE_PROVIDER } from './fx-rate-provider';
import { loadFxRatesFile, StaticFxRateProvider } from './static-fx-rate-provider';

@Module({})
export class FxModule {
  static register(config: AppConfig): DynamicModule {
    return {
      module: FxModule,
      global: true,
      providers: [
        {
          provide: FX_RATE_PROVIDER,
          useFactory: () => new StaticFxRateProvider(loadFxRatesFile(config.FX_RATES_FILE)),
        },
      ],
      exports: [FX_RATE_PROVIDER],
    };
  }
}
