import { IsBoolean, IsString } from 'class-validator';

export class ResolveCommentDto {
  @IsString()
  commentId: string;

  @IsString()
  pageId: string;

  @IsBoolean()
  resolved: boolean;
}
