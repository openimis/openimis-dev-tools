#!/usr/bin/env node
// Folds the decisions exported from uat/review.html into uat/catalog.json.
//   accept -> the proposal stands: validated_steps = proposed (or original for KEEP),
//             in_scope follows the verdict (KEEP/UPDATE in, DUPLICATE/OBSOLETE/NOT_INSTALLED out)
//   reject -> the case stays as originally written: validated_steps = original, in_scope = true
//   change -> left pending with the reviewer's note
// Usage: node scripts/apply-decisions.mjs [path/to/decisions.json]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const catalogPath = path.join(ROOT, "uat", "catalog.json");
const decisionsPath = path.resolve(process.argv[2] ?? path.join(ROOT, "uat", "decisions.json"));

const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
const { decisions } = JSON.parse(fs.readFileSync(decisionsPath, "utf8"));
const IN_SCOPE = new Set(["KEEP", "UPDATE"]);

const counts = { accept: 0, reject: 0, change: 0, unknown: 0 };
for (const c of catalog.cases) {
  const d = decisions[c.id];
  if (!d?.decision) continue;
  c.decision = d.decision;
  c.decision_note = d.note || null;
  if (d.decision === "accept") {
    c.in_scope = IN_SCOPE.has(c.verdict);
    c.validated_steps = c.in_scope ? (c.proposed_steps.length ? c.proposed_steps : c.original_steps) : [];
  } else if (d.decision === "reject") {
    c.in_scope = true;
    c.validated_steps = c.original_steps;
  } else if (d.decision === "change") {
    delete c.in_scope;
    delete c.validated_steps;
  }
  counts[d.decision in counts ? d.decision : "unknown"]++;
}
const unknownIds = Object.keys(decisions).filter((id) => !catalog.cases.some((c) => c.id === id));

const pending = catalog.cases.filter((c) => !c.decision || c.decision === "change").length;
catalog.status = pending ? `partially validated - ${pending} case(s) pending` : "validated";
fs.writeFileSync(catalogPath, JSON.stringify(catalog, null, 1));
console.log(`Applied ${counts.accept} accept, ${counts.reject} reject, ${counts.change} change; ${pending} case(s) still pending.`);
if (unknownIds.length) console.warn(`Ignored decisions for unknown ids: ${unknownIds.join(", ")}`);
