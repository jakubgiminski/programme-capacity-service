import { Controller, Get, HttpStatus, Inject, Param, Post, Query, Res } from '@nestjs/common';
import { type Response } from 'express';
import { Scope } from '../../auth/principal';
import { RequireScope } from '../../auth/require-scope.decorator';
import { JsonBody } from '../../http/json-body.decorator';
import { ZodValidationPipe } from '../../http/zod-validation.pipe';
import { Money } from '../../money';
import { CapacityQueries } from '../application/capacity-queries';
import { type Actor } from '../application/commands';
import { ReleaseReservation } from '../application/release-reservation';
import { ReserveCapacity } from '../application/reserve-capacity';
import {
  presentCapacity,
  presentDiscrepancy,
  presentRelease,
  presentReservation,
} from './presenters';
import { RequestActor } from './request-actor.decorator';
import { identifierSchema } from '../domain/identifier';
import {
  type DiscrepancyQuery,
  discrepancyQuerySchema,
  encodeCursor,
  type ReleaseBody,
  releaseBodySchema,
  type ReserveBody,
  reserveBodySchema,
} from './request-schemas';

const idPipe = new ZodValidationPipe(identifierSchema);
const discrepancyQueryPipe = new ZodValidationPipe(discrepancyQuerySchema);

@Controller('v1/programs/:programId')
export class CapacityController {
  constructor(
    @Inject(ReserveCapacity) private readonly reserveCapacity: ReserveCapacity,
    @Inject(ReleaseReservation) private readonly releaseReservation: ReleaseReservation,
    @Inject(CapacityQueries) private readonly queries: CapacityQueries,
  ) {}

  @Get('capacity')
  @RequireScope(Scope.Read)
  async getCapacity(@Param('programId', idPipe) programId: string) {
    return presentCapacity(await this.queries.getCapacity(programId));
  }

  @Get('discrepancies')
  @RequireScope(Scope.Read)
  async getDiscrepancies(
    @Param('programId', idPipe) programId: string,
    @Query(discrepancyQueryPipe) query: DiscrepancyQuery,
  ) {
    const list = await this.queries.listOpenDiscrepancies(programId, query);
    return {
      programId,
      discrepancies: list.discrepancies.map((item) => presentDiscrepancy(list.program, item)),
      nextCursor: list.next === null ? null : encodeCursor(list.next),
    };
  }

  @Post('reservations')
  @RequireScope(Scope.Write)
  async reserve(
    @Param('programId', idPipe) programId: string,
    @JsonBody(reserveBodySchema) body: ReserveBody,
    @RequestActor() actor: Actor,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.reserveCapacity.execute({
      programId,
      invoiceId: body.invoiceId,
      invoiceAmount: Money.of(body.amount.amount, body.amount.currency),
      actor,
    });
    response.status(result.created ? HttpStatus.CREATED : HttpStatus.OK);
    return presentReservation(result.program, result.reservation);
  }

  @Get('reservations/:invoiceId')
  @RequireScope(Scope.Read)
  async getReservation(
    @Param('programId', idPipe) programId: string,
    @Param('invoiceId', idPipe) invoiceId: string,
  ) {
    const details = await this.queries.getReservation(programId, invoiceId);
    return {
      ...presentReservation(details.program, details.reservation),
      releases: details.releases.map((release) =>
        presentRelease(details.program, details.reservation, release),
      ),
    };
  }

  @Post('reservations/:invoiceId/releases')
  @RequireScope(Scope.Write)
  async release(
    @Param('programId', idPipe) programId: string,
    @Param('invoiceId', idPipe) invoiceId: string,
    @JsonBody(releaseBodySchema) body: ReleaseBody,
    @RequestActor() actor: Actor,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.releaseReservation.execute({
      programId,
      invoiceId,
      releaseId: body.releaseId,
      amount: body.amount === undefined ? null : Money.of(body.amount.amount, body.amount.currency),
      actor,
    });
    response.status(result.created ? HttpStatus.CREATED : HttpStatus.OK);
    return {
      ...presentRelease(result.program, result.reservation, result.release),
      reservation: presentReservation(result.program, result.reservation),
    };
  }
}
