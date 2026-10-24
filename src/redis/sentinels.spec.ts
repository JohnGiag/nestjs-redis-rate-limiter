import { parseSentinels } from './sentinels';

describe('parseSentinels', () => {
  it('parses a comma-separated host:port list', () => {
    expect(parseSentinels('sentinel-1:26379, sentinel-2:26380')).toEqual([
      { host: 'sentinel-1', port: 26379 },
      { host: 'sentinel-2', port: 26380 },
    ]);
  });

  it.each([
    '',
    'sentinel',
    'sentinel:',
    ':26379',
    'sentinel:abc',
    'sentinel:0',
    'sentinel:70000',
    'a:1:2',
    'a:1,,b:2',
  ])('rejects %p', (value) => {
    expect(() => parseSentinels(value)).toThrow(/REDIS_SENTINELS/);
  });
});
