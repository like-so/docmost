import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import {
  DocumentKey,
  DocumentSnapshot,
  InputRevision,
  SnapshotAttachment,
  SnapshotOutcome,
  SourceReader,
} from '../contracts';
import { RagStateRepository } from '../persistence/rag-state.repository';
import { StorageService } from '../../../../integrations/storage/storage.service';

/**
 * Loads the committed source inputs behind one desired revision. The revision
 * and lifecycle gate always comes from the persisted source state, workspace
 * identity from the persisted page row and attachment sourceHash from the
 * stored bytes, never from extraction timestamps or request metadata. A change
 * that commits while bytes are loading invalidates the snapshot.
 */
@Injectable()
export class RagSourceReader implements SourceReader {
  constructor(
    private readonly stateRepository: RagStateRepository,
    @InjectKysely() private readonly db: KyselyDB,
    private readonly storage: StorageService,
  ) {}

  async loadSnapshot(
    key: DocumentKey,
    expectedInputRevision: InputRevision,
  ): Promise<SnapshotOutcome> {
    const initial = await this.stateRepository.find(this.db, key);
    if (!initial || initial.desiredInputRevision !== expectedInputRevision) {
      return { kind: 'superseded' };
    }
    if (initial.sourceStatus !== 'live') {
      return { kind: 'deleted' };
    }

    const page = await this.db
      .selectFrom('pages')
      .select([
        'id',
        'title',
        'spaceId',
        'workspaceId',
        'content',
        'textContent',
        'deletedAt',
      ])
      .where('id', '=', key.pageId)
      .where('workspaceId', '=', key.workspaceId)
      .executeTakeFirst();

    if (!page || page.deletedAt) {
      return { kind: 'deleted' };
    }

    const attachmentRows = await this.db
      .selectFrom('attachments')
      .select(['id', 'fileName', 'filePath', 'fileSize', 'mimeType'])
      .where('pageId', '=', key.pageId)
      .where('workspaceId', '=', key.workspaceId)
      .where('deletedAt', 'is', null)
      .orderBy('createdAt', 'asc')
      .orderBy('id', 'asc')
      .execute();

    const attachments: SnapshotAttachment[] = [];
    for (const row of attachmentRows) {
      attachments.push({
        attachmentId: row.id,
        fileName: row.fileName,
        mimeType: row.mimeType,
        byteSize: row.fileSize == null ? null : Number(row.fileSize),
        sourceHash: await this.hashAttachment(row.filePath),
        storageRef: row.filePath,
      });
    }

    // A change committed while the bytes above were loading invalidates the
    // snapshot: the worker must restart from the newer revision.
    const final = await this.stateRepository.find(this.db, key);
    if (!final || final.desiredInputRevision !== expectedInputRevision) {
      return { kind: 'superseded' };
    }
    if (final.sourceStatus !== 'live') {
      return { kind: 'deleted' };
    }

    const snapshot: DocumentSnapshot = {
      key,
      inputRevision: expectedInputRevision,
      title: page.title,
      spaceId: page.spaceId,
      bodyJson: page.content,
      bodyText: page.textContent ?? '',
      attachments,
    };
    return { kind: 'snapshot', value: snapshot };
  }

  private async hashAttachment(filePath: string): Promise<string> {
    const hash = createHash('sha256');
    const stream = await this.storage.readStream(filePath);
    for await (const chunk of stream) {
      hash.update(chunk as Buffer);
    }
    return hash.digest('hex');
  }
}
