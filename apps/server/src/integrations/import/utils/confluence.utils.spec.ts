import { BadRequestException } from '@nestjs/common';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseConfluencePages, prepareConfluenceXml } from './confluence.utils';

const fixture = `<?xml version="1.0"?><hibernate-generic>
<object class="BodyContent"><id name="id">body-1</id><property name="body"><![CDATA[<p>Child <a href="/pages/viewpage.action?pageId=1">Parent</a></p>]]></property></object>
<object class="Page"><id name="id">1</id><property name="title">Parent</property></object>
<object class="Page"><id name="id">2</id><property name="title">Child</property><property name="parent"><id name="id">1</id></property><property name="bodyContent"><id name="id">body-1</id></property></object>
</hibernate-generic>`;

describe('Confluence XML import preparation', () => {
  it('maps page hierarchy, body content, and page-id links into safe HTML files', async () => {
    const extractDir = await fs.mkdtemp(path.join(os.tmpdir(), 'confluence-'));
    await fs.writeFile(path.join(extractDir, 'entities.xml'), fixture);

    await prepareConfluenceXml(extractDir);

    await expect(
      fs.readFile(
        path.join(extractDir, 'confluence-pages', 'Parent.html'),
        'utf8',
      ),
    ).resolves.toContain('<h1>Parent</h1>');
    await expect(
      fs.readFile(
        path.join(extractDir, 'confluence-pages', 'Parent', 'Child.html'),
        'utf8',
      ),
    ).resolves.toContain('href="../Parent.html"');
    await fs.rm(extractDir, { recursive: true, force: true });
  });

  it('does not derive filesystem paths from unsafe page titles', async () => {
    const pages = parseConfluencePages(
      '<object class="Page"><id name="id">1</id><property name="title">../unsafe</property></object>',
    );
    const extractDir = await fs.mkdtemp(path.join(os.tmpdir(), 'confluence-'));
    await fs.writeFile(
      path.join(extractDir, 'entities.xml'),
      '<object class="Page"><id name="id">1</id><property name="title">../unsafe</property></object>',
    );

    expect(pages).toHaveLength(1);
    await prepareConfluenceXml(extractDir);
    await expect(
      fs.readdir(path.join(extractDir, 'confluence-pages')),
    ).resolves.toEqual(['unsafe.html']);
    await fs.rm(extractDir, { recursive: true, force: true });
  });

  it('rejects exports without parseable pages', async () => {
    const extractDir = await fs.mkdtemp(path.join(os.tmpdir(), 'confluence-'));
    await fs.writeFile(
      path.join(extractDir, 'entities.xml'),
      '<hibernate-generic/>',
    );

    await expect(prepareConfluenceXml(extractDir)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await fs.rm(extractDir, { recursive: true, force: true });
  });
  it('enforces the configured parser page limit before filesystem writes', () => {
    const xml = `${fixture}${fixture}`;

    expect(() => parseConfluencePages(xml, 1)).toThrow(
      'Confluence export has too many pages',
    );
  });
  it('rejects malformed XML before importing any generated page', async () => {
    const extractDir = await fs.mkdtemp(path.join(os.tmpdir(), 'confluence-'));
    await fs.writeFile(
      path.join(extractDir, 'entities.xml'),
      '<object class="Page"><id name="id">1</id>',
    );

    await expect(prepareConfluenceXml(extractDir)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await fs.rm(extractDir, { recursive: true, force: true });
  });
});
