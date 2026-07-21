import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { Queue } from 'bullmq';

@Injectable()
export class VideoQueueService {
  constructor(@InjectQueue('video-processing') private readonly queue: Queue) {}

  async enqueueProcessing(videoId: string): Promise<void> {
    await this.queue.add(
      'process-video',
      { videoId },
      {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
      },
    );
  }
}
