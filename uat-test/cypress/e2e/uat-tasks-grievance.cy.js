import { TIMEOUTS } from '../support/constants';

// UAT cases of "Workplace- / Task Management- / Grievance", against the pinned
// configuration (no module configuration change). The Beneficiary reporter needs a
// program with beneficiaries: the spec uploads two and approves the import task.

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

function gql(query) {
  return cy.request({ method: 'POST', url: '/api/graphql', body: { query }, log: false })
    .then(({ body }) => {
      if (body.errors?.length) throw new Error(`GraphQL error: ${JSON.stringify(body.errors)}`);
      return body.data;
    });
}

function mutate(name, input, label) {
  const clientMutationId = uuidv4();
  return gql(`mutation { ${name}(input: { clientMutationId: "${clientMutationId}" clientMutationLabel: "${label}" ${input} }) { clientMutationId } }`)
    .then(() => cy.waitForMutationLog(clientMutationId))
    .then(({ status, error }) => {
      if (status !== 2) throw new Error(`${label} failed: ${error}`);
    });
}

// Searcher filters apply after a debounce (~800 ms): a Search clicked sooner runs
// without the value just typed.
const FILTER_DEBOUNCE_MS = 1000;

const decodeId = (relayId) => atob(relayId).split(':')[1];

const programId = (code) => gql(`{ benefitPlan(code: "${code}") { edges { node { id } } } }`)
  .then((data) => decodeId(data.benefitPlan.edges[0].node.id));

// Program with two POTENTIAL beneficiaries: uploaded from the program page, then the
// Import Valid Items task is approved.
function seedProgramWithBeneficiaries(code, name) {
  const fileName = `uat_griev_${runId}.csv`;
  const csv = [
    'first_name,last_name,dob,location_name,location_code',
    `Gina,Griev${runId},1981-01-01,,`,
    `Hugo,Griev${runId},1982-02-02,,`,
  ].join('\n');
  mutate(
    'createBenefitPlan',
    `code: "${code}" name: "${name}" type: INDIVIDUAL maxBeneficiaries: 10
     dateValidFrom: "${isoDate(0)}" dateValidTo: "${isoDate(365)}" beneficiaryDataSchema: "{}"`,
    `UAT seed - create program ${code}`,
  );
  programId(code).then((id) => cy.visit(`/front/benefitPlans/benefitPlan/${id}`));
  // Upload is enabled once the program page has loaded.
  cy.contains('button', /^Upload$/, { timeout: TIMEOUTS.APP_LOAD }).should('not.be.disabled').click();
  cy.get('[role="dialog"] input[type="file"]').selectFile(
    { contents: Cypress.Buffer.from(csv), fileName, mimeType: 'text/csv' },
    { force: true },
  );
  cy.chooseMuiSelect('Workflow', 'Python Beneficiaries Upload');
  cy.get('[role="dialog"]').contains('button', 'Upload Beneficiaries').click();
  cy.contains('[role="dialog"] button', /^close$/i).click();

  cy.visit('/front/allTasks');
  cy.waitForSearcherLoaded();
  cy.enterMuiInput('Entity', fileName);
  cy.wait(FILTER_DEBOUNCE_MS); // eslint-disable-line cypress/no-unnecessary-waiting
  cy.aliasGraphqlQuery('task(', 'seedTaskSearch');
  cy.contains('button', 'Search').click();
  cy.awaitSearcherRefresh('seedTaskSearch');
  cy.contains('table tbody tr', fileName, { timeout: TIMEOUTS.BACKEND_VALIDATION })
    .find('button:is([title="View details"],[aria-label="View details"])')
    .click({ force: true });
  cy.contains('Import Valid Items Task', { timeout: TIMEOUTS.BACKEND_VALIDATION });
  cy.contains('label', 'Assigned to').siblings('.MuiInputBase-root').find('input')
    .click({ force: true })
    .type('any', { force: true });
  cy.contains('[role="listbox"] li, li[role="option"]', '· any —', { timeout: TIMEOUTS.BACKEND_VALIDATION }).click({ force: true });
  cy.clickSave();
  cy.waitForJournalProgress();
  cy.contains('div', 'Accept All', { timeout: TIMEOUTS.BACKEND_VALIDATION }).find('button').click();
  cy.contains('button', 'Continue').click();
  cy.contains('div', 'Accept All').find('button').should('be.disabled');
  // The beneficiaries exist once the task is completed.
  const waitForBeneficiaries = (attempt = 1) => gql(`{ beneficiary(benefitPlan_Code_Iexact: "${code}", isDeleted: false) { totalCount } }`)
    .then((data) => {
      if (data.beneficiary.totalCount >= 2) return;
      if (attempt >= 10) throw new Error(`program ${code}: beneficiaries not imported`);
      // eslint-disable-next-line cypress/no-unnecessary-waiting
      cy.wait(3000).then(() => waitForBeneficiaries(attempt + 1));
    });
  waitForBeneficiaries();
}

