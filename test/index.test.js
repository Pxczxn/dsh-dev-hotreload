import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { discoverLinkedDirs, looksLikeProfile, resolveProfileDir } from '../index.js';

function profile(dir, dependencies = {}) {
  mkdirSync(join(dir, 'node_modules'), { recursive: true });
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'dsh-profile-test', private: true, dependencies, dsh: { profile: { bundles: ['x'] } } }),
  );
}

test('looksLikeProfile 认出带 bundles 的 profile', () => {
  const root = mkdtempSync(join(tmpdir(), 'dev-hotreload-'));
  try {
    const dir = join(root, 'profile');
    profile(dir);
    assert.equal(looksLikeProfile(dir), true);
    assert.equal(looksLikeProfile(join(root, 'missing')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('discoverLinkedDirs 收集 link:/file: 依赖与 node_modules 里的 symlink', () => {
  const root = mkdtempSync(join(tmpdir(), 'dev-hotreload-'));
  try {
    const dir = join(root, 'profile');
    const linked = join(root, 'packages', 'alpha');
    const scoped = join(root, 'packages', 'beta');
    mkdirSync(linked, { recursive: true });
    mkdirSync(scoped, { recursive: true });
    profile(dir, {
      alpha: 'link:../packages/alpha',
      beta: `file:${scoped.replace(/\\/g, '/')}`,
      plain: '1.0.0',
    });
    symlinkSync(linked, join(dir, 'node_modules', 'alpha'), 'junction');
    mkdirSync(join(dir, 'node_modules', '@scope'), { recursive: true });
    symlinkSync(scoped, join(dir, 'node_modules', '@scope', 'beta'), 'junction');

    const found = discoverLinkedDirs(dir).map((path) => path.toLowerCase());
    assert.ok(found.includes(linked.toLowerCase()), 'link: 依赖应被发现');
    assert.ok(found.includes(scoped.toLowerCase()), 'file: 依赖与 symlink 应被发现');
    assert.equal(new Set(found).size, found.length, '结果不应重复');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('resolveProfileDir 优先用 profileContext.dir', () => {
  const root = mkdtempSync(join(tmpdir(), 'dev-hotreload-'));
  try {
    const dir = join(root, 'profile');
    profile(dir);
    const ctx = { get: (name) => (name === 'profileContext' ? { dir } : undefined) };
    assert.equal(resolveProfileDir(ctx).toLowerCase(), dir.toLowerCase());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('resolveProfileDir 在真实 profile 上返回当前安装目录', () => {
  const ctx = { get: () => undefined };
  const found = resolveProfileDir(ctx);
  if (found === undefined) return; // 非 profile 组合环境（例如独立 CLI 测试）跳过
  assert.equal(looksLikeProfile(found), true);
  assert.match(found.toLowerCase(), /profiles[\\/]desktop$/);
});
