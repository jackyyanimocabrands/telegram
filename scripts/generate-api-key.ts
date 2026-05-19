#!/usr/bin/env node
import { randomBytes } from 'crypto';

const length = parseInt(process.argv[2] ?? '48', 10);
const key = randomBytes(Math.ceil(length * 3 / 4))
  .toString('base64url')
  .slice(0, length);

console.log(key);
