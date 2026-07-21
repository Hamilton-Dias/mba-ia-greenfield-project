import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { Channel } from '../../channels/entities/channel.entity';
import { User } from '../../users/entities/user.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { Video, VideoStatus } from './video.entity';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await dataSource.query('DELETE FROM "videos"');
    await cleanAllTables(dataSource);
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await dataSource.query('DELETE FROM "videos"');
    await cleanAllTables(dataSource);
  });

  let userCounter = 0;
  async function createChannel(): Promise<Channel> {
    const user = await userRepository.save(
      userRepository.create({
        email: `video_user_${++userCounter}@example.com`,
        password: 'hashed',
      }),
    );
    return channelRepository.save(
      channelRepository.create({
        name: 'Channel',
        nickname: `video_chan_${userCounter}`,
        user_id: user.id,
      }),
    );
  }

  function buildVideo(
    channelId: string,
    overrides: Partial<Video> = {},
  ): Partial<Video> {
    return {
      channelId,
      originalFilename: 'my-video.mp4',
      storageKey: 'videos/some-id/original',
      ...overrides,
    };
  }

  it('should persist a video with defaults applied', async () => {
    const channel = await createChannel();
    const video = await videoRepository.save(
      videoRepository.create(buildVideo(channel.id)),
    );

    expect(video.id).toBeDefined();
    expect(video.status).toBe(VideoStatus.DRAFT);
    expect(video.duration).toBeNull();
    expect(video.thumbnailKey).toBeNull();
    expect(video.error_message).toBeNull();
    expect(video.created_at).toBeInstanceOf(Date);
    expect(video.updated_at).toBeInstanceOf(Date);
  });

  it('should enforce the channelId foreign key constraint', async () => {
    const video = videoRepository.create(
      buildVideo('00000000-0000-0000-0000-000000000000'),
    );

    await expect(videoRepository.save(video)).rejects.toThrow();
  });

  it('should accept each of the four valid status values', async () => {
    const channel = await createChannel();

    for (const status of [
      VideoStatus.DRAFT,
      VideoStatus.PROCESSING,
      VideoStatus.READY,
      VideoStatus.ERROR,
    ]) {
      const video = await videoRepository.save(
        videoRepository.create(buildVideo(channel.id, { status })),
      );
      expect(video.status).toBe(status);
    }
  });

  it('should reject an invalid enum value for status', async () => {
    const channel = await createChannel();
    const video = videoRepository.create({
      ...buildVideo(channel.id),
      status: 'invalid_status' as VideoStatus,
    });

    await expect(videoRepository.save(video)).rejects.toThrow();
  });

  it('should allow duration, thumbnailKey, and error_message to be set', async () => {
    const channel = await createChannel();
    const video = await videoRepository.save(
      videoRepository.create(
        buildVideo(channel.id, {
          status: VideoStatus.READY,
          duration: 12.5,
          thumbnailKey: 'videos/some-id/thumbnail.jpg',
        }),
      ),
    );

    expect(video.duration).toBe(12.5);
    expect(video.thumbnailKey).toBe('videos/some-id/thumbnail.jpg');

    const errored = await videoRepository.save(
      videoRepository.create(
        buildVideo(channel.id, {
          status: VideoStatus.ERROR,
          error_message: 'ffprobe failed',
        }),
      ),
    );

    expect(errored.error_message).toBe('ffprobe failed');
  });

  it('should load the related channel via the ManyToOne relation', async () => {
    const channel = await createChannel();
    await videoRepository.save(videoRepository.create(buildVideo(channel.id)));

    const found = await videoRepository.findOne({
      where: { channelId: channel.id },
      relations: ['channel'],
    });

    expect(found?.channel.id).toBe(channel.id);
  });
});
