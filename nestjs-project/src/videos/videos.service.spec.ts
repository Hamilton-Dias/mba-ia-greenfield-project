import { Repository } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import { Channel } from '../channels/entities/channel.entity';
import { VideoQueueService } from '../queue/video-queue.service';
import { StorageService } from '../storage/storage.service';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { CreateVideoDto } from './dto/create-video.dto';
import { Video, VideoStatus } from './entities/video.entity';
import { UploadVerificationFailedException } from './exceptions/upload-verification-failed.exception';
import { VideoNotFoundException } from './exceptions/video-not-found.exception';
import { VideosService } from './videos.service';

function makeChannel(): Channel {
  const channel = new Channel();
  channel.id = 'channel-id';
  channel.name = 'Channel';
  channel.nickname = 'channel';
  channel.user_id = 'user-id';
  channel.description = null;
  channel.created_at = new Date();
  channel.updated_at = new Date();
  return channel;
}

function makeDto(overrides: Partial<CreateVideoDto> = {}): CreateVideoDto {
  return {
    originalFilename: 'my-video.mp4',
    fileSize: 1024,
    ...overrides,
  } as CreateVideoDto;
}

function makeVideo(overrides: Partial<Video> = {}): Video {
  return {
    id: 'video-id',
    channelId: 'channel-id',
    originalFilename: 'my-video.mp4',
    storageKey: 'videos/video-id/original',
    status: VideoStatus.DRAFT,
    duration: null,
    thumbnailKey: null,
    error_message: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  } as Video;
}

interface Setup {
  service: VideosService;
  createMock: jest.Mock;
  saveMock: jest.Mock;
  findOneByMock: jest.Mock;
  findByUserIdMock: jest.Mock;
  presignPutObjectMock: jest.Mock;
  createMultipartUploadMock: jest.Mock;
  presignUploadPartMock: jest.Mock;
  completeMultipartUploadMock: jest.Mock;
  headObjectMock: jest.Mock;
  enqueueProcessingMock: jest.Mock;
}

