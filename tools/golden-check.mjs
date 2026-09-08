#!/usr/bin/env node
/**
 * Golden build check — codegen:R5 (unit 14b).
 *
 * Pipeline: golden diagram → generate() with the real Handlebars renderer →
 * fresh sandbox under os.tmpdir() → `mvnw.cmd -q -DskipTests package` →
 * `java -jar target/*.jar` → HTTP readiness poll → one CRUD round-trip
 * (POST then GET list) → teardown.
 *
 * Threat matrix row 2 (subprocess execution): every external process is
 * spawned with an ARGV ARRAY, `shell:false`, a FIXED cwd and a TIMEOUT.
 * No diagram/template content is ever interpolated into a shell string.
 *
 * On a compile failure the offending generated file path is mapped back
 * through the manifest to its template id and both are printed (the check
 * "fails loudly and identifies the offending template").
 *
 * Usage: node tools/golden-check.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CODEGEN_DIR = join(REPO_ROOT, 'packages', 'codegen');
const HELPER = join(REPO_ROOT, 'tools', 'golden-generate.ts');

const BUILD_TIMEOUT_MS = 15 * 60 * 1000; // first run downloads Maven + Spring deps
const START_TIMEOUT_MS = 120 * 1000; // app readiness poll
const HTTP_TIMEOUT_MS = 10 * 1000; // individual fetch budget
const PORT = 18080; // avoid clashing with a locally running 8080

function log(msg) {
  console.log(`[golden-check] ${msg}`);
}

function fail(msg) {
  console.error(`[golden-check] FAIL: ${msg}`);
  process.exitCode = 1;
  throw new Error(msg);
}

/**
 * Spawn with the threat-row-2 guarantees: argv array, shell:false, fixed cwd,
 * timeout (kills the whole process tree on expiry). Resolves with
 * {code, signal, output, child, timedOut}; rejects only on spawn errors.
 */
function run(argv0, args, opts) {
  const { timeout, ...spawnOpts } = opts;
  return new Promise((res, rej) => {
    const child = spawn(argv0, args, { shell: false, ...spawnOpts });
    let output = '';
    let timedOut = false;
    const timer = timeout
      ? setTimeout(() => {
          timedOut = true;
          killTree(child).catch(() => {});
        }, timeout)
      : null;
    if (timer) timer.unref();
    child.stdout?.on('data', (d) => (output += d.toString()));
    child.stderr?.on('data', (d) => (output += d.toString()));
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      rej(err);
    });
    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      res({ code, signal, output, child, timedOut });
    });
  });
}

/** Kill a possibly-tree-owned child (timeout/signal path on Windows). */
async function killTree(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    await run('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], {
      cwd: REPO_ROOT,
      stdio: 'ignore',
    }).catch(() => {});
  } else {
    child.kill('SIGKILL');
  }
}

/** Resolve after the given milliseconds. */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Remove a directory tree, retrying while the OS releases file handles.
 * On Windows a killed java process can keep the sandbox locked for a
 * moment after taskkill returns; cleanup must never turn a green check red,
 * so failures after the retry budget are reported as non-fatal warnings.
 */
async function rmRetry(dir, attempts = 20, delayMs = 500) {
  for (let i = 0; ; i++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      if (i >= attempts - 1) {
        console.error(`[golden-check] sandbox cleanup failed (non-fatal): ${err?.message ?? err}`);
        console.error(`[golden-check] leftover sandbox: ${dir}`);
        return;
      }
      await sleep(delayMs);
    }
  }
}

async function waitForUrl(url, deadlineMs) {
  const start = Date.now();
  let lastError = 'n/a';
  while (Date.now() - start < deadlineMs) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
      if (res.ok) return true;
      lastError = `HTTP ${res.status}`;
    } catch (err) {
      lastError = err?.cause?.code ?? err?.message ?? String(err);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  fail(`app did not become ready at ${url} within ${deadlineMs}ms (last error: ${lastError})`);
}

/** Map javac error lines in Maven output back to generated file + template. */
function reportCompileFailure(mavenOutput, manifest) {
  const byPath = new Map(manifest.files.map((f) => [f.path, f.template]));
  const offenders = new Set();
  for (const line of mavenOutput.split(/\r?\n/)) {
    const m = /\[ERROR\]\s+.*?((?:src[/\\]main[/\\]java[/\\][^\s:]+\.java)|pom\.xml)/.exec(line);
    if (m) offenders.add(m[1].replace(/\\/g, '/'));
  }
  if (offenders.size === 0) {
    console.error(mavenOutput.slice(-4000));
    fail('build failed without a locatable generated file (full tail above)');
  }
  for (const path of offenders) {
    const template = byPath.get(path) ?? '(not a generated file)';
    console.error(
      `[golden-check] OFFENDING TEMPLATE: "${template}" → generated file: ${path}`,
    );
  }
  const first = [...offenders][0];
  try {
    const content = readFileSync(join(sandbox, first), 'utf8');
    console.error(`----- content of ${first} -----\n${content}`);
  } catch {
    /* file may not exist for pom.xml-less failures */
  }
  fail(`golden build is red — ${offenders.size} offending generated file(s)`);
}

