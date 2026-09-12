import {
  BadRequestException,
  Injectable,
  Inject,
  NotFoundException,
} from '@nestjs/common';
import { AuthProviderRepo } from '@docmost/db/repos/auth-provider/auth-provider.repo';
import { EncryptionService } from '../../integrations/encryption/encryption.service';
import {
  AUTH_PROVIDER_TYPES,
  CreateAuthProviderDto,
} from './dto/create-auth-provider.dto';
import { AuthProviderDto } from './dto/auth-provider.dto';
import { UpdatableAuthProvider } from '@docmost/db/types/entity.types';
import { normalizeProviderSettings } from './federated-identity';
import { AuditEvent, AuditResource } from '../../common/events/audit-events';
import { AUDIT_SERVICE, IAuditService } from '../../integrations/audit/audit.service';

const SECRET_FIELDS = [
  'oidcClientSecret',
  'samlCertificate',
  'ldapBindPassword',
  'ldapTlsCaCert',
] as const;

@Injectable()
export class AuthProviderService {
  constructor(
    private readonly repo: AuthProviderRepo,
    private readonly encryption: EncryptionService,
    @Inject(AUDIT_SERVICE) private readonly auditService: IAuditService = {} as IAuditService,
  ) {}

  async create(
    workspaceId: string,
    user: { id: string },
    dto: CreateAuthProviderDto,
  ) {
    this.validate(dto);
    const { preparedId, ...configuration } = dto;
    const provider = await this.repo.create({
      ...this.encryptSecrets(this.normalizeSettings(configuration)),
      ...(preparedId ? { id: preparedId } : {}),
      workspaceId,
      creatorId: user.id,
    });
    await this.audit(AuditEvent.SSO_PROVIDER_CREATED, workspaceId, user.id, provider.id);
    return AuthProviderDto.from(provider);
  }

  async list(workspaceId: string) {
    return (await this.repo.list(workspaceId)).map(AuthProviderDto.from);
  }

  async listEnabled(workspaceId: string) {
    return (await this.repo.listEnabled(workspaceId)).map(
      ({ id, name, type }) => ({
        id,
        name,
        type,
      }),
    );
  }

  async findEnabled(workspaceId: string, id: string) {
    const provider = await this.repo.findEnabled(id, workspaceId);
    if (!provider)
      throw new NotFoundException('Authentication provider not found');
    return provider;
  }

  async update(
    workspaceId: string,
    user: { id: string },
    id: string,
    dto: Partial<CreateAuthProviderDto>,
  ) {
    const existing = await this.repo.findById(id, workspaceId);
    if (!existing)
      throw new NotFoundException('Authentication provider not found');
    this.validate({ ...existing, ...dto } as CreateAuthProviderDto);
    const provider = await this.repo.update(
      id,
      workspaceId,
      this.encryptSecrets(this.normalizeSettings(dto)),
    );
    if (!provider)
      throw new NotFoundException('Authentication provider not found');
    await this.audit(AuditEvent.SSO_PROVIDER_UPDATED, workspaceId, user.id, id);
    return AuthProviderDto.from(provider);
  }

  async remove(workspaceId: string, user: { id: string }, id: string) {
    if (!(await this.repo.findById(id, workspaceId))) {
      throw new NotFoundException('Authentication provider not found');
    }
    await this.repo.remove(id, workspaceId);
    await this.audit(AuditEvent.SSO_PROVIDER_DELETED, workspaceId, user.id, id);
  }

  private encryptSecrets(
    dto: Partial<CreateAuthProviderDto>,
  ): UpdatableAuthProvider {
    const result: UpdatableAuthProvider = { ...dto };
    for (const field of SECRET_FIELDS) {
      if (dto[field] !== undefined)
        result[field] = this.encryption.encrypt(dto[field]);
    }
    return result;
  }

  private async audit(
    event: (typeof AuditEvent)[keyof typeof AuditEvent],
    workspaceId: string,
    actorId: string,
    resourceId: string,
  ): Promise<void> {
    await this.auditService.logWithContext?.(
      { event, resourceType: AuditResource.SSO_PROVIDER, resourceId },
      { workspaceId, actorId, actorType: 'user' },
    );
  }

  private validate(dto: CreateAuthProviderDto) {
    if (!AUTH_PROVIDER_TYPES.includes(dto.type)) {
      throw new BadRequestException(
        'Unsupported authentication provider type.',
      );
    }
    if (dto.type === 'oidc' && (!dto.oidcIssuer || !dto.oidcClientId)) {
      throw new BadRequestException('OIDC issuer and client ID are required.');
    }
    if (
      dto.type === 'saml' &&
      (!dto.samlUrl || !dto.samlCertificate || !dto.samlEntityId)
    ) {
      throw new BadRequestException(
        'SAML URL, Entity ID, and certificate are required.',
      );
    }
    if (dto.type === 'ldap' && (!dto.ldapUrl || !dto.ldapBaseDn)) {
      throw new BadRequestException('LDAP URL and base DN are required.');
    }
    this.validateDomains(dto.settings);
  }

  private normalizeSettings(
    dto: Partial<CreateAuthProviderDto>,
  ): Partial<CreateAuthProviderDto> {
    if (dto.settings === undefined) return dto;
    return { ...dto, settings: normalizeProviderSettings(dto.settings) as any };
  }

  private validateDomains(settings: unknown): void {
    if (!settings || typeof settings !== 'object') return;
    const values = (settings as Record<string, unknown>).allowedDomains;
    const domains = Array.isArray(values)
      ? values
      : typeof values === 'string'
        ? values.split(/[;,]/)
        : values === undefined
          ? []
          : null;
    if (
      !domains ||
      domains.some(
        (value) =>
          typeof value !== 'string' ||
          !/^(?:@)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(
            value.trim(),
          ),
      )
    ) {
      throw new BadRequestException(
        'allowedDomains must contain domain names.',
      );
    }
  }
}
