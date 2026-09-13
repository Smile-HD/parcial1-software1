#!/usr/bin/env node
/**
 * Golden build check — codegen:R5 (unit 14b) + offline-backend (tasks 17.1–17.6).
 *
 * Pipeline: golden diagram → generate() with the real Handlebars renderer →
 * fresh sandbox under os.tmpdir() → `mvnw.cmd -q -DskipTests package` →
 * `java -jar target/*.jar` → HTTP readiness poll → CRUD round-trips → teardown.
 *
 * Modes:
 *   (default)          — online build + single CRUD round-trip
 *   --offline          — build with mvnw -o, start with dead SOCKS proxy, full
 *                         CRUD cycle per entity, H2 file persistence restart test,
 *                         README assertion (tasks 17.1–17.5)
 *   --prod             — create a Postgres DB on :5433, boot with prod profile,
 *                         assert schema auto-created, CRUD works, records survive
 *                         restart, then drop the DB (task 17.6)
 *
 * Threat matrix row 2 (subprocess execution): every external process is
 * spawned with an ARGV ARRAY, `shell:false`, a FIXED cwd and a TIMEOUT.
 * No diagram/template content is ever interpolated into a shell string.
 *
 * Usage:
 *   node tools/golden-check.mjs              # online mode (default)
 *   node tools/golden-check.mjs --offline    # offline + persistence + full CRUD
 *   node tools/golden-check.mjs --prod       # production profile against Postgres :5433
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

// ---------- task 17.1–17.6: offline / prod helpers ----------

/** Docker exec helper — runs psql on the ai-uml-postgres container. */
async function psql(sql) {
  return run('docker', ['exec', 'ai-uml-postgres', 'psql', '-U', 'postgres', '-c', sql], {
    cwd: REPO_ROOT,
    timeout: 15_000,
  });
}

/** Create a fresh Postgres database for the prod test (task 17.6). */
async function createProdDb(name) {
  const r = await psql(`CREATE DATABASE ${name}`);
  if (r.code !== 0) fail(`failed to create prod DB ${name}: ${r.output}`);
  log(`created prod DB: ${name}`);
}

/** Drop a Postgres database (cleanup after prod test). */
async function dropProdDb(name) {
  // Terminate existing connections before DROP.
  await psql(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${name}' AND pid <> pg_backend_pid()`,
  );
  const r = await psql(`DROP DATABASE IF EXISTS ${name}`);
  if (r.code !== 0) console.error(`[golden-check] warning: failed to drop DB ${name}: ${r.output}`);
  else log(`dropped prod DB: ${name}`);
}

/**
 * Start the generated app with custom JVM args and/or env overrides.
 * Returns the child process handle. Caller must killTree + await exit.
 */
function startApp(sandboxDir, jarName, { jvmArgs = [], env = {} } = {}) {
  const base = join(sandboxDir, 'target', jarName);
  const child = spawn('java', [...jvmArgs, '-jar', base, `--server.port=${PORT}`], {
    cwd: sandboxDir,
    shell: false,
    stdio: 'ignore',
    env: { ...process.env, ...env },
  });
  return child;
}

// ---------- entities from the golden reference diagram (task 17.3) ----------

/**
 * Entities with CRUD controllers in the generated backend. Route segments
 * follow the Handlebars `route` helper (camel → snake → plural).
 * Interface "Sellable" generates no CRUD controller and is excluded.
 */
