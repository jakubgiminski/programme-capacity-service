import { type DynamicModule, Module } from '@nestjs/common';
import { CapacityModule } from '../capacity/capacity.module';
import { type AppConfig } from '../config/config';
import { DeadLetterPublisher } from './dead-letter-publisher';
import { createKafka, KAFKA } from './kafka-client';
import { KAFKA_HEALTH, KafkaHealth } from './kafka-health';
import { TreasuryConsumer } from './treasury-consumer';

@Module({})
export class TreasuryModule {
  static register(config: AppConfig): DynamicModule {
    const health = { provide: KAFKA_HEALTH, useValue: new KafkaHealth(config.KAFKA_ENABLED) };
    if (!config.KAFKA_ENABLED) {
      return { module: TreasuryModule, global: true, providers: [health], exports: [KAFKA_HEALTH] };
    }
    return {
      module: TreasuryModule,
      global: true,
      imports: [CapacityModule],
      providers: [
        health,
        { provide: KAFKA, useFactory: () => createKafka(config) },
        DeadLetterPublisher,
        TreasuryConsumer,
      ],
      exports: [KAFKA_HEALTH],
    };
  }
}