function setup(
  options: {
    channel?: Channel | null;
    video?: Video | null;
    presignPutObjectMock?: jest.Mock;
    createMultipartUploadMock?: jest.Mock;
    presignUploadPartMock?: jest.Mock;
    completeMultipartUploadMock?: jest.Mock;
    headObjectMock?: jest.Mock;
  } = {},
): Setup {
  const createMock = jest.fn((data: Partial<Video>) => data as Video);
  const saveMock = jest.fn((data: Partial<Video>) =>
    Promise.resolve(data as Video),
  );
  const video = 'video' in options ? options.video : makeVideo();
  const findOneByMock = jest.fn().mockResolvedValue(video);
  const videoRepository = {
    create: createMock,
    save: saveMock,
    findOneBy: findOneByMock,
  } as unknown as Repository<Video>;

  const channel = 'channel' in options ? options.channel : makeChannel();
  const findByUserIdMock = jest.fn().mockResolvedValue(channel);
  const channelsService = {
    findByUserId: findByUserIdMock,
  } as unknown as ChannelsService;

  const presignPutObjectMock = options.presignPutObjectMock ?? jest.fn();
  const createMultipartUploadMock =
    options.createMultipartUploadMock ?? jest.fn();
  const presignUploadPartMock = options.presignUploadPartMock ?? jest.fn();
  const completeMultipartUploadMock =
    options.completeMultipartUploadMock ??
    jest.fn().mockResolvedValue(undefined);
  const headObjectMock =
    options.headObjectMock ?? jest.fn().mockResolvedValue({});
  const storageService = {
    presignPutObject: presignPutObjectMock,
    createMultipartUpload: createMultipartUploadMock,
    presignUploadPart: presignUploadPartMock,
    completeMultipartUpload: completeMultipartUploadMock,
    headObject: headObjectMock,
  } as unknown as StorageService;

  const enqueueProcessingMock = jest.fn().mockResolvedValue(undefined);
  const videoQueueService = {
    enqueueProcessing: enqueueProcessingMock,
  } as unknown as VideoQueueService;

  const service = new VideosService(
    videoRepository,
    channelsService,
    storageService,
    videoQueueService,
  );

  return {
    service,
    createMock,
    saveMock,
    findOneByMock,
    findByUserIdMock,
    presignPutObjectMock,
    createMultipartUploadMock,
    presignUploadPartMock,
    completeMultipartUploadMock,
    headObjectMock,
    enqueueProcessingMock,
  };
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const STORAGE_KEY_PATTERN = new RegExp(
  `^videos/${UUID_PATTERN.source.slice(1, -1)}/original$`,
);

describe('VideosService', () => {
  describe('createDraft', () => {
    it('resolves the channel from the userId, never from the request body', async () => {
      const channel = makeChannel();
      const { service, findByUserIdMock, createMock, presignPutObjectMock } =
        setup({
          channel,
          presignPutObjectMock: jest
            .fn()
            .mockResolvedValue('https://signed-url'),
        });

      await service.createDraft('user-id', makeDto());

      expect(findByUserIdMock).toHaveBeenCalledWith('user-id');
      expect(createMock).toHaveBeenCalledWith(
        expect.objectContaining({ channelId: channel.id }),
      );
      expect(presignPutObjectMock).toHaveBeenCalled();
    });

    it('computes storageKey as videos/{id}/original', async () => {
      const { service, createMock } = setup({
        presignPutObjectMock: jest.fn().mockResolvedValue('https://signed-url'),
      });

      const result = await service.createDraft('user-id', makeDto());

      expect(result.id).toMatch(UUID_PATTERN);
      expect(result.status).toBe(VideoStatus.DRAFT);
      const calls = createMock.mock.calls as [Partial<Video>][];
      const createdArg = calls[0][0];
      expect(createdArg.storageKey).toMatch(STORAGE_KEY_PATTERN);
      expect(createdArg.storageKey).toBe(`videos/${createdArg.id}/original`);
    });

    it('picks the single-PUT path when fileSize is at or below the 100MB threshold', async () => {
      const presignPutObjectMock = jest
        .fn()
        .mockResolvedValue('https://signed-url');
      const { service, createMultipartUploadMock } = setup({
        presignPutObjectMock,
      });

      const result = await service.createDraft(
        'user-id',
        makeDto({ fileSize: 104857600 }),
      );

      expect(presignPutObjectMock).toHaveBeenCalledTimes(1);
      expect(createMultipartUploadMock).not.toHaveBeenCalled();
      expect(result.upload).toEqual({
        type: 'single',
        url: 'https://signed-url',
      });
    });

    it('picks the multipart path when fileSize exceeds the 100MB threshold, one presigned URL per 50MB part', async () => {
      const presignPutObjectMock = jest.fn();
      const createMultipartUploadMock = jest
        .fn()
        .mockResolvedValue('upload-id');
      const presignUploadPartMock = jest
        .fn()
        .mockImplementation(
          (_key: string, _uploadId: string, partNumber: number) =>
            Promise.resolve(`https://signed-part-${partNumber}`),
        );
      const { service } = setup({
        presignPutObjectMock,
        createMultipartUploadMock,
        presignUploadPartMock,
      });

      // 150MB -> 3 parts of 50MB each
      const result = await service.createDraft(
        'user-id',
        makeDto({ fileSize: 150 * 1024 * 1024 }),
      );

      expect(presignPutObjectMock).not.toHaveBeenCalled();
      expect(createMultipartUploadMock).toHaveBeenCalledTimes(1);
      expect(presignUploadPartMock).toHaveBeenCalledTimes(3);
      expect(result.upload).toEqual({
        type: 'multipart',
        uploadId: 'upload-id',
        parts: [
          { partNumber: 1, url: 'https://signed-part-1' },
          { partNumber: 2, url: 'https://signed-part-2' },
          { partNumber: 3, url: 'https://signed-part-3' },
        ],
      });
    });

    it('throws when the authenticated user has no channel', async () => {
      const { service } = setup({ channel: null });

      await expect(service.createDraft('user-id', makeDto())).rejects.toThrow();
    });
  });

  describe('completeUpload', () => {
    function makeCompleteUploadDto(
      overrides: Partial<CompleteUploadDto> = {},
    ): CompleteUploadDto {
      return { ...overrides } as CompleteUploadDto;
    }

    it('calls completeMultipartUpload and skips headObject when uploadId is present', async () => {
      const {
        service,
        completeMultipartUploadMock,
        headObjectMock,
        saveMock,
        enqueueProcessingMock,
      } = setup();
      const dto = makeCompleteUploadDto({
        uploadId: 'upload-id',
        parts: [{ partNumber: 1, eTag: 'etag-1' }],
      });

      const result = await service.completeUpload('user-id', 'video-id', dto);

      expect(completeMultipartUploadMock).toHaveBeenCalledWith(
        'videos/video-id/original',
        'upload-id',
        [{ partNumber: 1, eTag: 'etag-1' }],
      );
      expect(headObjectMock).not.toHaveBeenCalled();
      expect(saveMock).toHaveBeenCalledWith(
        expect.objectContaining({ status: VideoStatus.PROCESSING }),
      );
      expect(enqueueProcessingMock).toHaveBeenCalledWith('video-id');
      expect(result).toEqual({
        id: 'video-id',
        status: VideoStatus.PROCESSING,
      });
    });

    it('calls headObject and skips completeMultipartUpload when uploadId is absent', async () => {
      const { service, completeMultipartUploadMock, headObjectMock } = setup();
      const dto = makeCompleteUploadDto();

      const result = await service.completeUpload('user-id', 'video-id', dto);

      expect(headObjectMock).toHaveBeenCalledWith('videos/video-id/original');
      expect(completeMultipartUploadMock).not.toHaveBeenCalled();
      expect(result).toEqual({
        id: 'video-id',
        status: VideoStatus.PROCESSING,
      });
    });

    it('throws VideoNotFoundException when the video does not exist', async () => {
      const { service } = setup({ video: null });

      await expect(
        service.completeUpload(
          'user-id',
          'unknown-id',
          makeCompleteUploadDto(),
        ),
      ).rejects.toThrow(VideoNotFoundException);
    });

    it('throws VideoNotFoundException on ownership mismatch (not a distinct 403)', async () => {
      const otherChannel = makeChannel();
      otherChannel.id = 'a-different-channel-id';
      const { service } = setup({ channel: otherChannel });

      await expect(
        service.completeUpload('user-id', 'video-id', makeCompleteUploadDto()),
      ).rejects.toThrow(VideoNotFoundException);
    });

    it('throws UploadVerificationFailedException when headObject reports not-found', async () => {
      const headObjectMock = jest.fn().mockRejectedValue({
        name: 'NotFound',
        $metadata: { httpStatusCode: 404 },
      });
      const { service } = setup({ headObjectMock });

      await expect(
        service.completeUpload('user-id', 'video-id', makeCompleteUploadDto()),
      ).rejects.toThrow(UploadVerificationFailedException);
    });

    it('rethrows unexpected headObject errors as-is', async () => {
      const unexpectedError = new Error('network error');
      const headObjectMock = jest.fn().mockRejectedValue(unexpectedError);
      const { service } = setup({ headObjectMock });

      await expect(
        service.completeUpload('user-id', 'video-id', makeCompleteUploadDto()),
      ).rejects.toThrow(unexpectedError);
    });
  });
});
