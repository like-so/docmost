import {
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsUUID,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class PagePermissionPageDto {
  @IsUUID()
  pageId: string;
}

export class PagePermissionGrantDto {
  @ValidateIf((grant) => !grant.groupId)
  @IsUUID()
  userId?: string;

  @ValidateIf((grant) => !grant.userId)
  @IsUUID()
  groupId?: string;

  @IsIn(['reader', 'writer'])
  role: 'reader' | 'writer';
}

export class UpdatePagePermissionDto extends PagePermissionPageDto {
  @IsOptional()
  @IsBoolean()
  inherit?: boolean;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PagePermissionGrantDto)
  members?: PagePermissionGrantDto[];
}
