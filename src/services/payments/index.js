import { createRazorpayProvider } from './razorpay.js';
import { createTestProvider } from './test-provider.js';

/** The configured provider, or null when payments are switched off. */
export function createPaymentProvider(ctx) {
  switch (ctx.config.payments.provider) {
    case 'razorpay':
      return createRazorpayProvider(ctx);
    case 'test':
      return createTestProvider(ctx);
    default:
      return null;
  }
}
