import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { Repository } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import { StorageService } from '../storage/storage.service';
import { CreateVideoDto } from './dto/create-video.dto';
import { Video, VideoStatus } from './entities/video.entity';

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

@Injectable()
export class VideosService {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly channelsService: ChannelsService,
    private readonly storageService: StorageService,
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
}