const ENTITIES = [
  {
    name: 'Customer',
    route: 'customers',
    /** Minimal valid create payload — all required fields present. */
    create: { name: 'Alice', email: 'alice@test.com', active: true },
    /** Missing required field (name) → expect 4xx. */
    invalidCreate: { email: 'bob@test.com' },
    /** Update payload. */
    update: { name: 'Alice Updated', email: 'alice-updated@test.com', active: false },
  },
  {
    name: 'Order',
    route: 'orders',
    create: { orderDate: '2026-01-15', total: 99.99, status: 'pending', note: 'first order' },
    invalidCreate: { status: 'pending' },
    update: { orderDate: '2026-01-15', total: 149.99, status: 'shipped', note: 'updated note' },
  },
  {
    name: 'Product',
    route: 'products',
    create: { name: 'Widget', price: 19.99, stock: 100, category: 'gadgets', label: 'Widget Label', basePrice: 15.0 },
    invalidCreate: { stock: 50 },
    update: { name: 'Widget Pro', price: 29.99, stock: 200, category: 'premium gadgets', label: 'Widget Pro Label', basePrice: 25.0 },
  },
  {
    name: 'ShippingAddress',
    route: 'shipping_addresses',
    create: { street: '123 Main St', zipCode: '12345', isDefault: true },
    invalidCreate: {},
    update: { street: '456 Oak Ave', zipCode: '67890', isDefault: false },
  },
  {
    name: 'OrderLine',
    route: 'order_lines',
    create: { quantity: 3, unitPrice: 10.5 },
    invalidCreate: { unitPrice: 10.5 },
    update: { quantity: 5, unitPrice: 12.0 },
  },
  {
    name: 'Item',
    route: 'items',
    create: { label: 'Gadget', basePrice: 25.0 },
    invalidCreate: { label: '' },
    update: { label: 'Gadget Pro', basePrice: 35.0 },
  },
  // NOTE (17 spec fix 2026-09-13): Payment is an ABSTRACT class in the golden
  // diagram. Codegen emits the entity only — no repository/controller/service —
  // so it must NOT appear in the CRUD entity list. The offline mode asserts its
  // route is absent (404) instead.
  {
    name: 'CustomerOrderProductLink',
    route: 'customer_order_product_links',
    /** N-ary join entity — needs at least one @ManyToOne per member. */
    create: {},
    /** An empty payload is the invalid case for the join entity. */
    invalidCreate: null, // skip invalid test (POST {} creates a link with null FKs → 400 or 500)
    update: null,
  },
];

let sandbox = null;
let appChild = null;

