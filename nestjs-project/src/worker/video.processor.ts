import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Job } from 'bullmq';
import { randomUUID } from 'crypto';
import { createWriteStream } from 'fs';
import { readFile, unlink } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { pipeline } from 'stream/promises';
import { Repository } from 'typeorm';
import { StorageService } from '../storage/storage.service';
import { Video, VideoStatus } from '../videos/entities/video.entity';
import { VideoNotFoundException } from '../videos/exceptions/video-not-found.exception';
import { computeThumbnailOffset } from './thumbnail-offset.util';

export interface VideoProcessingJobData {
  videoId: string;
}

interface FfprobeOutput {
  format: {
    duration?: string;
  };
}

/**
 * BullMQ job handler for the `video-processing` queue. Downloads the uploaded
 * source object, inspects it with ffprobe, captures a thumbnail with ffmpeg,
 * and writes the phase's terminal success/failure states atomically (TD-04).
 */
@Injectable()
@Processor('video-processing')
export class VideoProcessor extends WorkerHost {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storageService: StorageService,
  ) {
    super();
  }

  async process(job: Job<VideoProcessingJobData>): Promise<void> {
    const { videoId } = job.data;
    const video = await this.videoRepository.findOneBy({ id: videoId });
    if (!video) {
      throw new VideoNotFoundException();
    }

    // Idempotent: the same write whether this is attempt 1 or a BullMQ retry.
    await this.videoRepository.update(video.id, {
      status: VideoStatus.PROCESSING,
    });

    const inputPath = join(tmpdir(), `video-processing-${randomUUID()}`);
    const thumbnailPath = join(
      tmpdir(),
      `video-processing-${randomUUID()}.jpg`,
    );

    try {
      const sourceBody = await this.storageService.getObjectBody(
        video.storageKey,
      );
      await pipeline(sourceBody, createWriteStream(inputPath));

      const { execa } = await import('execa');

      const { stdout } = await execa('ffprobe', [
        '-print_format',
        'json',
        '-show_format',
        '-show_streams',
        inputPath,
      ]);
      const probe = JSON.parse(stdout) as FfprobeOutput;
      const duration = Number(probe.format.duration);

      const offset = computeThumbnailOffset(duration);
      await execa('ffmpeg', [
        '-ss',
        String(offset),
        '-i',
        inputPath,
        '-vframes',
        '1',
        thumbnailPath,
      ]);

      const thumbnailBuffer = await readFile(thumbnailPath);
      const thumbnailKey = `videos/${video.id}/thumbnail.jpg`;
      await this.storageService.putObject(thumbnailKey, thumbnailBuffer);

      // Single atomic write — status/duration/thumbnailKey land together so no
      // partially-processed state is ever visible (TD-04 success-path clause).
      await this.videoRepository.update(video.id, {
        status: VideoStatus.READY,
        duration,
        thumbnailKey,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Single atomic write for the failure path (TD-04 failure-path clause),
      // then re-throw so BullMQ's attempts/backoff (SI-03.4) governs retry.
      await this.videoRepository.update(video.id, {
        status: VideoStatus.ERROR,
        error_message: message,
      });
      throw err;
    } finally {
      await unlink(inputPath).catch(() => undefined);
      await unlink(thumbnailPath).catch(() => undefined);
    }
  }
}
