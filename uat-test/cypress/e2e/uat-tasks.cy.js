import { TIMEOUTS } from '../support/constants';

// UAT cases of "Workplace- / Task Management- / Tasks". Tasks are produced by program
// updates (BenefitPlanService), which need approval with the pinned maker-checker config.
//
// TaskService.create gives a new task to the task group bound to its source, as ACCEPTED;
// an unbound source leaves it RECEIVED without a group. Both paths are tested: the
// baseline leaves BenefitPlanService unbound (scripts/baseline.mjs, ensureTaskGroups),
// and the ACCEPTED task is seeded while the source is bound to the "any" group.

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

const programFields = (code, name, description) => `code: "${code}" name: "${name}" type: INDIVIDUAL maxBeneficiaries: 10
  dateValidFrom: "${isoDate(0)}" dateValidTo: "${isoDate(365)}" description: "${description}" beneficiaryDataSchema: "{}"`;

// Relay ids are base64("TypeName:uuid"); mutations take the uuid.
const decodeId = (relayId) => atob(relayId).split(':')[1];

function programOf(code) {
  return gql(`{ benefitPlan(code: "${code}") { edges { node { id description } } } }`)
    .then((data) => {
      const node = data.benefitPlan.edges[0]?.node;
      return node && { ...node, id: decodeId(node.id) };
    });
}

// Creates a program and sends an update of its description: with maker-checker on,
// the update becomes a RECEIVED BenefitPlanService task whose entity is "Benefit Plan <code>".
function seedProgramUpdateTask(code, newDescription) {
  const name = `UAT Task Program ${code}`;
  return mutate('createBenefitPlan', programFields(code, name, ''), `UAT seed - create program ${code}`)
    .then(() => programOf(code))
    .then((program) => mutate(
      'updateBenefitPlan',
      `id: "${program.id}" ${programFields(code, name, newDescription)}`,
      `UAT seed - update program ${code}`,
    ).then(() => program.id));
}

const entityOf = (code) => `Benefit Plan ${code}`;

const PROGRAM_TASK_SOURCE = 'BenefitPlanService';

// Replaces the task sources of a group, keeping its executors (the update replaces both).
function bindTaskSources(code, sources) {
  return gql(`{ taskGroup(code: "${code}", isDeleted: false) { edges { node { uuid completionPolicy taskexecutorSet { edges { node { user { id } } } } } } } }`)
    .then((data) => {
      const group = data.taskGroup.edges[0].node;
      const userIds = group.taskexecutorSet.edges.map((e) => `"${decodeId(e.node.user.id)}"`);
      return mutate(
        'updateTaskGroup',
        `id: "${group.uuid}" code: "${code}" completionPolicy: ${group.completionPolicy} userIds: [${userIds.join(', ')}] taskSources: [${sources.map((src) => `"${src}"`).join(', ')}]`,
        `UAT seed - bind ${sources.join(', ') || 'no source'} to task group ${code}`,
      );
    });
}

const taskGroupUuid = (code) => gql(`{ taskGroup(code: "${code}", isDeleted: false) { edges { node { uuid } } } }`)
  .then((data) => data.taskGroup.edges[0]?.node.uuid);

// Deletes every task group this spec creates (codes "uat-..."), including those an
// interrupted earlier run left behind.
function deleteUatTaskGroups() {
  return gql('{ taskGroup(code_Istartswith: "uat-", isDeleted: false, first: 100) { edges { node { uuid code } } } }')
    .then((data) => {
      const groups = data.taskGroup.edges.map((e) => e.node);
      if (!groups.length) return null;
      return mutate(
        'deleteTaskGroup',
        `ids: [${groups.map((g) => `"${g.uuid}"`).join(', ')}]`,
        `UAT cleanup - delete task groups ${groups.map((g) => g.code).join(', ')}`,
      );
    });
}

const assignedTo = () => cy.contains('label', 'Assigned to').siblings('.MuiInputBase-root').find('input');

