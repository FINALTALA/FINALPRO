import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { PHONE_INVALID_MARKER } from '../phone/phone-input';

// Sprint 27: markers raised by the sprint27_product_taxonomy triggers.
// Only these exact rule names are translated; any other database error
// still surfaces as an unexpected 500.
const DATABASE_RULES: { marker: string; code: string; message: string }[] = [
  {
    marker: 'OFFER_REQUIRES_COMBINATION',
    code: 'OFFER_REQUIRES_COMBINATION',
    message:
      'This product is classified - add colour/size combinations from the product screen instead',
  },
  {
    marker: 'OFFER_PRICE_NOT_UNIFIED',
    code: 'PRICE_IS_OFFER_LEVEL',
    message:
      'This product is classified - its price is set once for the whole product (PUT .../price)',
  },
  {
    marker: 'OFFER_NOT_CLASSIFIED',
    code: 'OFFER_NOT_CLASSIFIED',
    message:
      'Classify this product (audience and category) before publishing it',
  },
  {
    marker: 'COMBINATION_FLAG_IMMUTABLE',
    code: 'COMBINATION_FLAG_IMMUTABLE',
    message: 'A variant cannot be turned into, or out of, a combination',
  },
];

function databaseRuleFor(message: string) {
  return DATABASE_RULES.find((r) => message.includes(r.marker));
}

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
      // Phase A++ (item 8): a phone field that is not a valid number
      // (@PhoneField) is its own code, with the field name - never
      // class-validator's English sentence; any other validation message
      // of the same request stays in `details`.
      const phoneFields = details
        .filter(
          (d): d is string =>
            typeof d === 'string' && d.startsWith(PHONE_INVALID_MARKER),
        )
        .map((d) => d.slice(PHONE_INVALID_MARKER.length));
      if (!customCode && status === HttpStatus.BAD_REQUEST && phoneFields.length) {
        code = 'PHONE_INVALID';
        message =
          'The phone number is not valid (international format, e.g. +970...)';
        details = [
          ...[...new Set(phoneFields)].map((field) => ({ field })),
          ...details.filter(
            (d) =>
              !(typeof d === 'string' && d.startsWith(PHONE_INVALID_MARKER)),
          ),
        ];
      }
    } else if (
      exception instanceof Error &&
      databaseRuleFor(exception.message)
    ) {
      // Sprint 27: a business rule the database itself enforces (the
      // taxonomy migration's triggers) - reported as the same clean 409
      // a controller would have thrown, whichever endpoint hit it.
      const rule = databaseRuleFor(exception.message)!;
      status = HttpStatus.CONFLICT;
      code = rule.code;
      message = rule.message;
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
