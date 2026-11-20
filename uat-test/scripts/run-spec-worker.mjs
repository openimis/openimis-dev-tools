#!/usr/bin/env node
// Runs one Cypress spec through the module API and writes the result to a file.
// Started by run-uat.mjs in its own process group, so a spec that hangs can be
// killed together with the Cypress binary it spawned.
//   node scripts/run-spec-worker.mjs <options.json> <result.json>

import fs from "node:fs";

const [optionsFile, resultFile] = process.argv.slice(2);
const options = JSON.parse(fs.readFileSync(optionsFile, "utf8"));
const { default: cypress } = await import("cypress");
const results = await cypress.run(options);
fs.writeFileSync(resultFile, JSON.stringify(results));
process.exit(0);
