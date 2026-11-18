import { Inject, Injectable } from '@nestjs/common';
import { DATABASE, type Db } from '../../database/database';
import { ProgramNotFoundError, ReservationNotFoundError } from '../domain/errors';
import { availableMinor, type Program, type Release, type Reservation } from '../domain/model';
import { CapacityRepository } from '../infrastructure/capacity.repository';

export interface CapacityView {
  readonly program: Program;
  readonly availableMinor: bigint;
  readonly overUtilised: boolean;
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
    private readonly repository: CapacityRepository,
  ) {}

  async getCapacity(programId: string): Promise<CapacityView> {
    const program = await this.repository.findProgram(this.db, programId);
    if (program === null) {
      throw new ProgramNotFoundError(programId);
    }
    const available = availableMinor(program);
    return { program, availableMinor: available, overUtilised: available < 0n };
  }

  async getReservation(programId: string, invoiceId: string): Promise<ReservationDetails> {
    const program = await this.repository.findProgram(this.db, programId);
    if (program === null) {
      throw new ProgramNotFoundError(programId);
    }
    const reservation = await this.repository.findReservation(this.db, programId, invoiceId);
    if (reservation === null) {
      throw new ReservationNotFoundError(programId, invoiceId);
    }
    const releases = await this.repository.listReleases(this.db, reservation.id);
    return { program, reservation, releases };
  }
}
