import { Inject, Injectable } from '@nestjs/common';
import { DATABASE, type Db } from '../../database/database';
import { FX_RATE_PROVIDER, type FxRateProvider } from '../../fx/fx-rate-provider';
import {
  assertPositiveAmount,
  assertReplayableReservation,
  planBooking,
} from '../domain/capacity-rules';
import { FxRateUnavailableError, ProgramNotFoundError } from '../domain/errors';
import { type Program, type Reservation } from '../domain/model';
import { CapacityRepository } from '../infrastructure/capacity.repository';
import { TreasuryRepository } from '../infrastructure/treasury.repository';
import { type ReserveCapacityCommand } from './commands';

export interface ReserveCapacityResult {
  readonly program: Program;
  readonly reservation: Reservation;
  readonly created: boolean;
}

@Injectable()
export class ReserveCapacity {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(FX_RATE_PROVIDER) private readonly fx: FxRateProvider,
    @Inject(CapacityRepository) private readonly repository: CapacityRepository,
    @Inject(TreasuryRepository) private readonly treasury: TreasuryRepository,
  ) {}

  async execute(command: ReserveCapacityCommand): Promise<ReserveCapacityResult> {
    assertPositiveAmount(command.invoiceAmount);
    return await this.db.transaction().execute(async (trx) => {
      const program = await this.repository.lockProgram(trx, command.programId);
      if (program === null) {
        throw new ProgramNotFoundError(command.programId);
      }

      const existing = await this.repository.findReservation(trx, program.id, command.invoiceId);
      if (existing !== null) {
        assertReplayableReservation(existing, command.invoiceAmount);
        return { program, reservation: existing, created: false };
      }

      const rate = await this.fx.getRate(command.invoiceAmount.currency, program.currency);
      if (rate === null) {
        throw new FxRateUnavailableError(command.invoiceAmount.currency, program.currency);
      }

      const pendingLimit = await this.treasury.lowestPendingLimit(trx, program);
      const plan = planBooking(program, command.invoiceAmount, rate, pendingLimit);
      const reservation = await this.repository.insertReservation(trx, {
        programId: program.id,
        invoiceId: command.invoiceId,
        status: 'ACTIVE',
        origin: 'API',
        invoiceAmountMinor: command.invoiceAmount.minor,
        invoiceCurrency: command.invoiceAmount.currency,
        invoiceReleasedMinor: 0n,
        bookedMinor: plan.bookedMinor,
        fx: plan.fx,
      });
      const updated = await this.repository.updateProgram(trx, program, {
        limitMinor: program.limitMinor,
        utilisedMinor: program.utilisedMinor + plan.bookedMinor,
      });
      await this.repository.appendLedger(trx, [
        {
          type: 'RESERVE',
          program_id: program.id,
          reservation_id: reservation.id,
          delta_minor: plan.bookedMinor,
          utilised_after_minor: updated.utilisedMinor,
          limit_after_minor: updated.limitMinor,
          actor: command.actor.subject,
          correlation_id: command.actor.correlationId,
          source_message_id: null,
          reason: null,
        },
      ]);
      return { program: updated, reservation, created: true };
    });
  }
}
