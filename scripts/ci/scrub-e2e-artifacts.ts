import { readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

import {
  classifyArtifacts,
  exitCodeOf,
  renderScrubReport,
  type ArtifactFile,
} from './scrub-artifacts.util.js';

/**
 * `scrub-e2e-artifacts.ts <directory> [--ephemeral]` — the filesystem half of the artifact check.
 *
 * What may leave a build and why is decided in `scrub-artifacts.util.ts`; this walks the bundle,
 * reads what is readable as text, applies the verdict and sets the exit code. It runs as a step of
 * its own **before** the upload: a check that lives in a runbook is a check that happens when
 * somebody remembers.
 */

/** Text and small enough to scan. A video is neither, and reading it would only cost seconds. */
const SCANNABLE = /\.(json|txt|log|md|html|har|yaml|yml|zip)$/i;
const SCAN_LIMIT_BYTES = 8_000_000;

const walk = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);

    return entry.isDirectory() ? walk(path) : [path];
  });

const asArtifact = (path: string): ArtifactFile => {
  if (!SCANNABLE.test(path) || statSync(path).size > SCAN_LIMIT_BYTES) return { path };

  // `latin1`, not `utf8`: a Playwright trace is a zip, and the cookie name has to be findable in
  // whatever bytes it happens to sit in. Decoding as UTF-8 would replace the surrounding bytes and
  // could split the name across replacement characters.
  return { path, contents: readFileSync(path, 'latin1') };
};

const ephemeral = process.argv.includes('--ephemeral');
const target = process.argv.find((argument, index) => index > 1 && !argument.startsWith('--'));

if (target === undefined) {
  process.stderr.write('usage: scrub-e2e-artifacts.ts <directory> [--ephemeral]\n');
  process.exit(2);
}

let files: string[] = [];

try {
  files = walk(target);
} catch {
  // Nothing to publish is not a failure: a run that passed produces no `test-results` at all.
  process.stdout.write(`scrub: nothing at ${target}, nothing to publish\n`);
  process.exit(0);
}

const verdict = classifyArtifacts(files.map(asArtifact));

for (const path of verdict.remove) rmSync(path);

const { out, err } = renderScrubReport(verdict, ephemeral);

if (out !== '') process.stdout.write(`${out}\n`);
if (err !== '') process.stderr.write(`${err}\n`);

process.exitCode = exitCodeOf(verdict, ephemeral);
