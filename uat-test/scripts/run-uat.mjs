#!/usr/bin/env node
// Runs the Cypress suite against a live openIMIS instance and writes a UAT report
// keyed on TestLink external ids. A Cypress test covers a UAT case when its full
// title (describe + it) contains the tag OCM-<externalid>, e.g. "Signs in (OCM-1122)".
//
// Usage:
//   node scripts/run-uat.mjs [--spec cypress/e2e/auth.cy.js] [--base-url http://localhost:3000]
//                            [--browser chrome] [--headed] [--keep-config] [--spec-timeout 45]
//                            [--parallel 3] [--report-only [dir]]
//
// Each spec runs in its own process; one still running after --spec-timeout minutes
// is killed and its tests reported as failed, so a hang cannot stall the whole run.
// Per-spec console output is kept in reports/<timestamp>/logs/.
//
// --parallel N runs up to N specs at once. Specs that change shared state (module
// configuration, the login lockout: see EXCLUSIVE) still run one at a time, first; the
// others then run against the pinned configuration, which the runner applies once
// instead of every spec re-applying it under the others.
//
// Module configurations are backed up before the run and restored afterwards; each spec
// file runs against uat/module-config.pinned.json. --keep-config skips the restore.
//
// Outputs reports/<timestamp>/{report.html, uat-results.json, junit.xml, testlink-results.xml}
// and refreshes reports/latest.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CATALOG_PATH = path.join(ROOT, "uat", "catalog.json");
const REPORTS_DIR = path.join(ROOT, "reports");
const DEFAULT_BASE_URL = "http://localhost:3000"; // scripts/start-uat-stack.sh
const TAG_RE = /\bOCM-(\d+)\b/g;

function parseArgs(argv) {
  const args = { headed: false, keepConfig: false, specTimeoutMin: 45, parallel: 1 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--spec") args.spec = next();
    else if (a === "--base-url") args.baseUrl = next();
    else if (a === "--browser") args.browser = next();
    else if (a === "--headed") args.headed = true;
    else if (a === "--keep-config") args.keepConfig = true;
    else if (a === "--spec-timeout") args.specTimeoutMin = Number(next());
    else if (a === "--parallel") args.parallel = Math.max(1, Number(next()) || 1);
    else if (a === "--report-only") args.reportOnly = argv[i + 1] && !argv[i + 1].startsWith("--") ? next() : "latest";
    else if (a === "--help" || a === "-h") {
      console.log(fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1, 18).join("\n"));
      process.exit(0);
    } else throw new Error(`Unknown argument: ${a}`);
  }
  return args;
}

function loadCatalog() {
  if (!fs.existsSync(CATALOG_PATH)) {
    console.warn(`No catalog at ${CATALOG_PATH}: the report will only list automated tests.`);
    return [];
  }
  return JSON.parse(fs.readFileSync(CATALOG_PATH, "utf8")).cases;
}

// Flattens the Cypress module API result into one record per executed test.
function flattenCypressResults(results) {
  const tests = [];
  for (const run of results.runs ?? []) {
    for (const t of run.tests ?? []) {
      const fullTitle = t.title.join(" > ");
      const ids = [...new Set([...fullTitle.matchAll(TAG_RE)].map((m) => m[1]))];
      const attempts = t.attempts ?? [];
      tests.push({
        spec: run.spec.relative,
        title: t.title,
        fullTitle,
        state: t.state, // passed | failed | pending | skipped
        durationMs: t.duration ?? attempts.reduce((s, a) => s + (a.duration ?? 0), 0),
        attempts: Math.max(attempts.length, 1),
        error: t.displayError ? t.displayError.split("\n").slice(0, 6).join("\n") : null,
        ids,
      });
    }
  }
  return tests;
}

