import { type Money } from '../../money';

export interface Actor {
  readonly subject: string;
  readonly correlationId: string | null;
}

export interface ReserveCapacityCommand {
  readonly programId: string;
  readonly invoiceId: string;
  readonly invoiceAmount: Money;
  readonly actor: Actor;
}

export interface ReleaseReservationCommand {
  readonly programId: string;
  readonly invoiceId: string;
  readonly releaseId: string;
  readonly amount: Money | null;
  readonly actor: Actor;
}
