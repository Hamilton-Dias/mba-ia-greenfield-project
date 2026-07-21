import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { Repository } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import { VideoQueueService } from '../queue/video-queue.service';
import { StorageService } from '../storage/storage.service';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { CreateVideoDto } from './dto/create-video.dto';
import { Video, VideoStatus } from './entities/video.entity';
import { UploadVerificationFailedException } from './exceptions/upload-verification-failed.exception';
import { VideoNotFoundException } from './exceptions/video-not-found.exception';

const MULTIPART_THRESHOLD_BYTES = 104857600; // 100MB
const MULTIPART_PART_SIZE_BYTES = 50 * 1024 * 1024; // 50MB

export interface SingleUploadHandshake {
  type: 'single';
  url: string;
}

export interface MultipartUploadPartHandshake {
  partNumber: number;
  url: string;
}

export interface MultipartUploadHandshake {
  type: 'multipart';
  uploadId: string;
  parts: MultipartUploadPartHandshake[];
}

export type UploadHandshake = SingleUploadHandshake | MultipartUploadHandshake;

export interface CreateDraftResult {
  id: string;
  status: VideoStatus;
  upload: UploadHandshake;
}

export interface CompleteUploadResult {
  id: string;
  status: VideoStatus;
}

@Injectable()
export class VideosService {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly channelsService: ChannelsService,
    private readonly storageService: StorageService,
    private readonly videoQueueService: VideoQueueService,
  ) {}

  async createDraft(
    userId: string,
    dto: CreateVideoDto,
  ): Promise<CreateDraftResult> {
    const channel = await this.channelsService.findByUserId(userId);
    if (!channel) {
      throw new Error(
        'No channel found for the authenticated user — every user gets a channel at registration',
      );
    }

    const id = randomUUID();
    const storageKey = `videos/${id}/original`;

    const video = this.videoRepository.create({
      id,
      channelId: channel.id,
      originalFilename: dto.originalFilename,
      storageKey,
      status: VideoStatus.DRAFT,
    });
    const saved = await this.videoRepository.save(video);

    const upload =
      dto.fileSize > MULTIPART_THRESHOLD_BYTES
        ? await this.createMultipartHandshake(storageKey, dto.fileSize)
        : await this.createSingleHandshake(storageKey);

    return { id: saved.id, status: saved.status, upload };
  }

  private async createSingleHandshake(
    storageKey: string,
  ): Promise<SingleUploadHandshake> {
    const url = await this.storageService.presignPutObject(storageKey);
    return { type: 'single', url };
  }

  private async createMultipartHandshake(
    storageKey: string,
    fileSize: number,
  ): Promise<MultipartUploadHandshake> {
    const uploadId =
      await this.storageService.createMultipartUpload(storageKey);
    const partCount = Math.ceil(fileSize / MULTIPART_PART_SIZE_BYTES);
    const parts: MultipartUploadPartHandshake[] = [];

    for (let partNumber = 1; partNumber <= partCount; partNumber++) {
      const url = await this.storageService.presignUploadPart(
        storageKey,
        uploadId,
        partNumber,
      );
      parts.push({ partNumber, url });
    }

    return { type: 'multipart', uploadId, parts };
  }

  async completeUpload(
    userId: string,
    videoId: string,
    dto: CompleteUploadDto,
  ): Promise<CompleteUploadResult> {
    const video = await this.videoRepository.findOneBy({ id: videoId });
    const channel = await this.channelsService.findByUserId(userId);

    // Ownership mismatch reads as "not found", never as a distinct 403 (TD-04).
    if (!video || !channel || video.channelId !== channel.id) {
      throw new VideoNotFoundException();
    }

    if (dto.uploadId) {
      // A successful completion IS the existence proof — no follow-up HeadObject.
      await this.storageService.completeMultipartUpload(
        video.storageKey,
        dto.uploadId,
        dto.parts ?? [],
      );
    } else {
      try {
        await this.storageService.headObject(video.storageKey);
      } catch (err) {
        if (this.isNotFoundError(err)) {
          throw new UploadVerificationFailedException();
        }
        throw err;
      }
    }

    video.status = VideoStatus.PROCESSING;
    await this.videoRepository.save(video);
    await this.videoQueueService.enqueueProcessing(video.id);

    return { id: video.id, status: video.status };
  }

  async getStreamUrl(videoId: string): Promise<{ url: string }> {
    const video = await this.videoRepository.findOneBy({ id: videoId });

    if (!video || video.status !== VideoStatus.READY) {
      throw new VideoNotFoundException();
    }

    const url = await this.storageService.presignGetObject(video.storageKey);
    return { url };
  }

  async getDownloadUrl(videoId: string): Promise<{ url: string }> {
    const video = await this.videoRepository.findOneBy({ id: videoId });

    if (!video || video.status !== VideoStatus.READY) {
      throw new VideoNotFoundException();
    }

    const url = await this.storageService.presignGetObject(video.storageKey, {
      download: true,
      filename: video.originalFilename,
    });
    return { url };
  }

  private isNotFoundError(err: unknown): boolean {
    const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
    return e?.name === 'NotFound' || e?.$metadata?.httpStatusCode === 404;
  }
}
