import { describe, it } from 'mocha';
import { expect } from 'chai';
import { encrypt, decrypt } from '../../src/services/encryption.js';

describe('encryption', () => {
  describe('encrypt / decrypt round-trip', () => {
    it('decrypts back to the original plaintext', () => {
      const plaintext = 'my-secret-bot-token';
      const { ciphertext, iv, keyVersion } = encrypt(plaintext);
      expect(decrypt(ciphertext, iv, keyVersion)).to.equal(plaintext);
    });

    it('returns a non-empty ciphertext buffer', () => {
      const { ciphertext } = encrypt('hello');
      expect(ciphertext.length).to.be.greaterThan(0);
    });

    it('uses the current key version from env', () => {
      const { keyVersion } = encrypt('test');
      expect(keyVersion).to.equal(Number(process.env.ENCRYPTION_KEY_VERSION));
    });

    it('each call produces a different iv (random)', () => {
      const r1 = encrypt('same');
      const r2 = encrypt('same');
      expect(r1.iv.toString('hex')).to.not.equal(r2.iv.toString('hex'));
    });

    it('each call produces a different ciphertext (random IV)', () => {
      const r1 = encrypt('same');
      const r2 = encrypt('same');
      expect(r1.ciphertext.toString('hex')).to.not.equal(r2.ciphertext.toString('hex'));
    });
  });

  describe('decrypt', () => {
    it('throws on tampered ciphertext (auth tag mismatch)', () => {
      const { ciphertext, iv, keyVersion } = encrypt('secret');
      // Flip first byte of auth tag
      const tampered = Buffer.from(ciphertext);
      tampered[0] = tampered[0]! ^ 0xff;
      expect(() => decrypt(tampered, iv, keyVersion)).to.throw();
    });

    it('throws on wrong key version', () => {
      const { ciphertext, iv } = encrypt('secret');
      expect(() => decrypt(ciphertext, iv, 999)).to.throw();
    });
  });
});
