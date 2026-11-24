#!/usr/bin/env node
/**
 * Copy frameworks/, roles/, and skills/ into the CLI package so a published
 * `@turbine-hall/turbine-cli` tarball is self-contained (factoryRoot resolves
 * to the package root after install).
 */
import { cpSync, existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cliRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const monoRoot = join(cliRoot, '../..');
const dirs = ['frameworks', 'roles', 'skills'];

for (const name of dirs) {
  const src = join(monoRoot, name);
  const dest = join(cliRoot, name);
  if (!existsSync(src)) {
    throw new Error(`copy-factory: missing ${src}`);
  }
  rmSync(dest, { recursive: true, force: true });
  cpSync(src, dest, { recursive: true });
}
