import { randomUUID } from 'crypto';
import { readFile, unlink } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

/**
 * Generates a real, tiny synthetic .mp4 via ffmpeg's `testsrc` lavfi source —
 * no external downloads needed. Used by integration tests that need to exercise
 * real ffprobe/ffmpeg processing end-to-end (see video.processor.integration-spec.ts).
 * Requires the `ffmpeg` binary to be available on PATH (present in the
 * video-worker container per its Dockerfile, not in the nestjs-api container).
 */
export async function generateSyntheticVideo(
  durationSeconds: number,
): Promise<Buffer> {
  const { execa } = await import('execa');
  const outputPath = join(tmpdir(), `synthetic-video-${randomUUID()}.mp4`);

  await execa('ffmpeg', [
    '-f',
    'lavfi',
    '-i',
    `testsrc=duration=${durationSeconds}:size=320x240:rate=10`,
    '-pix_fmt',
    'yuv420p',
    outputPath,
  ]);

  try {
    return await readFile(outputPath);
  } finally {
    await unlink(outputPath).catch(() => undefined);
  }
}
