import {
  ArgumentsHost,
  Catch,
  ConflictException,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import { QueryFailedError } from 'typeorm';
import { CONSTRAINT_MESSAGES, SQLSTATE_MESSAGES } from './constraint-messages';

/** The shape `pg` gives a driver error. */
interface PostgresError extends Error {
  code?: string;
  constraint?: string;
  detail?: string;
  table?: string;
  column?: string;
}

/**
 * Turns a database constraint violation into an HTTP response a user can read.
 *
 * This is the second half of the bargain DB_DESIGN.MD §16 describes: the
 * constraints guarantee correctness, and this filter makes them presentable.
 * It deliberately does *not* leak `detail`, which can echo row values.
 */
@Catch(QueryFailedError)
export class DatabaseExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(DatabaseExceptionFilter.name);

  catch(exception: QueryFailedError, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const driver = exception.driverError as PostgresError | undefined;

    const code = driver?.code;
    const constraint = driver?.constraint;

    // Always log the real error — the user gets a sentence, the operator gets
    // everything needed to diagnose it.
    this.logger.error(
      `Query failed [${code ?? 'unknown'}]${
        constraint ? ` constraint=${constraint}` : ''
      }: ${exception.message}`,
    );

    const message =
      (constraint && CONSTRAINT_MESSAGES[constraint]) ??
      (code && SQLSTATE_MESSAGES[code]) ??
      undefined;

    if (!message) {
      // Not a rule we recognise — do not guess, and do not echo SQL.
      response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
        statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
        message: 'An unexpected database error occurred.',
      });
      return;
    }

    const status = statusForSqlState(code);
    response.status(status).json({
      statusCode: status,
      message,
      // The constraint name is safe and makes support conversations concrete.
      constraint: constraint ?? undefined,
    });
  }
}

function statusForSqlState(code: string | undefined): number {
  switch (code) {
    case '23505': // unique violation
    case '23503': // foreign key violation
      return HttpStatus.CONFLICT;
    case '23502': // not null violation
    case '23514': // check violation
      return HttpStatus.UNPROCESSABLE_ENTITY;
    case '40001': // serialization failure
    case '40P01': // deadlock detected
    case '55P03': // lock not available
      return HttpStatus.SERVICE_UNAVAILABLE;
    default:
      return HttpStatus.BAD_REQUEST;
  }
}

/** Re-exported for services that want to raise the same message deliberately. */
export function conflict(constraintName: string): HttpException {
  return new ConflictException(
    CONSTRAINT_MESSAGES[constraintName] ?? 'That value is already in use.',
  );
}
