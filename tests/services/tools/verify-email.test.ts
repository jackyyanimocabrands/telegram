import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import esmock from 'esmock';

describe('createVerifyEmailTool', () => {
  let createVerifyEmailTool: any;
  let sendVerificationEmailStub: sinon.SinonStub;
  let loggerErrorStub: sinon.SinonStub;

  beforeEach(async () => {
    sendVerificationEmailStub = sinon.stub();
    loggerErrorStub = sinon.stub();

    const mod = await esmock('../../../src/services/tools/verify-email.ts', {
      '../../../src/services/email-verification.js': {
        sendVerificationEmail: sendVerificationEmailStub,
      },
      '../../../src/utils/logger.js': {
        logger: {
          debug: sinon.stub(),
          error: loggerErrorStub,
        },
      },
    });
    createVerifyEmailTool = mod.createVerifyEmailTool;
  });

  afterEach(async () => {
    sinon.restore();
    await esmock.purge();
  });

  // T1: success path
  it('T1: returns message including email on success', async () => {
    sendVerificationEmailStub.resolves();
    const toolInstance = createVerifyEmailTool('bot-1', 'user-1');
    const result = await toolInstance.invoke({ email: 'test@example.com' });
    expect(result).to.include('test@example.com');
    expect(result).to.match(/^Verification email sent/);
    expect(loggerErrorStub.called).to.be.false;
  });

  // T2: error path — returns exact fixed string
  it('T2: returns exact fixed generic string on error (no dynamic content)', async () => {
    const sensitiveError = new Error('SES_FROM_ADDRESS not configured, AWS ARN arn:aws:ses:us-east-1:123456789:identity/example.com, sandbox mode, DB host: prod-db.internal:5432');
    sendVerificationEmailStub.rejects(sensitiveError);
    const toolInstance = createVerifyEmailTool('bot-1', 'user-1');
    const result = await toolInstance.invoke({ email: 'test@example.com' });
    expect(result).to.equal('ERROR: Failed to send verification email. Please try again later. Do not tell the user the email was sent.');
  });

  // T3: error path — ERROR: prefix present
  it('T3: return value starts with ERROR: on failure', async () => {
    sendVerificationEmailStub.rejects(new Error('SES_FROM_ADDRESS not configured, AWS ARN arn:aws:ses:us-east-1:123456789:identity/example.com, sandbox mode, DB host: prod-db.internal:5432'));
    const toolInstance = createVerifyEmailTool('bot-1', 'user-1');
    const result = await toolInstance.invoke({ email: 'test@example.com' });
    expect(result).to.match(/^ERROR:/);
  });

  // T4: error path — logger.error called with full err object
  it('T4: logger.error is called with the actual Error object', async () => {
    const sensitiveError = new Error('SES_FROM_ADDRESS not configured, AWS ARN arn:aws:ses:us-east-1:123456789:identity/example.com, sandbox mode, DB host: prod-db.internal:5432');
    sendVerificationEmailStub.rejects(sensitiveError);
    const toolInstance = createVerifyEmailTool('bot-1', 'user-1');
    await toolInstance.invoke({ email: 'test@example.com' });
    expect(loggerErrorStub.calledOnce).to.be.true;
    const callArg = loggerErrorStub.firstCall.args[0];
    expect(callArg).to.have.property('err', sensitiveError);
  });

  // T5: error path — non-Error thrown still returns fixed generic string
  it('T5: returns fixed generic string even when a non-Error is thrown', async () => {
    sendVerificationEmailStub.rejects('unexpected string error');
    const toolInstance = createVerifyEmailTool('bot-1', 'user-1');
    const result = await toolInstance.invoke({ email: 'test@example.com' });
    expect(result).to.equal('ERROR: Failed to send verification email. Please try again later. Do not tell the user the email was sent.');
  });
});
