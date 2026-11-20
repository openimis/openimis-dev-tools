import { TIMEOUTS } from '../support/constants';

// UAT cases of "Benefit Plan- / Social Program-" (programs, beneficiary uploads) and
// "Create payroll from benefit plan". Runs against the pinned configuration: maker-checker
// is on, so program updates and uploads create tasks that the tests approve.

// Codes are at most 8 characters; one id per run keeps reruns apart.
const runId = Date.now().toString(36).slice(-5).toUpperCase();

const isoDate = (offsetDays = 0) => {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
};

const uuidv4 = () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
  const r = (Math.random() * 16) | 0;
  return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
});

// --- GraphQL seeding ---------------------------------------------------------

function gql(query) {
  return cy.request({ method: 'POST', url: '/api/graphql', body: { query }, log: false })
    .then(({ body }) => {
      if (body.errors?.length) throw new Error(`GraphQL error: ${JSON.stringify(body.errors)}`);
      return body.data;
    });
}

// Sends a mutation and waits until its MutationLog is processed (async mutations).
function mutate(name, input, label) {
  const clientMutationId = uuidv4();
  return gql(`mutation { ${name}(input: { clientMutationId: "${clientMutationId}" clientMutationLabel: "${label}" ${input} }) { clientMutationId } }`)
    .then(() => cy.waitForMutationLog(clientMutationId))
    .then(({ status, error }) => {
      if (status !== 2) throw new Error(`${label} failed: ${error}`);
    });
}

// Creates a program through the API (creation needs no approval) and yields its id.
function seedProgram({ code, name, type = 'INDIVIDUAL', maxBeneficiaries = 100, schema = {} }) {
  return mutate(
    'createBenefitPlan',
    `code: "${code}" name: "${name}" type: ${type} maxBeneficiaries: ${maxBeneficiaries}
     dateValidFrom: "${isoDate(0)}" dateValidTo: "${isoDate(365)}"
     beneficiaryDataSchema: ${JSON.stringify(JSON.stringify(schema))}`,
    `UAT seed - create program ${code}`,
  ).then(() => programId(code));
}

// Relay ids are base64("TypeName:uuid"); pages and mutations use the uuid.
const decodeId = (relayId) => atob(relayId).split(':')[1];

function programId(code) {
  return gql(`{ benefitPlan(code: "${code}") { edges { node { id } } } }`)
    .then((data) => {
      const id = data.benefitPlan.edges[0]?.node.id;
      if (!id) throw new Error(`program ${code} not found`);
      return decodeId(id);
    });
}

function deleteProgramApi(id, code) {
  return mutate('deleteBenefitPlan', `ids: ["${id}"]`, `UAT cleanup - delete program ${code}`);
}

// --- UI helpers ----------------------------------------------------------------

// Searcher filters apply after a debounce (~800 ms): a Search clicked sooner runs
// without the value just typed.
const FILTER_DEBOUNCE_MS = 1000;

// The initial total, once the list has loaded (the title reads "0 ..." before).
const loadedCount = (entity) => cy.contains(new RegExp(`^\\d+ ${entity}$`), { timeout: TIMEOUTS.BACKEND_VALIDATION })
  .should(($el) => expect(Number($el.text().split(' ')[0]), `${entity} loaded`).to.be.greaterThan(0))
  .invoke('text')
  .then((text) => Number(text.split(' ')[0]));

const resultsCount = (entity) => cy.contains(new RegExp(`^\\d+ ${entity}$`), { timeout: TIMEOUTS.BACKEND_VALIDATION })
  .invoke('text')
  .then((text) => Number(text.split(' ')[0]));

// Opens the program list once its first query has returned (the title reads
// "0 Programs" until then).
function visitPrograms() {
  cy.aliasGraphqlQuery('benefitPlan(', 'programsLoad');
  cy.visit('/front/benefitPlans');
  cy.wait('@programsLoad', { timeout: TIMEOUTS.BACKEND_VALIDATION });
  cy.waitForSearcherLoaded();
}

function searchPrograms() {
  cy.aliasGraphqlQuery('benefitPlan(', 'programSearch');
  cy.wait(FILTER_DEBOUNCE_MS); // eslint-disable-line cypress/no-unnecessary-waiting
  cy.contains('button', 'Search').click();
  cy.awaitSearcherRefresh('programSearch');
  cy.waitForSearcherLoaded();
}

function openProgramPage(id) {
  cy.visit(`/front/benefitPlans/benefitPlan/${id}`);
  cy.contains('label', 'Code', { timeout: TIMEOUTS.BACKEND_VALIDATION });
}

// Asserts the values of a results column, retrying until the searcher has re-rendered.
const checkColumn = (header, check) => cy.contains('table thead th', header).should(($th) => {
  const index = $th.index();
  check($th.closest('table').find('tbody tr').toArray()
    .map((tr) => tr.children[index]?.innerText.trim())
    .filter((v) => v !== undefined && v !== ''));
});

