import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';

const excludedRoots = [
  'apps/server/src/ee',
  'apps/client/src/ee',
  'packages/ee',
  'packages/base-formula',
];
const sourceRoots = ['apps/server', 'apps/client', 'packages/editor-ext'];
const configFiles = ['Dockerfile', 'package.json', 'nx.json'];
const dependencyFiles = [
  'package.json',
  'apps/server/package.json',
  'apps/client/package.json',
  'packages/editor-ext/package.json',
];
const textExtensions = new Set(['.cjs', '.cts', '.js', '.json', '.jsx', '.mjs', '.mts', '.ts', '.tsx']);
const forbiddenReferences = [
  '@docmost/base-formula',
  '@docmost/ee',
  '@/ee/',
  'apps/server/src/ee',
  'apps/client/src/ee',
  'packages/ee',
  'packages/base-formula',
];
const forbiddenPackages = ['@docmost/base-formula', '@docmost/ee'];
const buildTargets = ['server', 'client', '@docmost/editor-ext'];

function isWithin(root, candidate) {
  const path = relative(root, candidate);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..');
}

function isExcluded(root, candidate) {
  return excludedRoots.some((path) => isWithin(resolve(root, path), candidate));
}

function isTextFile(path) {
  return textExtensions.has(path.slice(path.lastIndexOf('.')));
}

function collectTextFiles(root, target, files) {
  const absolute = resolve(root, target);
  if (!isWithin(root, absolute)) {
    throw new Error(`Validation path escapes repository: ${target}`);
  }
  if (isExcluded(root, absolute)) {
    throw new Error(`Validation path includes excluded source: ${target}`);
  }
  if (!existsSync(absolute)) return;

  const metadata = statSync(absolute);
  if (!metadata.isDirectory()) {
    if (isTextFile(absolute)) files.add(absolute);
    return;
  }

  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    const child = join(absolute, entry.name);
    if (entry.isDirectory()) {
      if (!['dist', 'node_modules'].includes(entry.name) && !isExcluded(root, child)) {
        collectTextFiles(root, relative(root, child), files);
      }
    } else if (entry.isFile() && isTextFile(child)) {
      files.add(child);
    }
  }
}

function readJson(root, path, failures) {
  try {
    return JSON.parse(readFileSync(resolve(root, path), 'utf8'));
  } catch (error) {
    failures.push(`Cannot read JSON ${path}: ${error.message}`);
    return undefined;
  }
}

function validateBuildGraph(root, failures) {
  const rootPackage = readJson(root, 'package.json', failures);
  const expectedBuild = [
    'pnpm run agpl:validate',
    'pnpm --filter server run build',
    'pnpm --filter client run build',
    'pnpm --filter @docmost/editor-ext run build',
  ].join(' && ');
  if (rootPackage?.scripts?.['agpl:build'] !== expectedBuild) {
    failures.push('package.json agpl:build must validate and explicitly build only AGPL targets.');
  }
  if (rootPackage?.scripts?.['agpl:validate'] !== 'node scripts/validate-agpl-build-boundary.mjs') {
    failures.push('package.json agpl:validate must run the boundary validator.');
  }
  if (rootPackage?.scripts?.build !== 'pnpm agpl:build') {
    failures.push('package.json build must use the scoped AGPL build.');
  }

  const declaredTargets = rootPackage?.scripts?.['agpl:build'] ?? '';
  for (const target of buildTargets) {
    if (!declaredTargets.includes(`--filter ${target} run build`)) {
      failures.push(`AGPL build omits required target ${target}.`);
    }
  }

  const dockerfile = readFileSync(resolve(root, 'Dockerfile'), 'utf8');
  const dockerIgnore = readFileSync(resolve(root, '.dockerignore'), 'utf8');
  if (!dockerfile.includes('RUN pnpm agpl:build')) {
    failures.push('Dockerfile builder must use pnpm agpl:build.');
  }
  if (dockerfile.includes('RUN pnpm build')) {
    failures.push('Dockerfile must not run the unrestricted root build.');
  }
  for (const excludedRoot of excludedRoots) {
    if (dockerfile.includes(`COPY --from=builder /app/${excludedRoot}`)) {
      failures.push(`Dockerfile final image copies excluded root ${excludedRoot}.`);
    }
    if (!dockerIgnore.split(/\r?\n/).map((line) => line.trim()).includes(excludedRoot)) {
      failures.push(`.dockerignore must exclude build-context root ${excludedRoot}.`);
    }
  }
}

