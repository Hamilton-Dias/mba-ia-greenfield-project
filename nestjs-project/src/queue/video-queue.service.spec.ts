import { Queue } from 'bullmq';
import { VideoQueueService } from './video-queue.service';

function makeQueue(): { add: jest.Mock } & Queue {
  return {
    add: jest.fn().mockResolvedValue(undefined),
  } as unknown as { add: jest.Mock } & Queue;
}

describe('VideoQueueService', () => {
  describe('enqueueProcessing', () => {
    it('adds a process-video job with the videoId payload and retry policy', async () => {
      const queue = makeQueue();
      const service = new VideoQueueService(queue);

      await service.enqueueProcessing('video-id');

      expect(queue.add).toHaveBeenCalledWith(
        'process-video',
        { videoId: 'video-id' },
        {
          attempts: 3,
          backoff: { type: 'exponential', delay: 5000 },
        },
      );
    });

    it('calls queue.add exactly once per invocation', async () => {
      const queue = makeQueue();
      const service = new VideoQueueService(queue);

      await service.enqueueProcessing('another-video-id');

      expect(queue.add).toHaveBeenCalledTimes(1);
    });
  });
});
