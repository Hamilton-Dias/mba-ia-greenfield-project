import {
  AbortMultipartUploadCommand,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import type { Queue } from 'bullmq';
import { randomUUID } from 'crypto';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { ChannelsService } from '../channels/channels.service';
import { Channel } from '../channels/entities/channel.entity';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import { QueueModule } from '../queue/queue.module';
import { VideoQueueService } from '../queue/video-queue.service';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { CreateVideoDto } from './dto/create-video.dto';
import { Video, VideoStatus } from './entities/video.entity';
import { UploadVerificationFailedException } from './exceptions/upload-verification-failed.exception';
import { VideoNotFoundException } from './exceptions/video-not-found.exception';
import { VideosService } from './videos.service';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

const rawAdminClient = new S3Client({
  endpoint: process.env.STORAGE_INTERNAL_ENDPOINT,
  region: 'us-east-1',
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.STORAGE_ACCESS_KEY as string,
    secretAccessKey: process.env.STORAGE_SECRET_KEY as string,
  },
});

describe('VideosService (integration)', () => {
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;
  let channelsService: ChannelsService;
  let storageModule: TestingModule;
  let storageService: StorageService;
  let queueModule: TestingModule;
  let videoQueueService: VideoQueueService;
  let videoProcessingQueue: Queue;
  let service: VideosService;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
    channelsService = new ChannelsService(dataSource, channelRepository);

    storageModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
    }).compile();
    storageService = storageModule.get(StorageService);
    await storageModule.init();

    queueModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [queueConfig] }),
        QueueModule,
      ],
    }).compile();
    videoQueueService = queueModule.get(VideoQueueService);
    videoProcessingQueue = queueModule.get(getQueueToken('video-processing'));
    await queueModule.init();

    service = new VideosService(
      videoRepository,
      channelsService,
      storageService,
      videoQueueService,
    );
  }, 30000);

  afterAll(async () => {
    await dataSource.query('DELETE FROM "videos"');
    await cleanAllTables(dataSource);
    await dataSource.destroy();
    await storageModule.close();
    await queueModule.close();
  });

  beforeEach(async () => {
    await dataSource.query('DELETE FROM "videos"');
    await cleanAllTables(dataSource);
  });

  let userCounter = 0;
  async function createChannel(): Promise<Channel> {
    const user = await userRepository.save(
      userRepository.create({
        email: `video_svc_${++userCounter}@example.com`,
        password: 'hashed',
      }),
    );
    return channelRepository.save(
      channelRepository.create({
        name: 'Channel',
        nickname: `video_svc_chan_${userCounter}`,
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

  function makeDto(overrides: Partial<CreateVideoDto> = {}): CreateVideoDto {
    return {
      originalFilename: 'my-video.mp4',
      fileSize: 1024,
      ...overrides,
    } as CreateVideoDto;
  }

  describe('createDraft', () => {
    it('persists a videos row with status=draft, correct channelId and originalFilename', async () => {
      const channel = await createChannel();

      const result = await service.createDraft(
        channel.user_id,
        makeDto({ originalFilename: 'holiday.mp4' }),
      );

      const persisted = await videoRepository.findOneBy({ id: result.id });
      expect(persisted).not.toBeNull();
      expect(persisted!.status).toBe(VideoStatus.DRAFT);
      expect(persisted!.channelId).toBe(channel.id);
      expect(persisted!.originalFilename).toBe('holiday.mp4');
      expect(persisted!.storageKey).toBe(`videos/${result.id}/original`);
    });

    it('returns a single-PUT presigned URL for files at or below the 100MB threshold', async () => {
      const channel = await createChannel();

      const result = await service.createDraft(
        channel.user_id,
        makeDto({ fileSize: 1024 }),
      );

      expect(result.upload.type).toBe('single');
      if (result.upload.type === 'single') {
        expect(result.upload.url).toEqual(expect.any(String));
      }
    });

    it('creates a real MinIO multipart upload for files above the 100MB threshold', async () => {
      const channel = await createChannel();

      const result = await service.createDraft(
        channel.user_id,
        makeDto({ fileSize: 150 * 1024 * 1024 }),
      );

      expect(result.upload.type).toBe('multipart');
      if (result.upload.type !== 'multipart') {
        throw new Error('expected multipart upload');
      }
      expect(result.upload.parts).toHaveLength(3);

      // Verify the multipart upload is real against the actual MinIO instance —
      // ListPartsCommand only succeeds against a live, still-open upload.
      const storageKey = `videos/${result.id}/original`;
      await expect(
        rawAdminClient.send(
          new ListPartsCommand({
            Bucket: process.env.STORAGE_BUCKET,
            Key: storageKey,
            UploadId: result.upload.uploadId,
          }),
        ),
      ).resolves.toBeDefined();

      await rawAdminClient.send(
        new AbortMultipartUploadCommand({
          Bucket: process.env.STORAGE_BUCKET,
          Key: storageKey,
          UploadId: result.upload.uploadId,
        }),
      );
    }, 30000);

    it('resolves the channel from the userId rather than any client-supplied value', async () => {
      const channel = await createChannel();

      const result = await service.createDraft(channel.user_id, makeDto());

      const persisted = await videoRepository.findOneBy({ id: result.id });
      expect(persisted!.channelId).toBe(channel.id);
    });
  });

  describe('completeUpload', () => {
    async function findEnqueuedJob(videoId: string) {
      const jobs = await videoProcessingQueue.getJobs([
        'waiting',
        'delayed',
        'active',
        'completed',
      ]);
      return jobs.find(
        (job) => (job.data as { videoId: string }).videoId === videoId,
      );
    }

    it('persists status=processing and enqueues a job after a real single-PUT completion', async () => {
      const channel = await createChannel();
      const video = await createDraftVideo(channel);

      await rawAdminClient.send(
        new PutObjectCommand({
          Bucket: process.env.STORAGE_BUCKET,
          Key: video.storageKey,
          Body: Buffer.from('real uploaded content'),
        }),
      );

      const result = await service.completeUpload(
        channel.user_id,
        video.id,
        {} as CompleteUploadDto,
      );

      expect(result).toEqual({ id: video.id, status: VideoStatus.PROCESSING });

      const persisted = await videoRepository.findOneBy({ id: video.id });
      expect(persisted!.status).toBe(VideoStatus.PROCESSING);

      const job = await findEnqueuedJob(video.id);
      expect(job).toBeDefined();
    }, 20000);

    it('persists status=processing and enqueues a job after a real multipart completion', async () => {
      const channel = await createChannel();
      const video = await createDraftVideo(channel);

      const uploadId = await storageService.createMultipartUpload(
        video.storageKey,
      );
      const partResult = await rawAdminClient.send(
        new UploadPartCommand({
          Bucket: process.env.STORAGE_BUCKET,
          Key: video.storageKey,
          UploadId: uploadId,
          PartNumber: 1,
          Body: Buffer.from('real uploaded multipart content'),
        }),
      );

      const dto: CompleteUploadDto = {
        uploadId,
        parts: [{ partNumber: 1, eTag: partResult.ETag as string }],
      };

      const result = await service.completeUpload(
        channel.user_id,
        video.id,
        dto,
      );

      expect(result).toEqual({ id: video.id, status: VideoStatus.PROCESSING });

      const persisted = await videoRepository.findOneBy({ id: video.id });
      expect(persisted!.status).toBe(VideoStatus.PROCESSING);

      const job = await findEnqueuedJob(video.id);
      expect(job).toBeDefined();
    }, 20000);

    it('throws UploadVerificationFailedException when the object was never actually uploaded', async () => {
      const channel = await createChannel();
      const video = await createDraftVideo(channel);

      await expect(
        service.completeUpload(
          channel.user_id,
          video.id,
          {} as CompleteUploadDto,
        ),
      ).rejects.toThrow(UploadVerificationFailedException);
    });

    it('throws VideoNotFoundException on ownership mismatch', async () => {
      const channel = await createChannel();
      const otherChannel = await createChannel();
      const video = await createDraftVideo(channel);

      await expect(
        service.completeUpload(
          otherChannel.user_id,
          video.id,
          {} as CompleteUploadDto,
        ),
      ).rejects.toThrow(VideoNotFoundException);
    });

    it('throws VideoNotFoundException for an unknown video id', async () => {
      const channel = await createChannel();

      await expect(
        service.completeUpload(
          channel.user_id,
          randomUUID(),
          {} as CompleteUploadDto,
        ),
      ).rejects.toThrow(VideoNotFoundException);
    });
  });
});
