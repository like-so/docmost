import * as JSZip from 'jszip';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { extractZip } from './file.utils';

describe('extractZip', () => {
  it('rejects archives that exceed the configured extracted-size limit', async () => {
    const source = path.join(
      await fs.mkdtemp(path.join(os.tmpdir(), 'zip-')),
      'input.zip',
    );
    const target = await fs.mkdtemp(path.join(os.tmpdir(), 'extract-'));
    const zip = new JSZip();
    zip.file('large.md', 'x'.repeat(1024));
    await fs.writeFile(source, await zip.generateAsync({ type: 'nodebuffer' }));

    await expect(extractZip(source, target, 128)).rejects.toThrow(
      'allowed extracted size limit',
    );

    await fs.rm(path.dirname(source), { recursive: true, force: true });
    await fs.rm(target, { recursive: true, force: true });
  });
  it('rejects traversal entries before writing them', async () => {
    const sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zip-'));
    const source = path.join(sourceDir, 'input.zip');
    const target = await fs.mkdtemp(path.join(os.tmpdir(), 'extract-'));
    const zip = new JSZip();
    zip.file('safe.md', 'content');
    const archive = await zip.generateAsync({ type: 'nodebuffer' });
    for (
      let index = archive.indexOf(Buffer.from('safe.md'));
      index >= 0;
      index = archive.indexOf(Buffer.from('safe.md'), index + 1)
    ) {
      archive.write('../evil', index, 'utf8');
    }
    await fs.writeFile(source, archive);

    await expect(extractZip(source, target, 1024)).rejects.toThrow(
      'Invalid archive entry',
    );
    await expect(fs.access(path.join(target, '..', 'evil'))).rejects.toThrow();

    await fs.rm(sourceDir, { recursive: true, force: true });
    await fs.rm(target, { recursive: true, force: true });
  });
});
