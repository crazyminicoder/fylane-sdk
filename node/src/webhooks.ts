import { createHmac, timingSafeEqual } from 'node:crypto';
import { FylaneError } from './errors.js';

/**
 * Webhook signature verification (#96's other half): the platform signs
 * every delivery `t=<unix seconds>,v1=<hex hmac-sha256(secret, "t.body")>`
 * in the `Fylane-Signature` header; this is the receiving end, so no
 * customer hand-rolls HMAC comparison — the classic place to write a
 * timing leak or forget replay bounds.
 *
 * Verify the RAW request body, before any JSON parsing — a re-serialised
 * body is a different byte string and will not match.
 */

const DEFAULT_TOLERANCE_SECONDS = 300;

export interface VerifyWebhookOptions {
  /** Maximum age of the signature, in seconds. Default 300. */
  readonly toleranceSeconds?: number;
  /** Injectable clock (unix seconds) for tests. */
  readonly now?: number;
}

export function verifyWebhookSignature(
  payload: string | Uint8Array,
  signatureHeader: string,
  secret: string,
  options: VerifyWebhookOptions = {},
): Record<string, unknown> {
  const raw = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : Buffer.from(payload);

  const timestamps: string[] = [];
  const signatures: string[] = [];
  for (const pair of signatureHeader.split(',')) {
    const index = pair.indexOf('=');
    if (index === -1) continue;
    const name = pair.slice(0, index).trim();
    const value = pair.slice(index + 1).trim();
    if (name === 't') timestamps.push(value);
    if (name === 'v1') signatures.push(value);
  }
  const timestamp = Number(timestamps[0]);
  if (timestamps.length !== 1 || !Number.isInteger(timestamp) || signatures.length === 0) {
    throw new FylaneError('The signature header is not in t=...,v1=... form.');
  }

  const expected = createHmac('sha256', secret)
    .update(`${String(timestamp)}.`)
    .update(raw)
    .digest();
  const matches = signatures.some((candidate) => {
    const bytes = Buffer.from(candidate, 'hex');
    return bytes.length === expected.length && timingSafeEqual(bytes, expected);
  });
  if (!matches) {
    throw new FylaneError(
      'The webhook signature does not match — wrong secret, or a body modified in flight.',
    );
  }

  const now = options.now ?? Date.now() / 1000;
  const tolerance = options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  const age = Math.abs(now - timestamp);
  if (age > tolerance) {
    throw new FylaneError(
      `The webhook signature is ${String(Math.round(age))}s old, beyond the ${String(tolerance)}s replay tolerance.`,
    );
  }

  return JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
}
