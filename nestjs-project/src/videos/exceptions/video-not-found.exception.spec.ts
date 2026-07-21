import { VideoNotFoundException } from './video-not-found.exception';

describe('VideoNotFoundException', () => {
  it('constructs with errorCode VIDEO_NOT_FOUND and httpStatus 404', () => {
    const exception = new VideoNotFoundException();

    expect(exception.errorCode).toBe('VIDEO_NOT_FOUND');
    expect(exception.httpStatus).toBe(404);
    expect(exception.message).toBe('Video not found');
  });
});