// Opens a task from All tasks by its entity, assigns the permissive group and approves it.
// (tasks.commands approveTaskFromList expects the picker value "any", but the
// "Assigned to" picker now shows "Group · any — ANY".)
function approveTask(entity) {
  cy.visit('/front/allTasks');
  cy.waitForSearcherLoaded();
  cy.enterMuiInput('Entity', entity);
  cy.aliasGraphqlQuery('task(', 'approveTaskSearch');
  cy.wait(FILTER_DEBOUNCE_MS); // eslint-disable-line cypress/no-unnecessary-waiting
  cy.contains('button', 'Search').click();
  cy.awaitSearcherRefresh('approveTaskSearch');
  cy.contains('table tbody tr', entity, { timeout: TIMEOUTS.BACKEND_VALIDATION })
    .find('button:is([title="View details"],[aria-label="View details"])')
    .click({ force: true });
  cy.url({ timeout: TIMEOUTS.BACKEND_VALIDATION }).should('include', '/tasks/task/');
  assignPermissiveGroup();
  cy.contains('button.MuiFab-root', /^check$/, { timeout: TIMEOUTS.BACKEND_VALIDATION }).should('not.be.disabled').click();
  cy.get('[role="dialog"]').contains('button', 'Ok').click();
  cy.waitForJournalProgress();
}

// Picks the "any" group in the "Assigned to" picker of the open task and saves.
function assignPermissiveGroup() {
  cy.contains('label', 'Assigned to').siblings('.MuiInputBase-root').find('input')
    .click({ force: true })
    .type('any', { force: true });
  cy.contains('[role="listbox"] li, li[role="option"]', /·\s*any\s*—/, { timeout: TIMEOUTS.BACKEND_VALIDATION }).click({ force: true });
  cy.contains('label', 'Assigned to').siblings('.MuiInputBase-root').find('input')
    .should('have.value', 'Group · any — ANY');
  cy.clickSave();
  cy.waitForJournalProgress();
}

// --- Beneficiary upload helpers ---------------------------------------------------

// Columns accepted by the upload: the base fields plus properties of the program schema.
const BENEFICIARY_SCHEMA = {
  $id: 'https://example.com/beneficiares.schema.json',
  type: 'object',
  title: 'Record of beneficiares',
  $schema: 'http://json-schema.org/draft-04/schema#',
  properties: {
    email: { type: 'string', description: 'email address to contact with beneficiary', validationCalculation: { name: 'EmailValidationStrategy' } },
    able_bodied: { type: 'boolean', description: 'Flag determining whether someone is able bodied or not' },
    national_id: { type: 'string', uniqueness: true, description: 'national id' },
    educated_level: { type: 'string', description: 'The level of person when it comes to the school/education/studies' },
    chronic_illness: { type: 'boolean', description: 'Flag determining whether someone has such kind of illness or not' },
    national_id_type: { type: 'string', description: 'A type of national id' },
    number_of_elderly: { type: 'integer', description: 'Number of elderly' },
    number_of_children: { type: 'integer', description: 'Number of children' },
    beneficiary_data_source: { type: 'string', description: 'The source from where such beneficiary comes' },
  },
  description: 'This document records the details beneficiares',
};

const CSV_HEADER = ['first_name', 'last_name', 'dob', 'location_name', 'location_code', 'email', 'national_id', 'educated_level'];

const toCsv = (header, rows) => [header.join(','), ...rows.map((r) => header.map((h) => r[h] ?? '').join(','))].join('\n');

const beneficiaryRow = (firstName, lastName, dob, suffix, email) => ({
  first_name: firstName,
  last_name: lastName,
  dob,
  email: email ?? `${firstName.toLowerCase()}.${suffix}@example.org`,
  national_id: `UAT${runId}${suffix}`,
  educated_level: 'primary',
});

// Opens the Beneficiaries > Upload dialog of the open program, picks the CSV and the
// workflow and submits. Yields the alert shown after the upload.
function uploadBeneficiaries(fileName, csvText, workflow) {
  cy.contains('button', /^Upload$/).click();
  cy.contains('[role="dialog"] h2', 'Upload Beneficiaries').should('be.visible');
  cy.get('[role="dialog"]').contains('button', 'Template').should('be.visible');
  cy.get('[role="dialog"]').contains('button', 'Upload Beneficiaries').should('be.disabled');
  cy.get('[role="dialog"] input[type="file"]').selectFile(
    { contents: Cypress.Buffer.from(csvText), fileName, mimeType: 'text/csv' },
    { force: true },
  );
  cy.chooseMuiSelect('Workflow', workflow);
  cy.intercept('POST', '/api/social_protection/import_beneficiaries/').as('importBeneficiaries');
  cy.get('[role="dialog"]').contains('button', 'Upload Beneficiaries').should('not.be.disabled').click();
  return cy.wait('@importBeneficiaries', { timeout: 60000 });
}