// A UAT case passes only if every Cypress test tagged with it passed.
function aggregate(catalog, tests) {
  const byId = new Map();
  for (const t of tests) for (const id of t.ids) (byId.get(id) ?? byId.set(id, []).get(id)).push(t);

  const known = new Set(catalog.map((c) => c.id));
  const cases = catalog.map((c) => {
    const covering = byId.get(c.id) ?? [];
    let result;
    // in_scope is set once the review is validated (scripts/apply-decisions.mjs); until then the verdict decides.
    const inScope = c.in_scope ?? (c.verdict === "KEEP" || c.verdict === "UPDATE");
    if (!covering.length) result = inScope ? "not_automated" : "out_of_scope";
    else if (covering.some((t) => t.state === "failed")) result = "failed";
    else if (covering.every((t) => t.state === "passed")) result = "passed";
    else result = "skipped";
    return {
      ...c,
      result,
      durationMs: covering.reduce((s, t) => s + t.durationMs, 0),
      tests: covering.map((t) => ({ spec: t.spec, fullTitle: t.fullTitle, state: t.state, durationMs: t.durationMs, error: t.error })),
    };
  });
  const unknownIds = [...byId.keys()].filter((id) => !known.has(id));
  const untagged = tests.filter((t) => !t.ids.length);
  return { cases, unknownIds, untagged };
}

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
const secs = (ms) => (ms / 1000).toFixed(1);

