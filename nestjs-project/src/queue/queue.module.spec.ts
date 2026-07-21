import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import queueConfig from '../config/queue.config';
import { QueueModule } from './queue.module';
import { VideoQueueService } from './video-queue.service';

describe('QueueModule', () => {
  it('compiles standalone with BullMQ forRootAsync + registerQueue wiring', async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [queueConfig] }),
        QueueModule,
      ],
    }).compile();

    expect(module).toBeDefined();
    expect(module.get(VideoQueueService)).toBeInstanceOf(VideoQueueService);

    await module.close();
  }, 15000);
});