// Searcher filters apply after a debounce (~800 ms): a Search clicked sooner runs
// without the value just typed.
const FILTER_DEBOUNCE_MS = 1000;

function searchAllTasks(fill) {
  cy.visit('/front/allTasks');
  cy.waitForSearcherLoaded();
  fill();
  cy.wait(FILTER_DEBOUNCE_MS); // eslint-disable-line cypress/no-unnecessary-waiting
  cy.aliasGraphqlQuery('task(', 'allTaskSearch');
  cy.contains('button', 'Search').click();
  cy.awaitSearcherRefresh('allTaskSearch');
  cy.waitForSearcherLoaded();
}

function openTask(entity) {
  searchAllTasks(() => cy.enterMuiInput('Entity', entity));
  cy.contains('table tbody tr', entity, { timeout: TIMEOUTS.BACKEND_VALIDATION })
    .find('button:is([title="View details"],[aria-label="View details"])')
    .click({ force: true });
  cy.url({ timeout: TIMEOUTS.BACKEND_VALIDATION }).should('include', '/tasks/task/');
  cy.contains('General Information', { timeout: TIMEOUTS.BACKEND_VALIDATION });
  cy.contains('label', 'Entity').siblings('.MuiInputBase-root').find('input')
    .should('have.value', entity);
}

const statusField = () => cy.contains('label', /^Status$/).siblings('.MuiInputBase-root');

function assertTaskStatus(status) {
  statusField().should(($box) => {
    const value = $box.find('input').val() || $box.text();
    expect(String(value).trim()).to.contain(status);
  });
}

// The "Assigned to" picker lists flows and groups as "Group · <code> — <policy>".
// Each step queries the input again: the picker re-renders on focus when it already holds a group.
function assignTaskGroup(groupCode = 'any') {
  assignedTo().click({ force: true });
  assignedTo().clear({ force: true });
  assignedTo().type(groupCode, { force: true });
  cy.contains('[role="listbox"] li, li[role="option"]', `· ${groupCode} —`, { timeout: TIMEOUTS.BACKEND_VALIDATION }).click({ force: true });
  assignedTo().should('have.value', `Group · ${groupCode} — ANY`);
  cy.clickSave();
  cy.waitForJournalProgress();
  assertTaskStatus('ACCEPTED');
}

const decisionFab = (icon) => cy.contains('button.MuiFab-root', new RegExp(`^${icon}$`), { timeout: TIMEOUTS.BACKEND_VALIDATION });

// Polls the task row on All tasks until it shows `status` (resolution is asynchronous).
function waitForTaskRowStatus(entity, status, attempt = 1) {
  searchAllTasks(() => cy.enterMuiInput('Entity', entity));
  cy.contains('table tbody tr', entity).then(($row) => {
    if ($row.text().includes(status)) return;
    if (attempt >= 6) throw new Error(`task ${entity}: status ${status} not reached (${$row.text()})`);
    // eslint-disable-next-line cypress/no-unnecessary-waiting
    cy.wait(3000).then(() => waitForTaskRowStatus(entity, status, attempt + 1));
  });
}

function createTaskGroupUI(code, { sources = [] } = {}) {
  cy.visit('/front/tasks/groups');
  cy.waitForSearcherLoaded();
  cy.clickCreate();
  cy.enterMuiInput('Code', code);
  cy.chooseMuiSelect('Policy Status', 'ANY');
  cy.chooseMuiAutocomplete('Task Executors', 'Admin');
  sources.forEach((src) => cy.chooseMuiAutocomplete('Task Sources', src));
  cy.saveAndAwaitJournal({ mutationLabel: 'Create task group', assertNoFail: true });
}

