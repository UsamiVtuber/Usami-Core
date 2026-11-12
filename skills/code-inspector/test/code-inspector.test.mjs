import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CODE_INSPECT_SCHEMA,
  inspectAllowlistedFile,
  isAllowlistedCodePath,
  searchAllowlistedCode,
} from '../inspector-core.mjs';

test('allowlist bloqueia .env, vault, data e traversal', () => {
  assert.equal(isAllowlistedCodePath('.env'), false);
  assert.equal(isAllowlistedCodePath('../.env'), false);
  assert.equal(isAllowlistedCodePath('data/memory.json'), false);
  assert.equal(isAllowlistedCodePath('vault/nota.md'), false);
  assert.equal(isAllowlistedCodePath('src/agent-core.js'), true);
  assert.equal(isAllowlistedCodePath('docs/architecture.md'), true);
  assert.equal(isAllowlistedCodePath('usami-desktop/src/main.rs'), true);
  assert.equal(isAllowlistedCodePath('desktop/target/debug/app.exe'), false);
});

test('inspectAllowlistedFile e searchAllowlistedCode leem código permitido e redigem segredos', t => {
  const baseRoot = process.env.USAMI_DATA_DIR || tmpdir();
  const root = mkdtempSync(join(baseRoot, 'inspector-test-'));
  const desktopRoot = mkdtempSync(join(baseRoot, 'inspector-desktop-'));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(desktopRoot, { recursive: true, force: true });
  });

  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(desktopRoot, 'src'), { recursive: true });
  writeFileSync(join(root, '.env'), 'NVIDIA_API_KEY=nvapi-supersecretkey123456\n');
  writeFileSync(
    join(root, 'src', 'sample.js'),
    'export function greet() {\n  return "oi";\n}\n// USAMI_API_TOKEN=segredo123456\n// github_pat_1234567890abcdef\n',
  );
  writeFileSync(join(desktopRoot, 'src', 'lib.rs'), 'pub fn ping_usami() -> bool { true }\n');

  const inspected = inspectAllowlistedFile({ rootDir: root, path: 'src/sample.js' });
  assert.equal(inspected.schema, CODE_INSPECT_SCHEMA);
  assert.deepEqual(inspected.exports, ['greet']);
  assert.equal(inspected.snippet.lines.some(l => l.text.includes('segredo123456')), false);
  assert.equal(inspected.snippet.lines.some(l => l.text.includes('github_pat_1234567890abcdef')), false);

  const desk = inspectAllowlistedFile({ rootDir: root, desktopRoot, path: 'usami-desktop/src/lib.rs' });
  assert.deepEqual(desk.exports, ['ping_usami']);

  assert.throws(() => inspectAllowlistedFile({ rootDir: root, path: '.env' }), /allowlist/);

  const found = searchAllowlistedCode({ rootDir: root, query: 'greet', scope: 'src' });
  assert.equal(found.totalMatches, 1);
  assert.equal(found.matches[0].path, 'src/sample.js');

  const foundDesk = searchAllowlistedCode({ rootDir: root, desktopRoot, query: 'ping_usami', scope: 'desktop' });
  assert.equal(foundDesk.totalMatches, 1);
  assert.equal(foundDesk.matches[0].path, 'desktop/src/lib.rs');
});

