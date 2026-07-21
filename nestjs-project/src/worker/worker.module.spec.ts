import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { StorageService } from '../storage/storage.service';
import { Video } from '../videos/entities/video.entity';
import { WorkerModule } from './worker.module';

describe('WorkerModule', () => {
  it('compiles with TypeOrmModule.forRootAsync, TypeOrmModule.forFeature([Video]), StorageModule, and BullModule wiring', async () => {
    const module = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();

    expect(module).toBeDefined();
    expect(module.get(StorageService)).toBeInstanceOf(StorageService);
    expect(module.get(getRepositoryToken(Video))).toBeInstanceOf(Repository);

    await module.close();
  }, 30000);
});