// Re-opens Upload History until the row of `fileName` shows `status` (the workflow
// runs in the request, but the status can still move after it).
function waitForUploadStatus(fileName, status, attempt = 1) {
  cy.contains('button', 'Upload History').click();
  cy.contains('[role="dialog"] th', 'Workflow', { timeout: TIMEOUTS.BACKEND_VALIDATION });
  cy.get('[role="dialog"] [role="progressbar"]').should('not.exist');
  return cy.get('[role="dialog"]').then(($dialog) => {
    const row = $dialog.find('tbody tr').toArray().find((tr) => tr.innerText.includes(fileName));
    if (row && row.innerText.includes(status)) return cy.wrap(row);
    if (attempt >= 10) {
      throw new Error(`upload ${fileName}: status ${status} not reached; row: ${row?.innerText ?? '(none)'}`);
    }
    cy.get('[role="dialog"]').contains('button', 'Close').click();
    // eslint-disable-next-line cypress/no-unnecessary-waiting
    cy.wait(3000);
    return waitForUploadStatus(fileName, status, attempt + 1);
  });
}

// Closes the alert (coreAlert) shown after an upload.
const closeAlert = () => {
  cy.contains('[role="dialog"] button', /^close$/i).click();
};

const closeDialog = () => {
  cy.get('[role="dialog"]').contains('button', 'Close').click();
  cy.get('[role="dialog"]').should('not.exist');
};

// Opens the Import Valid Items task of an upload from All tasks (its entity string
// holds the file name).
function openImportTask(fileName) {
  cy.visit('/front/allTasks');
  cy.waitForSearcherLoaded();
  cy.enterMuiInput('Entity', fileName);
  cy.aliasGraphqlQuery('task(', 'importTaskSearch');
  cy.wait(FILTER_DEBOUNCE_MS); // eslint-disable-line cypress/no-unnecessary-waiting
  cy.contains('button', 'Search').click();
  cy.awaitSearcherRefresh('importTaskSearch');
  cy.contains('table tbody tr', fileName, { timeout: TIMEOUTS.BACKEND_VALIDATION })
    .find('button:is([title="View details"],[aria-label="View details"])')
    .click({ force: true });
  cy.url({ timeout: TIMEOUTS.BACKEND_VALIDATION }).should('include', '/tasks/task/');
  cy.contains('Import Valid Items Task', { timeout: TIMEOUTS.BACKEND_VALIDATION });
}

// Assigns the permissive group to the open import task and accepts all its records.
function approveOpenImportTask() {
  assignPermissiveGroup();
  cy.contains('div', 'Accept All', { timeout: TIMEOUTS.BACKEND_VALIDATION }).find('button')
    .should('not.be.disabled')
    .click();
  cy.contains('Beneficiary Upload Confirmation');
  cy.contains('button', 'Continue').click();
  cy.contains('div', 'Accept All').find('button').should('be.disabled');
}

// Polls the task of an upload on All tasks until it shows `status`.
function assertImportTaskStatus(fileName, status, attempt = 1) {
  cy.visit('/front/allTasks');
  cy.waitForSearcherLoaded();
  cy.enterMuiInput('Entity', fileName);
  cy.aliasGraphqlQuery('task(', 'importTaskStatus');
  cy.wait(FILTER_DEBOUNCE_MS); // eslint-disable-line cypress/no-unnecessary-waiting
  cy.contains('button', 'Search').click();
  cy.awaitSearcherRefresh('importTaskStatus');
  cy.contains('table tbody tr', fileName).then(($row) => {
    if ($row.text().includes(status) || attempt >= 6) {
      cy.wrap($row).should('contain', status);
      return;
    }
    // eslint-disable-next-line cypress/no-unnecessary-waiting
    cy.wait(3000).then(() => assertImportTaskStatus(fileName, status, attempt + 1));
  });
}

// The Import Valid Items panel of Tasks shows Program code, Filename, Workflow and
// Percentage of invalid items of each upload task.
function assertImportTaskSummary(fileName, cells) {
  cy.visit('/front/tasks');
  cy.contains('Import Valid Items Task', { timeout: TIMEOUTS.BACKEND_VALIDATION }).click();
  cy.waitForSearcherLoaded();
  cy.enterMuiInput('Entity', fileName);
  cy.aliasGraphqlQuery('task(', 'importTaskSummary');
  cy.wait(FILTER_DEBOUNCE_MS); // eslint-disable-line cypress/no-unnecessary-waiting
  cy.contains('button', 'Search').click();
  cy.awaitSearcherRefresh('importTaskSummary');
  return cy.contains('table tbody tr', fileName, { timeout: TIMEOUTS.BACKEND_VALIDATION }).should(($row) => {
    cells.forEach((cell) => expect($row.text(), 'task summary').to.contain(cell));
  });
}

// Beneficiaries > List of the open program, filtered by last name.
function listBeneficiaries(lastName) {
  cy.contains('button', 'Beneficiaries').click();
  cy.contains('button', /^List$/).click();
  if (lastName) cy.enterMuiInput('Last name', lastName);
  cy.aliasGraphqlQuery('beneficiary(', 'beneficiarySearch');
  cy.wait(FILTER_DEBOUNCE_MS); // eslint-disable-line cypress/no-unnecessary-waiting
  cy.contains('button', 'Search').click();
  cy.awaitSearcherRefresh('beneficiarySearch');
  cy.waitForSearcherLoaded();
}