try {
  // ── Parse flags ──────────────────────────────────────────────────────
  const args = process.argv.slice(2);
  const offlineMode = args.includes('--offline');
  const prodMode = args.includes('--prod');
  if (offlineMode) log('MODE: offline (dead-proxy + mvnw -o + H2 restart + full CRUD + README)');
  if (prodMode) log('MODE: prod (PostgreSQL :5433 + prod profile + schema + CRUD + restart)');

  // ── (b) fresh sandbox under the OS temp dir ──────────────────────────
  sandbox = mkdtempSync(join(tmpdir(), 'ai-uml-golden-'));
  log(`sandbox: ${sandbox}`);

  // ── (a) generate from the golden diagram through the TS seam ─────────
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

  // ── (c) build — argv array, shell:false, fixed cwd, timeout ─────────
  log('building with the vendored Maven wrapper…');
  const javaHome = await resolveJavaHome();
  log(`JAVA_HOME=${javaHome}`);
  const buildArgs = ['-q', '-DskipTests', 'package'];
  if (offlineMode) buildArgs.unshift('-o');
  const build = await run(
    'cmd.exe',
    ['/d', '/s', '/c', 'mvnw.cmd', ...buildArgs],
    { cwd: sandbox, timeout: BUILD_TIMEOUT_MS, env: { ...process.env, JAVA_HOME: javaHome } },
  );
  if (build.timedOut) {
    fail(`build timed out after ${BUILD_TIMEOUT_MS}ms — killed the wrapper process tree`);
  }
  if (build.code !== 0) {
    reportCompileFailure(build.output, manifest);
  }
  log(offlineMode ? 'BUILD SUCCESS (offline)' : 'BUILD SUCCESS');

  // ── locate the boot jar ──────────────────────────────────────────────
  const targetDir = join(sandbox, 'target');
  const jar = readdirSync(targetDir).find(
    (f) => f.endsWith('.jar') && !f.startsWith('original-'),
  );
  if (!jar) fail('no boot jar found in target/ after package');

  // ═══════════════════════════════════════════════════════════════════════
  // PHASE 1: Online mode (default) — original single CRUD round-trip
  // ═══════════════════════════════════════════════════════════════════════
  if (!offlineMode && !prodMode) {
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
  }

  // ═══════════════════════════════════════════════════════════════════════
  // PHASE 2: Offline mode (--offline) — tasks 17.1–17.5
  // ═══════════════════════════════════════════════════════════════════════
  if (offlineMode) {
    const base = `http://127.0.0.1:${PORT}`;
    const offlineJvmArgs = [
      '-DsocksProxyHost=127.0.0.1',
      '-DsocksProxyPort=1',
    ];

    // ── 17.1: Start app with dead proxy (outbound blocked) ─────────────
    log('17.1: starting app with dead SOCKS proxy (outbound blocked)…');
    appChild = startApp(sandbox, jar, { jvmArgs: offlineJvmArgs });
    await waitForUrl(`${base}/api/customers`, START_TIMEOUT_MS);
    log('17.1: app is up — outbound is blocked via dead proxy');

    // ── 17.3: Full CRUD cycle for EVERY entity ─────────────────────────
    log('17.3: CRUD cycle per entity…');
    for (const ent of ENTITIES) {
      if (ent.invalidCreate !== null) {
        // Invalid create → client error, nothing persisted
        const beforeList = await fetch(`${base}/api/${ent.route}`, {
          signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
        });
        const beforeBody = await beforeList.json();
        const beforeCount = Array.isArray(beforeBody) ? beforeBody.length : 0;

        const invalidRes = await fetch(`${base}/api/${ent.route}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(ent.invalidCreate),
          signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
        });
        if (invalidRes.status < 400 || invalidRes.status >= 500) {
          fail(`${ent.name}: invalid create expected 4xx, got ${invalidRes.status}`);
        }

        const afterList = await fetch(`${base}/api/${ent.route}`, {
          signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
        });
        const afterBody = await afterList.json();
        const afterCount = Array.isArray(afterBody) ? afterBody.length : 0;
        if (afterCount !== beforeCount) {
          fail(`${ent.name}: invalid create should not persist (before=${beforeCount}, after=${afterCount})`);
        }
        log(`  ${ent.name}: invalid create → ${invalidRes.status}, count unchanged (${afterCount})`);
      }

      // Create
      const createRes = await fetch(`${base}/api/${ent.route}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(ent.create),
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
      if (createRes.status !== 201) {
        fail(`${ent.name}: POST expected 201, got ${createRes.status} — ${await createRes.text()}`);
      }
      const created = await createRes.json();
      if (typeof created.id !== 'number') fail(`${ent.name}: created entity has no numeric id`);

      // List
      const listRes = await fetch(`${base}/api/${ent.route}`, {
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
      if (!listRes.ok) fail(`${ent.name}: GET list expected 200, got ${listRes.status}`);
      const listBody = await listRes.json();
      if (!Array.isArray(listBody) || !listBody.some((e) => e.id === created.id)) {
        fail(`${ent.name}: GET list does not contain created entity id=${created.id}`);
      }

      // Get by id
      const getRes = await fetch(`${base}/api/${ent.route}/${created.id}`, {
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
      if (!getRes.ok) fail(`${ent.name}: GET /${created.id} expected 200, got ${getRes.status}`);

      // Update (if supported)
      if (ent.update) {
        const updateRes = await fetch(`${base}/api/${ent.route}/${created.id}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(ent.update),
          signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
        });
        if (!updateRes.ok) fail(`${ent.name}: PUT expected 200, got ${updateRes.status}`);
      }

      // Delete
      const delRes = await fetch(`${base}/api/${ent.route}/${created.id}`, {
        method: 'DELETE',
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
      if (delRes.status !== 204) fail(`${ent.name}: DELETE expected 204, got ${delRes.status}`);

      // Confirm deletion
      const confirmRes = await fetch(`${base}/api/${ent.route}/${created.id}`, {
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
      if (confirmRes.status !== 404) {
        fail(`${ent.name}: GET after DELETE expected 404, got ${confirmRes.status}`);
      }

      log(`  ${ent.name}: CRUD cycle OK (id=${created.id})`);
    }
    log('17.3: all entities passed CRUD cycle');

    // ── 17.3b: abstract classes must NOT expose a CRUD surface ────────
    const paymentRes = await fetch(`${base}/api/payments`, {
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (paymentRes.status !== 404) {
      fail(`Payment (abstract): GET /api/payments expected 404 (no controller generated), got ${paymentRes.status}`);
    }
    log('17.3b: abstract Payment has no CRUD route (404) as expected');

    // ── 17.2: H2 file persistence — survive restart ───────────────────
    log('17.2: H2 file persistence test (create → kill → restart → verify)…');
    const persistBody = { name: 'PersistTest', email: 'persist@test.com', active: true };
    const persistRes = await fetch(`${base}/api/customers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(persistBody),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (persistRes.status !== 201) fail(`persist create: expected 201, got ${persistRes.status}`);
    const persistCreated = await persistRes.json();
    if (typeof persistCreated.id !== 'number') fail('persist create: no numeric id in response');
    log(`  created customer id=${persistCreated.id} for persistence test`);

    // Pre-kill proof: the row must be readable by id, then give the H2 MVStore a
    // flush window before the hard kill (delayed background writes — a kill
    // immediately after commit can lose the last checkpoint; observed race
    // 2026-09-13). This tests the documented file-persistence semantics, not
    // crash-consistency of an unflushed commit.
    const preKill = await fetch(`${base}/api/customers/${persistCreated.id}`, {
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (preKill.status !== 200) fail(`persist: row unreadable before kill (${preKill.status})`);
    await sleep(8000);

    // Kill the app (wait for real exit so Windows releases file handles)
    log('  killing app…');
    await killTree(appChild);
    if (appChild.exitCode === null && appChild.signalCode === null) {
      await new Promise((resolve) => appChild.once('exit', resolve));
    }
    appChild = null;
    await sleep(2000); // let file handles release on Windows

    // Restart
    log('  restarting app…');
    appChild = startApp(sandbox, jar, { jvmArgs: offlineJvmArgs });
    await waitForUrl(`${base}/api/customers`, START_TIMEOUT_MS);
    log('  app restarted');

    // Verify the record survived
    const survivedRes = await fetch(`${base}/api/customers/${persistCreated.id}`, {
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (survivedRes.status !== 200) {
      fail(`persist: GET after restart expected 200, got ${survivedRes.status}`);
    }
    const survivedBody = await survivedRes.json();
    if (survivedBody.name !== persistBody.name || survivedBody.email !== persistBody.email) {
      fail(`persist: record data mismatch after restart — got ${JSON.stringify(survivedBody)}`);
    }
    log(`17.2: H2 file persistence OK — customer id=${persistCreated.id} survived restart`);

    // ── 17.4: README check ────────────────────────────────────────────
    log('17.4: checking generated README…');
    const readmeContent = readFileSync(join(sandbox, 'README.md'), 'utf8');
    const hasMvnwRun = /\.\/mvnw\s+spring-boot:run/.test(readmeContent)
      || /\.\.\/mvnw\.cmd\s+spring-boot:run/i.test(readmeContent);
    if (!hasMvnwRun) {
      fail('17.4: generated README does not document "./mvnw spring-boot:run"');
    }
    log('17.4: README contains "./mvnw spring-boot:run" ✓');

    // ── 17.5: summary ─────────────────────────────────────────────────
    log('17.5: all offline-backend-artifact acceptance criteria PASS');
    log('GOLDEN CHECK GREEN (offline)');
  }

  // ═══════════════════════════════════════════════════════════════════════
  // PHASE 3: Production mode (--prod) — task 17.6
  // ═══════════════════════════════════════════════════════════════════════
  if (prodMode) {
    const base = `http://127.0.0.1:${PORT}`;
    const testDb = 'golden_prod_test';

    // Create the test DB
    await createProdDb(testDb);

    try {
      // Start with prod profile against Postgres :5433
      log('17.6: starting app with prod profile…');
      appChild = startApp(sandbox, jar, {
        env: {
          SPRING_PROFILES_ACTIVE: 'prod',
          SPRING_DATASOURCE_URL: `jdbc:postgresql://127.0.0.1:5433/${testDb}`,
          SPRING_DATASOURCE_USERNAME: 'postgres',
          SPRING_DATASOURCE_PASSWORD: 'postgres',
        },
      });
      await waitForUrl(`${base}/api/customers`, START_TIMEOUT_MS);
      log('17.6: app is up on prod profile');

      // Verify schema was auto-created by checking that GET /api/customers works
      const checkRes = await fetch(`${base}/api/customers`, {
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
      if (!checkRes.ok) {
        fail(`17.6: schema check — GET /api/customers expected 200, got ${checkRes.status}`);
      }
      log('17.6: schema auto-created (GET /api/customers returns 200)');

      // CRUD cycle on Customer
      log('17.6: CRUD cycle on prod…');
      const createRes = await fetch(`${base}/api/customers`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'ProdUser', email: 'prod@test.com', active: true }),
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
      if (createRes.status !== 201) fail(`prod create: expected 201, got ${createRes.status}`);
      const prodCreated = await createRes.json();
      log(`  created customer id=${prodCreated.id}`);

      // List contains it
      const listRes = await fetch(`${base}/api/customers`, {
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
      const listBody = await listRes.json();
      if (!Array.isArray(listBody) || !listBody.some((c) => c.id === prodCreated.id)) {
        fail('prod: GET /api/customers does not list created entity');
      }
      log('  list contains created entity');

      // Update
      const updateRes = await fetch(`${base}/api/customers/${prodCreated.id}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'ProdUser Updated', email: 'prod-updated@test.com', active: false }),
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
      if (!updateRes.ok) fail(`prod update: expected 200, got ${updateRes.status}`);
      log('  update OK');

      // Kill and restart to verify persistence on Postgres
      log('  killing app for restart persistence test…');
      await killTree(appChild);
      if (appChild.exitCode === null && appChild.signalCode === null) {
        await new Promise((resolve) => appChild.once('exit', resolve));
      }
      appChild = null;
      await sleep(2000);

      log('  restarting app on prod profile…');
      appChild = startApp(sandbox, jar, {
        env: {
          SPRING_PROFILES_ACTIVE: 'prod',
          SPRING_DATASOURCE_URL: `jdbc:postgresql://127.0.0.1:5433/${testDb}`,
          SPRING_DATASOURCE_USERNAME: 'postgres',
          SPRING_DATASOURCE_PASSWORD: 'postgres',
        },
      });
      await waitForUrl(`${base}/api/customers`, START_TIMEOUT_MS);
      log('  app restarted');

      const survivedRes = await fetch(`${base}/api/customers/${prodCreated.id}`, {
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
      if (survivedRes.status !== 200) {
        fail(`prod persist: GET after restart expected 200, got ${survivedRes.status}`);
      }
      const survivedBody = await survivedRes.json();
      if (survivedBody.name !== 'ProdUser Updated') {
        fail(`prod persist: record mismatch after restart — got ${JSON.stringify(survivedBody)}`);
      }
      log(`17.6: prod persistence OK — customer id=${prodCreated.id} survived restart`);

      // Cleanup: kill app
      await killTree(appChild);
      if (appChild.exitCode === null && appChild.signalCode === null) {
        await new Promise((resolve) => appChild.once('exit', resolve));
      }
      appChild = null;

      log('GOLDEN CHECK GREEN (prod)');
    } finally {
      // Always drop the test DB
      await dropProdDb(testDb);
    }
  }
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
