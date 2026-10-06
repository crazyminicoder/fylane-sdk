import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { FylaneError, verifyWebhookSignature } from '../src/index.js';

/**
 * The receiving end of the delivery worker's signature: the same
 * `t=…,v1=hex(hmac(secret, "t.body"))` scheme the API's signPayload
 * produces, judged here byte for byte.
 */

const SECRET = 'whsec_test_secret';

function sign(timestamp: number, body: string, secret = SECRET): string {
  const mac = createHmac('sha256', secret)
    .update(`${String(timestamp)}.${body}`)
    .digest('hex');
  return `t=${String(timestamp)},v1=${mac}`;
}

describe('verifyWebhookSignature', () => {
  it('accepts a genuine delivery and returns the parsed event', () => {
    const body = JSON.stringify({ type: 'job.succeeded', data: { job_id: 'j-1' } });
    const header = sign(1_700_000_000, body);
    const event = verifyWebhookSignature(body, header, SECRET, { now: 1_700_000_030 });
    expect(event['type']).toBe('job.succeeded');
  });

  it('accepts the raw bytes form a framework hands over', () => {
    const body = '{"type":"file.ready"}';
    const header = sign(1_700_000_000, body);
    const event = verifyWebhookSignature(new TextEncoder().encode(body), header, SECRET, {
      now: 1_700_000_000,
    });
    expect(event['type']).toBe('file.ready');
  });

  it('refuses a tampered body', () => {
    const header = sign(1_700_000_000, '{"amount":1}');
    expect(() =>
      verifyWebhookSignature('{"amount":9999}', header, SECRET, { now: 1_700_000_000 }),
    ).toThrow(/does not match/);
  });

  it('refuses the right signature under the wrong secret', () => {
    const body = '{"type":"job.succeeded"}';
    const header = sign(1_700_000_000, body, 'whsec_other');
    expect(() => verifyWebhookSignature(body, header, SECRET, { now: 1_700_000_000 })).toThrow(
      FylaneError,
    );
  });

  it('refuses a replayed signature by age', () => {
    const body = '{"type":"job.succeeded"}';
    const header = sign(1_700_000_000, body);
    expect(() => verifyWebhookSignature(body, header, SECRET, { now: 1_700_009_999 })).toThrow(
      /replay tolerance/,
    );
  });

  it('refuses malformed headers before any crypto', () => {
    expect(() => verifyWebhookSignature('{}', 'v1=deadbeef', SECRET)).toThrow(/t=/);
    expect(() => verifyWebhookSignature('{}', 't=abc,v1=deadbeef', SECRET)).toThrow(/form/);
    expect(() => verifyWebhookSignature('{}', 't=1,t=2,v1=deadbeef', SECRET)).toThrow(/form/);
  });

  it('survives a candidate that is not even hex', () => {
    const body = '{"ok":true}';
    expect(() =>
      verifyWebhookSignature(body, 't=1700000000,v1=zzzz', SECRET, { now: 1_700_000_000 }),
    ).toThrow(/does not match/);
  });
});
