import 'cypress-file-upload';
import './commands'
import { registerMutationCommands, trackMutations } from './mutations'
import { addCsrfToGraphqlRequests } from './csrf'

addCsrfToGraphqlRequests()
registerMutationCommands()
trackMutations()

before(() => {
  cy.task('checkSetup').then((completed) => {
    if (!completed) {
      cy.task('completeSetup')
    }
  })
  // Failed logins left by a previous spec or run must not lock this spec out.
  cy.task('resetLoginFailures')
  // The reference data specs rely on (scripts/baseline.mjs), fetched or created; specs
  // read it with baseline() from support/baseline.js. Runs before the module configuration
  // is pinned: the first creation uploads individuals with the maker-checker switched off.
  cy.task('ensureBaseline', null, { timeout: 10 * 60 * 1000 }).then((b) => Cypress.env('baseline', b))
  // Set CYPRESS_PIN_MODULE_CONFIG=false to run against the database's own configuration.
  if (Cypress.env('PIN_MODULE_CONFIG') !== false) {
    cy.task('pinModuleConfigs').then((pinned) => Cypress.log({ name: 'pinModuleConfigs', message: pinned.join(', ') }))
  }
})

after(() => {
  cy.task('removeSetupFile')
})
