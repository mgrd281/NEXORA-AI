import { describe, expect, it } from 'vitest';
import { WEBHOOK_LIMITS } from '@jarvis/contracts';
import {
  generateWebhookSecret,
  signWebhook,
  verifyWebhook,
  webhookHeaders,
  webhookMessageId,
  webhookSecretHint,
} from '../../../src/modules/webhooks/signing';

// Reference vector of the Standard Webhooks specification.
const SPEC = {
  secret: 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw',
  id: 'msg_p5jXN8AQM9LWM0D4loKWxJek',
  timestamp: 1614265330,
  body: '{"test": 2432232314}',
  signature: 'v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=',
};

describe('Standard Webhooks signing', () => {
  it('matches the specification’s reference signature', () => {
    expect(signWebhook(SPEC.secret, SPEC.id, SPEC.timestamp, SPEC.body)).toBe(SPEC.signature);
  });

  it('verifies within the replay window and rejects outside it or after tampering', () => {
    const headers = webhookHeaders(SPEC.secret, SPEC.id, SPEC.timestamp, SPEC.body);
    const at = (offset: number) => ({ nowSeconds: SPEC.timestamp + offset });
    expect(verifyWebhook(SPEC.secret, headers, SPEC.body, at(0))).toBe(true);
    expect(
      verifyWebhook(SPEC.secret, headers, SPEC.body, at(WEBHOOK_LIMITS.toleranceSeconds)),
    ).toBe(true);
    expect(
      verifyWebhook(SPEC.secret, headers, SPEC.body, at(WEBHOOK_LIMITS.toleranceSeconds + 1)),
    ).toBe(false);
    expect(verifyWebhook(SPEC.secret, headers, `${SPEC.body} `, at(0))).toBe(false);
    expect(
      verifyWebhook(SPEC.secret, { ...headers, 'webhook-id': 'msg_other' }, SPEC.body, at(0)),
    ).toBe(false);
    expect(verifyWebhook(generateWebhookSecret(), headers, SPEC.body, at(0))).toBe(false);
    // Several signatures (secret rotation): any valid one is enough.
    const rotated = { ...headers, 'webhook-signature': `v1,AAAA ${headers['webhook-signature']}` };
    expect(verifyWebhook(SPEC.secret, rotated, SPEC.body, at(0))).toBe(true);
  });

  it('makes long random secrets and reveals only a hint', () => {
    const a = generateWebhookSecret();
    const b = generateWebhookSecret();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^whsec_[A-Za-z0-9+/]{43}=$/);
    expect(webhookSecretHint(a)).toBe(`whsec_…${a.slice(-4)}`);
    expect(webhookSecretHint(a)).not.toContain(a.slice(6, 20));
    expect(webhookMessageId('3f1c')).toBe('msg_3f1c');
    expect(() => signWebhook('not-a-secret', 'msg_x', 1, '{}')).toThrow();
  });
});
