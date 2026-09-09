import { Injectable } from '@nestjs/common';
import { AuditRepo } from '../../database/repos/audit/audit.repo';
import { SiemDestinationRepo } from '../../database/repos/siem/siem-destination.repo';
import { SiemOutboxRepo } from '../../database/repos/siem/siem-outbox.repo';
import { EncryptionService } from '../encryption/encryption.service';
import { OutboundAgentFactory } from '../outbound/outbound-agent.factory';
import { EnvironmentService } from '../environment/environment.service';
import * as undici from 'undici';

type DestinationConfig = { url?: string };
type DestinationSecrets = { token?: string };

@Injectable()
export class SiemDeliveryService {
  constructor(
    private readonly destinations: SiemDestinationRepo,
    private readonly auditRepo: AuditRepo,
    private readonly outbox: SiemOutboxRepo,
    private readonly encryption: EncryptionService,
    private readonly outbound: OutboundAgentFactory,
    private readonly environment: EnvironmentService,
  ) {}

  async deliver(destinationId: string, auditId: string): Promise<boolean> {
    const destination = await this.destinations.findById(destinationId);
    if (!destination?.enabled) return false;
    const pending = await this.outbox.next(destination.id);
    if (!pending || pending.auditId !== auditId) return false;
    const event = await this.auditRepo.findById(auditId, destination.workspaceId);
    if (!event) return false;
    const url = (destination.config as DestinationConfig).url;
    if (!url) throw new Error('SIEM destination does not have a URL');
    const secrets = JSON.parse(
      this.encryption.decrypt(destination.secrets),
    ) as DestinationSecrets;
    const lease = await this.outbound.lease(url);
    try {
      const response = await undici.fetch(url, {
        method: 'POST',
        dispatcher: lease.dispatcher,
        redirect: 'error',
        signal: AbortSignal.timeout(this.environment.getSiemRequestTimeoutMs()),
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': event.id,
          ...(secrets.token
            ? { Authorization: `Bearer ${secrets.token}` }
            : {}),
        },
        body: JSON.stringify(event),
      });
      if (!response.ok)
        throw new Error(`SIEM receiver returned ${response.status}`);
      await this.destinations.markDelivered(
        destination.id,
        event.createdAt,
        event.id,
      );
      await this.outbox.markDelivered(pending.id);
      return true;
    } finally {
      await lease.release();
    }
  }

}
