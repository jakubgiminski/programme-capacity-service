import { Body, Controller, Get, HttpStatus, Param, Post, Res } from '@nestjs/common';
import { type Response } from 'express';
import { Scope } from '../../auth/principal';
import { RequireScope } from '../../auth/require-scope.decorator';
import { ZodValidationPipe } from '../../http/zod-validation.pipe';
import { Money } from '../../money';
import { CapacityQueries } from '../application/capacity-queries';
import { type Actor } from '../application/commands';
import { ReleaseReservation } from '../application/release-reservation';
import { ReserveCapacity } from '../application/reserve-capacity';
import { presentCapacity, presentRelease, presentReservation } from './presenters';
import { RequestActor } from './request-actor.decorator';
import {
  identifierSchema,
  type ReleaseBody,
  releaseBodySchema,
  type ReserveBody,
  reserveBodySchema,
} from './request-schemas';

const idPipe = new ZodValidationPipe(identifierSchema);

@Controller('v1/programs/:programId')
export class CapacityController {
  constructor(
    private readonly reserveCapacity: ReserveCapacity,
    private readonly releaseReservation: ReleaseReservation,
    private readonly queries: CapacityQueries,
  ) {}

  @Get('capacity')
  @RequireScope(Scope.Read)
  async getCapacity(@Param('programId', idPipe) programId: string) {
    return presentCapacity(await this.queries.getCapacity(programId));
  }

  @Post('reservations')
  @RequireScope(Scope.Write)
  async reserve(
    @Param('programId', idPipe) programId: string,
    @Body(new ZodValidationPipe(reserveBodySchema)) body: ReserveBody,
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
    @Body(new ZodValidationPipe(releaseBodySchema)) body: ReleaseBody,
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
