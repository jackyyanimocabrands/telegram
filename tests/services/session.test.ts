import { describe, it } from 'mocha';
import { expect } from 'chai';
import { issueAccessToken, verifyAccessToken } from '../../src/services/session.js';
import type { AuthenticatedUser } from '../../src/types/api.js';

const testUser: AuthenticatedUser = {
  id: 1,
  telegramId: 99887766,
  firstName: 'Test',
  username: 'testuser',
};

describe('session', () => {
  describe('issueAccessToken', () => {
    it('returns a non-empty JWT string', () => {
      const token = issueAccessToken(testUser);
      expect(token).to.be.a('string').with.length.greaterThan(10);
    });

    it('returns a token with three dot-separated parts', () => {
      const parts = issueAccessToken(testUser).split('.');
      expect(parts).to.have.length(3);
    });
  });

  describe('verifyAccessToken', () => {
    it('returns the correct user payload', () => {
      const token = issueAccessToken(testUser);
      const user = verifyAccessToken(token);
      expect(user.id).to.equal(testUser.id);
      expect(user.telegramId).to.equal(testUser.telegramId);
      expect(user.firstName).to.equal(testUser.firstName);
      expect(user.username).to.equal(testUser.username);
    });

    it('throws on a completely invalid token string', () => {
      expect(() => verifyAccessToken('not.a.token')).to.throw();
    });

    it('throws on an empty string', () => {
      expect(() => verifyAccessToken('')).to.throw();
    });

    it('throws on a tampered token (modified payload)', () => {
      const token = issueAccessToken(testUser);
      const parts = token.split('.');
      // Replace payload with garbage base64
      const tampered = [parts[0], Buffer.from('{"sub":9999}').toString('base64url'), parts[2]].join('.');
      expect(() => verifyAccessToken(tampered)).to.throw();
    });
  });
});
