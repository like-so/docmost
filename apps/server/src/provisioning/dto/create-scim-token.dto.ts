import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class CreateScimTokenDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  name: string;
}
