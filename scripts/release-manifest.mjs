#!/usr/bin/env node
/**
 * Release manifest tooling.
 *
 * `release-manifest.json` is the single source of truth for which workspace
 * packages are published to npm. This script keeps the rest of the repo in sync
 * with it:
 *
 *   - packages not listed in `publish` are marked `"private": true` so npm can
 *     never publish them, and are added to the Changesets `ignore` list
 *   - packages listed in `publish` have `"private"` removed and are kept out of
 *     the Changesets `ignore` list
 *
 * Commands:
 *   sync          rewrite package.json / .changeset/config.json from the manifest
 *   check         exit non-zero if any file is out of sync with the manifest
 *   turbo-filter  print `--filter=<pkg>` args for the publishable packages
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = join(rootDir, 'release-manifest.json');
const changesetConfigPath = join(rootDir, '.changeset', 'config.json');
const packagesDir = join(rootDir, 'packages');

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function loadWorkspacePackages() {
  return readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(packagesDir, entry.name, 'package.json'))
    .filter((path) => existsSync(path))
    .map((path) => ({ path, json: readJson(path) }))
    .sort((a, b) => a.json.name.localeCompare(b.json.name));
}

function loadManifest(packages) {
  const manifest = readJson(manifestPath);
  const publish = manifest.publish;

  if (!Array.isArray(publish) || publish.some((name) => typeof name !== 'string')) {
    throw new Error('release-manifest.json: "publish" must be an array of package names');
  }

  const known = new Set(packages.map((pkg) => pkg.json.name));
  const unknown = publish.filter((name) => !known.has(name));
  if (unknown.length > 0) {
    throw new Error(
      `release-manifest.json lists unknown package(s): ${unknown.join(', ')}. ` +
        `Known packages: ${[...known].join(', ')}`,
    );
  }

  return new Set(publish);
}

/** Returns the package.json edits needed to match the manifest. */
function plan(packages, publishable) {
  const changes = [];

  for (const pkg of packages) {
    const shouldPublish = publishable.has(pkg.json.name);
    const isPrivate = pkg.json.private === true;

    if (shouldPublish && isPrivate) {
      changes.push({
        pkg,
        description: `${pkg.json.name}: remove "private": true (listed in release manifest)`,
        apply: () => {
          delete pkg.json.private;
        },
      });
    } else if (!shouldPublish && !isPrivate) {
      changes.push({
        pkg,
        description: `${pkg.json.name}: add "private": true (not listed in release manifest)`,
        apply: () => {
          pkg.json.private = true;
        },
      });
    }
  }

  return changes;
}

function expectedIgnoreList(packages, publishable) {
  return packages.map((pkg) => pkg.json.name).filter((name) => !publishable.has(name));
}

function run(command) {
  const packages = loadWorkspacePackages();
  const publishable = loadManifest(packages);

  if (command === 'turbo-filter') {
    const filters = packages
      .map((pkg) => pkg.json.name)
      .filter((name) => publishable.has(name))
      .map((name) => `--filter=${name}`)
      .join(' ');
    process.stdout.write(`${filters}\n`);
    return 0;
  }

  const changes = plan(packages, publishable);
  const changesetConfig = readJson(changesetConfigPath);
  const expectedIgnore = expectedIgnoreList(packages, publishable);
  const ignoreOutOfSync =
    JSON.stringify(changesetConfig.ignore ?? []) !== JSON.stringify(expectedIgnore);

  if (command === 'check') {
    if (changes.length === 0 && !ignoreOutOfSync) {
      console.log('Release manifest is in sync.');
      return 0;
    }

    console.error('Release manifest is out of sync. Run `pnpm manifest:sync`:');
    for (const change of changes) console.error(`  - ${change.description}`);
    if (ignoreOutOfSync) {
      console.error(
        `  - .changeset/config.json: "ignore" should be ${JSON.stringify(expectedIgnore)}`,
      );
    }
    return 1;
  }

  if (command === 'sync') {
    for (const change of changes) {
      change.apply();
      writeJson(change.pkg.path, change.pkg.json);
      console.log(`Updated ${change.description}`);
    }

    if (ignoreOutOfSync) {
      changesetConfig.ignore = expectedIgnore;
      writeJson(changesetConfigPath, changesetConfig);
      console.log(`Updated .changeset/config.json "ignore" to ${JSON.stringify(expectedIgnore)}`);
    }

    if (changes.length === 0 && !ignoreOutOfSync) console.log('Release manifest already in sync.');
    return 0;
  }

  console.error('Usage: node scripts/release-manifest.mjs <sync|check|turbo-filter>');
  return 1;
}

try {
  process.exit(run(process.argv[2]));
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
