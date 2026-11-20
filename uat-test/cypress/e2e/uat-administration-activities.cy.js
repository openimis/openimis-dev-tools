// CoreMIS / Administration: project activities (OCM-1210..1212).
//
// Activities are maintained in Django admin and offered by the "Activity" picker of the
// project form of a program. The demo dataset has no program: the spec creates one,
// plus one activity named per run, and removes both at the end.

const runId = Date.now().toString(36).slice(-5).toUpperCase();
const TIMEOUT = 5000;
const programCode = `UA${runId}`;
const programName = `UAT Activities ${runId}`;
const activityName = `UAT Activity ${runId}`;
const renamedActivity = `${activityName} upd`;

const exactCell = (text) => new RegExp(`^\\s*${Cypress._.escapeRegExp(text)}\\s*$`);

function openActivitiesAdmin() {
  cy.loginAdminInterface();
  cy.visit('/api/admin/');
  cy.contains('a', 'Activities').click();
  // Django titles it after the model's verbose_name, "Activity".
  cy.contains(/Select activity to change/i);
}

function openActivityChangeForm(name) {
  cy.contains('td.field-name', exactCell(name)).parent('tr').find('th.field-id a').click();
}

// Opens a new project of the test program and types `text` in its Activity picker.
function typeInProjectActivity(text) {
  cy.login();
  cy.visit('/front/benefitPlans');
  cy.openProgramForEditFromList(programName);
  cy.contains('button', 'Projects').click();
  cy.contains('button', 'Create Project').click();
  cy.contains('h6', 'Project details');
  cy.contains('label', 'Activity').should('have.class', 'Mui-required');
  cy.contains('label', 'Activity').siblings('.MuiInputBase-root').find('input')
    .click({ force: true })
    .type(text, { force: true });
  // Wait for the picker to answer: options or "No options".
  cy.get('.MuiAutocomplete-popper', { timeout: TIMEOUT })
    .should(($popper) => {
      expect($popper.find('.MuiAutocomplete-loading'), 'options loaded').to.have.length(0);
      expect($popper.find('li[role="option"], .MuiAutocomplete-noOptions').length, 'picker answered').to.be.greaterThan(0);
    });
}

const activityOptions = () => cy.get('.MuiAutocomplete-popper').then(($popper) =>
  $popper.find('li[role="option"]').toArray().map((li) => li.textContent.trim()));

describe('CoreMIS / Administration: activities', () => {
  before(() => {
    cy.login();
    cy.createProgram(programCode, programName, '100', 'INDIVIDUAL');
  });

  after(() => {
    cy.login();
    cy.deleteProgram(programName);
    cy.loginAdminInterface();
    cy.deleteActivities([activityName, renamedActivity]);
  });

  it('Creates an activity offered in the project form (OCM-1210)', () => {
    openActivitiesAdmin();
    cy.contains('a', 'Add Activity').click();
    cy.get('input[name="name"]').type(activityName);
    cy.get('input[value="Save"]').click();
    cy.contains('td.field-name', exactCell(activityName));

    typeInProjectActivity(activityName);
    activityOptions().should('include', activityName);
  });

  it('Updates an activity (OCM-1211)', () => {
    openActivitiesAdmin();
    openActivityChangeForm(activityName);
    cy.get('input[name="name"]').clear().type(renamedActivity);
    cy.get('input[value="Save"]').click();
    cy.contains('td.field-name', exactCell(renamedActivity))
      .parent('tr')
      .find('td.field-version')
      .should('have.text', '2');

    typeInProjectActivity(`UAT Activity ${runId}`);
    activityOptions().should('include', renamedActivity).and('not.include', activityName);
  });

  it('Soft deletes an activity (OCM-1212)', () => {
    openActivitiesAdmin();
    openActivityChangeForm(renamedActivity);
    cy.get('input[name="is_deleted"]').check();
    cy.get('input[value="Save"]').click();
    cy.contains('td.field-name', exactCell(renamedActivity))
      .siblings('td.field-is_deleted')
      .find('img[alt="True"]')
      .should('exist');

    typeInProjectActivity(`UAT Activity ${runId}`);
    activityOptions().should('not.include', renamedActivity);
  });
});