function junitXml(meta, tests) {
  const bySpec = Object.groupBy(tests, (t) => t.spec);
  const suites = Object.entries(bySpec).map(([spec, ts]) => {
    const failures = ts.filter((t) => t.state === "failed").length;
    const skipped = ts.filter((t) => t.state !== "passed" && t.state !== "failed").length;
    const time = secs(ts.reduce((s, t) => s + t.durationMs, 0));
    const cases = ts
      .map((t) => {
        const name = esc(t.title.at(-1));
        const cls = esc(t.title.slice(0, -1).join(" > ") || spec);
        let body = "";
        if (t.state === "failed") body = `<failure message="${esc(t.error?.split("\n")[0])}">${esc(t.error)}</failure>`;
        else if (t.state !== "passed") body = "<skipped/>";
        return `    <testcase classname="${cls}" name="${name}" time="${secs(t.durationMs)}">${body}</testcase>`;
      })
      .join("\n");
    return `  <testsuite name="${esc(spec)}" tests="${ts.length}" failures="${failures}" skipped="${skipped}" time="${time}">\n${cases}\n  </testsuite>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="openIMIS UAT" timestamp="${meta.startedAt}">\n${suites.join("\n")}\n</testsuites>\n`;
}

// TestLink "import results" format; execution_duration is in minutes.
function testlinkXml(meta, cases) {
  const code = { passed: "p", failed: "f", skipped: "b" };
  const rows = cases
    .filter((c) => code[c.result])
    .map((c) => {
      const notes = c.tests.map((t) => `[${t.state}] ${t.spec}: ${t.fullTitle}${t.error ? `\n${t.error}` : ""}`).join("\n");
      return `  <testcase external_id="OCM-${c.id}">
    <tester>${esc(meta.tester)}</tester>
    <timestamp>${meta.startedAt.replace("T", " ").slice(0, 19)}</timestamp>
    <result>${code[c.result]}</result>
    <execution_duration>${(c.durationMs / 60000).toFixed(2)}</execution_duration>
    <notes><![CDATA[Automated (Cypress) against ${meta.baseUrl}\n${notes}]]></notes>
  </testcase>`;
    });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<results>\n${rows.join("\n")}\n</results>\n`;
}

function htmlReport(meta, agg, tests) {
  const count = (pred) => agg.cases.filter(pred).length;
  const inScope = agg.cases.filter((c) => c.result !== "out_of_scope");
  const tiles = [
    ["UAT cases", agg.cases.length],
    ["In scope (keep/update)", inScope.length],
    ["Passed", count((c) => c.result === "passed"), "passed"],
    ["Failed", count((c) => c.result === "failed"), "failed"],
    ["Not automated yet", count((c) => c.result === "not_automated"), "pending"],
    ["Cypress tests run", tests.length],
    ["Run time", `${secs(meta.durationMs)} s`],
  ];
  const badge = (r) => `<span class="badge ${esc(r)}">${esc(r.replace("_", " "))}</span>`;
  const bySpec = Object.entries(Object.groupBy(tests, (t) => t.spec));
  const specRows = bySpec
    .map(([spec, ts]) => {
      const n = (st) => ts.filter((t) => t.state === st).length;
      const other = ts.length - n("passed") - n("failed");
      const state = n("failed") ? "failed" : other ? "skipped" : "passed";
      return `<tr><td><code>${esc(spec)}</code></td><td>${badge(state)}</td><td class="num">${ts.length}</td><td class="num">${n("passed")}</td><td class="num">${n("failed")}</td><td class="num">${other}</td><td class="num">${secs(ts.reduce((a, t) => a + t.durationMs, 0))}</td></tr>`;
    })
    .join("");
  const specTable = `<h2>Cypress specs</h2><div class="scroll"><table><thead><tr><th>Spec</th><th>Status</th><th class="num">Tests</th><th class="num">Passed</th><th class="num">Failed</th><th class="num">Not run</th><th class="num">s</th></tr></thead><tbody>${specRows}</tbody></table></div>`;
  const suites = Object.entries(Object.groupBy(agg.cases, (c) => c.suite));
  const caseRow = (c) => {
    const detail = c.tests
      .map(
        (t) =>
          `<li>${badge(t.state)} <code>${esc(t.spec)}</code> ${esc(t.fullTitle)} <span class="muted">${secs(t.durationMs)} s</span>${
            t.error ? `<pre>${esc(t.error)}</pre>` : ""
          }</li>`,
      )
      .join("");
    return `<tr data-result="${esc(c.result)}" data-verdict="${esc(c.verdict)}">
      <td class="mono">OCM-${esc(c.id)}</td>
      <td>${esc(c.name)}${detail ? `<ul class="tests">${detail}</ul>` : ""}</td>
      <td>${esc(c.verdict)}${c.duplicate_of ? ` <span class="muted">of OCM-${esc(c.duplicate_of)}</span>` : ""}</td>
      <td>${esc(c.feasibility ?? "")}</td>
      <td>${badge(c.result)}</td>
      <td class="num">${c.durationMs ? secs(c.durationMs) : ""}</td></tr>`;
  };
  const suiteBlocks = suites
    .map(([suite, cs]) => {
      const p = cs.filter((c) => c.result === "passed").length;
      const f = cs.filter((c) => c.result === "failed").length;
      return `<details class="suite" ${f ? "open" : ""}><summary><b>${esc(suite)}</b> <span class="muted">${cs.length} cases · ${p} passed · ${f} failed</span></summary>
      <div class="scroll"><table><thead><tr><th>ID</th><th>Case</th><th>Verdict</th><th>Automation</th><th>Result</th><th class="num">s</th></tr></thead>
      <tbody>${cs.map(caseRow).join("")}</tbody></table></div></details>`;
    })
    .join("\n");
  const untagged = agg.untagged.length
    ? `<h2>Automated tests without a UAT id</h2><p class="muted">Tag them with OCM-&lt;id&gt; in the title to map them to a UAT case.</p>
       <div class="scroll"><table><thead><tr><th>Spec</th><th>Test</th><th>Result</th><th class="num">s</th></tr></thead><tbody>${agg.untagged
         .map((t) => `<tr><td><code>${esc(t.spec)}</code></td><td>${esc(t.fullTitle)}${t.error ? `<pre>${esc(t.error)}</pre>` : ""}</td><td>${badge(t.state)}</td><td class="num">${secs(t.durationMs)}</td></tr>`)
         .join("")}</tbody></table></div>`
    : "";
  const unknown = agg.unknownIds.length
    ? `<p class="warn">Tags not found in the catalog: ${agg.unknownIds.map((i) => `OCM-${esc(i)}`).join(", ")}</p>`
    : "";

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>openIMIS UAT Report</title>
<style>
:root{--bg:#fafaf9;--fg:#1c1917;--muted:#78716c;--card:#fff;--line:#e7e5e4;--pass:#15803d;--fail:#b91c1c;--pend:#a16207;--na:#57534e;}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#1c1917;--fg:#f5f5f4;--muted:#a8a29e;--card:#292524;--line:#44403c;--pass:#4ade80;--fail:#f87171;--pend:#facc15;--na:#a8a29e;color-scheme:dark}}
:root[data-theme="dark"]{--bg:#1c1917;--fg:#f5f5f4;--muted:#a8a29e;--card:#292524;--line:#44403c;--pass:#4ade80;--fail:#f87171;--pend:#facc15;--na:#a8a29e;color-scheme:dark}
body{margin:0;padding-block:24px;padding-inline:16px;background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,sans-serif}
main{max-width:1200px;margin:auto}h1{margin:0 0 4px}.muted{color:var(--muted)}.mono,code{font-family:ui-monospace,monospace;font-size:12px}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:8px;margin:16px 0}
.tile{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px}.tile b{display:block;font-size:22px}
.tile.passed b{color:var(--pass)}.tile.failed b{color:var(--fail)}.tile.pending b{color:var(--pend)}
.filters{display:flex;flex-wrap:wrap;gap:8px;margin:8px 0 16px}.filters label{background:var(--card);border:1px solid var(--line);border-radius:6px;padding:4px 8px}
.suite{background:var(--card);border:1px solid var(--line);border-radius:8px;margin:8px 0;padding:8px 12px}.suite summary{cursor:pointer}
.scroll{overflow-x:auto}table{width:100%;border-collapse:collapse;margin-top:8px}th,td{text-align:left;vertical-align:top;padding:6px;border-top:1px solid var(--line)}
.num{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}h2{font-size:16px;margin:20px 0 4px}ul.tests{margin:4px 0 0;padding-left:16px}pre{white-space:pre-wrap;font-size:12px;color:var(--fail);margin:4px 0}
.badge{display:inline-block;border-radius:4px;padding:0 6px;font-size:12px;border:1px solid currentColor;white-space:nowrap}
.badge.passed{color:var(--pass)}.badge.failed{color:var(--fail)}.badge.not_automated,.badge.skipped,.badge.pending{color:var(--pend)}.badge.out_of_scope{color:var(--na)}
.warn{color:var(--pend)}
</style></head><body><main>
<h1>openIMIS UAT Report</h1>
<div class="muted">Target <code>${esc(meta.baseUrl)}</code> · started ${esc(meta.startedAt)} · ${esc(meta.browser)} · Cypress ${esc(meta.cypressVersion)}</div>
<div class="tiles">${tiles.map(([l, v, cls]) => `<div class="tile ${cls ?? ""}"><b>${esc(v)}</b>${esc(l)}</div>`).join("")}</div>
${unknown}
${specTable}
<h2>UAT cases</h2>
<div class="filters" id="filters">${["passed", "failed", "skipped", "not_automated", "out_of_scope"]
    .map((r) => `<label><input type="checkbox" value="${r}" ${r === "out_of_scope" ? "" : "checked"}> ${r.replace("_", " ")}</label>`)
    .join("")}</div>
${suiteBlocks}
${untagged}
</main><script>
const apply=()=>{const on=new Set([...document.querySelectorAll('#filters input:checked')].map(i=>i.value));
document.querySelectorAll('tr[data-result]').forEach(tr=>tr.hidden=!on.has(tr.dataset.result));
document.querySelectorAll('details.suite').forEach(d=>d.hidden=![...d.querySelectorAll('tr[data-result]')].some(tr=>!tr.hidden));};
document.getElementById('filters').addEventListener('change',apply);apply();
</script></body></html>`;
}

function writeReports(dir, meta, tests) {
  const agg = aggregate(loadCatalog(), tests);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "uat-results.json"), JSON.stringify({ meta, tests, ...agg }, null, 1));
  fs.writeFileSync(path.join(dir, "junit.xml"), junitXml(meta, tests));
  fs.writeFileSync(path.join(dir, "testlink-results.xml"), testlinkXml(meta, agg.cases));
  const page = htmlReport(meta, agg, tests);
  fs.writeFileSync(path.join(dir, "report.html"), page);
  fs.writeFileSync(
    path.join(dir, "report.artifact.html"),
    page
      .replace(/^<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport"[^>]*>\n?/, "")
      .replace("</style></head><body><main>", "</style><main>")
      .replace("</script></body></html>", "</script>"),
  );
  const latest = path.join(REPORTS_DIR, "latest");
  if (path.resolve(dir) !== path.resolve(latest)) {
    fs.rmSync(latest, { force: true, recursive: true });
    fs.symlinkSync(path.relative(REPORTS_DIR, dir), latest);
  }
  const c = (r) => agg.cases.filter((x) => x.result === r).length;
  console.log(
    `\nUAT: ${c("passed")} passed, ${c("failed")} failed, ${c("not_automated")} not automated` +
      ` (${tests.length} Cypress tests, ${agg.untagged.length} untagged)\nReport: ${path.join(dir, "report.html")}`,
  );
  // Untagged tests count too: a failing Cypress test must fail the run.
  return tests.filter((t) => t.state === "failed").length;
}

function listSpecs(specArg) {
  if (specArg) return specArg.split(",").map((s) => s.trim()).filter(Boolean);
  const dir = path.join(ROOT, "cypress", "e2e");
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".cy.js"))
    .sort()
    .map((f) => path.join("cypress", "e2e", f));
}

