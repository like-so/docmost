import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { PageAccessService } from '../page/page-access/page-access.service';
import { User } from '@docmost/db/types/entity.types';
import { RequestVerificationDto } from './dto/page-verification.dto';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { QueueJob, QueueName } from '../../integrations/queue/constants';
import { AuditEvent, AuditResource } from '../../common/events/audit-events';
import {
  AUDIT_SERVICE,
  IAuditService,
} from '../../integrations/audit/audit.service';

@Injectable()
export class PageVerificationService {
  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly pages: PageRepo,
    private readonly pageAccess: PageAccessService,
    @InjectQueue(QueueName.NOTIFICATION_QUEUE)
    private readonly notifications: Queue,
    @Inject(AUDIT_SERVICE) private readonly auditService: IAuditService,
  ) {}

  async list(user: User, workspaceId: string) {
    const query = this.db
      .selectFrom('pageVerifications')
      .leftJoin(
        'pageVerifiers',
        'pageVerifiers.pageVerificationId',
        'pageVerifications.id',
      )
      .select([
        'pageVerifications.id',
        'pageVerifications.pageId',
        'pageVerifications.status',
        'pageVerifications.type',
        'pageVerifications.requestedAt',
        'pageVerifications.expiresAt',
      ])
      .where('pageVerifications.workspaceId', '=', workspaceId)
      .groupBy([
        'pageVerifications.id',
        'pageVerifications.pageId',
        'pageVerifications.status',
        'pageVerifications.type',
        'pageVerifications.requestedAt',
        'pageVerifications.expiresAt',
      ]);
    if (user.role === 'owner' || user.role === 'admin') {
      return this.withActionFlags(
        await query.orderBy('pageVerifications.requestedAt', 'desc').execute(),
        user,
      );
    }
    return this.withActionFlags(
      await query
      .where((eb) =>
        eb.or([
          eb('pageVerifications.requestedById', '=', user.id),
          eb('pageVerifiers.userId', '=', user.id),
        ]),
      )
      .orderBy('pageVerifications.requestedAt', 'desc')
      .execute(),
      user,
    );
  }

  async request(user: User, workspaceId: string, dto: RequestVerificationDto) {
    const page = await this.pages.findById(dto.pageId);
    if (!page || page.workspaceId !== workspaceId)
      throw new NotFoundException('Page not found');
    await this.pageAccess.validateCanEdit(page, user);
    await this.assertVerifiers(dto.verifierIds, workspaceId, page);
    const verification = await this.db.transaction().execute(async (trx) => {
      const existing = await trx
        .selectFrom('pageVerifications')
        .select('id')
        .where('pageId', '=', page.id)
        .executeTakeFirst();
      const expiry =
        dto.type === 'permanent'
          ? null
          : new Date(Date.now() + (dto.periodDays ?? 90) * 86400000);
      const current = existing
        ? await trx
            .updateTable('pageVerifications')
            .set({
              type: dto.type ?? 'expiring',
              status: 'requested',
              periodAmount: dto.periodDays ?? 90,
              periodUnit: 'days',
              requestedAt: new Date(),
              requestedById: user.id,
              verifiedAt: null,
              verifiedById: null,
              rejectedAt: null,
              rejectedById: null,
              rejectionComment: null,
              expiresAt: expiry,
              updatedAt: new Date(),
            })
            .where('id', '=', existing.id)
            .returningAll()
            .executeTakeFirstOrThrow()
        : await trx
            .insertInto('pageVerifications')
            .values({
              pageId: page.id,
              workspaceId,
              spaceId: page.spaceId,
              type: dto.type ?? 'expiring',
              status: 'requested',
              periodAmount: dto.periodDays ?? 90,
              periodUnit: 'days',
              requestedAt: new Date(),
              requestedById: user.id,
              expiresAt: expiry,
              creatorId: user.id,
            })
            .returningAll()
            .executeTakeFirstOrThrow();
      await trx
        .deleteFrom('pageVerifiers')
        .where('pageVerificationId', '=', current.id)
        .execute();
      await trx
        .insertInto('pageVerifiers')
        .values(
          dto.verifierIds.map((userId, index) => ({
            pageVerificationId: current.id,
            userId,
            isPrimary: index === 0,
            addedById: user.id,
          })),
        )
        .execute();
      await this.auditService.logWithContextInTransaction(
        {
          event: AuditEvent.PAGE_APPROVAL_REQUESTED,
          resourceType: AuditResource.PAGE_VERIFICATION,
          resourceId: current.id,
          spaceId: page.spaceId,
          metadata: { pageId: page.id, verifierIds: dto.verifierIds },
        },
        { workspaceId, actorId: user.id },
        trx,
      );
      return current;
    });
    await this.notifications.add(
      QueueJob.PAGE_APPROVAL_REQUESTED_NOTIFICATION,
      {
        pageId: page.id,
        spaceId: page.spaceId,
        workspaceId,
        actorId: user.id,
        verifierIds: dto.verifierIds,
      },
    );
    return verification;
  }

  async verify(user: User, workspaceId: string, verificationId: string) {
    const verification = await this.findAuthorized(
      user,
      workspaceId,
      verificationId,
    );
    const updated = await this.db
      .updateTable('pageVerifications')
      .set({
        status: 'verified',
        verifiedAt: new Date(),
        verifiedById: user.id,
        rejectedAt: null,
        rejectedById: null,
        rejectionComment: null,
        updatedAt: new Date(),
      })
      .where('id', '=', verification.id)
      .where('status', '=', 'requested')
      .returningAll()
      .executeTakeFirst();
    if (!updated)
      throw new ConflictException('Verification is no longer pending');
    await this.auditService.logWithContext({
      event: AuditEvent.PAGE_VERIFIED,
      resourceType: AuditResource.PAGE_VERIFICATION,
      resourceId: updated.id,
      spaceId: updated.spaceId,
      metadata: { pageId: updated.pageId },
    }, { workspaceId, actorId: user.id });
    const verifierIds = await this.verifierIds(verification.id);
    await this.notifications.add(QueueJob.PAGE_VERIFIED_NOTIFICATION, {
      pageId: verification.pageId,
      spaceId: verification.spaceId,
      workspaceId,
      actorId: user.id,
      verifierIds,
    });
    return updated;
  }

  async reject(
    user: User,
    workspaceId: string,
    verificationId: string,
    comment?: string,
  ) {
    const verification = await this.findAuthorized(
      user,
      workspaceId,
      verificationId,
    );
    const updated = await this.db
      .updateTable('pageVerifications')
      .set({
        status: 'rejected',
        rejectedAt: new Date(),
        rejectedById: user.id,
        rejectionComment: comment ?? null,
        updatedAt: new Date(),
      })
      .where('id', '=', verification.id)
      .where('status', '=', 'requested')
      .returningAll()
      .executeTakeFirst();
    if (!updated)
      throw new ConflictException('Verification is no longer pending');
    await this.auditService.logWithContext({
      event: AuditEvent.PAGE_APPROVAL_REJECTED,
      resourceType: AuditResource.PAGE_VERIFICATION,
      resourceId: updated.id,
      spaceId: updated.spaceId,
      metadata: { pageId: updated.pageId },
    }, { workspaceId, actorId: user.id });
    await this.notifications.add(QueueJob.PAGE_APPROVAL_REJECTED_NOTIFICATION, {
      pageId: verification.pageId,
      spaceId: verification.spaceId,
      workspaceId,
      actorId: user.id,
      verifierIds: await this.verifierIds(verification.id),
    });
    return updated;
  }

  async acknowledge(user: User, workspaceId: string, pageId: string) {
    const page = await this.pages.findById(pageId);
    if (!page || page.workspaceId !== workspaceId)
      throw new NotFoundException('Page not found');
    await this.pageAccess.validateCanView(page, user);
    return this.db
      .insertInto('pageReadConfirmations')
      .values({ pageId: page.id, userId: user.id, workspaceId })
      .onConflict((oc) =>
        oc.columns(['pageId', 'userId']).doUpdateSet({ readAt: new Date() }),
      )
      .returningAll()
      .executeTakeFirst();
  }

  private async assertVerifiers(
    userIds: string[],
    workspaceId: string,
    page: any,
  ) {
    const verifiers = await this.db
      .selectFrom('users')
      .select(['id', 'workspaceId'])
      .where('id', 'in', userIds)
      .where('workspaceId', '=', workspaceId)
      .where('deactivatedAt', 'is', null)
      .execute();
    if (verifiers.length !== new Set(userIds).size) {
      throw new ForbiddenException(
        'Verifiers must be active workspace members',
      );
    }
    for (const verifier of verifiers) {
      await this.pageAccess.validateCanView(page, verifier as User);
    }
  }

  private async findAuthorized(
    user: User,
    workspaceId: string,
    verificationId: string,
  ) {
    const verification = await this.db
      .selectFrom('pageVerifications')
      .selectAll()
      .where('id', '=', verificationId)
      .where('workspaceId', '=', workspaceId)
      .executeTakeFirst();
    if (!verification) throw new NotFoundException('Verification not found');
    await this.pageAccess.validateCanView(
      (await this.pages.findById(verification.pageId))!,
      user,
    );
    const verifier = await this.db
      .selectFrom('pageVerifiers')
      .select('id')
      .where('pageVerificationId', '=', verification.id)
      .where('userId', '=', user.id)
      .executeTakeFirst();
    if (!verifier && user.role !== 'owner' && user.role !== 'admin')
      throw new ForbiddenException();
    return verification;
  }

  private async verifierIds(verificationId: string) {
    return (
      await this.db
        .selectFrom('pageVerifiers')
        .select('userId')
        .where('pageVerificationId', '=', verificationId)
        .execute()
    ).map((row) => row.userId);
  }

  private async withActionFlags(
    verifications: Array<{ id: string }>,
    user: User,
  ) {
    if (verifications.length === 0) return verifications;
    if (user.role === 'owner' || user.role === 'admin')
      return verifications.map((verification) => ({
        ...verification,
        canVerify: true,
      }));
    const assignments = await this.db
      .selectFrom('pageVerifiers')
      .select('pageVerificationId')
      .where(
        'pageVerificationId',
        'in',
        verifications.map((verification) => verification.id),
      )
      .where('userId', '=', user.id)
      .execute();
    const assigned = new Set(
      assignments.map((assignment) => assignment.pageVerificationId),
    );
    return verifications.map((verification) => ({
      ...verification,
      canVerify: assigned.has(verification.id),
    }));
  }
}
