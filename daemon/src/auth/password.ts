import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

const cost = 32768;
const blockSize = 8;
const parallelism = 1;

function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 32, { N: cost, r: blockSize, p: parallelism, maxmem: 64 * 1024 * 1024 }, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

export function validatePassword(password: string) {
  if (password.length < 12 || Buffer.byteLength(password, 'utf8') > 1024) {
    throw new Error('The initial admin password must contain at least 12 characters and at most 1024 UTF-8 bytes');
  }
}

export async function hashPassword(password: string) {
  validatePassword(password);
  const salt = randomBytes(16);
  const key = await derive(password, salt);
  return `scrypt$${cost}$${blockSize}$${parallelism}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export async function verifyPassword(password: string, hash: string) {
  if (Buffer.byteLength(password, 'utf8') > 1024) return false;
  const parts = hash.split('$');
  if (
    parts.length !== 6 ||
    parts[0] !== 'scrypt' ||
    parts[1] !== `${cost}` ||
    parts[2] !== `${blockSize}` ||
    parts[3] !== `${parallelism}`
  )
    return false;
  if (!/^[A-Za-z0-9_-]{22}$/.test(parts[4]) || !/^[A-Za-z0-9_-]{43}$/.test(parts[5])) return false;
  const salt = Buffer.from(parts[4], 'base64url');
  const expected = Buffer.from(parts[5], 'base64url');
  return timingSafeEqual(await derive(password, salt), expected);
}
