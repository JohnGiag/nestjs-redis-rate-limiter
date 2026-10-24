import type { NestExpressApplication } from '@nestjs/platform-express';

/**
 * hops = proxies in front of the app; req.ip is read that many hops from the right of X-Forwarded-For.
 * Never `true`: it trusts the leftmost entry, which the client controls, and bypasses rate limits.
 */
export function applyTrustProxy(
  app: Pick<NestExpressApplication, 'set'>,
  hops: string,
): void {
  // Express reads a string as a list of trusted addresses, so it must become a number.
  const count = Number(hops);
  if (hops.trim() === '' || !Number.isInteger(count) || count < 0) {
    throw new Error(`TRUST_PROXY_HOPS must be an integer >= 0, got "${hops}"`);
  }
  app.set('trust proxy', count);
}
