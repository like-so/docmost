import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class LinkAuthAccountDto {
  @IsString()
  @IsNotEmpty()
  providerId: string;

  @IsString()
  @IsNotEmpty()
  userId: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(512)
  providerUserId: string;
}