// A spec that changes state shared by every spec (module configuration through Django
// admin, login failures) must not run next to others.
const EXCLUSIVE = /\b(setModuleConfig|deleteModuleConfig|loginAdminInterface|resetLoginFailures)\b/;
const isExclusive = (spec) => EXCLUSIVE.test(fs.readFileSync(path.join(ROOT, spec), "utf8"));

// Runs one spec in a child process group, killed after timeoutMs. Resolves with the
// Cypress module API result, or a synthetic failed run when the spec timed out/crashed.
function runSpec(spec, cypressOptions, workDir, timeoutMs, { quiet = false } = {}) {
  const name = path.basename(spec);
  const optionsFile = path.join(workDir, `${name}.options.json`);
  const resultFile = path.join(workDir, `${name}.result.json`);
  const logFile = path.join(workDir, "logs", `${name}.log`);
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  fs.writeFileSync(optionsFile, JSON.stringify({ ...cypressOptions, spec }));
  fs.rmSync(resultFile, { force: true });

  return new Promise((resolve) => {
    const started = Date.now();
    const log = fs.createWriteStream(logFile);
    const child = spawn(process.execPath, [path.join(ROOT, "scripts", "run-spec-worker.mjs"), optionsFile, resultFile], {
      cwd: ROOT,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    for (const stream of [child.stdout, child.stderr]) {
      stream.on("data", (chunk) => {
        if (!quiet) process.stdout.write(chunk); // parallel specs would interleave
        log.write(chunk);
      });
    }
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      console.error(`\n${name}: no result after ${timeoutMs / 60000} min, killing it.`);
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }, timeoutMs);

    child.on("exit", () => {
      clearTimeout(timer);
      log.end();
      if (!timedOut && fs.existsSync(resultFile)) {
        resolve(JSON.parse(fs.readFileSync(resultFile, "utf8")));
        return;
      }
      const reason = timedOut
        ? `Spec killed after ${timeoutMs / 60000} min without finishing (hang); see ${path.relative(ROOT, logFile)}`
        : `Spec process ended without a result; see ${path.relative(ROOT, logFile)}`;
      resolve({
        status: "finished",
        runs: [
          {
            spec: { relative: spec },
            tests: [{ title: [name, "(whole spec)"], state: "failed", duration: Date.now() - started, displayError: reason }],
          },
        ],
      });
    });
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.reportOnly) {
    const dir = path.resolve(REPORTS_DIR, args.reportOnly);
    const prev = JSON.parse(fs.readFileSync(path.join(dir, "uat-results.json"), "utf8"));
    writeReports(fs.realpathSync(dir), prev.meta, prev.tests);
    return;
  }

  const moduleConfig = await import("./module-config.mjs");
  const startedAt = new Date();
  const stamp = startedAt.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const runDir = path.join(REPORTS_DIR, stamp);
  const baseUrl = args.baseUrl ?? process.env.CYPRESS_BASE_URL ?? DEFAULT_BASE_URL;
  const credentials = JSON.parse(fs.readFileSync(path.join(ROOT, "cypress", "fixtures", "cred.json"), "utf8"));
  const configBackup = path.join(runDir, "module-config-before.json");
  const count = await moduleConfig.backup(baseUrl, credentials, configBackup);
  console.log(`Backed up ${count} module configuration(s) to ${configBackup}`);
  // The baseline rebinds task sources (see ensureTaskGroups): the server's own bindings
  // are put back after the run, like the module configurations.
  const { ensureBaseline, backupTaskSources, restoreTaskSources } = await import("./baseline.mjs");
  const taskSourcesBackup = path.join(runDir, "task-sources-before.json");
  fs.writeFileSync(taskSourcesBackup, JSON.stringify(await backupTaskSources(baseUrl, credentials), null, 1));
  // Created here once, so specs running in parallel only read it (each Cypress process
  // still calls ensureBaseline, which then only looks the records up).
  await ensureBaseline(baseUrl, credentials);

  // One cypress.run per spec: clear the screenshots once here, not before each spec.
  fs.rmSync(path.join(ROOT, "cypress", "screenshots"), { recursive: true, force: true });
  const config = { video: false, screenshotOnRunFailure: true, trashAssetsBeforeRuns: false, baseUrl };
  const cypressOptions = { project: ROOT, browser: args.browser, headed: args.headed, config };
  const results = { runs: [] };
  const byspec = new Map();
  const record = (spec, result) => {
    if (result.status === "failed") {
      // Cypress itself could not run (no browser, bad config...), as opposed to failing tests.
      console.error(`Cypress failed to run ${spec}: ${result.message}`);
      process.exitCode = 2;
      return;
    }
    byspec.set(spec, result);
    results.browserName ??= result.browserName;
    results.browserVersion ??= result.browserVersion;
    results.cypressVersion ??= result.cypressVersion;
  };
  const specs = listSpecs(args.spec);
  try {
    const exclusive = args.parallel > 1 ? specs.filter(isExclusive) : specs;
    const shared = specs.filter((s) => !exclusive.includes(s));
    for (const spec of exclusive) {
      record(spec, await runSpec(spec, cypressOptions, runDir, args.specTimeoutMin * 60000));
    }
    if (shared.length) {
      console.log(`\nRunning ${shared.length} spec(s), ${args.parallel} at a time; output in ${path.join(runDir, "logs")}`);
      await moduleConfig.pin(baseUrl, credentials);
      const options = { ...cypressOptions, env: { PIN_MODULE_CONFIG: false } };
      const queue = [...shared];
      const worker = async () => {
        for (let spec = queue.shift(); spec; spec = queue.shift()) {
          const result = await runSpec(spec, options, runDir, args.specTimeoutMin * 60000, { quiet: true });
          const tests = (result.runs ?? []).flatMap((r) => r.tests ?? []);
          const passed = tests.filter((t) => t.state === "passed").length;
          console.log(`  ${path.basename(spec)}: ${passed}/${tests.length} passed`);
          record(spec, result);
        }
      };
      await Promise.all(Array.from({ length: args.parallel }, worker));
    }
    for (const spec of specs) if (byspec.has(spec)) results.runs.push(...(byspec.get(spec).runs ?? []));
  } finally {
    if (args.keepConfig) {
      console.log(`Module configurations and task group bindings left as the run ended them; restore with:\n  node scripts/module-config.mjs restore --file ${configBackup}\n  node scripts/baseline.mjs --restore-task-sources ${taskSourcesBackup}`);
    } else {
      await moduleConfig.restore(baseUrl, credentials, configBackup);
      console.log("Module configurations restored.");
      await restoreTaskSources(baseUrl, credentials, JSON.parse(fs.readFileSync(taskSourcesBackup, "utf8")));
      console.log("Task group bindings restored.");
    }
  }
  const meta = {
    startedAt: startedAt.toISOString(),
    durationMs: Date.now() - startedAt.getTime(),
    baseUrl,
    browser: `${results.browserName ?? args.browser ?? "electron"} ${results.browserVersion ?? ""}`.trim(),
    cypressVersion: results.cypressVersion,
    tester: process.env.UAT_TESTER ?? process.env.USER ?? "automation",
  };
  const failed = writeReports(runDir, meta, flattenCypressResults(results));
  process.exit(process.exitCode ?? (failed ? 1 : 0));
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
