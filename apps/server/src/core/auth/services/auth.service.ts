import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { LoginDto } from '../dto/login.dto';
import { CreateUserDto } from '../dto/create-user.dto';
import { TokenService } from './token.service';
import { SessionService } from '../../session/session.service';
import { UserSessionRepo } from '@docmost/db/repos/session/user-session.repo';
import { SignupService } from './signup.service';
import { CreateAdminUserDto } from '../dto/create-admin-user.dto';
import { UserRepo } from '@docmost/db/repos/user/user.repo';
import {
  comparePasswordHash,
  hashPassword,
  isUserDisabled,
  nanoIdGen,
} from '../../../common/helpers';
import { canUsePasswordLogin, throwIfEmailNotVerified } from '../auth.util';
import { ChangePasswordDto } from '../dto/change-password.dto';
import { MailService } from '../../../integrations/mail/mail.service';
import ChangePasswordEmail from '@docmost/transactional/emails/change-password-email';
import { ForgotPasswordDto } from '../dto/forgot-password.dto';
import ForgotPasswordEmail from '@docmost/transactional/emails/forgot-password-email';
import { UserTokenRepo } from '@docmost/db/repos/user-token/user-token.repo';
import { PasswordResetDto } from '../dto/password-reset.dto';
import { User, UserToken, Workspace } from '@docmost/db/types/entity.types';
import { UserTokenType } from '../auth.constants';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { InjectKysely } from 'nestjs-kysely';
import { executeTx } from '@docmost/db/utils';
import { VerifyUserTokenDto } from '../dto/verify-user-token.dto';
import { DomainService } from '../../../integrations/environment/domain.service';
import { AuditEvent, AuditResource } from '../../../common/events/audit-events';
import {
  AUDIT_SERVICE,
  IAuditService,
} from '../../../integrations/audit/audit.service';
import { EnvironmentService } from '../../../integrations/environment/environment.service';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { EventName } from '../../../common/events/event.contants';
import { MfaGateService } from '../../../provisioning/services/mfa-gate.service';
import { MfaService } from '../../../provisioning/services/mfa.service';
import { GroupSyncService } from '../../../provisioning/services/group-sync.service';
import { randomBytes } from 'node:crypto';
import {
  FederatedIdentity,
  isAllowedEmail,
} from '../../auth-provider/federated-identity';

