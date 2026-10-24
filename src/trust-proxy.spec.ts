import { applyTrustProxy } from './trust-proxy';

describe('applyTrustProxy', () => {
  it.each([
    ['0', 0],
    ['1', 1],
    ['2', 2],
  ])('sets "%s" as the number %p', (hops, expected) => {
    const app = { set: jest.fn() };
    applyTrustProxy(app, hops);
    expect(app.set).toHaveBeenCalledWith('trust proxy', expected);
  });

  it.each(['', ' ', 'abc', '-1', '1.5', 'true'])('rejects %p', (hops) => {
    const app = { set: jest.fn() };
    expect(() => applyTrustProxy(app, hops)).toThrow(/TRUST_PROXY_HOPS/);
    expect(app.set).not.toHaveBeenCalled();
  });
});
