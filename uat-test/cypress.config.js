const fs = require('fs')
const path = require('path')
const { defineConfig } = require("cypress")

const serverFlagPath = path.resolve(__dirname, 'serverStarted')

const payload = {
  "query": "{ moduleConfigurations { module, config, controls { field, usage } } }"
}
const timeoutMinutes = 10
const retryIntervalSeconds = 15

function waitForServerToStart(url) {
  console.log('Waiting for API server to start...')
  return new Promise((resolve, reject) => {
    const startTime = Date.now()

    function checkServer() {
      return fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      }).then(response => {
          if (response.status === 200) {
            return resolve()
          } else {
            throw new Error(`Server responded with status ${response.status}`)
          }
        })
        .catch(error => {
          if (Date.now() - startTime >= timeoutMinutes * 60 * 1000) {
            return reject(
              new Error(`Timed out waiting for the server to start: ${error.message}`)
            )
          } else {
            console.log(`${error.message}. Retrying in ${retryIntervalSeconds} seconds...`)
            return setTimeout(checkServer, retryIntervalSeconds * 1000)
          }
        })
    }

    return checkServer()
  })
}

module.exports = defineConfig({
  viewportWidth: 1280,
  viewportHeight: 1000,
  e2e: {
    projectId: "q6gc25", // Cypress Cloud, needed for recording
    // UAT stack from scripts/start-uat-stack.sh (demo dataset). Override per target with
    // CYPRESS_BASE_URL or --base-url: http://localhost:3000 (dev stack), http://localhost (docker).
    baseUrl: 'http://localhost:3000',
    defaultCommandTimeout: 5000,
    taskTimeout: timeoutMinutes * 60 * 1000 + 10,
    downloadsFolder: 'cypress/downloads',
    setupNodeEvents(on, config) {
      const readCredentials = () => JSON.parse(fs.readFileSync(path.join(config.fixturesFolder, 'cred.json'), 'utf8'))
      // The UAT baseline (scripts/baseline.mjs) is fetched or created once per Cypress
      // process: the first spec pays for creating it, the others reuse the answer.
      let baselinePromise
      const baseline = () => {
        baselinePromise ??= import('./scripts/baseline.mjs')
          .then(({ ensureBaseline }) => ensureBaseline(config.baseUrl, readCredentials()))
          .catch((error) => { baselinePromise = undefined; throw error })
        return baselinePromise
      }
      on('task', {
        ensureBaseline() {
          return baseline()
        },
        log(message) {
          console.log('[probe]', message)
          return null
        },
        // Re-applies uat/module-config.pinned.json so every spec file starts from the same approval settings.
        async pinModuleConfigs() {
          const { pin } = await import('./scripts/module-config.mjs')
          return pin(config.baseUrl, readCredentials())
        },
        async resetLoginFailures() {
          const { resetLoginFailures } = await import('./scripts/module-config.mjs')
          return resetLoginFailures(config.baseUrl, readCredentials())
        },
        // Claim-check cases (scripts/claim-seed.mjs): shared data, one case, one claim.
        async prepareClaimRun() {
          const { prepareRun } = await import('./scripts/claim-seed.mjs')
          return prepareRun(config.baseUrl, readCredentials(), await baseline())
        },
        async prepareClaimCase({ run, caseId }) {
          const { prepareCase } = await import('./scripts/claim-seed.mjs')
          return prepareCase(config.baseUrl, readCredentials(), run, caseId)
        },
        async readClaim(code) {
          const { readClaim } = await import('./scripts/claim-seed.mjs')
          return readClaim(config.baseUrl, readCredentials(), code)
        },
        checkSetup() {
          return fs.existsSync(serverFlagPath)
        },
        completeSetup() {
          const url = `${config.baseUrl}/api/graphql`
          return waitForServerToStart(url)
            .then(() => {
              console.log('Server is ready!')
              fs.writeFileSync(serverFlagPath, new Date().toString())
              return null
            })
            .catch(error => {
              console.error('Failed to start server:')
              console.error(error.stack);
              throw error;
            })
        },
        removeSetupFile() {
          if (fs.existsSync(serverFlagPath)) {
            fs.unlinkSync(serverFlagPath)
          }
          return null
        },
        // The fixture names baseline locations by alias ("@r1d2m1v1"): they are resolved
        // to the baseline location's code and name here.
        async updateCSV({ numIndividuals } = {}) {
          const fixturePath = path.join(config.fixturesFolder, 'individuals.csv');
          const tmpPath = path.join(config.fixturesFolder, 'tmp_individuals.csv');
          const { resolveCsvLocations } = await import('./scripts/baseline.mjs');
          const csv = resolveCsvLocations(fs.readFileSync(fixturePath, 'utf8'), (await baseline()).locations);

          const lines = csv.trim().split('\n');
          const header = lines[0];
          const rows = lines.slice(1);
          const headerCols = header.split(',');
          const groupCodeIdx = headerCols.indexOf('group_code');

          // map old group_code → new group_code
          const groupMap = {};

          // Subset or duplicate rows
          let adjustedRows = [];
          if (numIndividuals && numIndividuals > 0) {
            if (numIndividuals <= rows.length) {
              adjustedRows = rows.slice(0, numIndividuals);
            } else {
              const times = Math.floor(numIndividuals / rows.length);
              const remainder = numIndividuals % rows.length;
              adjustedRows = Array(times).fill(rows).flat().concat(rows.slice(0, remainder));
            }
          } else {
            adjustedRows = rows;
          }

          const newLines = [header];
          for (const line of adjustedRows) {
            const row = line.split(',');
            const oldCode = row[groupCodeIdx];

            // Preserve empty group_code — individuals without a group are
            // needed for individual program enrollment (grouped individuals
            // are ineligible for individual programs).
            if (!oldCode) {
              newLines.push(row.join(','));
              continue;
            }

            if (!groupMap[oldCode]) {
              groupMap[oldCode] = Math.random().toString(36).substring(2, 8).toUpperCase();
            }

            row[groupCodeIdx] = groupMap[oldCode];
            newLines.push(row.join(','));
          }

          fs.writeFileSync(tmpPath, newLines.join('\n'));
          return null;
        }
      })
    },
  },
})
