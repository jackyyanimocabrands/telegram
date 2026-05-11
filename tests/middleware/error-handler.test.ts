import { describe, it } from 'mocha';
import { expect } from 'chai';
import type { Request, Response, NextFunction } from 'express';
import { errorHandler } from '../../src/middleware/error-handler.js';
import { AppError, TelegramApiError, AuthenticationError, ValidationError } from '../../src/utils/errors.js';

// ── helpers ───────────────────────────────────────────────────────────────────

/** Creates a minimal mock Response that captures status + json body. */
function makeMockRes(): { res: Response; captured: { status?: number; body?: any } } {
  const captured: { status?: number; body?: any } = {};
  const res = {
    status(code: number) {
      captured.status = code;
      return this;
    },
    json(body: any) {
      captured.body = body;
      return this;
    },
  } as unknown as Response;
  return { res, captured };
}

function makeReq(method = 'GET', path = '/test'): Request {
  return { method, path, ip: '127.0.0.1' } as Request;
}

const noop: NextFunction = () => {};

// ── tests ─────────────────────────────────────────────────────────────────────

describe('errorHandler middleware', () => {
  describe('TelegramApiError (isClientFacing = false)', () => {
    it('responds with 502 status', () => {
      const err = new TelegramApiError('sendMessage', 400, 'Bad Request');
      const { res, captured } = makeMockRes();

      errorHandler(err, makeReq(), res, noop);

      expect(captured.status).to.equal(502);
    });

    it('responds with generic "An internal error occurred" — not the raw method name', () => {
      const err = new TelegramApiError('sendMessage', 400, 'Bad Request');
      const { res, captured } = makeMockRes();

      errorHandler(err, makeReq(), res, noop);

      expect(captured.body.error).to.equal('An internal error occurred');
    });

    it('does NOT leak the Telegram method name in the response body', () => {
      const method = 'setWebhook';
      const err = new TelegramApiError(method, 403, 'Forbidden');
      const { res, captured } = makeMockRes();

      errorHandler(err, makeReq(), res, noop);

      const bodyString = JSON.stringify(captured.body);
      expect(bodyString).to.not.include(method);
    });

    it('does NOT leak the internal error description in the response body', () => {
      const description = 'Forbidden — internal detail';
      const err = new TelegramApiError('getMe', 403, description);
      const { res, captured } = makeMockRes();

      errorHandler(err, makeReq(), res, noop);

      const bodyString = JSON.stringify(captured.body);
      expect(bodyString).to.not.include(description);
    });

    it('sets ok: false in the response body', () => {
      const err = new TelegramApiError('getMe', 400, 'Bad');
      const { res, captured } = makeMockRes();

      errorHandler(err, makeReq(), res, noop);

      expect(captured.body).to.have.property('ok', false);
    });

    it('includes the TELEGRAM_API_ERROR code in the response body', () => {
      const err = new TelegramApiError('getMe', 400, 'Bad');
      const { res, captured } = makeMockRes();

      errorHandler(err, makeReq(), res, noop);

      expect(captured.body).to.have.property('code', 'TELEGRAM_API_ERROR');
    });
  });

  describe('AppError with isClientFacing = true (client-facing operational errors)', () => {
    it('responds with the AppError statusCode', () => {
      const err = new AuthenticationError('Token has expired');
      const { res, captured } = makeMockRes();

      errorHandler(err, makeReq(), res, noop);

      expect(captured.status).to.equal(401);
    });

    it('surfaces the AppError message to the client', () => {
      const err = new AuthenticationError('Token has expired');
      const { res, captured } = makeMockRes();

      errorHandler(err, makeReq(), res, noop);

      expect(captured.body.error).to.equal('Token has expired');
    });

    it('includes the correct error code', () => {
      const err = new AuthenticationError();
      const { res, captured } = makeMockRes();

      errorHandler(err, makeReq(), res, noop);

      expect(captured.body.code).to.equal('AUTHENTICATION_FAILED');
    });

    it('responds with 422 and validation message for ValidationError', () => {
      const err = new ValidationError('Field x is required');
      const { res, captured } = makeMockRes();

      errorHandler(err, makeReq(), res, noop);

      expect(captured.status).to.equal(422);
      expect(captured.body.error).to.equal('Field x is required');
      expect(captured.body.code).to.equal('VALIDATION_ERROR');
    });

    it('sets ok: false in the response body', () => {
      const err = new AppError('Something went wrong', 400, 'BAD_REQUEST');
      const { res, captured } = makeMockRes();

      errorHandler(err, makeReq(), res, noop);

      expect(captured.body).to.have.property('ok', false);
    });

    it('uses the AppError statusCode for arbitrary AppError instances', () => {
      const err = new AppError('Custom operational error', 503, 'SERVICE_UNAVAILABLE');
      const { res, captured } = makeMockRes();

      errorHandler(err, makeReq(), res, noop);

      expect(captured.status).to.equal(503);
      expect(captured.body.error).to.equal('Custom operational error');
      expect(captured.body.code).to.equal('SERVICE_UNAVAILABLE');
    });
  });

  describe('Unknown / non-AppError errors', () => {
    it('responds with 500 status', () => {
      const err = new Error('something failed internally');
      const { res, captured } = makeMockRes();

      errorHandler(err, makeReq(), res, noop);

      expect(captured.status).to.equal(500);
    });

    it('returns a generic message — not the raw error message', () => {
      const err = new Error('something failed internally');
      const { res, captured } = makeMockRes();

      errorHandler(err, makeReq(), res, noop);

      expect(captured.body.error).to.equal('Internal server error');
      expect(captured.body.error).to.not.include('something failed internally');
    });

    it('sets ok: false in the response body', () => {
      const err = new Error('boom');
      const { res, captured } = makeMockRes();

      errorHandler(err, makeReq(), res, noop);

      expect(captured.body).to.have.property('ok', false);
    });

    it('sets code to INTERNAL_ERROR', () => {
      const err = new Error('boom');
      const { res, captured } = makeMockRes();

      errorHandler(err, makeReq(), res, noop);

      expect(captured.body.code).to.equal('INTERNAL_ERROR');
    });

    it('does not expose raw error message for TypeError', () => {
      const err = new TypeError('Cannot read properties of undefined');
      const { res, captured } = makeMockRes();

      errorHandler(err, makeReq(), res, noop);

      expect(captured.body.error).to.equal('Internal server error');
    });
  });
});
