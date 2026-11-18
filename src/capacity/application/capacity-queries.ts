import { Inject, Injectable } from '@nestjs/common';
import { DATABASE, type Db, type DbTransaction } from '../../database/database';
import { ProgramNotFoundError, ReservationNotFoundError } from '../domain/errors';
import { admissionLimitMinor } from '../domain/capacity-rules';
import { type Program, type Release, type Reservation } from '../domain/model';
import { CapacityRepository } from '../infrastructure/capacity.repository';
import {
  type OpenDiscrepancy,
  type StreamStatus,
  TreasuryRepository,
} from '../infrastructure/treasury.repository';

export interface CapacityView {
  readonly program: Program;
  readonly availableMinor: bigint;
  readonly overUtilised: boolean;
  readonly openDiscrepancies: number;
  readonly treasury: StreamStatus;
}

export interface DiscrepancyList {
  readonly program: Program;
  readonly discrepancies: OpenDiscrepancy[];
}

export interface ReservationDetails {
  readonly program: Program;
  readonly reservation: Reservation;
  readonly releases: Release[];
}

@Injectable()
export class CapacityQueries {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(CapacityRepository) private readonly repository: CapacityRepository,
    @Inject(TreasuryRepository) private readonly treasury: TreasuryRepository,
  ) {}

  getCapacity(programId: string): Promise<CapacityView> {
    return this.snapshot(async (trx) => {
      const program = await this.repository.findProgram(trx, programId);
      if (program === null) {
        throw new ProgramNotFoundError(programId);
      }
      const treasury = await this.treasury.streamStatus(trx, program);
      const available =
        admissionLimitMinor(program, treasury.pendingLimitMinor) - program.utilisedMinor;
      return {
        program,
        availableMinor: available,
        overUtilised: available < 0n,
        openDiscrepancies: await this.treasury.countOpenDiscrepancies(trx, programId),
        treasury,
      };
    });
  }

  listOpenDiscrepancies(programId: string): Promise<DiscrepancyList> {
    return this.snapshot(async (trx) => {
      const program = await this.repository.findProgram(trx, programId);
      if (program === null) {
        throw new ProgramNotFoundError(programId);
      }
      return { program, discrepancies: await this.treasury.listOpenDiscrepancies(trx, programId) };
    });
  }

  getReservation(programId: string, invoiceId: string): Promise<ReservationDetails> {
    return this.snapshot(async (trx) => {
      const program = await this.repository.findProgram(trx, programId);
      if (program === null) {
        throw new ProgramNotFoundError(programId);
      }
      const reservation = await this.repository.findReservation(trx, programId, invoiceId);
      if (reservation === null) {
        throw new ReservationNotFoundError(programId, invoiceId);
      }
      const releases = await this.repository.listReleases(trx, reservation.id);
      return { program, reservation, releases };
    });
  }

  private snapshot<T>(read: (trx: DbTransaction) => Promise<T>): Promise<T> {
    return this.db
      .transaction()
      .setIsolationLevel('repeatable read')
      .setAccessMode('read only')
      .execute(read);
  }
}
