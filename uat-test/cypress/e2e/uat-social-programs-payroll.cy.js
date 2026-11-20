import { CALC_RULES, PAYROLL_STATUS, TIMEOUTS } from '../support/constants';
import { baseline } from '../support/baseline';

// UAT cases that need a program with ACTIVE beneficiaries: payroll creation and
// reconciliation ("Accounting- / Payroll-") and project timesheets. Runs against the
// pinned configuration: enrolment, payment cycles and payrolls go through tasks.

const runId = Date.now().toString(36).slice(-5).toUpperCase();

const isoDate = (offsetDays = 0) => {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
};
const dmy = (offsetDays) => isoDate(offsetDays).split('-').reverse().join('-');

const uuidv4 = () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
  const r = (Math.random() * 16) | 0;
  return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
});

// Searcher filters apply after a debounce (~800 ms): a Search clicked sooner runs
// without the value just typed.
const FILTER_DEBOUNCE_MS = 1000;

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

const decodeId = (relayId) => atob(relayId).split(':')[1];

const SCHEMA = {
  type: 'object',
  properties: {
    able_bodied: { type: 'boolean' },
    educated_level: { type: 'string' },
    number_of_children: { type: 'integer' },
  },
};

// The ACTIVE enrolment criterion is stored with the program at creation: a later
// program update would wait for approval.
const ACTIVE_CRITERIA = { advanced_criteria: { ACTIVE: [{ type: 'boolean', field: 'able_bodied', value: 'False', filter: 'exact' }] } };

function searchList(route, name) {
  cy.visit(route);
  cy.contains('Payrolls Found', { timeout: TIMEOUTS.BACKEND_VALIDATION });
  cy.waitForSearcherLoaded();
  cy.enterMuiInput('Name', name);
  cy.wait(FILTER_DEBOUNCE_MS); // eslint-disable-line cypress/no-unnecessary-waiting
  cy.aliasGraphqlQuery('payroll(', 'payrollListSearch');
  cy.contains('button', 'Search').click();
  cy.awaitSearcherRefresh('payrollListSearch');
  cy.waitForSearcherLoaded();
}

function openPayroll(name) {
  searchList('/front/payrolls', name);
  cy.contains('table tbody tr', name).find('button.MuiIconButton-root').first().click({ force: true });
  cy.url().should('match', /\/payrolls\/payroll\/.+/);
  cy.assertMuiInput('Name', name);
}

const payrollStatus = () => cy.contains('label', /^Status$/).siblings('.MuiInputBase-root').find('input');

// Reopens the payroll until its status is `status` (benefits are generated asynchronously).
function waitForPayrollStatus(name, status, attempt = 1) {
  openPayroll(name);
  payrollStatus().invoke('val').then((value) => {
    if (value === status) return;
    if (attempt >= 10) throw new Error(`payroll ${name}: status ${status} not reached (${value})`);
    // eslint-disable-next-line cypress/no-unnecessary-waiting
    cy.wait(5000).then(() => waitForPayrollStatus(name, status, attempt + 1));
  });
}

// Approves the open (RECEIVED) task of `entity` whose row contains `type`, assigning the
// permissive group. (tasks.commands approveTaskFromList expects the picker value "any",
// but the "Assigned to" picker now shows "Group · any — ANY".)
function approveTask(entity, type) {
  cy.visit('/front/allTasks');
  cy.waitForSearcherLoaded();
  cy.enterMuiInput('Entity', entity);
  cy.wait(FILTER_DEBOUNCE_MS); // eslint-disable-line cypress/no-unnecessary-waiting
  cy.aliasGraphqlQuery('task(', 'approveTaskSearch');
  cy.contains('button', 'Search').click();
  cy.awaitSearcherRefresh('approveTaskSearch');
  cy.get('table tbody tr', { timeout: TIMEOUTS.BACKEND_VALIDATION })
    .filter((_, tr) => tr.innerText.includes(type) && /RECEIVED|ACCEPTED/.test(tr.innerText))
    .first()
    .find('button:is([title="View details"],[aria-label="View details"])')
    .click({ force: true });
  cy.url({ timeout: TIMEOUTS.BACKEND_VALIDATION }).should('include', '/tasks/task/');
  cy.contains('label', 'Assigned to').siblings('.MuiInputBase-root').find('input')
    .click({ force: true })
    .type('any', { force: true });
  cy.contains('[role="listbox"] li, li[role="option"]', '· any —', { timeout: TIMEOUTS.BACKEND_VALIDATION }).click({ force: true });
  cy.clickSave();
  cy.waitForJournalProgress();
  cy.contains('button.MuiFab-root', /^check$/, { timeout: TIMEOUTS.BACKEND_VALIDATION }).should('not.be.disabled').click();
  cy.get('[role="dialog"]').contains('button', 'Ok').click();
  cy.get('[role="dialog"]').should('not.exist');
}

