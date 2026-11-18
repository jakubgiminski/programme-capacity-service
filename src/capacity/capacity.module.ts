import { Module } from '@nestjs/common';
import { ApplyTreasuryMessage } from './application/apply-treasury-message';
import { CapacityQueries } from './application/capacity-queries';
import { ReleaseProcessor } from './application/release-processor';
import { ReleaseReservation } from './application/release-reservation';
import { ReserveCapacity } from './application/reserve-capacity';
import { CapacityController } from './http/capacity.controller';
import { CapacityRepository } from './infrastructure/capacity.repository';
import { TreasuryRepository } from './infrastructure/treasury.repository';

@Module({
  controllers: [CapacityController],
  providers: [
    CapacityRepository,
    TreasuryRepository,
    ApplyTreasuryMessage,
    ReserveCapacity,
    ReleaseProcessor,
    ReleaseReservation,
    CapacityQueries,
  ],
  exports: [
    CapacityRepository,
    TreasuryRepository,
    ApplyTreasuryMessage,
    ReserveCapacity,
    ReleaseProcessor,
    ReleaseReservation,
    CapacityQueries,
  ],
})
export class CapacityModule {}
