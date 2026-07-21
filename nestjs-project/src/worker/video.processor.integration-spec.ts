import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import type { Job } from 'bullmq';
import { randomUUID } from 'crypto';
import { DataSource, Repository } from 'typeorm';
import { Channel } from '../channels/entities/channel.entity';
import storageConfig from '../config/storage.config';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import { generateSyntheticVideo } from '../test/generate-synthetic-video';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video, VideoStatus } from '../videos/entities/video.entity';
import { computeThumbnailOffset } from './thumbnail-offset.util';
import { VideoProcessor, VideoProcessingJobData } from './video.processor';

// Video has a relation to Channel, which has a relation to User — TypeORM builds
// relation metadata eagerly, so all three must be registered even though this
// spec only ever reads/writes the `videos` table directly (same requirement
// SI-03.7 hit when bootstrapping WorkerModule itself).
const ALL_ENTITIES = [User, Channel, Video];

const rawAdminClient = new S3Client({
  endpoint: process.env.STORAGE_INTERNAL_ENDPOINT,
  region: 'us-east-1',
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.STORAGE_ACCESS_KEY as string,
    secretAccessKey: process.env.STORAGE_SECRET_KEY as string,
  },
});

function makeJob(videoId: string): Job<VideoProcessingJobData> {
  return { data: { videoId } } as Job<VideoProcessingJobData>;
}

