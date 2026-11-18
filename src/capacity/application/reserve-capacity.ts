import { Inject, Injectable } from '@nestjs/common';
import { DATABASE, type Db } from '../../database/database';
import { FX_RATE_PROVIDER, type FxRateProvider } from '../../fx/fx-rate-provider';
import { isSameReservationRequest, planBooking } from '../domain/capacity-rules';
import {
  FxRateUnavailableError,
  InvoiceConflictError,
  ProgramNotFoundError,
} from '../domain/errors';
import { type Program, type Reservation } from '../domain/model';
import { CapacityRepository } from '../infrastructure/capacity.repository';
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
    private readonly repository: CapacityRepository,
  ) {}

  execute(command: ReserveCapacityCommand): Promise<ReserveCapacityResult> {
    return this.db.transaction().execute(async (trx) => {
      const program = await this.repository.lockProgram(trx, command.programId);
      if (program === null) {
        throw new ProgramNotFoundError(command.programId);
      }

      const existing = await this.repository.findReservation(trx, program.id, command.invoiceId);
      if (existing !== null) {
        if (!isSameReservationRequest(existing, command.invoiceAmount)) {
          throw new InvoiceConflictError(command.invoiceId);
        }
        return { program, reservation: existing, created: false };
      }

      const rate = await this.fx.getRate(command.invoiceAmount.currency, program.currency);
      if (rate === null) {
        throw new FxRateUnavailableError(command.invoiceAmount.currency, program.currency);
      }

      const plan = planBooking(program, command.invoiceAmount, rate);
      const reservation = await this.repository.insertReservation(trx, {
        programId: program.id,
        invoiceId: command.invoiceId,
        origin: 'API',
        invoiceAmountMinor: command.invoiceAmount.minor,
        invoiceCurrency: command.invoiceAmount.currency,
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
