/**
 * A stand-in for a payment provider that never moves money. Its "checkout" is a page on this site with a Pay and a
 * Cancel button. It exists so the whole tip flow can be exercised in development and in tests. Production refuses it.
 */
export function createTestProvider(ctx) {
  return {
    name: 'test',
    async createCheckout({ paymentId }) {
      return { providerRef: `test_${paymentId}`, checkoutUrl: `${ctx.config.baseUrl}/support/test-checkout/${paymentId}` };
    },
  };
}