function validateTypeScriptBoundary(root, failures) {
  const configs = [
    ['apps/server/tsconfig.build.json', 'server build'],
    ['apps/client/tsconfig.json', 'client'],
  ];
  for (const [path, target] of configs) {
    let config;
    try {
      config = readFileSync(resolve(root, path), 'utf8');
    } catch (error) {
      failures.push(`Cannot read ${path}: ${error.message}`);
      continue;
    }
    if (!/"exclude"\s*:\s*\[[^\]]*"src\/ee"/s.test(config)) {
      failures.push(`${path} must exclude src/ee from AGPL ${target} typechecking.`);
    }
  }
}

function excludedSpecifier(root, source, specifier) {
  const relativePath = relative(root, source);
  const appRoot = relativePath.startsWith('apps/server/')
    ? 'apps/server'
    : relativePath.startsWith('apps/client/')
      ? 'apps/client'
      : undefined;
  const candidates = specifier.startsWith('.')
    ? [resolve(dirname(source), specifier)]
    : specifier.startsWith('/src/') && appRoot
      ? [resolve(root, appRoot, `.${specifier}`)]
      : specifier.startsWith('/')
        ? [resolve(root, `.${specifier}`)]
        : [];
  return candidates.find((candidate) => isExcluded(root, candidate));
}

function validateSourceSpecifiers(root, source, content, failures) {
  const patterns = [
    /\b(?:import|export)\s+(?:type\s+)?(?:[\w*${}[\],\s]+?\s+from\s+)?['"]([^'"]+)['"]/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      const target = excludedSpecifier(root, source, match[1]);
      if (target) {
        failures.push(`${relative(root, source)} specifier ${match[1]} resolves to excluded source ${relative(root, target)}.`);
      }
    }
  }
}

function importerBlock(lockfile, importer) {
  const lines = lockfile.split(/\r?\n/);
  const heading = `  ${importer}:`;
  const start = lines.findIndex((line) => line === heading);
  if (start < 0) return undefined;

  const entries = [];
  for (const line of lines.slice(start + 1)) {
    if (/^  \S/.test(line)) break;
    entries.push(line);
  }
  return entries.join('\n');
}

function forbiddenReference(value) {
  return forbiddenReferences.find((reference) => value.includes(reference));
}

function importerDependencies(block) {
  const entries = [];
  let dependency;
  for (const line of block.split('\n')) {
    const key = line.match(/^ {6}(?:'([^']+)'|"([^"]+)"|([^:\s]+)):\s*$/);
    if (key) {
      if (dependency) entries.push(dependency);
      dependency = { name: key[1] ?? key[2] ?? key[3], values: [] };
      continue;
    }
    const value = line.match(/^ {8}(?:specifier|version):\s*(.+)\s*$/);
    if (dependency && value) dependency.values.push(value[1]);
  }
  if (dependency) entries.push(dependency);
  return entries;
}

function validateLockfile(root, failures) {
  let lockfile;
  try {
    lockfile = readFileSync(resolve(root, 'pnpm-lock.yaml'), 'utf8');
  } catch (error) {
    failures.push(`Cannot read pnpm-lock.yaml: ${error.message}`);
    return;
  }

  for (const importer of ['apps/server', 'apps/client']) {
    const block = importerBlock(lockfile, importer);
    if (block === undefined) {
      failures.push(`pnpm-lock.yaml omits importer ${importer}.`);
      continue;
    }
    for (const dependency of importerDependencies(block)) {
      const reference = forbiddenPackages.includes(dependency.name)
        ? dependency.name
        : forbiddenReference(dependency.values.join('\n'));
      if (reference) {
        failures.push(`pnpm-lock.yaml importer ${importer} dependency ${dependency.name} references excluded workspace/link target ${reference}.`);
      }
    }
  }
}