describe('VideoProcessor (integration)', () => {
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;
  let storageModule: TestingModule;
  let storageService: StorageService;
  let processor: VideoProcessor;

  let longVideo: Buffer; // >=3s — should thumbnail at the 3s offset
  let shortVideo: Buffer; // <3s — should clamp to the 0s offset

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);

    storageModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
    }).compile();
    storageService = storageModule.get(StorageService);
    await storageModule.init();

    processor = new VideoProcessor(videoRepository, storageService);

    [longVideo, shortVideo] = await Promise.all([
      generateSyntheticVideo(5),
      generateSyntheticVideo(1),
    ]);
  }, 60000);

  afterAll(async () => {
    await dataSource.query('DELETE FROM "videos"');
    await cleanAllTables(dataSource);
    await dataSource.destroy();
    await storageModule.close();
  });

  beforeEach(async () => {
    await dataSource.query('DELETE FROM "videos"');
    await cleanAllTables(dataSource);
  });

  let userCounter = 0;
  async function createChannel(): Promise<Channel> {
    const user = await userRepository.save(
      userRepository.create({
        email: `video_proc_${++userCounter}@example.com`,
        password: 'hashed',
      }),
    );
    return channelRepository.save(
      channelRepository.create({
        name: 'Channel',
        nickname: `video_proc_chan_${userCounter}`,
        user_id: user.id,
      }),
    );
  }

  async function createDraftVideo(
    channel: Channel,
    overrides: Partial<Video> = {},
  ): Promise<Video> {
    const id = randomUUID();
    return videoRepository.save(
      videoRepository.create({
        id,
        channelId: channel.id,
        originalFilename: 'my-video.mp4',
        storageKey: `videos/${id}/original`,
        status: VideoStatus.DRAFT,
        ...overrides,
      }),
    );
  }

  async function uploadSource(video: Video, body: Buffer): Promise<void> {
    await rawAdminClient.send(
      new PutObjectCommand({
        Bucket: process.env.STORAGE_BUCKET,
        Key: video.storageKey,
        Body: body,
      }),
    );
  }

  it('success path: >=3s video lands status=ready with duration and thumbnailKey in one write', async () => {
    const channel = await createChannel();
    const video = await createDraftVideo(channel);
    await uploadSource(video, longVideo);

    const updateSpy = jest.spyOn(videoRepository, 'update');

    await processor.process(makeJob(video.id));

    // Exactly two writes: processing, then the single atomic ready write.
    expect(updateSpy).toHaveBeenCalledTimes(2);
    expect(updateSpy).toHaveBeenNthCalledWith(
      1,
      video.id,
      expect.objectContaining({ status: VideoStatus.PROCESSING }),
    );
    expect(updateSpy).toHaveBeenNthCalledWith(
      2,
      video.id,
      expect.objectContaining({
        status: VideoStatus.READY,
        duration: expect.any(Number) as number,
        thumbnailKey: `videos/${video.id}/thumbnail.jpg`,
      }),
    );
    updateSpy.mockRestore();

    const persisted = await videoRepository.findOneBy({ id: video.id });
    expect(persisted!.status).toBe(VideoStatus.READY);
    expect(persisted!.duration).not.toBeNull();
    expect(persisted!.duration).toBeGreaterThanOrEqual(4);
    expect(persisted!.thumbnailKey).toBe(`videos/${video.id}/thumbnail.jpg`);
    expect(computeThumbnailOffset(persisted!.duration as number)).toBe(3);

    // The thumbnail is a real object written to storage, not just a DB pointer.
    const head = await storageService.headObject(persisted!.thumbnailKey!);
    expect(head.ContentLength).toBeGreaterThan(0);
  }, 30000);

  it('success path: <3s video still processes to ready, using the clamped 0s offset', async () => {
    const channel = await createChannel();
    const video = await createDraftVideo(channel);
    await uploadSource(video, shortVideo);

    await processor.process(makeJob(video.id));

    const persisted = await videoRepository.findOneBy({ id: video.id });
    expect(persisted!.status).toBe(VideoStatus.READY);
    expect(persisted!.duration).not.toBeNull();
    expect(persisted!.duration).toBeLessThan(3);
    expect(computeThumbnailOffset(persisted!.duration as number)).toBe(0);
    expect(persisted!.thumbnailKey).toBe(`videos/${video.id}/thumbnail.jpg`);

    // A -ss 3 seek would have failed to produce a frame on a <3s source, so a
    // successful, non-empty thumbnail here is proof the 0s clamp was used.
    const head = await storageService.headObject(persisted!.thumbnailKey!);
    expect(head.ContentLength).toBeGreaterThan(0);
  }, 30000);

  it('failure path: corrupt/unreadable source lands status=error with error_message and re-throws', async () => {
    const channel = await createChannel();
    const video = await createDraftVideo(channel);
    await uploadSource(video, Buffer.from('this is not a video file'));

    const updateSpy = jest.spyOn(videoRepository, 'update');

    await expect(processor.process(makeJob(video.id))).rejects.toThrow();

    expect(updateSpy).toHaveBeenCalledTimes(2);
    expect(updateSpy).toHaveBeenNthCalledWith(
      1,
      video.id,
      expect.objectContaining({ status: VideoStatus.PROCESSING }),
    );
    expect(updateSpy).toHaveBeenNthCalledWith(
      2,
      video.id,
      expect.objectContaining({
        status: VideoStatus.ERROR,
        error_message: expect.any(String) as string,
      }),
    );
    updateSpy.mockRestore();

    const persisted = await videoRepository.findOneBy({ id: video.id });
    expect(persisted!.status).toBe(VideoStatus.ERROR);
    expect(persisted!.error_message).toBeTruthy();
  }, 30000);

  it('resets status=processing at the start of every retry attempt, and stays error after the 3rd failed attempt', async () => {
    const channel = await createChannel();
    const video = await createDraftVideo(channel);
    await uploadSource(video, Buffer.from('still not a video file'));

    // The processor itself doesn't count attempts (BullMQ does) — so we invoke
    // process() 3 times directly, simulating BullMQ's configured `attempts: 3`,
    // and assert the per-attempt idempotent processing->error transition holds
    // on every single call, not just the first.
    for (let attempt = 1; attempt <= 3; attempt++) {
      const updateSpy = jest.spyOn(videoRepository, 'update');

      await expect(processor.process(makeJob(video.id))).rejects.toThrow();

      expect(updateSpy).toHaveBeenNthCalledWith(
        1,
        video.id,
        expect.objectContaining({ status: VideoStatus.PROCESSING }),
      );
      expect(updateSpy).toHaveBeenNthCalledWith(
        2,
        video.id,
        expect.objectContaining({ status: VideoStatus.ERROR }),
      );
      updateSpy.mockRestore();
    }

    // After the 3rd failed attempt, the error state persists — no further
    // automatic retry happens at the processor level.
    const persisted = await videoRepository.findOneBy({ id: video.id });
    expect(persisted!.status).toBe(VideoStatus.ERROR);
    expect(persisted!.error_message).toBeTruthy();
  }, 45000);
});
