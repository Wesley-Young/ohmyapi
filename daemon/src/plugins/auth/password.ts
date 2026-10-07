import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

const cost = 32768;
const blockSize = 8;
const parallelism = 1;

export function generatePassword() {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  return [...randomBytes(16)].map((byte) => alphabet[byte & 63]).join('');
}

function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 32, { N: cost, r: blockSize, p: parallelism, maxmem: 64 * 1024 * 1024 }, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

export function validatePassword(password: string) {
  if (password.length < 8 || Buffer.byteLength(password, 'utf8') > 1024) {
    throw new Error('密码至少 8 个字符，且不超过 1024 个 UTF-8 字节');
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
