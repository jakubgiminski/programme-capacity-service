import { Inject, Injectable } from '@nestjs/common';
import { DATABASE, type Db } from '../../database/database';
import { ProgramNotFoundError } from '../domain/errors';
import { CapacityRepository } from '../infrastructure/capacity.repository';
import { type ReleaseReservationCommand } from './commands';
import { ReleaseProcessor, type ReleaseOutcome } from './release-processor';

@Injectable()
export class ReleaseReservation {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(CapacityRepository) private readonly repository: CapacityRepository,
    @Inject(ReleaseProcessor) private readonly processor: ReleaseProcessor,
  ) {}

  execute(command: ReleaseReservationCommand): Promise<ReleaseOutcome> {
    return this.db.transaction().execute(async (trx) => {
      const program = await this.repository.lockProgram(trx, command.programId);
      if (program === null) {
        throw new ProgramNotFoundError(command.programId);
      }
      return this.processor.releaseLocked(trx, program, {
        invoiceId: command.invoiceId,
        releaseId: command.releaseId,
        amount: command.amount,
        origin: 'API',
        actor: command.actor,
        sourceMessageId: null,
      });
    });
  }
}