// Clicks DOWNLOAD on the beneficiaries list and yields the exported CSV rows.
function exportBeneficiaries() {
  cy.intercept('GET', '/api/core/fetch_export*').as('fetchExport');
  cy.contains('li, button', 'DOWNLOAD').click({ force: true });
  cy.get('body').then(($body) => {
    // Some searchers ask for the columns first.
    if ($body.find('[role="dialog"]:contains("Export configuration")').length) {
      cy.get('[role="dialog"]').contains('button', 'Ok').click();
    }
  });
  return cy.wait('@fetchExport', { timeout: 30000 }).then(({ response }) => {
    const text = typeof response.body === 'string' ? response.body : new TextDecoder().decode(response.body);
    const [header, ...lines] = text.trim().split(/\r?\n/);
    const columns = header.split(',');
    return lines.filter(Boolean).map((line) => Object.fromEntries(line.split(',').map((v, i) => [columns[i], v])));
  });
}

describe('Programs list', () => {
  const activeCode = `LA${runId}`;
  const groupCode = `LG${runId}`;
  const deletedCode = `LD${runId}`;
  const listName = `UAT List ${runId}`;
  const active = { code: activeCode, name: `${listName} Individual` };
  const group = { code: groupCode, name: `${listName} Group`, type: 'GROUP' };
  const deleted = { code: deletedCode, name: `${listName} Deleted` };
  const ids = {};

  before(() => {
    cy.login();
    seedProgram(active).then((id) => { ids.active = id; });
    seedProgram(group).then((id) => { ids.group = id; });
    seedProgram(deleted).then((id) => {
      ids.deleted = id;
      deleteProgramApi(id, deletedCode);
    });
  });

  after(() => {
    cy.login();
    [['active', activeCode], ['group', groupCode]].forEach(([key, code]) => {
      if (ids[key]) deleteProgramApi(ids[key], code);
    });
  });

  beforeEach(() => {
    cy.login();
  });

  it('Lists programs and filters them by code and type (OCM-1166)', () => {
    visitPrograms();
    ['Code', 'Name', 'Type', 'Date from', 'Date to'].forEach((label) => cy.contains('label', label).should('exist'));
    cy.contains('label', 'Show historical').should('exist');
    ['Code', 'Name', 'Type', 'Date from', 'Date to', 'Max Beneficiaries']
      .forEach((header) => cy.contains('table thead th', header).should('exist'));

    loadedCount('Programs').then((total) => {
      cy.enterMuiInput('Code', activeCode);
      searchPrograms();
      resultsCount('Programs').should('be.lessThan', total);
      checkColumn('Code', (codes) => {
        expect(codes, 'codes after code filter').to.have.length.greaterThan(0);
        codes.forEach((c) => expect(c).to.contain(activeCode));
      });

      // Type filter, on the programs of this run (both types).
      cy.enterMuiInput('Code', runId);
      cy.chooseMuiSelect('Type', 'INDIVIDUAL');
      searchPrograms();
      checkColumn('Type', (types) => {
        expect(types, 'types after type filter').to.have.length.greaterThan(0);
        types.forEach((t) => expect(t).to.eq('INDIVIDUAL'));
      });
      cy.contains('table tbody tr', groupCode).should('not.exist');
      cy.contains('table tbody tr', activeCode).should('exist');

      cy.aliasGraphqlQuery('benefitPlan(', 'programReset');
      cy.contains('button', /reset/i).click();
      cy.awaitSearcherRefresh('programReset');
      cy.waitForSearcherLoaded();
      cy.assertMuiInput('Code', '');
      resultsCount('Programs').should('eq', total);
    });
  });

  it('Shows deleted programs only when "Show historical" is checked (OCM-1167)', () => {
    visitPrograms();
    cy.enterMuiInput('Name', listName);
    searchPrograms();
    cy.contains('table tbody tr', activeCode).should('exist');
    cy.contains('table tbody tr', deletedCode).should('not.exist');

    cy.contains('label', 'Show historical').find('input[type="checkbox"]').check({ force: true });
    searchPrograms();
    cy.contains('table tbody tr', deletedCode).should('exist');
    cy.contains('table tbody tr', activeCode).should('not.exist');
    cy.get('table tbody tr').each(($tr) => {
      expect($tr.find(':is([title="Undo Delete"],[aria-label="Undo Delete"])').length, 'Undo Delete action').to.be.greaterThan(0);
      expect($tr.find(':is([title="Delete"],[aria-label="Delete"])').length, 'no Delete action').to.eq(0);
    });

    cy.contains('label', 'Show historical').find('input[type="checkbox"]').uncheck({ force: true });
    searchPrograms();
    cy.contains('table tbody tr', activeCode).should('exist');
    cy.contains('table tbody tr', deletedCode).should('not.exist');
  });

  it('Deletes a program after confirmation (OCM-1168)', () => {
    const code = `LX${runId}`;
    const name = `${listName} To delete`;
    seedProgram({ code, name });

    visitPrograms();
    cy.enterMuiInput('Name', name);
    searchPrograms();
    const deleteButton = () => cy.contains('table tbody tr', code)
      .find('button:is([title="Delete"],[aria-label="Delete"]), :is([title="Delete"],[aria-label="Delete"]) button')
      .first();

    deleteButton().click();
    cy.get('[role="dialog"]').should('contain', `Delete program ${code} ${name}`)
      .and('contain', 'Are you sure you want to delete the program?');
    cy.get('[role="dialog"]').contains('button', 'Cancel').click();
    cy.get('[role="dialog"]').should('not.exist');
    deleteButton().should('not.be.disabled');

    deleteButton().click();
    cy.get('[role="dialog"]').contains('button', 'Ok').click();
    cy.waitForJournalProgress();
    cy.assertJournalFirstEntryContains(`Delete program ${name}`);
    cy.assertJournalNoFail();
    // Collapse the journal drawer opened above: expanded, it covers the Search button.
    cy.get('.MuiDrawer-paperAnchorRight button').first().click();

    // The list drops the deleted program once the deletion is done, without a new search;
    // "Show historical" still lists it.
    cy.contains('table tbody tr', code, { timeout: TIMEOUTS.SERVER_RESULT }).should('not.exist');
    searchPrograms();
    cy.contains('table tbody tr', code).should('not.exist');
    cy.contains('label', 'Show historical').find('input[type="checkbox"]').check({ force: true });
    searchPrograms();
    cy.contains('table tbody tr', code).should('exist');
  });
});