function validateDependencies(root, failures) {
  for (const path of dependencyFiles) {
    const packageJson = readJson(root, path, failures);
    const packageConfig = { ...packageJson };
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
      for (const [dependency, value] of Object.entries(packageJson?.[field] ?? {})) {
        const reference = forbiddenPackages.includes(dependency)
          ? dependency
          : forbiddenReference(JSON.stringify(value));
        if (reference) {
          failures.push(`${path} dependency ${dependency} references excluded source ${reference}.`);
        }
        delete packageConfig[field];
      }
    }
    for (const forbidden of forbiddenReferences) {
      if (JSON.stringify(packageConfig).includes(forbidden)) {
        failures.push(`${path} references excluded source ${forbidden}.`);
      }
    }
  }
}

function validateBoundary(root) {
  const failures = [];
  const sources = new Set();

  for (const sourceRoot of sourceRoots) collectTextFiles(root, sourceRoot, sources);
  for (const configFile of configFiles) collectTextFiles(root, configFile, sources);
  for (const source of sources) {
    const content = source.endsWith('package.json')
      ? JSON.stringify(Object.fromEntries(Object.entries(readJson(root, relative(root, source), failures) ?? {}).filter(([key]) => !['dependencies', 'devDependencies', 'peerDependencies'].includes(key))))
      : readFileSync(source, 'utf8');
    for (const forbidden of forbiddenReferences) {
      if (source.endsWith('Dockerfile') && forbiddenReferences.includes(forbidden)) continue;
      if (content.includes(forbidden)) {
        failures.push(`${relative(root, source)} references excluded source ${forbidden}`);
      }
    }
    validateSourceSpecifiers(root, source, content, failures);
  }
  validateBuildGraph(root, failures);
  validateTypeScriptBoundary(root, failures);
  validateDependencies(root, failures);
  validateLockfile(root, failures);
  return failures;
}

