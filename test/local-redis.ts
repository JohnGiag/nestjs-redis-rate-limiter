// The e2e suites run SCRIPT FLUSH (server-wide) and delete keys: never point them at a shared Redis.
export function assertLocalRedis(url: string): void {
  const { hostname } = new URL(url);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(hostname)) {
    throw new Error(
      `e2e tests need a local Redis; REDIS_URL points at "${hostname}"`,
    );
  }
}