function searchTaskGroups(code, policy) {
  cy.visit('/front/tasks/groups');
  cy.waitForSearcherLoaded();
  if (code) cy.enterMuiInput('Code', code);
  if (policy) cy.chooseMuiSelect('Policy Status', policy);
  cy.wait(FILTER_DEBOUNCE_MS); // eslint-disable-line cypress/no-unnecessary-waiting
  cy.aliasGraphqlQuery('taskGroup(', 'taskGroupSearch');
  cy.contains('button', 'Search').click();
  cy.awaitSearcherRefresh('taskGroupSearch');
  cy.waitForSearcherLoaded();
}

// Removes every task source of a group, so no new task is routed to it.
function unbindTaskSources(code) {
  searchTaskGroups(code);
  cy.get('body').then(($body) => {
    const row = $body.find('table tbody tr').toArray().find((tr) => tr.children[0]?.innerText.trim() === code);
    if (!row) return;
    cy.wrap(row).find(':is([title="View details"],[aria-label="View details"])').first().click({ force: true });
    cy.contains('label', 'Task Sources', { timeout: TIMEOUTS.BACKEND_VALIDATION });
    cy.assertMuiInput('Code', code);
    cy.contains('label', 'Task Sources').parent().then(($field) => {
      const chips = $field.find('.MuiChip-root').length;
      if (!chips) return;
      for (let i = 0; i < chips; i += 1) {
        cy.contains('label', 'Task Sources').parent().find('.MuiChip-root .MuiChip-deleteIcon').first().click({ force: true });
      }
      cy.saveAndAwaitJournal({ mutationLabel: 'Update task group', assertNoFail: true });
    });
  });
}

// Asserts the values of a results column, retrying until the searcher has re-rendered.
const checkColumn = (header, check) => cy.contains('table thead th', header).should(($th) => {
  const index = $th.index();
  check($th.closest('table').find('tbody tr').toArray()
    .map((tr) => tr.children[index]?.innerText.trim())
    .filter((v) => v !== undefined && v !== ''));
});

describe('Task approval', () => {
  const searchCode = `TS${runId}`;
  const rejectCode = `TR${runId}`;
  const acceptCode = `TA${runId}`;
  const newDescription = `Approved change ${runId}`;
  const programs = {};
  const seed = (code) => seedProgramUpdateTask(code, newDescription).then((id) => { programs[code] = id; });

  before(() => {
    cy.login();
    cy.ensurePermissiveTaskGroup();
    // Unbound source: RECEIVED, no group.
    [searchCode, rejectCode].forEach(seed);
    // Bound source: ACCEPTED in the bound group.
    bindTaskSources('any', [PROGRAM_TASK_SOURCE]);
    seed(acceptCode);
    bindTaskSources('any', []);
  });

  after(() => {
    cy.login();
    // Already done in before(), unless a seed failed in between.
    bindTaskSources('any', []);
    Object.entries(programs).forEach(([code, id]) => mutate('deleteBenefitPlan', `ids: ["${id}"]`, `UAT cleanup - delete program ${code}`));
  });

  beforeEach(() => {
    cy.login();
  });

  it('Searches all tasks by status and entity (OCM-1158)', () => {
    cy.visit('/front/allTasks');
    cy.waitForSearcherLoaded();
    cy.contains(/\d+ Tasks Found/).should('exist');
    ['Source', 'Type', 'Entity', 'Task Group', 'Status', 'Date Created']
      .forEach((header) => cy.contains('table thead th', header).should('exist'));

    // The seeded tasks guarantee rows in both statuses.
    ['RECEIVED', 'ACCEPTED'].forEach((status) => {
      searchAllTasks(() => cy.chooseMuiSelect('Status', status));
      checkColumn('Status', (statuses) => {
        expect(statuses, `${status} rows`).to.have.length.greaterThan(0);
        statuses.forEach((s) => expect(s).to.eq(status));
      });
    });

    searchAllTasks(() => cy.enterMuiInput('Entity', entityOf(searchCode)));
    checkColumn('Entity', (entities) => {
      expect(entities, 'rows').to.have.length(1);
      expect(entities[0]).to.eq(entityOf(searchCode));
    });
  });

  // Unbound source: the task waits for a group before it can be decided.
  it('Rejects a task: the change is not applied (OCM-1159)', () => {
    openTask(entityOf(rejectCode));
    assertTaskStatus('RECEIVED');
    cy.contains('Please assign a task group to approve this task.').should('be.visible');
    cy.contains('button.MuiFab-root', /^(check|clear)$/).should('not.exist');

    assignTaskGroup();
    decisionFab('check').should('not.be.disabled');
    decisionFab('clear').should('not.be.disabled').click();
    cy.get('[role="dialog"]').should('contain', 'Resolve task')
      .and('contain', 'Are you sure you want to fail this task?');
    cy.get('[role="dialog"]').contains('button', 'Ok').click();
    cy.waitForJournalProgress();

    waitForTaskRowStatus(entityOf(rejectCode), 'FAILED');
    programOf(rejectCode).its('description').should('not.eq', newDescription);
  });

  // Bound source: the task arrives ACCEPTED in the bound group and is decided there.
  it('Accepts a task: the change is applied (OCM-1160)', () => {
    openTask(entityOf(acceptCode));
    assertTaskStatus('ACCEPTED');
    assignedTo().should('have.value', 'Group · any — ANY');
    decisionFab('check').should('not.be.disabled').click();
    cy.get('[role="dialog"]').should('contain', 'Are you sure you want to approve this task?');
    cy.get('[role="dialog"]').contains('button', 'Ok').click();
    cy.waitForJournalProgress();

    waitForTaskRowStatus(entityOf(acceptCode), 'COMPLETED');
    programOf(acceptCode).its('description').should('eq', newDescription);
  });
});

