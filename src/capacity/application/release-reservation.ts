import { Inject, Injectable } from '@nestjs/common';
import { DATABASE, type Db } from '../../database/database';
import { ProgramNotFoundError } from '../domain/errors';
import { type Release, type Reservation } from '../domain/model';
import { CapacityRepository } from '../infrastructure/capacity.repository';
import { type ReleaseReservationCommand } from './commands';
import { ReleaseProcessor } from './release-processor';

export interface ReleaseReservationResult {
  readonly reservation: Reservation;
  readonly release: Release;
  readonly created: boolean;
}

@Injectable()
export class ReleaseReservation {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    private readonly repository: CapacityRepository,
    private readonly processor: ReleaseProcessor,
  ) {}

  execute(command: ReleaseReservationCommand): Promise<ReleaseReservationResult> {
    return this.db.transaction().execute(async (trx) => {
      const program = await this.repository.lockProgram(trx, command.programId);
      if (program === null) {
        throw new ProgramNotFoundError(command.programId);
      }
      const outcome = await this.processor.releaseLocked(trx, program, {
        invoiceId: command.invoiceId,
        releaseId: command.releaseId,
        amount: command.amount,
        origin: 'API',
        actor: command.actor,
        sourceMessageId: null,
      });
      return {
        reservation: outcome.reservation,
        release: outcome.release,
        created: outcome.created,
      };
    });
  }
}
