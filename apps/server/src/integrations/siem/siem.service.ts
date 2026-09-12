import { Inject, Injectable } from '@nestjs/common';
import { EncryptionService } from '../encryption/encryption.service';
import {
  NewSiemDestination,
  SiemDestination,
  SiemDestinationRepo,
  SiemUpdate,
} from '../../database/repos/siem/siem-destination.repo';
import { AuditEvent, AuditResource } from '../../common/events/audit-events';
import {
  AUDIT_SERVICE,
  IAuditService,
} from '../audit/audit.service';

export type SiemInput = {
  name: string;
  type: string;
  config: Record<string, unknown>;
  secrets?: Record<string, string>;
  enabled?: boolean;
};

type SafeDestination = Omit<SiemDestination, 'secrets'> & { secrets?: never };

@Injectable()
export class SiemService {
  private readonly failureLimit = 3;

  constructor(
    private readonly repo: SiemDestinationRepo,
    private readonly encryption: EncryptionService,
    @Inject(AUDIT_SERVICE) private readonly auditService: IAuditService,
  ) {}

  async create(
    workspaceId: string,
    creatorId: string,
    input: SiemInput,
  ): Promise<SafeDestination> {
    const destination: NewSiemDestination = {
      workspaceId,
      creatorId,
      name: input.name,
      type: input.type,
      config: input.config as any,
      enabled: input.enabled ?? true,
      secrets: this.encryption.encrypt(JSON.stringify(input.secrets ?? {})),
    };
    const created = await this.repo.create(destination);
    await this.auditService.logWithContext(
      {
        event: AuditEvent.SIEM_DESTINATION_CREATED,
        resourceType: AuditResource.SIEM_DESTINATION,
        resourceId: created.id,
        changes: { after: { name: created.name, type: created.type } },
      },
      { workspaceId, actorId: creatorId },
    );
    return this.redact(created);
  }

  async list(workspaceId: string): Promise<SafeDestination[]> {
    return (await this.repo.list(workspaceId)).map((destination) =>
      this.redact(destination),
    );
  }

  async update(
    id: string,
    workspaceId: string,
    input: Partial<SiemInput>,
  ): Promise<SafeDestination> {
    const { secrets, ...fields } = input;
    const update: SiemUpdate = {
      ...fields,
      config: fields.config as any,
      updatedAt: new Date(),
    };
    if (secrets)
      update.secrets = this.encryption.encrypt(JSON.stringify(secrets));
    const destination = await this.repo.update(id, workspaceId, update);
    await this.auditService.log({
      event: AuditEvent.SIEM_DESTINATION_UPDATED,
      resourceType: AuditResource.SIEM_DESTINATION,
      resourceId: id,
      changes: { after: { name: destination.name, type: destination.type } },
    });
    return this.redact(destination);
  }

  async remove(id: string, workspaceId: string): Promise<void> {
    await this.repo.remove(id, workspaceId);
    await this.auditService.log({
      event: AuditEvent.SIEM_DESTINATION_DELETED,
      resourceType: AuditResource.SIEM_DESTINATION,
      resourceId: id,
    });
  }

  async recordFailure(id: string, message: string): Promise<void> {
    const destination = await this.repo.recordFailure(id, message);
    if (destination.consecutiveFailures >= this.failureLimit)
      await this.repo.disable(id);
  }

  private redact(destination: SiemDestination): SafeDestination {
    const { secrets: _secrets, ...safe } = destination;
    return safe;
  }
}