/**
 * Resolve JAVA_HOME from the `java` on PATH (mvnw.cmd requires it).
 * Still argv-array + shell:false — we only read, never install anything.
 */
async function resolveJavaHome() {
  if (process.env.JAVA_HOME) return process.env.JAVA_HOME;
  const probe = await run('java.exe', ['-XshowSettings:properties', '-version'], {
    cwd: REPO_ROOT,
    timeout: 30_000,
  });
  const m = /java\.home\s*=\s*(.+)/.exec(probe.output);
  if (!m) fail('could not resolve java.home from `java -XshowSettings:properties -version`');
  return m[1].trim();
}

let sandbox = null;
let appChild = null;

try {
  // (b) fresh sandbox under the OS temp dir
  sandbox = mkdtempSync(join(tmpdir(), 'ai-uml-golden-'));
  log(`sandbox: ${sandbox}`);

  // (a) generate from the golden diagram through the TS seam (tsx loader)
  const gen = await run(
    process.execPath,
    ['--import', 'tsx', HELPER, sandbox],
    { cwd: CODEGEN_DIR, timeout: 60_000 },
  );
  if (gen.code !== 0) {
    console.error(gen.output);
    fail(`generation step exited with code ${gen.code}`);
  }
  log(gen.output.trim());
  const manifest = JSON.parse(readFileSync(join(sandbox, '.golden-manifest.json'), 'utf8'));

  // (c) build — argv array, shell:false, fixed cwd, timeout (threat row 2)
  log('building with the vendored Maven wrapper (first run downloads Maven + deps)…');
  const javaHome = await resolveJavaHome();
  log(`JAVA_HOME=${javaHome}`);
  const build = await run(
    'cmd.exe',
    ['/d', '/s', '/c', 'mvnw.cmd', '-q', '-DskipTests', 'package'],
    { cwd: sandbox, timeout: BUILD_TIMEOUT_MS, env: { ...process.env, JAVA_HOME: javaHome } },
  );
  if (build.timedOut) {
    fail(`build timed out after ${BUILD_TIMEOUT_MS}ms — killed the wrapper process tree`);
  }
  if (build.code !== 0) {
    reportCompileFailure(build.output, manifest);
  }
  log('BUILD SUCCESS');

  // (d) start the packaged jar and exercise one CRUD round-trip
  const targetDir = join(sandbox, 'target');
  const jar = readdirSync(targetDir).find(
    (f) => f.endsWith('.jar') && !f.startsWith('original-'),
  );
  if (!jar) fail('no boot jar found in target/ after package');
  appChild = spawn('java', ['-jar', join(targetDir, jar), `--server.port=${PORT}`], {
    cwd: sandbox,
    shell: false,
    stdio: 'ignore',
  });
  const base = `http://127.0.0.1:${PORT}`;
  await waitForUrl(`${base}/api/customers`, START_TIMEOUT_MS);
  log('app is up');

  const created = await fetch(`${base}/api/customers`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Ada Lovelace', email: 'ada@example.com', active: true }),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  if (created.status !== 201) fail(`POST /api/customers expected 201, got ${created.status}`);
  const createdBody = await created.json();
  if (typeof createdBody.id !== 'number') fail('created entity has no numeric id');

  const list = await fetch(`${base}/api/customers`, {
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  if (!list.ok) fail(`GET /api/customers expected 200, got ${list.status}`);
  const listBody = await list.json();
  if (!Array.isArray(listBody) || !listBody.some((c) => c.id === createdBody.id)) {
    fail('GET /api/customers does not list the created entity');
  }
  log(`CRUD round-trip OK (customer id=${createdBody.id})`);
  log('GOLDEN CHECK GREEN');
} catch (err) {
  if (process.exitCode === undefined || process.exitCode === 0) {
    console.error(`[golden-check] FAIL: ${err?.stack ?? err}`);
    process.exitCode = 1;
  }
} finally {
  // (e) teardown: kill the app, wait for real exit (Windows handle release),
  // then remove the sandbox with retries (kept on failure for debug)
  if (appChild) {
    await killTree(appChild).catch(() => {});
    if (appChild.exitCode === null && appChild.signalCode === null) {
      await new Promise((resolve) => appChild.once('exit', resolve));
    }
  }
  if (sandbox && process.exitCode !== 1) {
    await rmRetry(sandbox);
  } else if (sandbox) {
    console.error(`[golden-check] sandbox kept for debugging: ${sandbox}`);
  }
}