const grievanceData = (label, extra = {}) => ({
  title: `UAT ${label} Grievance ${runId}`,
  category: 'Category A',
  flag: 'FlagA',
  channel: 'Channel A',
  priority: 'High',
  details: `Details of the ${label} grievance ${runId}.`,
  // A grievance cannot be saved without a reporter (TicketForm canSave).
  reporterType: 'Attending Staff',
  ...extra,
});

// The Save FAB of a new grievance; its tooltip is none of the titles clickSave knows.
const saveFab = () => cy.get('button.MuiFab-root', { timeout: TIMEOUTS.BACKEND_VALIDATION }).last();
// A pristine form shows no Save FAB at all: fe-core Form renders it once the form is dirty.
const assertNoSaveFab = () => cy.get('button.MuiFab-root').should('not.exist');

function searchTickets(fill) {
  cy.visit('/front/ticket/tickets');
  cy.waitForSearcherLoaded();
  fill();
  cy.wait(FILTER_DEBOUNCE_MS); // eslint-disable-line cypress/no-unnecessary-waiting
  cy.aliasGraphqlQuery('tickets(', 'ticketSearch');
  cy.contains('button', 'Search').click();
  cy.awaitSearcherRefresh('ticketSearch');
  cy.waitForSearcherLoaded();
}

// Asserts the values of a results column, retrying until the searcher has re-rendered.
const checkColumn = (header, check) => cy.contains('table thead th', header).should(($th) => {
  const index = $th.index();
  check($th.closest('table').find('tbody tr').toArray()
    .map((tr) => tr.children[index]?.innerText.trim())
    .filter((v) => v !== undefined && v !== ''));
});

// Creates a grievance and yields its generated code.
function createGrievanceWithCode(data) {
  cy.createGrievance(data);
  return cy.getGrievanceCodeFromList(data.title);
}

function openGrievance(code) {
  cy.searchAndOpenGrievanceForEdit(code);
  cy.url({ timeout: TIMEOUTS.BACKEND_VALIDATION }).should('match', /\/ticket\/ticket\/[0-9a-f-]{36}/);
  cy.contains('label', 'Grievance Title', { timeout: TIMEOUTS.BACKEND_VALIDATION });
}

// Saves the open grievance and yields the MutationLog of the update (status 2 = success, 1 = error).
function saveGrievanceAndGetLog() {
  cy.intercept('POST', '/api/graphql', (req) => {
    if (typeof req.body?.query === 'string' && /updateTicket\s*\(/.test(req.body.query)) req.alias = 'updateTicket';
  });
  cy.clickSave();
  return cy.wait('@updateTicket').then(({ request }) => {
    const id = request.body.query.match(/clientMutationId:\s*"([^"]+)"/)?.[1];
    expect(id, 'clientMutationId of updateTicket').to.be.a('string');
    return cy.waitForMutationLog(id).then((log) => {
      // A successful save raises "Grievance saved", which covers the journal button.
      if (log.status === 2) cy.closeGrievanceSavedDialog();
      return cy.wrap(log, { log: false });
    });
  });
}