function runSelfTest() {
  const fixture = mkdtempSync(join(tmpdir(), 'like-157-boundary-'));
  try {
    for (const path of [...sourceRoots, 'scripts']) mkdirSync(join(fixture, path), { recursive: true });
    for (const path of ['package.json', 'apps/server/package.json', 'apps/client/package.json', 'packages/editor-ext/package.json']) {
      mkdirSync(resolve(fixture, path, '..'), { recursive: true });
      writeFileSync(join(fixture, path), JSON.stringify({ name: path, scripts: {}, dependencies: {} }));
    }
    writeFileSync(join(fixture, 'nx.json'), '{}');
    writeFileSync(join(fixture, 'pnpm-lock.yaml'), [
      "lockfileVersion: '9.0'",
      'importers:',
      '  apps/client:',
      '    dependencies: {}',
      '  apps/server:',
      '    dependencies: {}',
      '',
    ].join('\n'));
    writeFileSync(join(fixture, 'Dockerfile'), 'FROM node\nRUN pnpm agpl:build\n');
    writeFileSync(join(fixture, '.dockerignore'), `${excludedRoots.join('\n')}\n`);
    const rootPackage = JSON.parse(readFileSync(join(fixture, 'package.json'), 'utf8'));
    rootPackage.scripts = {
      build: 'pnpm agpl:build',
      'agpl:validate': 'node scripts/validate-agpl-build-boundary.mjs',
      'agpl:build': [
        'pnpm run agpl:validate',
        'pnpm --filter server run build',
        'pnpm --filter client run build',
        'pnpm --filter @docmost/editor-ext run build',
      ].join(' && '),
    };
    writeFileSync(join(fixture, 'package.json'), JSON.stringify(rootPackage));
    writeFileSync(join(fixture, 'apps/client/tsconfig.json'), JSON.stringify({
      exclude: ['src/ee'],
    }));
    writeFileSync(join(fixture, 'apps/server/tsconfig.build.json'), JSON.stringify({
      exclude: ['src/ee'],
    }));
    writeFileSync(join(fixture, 'apps/client/src.ts'), 'export const value = 1;');
    mkdirSync(join(fixture, 'apps/client/src'), { recursive: true });
    writeFileSync(join(fixture, 'apps/client/src/index.ts'), 'export const value = 1;');
    if (validateBoundary(fixture).length !== 0) {
      throw new Error('Expected safe fixture to pass.');
    }
    writeFileSync(join(fixture, 'apps/client/src.ts'), "export { value } from '@docmost/base-formula';");
    if (!validateBoundary(fixture).some((failure) => failure.includes('@docmost/base-formula'))) {
      throw new Error('Expected excluded source fixture to fail.');
    }
    writeFileSync(join(fixture, 'apps/client/src.ts'), 'export const value = 1;');
    writeFileSync(join(fixture, 'apps/client/tsconfig.json'), '{}');
    if (!validateBoundary(fixture).some((failure) => failure.includes('apps/client/tsconfig.json must exclude src/ee'))) {
      throw new Error('Expected missing client exclusion fixture to fail.');
    }
    writeFileSync(join(fixture, 'apps/client/tsconfig.json'), JSON.stringify({
      exclude: ['src/ee'],
    }));
    writeFileSync(join(fixture, 'apps/server/tsconfig.build.json'), '{}');
    if (!validateBoundary(fixture).some((failure) => failure.includes('apps/server/tsconfig.build.json must exclude src/ee'))) {
      throw new Error('Expected missing server build exclusion fixture to fail.');
    }
    writeFileSync(join(fixture, 'apps/server/tsconfig.build.json'), JSON.stringify({
      exclude: ['src/ee'],
    }));
    writeFileSync(join(fixture, 'apps/client/src/index.ts'), "export { value } from './ee';");
    if (!validateBoundary(fixture).some((failure) => failure.includes('specifier ./ee resolves to excluded source'))) {
      throw new Error('Expected excluded relative specifier fixture to fail.');
    }
    writeFileSync(join(fixture, 'apps/client/src/index.ts'), "require('/src/ee');");
    if (!validateBoundary(fixture).some((failure) => failure.includes('specifier /src/ee resolves to excluded source'))) {
      throw new Error('Expected excluded absolute specifier fixture to fail.');
    }
    writeFileSync(join(fixture, 'apps/client/src/index.ts'), 'export const value = 1;');
    mkdirSync(join(fixture, 'packages/editor-ext/src'), { recursive: true });
    writeFileSync(join(fixture, 'packages/editor-ext/src/index.ts'), "export { value } from '../../base-formula';");
    if (!validateBoundary(fixture).some((failure) => failure.includes('specifier ../../base-formula resolves to excluded source'))) {
      throw new Error('Expected excluded base-formula relative specifier fixture to fail.');
    }
    writeFileSync(join(fixture, 'packages/editor-ext/src/index.ts'), 'export const value = 1;');
    writeFileSync(join(fixture, 'apps/server/tsconfig.json'), JSON.stringify({
      compilerOptions: { paths: { '@docmost/ee/*': ['./src/ee/*'] } },
    }));
    if (!validateBoundary(fixture).some((failure) => failure.includes('@docmost/ee'))) {
      throw new Error('Expected excluded alias fixture to fail.');
    }
    writeFileSync(join(fixture, 'apps/server/tsconfig.json'), '{}');
    writeFileSync(join(fixture, 'apps/server/package.json'), JSON.stringify({
      dependencies: { '@docmost/base-formula': 'workspace:*' },
    }));
    if (!validateBoundary(fixture).some((failure) => failure.includes('dependency @docmost/base-formula references excluded source'))) {
      throw new Error('Expected excluded dependency fixture to fail.');
    }
    writeFileSync(join(fixture, 'apps/server/package.json'), JSON.stringify({
      dependencies: { enterpriseAlias: 'workspace:@docmost/ee@*' },
    }));
    if (!validateBoundary(fixture).some((failure) => failure.includes('dependency enterpriseAlias references excluded source @docmost/ee'))) {
      throw new Error('Expected excluded manifest dependency alias fixture to fail.');
    }
    writeFileSync(join(fixture, 'apps/server/package.json'), JSON.stringify({
      dependencies: {},
      jest: { moduleNameMapper: { '^@docmost/base-formula$': './excluded' } },
    }));
    if (!validateBoundary(fixture).some((failure) => failure.includes('apps/server/package.json references excluded source'))) {
      throw new Error('Expected excluded package alias fixture to fail.');
    }
    writeFileSync(join(fixture, 'apps/server/package.json'), JSON.stringify({ dependencies: {} }));
    writeFileSync(join(fixture, 'pnpm-lock.yaml'), [
      "lockfileVersion: '9.0'",
      'importers:',
      '  apps/client:',
      '    dependencies:',
      "      '@docmost/ee':",
      '        specifier: workspace:*',
      '        version: link:../../packages/ee',
      '  apps/server:',
      '    dependencies: {}',
      '',
    ].join('\n'));
    if (!validateBoundary(fixture).some((failure) => failure.includes('pnpm-lock.yaml importer apps/client dependency @docmost/ee references excluded workspace/link target @docmost/ee'))) {
      throw new Error('Expected excluded lockfile importer fixture to fail.');
    }
    writeFileSync(join(fixture, 'pnpm-lock.yaml'), [
      "lockfileVersion: '9.0'",
      'importers:',
      '  apps/client:',
      '    dependencies:',
      '      formulaAlias:',
      '        specifier: workspace:@docmost/base-formula@*',
      '        version: link:../../packages/base-formula',
      '  apps/server:',
      '    dependencies: {}',
      '',
    ].join('\n'));
    if (!validateBoundary(fixture).some((failure) => failure.includes('dependency formulaAlias references excluded workspace/link target @docmost/base-formula'))) {
      throw new Error('Expected excluded lockfile value alias fixture to fail.');
    }
    writeFileSync(join(fixture, 'pnpm-lock.yaml'), [
      "lockfileVersion: '9.0'",
      'importers:',
      '  apps/client:',
      '    dependencies: {}',
      '  apps/server:',
      '    dependencies:',
      "      '@docmost/base-formula':",
      '        specifier: workspace:*',
      '        version: link:../../packages/base-formula',
      '',
    ].join('\n'));
    if (!validateBoundary(fixture).some((failure) => failure.includes('pnpm-lock.yaml importer apps/server dependency @docmost/base-formula references excluded workspace/link target @docmost/base-formula'))) {
      throw new Error('Expected excluded base-formula lockfile importer fixture to fail.');
    }
    writeFileSync(join(fixture, 'pnpm-lock.yaml'), [
      "lockfileVersion: '9.0'",
      'importers:',
      '  apps/client:',
      '    dependencies: {}',
      '  apps/server:',
      '    dependencies: {}',
      '',
    ].join('\n'));
    writeFileSync(join(fixture, 'Dockerfile'), 'FROM node\nRUN pnpm build\nCOPY --from=builder /app/packages/base-formula/dist /app/packages/base-formula/dist\n');
    const dockerFailures = validateBoundary(fixture);
    if (!dockerFailures.some((failure) => failure.includes('Dockerfile builder')) || !dockerFailures.some((failure) => failure.includes('final image copies excluded root'))) {
      throw new Error('Expected unsafe Docker fixture to fail.');
    }
    writeFileSync(join(fixture, 'Dockerfile'), 'FROM node\nRUN pnpm agpl:build\n');
    writeFileSync(join(fixture, '.dockerignore'), `${excludedRoots.slice(0, -1).join('\n')}\n`);
    if (!validateBoundary(fixture).some((failure) => failure.includes('.dockerignore must exclude build-context root'))) {
      throw new Error('Expected missing Docker context exclusion fixture to fail.');
    }
  } finally {
    rmSync(fixture, { force: true, recursive: true });
  }
}

const root = process.cwd();
if (process.argv.includes('--self-test')) {
  runSelfTest();
  console.log('AGPL build-boundary self-test passed.');
} else {
  const failures = validateBoundary(root);
  if (failures.length > 0) {
    console.error(failures.join('\n'));
    process.exitCode = 1;
  } else {
    console.log('AGPL build boundary passed.');
  }
}
