import {
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class CreateVideoDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  originalFilename: string;

  @IsInt()
  @Min(1)
  @Max(10737418240)
  fileSize: number;

  @IsString()
  @IsOptional()
  contentType?: string;
}
