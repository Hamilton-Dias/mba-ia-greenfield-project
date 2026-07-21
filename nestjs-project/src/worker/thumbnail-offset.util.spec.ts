import { computeThumbnailOffset } from './thumbnail-offset.util';

describe('computeThumbnailOffset', () => {
  it('returns 3 when duration is exactly 3', () => {
    expect(computeThumbnailOffset(3)).toBe(3);
  });

  it('returns 3 when duration is greater than 3', () => {
    expect(computeThumbnailOffset(10.5)).toBe(3);
  });

  it('returns 0 when duration is less than 3', () => {
    expect(computeThumbnailOffset(2.9)).toBe(0);
  });

  it('returns 0 when duration is 0', () => {
    expect(computeThumbnailOffset(0)).toBe(0);
  });
});
