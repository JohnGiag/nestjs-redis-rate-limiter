/** Parses REDIS_SENTINELS, e.g. "sentinel-1:26379,sentinel-2:26379". */
export function parseSentinels(
  value: string,
): { host: string; port: number }[] {
  return value.split(',').map((entry) => {
    const [host, portText, extra] = entry.trim().split(':');
    const port = Number(portText);
    if (
      !host ||
      extra !== undefined ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65535
    ) {
      throw new Error(
        `REDIS_SENTINELS must be "host:port[,host:port...]", got "${entry}"`,
      );
    }
    return { host, port };
  });
}
