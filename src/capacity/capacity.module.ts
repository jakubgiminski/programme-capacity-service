import { Module } from '@nestjs/common';
import { CapacityQueries } from './application/capacity-queries';
import { ReleaseProcessor } from './application/release-processor';
import { ReleaseReservation } from './application/release-reservation';
import { ReserveCapacity } from './application/reserve-capacity';
import { CapacityController } from './http/capacity.controller';
import { CapacityRepository } from './infrastructure/capacity.repository';

@Module({
  controllers: [CapacityController],
  providers: [
    CapacityRepository,
    ReserveCapacity,
    ReleaseProcessor,
    ReleaseReservation,
    CapacityQueries,
  ],
  exports: [
    CapacityRepository,
    ReserveCapacity,
    ReleaseProcessor,
    ReleaseReservation,
    CapacityQueries,
  ],
})
export class CapacityModule {}
