import {
  ArrayNotEmpty,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
} from 'class-validator';

export class RequestVerificationDto {
  @IsUUID() pageId: string;
  @IsArray()
  @ArrayNotEmpty()
  @IsUUID('all', { each: true })
  verifierIds: string[];
  @IsOptional() @IsIn(['expiring', 'permanent']) type?:
    | 'expiring'
    | 'permanent';
  @IsOptional() @IsInt() @Min(1) @Max(365) periodDays?: number;
}
export class VerificationIdDto {
  @IsUUID() verificationId: string;
}
export class RejectVerificationDto extends VerificationIdDto {
  @IsOptional() @IsString() comment?: string;
}
export class ReadConfirmationDto {
  @IsUUID() pageId: string;
}
