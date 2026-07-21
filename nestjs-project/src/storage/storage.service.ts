import {
  CompleteMultipartUploadCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  HeadObjectCommandOutput,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { Readable } from 'stream';
import storageConfig from '../config/storage.config';
import { STORAGE_ADMIN_CLIENT } from './storage.constants';

const PRESIGN_EXPIRES_IN_SECONDS = 3600;

export interface MultipartUploadPart {
  partNumber: number;
  eTag: string;
}

export interface PresignGetObjectOptions {
  download?: boolean;
  filename?: string;
}

@Injectable()
export class StorageService implements OnModuleInit {
  private readonly logger = new Logger(StorageService.name);

  // Lazily constructed on first presign call — must stay undefined until then so a
  // process without STORAGE_PUBLIC_ENDPOINT (the worker) never touches it at boot.
  private presigningClient: S3Client | undefined;

  constructor(
    @Inject(STORAGE_ADMIN_CLIENT) private readonly adminClient: S3Client,
    @Inject(storageConfig.KEY)
    private readonly config: ConfigType<typeof storageConfig>,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.ensureBucketExists();
  }

  async ensureBucketExists(): Promise<void> {
    const bucket = this.config.bucket;
    try {
      await this.adminClient.send(new HeadBucketCommand({ Bucket: bucket }));
    } catch (err) {
      if (this.isNotFoundError(err)) {
        await this.adminClient.send(
          new CreateBucketCommand({ Bucket: bucket }),
        );
        this.logger.log(`Created storage bucket "${bucket}"`);
      } else {
        throw err;
      }
    }
  }

  private isNotFoundError(err: unknown): boolean {
    const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
    return e?.name === 'NotFound' || e?.$metadata?.httpStatusCode === 404;
  }

  private getPresigningClient(): S3Client {
    if (!this.presigningClient) {
      if (!this.config.publicEndpoint) {
        throw new Error(
          'Cannot presign URLs: STORAGE_PUBLIC_ENDPOINT is not configured in this process',
        );
      }
      this.presigningClient = new S3Client({
        endpoint: this.config.publicEndpoint,
        region: 'us-east-1',
        forcePathStyle: true,
        credentials: {
          accessKeyId: this.config.accessKey as string,
          secretAccessKey: this.config.secretKey as string,
        },
      });
    }
    return this.presigningClient;
  }

  async createMultipartUpload(key: string): Promise<string> {
    const result = await this.adminClient.send(
      new CreateMultipartUploadCommand({
        Bucket: this.config.bucket,
        Key: key,
      }),
    );
    if (!result.UploadId) {
      throw new Error(
        'CreateMultipartUploadCommand did not return an UploadId',
      );
    }
    return result.UploadId;
  }

  async presignUploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
  ): Promise<string> {
    const client = this.getPresigningClient();
    return getSignedUrl(
      client,
      new UploadPartCommand({
        Bucket: this.config.bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
      }),
      { expiresIn: PRESIGN_EXPIRES_IN_SECONDS },
    );
  }

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: MultipartUploadPart[],
  ): Promise<void> {
    await this.adminClient.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.config.bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: {
          Parts: parts.map((part) => ({
            PartNumber: part.partNumber,
            ETag: part.eTag,
          })),
        },
      }),
    );
  }

  async presignPutObject(key: string): Promise<string> {
    const client = this.getPresigningClient();
    return getSignedUrl(
      client,
      new PutObjectCommand({ Bucket: this.config.bucket, Key: key }),
      { expiresIn: PRESIGN_EXPIRES_IN_SECONDS },
    );
  }

  async headObject(key: string): Promise<HeadObjectCommandOutput> {
    return this.adminClient.send(
      new HeadObjectCommand({ Bucket: this.config.bucket, Key: key }),
    );
  }

  async presignGetObject(
    key: string,
    options?: PresignGetObjectOptions,
  ): Promise<string> {
    const client = this.getPresigningClient();
    return getSignedUrl(
      client,
      new GetObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
        ...(options?.download
          ? {
              ResponseContentDisposition: `attachment; filename="${options.filename}"`,
            }
          : {}),
      }),
      { expiresIn: PRESIGN_EXPIRES_IN_SECONDS },
    );
  }

  async getObjectBody(key: string): Promise<Readable> {
    const result = await this.adminClient.send(
      new GetObjectCommand({ Bucket: this.config.bucket, Key: key }),
    );
    if (!result.Body) {
      throw new Error(`Object "${key}" has no body`);
    }
    return result.Body as Readable;
  }

  async putObject(key: string, body: Readable | Buffer): Promise<void> {
    await this.adminClient.send(
      new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
        Body: body,
      }),
    );
  }
}
