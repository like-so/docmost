import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './services/auth.service';
import { JwtStrategy } from './strategies/jwt.strategy';
import { WorkspaceModule } from '../workspace/workspace.module';
import { SignupService } from './services/signup.service';
import { TokenModule } from './token.module';
import { ProvisioningModule } from '../../provisioning/provisioning.module';
import { MfaController } from '../../provisioning/mfa.controller';

@Module({
  imports: [TokenModule, WorkspaceModule, ProvisioningModule],
  controllers: [AuthController, MfaController],
  providers: [AuthService, SignupService, JwtStrategy],
  exports: [AuthService, SignupService],
})
export class AuthModule {}
