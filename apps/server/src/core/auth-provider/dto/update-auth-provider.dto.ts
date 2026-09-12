import { OmitType, PartialType } from '@nestjs/mapped-types';
import { IsUUID } from 'class-validator';
import { CreateAuthProviderDto } from './create-auth-provider.dto';

export class UpdateAuthProviderDto extends PartialType(OmitType(CreateAuthProviderDto, ['preparedId'] as const)) {
  @IsUUID()
  id: string;
}
