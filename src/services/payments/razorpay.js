import crypto from 'node:crypto';
import { safeEqual } from '../../lib/crypto.js';

export class ProviderError extends Error {
  constructor(message, { status } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
  }
}

/**
 * Razorpay Payment Links. A link is created per tip; the payer pays on Razorpay's hosted page; Razorpay tells us
 * with a signed webhook. Only the webhook credits money: the page the payer returns to just shows what we know.
 * Request and event formats follow Razorpay's published documentation for Payment Links.
 */
export function createRazorpayProvider(ctx) {
  const rz = ctx.config.payments.razorpay;
  const authorization = `Basic ${Buffer.from(`${rz.keyId}:${rz.keySecret}`).toString('base64')}`;

  return {
    name: 'razorpay',

    async createCheckout({ paymentId, amountMinor, currency, description, callbackUrl, expiresAt }) {
      const res = await ctx.fetch(`${rz.apiBase}/v1/payment_links/`, {
        method: 'POST',
        headers: { authorization, 'content-type': 'application/json' },
        body: JSON.stringify({
          amount: amountMinor,
          currency,
          accept_partial: false,
          description: description.slice(0, 500),
          reference_id: paymentId, // 36 characters; Razorpay allows 40 and requires it to be unique
          notify: { sms: false, email: false },
          reminder_enable: false,
          expire_by: Math.floor(expiresAt.getTime() / 1000),
          callback_url: callbackUrl,
          callback_method: 'get',
          notes: { payment_id: paymentId },
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new ProviderError(`Razorpay answered with status ${res.status}`, { status: res.status });
      const data = await res.json().catch(() => null);
      if (!data || typeof data.id !== 'string' || typeof data.short_url !== 'string' || !/^https:\/\//.test(data.short_url)) throw new ProviderError('Razorpay sent an unexpected answer');
      return { providerRef: data.id, checkoutUrl: data.short_url };
    },

    /**
     * Checks the signature (HMAC-SHA256 of the raw body, hex, in X-Razorpay-Signature) and turns the event into
     * { id, type: 'paid' | 'expired' | 'cancelled' | 'ignored', ... }. Returns null when the signature does not match.
     */
    readWebhook({ rawBody, headers }) {
      if (!Buffer.isBuffer(rawBody) || !rz.webhookSecret) return null;
      const given = String(headers['x-razorpay-signature'] ?? '');
      const expected = crypto.createHmac('sha256', rz.webhookSecret).update(rawBody).digest('hex');
      if (!given || !safeEqual(given, expected)) return null;
      const id = String(headers['x-razorpay-event-id'] ?? '').slice(0, 100);
      if (!id) return null;
      let body;
      try {
        body = JSON.parse(rawBody.toString('utf8'));
      } catch {
        return null;
      }
      const link = body?.payload?.payment_link?.entity;
      const payment = body?.payload?.payment?.entity;
      const type = String(body?.event ?? '');
      const base = { id, rawType: type, providerRef: typeof link?.id === 'string' ? link.id : null };
      if (type === 'payment_link.paid' && base.providerRef) {
        return {
          ...base,
          type: 'paid',
          amountMinor: Number(link.amount_paid),
          currency: String(link.currency ?? ''),
          providerPaymentId: typeof payment?.id === 'string' ? payment.id : null,
          paidAt: Number.isFinite(body.created_at) ? new Date(body.created_at * 1000) : null,
        };
      }
      if (type === 'payment_link.expired') return { ...base, type: 'expired' };
      if (type === 'payment_link.cancelled') return { ...base, type: 'cancelled' };
      return { ...base, type: 'ignored' };
    },
  };
}
