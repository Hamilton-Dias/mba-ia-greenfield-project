/**
 * Computes the ffmpeg `-ss` seek offset (in seconds) used to capture a video's
 * thumbnail frame, per TD-06's fixed-offset-with-clamp rule: videos long enough
 * to have a frame at the 3-second mark use that offset; shorter videos clamp to
 * the very first frame (offset 0) so the seek never lands past end-of-stream.
 */
export function computeThumbnailOffset(duration: number): number {
  return duration >= 3 ? 3 : 0;
}