export type LoginResult =
  | { authToken: string }
  | { mfaRequired: true; challengeId: string }
  | { mfaSetupRequired: true; setupId: string };

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private signupService: SignupService,
    private tokenService: TokenService,
    private sessionService: SessionService,
    private userSessionRepo: UserSessionRepo,
    private userRepo: UserRepo,
    private userTokenRepo: UserTokenRepo,
    private mailService: MailService,
    private domainService: DomainService,
    private environmentService: EnvironmentService,
    private eventEmitter: EventEmitter2,
    private readonly mfaGate: MfaGateService,
    private readonly mfa: MfaService,
    private readonly groups: GroupSyncService,
    @InjectKysely() private readonly db: KyselyDB,
    @Inject(AUDIT_SERVICE) private readonly auditService: IAuditService,
  ) {}

  async login(loginDto: LoginDto, workspaceId: string) {
    const user = await this.userRepo.findByEmail(loginDto.email, workspaceId, {
      includePassword: true,
    });

    const errorMessage = 'Email or password does not match';
    if (!user || isUserDisabled(user)) {
      throw new UnauthorizedException(errorMessage);
    }

    if (workspaceId) {
      const workspace = await this.db
        .selectFrom('workspaces')
        .select('enforceSso')
        .where('id', '=', workspaceId)
        .executeTakeFirst();
      if (
        !canUsePasswordLogin(
          Boolean(workspace?.enforceSso),
          user.role,
          this.environmentService.isSsoCapabilityEnabled(),
        )
      ) {
        throw new BadRequestException('This workspace has enforced SSO login.');
      }
    }

    const isPasswordMatch = await comparePasswordHash(
      loginDto.password,
      user.password,
    );

    if (!isPasswordMatch) {
      throw new UnauthorizedException(errorMessage);
    }

    throwIfEmailNotVerified({
      isCloud: this.environmentService.isCloud(),
      emailVerifiedAt: user.emailVerifiedAt,
      email: user.email,
      workspaceId,
      appSecret: this.environmentService.getAppSecret(),
    });

    user.lastLoginAt = new Date();
    await this.userRepo.updateLastLogin(user.id, workspaceId);

    await this.auditService.log({
      event: AuditEvent.USER_LOGIN,
      resourceType: AuditResource.USER,
      resourceId: user.id,
      metadata: { source: 'password' },
    });

    return this.completeLogin(user, workspaceId);
  }

  async register(createUserDto: CreateUserDto, workspaceId: string) {
    const user = await this.signupService.signup(createUserDto, workspaceId);
    return this.sessionService.createSessionAndToken(user);
  }

  async loginFederated(
    providerId: string,
    identity: FederatedIdentity,
    workspaceId: string,
  ): Promise<LoginResult> {
    const provider = await this.findEligibleFederatedProvider(
      providerId,
      identity,
      workspaceId,
    );
    const account = await this.db
      .selectFrom('authAccounts')
      .innerJoin('users', 'users.id', 'authAccounts.userId')
      .selectAll('users')
      .where('authAccounts.authProviderId', '=', providerId)
      .where('authAccounts.providerUserId', '=', identity.subject)
      .where('authAccounts.workspaceId', '=', workspaceId)
      .where('users.workspaceId', '=', workspaceId)
      .where('users.deactivatedAt', 'is', null)
      .where('users.deletedAt', 'is', null)
      .executeTakeFirst();
    const user =
      account ??
      (await this.resolveFederatedUser(
        providerId,
        identity,
        workspaceId,
        provider,
      ));
    if (identity.name && identity.emailVerified) {
      await this.userRepo.updateUser(
        { name: identity.name },
        user.id,
        workspaceId,
      );
      user.name = identity.name;
    }
    if (identity.groups !== undefined) {
      await this.groups.syncUserGroups(
        workspaceId,
        user.id,
        providerId,
        identity.groups,
      );
    }
    return this.completeLogin(user, workspaceId);
  }

  private async resolveFederatedUser(
    providerId: string,
    identity: FederatedIdentity,
    workspaceId: string,
    provider: { allowSignup: boolean; settings: unknown },
  ): Promise<User> {
    return executeTx(this.db, async (trx) => {
      const existing = await this.userRepo.findByEmail(
        identity.email,
        workspaceId,
        { trx },
      );
      if (existing && existing.workspaceId !== workspaceId) {
        throw new UnauthorizedException(
          'SSO account is not eligible for automatic linking.',
        );
      }
      if (!existing && !provider.allowSignup) {
        throw new UnauthorizedException('SSO signup is disabled.');
      }
      const user =
        existing ??
        (await this.signupService.signup(
          {
            email: identity.email,
            name: identity.name ?? identity.email.split('@')[0],
            password: randomBytes(32).toString('base64url'),
            emailVerifiedAt: new Date(),
          } as CreateUserDto,
          workspaceId,
          trx,
        ));
      const inserted = await trx
        .insertInto('authAccounts')
        .values({
          authProviderId: providerId,
          providerUserId: identity.subject,
          userId: user.id,
          workspaceId,
        })
        .onConflict((conflict) =>
          conflict.columns(['authProviderId', 'providerUserId']).doNothing(),
        )
        .returning('userId')
        .executeTakeFirst();
      if (!inserted) {
        throw new UnauthorizedException('SSO identity is already linked.');
      }
      return user;
    });
  }

  private async findEligibleFederatedProvider(
    providerId: string,
    identity: FederatedIdentity,
    workspaceId: string,
  ) {
    const provider = await this.db
      .selectFrom('authProviders')
      .select(['allowSignup', 'settings'])
      .where('id', '=', providerId)
      .where('workspaceId', '=', workspaceId)
      .where('isEnabled', '=', true)
      .where('deletedAt', 'is', null)
      .executeTakeFirst();
    if (
      !provider ||
      !identity.email ||
      !identity.emailVerified ||
      !isAllowedEmail(identity.email, provider.settings)
    ) {
      throw new UnauthorizedException(
        'SSO account is not eligible for automatic linking.',
      );
    }
    return provider;
  }

  async completeMfaLogin(challengeId: string, code: string): Promise<string> {
    const challenge = await this.mfa.verifyChallenge(challengeId, code);
    const user = await this.userRepo.findById(
      challenge.userId,
      challenge.workspaceId,
    );
    if (!user || isUserDisabled(user)) {
      throw new UnauthorizedException('MFA login user is unavailable');
    }
    return this.sessionService.createSessionAndToken(user);
  }

  async startMfaSetup(setupId: string) {
    const challenge = await this.mfa.getSetupChallenge(setupId);
    const user = await this.userRepo.findById(
      challenge.userId,
      challenge.workspaceId,
    );
    if (!user || isUserDisabled(user)) {
      throw new UnauthorizedException('MFA setup user is unavailable');
    }
    return this.mfa.setup(
      user.id,
      challenge.workspaceId,
      user.email,
      undefined,
      true,
    );
  }

  async verifyMfaPassword(
    userId: string,
    workspaceId: string,
    password?: string,
  ): Promise<boolean> {
    if (!password) return false;
    const user = await this.userRepo.findById(userId, workspaceId, {
      includePassword: true,
    });
    return Boolean(
      user &&
        !isUserDisabled(user) &&
        (await comparePasswordHash(password, user.password)),
    );
  }

  async completeMfaSetup(setupId: string, code: string): Promise<string> {
    const challenge = await this.mfa.verifySetupChallenge(setupId, code);
    const user = await this.userRepo.findById(
      challenge.userId,
      challenge.workspaceId,
    );
    if (!user || isUserDisabled(user)) {
      throw new UnauthorizedException('MFA setup user is unavailable');
    }
    return this.sessionService.createSessionAndToken(user);
  }

  async setup(createAdminUserDto: CreateAdminUserDto) {
    const { workspace, user } =
      await this.signupService.initialSetup(createAdminUserDto);

    const authToken = await this.sessionService.createSessionAndToken(user);
    return { workspace, authToken };
  }

  async changePassword(
    dto: ChangePasswordDto,
    userId: string,
    workspaceId: string,
    currentSessionId?: string,
  ): Promise<void> {
    const user = await this.userRepo.findById(userId, workspaceId, {
      includePassword: true,
    });

    if (!user || isUserDisabled(user)) {
      throw new NotFoundException('User not found');
    }

    const comparePasswords = await comparePasswordHash(
      dto.oldPassword,
      user.password,
    );

    if (!comparePasswords) {
      throw new BadRequestException('Current password is incorrect');
    }

    const newPasswordHash = await hashPassword(dto.newPassword);
    await this.userRepo.updateUser(
      {
        password: newPasswordHash,
        hasGeneratedPassword: false,
      },
      userId,
      workspaceId,
    );

    if (currentSessionId) {
      await this.userSessionRepo.deleteAllExceptCurrent(
        currentSessionId,
        userId,
        workspaceId,
      );
    } else {
      await this.userSessionRepo.deleteByUserId(userId, workspaceId);
    }

    await this.auditService.log({
      event: AuditEvent.USER_PASSWORD_CHANGED,
      resourceType: AuditResource.USER,
      resourceId: userId,
    });

    const emailTemplate = ChangePasswordEmail({ username: user.name });
    await this.mailService.sendToQueue({
      to: user.email,
      subject: 'Your password has been changed',
      template: emailTemplate,
    });
  }

  async forgotPassword(
    forgotPasswordDto: ForgotPasswordDto,
    workspace: Workspace,
  ): Promise<void> {
    const user = await this.userRepo.findByEmail(
      forgotPasswordDto.email,
      workspace.id,
    );

    if (!user || isUserDisabled(user)) {
      return;
    }

    if (
      !canUsePasswordLogin(
        workspace.enforceSso,
        user.role,
        this.environmentService.isSsoCapabilityEnabled(),
      )
    ) {
      return;
    }

    const token = nanoIdGen(16);

    await executeTx(this.db, async (trx) => {
      await trx
        .deleteFrom('userTokens')
        .where('userId', '=', user.id)
        .where('type', '=', UserTokenType.FORGOT_PASSWORD)
        .execute();

      await this.userTokenRepo.insertUserToken(
        {
          token,
          userId: user.id,
          workspaceId: user.workspaceId,
          expiresAt: new Date(Date.now() + 30 * 60 * 1000), // 30 minutes
          type: UserTokenType.FORGOT_PASSWORD,
        },
        { trx },
      );
    });

    const resetLink = `${this.domainService.getUrl(workspace.hostname)}/password-reset?token=${token}`;

    const emailTemplate = ForgotPasswordEmail({
      username: user.name,
      resetLink: resetLink,
    });

    await this.mailService.sendToQueue({
      to: user.email,
      subject: 'Reset your password',
      template: emailTemplate,
    });

    await this.auditService.log({
      event: AuditEvent.USER_PASSWORD_RESET_REQUESTED,
      resourceType: AuditResource.USER,
      resourceId: user.id,
      metadata: { source: 'forgot_password' },
    });
  }

  async passwordReset(
    passwordResetDto: PasswordResetDto,
    workspace: Workspace,
  ) {
    const userToken = await this.userTokenRepo.findById(
      passwordResetDto.token,
      workspace.id,
    );

    if (
      !userToken ||
      userToken.type !== UserTokenType.FORGOT_PASSWORD ||
      userToken.expiresAt < new Date()
    ) {
      throw new BadRequestException('Invalid or expired token');
    }

    const user = await this.userRepo.findById(userToken.userId, workspace.id, {
      includeUserMfa: true,
    });
    if (!user || isUserDisabled(user)) {
      throw new NotFoundException('User not found');
    }

    if (
      !canUsePasswordLogin(
        workspace.enforceSso,
        user.role,
        this.environmentService.isSsoCapabilityEnabled(),
      )
    ) {
      throw new BadRequestException('This workspace has enforced SSO login.');
    }

    const newPasswordHash = await hashPassword(passwordResetDto.newPassword);

    await executeTx(this.db, async (trx) => {
      await this.userRepo.updateUser(
        {
          password: newPasswordHash,
          hasGeneratedPassword: false,
        },
        user.id,
        workspace.id,
        trx,
      );

      await trx
        .deleteFrom('userTokens')
        .where('userId', '=', user.id)
        .where('type', '=', UserTokenType.FORGOT_PASSWORD)
        .execute();
    });

    await this.userSessionRepo.deleteByUserId(user.id, workspace.id);

    // A failed revocation must not block the reset itself; log loudly instead.
    try {
      await this.eventEmitter.emitAsync(EventName.USER_PASSWORD_RESET, {
        userId: user.id,
        workspaceId: workspace.id,
      });
    } catch (err) {
      this.logger.error(
        `failed to revoke oauth grants for user ${user.id} after password reset`,
        err,
      );
    }

    this.auditService.setActorId(user.id);
    await this.auditService.log({
      event: AuditEvent.USER_PASSWORD_RESET,
      resourceType: AuditResource.USER,
      resourceId: user.id,
    });

    const emailTemplate = ChangePasswordEmail({ username: user.name });
    await this.mailService.sendToQueue({
      to: user.email,
      subject: 'Your password has been changed',
      template: emailTemplate,
    });

    if (this.environmentService.isCloud() && !user.emailVerifiedAt) {
      await this.userRepo.updateUser(
        { emailVerifiedAt: new Date() },
        user.id,
        workspace.id,
      );
    }

    // Check if user has MFA enabled or workspace enforces MFA
    const userHasMfa = user?.['mfa']?.isEnabled || false;
    const workspaceEnforcesMfa = workspace.enforceMfa || false;

    if (userHasMfa || workspaceEnforcesMfa) {
      return {
        requiresLogin: true,
      };
    }

    const authToken = await this.sessionService.createSessionAndToken(user);
    return { authToken };
  }

  async verifyUserToken(
    userTokenDto: VerifyUserTokenDto,
    workspaceId: string,
  ): Promise<void> {
    const userToken: UserToken = await this.userTokenRepo.findById(
      userTokenDto.token,
      workspaceId,
    );

    if (
      !userToken ||
      userToken.type !== userTokenDto.type ||
      userToken.expiresAt < new Date()
    ) {
      throw new BadRequestException('Invalid or expired token');
    }
  }

  async getCollabToken(user: User, workspaceId: string) {
    const token = await this.tokenService.generateCollabToken(
      user,
      workspaceId,
    );
    return { token };
  }

  private async completeLogin(
    user: User,
    workspaceId: string,
  ): Promise<LoginResult> {
    if (await this.mfaGate.requiresChallenge(user.id, workspaceId)) {
      if (!(await this.mfa.hasEnabledFactor(user.id, workspaceId))) {
        const { challengeId: setupId } = await this.mfa.createChallenge(
          user.id,
          workspaceId,
          'totp_setup',
        );
        return { mfaSetupRequired: true, setupId };
      }
      const { challengeId } = await this.mfa.createChallenge(
        user.id,
        workspaceId,
        'totp',
      );
      return { mfaRequired: true, challengeId };
    }
    return { authToken: await this.sessionService.createSessionAndToken(user) };
  }
}
