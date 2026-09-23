import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';

/**
 * Part 4, H.1's error-response format:
 *   { "error": { "code", "message", "details", "correlation_id" } }
 * Every error this API returns goes through here, whether it started
 * as a thrown HttpException (validation, auth, business-rule
 * violations - see the master prompt's 400/401/403/404/409/422/429/500
 * convention) or an unexpected exception (mapped to 500).
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();
    const correlationId = request.correlationId ?? 'unknown';

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let code = 'INTERNAL_SERVER_ERROR';
    let message = 'An unexpected error occurred';
    let details: unknown[] = [];

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse();
      // Part 4, H.1's examples (`400 OTP_INVALID`, `409 OTP_EXPIRED`, ...)
      // are business-specific codes, not just the HTTP status name - a
      // thrown exception can supply its own `code` in the response body
      // (e.g. `new BadRequestException({ code: 'OTP_INVALID', message })`)
      // and it's used verbatim; anything that doesn't falls back to the
      // generic status-derived code exactly as before.
      let customCode: string | undefined;
      if (typeof body === 'string') {
        message = body;
      } else if (typeof body === 'object' && body !== null) {
        const asRecord = body as Record<string, unknown>;
        message = (asRecord.message as string) ?? exception.message;
        // Validation errors arrive as an array `message`; a business
        // error may instead supply its own structured `details` array
        // (e.g. the price/fee diff of CHECKOUT_PRICE_CHANGED).
        details = Array.isArray(asRecord.message)
          ? (asRecord.message as unknown[])
          : Array.isArray(asRecord.details)
            ? (asRecord.details as unknown[])
            : [];
        customCode =
          typeof asRecord.code === 'string' ? asRecord.code : undefined;
      }
      code = customCode ?? HttpStatus[status] ?? 'ERROR';
    } else if (exception instanceof Error) {
      message = exception.message;
      this.logger.error(exception.message, exception.stack, correlationId);
    }

    response.status(status).json({
      error: {
        code,
        message,
        details,
        correlation_id: correlationId,
      },
    });
  }
}