describe('Grievance creation and list', () => {
  const programCode = `GV${runId}`;
  const programName = `UAT Grievance Program ${runId}`;
  const codes = {};

  before(() => {
    cy.login();
    cy.ensurePermissiveTaskGroup();
    seedProgramWithBeneficiaries(programCode, programName);
  });

  after(() => {
    cy.login();
    programId(programCode).then((id) => mutate('deleteBenefitPlan', `ids: ["${id}"]`, `UAT cleanup - delete program ${programCode}`));
  });

  beforeEach(() => {
    cy.login();
  });

  it('Creates grievances for each reporter type (OCM-1183)', () => {
    cy.visit('/front/ticket/newTicket');
    cy.contains('label', 'Grievance Title', { timeout: TIMEOUTS.BACKEND_VALIDATION });
    assertNoSaveFab();

    const variants = [
      ['Beneficiary', { reporterType: 'Beneficiary', benefitPlan: programName }],
      ['Individual', { reporterType: 'Individual' }],
      ['Staff', { reporterType: 'Attending Staff' }],
      ['None', { reporterType: 'None' }],
    ];
    variants.forEach(([label, extra]) => {
      const data = grievanceData(label, extra);
      createGrievanceWithCode(data).then((code) => {
        codes[label] = code;
        expect(code, `generated code of ${label}`).to.match(/^\S+\d+$/);
      });
      cy.contains('table tbody tr', data.title).should('contain', 'RECEIVED');
    });
  });

  it('Keeps Save disabled while required fields are empty (OCM-1184)', () => {
    cy.visit('/front/ticket/newTicket');
    cy.contains('label', 'Grievance Title', { timeout: TIMEOUTS.BACKEND_VALIDATION });
    assertNoSaveFab();
    cy.enterMuiInput('DETAILS OF EVENT', `Only details ${runId}`);
    saveFab().should('be.disabled');
    ['Grievance Title', 'Category', 'Flag', 'Channel'].forEach((label) => {
      cy.contains('label', label).should('have.class', 'Mui-required');
    });
  });

  it('Lists grievances with the expected columns (OCM-1185)', () => {
    cy.visit('/front/ticket/tickets');
    cy.waitForSearcherLoaded();
    cy.contains(/\(\d+\) Grievance\(s\)/).should('exist');
    ['Code', 'Title', 'Reporter', 'Category', 'Status', 'Priority'].forEach((header) => cy.contains('table thead th', header).should('exist'));
    cy.get(':is([title="Add Grievance"],[aria-label="Add Grievance"]) button, button:is([title="Add Grievance"],[aria-label="Add Grievance"])').should('exist');

    const data = grievanceData('Listed');
    cy.createGrievance(data);
    cy.visit('/front/ticket/tickets');
    cy.checkGrievanceFieldValuesInListView(data.title, data.category);
  });

  it('Searches grievances by code, title, priority and status (OCM-1188)', () => {
    const low = grievanceData('Search Low', { priority: 'Low', category: 'Category B' });
    cy.createGrievance(low);
    cy.getGrievanceCodeFromList(low.title).then((lowCode) => {
      searchTickets(() => cy.enterMuiInput('Code', lowCode));
      checkColumn('Code', (values) => expect(values).to.deep.equal([lowCode]));
    });

    searchTickets(() => cy.enterMuiInput('Title', `Grievance ${runId}`));
    checkColumn('Title', (titles) => {
      expect(titles.length, 'rows of this run').to.be.greaterThan(1);
      titles.forEach((t) => expect(t).to.contain(runId));
    });

    searchTickets(() => {
      cy.enterMuiInput('Title', `Grievance ${runId}`);
      cy.chooseMuiSelect('Priority', 'Low');
    });
    checkColumn('Priority', (priorities) => {
      expect(priorities, 'rows').to.have.length.greaterThan(0);
      priorities.forEach((p) => expect(p).to.eq('Low'));
    });

    searchTickets(() => {
      cy.enterMuiInput('Title', `Grievance ${runId}`);
      cy.chooseMuiSelect('Status', 'Received');
    });
    checkColumn('Status', (statuses) => {
      expect(statuses, 'rows').to.have.length.greaterThan(0);
      statuses.forEach((s) => expect(s).to.eq('RECEIVED'));
    });

    cy.contains(/\(\d+\) Grievance\(s\)/).invoke('text').then((filtered) => {
      cy.aliasGraphqlQuery('tickets(', 'ticketReset');
      cy.contains('button', /reset/i).click();
      cy.awaitSearcherRefresh('ticketReset');
      cy.waitForSearcherLoaded();
      cy.assertMuiInput('Title', '');
      cy.contains(/\(\d+\) Grievance\(s\)/).invoke('text').should('not.eq', filtered);
    });
  });
});

