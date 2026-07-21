import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { CreateVideoDto } from './dto/create-video.dto';
import {
  CompleteUploadResult,
  CreateDraftResult,
  VideosService,
} from './videos.service';

@Controller('videos')
export class VideosController {
  constructor(private readonly videosService: VideosService) {}

  @Post()
  async createDraft(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateVideoDto,
  ): Promise<CreateDraftResult> {
    return this.videosService.createDraft(user.sub, dto);
  }

  @Post(':id/complete-upload')
  @HttpCode(200)
  async completeUpload(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: CompleteUploadDto,
  ): Promise<CompleteUploadResult> {
    return this.videosService.completeUpload(user.sub, id, dto);
  }

  @Public()
  @Get(':id/stream')
  async getStreamUrl(@Param('id') id: string): Promise<{ url: string }> {
    return this.videosService.getStreamUrl(id);
  }

  @Public()
  @Get(':id/download')
  async getDownloadUrl(@Param('id') id: string): Promise<{ url: string }> {
    return this.videosService.getDownloadUrl(id);
  }
}
