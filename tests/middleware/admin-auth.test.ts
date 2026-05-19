import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import esmock from 'esmock';
import type { Request, Response } from 'express';

const TEST_ADMIN_KEY = 'test-admin-key-for-testing-purposes-only-32chars';

function makeReq(authHeader?: string): Request {
  return { headers: { authorization: authHeader } } as any;
}

function makeRes() {
  const json = sinon.stub().returnsThis();
  const status = sinon.stub().returnsThis();
  return { status, json } as unknown as Response & { status: sinon.SinonStub; json: sinon.SinonStub };
}

describe('adminAuth middleware', () => {
  let next: sinon.SinonStub;
  let adminAuth: any;

  beforeEach(async () => {
    next = sinon.stub();

    const module = await esmock('../../src/middleware/admin-auth.ts', {
      '../../src/config/env.js': {
        env: { ADMIN_API_KEY: TEST_ADMIN_KEY },
      },
    });
    adminAuth = module.adminAuth;
  });

  afterEach(async () => {
    sinon.restore();
    await esmock.purge();
  });

  it('returns 401 when Authorization header is missing', () => {
    const res = makeRes();
    adminAuth(makeReq(), res, next);
    expect(res.status.calledWith(401)).to.be.true;
    expect(res.json.calledOnce).to.be.true;
    expect(next.called).to.be.false;
  });

  it('returns 401 when header does not start with Bearer (Basic scheme)', () => {
    const res = makeRes();
    adminAuth(makeReq('Basic dXNlcjpwYXNz'), res, next);
    expect(res.status.calledWith(401)).to.be.true;
    expect(res.json.calledOnce).to.be.true;
    expect(next.called).to.be.false;
  });

  it('returns 401 when Bearer prefix present but token is empty', () => {
    const res = makeRes();
    adminAuth(makeReq('Bearer'), res, next);
    expect(res.status.calledWith(401)).to.be.true;
    expect(next.called).to.be.false;
  });

  it('calls next() with no arguments for the correct token', () => {
    const res = makeRes();
    adminAuth(makeReq(`Bearer ${TEST_ADMIN_KEY}`), res, next);
    expect(next.calledOnce).to.be.true;
    expect(next.firstCall.args).to.deep.equal([]);
    expect(res.status.called).to.be.false;
  });

  it('returns 401 for a wrong token of the same length', () => {
    // Same length as TEST_ADMIN_KEY, different content
    const wrongToken = TEST_ADMIN_KEY.replace(/a/g, 'z');
    const res = makeRes();
    adminAuth(makeReq(`Bearer ${wrongToken}`), res, next);
    expect(res.status.calledWith(401)).to.be.true;
    expect(next.called).to.be.false;
  });

  it('returns 401 for a wrong token of a different length', () => {
    const res = makeRes();
    adminAuth(makeReq('Bearer short-wrong-key'), res, next);
    expect(res.status.calledWith(401)).to.be.true;
    expect(next.called).to.be.false;
  });

  it('401 response body contains only { error: "Unauthorized" } — no key value leaked', () => {
    const res = makeRes();
    adminAuth(makeReq('Bearer wrong-token-value'), res, next);
    expect(res.json.calledOnce).to.be.true;
    const body = res.json.firstCall.args[0];
    expect(body).to.deep.equal({ error: 'Unauthorized' });
    // Ensure the actual key value is not in the response
    expect(JSON.stringify(body)).to.not.include(TEST_ADMIN_KEY);
  });
});