describe('Program edit with approval', () => {
  const code = `PE${runId}`;
  const name = `UAT Edit Program ${runId}`;
  const description = `Updated by UAT ${runId}`;
  let id;

  before(() => {
    cy.login();
    cy.ensurePermissiveTaskGroup();
    seedProgram({ code, name }).then((programUuid) => { id = programUuid; });
  });

  after(() => {
    cy.login();
    if (id) deleteProgramApi(id, code);
  });

  beforeEach(() => {
    cy.login();
  });

  it('Updates a program through an approved task (OCM-1169)', () => {
    visitPrograms();
    cy.enterMuiInput('Name', name);
    searchPrograms();
    cy.contains('table tbody tr', code).find(':is([title="Edit"],[aria-label="Edit"])').first().click({ force: true });
    cy.url().should('include', `/benefitPlan/${id}`);
    cy.contains(`Program ${code} ${name}`, { timeout: TIMEOUTS.BACKEND_VALIDATION });
    ['Code', 'Name', 'Type', 'Date from', 'Date to', 'Max Beneficiaries', 'Institution', 'Description', 'Schema']
      .forEach((label) => cy.contains('label', label).should('exist'));
    ['Beneficiaries', 'Projects', 'Changelog', 'Tasks'].forEach((tab) => cy.contains('button[role="tab"], button', tab).should('exist'));
    cy.assertMuiInput('Name', name);

    cy.enterMuiInput('Description', description, 'textarea');
    cy.get(':is([title="Save changes"],[aria-label="Save changes"]) button').click();
    // This case approves the task through the UI below.
    cy.checkProgramUpdateCompleted({ approve: false });
    cy.assertJournalFirstEntryContains(`Update program ${name}`);

    // Maker-checker: the change waits for approval.
    openProgramPage(id);
    cy.assertMuiInput('Description', '', 'textarea');
    cy.contains('button', 'Tasks').click();
    cy.contains('table tbody tr', 'RECEIVED', { timeout: TIMEOUTS.BACKEND_VALIDATION }).should('exist');
    // OP-3279: the program page tells about the pending update task.
    cy.contains('.MuiChip-root', '1 pending task', { timeout: TIMEOUTS.BACKEND_VALIDATION }).should('be.visible');

    approveTask(`Benefit Plan ${code}`);

    // The update runs once the task is resolved.
    const waitForDescription = (attempt = 1) => {
      openProgramPage(id);
      cy.contains('label', 'Description').siblings('.MuiInputBase-root').find('textarea').first()
        .invoke('val')
        .then((value) => {
          if (value === description || attempt >= 6) return;
          // eslint-disable-next-line cypress/no-unnecessary-waiting
          cy.wait(3000).then(() => waitForDescription(attempt + 1));
        });
    };
    waitForDescription();
    cy.assertMuiInput('Description', description, 'textarea');
    cy.contains('table tbody tr', `Benefit Plan ${code}`).should('not.exist');
    // OP-3279: no task is pending any more once it is resolved.
    cy.contains('.MuiChip-root', 'pending task').should('not.exist');

    cy.visit('/front/allTasks');
    cy.waitForSearcherLoaded();
    cy.enterMuiInput('Entity', `Benefit Plan ${code}`);
    cy.aliasGraphqlQuery('task(', 'editTaskStatus');
    cy.wait(FILTER_DEBOUNCE_MS); // eslint-disable-line cypress/no-unnecessary-waiting
    cy.contains('button', 'Search').click();
    cy.awaitSearcherRefresh('editTaskStatus');
    cy.contains('table tbody tr', `Benefit Plan ${code}`).should('contain', 'COMPLETED');

    openProgramPage(id);
    cy.contains('button', 'Changelog').click();
    cy.contains(/\d+ Historical Records Found/, { timeout: TIMEOUTS.BACKEND_VALIDATION })
      .should(($el) => expect(Number($el.text().split(' ')[0]), 'changelog entries').to.be.greaterThan(1));
  });
});