describe('Grievance detail and workflow', () => {
  const base = grievanceData('Workflow', { category: 'Category A', priority: 'Normal' });
  let code;

  before(() => {
    cy.login();
    createGrievanceWithCode(base).then((c) => { code = c; });
  });

  beforeEach(() => {
    cy.login();
  });

  it('Shows the details of a grievance (OCM-1186)', () => {
    searchTickets(() => cy.enterMuiInput('Code', code));
    cy.contains('table tbody tr', code).dblclick();
    cy.url({ timeout: TIMEOUTS.BACKEND_VALIDATION }).should('match', /\/front\/ticket\/ticket\/[0-9a-f-]{36}/);
    cy.checkGrievanceFieldValues(base.title, base.category, base.flag, base.channel, base.priority, base.details);
    cy.contains('label', 'Status').siblings('.MuiInputBase-root').should('contain', 'Received');
    cy.contains('Add Comment').should('exist');
  });

  it('Adds a comment to a grievance (OCM-1190)', () => {
    const comment = `UAT comment ${runId}`;
    openGrievance(code);
    // The commenter is optional; OP-3286 (tech debt) proposes defaulting it to the user.
    cy.addGrievanceComment(comment, { reporterType: 'Attending Staff', attendingStaff: 'Admin' });
    cy.assertJournalNoFail();
    cy.reload();
    // The commenter is shown in a read-only user picker: its name is an input value.
    cy.contains('tr', comment, { timeout: TIMEOUTS.BACKEND_VALIDATION }).should(($tr) => {
      const values = [$tr.text(), ...$tr.find('input').toArray().map((i) => i.value)].join(' ');
      expect(values, 'commenter in the comment row').to.contain('Admin');
    });
  });

  it('Updates a grievance (OCM-1187)', () => {
    const updated = { title: `${base.title} Updated`, category: 'Category B', priority: 'Low' };
    openGrievance(code);
    cy.enterMuiInput('Grievance Title', updated.title);
    cy.chooseMuiAutocomplete('Category', updated.category);
    cy.chooseMuiSelect('Priority', updated.priority);
    saveGrievanceAndGetLog().its('status').should('eq', 2);
    cy.assertJournalFirstEntryContains('Update Ticket');

    openGrievance(code);
    cy.assertMuiInput('Grievance Title', updated.title);
    cy.assertMuiInput('Category', updated.category);
    cy.assertMuiSelectValue('Priority', updated.priority);
    searchTickets(() => cy.enterMuiInput('Code', code));
    cy.contains('table tbody tr', code).should('contain', updated.title).and('contain', updated.category).and('contain', updated.priority);
  });

  it('Rejects an invalid resolution time and accepts a valid one (OCM-1189)', () => {
    const resolution = () => cy.contains('label', 'RESOLUTION').siblings('.MuiInputBase-root').find('input');
    openGrievance(code);
    resolution().invoke('val').then((before) => {
      cy.enterMuiInput('RESOLUTION', 'abc');
      saveGrievanceAndGetLog().its('status').should('eq', 1);
      openGrievance(code);
      resolution().should('have.value', before);
    });

    cy.enterMuiInput('RESOLUTION', '5,12');
    saveGrievanceAndGetLog().its('status').should('eq', 2);
    openGrievance(code);
    resolution().should('have.value', '5,12');
  });

  it('Prints the grievance report (OCM-1194)', () => {
    openGrievance(code);
    // react-to-print prints a hidden iframe: capture what it would print instead of
    // opening the browser print dialog.
    cy.window().then((win) => {
      const descriptor = Object.getOwnPropertyDescriptor(win.HTMLIFrameElement.prototype, 'contentWindow');
      Object.defineProperty(win.HTMLIFrameElement.prototype, 'contentWindow', {
        configurable: true,
        get() {
          const frameWindow = descriptor.get.call(this);
          if (frameWindow && !frameWindow.uatPrintStub) {
            frameWindow.uatPrintStub = true;
            frameWindow.print = () => { win.uatPrinted = frameWindow.document.body.innerText; };
          }
          return frameWindow;
        },
      });
    });
    cy.contains('label[class*="MuiIconButton"], button', /^print$/).first().click({ force: true });
    cy.window().its('uatPrinted', { timeout: TIMEOUTS.BACKEND_VALIDATION }).then((printed) => {
      // Comments are printed from the comments panel, by their own template
      // (TicketPrintCommentTemplate), not with the details. 'Reporter' is missing for a
      // reporter of type user: fe-grievance_social_protection TicketPrintTemplate.jsx:119-144.
      [code, 'Date of Incident', 'Status', 'Reporter'].forEach((text) => expect(printed).to.contain(text));
    });
  });

  it('Moves a grievance to In Progress, resolves it with a comment and reopens it (OCM-1192, OCM-1193)', () => {
    openGrievance(code);
    cy.chooseMuiSelect('Status', 'In Progress');
    saveGrievanceAndGetLog().its('status').should('eq', 2);
    searchTickets(() => cy.enterMuiInput('Code', code));
    cy.contains('table tbody tr', code).should('contain', 'IN_PROGRESS');

    cy.resolveGrievance(code, `Resolution comment ${runId}`);
    searchTickets(() => cy.enterMuiInput('Code', code));
    cy.contains('table tbody tr', code).should('contain', 'CLOSED');

    cy.unlockGrievance(code);
    cy.assertJournalFirstEntryContains('Reopen Ticket');
    searchTickets(() => cy.enterMuiInput('Code', code));
    cy.contains('table tbody tr', code).should('contain', 'OPEN');
  });
});
