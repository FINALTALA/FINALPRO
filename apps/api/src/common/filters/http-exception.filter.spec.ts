import {
  ArgumentsHost,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { HttpExceptionFilter } from './http-exception.filter';

function makeHost(correlationId?: string) {
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  const res = { status };
  const req = { correlationId };
  const host = {
    switchToHttp: () => ({
      getResponse: () => res,
      getRequest: () => req,
    }),
  } as unknown as ArgumentsHost;
  return { host, status, json };
}

describe('HttpExceptionFilter', () => {
  it('uses a custom `code` from the exception body when the thrown exception supplies one (Part 4, H.1: OTP_INVALID etc.)', () => {
    const filter = new HttpExceptionFilter();
    const { host, status, json } = makeHost('corr-1');

    filter.catch(
      new BadRequestException({ code: 'OTP_INVALID', message: 'bad code' }),
      host,
    );

    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith({
      error: {
        code: 'OTP_INVALID',
        message: 'bad code',
        details: [],
        correlation_id: 'corr-1',
      },
    });
  });

  it('falls back to the HTTP-status-derived code when no custom code is supplied', () => {
    const filter = new HttpExceptionFilter();
    const { host, status, json } = makeHost('corr-2');

    filter.catch(new NotFoundException(), host);

    expect(status).toHaveBeenCalledWith(404);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({ code: 'NOT_FOUND' }),
      }),
    );
  });

  it('maps a non-HttpException error to a generic 500 without leaking its message as the code', () => {
    const filter = new HttpExceptionFilter();
    const { host, status, json } = makeHost('corr-3');

    filter.catch(new Error('db exploded'), host);

    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({
          code: 'INTERNAL_SERVER_ERROR',
          correlation_id: 'corr-3',
        }),
      }),
    );
  });
});
