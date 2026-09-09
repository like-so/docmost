import { Global, Module } from '@nestjs/common';
import { TokenModule } from '../auth/token.module';
import { OAuthController } from './oauth.controller';
import { OAuthService } from './oauth.service';

@Global()
@Module({
  imports: [TokenModule],
  controllers: [OAuthController],
  providers: [OAuthService],
  exports: [OAuthService],
})
export class OAuthModule {}
