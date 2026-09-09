import { PartialType } from '@nestjs/mapped-types';
import { IsUUID } from 'class-validator';
import { CreateAuthProviderDto } from './create-auth-provider.dto';

export class UpdateAuthProviderDto extends PartialType(CreateAuthProviderDto) {
  @IsUUID()
  id: string;
}