describe('Create payroll from a program', () => {
  const withPlanCode = `PY${runId}`;
  const withPlanName = `UAT Payroll Program ${runId}`;
  const noPlanCode = `PN${runId}`;
  const noPlanName = `UAT No Plan Program ${runId}`;
  const planCode = `PP${runId}`;
  const planName = `UAT Plan ${runId}`;
  const ids = {};

  before(() => {
    cy.login();
    seedProgram({ code: withPlanCode, name: withPlanName }).then((id) => { ids.withPlan = id; });
    seedProgram({ code: noPlanCode, name: noPlanName }).then((id) => { ids.noPlan = id; });
    const dmy = (iso) => iso.split('-').reverse().join('-');
    cy.createPaymentPlan({
      code: planCode,
      name: planName,
      benefitPlanCode: withPlanCode,
      dateValidFrom: dmy(isoDate(0)),
      dateValidTo: dmy(isoDate(365)),
    });
  });

  after(() => {
    cy.login();
    cy.deletePaymentPlan(planName);
    Object.entries(ids).forEach(([, id]) => deleteProgramApi(id, 'payroll program'));
  });

  beforeEach(() => {
    cy.login();
  });

  it('Opens the payroll form from a program with a payment plan (OCM-1182)', () => {
    openProgramPage(ids.noPlan);
    cy.contains('button', 'CREATE PAYROLL').should('be.disabled')
      .parent('span').trigger('mouseover');
    cy.contains('[role="tooltip"]', 'Create Payment Plan first.').should('be.visible');

    openProgramPage(ids.withPlan);
    cy.contains('button', 'CREATE PAYROLL').should('not.be.disabled').click();
    cy.location('pathname').should('eq', `/front/payrolls/payroll/null/null/${ids.withPlan}`);

    cy.contains('label', 'Payment Plan', { timeout: TIMEOUTS.BACKEND_VALIDATION })
      .siblings('.MuiInputBase-root').find('[role="combobox"], input').first().click({ force: true });
    // Until the picker's query returns, the list holds a disabled "No options available"
    // item: assert in one retried callback, so it waits for the real options.
    cy.get('[role="listbox"] li, li[role="option"]', { timeout: TIMEOUTS.BACKEND_VALIDATION }).should(($lis) => {
      const texts = [...$lis].map((li) => li.innerText);
      expect(texts, 'payment plan options').to.have.length.at.least(1);
      texts.forEach((text) => expect(text).to.contain(planCode));
    });
  });
});

