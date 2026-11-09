// Claim checks at submission (TestLink "Benefits and Claims / Claim", OCM-53..77, 98):
// a claim that breaks a product, policy or medical rule is rejected, with the reason
// on the claim and on the rejected rows.
//
// The data comes from scripts/claim-seed.mjs through the API: an active policy, a
// product with low limits and the earlier claims that use those limits up, none of
// which the demo dataset has. Each case then submits its claim from Health Facility
// Claims ("Submit Selected") and reads the result on the claim page (row Status and
// R = rejection reason). The claim-level reason is not shown anywhere in the UI, so
// it is read through the API.
//
// Care dates are today: see CARE_DAY in claim-seed.mjs for why.
//
// OCM-56: a claim whose care ends before it starts is saved in Error with the entry
// error 4 and is not submitted (OP-3239); before that fix it was checked.

const CASES = [
  ['OCM-53'], ['OCM-54'], ['OCM-55'], ['OCM-56'], ['OCM-57'], ['OCM-58'], ['OCM-59'],
  ['OCM-61'], ['OCM-62'], ['OCM-63'], ['OCM-64'], ['OCM-65'], ['OCM-98'], ['OCM-66'],
  ['OCM-67', 'OCM-303'], ['OCM-70', 'OCM-304'], ['OCM-71'], ['OCM-74'], ['OCM-75'],
  ['OCM-76'], ['OCM-77'],
];

const submitFromList = (code) => {
  cy.visit('/front/claim/healthFacilities');
  cy.waitForSearcherLoaded();
  cy.enterMuiInput('Claim No.', code, 'input');
  cy.contains('button', 'Search').click({ force: true });
  // Select the row once the filtered result is in, then check the selection held
  // (a refresh clears it and the menu would offer no "Submit Selected").
  cy.waitForSearcherLoaded();
  cy.get('tbody tr').should('have.length', 1).and('contain.text', code).click();
  cy.get('tbody tr').should('have.class', 'Mui-selected');
  cy.get('button.MuiIconButton-root').filter(':has(.material-symbols-outlined:contains("more_horiz"))').first().click();
  cy.contains('[role="menuitem"]', 'Submit Selected').should('be.visible').click();
  cy.waitForJournalProgress();
};

const assertRows = (claim, expected) => {
  cy.visit(`/front/claim/healthFacilities/claim/${claim.uuid}`);
  cy.contains('label', 'Claim No.').siblings('.MuiInputBase-root').find('input').should('have.value', claim.code);
  for (const [kind, header] of [['items', 'Item'], ['services', 'Service']]) {
    const reasons = expected.rows?.[kind];
    if (!reasons) continue;
    // The rows table has no <th>: its first row holds the column names.
    const cellText = (cell) => (cell.innerText || cell.querySelector('input')?.value || '').trim();
    cy.get('table')
      .should(($tables) => {
        const $t = $tables.filter((_, t) => t.rows[0] && cellText(t.rows[0].cells[0]) === header);
        expect($t.length, `${header} table`).to.eq(1);
        const names = [...$t[0].rows[0].cells].map(cellText);
        const rows = [...$t[0].rows].slice(1).filter((r) => cellText(r.cells[0]) || r.querySelector('input'));
        reasons.forEach((reason, i) => {
          const cells = rows[i] ? [...rows[i].cells].map(cellText) : [];
          expect(cells[names.indexOf('Status')], `${header} row ${i + 1} status`).to.eq('Rejected');
          expect(cells[names.indexOf('R')], `${header} row ${i + 1} rejection reason`).to.eq(String(reason));
        });
      });
  }
};

describe('Claim checks at submission', () => {
  let run;

  before(() => {
    cy.task('prepareClaimRun', null, { timeout: 300000 }).then((r) => { run = r; });
  });

  beforeEach(() => {
    cy.login();
  });

  // CYPRESS_CLAIM_CASES=OCM-61,OCM-63 runs only those cases.
  const only = (Cypress.env('CLAIM_CASES') ?? '').split(',').filter(Boolean);
  CASES.filter(([caseId]) => !only.length || only.includes(caseId)).forEach(([caseId, ...duplicates]) => {
    const tags = [caseId, ...duplicates].join(', ');
    it(`${caseId} rejects the claim (${tags})`, () => {
      cy.task('prepareClaimCase', { run, caseId }, { timeout: 300000 }).then(({ title, claim, expect: expected }) => {
        cy.task('log', `${caseId}: ${title} - claim ${claim.code}`);
        if (expected.entryErrorCodes) {
          expect(claim.entryErrorCodes, `entry errors (${title})`).to.deep.eq(expected.entryErrorCodes);
        }
        // A claim saved in Error (OP-3239) is not submittable: only its status is read.
        if (expected.submit !== false) {
          submitFromList(claim.code);
          assertRows(claim, expected);
        }
        cy.task('readClaim', claim.code).then((result) => {
          for (const [key, value] of Object.entries(expected.claim ?? {})) {
            expect(result[key], `claim ${key} (${title})`).to.eq(value);
          }
        });
      });
    });
  });
});