function createActiveCycle(code) {
  cy.createPaymentCycle({ code, startDate: dmy(0), endDate: dmy(30), status: 'ACTIVE' });
  cy.approveLatestPaymentCycleTask();
  cy.filterPaymentCycles({ code });
  cy.assertPaymentCycleRowVisible({ code, status: 'ACTIVE' });
}

function openReconciledSummary(name) {
  searchList('/front/payrollsReconciled', name);
  cy.contains('table tbody tr', name).contains('button', /View Reconciliation Summary/i).click({ force: true });
  cy.contains('[role="dialog"]', 'View Reconciliation Summary:', { timeout: TIMEOUTS.BACKEND_VALIDATION });
}

describe('Payrolls and projects of a program with active beneficiaries', () => {
  // Program, plan and cycles are seeded here. Beneficiaries are the baseline upload
  // (able bodied false). The timesheet project uses region r1 (coherent with those
  // individuals, villages of r1d1 and r1d2) and the baseline activity.
  const code = `PA${runId}`;
  const name = `UAT Payroll Program ${runId}`;
  const planCode = `PL${runId}`;
  const planName = `UAT Payroll Plan ${runId}`;
  const cycleCode = `PCA${runId}`;
  const failedCycleCode = `PCF${runId}`;
  const payrollName = `UAT Payroll ${runId}`;
  const failedPayrollName = `UAT Failed Invoices ${runId}`;
  const legacyCycleCode = `PCL${runId}`;
  const legacyPayrollName = `UAT Legacy Criterion ${runId}`;
  let programId;

  before(() => {
    cy.login();
    cy.ensurePermissiveTaskGroup();
    cy.ensurePaymentCycleTaskGroup();
    mutate(
      'createBenefitPlan',
      `code: "${code}" name: "${name}" type: INDIVIDUAL maxBeneficiaries: 500
       dateValidFrom: "${isoDate(0)}" dateValidTo: "${isoDate(365)}"
       beneficiaryDataSchema: ${JSON.stringify(JSON.stringify(SCHEMA))} jsonExt: ${JSON.stringify(JSON.stringify(ACTIVE_CRITERIA))}`,
      `UAT seed - create program ${code}`,
    );
    gql(`{ benefitPlan(code: "${code}") { edges { node { id } } } }`).then((data) => {
      programId = decodeId(data.benefitPlan.edges[0].node.id);
    });
    cy.enrollIndividualBeneficiariesIntoProgram(name, code, 'Active', 'Able bodied', 'Exact', 'False');
    cy.createPaymentPlan({
      code: planCode,
      name: planName,
      benefitPlanCode: code,
      calculationRule: CALC_RULES.SOCIAL_PROTECTION,
      calculationParams: { 'Fixed amount': '100' },
      dateValidFrom: dmy(0),
      dateValidTo: dmy(365),
    });
    createActiveCycle(cycleCode);
    createActiveCycle(failedCycleCode);
    createActiveCycle(legacyCycleCode);
  });

  after(() => {
    cy.login();
    // A payroll is deleted once its deletion task is approved: done through the API.
    [payrollName, failedPayrollName, legacyPayrollName].forEach((payroll) => cy.deletePayrollsByApi(payroll));
  });

  beforeEach(() => {
    cy.login();
  });

  it('Creates a payroll with an advanced criterion and approves it (OCM-1177)', () => {
    cy.openCreatePayroll();
    ['Name', 'Payment Plan', 'Payment Point', 'Payment Cycle', 'Payment Method', 'Valid From', 'Valid To']
      .forEach((label) => cy.contains('label', label).should('exist'));
    cy.assertSaveDisabled();
    cy.fillPayrollForm({
      name: payrollName,
      paymentPlanCode: planCode,
      paymentPlanName: planName,
      paymentCycleCode: cycleCode,
      paymentMethod: 'StrategyOfflinePayment',
      dateValidFrom: dmy(0),
      dateValidTo: dmy(30),
    });
    // Payment Point is optional.
    cy.assertSaveEnabled();

    cy.contains('button', 'Add Criterion').click();
    cy.chooseMuiSelect('Field', 'children');
    cy.chooseFirstMuiSelect('Filter');
    cy.enterMuiInput('Value', '0');

    cy.clickSave();
    cy.waitForJournalProgress();
    cy.assertJournalFirstEntryContains(`Create Payroll ${payrollName}`);
    cy.assertJournalNoFail();
    waitForPayrollStatus(payrollName, PAYROLL_STATUS.PENDING_APPROVAL);

    // OP-3279: the payroll page tells about the pending acceptance task.
    openPayroll(payrollName);
    cy.contains('.MuiChip-root', '1 pending task', { timeout: TIMEOUTS.BACKEND_VALIDATION }).should('be.visible');

    searchList('/front/payrollsPending', payrollName);
    cy.contains('table tbody tr', payrollName).should('exist');

    approveTask(payrollName, 'accept_payroll');
    searchList('/front/payrollsApproved', payrollName);
    cy.contains('table tbody tr', payrollName).should('exist');
    waitForPayrollStatus(payrollName, PAYROLL_STATUS.APPROVE_FOR_PAYMENT);

    // No task is pending any more once the payroll is accepted.
    openPayroll(payrollName);
    cy.contains('label', 'Name', { timeout: TIMEOUTS.BACKEND_VALIDATION });
    cy.contains('.MuiChip-root', 'pending task').should('not.exist');
  });

  // The payroll is reconciled with one beneficiary left unpaid, which the next cases need.
  it('Shows a reconciled payroll: files, summary and details (OCM-1179)', () => {
    openPayroll(payrollName);
    cy.downloadReconciliationFromUI().then(({ rows }) => {
      expect(rows.length, 'benefits to reconcile').to.be.greaterThan(1);
      const paid = rows.map((r, i) => (i === 0 ? r : { ...r, Paid: 'Yes', Receipt: `RCT-${r.Code}` }));
      cy.buildReconciliationCsv(paid).then((csv) => cy.uploadReconciliationFromUI(payrollName, csv));
      cy.wrap(rows.length).as('benefitCount');
    });
    cy.approveAndClosePayrollFromSummary(payrollName);
    approveTask(payrollName, 'payroll_reconciliation');
    waitForPayrollStatus(payrollName, PAYROLL_STATUS.RECONCILED);

    searchList('/front/payrollsReconciled', payrollName);
    cy.contains('table tbody tr', payrollName).contains('button', /View Reconciliation Files/i).click({ force: true });
    cy.get('[role="dialog"]', { timeout: TIMEOUTS.BACKEND_VALIDATION }).should('contain', '.csv');
    cy.get('[role="dialog"]').contains('button', /close/i).click();

    openReconciledSummary(payrollName);
    cy.get('@benefitCount').then((count) => {
      cy.get('[role="dialog"]').should('contain', `${count - 1} of ${count}`);
    });
    cy.get('[role="dialog"]').should('contain', 'Total Amount for Invoice').and('contain', 'Total Delivered Per Reconciliation');
    cy.get('[role="dialog"]').contains('button', /^close$/i).click();

    searchList('/front/payrollsReconciled', payrollName);
    cy.contains('table tbody tr', payrollName).dblclick({ force: true });
    cy.url().should('match', /\/payrolls\/payroll\/.+/);
    cy.assertMuiInputDisabled('Name', payrollName);
    cy.contains('Benefit Consumptions').should('exist');
  });

  it('Creates a payroll for the failed invoices of a reconciled payroll (OCM-1180)', () => {
    openReconciledSummary(payrollName);
    cy.get('[role="dialog"]').contains('button', 'Create Payment For Failed Invoice').should('not.be.disabled').click();
    cy.url().should('include', 'createPayrollFromFailedInvoices');
    cy.assertMuiInput('Name', '');
    cy.contains('label', 'Payment Cycle').siblings('.MuiInputBase-root').find('input').should('have.value', '');
    cy.contains('label', 'Payment Plan').siblings('.MuiInputBase-root').should('contain', planCode);

    cy.enterMuiInput('Name', failedPayrollName);
    cy.chooseMuiAutocomplete('Payment Cycle', failedCycleCode);
    cy.clickSave();
    cy.waitForJournalProgress();
    cy.assertJournalFirstEntryContains(`Create Payroll ${failedPayrollName}`);
    cy.assertJournalNoFail();
    waitForPayrollStatus(failedPayrollName, PAYROLL_STATUS.PENDING_APPROVAL);

    cy.visit('/front/allTasks');
    cy.waitForSearcherLoaded();
    cy.enterMuiInput('Entity', failedPayrollName);
    cy.wait(FILTER_DEBOUNCE_MS); // eslint-disable-line cypress/no-unnecessary-waiting
    cy.aliasGraphqlQuery('task(', 'failedPayrollTask');
    cy.contains('button', 'Search').click();
    cy.awaitSearcherRefresh('failedPayrollTask');
    cy.contains('table tbody tr', 'accept_payroll').should('contain', failedPayrollName);
  });

  // OP-3313: a criterion stored without an operator ("field__type=value", as payrolls and
  // payment plans saved before 26.10 hold it) is an exact match. Since OP-3251 it was refused
  // and the payroll ended FAILED. The UI always writes an operator, so the payroll is created
  // through the API, as stored data would reach the backend.
  it('Creates a payroll whose stored criterion has no operator', () => {
    gql(`{ paymentPlan(code: "${planCode}") { edges { node { id } } } }`).then((plans) => {
      gql(`{ paymentCycle(code: "${legacyCycleCode}") { edges { node { id } } } }`).then((cycles) => {
        const jsonExt = { advanced_criteria: [{ custom_filter_condition: 'able_bodied__boolean=False' }] };
        mutate(
          'createPayroll',
          `name: "${legacyPayrollName}" paymentMethod: "StrategyOfflinePayment"
           paymentPlanId: "${decodeId(plans.paymentPlan.edges[0].node.id)}"
           paymentCycleId: "${decodeId(cycles.paymentCycle.edges[0].node.id)}"
           dateValidFrom: "${isoDate(0)}" dateValidTo: "${isoDate(30)}"
           jsonExt: ${JSON.stringify(JSON.stringify(jsonExt))}`,
          `UAT - create payroll ${legacyPayrollName}`,
        );
      });
    });
    // The baseline beneficiaries are not able bodied: all of them match, at the fixed amount.
    cy.assertPayrollBenefits(legacyPayrollName, { minCount: 1, amount: 100 });
  });

  it('Enters time of project beneficiaries and rejects percentages above 100 (OCM-1226)', () => {
    const projectName = `UAT Timesheet ${runId}`;
    const B = baseline();
    cy.createProject(name, projectName, B.activity.name, B.locations.r1.label, null, '20', '3');
    // The page moves from the create URL to project/<uuid> only once the saved project is
    // fetched (OP-3275): read the path after that, not right after the save.
    cy.location('pathname', { timeout: TIMEOUTS.SERVER_RESULT }).should('match', /\/project\/[0-9a-f-]{36}$/i);
    cy.location('pathname').then((projectPath) => {
      cy.assignBeneficiariesToProject(projectPath);
      cy.visit(projectPath);
    });
    cy.contains(/[1-9]\d* Beneficiaries Assigned/, { timeout: TIMEOUTS.BACKEND_VALIDATION });
    cy.contains('button', 'Enter time').click();
    cy.get('table input[placeholder^="Work Day"]').should('have.length.at.least', 2);
    cy.get('table tbody tr').first().find('input[placeholder^="Work Day"]').should('have.length', 3);

    const day1 = (row) => cy.get('table tbody tr').filter((_, tr) => tr.querySelector('input[placeholder^="Work Day"]')).eq(row)
      .find('input[placeholder="Work Day 1"]');
    day1(0).type('{selectall}50', { force: true });
    day1(1).type('{selectall}150', { force: true });
    cy.contains('button', 'Save').click();
    cy.contains('[role="dialog"]', 'Invalid Time Entry').should('contain', 'Percentage values must be between 0 and 100');
    cy.get('[role="dialog"]').contains('button', /ok|close/i).click();

    day1(1).type('{selectall}100', { force: true });
    cy.contains('button', 'Save').click();
    cy.waitForJournalProgress();
    cy.assertJournalFirstEntryContains('time entries for project');
    cy.assertJournalNoFail();
    cy.get('table input[placeholder^="Work Day"]').should('not.exist');

    cy.reload();
    cy.contains('button', 'Enter time').click();
    day1(0).should('have.value', '50');
    day1(1).should('have.value', '100');
  });
});
