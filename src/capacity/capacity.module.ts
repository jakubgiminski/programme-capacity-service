import { Module } from '@nestjs/common';
import { CapacityQueries } from './application/capacity-queries';
import { ReleaseProcessor } from './application/release-processor';
import { ReleaseReservation } from './application/release-reservation';
import { ReserveCapacity } from './application/reserve-capacity';
import { CapacityRepository } from './infrastructure/capacity.repository';

@Module({
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