describe('Task groups', () => {
  const createCode = `uat-c-${runId}`.toLowerCase();
  const deleteCode = `uat-d-${runId}`.toLowerCase();
  const autoCode = `uat-a-${runId}`.toLowerCase();
  const programs = {};

  before(() => {
    cy.login();
    createTaskGroupUI(deleteCode);
  });

  after(() => {
    cy.login();
    // Through the API: the UI path waits on the journal, whose spinner can outlive the
    // test and leave the groups behind. Unbind first: a group left bound to
    // BenefitPlanService would capture the program tasks of other specs.
    taskGroupUuid(autoCode).then((uuid) => uuid && bindTaskSources(autoCode, []));
    deleteUatTaskGroups();
    Object.entries(programs).forEach(([code, id]) => mutate('deleteBenefitPlan', `ids: ["${id}"]`, `UAT cleanup - delete program ${code}`));
  });

  beforeEach(() => {
    cy.login();
  });

  it('Creates a task group (OCM-1163)', () => {
    cy.visit('/front/tasks/groups');
    cy.waitForSearcherLoaded();
    cy.clickCreate();
    cy.contains('General Information');
    ['Code', 'Policy Status', 'Task Executors', 'Task Sources'].forEach((label) => cy.contains('label', label).should('exist'));
    cy.assertSaveDisabled();

    cy.enterMuiInput('Code', createCode);
    cy.chooseMuiSelect('Policy Status', 'ANY');
    cy.chooseMuiAutocomplete('Task Executors', 'Admin');
    cy.saveAndAwaitJournal({ mutationLabel: 'Create task group', assertNoFail: true });

    searchTaskGroups(createCode);
    cy.contains('table tbody tr', createCode).should('contain', 'ANY');
  });

  it('Filters and sorts task groups (OCM-1162)', () => {
    cy.visit('/front/tasks/groups');
    cy.waitForSearcherLoaded();
    cy.contains(/\d+ Task Groups Found/).should('exist');
    ['Code', 'Policy Status'].forEach((header) => cy.contains('table thead th', header).should('exist'));

    searchTaskGroups('uat-', 'ANY');
    checkColumn('Code', (codes) => {
      expect(codes, 'groups of this suite').to.include.members([deleteCode]);
      codes.forEach((c) => expect(c).to.contain('uat-'));
    });
    checkColumn('Policy Status', (policies) => policies.forEach((p) => expect(p).to.eq('ANY')));

    searchTaskGroups('');
    const sortByCode = (alias) => {
      cy.aliasGraphqlQuery('taskGroup(', alias);
      cy.contains('table thead th', 'Code').click();
      cy.awaitSearcherRefresh(alias);
      cy.waitForSearcherLoaded();
    };
    // The database orders codes byte by byte (release: TG1, any, pc-cycles), upper case
    // first, not case-insensitively.
    const byCode = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
    // The list is already ordered by code, so the first click may turn it either way:
    // it must be ordered by code, and the second click must reverse it.
    const firstOrder = [];
    sortByCode('groupSortFirst');
    checkColumn('Code', (codes) => {
      expect(codes.length).to.be.greaterThan(1);
      const asc = [...codes].sort(byCode);
      expect([asc, [...asc].reverse()], 'ordered by code').to.deep.include(codes);
      firstOrder.splice(0, firstOrder.length, ...codes);
    });
    sortByCode('groupSortSecond');
    checkColumn('Code', (codes) => expect(codes, 'order reversed by the second click').to.deep.equal([...firstOrder].reverse()));

    // The test case's "Number of Members" column is not in the list: OP-3288 (tech debt).
  });

  it('Deletes a task group after confirmation (OCM-1164)', () => {
    searchTaskGroups(deleteCode);
    const deleteButton = () => cy.contains('table tbody tr', deleteCode).find(':is([title="Delete"],[aria-label="Delete"])').first();
    deleteButton().click({ force: true });
    cy.get('[role="dialog"]').should('contain', `Delete task group ${deleteCode}`);
    cy.get('[role="dialog"]').contains('button', 'Cancel').click();
    cy.get('[role="dialog"]').should('not.exist');
    cy.contains('table tbody tr', deleteCode).should('exist');

    deleteButton().click({ force: true });
    cy.get('[role="dialog"]').contains('button', 'Ok').click();
    cy.waitForJournalProgress();
    cy.assertJournalFirstEntryContains('Delete task group');
    cy.assertJournalNoFail();

    searchTaskGroups(deleteCode);
    cy.contains('table tbody tr', deleteCode).should('not.exist');
    // The list alone can pass while the server refused the delete (empty or stale results).
    gql(`{ taskGroup(code: "${deleteCode}", isDeleted: false) { totalCount } }`)
      .its('taskGroup.totalCount').should('eq', 0);
  });

  // Adapted: the case binds 'Delete Payroll' and deletes a pending payroll; this test
  // binds the program update source (BenefitPlanService), which is cheaper to trigger.
  // The source is unbound afterwards.
  it('Assigns new tasks of a bound source to the group automatically (OCM-1165)', () => {
    const code = `TG${runId}`;
    createTaskGroupUI(autoCode);
    searchTaskGroups(autoCode);
    cy.contains('table tbody tr', autoCode).find(':is([title="View details"],[aria-label="View details"])').first().click({ force: true });
    cy.contains('label', 'Task Sources', { timeout: TIMEOUTS.BACKEND_VALIDATION }).should('exist');
    cy.assertMuiInput('Code', autoCode);
    cy.chooseMuiAutocomplete('Task Sources', PROGRAM_TASK_SOURCE);
    cy.saveAndAwaitJournal({ mutationLabel: 'Update task group', assertNoFail: true });

    seedProgramUpdateTask(code, `Auto assigned ${runId}`).then((id) => { programs[code] = id; });
    openTask(entityOf(code));
    assertTaskStatus('ACCEPTED');
    assignedTo().should('have.value', `Group · ${autoCode} — ANY`);

    // Unbind before anything else creates program tasks.
    unbindTaskSources(autoCode);
  });
});