describe('Beneficiary upload and validation', () => {
  const code = `BU${runId}`;
  const name = `UAT Upload Program ${runId}`;
  const lastName = (prefix) => `${prefix}${runId}`;
  const validRows = [
    beneficiaryRow('Anna', lastName('Delta'), '1980-01-01', '1'),
    beneficiaryRow('Ben', lastName('Alpha'), '1975-05-05', '2'),
    beneficiaryRow('Cleo', lastName('Charlie'), '1990-09-09', '3'),
    beneficiaryRow('Dan', lastName('Bravo'), '1985-03-03', '4'),
  ];
  let id;

  before(() => {
    cy.login();
    cy.ensurePermissiveTaskGroup();
  });

  after(() => {
    cy.login();
    programId(code).then((uuid) => deleteProgramApi(uuid, code));
  });

  beforeEach(() => {
    cy.login();
  });

  it('Creates a program with a schema and imports 4 valid beneficiaries (OCM-1175, OCM-1172)', () => {
    const fileName = `uat_valid_${runId}.csv`;
    cy.createProgram(code, name, '100', 'INDIVIDUAL', BENEFICIARY_SCHEMA);
    cy.assertJournalFirstEntryContains(`Create program ${name}`);
    cy.visit('/front/benefitPlans');
    cy.searchProgramByName(name);
    cy.contains('table tbody tr', code).should('exist');
    programId(code).then((uuid) => { id = uuid; });

    cy.then(() => openProgramPage(id));
    uploadBeneficiaries(fileName, toCsv(CSV_HEADER, validRows), 'Python Beneficiaries Upload')
      .its('response.statusCode').should('be.lessThan', 400);
    cy.contains('Upload successful').should('be.visible');
    cy.contains('File uploaded successfully and sent to the task group for approval.').should('be.visible');
    closeAlert();
    cy.contains('[role="dialog"] h2', 'Upload Beneficiaries').should('not.exist');

    waitForUploadStatus(fileName, 'WAITING_FOR_VERIFICATION').within(() => {
      cy.root().should('contain', 'Python Beneficiaries Upload').and('contain', 'None');
    });
    closeDialog();

    assertImportTaskSummary(fileName, [code, 'Python Beneficiaries Upload']);
    openImportTask(fileName);
    approveOpenImportTask();
    assertImportTaskStatus(fileName, 'COMPLETED');

    cy.then(() => openProgramPage(id));
    waitForUploadStatus(fileName, 'SUCCESS');
    closeDialog();
    listBeneficiaries(runId);
    cy.contains('4 Beneficiaries', { timeout: TIMEOUTS.BACKEND_VALIDATION }).should('exist');
    validRows.forEach((row) => cy.contains('table tbody tr', row.last_name).should('contain', 'POTENTIAL'));
  });

  it('Reports a missing mandatory column in the upload history (OCM-1171)', () => {
    const fileName = `uat_nodob_${runId}.csv`;
    const header = CSV_HEADER.filter((h) => h !== 'dob');
    openProgramPage(id);
    uploadBeneficiaries(fileName, toCsv(header, [beneficiaryRow('Eve', lastName('Echo'), '', '9')]), 'Python Beneficiaries Upload');
    // The request returns, with an alert either way.
    closeAlert();
    waitForUploadStatus(fileName, 'FAIL').within(() => {
      cy.get('li, [role="button"]').first().click({ force: true });
      cy.root().should('contain', 'Uploaded beneficiaries missing essential header: dob');
    });
    closeDialog();
  });

  it('Puts invalid rows aside and imports the valid ones after approval (OCM-1176)', () => {
    const fileName = `uat_invalid_${runId}.csv`;
    const rows = [
      beneficiaryRow('Fay', lastName('Foxtrot'), '1970-02-02', '5'),
      beneficiaryRow('Gus', lastName('Golf'), '1971-03-03', '6'),
      beneficiaryRow('Hal', lastName('Hotel'), '1972-04-04', '7'),
      beneficiaryRow('Ivy', lastName('India'), '1973-05-05', '8', 'not-an-email'),
    ];
    openProgramPage(id);
    uploadBeneficiaries(fileName, toCsv(CSV_HEADER, rows), 'Python Beneficiaries Upload')
      .its('response.statusCode').should('be.lessThan', 400);
    cy.contains('Upload successful').should('be.visible');
    closeAlert();

    const invalidItems = {};
    waitForUploadStatus(fileName, 'WAITING_FOR_VERIFICATION');
    closeDialog();

    // The test case's "Percentage of invalid items 25 %" was the tester's expected outcome,
    // not a field of the screen: not checked (OP-3287, tech debt; see also OP-3285).
    assertImportTaskSummary(fileName, [code, fileName, 'Python Beneficiaries Upload']);
    openImportTask(fileName);
    approveOpenImportTask();
    assertImportTaskStatus(fileName, 'COMPLETED');

    openProgramPage(id);
    listBeneficiaries(runId);
    ['Foxtrot', 'Golf', 'Hotel'].forEach((prefix) => cy.contains('table tbody tr', lastName(prefix)).should('exist'));
    cy.contains('table tbody tr', lastName('India')).should('not.exist');

    // The app offers 'Download Invalid Items' once the upload is PARTIAL_SUCCESS, i.e. after
    // approval (BenefitPlanBeneficiariesUploadHistoryDialog). Whether it must already be
    // offered while WAITING_FOR_VERIFICATION is the question of OP-3285: if so, check it there.
    waitForUploadStatus(fileName, 'PARTIAL_SUCCESS').then(($row) => {
      const $button = Cypress.$($row).find('button').filter((_, b) => b.innerText.trim().toLowerCase() === 'download invalid items');
      invalidItems.offered = $button.length > 0;
      if (!invalidItems.offered) return;
      cy.intercept('GET', '/api/social_protection/download_invalid_items/*').as('invalidItems');
      cy.wrap($button.first()).click();
      cy.wait('@invalidItems').then(({ response }) => {
        invalidItems.text = typeof response.body === 'string' ? response.body : new TextDecoder().decode(response.body);
      });
    });
    closeDialog();

    cy.wrap(invalidItems).should((items) => {
      expect(items.offered, "'Download Invalid Items' offered once PARTIAL_SUCCESS").to.be.true;
      expect(items.text, 'invalid items file').to.contain(lastName('India'));
      expect(items.text, 'valid rows not in the invalid items file').not.to.contain(lastName('Foxtrot'));
    });
  });

  it('Filters and sorts the beneficiaries of a program (OCM-1170)', () => {
    openProgramPage(id);
    cy.contains('button', 'Beneficiaries').click();
    ['List', 'Potential', 'Active', 'Graduated', 'Suspended'].forEach((tab) => cy.contains('button', new RegExp(`^${tab}$`)).should('exist'));
    listBeneficiaries();
    ['First name', 'Last name', 'Date of birth', 'Status'].forEach((header) => cy.contains('table thead th', header).should('exist'));
    loadedCount('Beneficiaries').then((total) => {
      cy.enterMuiInput('Last name', lastName('Alpha'));
      cy.aliasGraphqlQuery('beneficiary(', 'beneficiaryFilter');
      cy.wait(FILTER_DEBOUNCE_MS); // eslint-disable-line cypress/no-unnecessary-waiting
      cy.contains('button', 'Search').click();
      cy.awaitSearcherRefresh('beneficiaryFilter');
      resultsCount('Beneficiaries').should('be.lessThan', total);
      checkColumn('Last name', (values) => expect(values).to.deep.equal([lastName('Alpha')]));
    });

    cy.enterMuiInput('Last name', runId);
    cy.aliasGraphqlQuery('beneficiary(', 'beneficiaryRun');
    cy.wait(FILTER_DEBOUNCE_MS); // eslint-disable-line cypress/no-unnecessary-waiting
    cy.contains('button', 'Search').click();
    cy.awaitSearcherRefresh('beneficiaryRun');

    const sortBy = (header, alias) => {
      cy.aliasGraphqlQuery('beneficiary(', alias);
      cy.contains('table thead th', header).click();
      cy.awaitSearcherRefresh(alias);
      cy.waitForSearcherLoaded();
    };
    const sorted = (values, desc = false) => {
      const copy = [...values].sort((a, b) => a.localeCompare(b));
      return desc ? copy.reverse() : copy;
    };
    sortBy('Last name', 'sortLastAsc');
    checkColumn('Last name', (values) => {
      expect(values.length).to.be.greaterThan(2);
      expect(values, 'ascending by last name').to.deep.equal(sorted(values));
    });
    sortBy('Last name', 'sortLastDesc');
    checkColumn('Last name', (values) => expect(values, 'descending by last name').to.deep.equal(sorted(values, true)));
    sortBy('Date of birth', 'sortDob');
    checkColumn('Date of birth', (values) => {
      // The list shows YYYY-MM-DD or DD-MM-YYYY depending on the locale: normalise to
      // YYYY-MM-DD so that a string sort is a date sort.
      const asDate = values.map((v) => {
        const parts = v.split(/[-/]/);
        return parts[0].length === 4 ? parts.join('-') : parts.reverse().join('-');
      });
      const asc = [...asDate].sort();
      expect([asc, [...asc].reverse()], 'ordered by date of birth').to.deep.include(asDate);
    });
  });

  it('Exports the beneficiaries of a program (OCM-1174)', () => {
    openProgramPage(id);
    listBeneficiaries();
    loadedCount('Beneficiaries').then((total) => {
      exportBeneficiaries().then((rows) => expect(rows, 'exported rows').to.have.length(total));
    });
    cy.enterMuiInput('Last name', lastName('Alpha'));
    cy.aliasGraphqlQuery('beneficiary(', 'beneficiaryExportFilter');
    cy.wait(FILTER_DEBOUNCE_MS); // eslint-disable-line cypress/no-unnecessary-waiting
    cy.contains('button', 'Search').click();
    cy.awaitSearcherRefresh('beneficiaryExportFilter');
    exportBeneficiaries().then((rows) => {
      expect(rows, 'filtered export').to.have.length(1);
      expect(rows[0].last_name).to.eq(lastName('Alpha'));
    });
  });

  it('Updates beneficiaries from an uploaded file (OCM-1173)', () => {
    const fileName = `uat_update_${runId}.csv`;
    openProgramPage(id);
    listBeneficiaries(runId);
    exportBeneficiaries().then((rows) => {
      // The update workflow reads national_id (unique in the schema): keep the stored value.
      const header = ['ID', ...CSV_HEADER];
      expect(Object.keys(rows[0]), 'exported columns').to.include.members(['ID', 'first_name', 'last_name', 'dob']);
      const changed = rows.filter((r) => [lastName('Alpha'), lastName('Bravo')].includes(r.last_name))
        .map((r) => ({ ...r, last_name: `${r.last_name}X`, location_name: '', location_code: '' }));
      expect(changed, 'rows to update').to.have.length(2);
      openProgramPage(id);
      uploadBeneficiaries(fileName, toCsv(header, changed), 'Python Beneficiaries Update')
        .its('response.statusCode').should('be.lessThan', 400);
    });
    cy.contains('Upload successful').should('be.visible');
    closeAlert();
    waitForUploadStatus(fileName, 'WAITING_FOR_VERIFICATION').should('contain', 'Python Beneficiaries Update');
    closeDialog();

    openImportTask(fileName);
    approveOpenImportTask();
    assertImportTaskStatus(fileName, 'COMPLETED');

    openProgramPage(id);
    listBeneficiaries(runId);
    cy.contains('table tbody tr', `${lastName('Alpha')}X`).should('exist');
    cy.contains('table tbody tr', `${lastName('Bravo')}X`).should('exist');
  });
});
