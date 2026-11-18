import { Inject, Injectable } from '@nestjs/common';
import { type DbTransaction } from '../../database/database';
import { type Money } from '../../money';
import { planRelease } from '../domain/capacity-rules';
import { ReleaseConflictError, ReservationNotFoundError } from '../domain/errors';
import { type Origin, type Program, type Release, type Reservation } from '../domain/model';
import { CapacityRepository } from '../infrastructure/capacity.repository';
import { type Actor } from './commands';

export interface LockedReleaseCommand {
  readonly invoiceId: string;
  readonly releaseId: string;
  readonly amount: Money | null;
  readonly origin: Origin;
  readonly actor: Actor;
  readonly sourceMessageId: string | null;
}

export interface ReleaseOutcome {
  readonly program: Program;
  readonly reservation: Reservation;
  readonly release: Release;
  readonly created: boolean;
}

@Injectable()
export class ReleaseProcessor {
  constructor(@Inject(CapacityRepository) private readonly repository: CapacityRepository) {}

  async releaseLocked(
    trx: DbTransaction,
    program: Program,
    command: LockedReleaseCommand,
  ): Promise<ReleaseOutcome> {
    const reservation = await this.repository.findReservation(trx, program.id, command.invoiceId);
    if (reservation === null) {
      throw new ReservationNotFoundError(program.id, command.invoiceId);
    }

    const previous = await this.repository.findRelease(trx, reservation.id, command.releaseId);
    if (previous !== null) {
      if (!isSameReleaseRequest(previous, reservation, command.amount)) {
        throw new ReleaseConflictError(command.releaseId);
      }
      return { program, reservation, release: previous, created: false };
    }

    const plan = planRelease(reservation, command.amount);
    const now = new Date();
    const updatedReservation = await this.repository.updateReservation(
      trx,
      reservation.id,
      {
        status: plan.status,
        invoiceReleasedMinor: plan.invoiceReleasedAfterMinor,
        bookedMinor: reservation.bookedMinor,
        releasedMinor: plan.releasedAfterMinor,
      },
      now,
    );
    const release = await this.repository.insertRelease(trx, {
      reservationId: reservation.id,
      releaseId: command.releaseId,
      requestedInvoiceAmountMinor: command.amount?.minor ?? null,
      invoiceAmountMinor: plan.invoiceAmountMinor,
      freedMinor: plan.freedMinor,
      origin: command.origin,
      actor: command.actor.subject,
      sequence: program.version + 1n,
      statusAfter: plan.status,
      invoiceReleasedAfterMinor: plan.invoiceReleasedAfterMinor,
      bookedAfterMinor: reservation.bookedMinor,
      releasedAfterMinor: plan.releasedAfterMinor,
      createdAt: now,
    });
    const updatedProgram = await this.repository.updateProgram(trx, program, {
      limitMinor: program.limitMinor,
      utilisedMinor: program.utilisedMinor - plan.freedMinor,
    });
    await this.repository.appendLedger(trx, [
      {
        type: 'RELEASE',
        program_id: program.id,
        reservation_id: reservation.id,
        delta_minor: -plan.freedMinor,
        utilised_after_minor: updatedProgram.utilisedMinor,
        limit_after_minor: updatedProgram.limitMinor,
        actor: command.actor.subject,
        correlation_id: command.actor.correlationId,
        source_message_id: command.sourceMessageId,
        reason: null,
      },
    ]);
    return { program: updatedProgram, reservation: updatedReservation, release, created: true };
  }
}

function isSameReleaseRequest(
  previous: Release,
  reservation: Reservation,
  amount: Money | null,
): boolean {
  if (amount === null) {
    return previous.requestedInvoiceAmountMinor === null;
  }
  return (
    amount.currency === reservation.invoiceCurrency &&
    previous.requestedInvoiceAmountMinor === amount.minor
  );
}
