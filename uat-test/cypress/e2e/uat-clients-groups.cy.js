// UAT "Clients / Individual- / Groups" (and the Group History tab of an individual):
// list, members, change log, tasks, deletion with maker-checker, export and pagination
// of /front/groups. Groups and members are seeded through the GraphQL API with
// run-unique codes and names.
import { TIMEOUTS } from '../support/constants';

const runId = Date.now().toString(36).slice(-5).toUpperCase();
const runTag = runId.replace(/\d/g, (d) => 'ABCDEFGHIJ'[d]);
const lastName = (suffix) => `Uat${runTag}${suffix}`;

// ------------------ API ------------------
const uuidv4 = () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
  const r = (Math.random() * 16) | 0;
  return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
});

const gql = (query) => cy
  .request({ method: 'POST', url: '/api/graphql', body: { query }, log: false })
  .then(({ body }) => {
    if (body.errors?.length) throw new Error(`GraphQL error: ${JSON.stringify(body.errors)}`);
    return body.data;
  });

const mutateOk = (name, input, label = `UAT clients ${name}`) => {
  const clientMutationId = uuidv4();
  return gql(`mutation { ${name}(input: { clientMutationId: "${clientMutationId}" clientMutationLabel: "${label}" ${input} }) { clientMutationId } }`)
    .then(() => cy.waitForMutationLog(clientMutationId))
    .then(({ status, error }) => expect(status, `${name}: ${error}`).to.eq(2));
};

const gqlJson = (obj) => JSON.stringify(JSON.stringify(obj));

const seedIndividual = ({ firstName, lastName: last, dob = '1990-05-17' }) => {
  mutateOk('createIndividual', `firstName: "${firstName}" lastName: "${last}" dob: "${dob}" jsonExt: ${gqlJson({ number_of_children: 1 })}`);
  return gql(`{ individual(lastName_Iexact: "${last}", firstName_Iexact: "${firstName}") { edges { node { uuid } } } }`)
    .then((data) => data.individual.edges[0].node.uuid);
};

// Creates a group with its members ([{ uuid, role, recipientType }]); yields its uuid.
const seedGroup = (code, members) => {
  const individualsData = members
    .map((m) => `{ individualId: "${m.uuid}" role: ${m.role}${m.recipientType ? ` recipientType: ${m.recipientType}` : ''} }`)
    .join(' ');
  mutateOk('createGroup', `code: "${code}" individualsData: [${individualsData}]`);
  return gql(`{ group(code_Iexact: "${code}") { edges { node { uuid } } } }`).then((data) => data.group.edges[0].node.uuid);
};

const groupMembers = (groupUuid) => gql(`{ groupIndividual(group_Id: "${groupUuid}") { edges { node { uuid role recipientType individual { uuid } } } } }`)
  .then((data) => data.groupIndividual.edges.map((e) => e.node));

const editMember = (groupUuid, member, changes) => mutateOk(
  'editIndividualInGroup',
  `id: "${member.uuid}" individualId: "${member.individual.uuid}" groupId: "${groupUuid}" role: ${changes.role ?? member.role} recipientType: ${changes.recipientType ?? member.recipientType ?? 'SECONDARY'}`,
);

const tasksOf = (entityId) => gql(`{ task(entityId: "${entityId}") { edges { node { uuid status } } } }`)
  .then((data) => data.task.edges.map((e) => e.node));

const approveTaskApi = (entityId) => {
  gql('{ taskGroup(code: "any") { edges { node { uuid } } } users(username: "Admin") { edges { node { id } } } }')
    .then((data) => {
      const groupUuid = data.taskGroup.edges[0].node.uuid;
      const adminUuid = atob(data.users.edges[0].node.id).split(':')[1];
      tasksOf(entityId).then((tasks) => {
        const task = tasks.find((t) => ['RECEIVED', 'ACCEPTED'].includes(t.status));
        expect(task, `pending task of ${entityId}`).to.exist;
        mutateOk('updateTask', `id: "${task.uuid}" status: ACCEPTED taskGroupId: "${groupUuid}"`);
        mutateOk('resolveTask', `id: "${task.uuid}" businessStatus: ${gqlJson({ [adminUuid]: 'APPROVED' })}`);
      });
    });
};

const pollUntil = (fetch, check, message, { tries = 30, interval = 1000 } = {}) => {
  const attempt = (n) => fetch().then((value) => {
    if (check(value)) return value;
    if (n >= tries) throw new Error(`${message} (last value: ${JSON.stringify(value)})`);
    // eslint-disable-next-line cypress/no-unnecessary-waiting
    return cy.wait(interval, { log: false }).then(() => attempt(n + 1));
  });
  return attempt(1);
};

// ------------------ UI ------------------

// Sets the visible date field labelled `label`. Neither the calendar button (no popper
// opens for these searcher filters under Cypress) nor typing into the MUI X sections
// works, so the value goes through the field's hidden input, which parses it.
// The history searchers rebuild their filter pane on every fetch (OP-3273): a date
// set while a fetch is running is lost, so the tests wait for the request first.
const dateText = (date) => {
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(date.getDate())}-${pad(date.getMonth() + 1)}-${date.getFullYear()}`;
};
const pickDate = (label, date) => {
  const text = dateText(date);
  cy.waitForSearcherLoaded();
  cy.get('label').filter((_, l) => l.textContent.replace(/\*/g, '').trim() === label).filter(':visible').first()
    .parent()
    .as('dateField')
    .find('input')
    .first()
    .then(($input) => {
      const input = $input[0];
      const { HTMLInputElement, Event } = input.ownerDocument.defaultView;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, text);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  cy.get('@dateField').find('.MuiPickersSectionList-root, input').first().should(($el) => {
    expect($el.is('input') ? $el.val() : $el.text()).to.eq(text);
  });
};

const tableRows = () => cy.get('table tbody tr');
const openTab = (label) => cy.contains('button[role="tab"]', label, { matchCase: false }).click();
const countIn = (text, entity) => Number(text.match(new RegExp(`(\\d+) ${entity}`))[1]);

const searchGroups = (label, value) => {
  cy.visit('/front/groups');
  cy.contains(/\d+ Groups Found/, { timeout: TIMEOUTS.BACKEND_VALIDATION });
  cy.enterMuiInput(label, value);
  cy.contains('button', 'Search').click();
  cy.waitForSearcherLoaded();
};

// A FAB identified by its Material Symbols icon name ('check', 'clear').
const fabWithIcon = (icon) => cy.get('button.MuiFab-root').filter((_, b) => (
  [...b.querySelectorAll('[class*="material-symbols"]')].some((el) => el.textContent.trim() === icon)
));

// Opens the task whose Entity contains `entity` from Tasks Management > All tasks,
// assigns it to the 'any' group and saves.
const openAndAssignTask = (entity) => {
  const findRow = (attempt = 1) => {
    cy.visit('/front/AllTasks');
    cy.contains('Tasks Found', { timeout: TIMEOUTS.BACKEND_VALIDATION });
    cy.enterMuiInput('Entity', entity);
    cy.contains('button', 'Search').click();
    cy.waitForSearcherLoaded();
    cy.get('body').then(($body) => {
      if ($body.find('table tbody tr').toArray().some((tr) => tr.innerText.includes(entity))) return;
      if (attempt >= 6) throw new Error(`No task row for ${entity}`);
      // eslint-disable-next-line cypress/no-unnecessary-waiting
      cy.wait(5000).then(() => findRow(attempt + 1));
    });
  };
  findRow();
  cy.contains('table tbody tr', entity)
    .find('button:is([title="View details"],[aria-label="View details"])')
    .click({ force: true });
  cy.url({ timeout: TIMEOUTS.BACKEND_VALIDATION }).should('include', '/tasks/task/');
  cy.chooseMuiAutocomplete('Assigned to', 'any');
  // The picked option reads "Group · any — ANY".
  cy.contains('label', 'Assigned to').siblings('.MuiInputBase-root').find('input').invoke('val').should('match', /\bany\b/);
  cy.clickSave();
  cy.waitForJournalProgress();
};

// Clicks DOWNLOAD (confirming the column dialog when the searcher shows one) and
// yields the CSV the app fetched.
const downloadCsv = () => {
  cy.intercept('GET', '**/core/fetch_export*').as('export');
  cy.contains('DOWNLOAD').click();
  cy.get('body').then(($body) => {
    if ($body.find('[role="dialog"]:contains("Export configuration")').length) {
      cy.contains('[role="dialog"]', 'Export configuration').contains('button', /^Ok$/i).click();
    }
  });
  return cy.wait('@export', { timeout: 60000 }).then(({ response }) => {
    const [head, ...lines] = String(response.body).trim().split(/\r?\n/);
    return { columns: head.split(',').map((c) => c.replace(/"/g, '')), lines };
  });
};

// ------------------ DATA ------------------
// Spec-seeded groups (run-unique codes; members have no location), so coherence does
// not apply. Pagination needs >=20 groups: the baseline individuals upload provides
// them (group codes prefixed BL, same villages as the individuals, districts r1d1 and
// r1d2) and this spec seeds three more. No demo group is required.
const codes = {
  main: `UG${runId}`,
  tasks: `UT${runId}`,
  remove: `UD${runId}`,
};
const people = {
  head: { firstName: 'Hortense', lastName: lastName('Head') },
  child: { firstName: 'Hector', lastName: lastName('Kid') },
  taskHead: { firstName: 'Tobias', lastName: lastName('Thd') },
  taskMember: { firstName: 'Tamsin', lastName: lastName('Tmb') },
  removeHead: { firstName: 'Delphine', lastName: lastName('Dhd') },
};
const ids = {};

describe('Clients / Groups', () => {
  before(() => {
    cy.login();
    cy.ensurePermissiveTaskGroup();
    Object.entries(people).forEach(([key, person]) => {
      seedIndividual(person).then((uuid) => { ids[key] = uuid; });
    });
    cy.then(() => {
      seedGroup(codes.main, [
        { uuid: ids.head, role: 'HEAD', recipientType: 'PRIMARY' },
        { uuid: ids.child, role: 'SON' },
      ]).then((uuid) => { ids.mainGroup = uuid; });
      seedGroup(codes.tasks, [
        { uuid: ids.taskHead, role: 'HEAD', recipientType: 'PRIMARY' },
        { uuid: ids.taskMember, role: 'SPOUSE' },
      ]).then((uuid) => { ids.taskGroup = uuid; });
      seedGroup(codes.remove, [{ uuid: ids.removeHead, role: 'HEAD', recipientType: 'PRIMARY' }])
        .then((uuid) => { ids.removeGroup = uuid; });
    });
    // Group tasks: one approved member update, then one pending.
    cy.then(() => groupMembers(ids.taskGroup)).then((members) => {
      const [first, second] = members;
      editMember(ids.taskGroup, first, { recipientType: first.recipientType === 'PRIMARY' ? 'PRIMARY' : 'SECONDARY' });
      approveTaskApi(first.uuid);
      pollUntil(() => tasksOf(first.uuid), (tasks) => tasks[0]?.status === 'COMPLETED', 'member update approved');
      editMember(ids.taskGroup, second, { recipientType: 'SECONDARY' });
    });
    // Change log: one more version of the main group.
    cy.then(() => mutateOk('updateGroup', `id: "${ids.mainGroup}" code: "${codes.main}"`));
  });

  beforeEach(() => {
    cy.login();
  });

  it('Lists groups with columns and actions (OCM-1146)', () => {
    cy.visit('/front/groups');
    cy.contains('Groups');
    cy.contains(/(\d+) Groups Found/, { timeout: TIMEOUTS.BACKEND_VALIDATION })
      .invoke('text')
      .then((text) => expect(countIn(text, 'Groups')).to.be.at.least(1));
    cy.contains('th', 'Code');
    cy.contains('th', 'Head');
    // The delete action is checked on a spec-seeded group, not whichever row sorts first.
    searchGroups('Code', codes.main);
    cy.contains('table tbody tr', codes.main)
      .find(':is([title="Delete"],[aria-label="Delete"])')
      .should('exist');
    cy.contains('DOWNLOAD');
    cy.contains('ENROLLMENT');
    cy.contains('button', 'Advanced Filters');
  });

  it('Opens a group and searches its members (OCM-1147)', () => {
    searchGroups('Code', codes.main);
    cy.contains(/(?<!\d)1 Groups Found/);
    cy.openRowByValue(codes.main);
    cy.url().should('include', `/groups/group/${ids.mainGroup}`);
    cy.contains('General information');
    ['MEMBERS', 'PROGRAMS', 'Change Log', 'Benefits', 'Tasks'].forEach((tab) => cy.contains('button[role="tab"]', tab, { matchCase: false }));

    openTab('MEMBERS');
    ['First Name', 'Last Name', 'Day of birth'].forEach((label) => cy.contains('label', label));
    cy.contains('th', 'Role');
    cy.contains('th', 'Recipient Type');
    cy.contains('tr', people.head.lastName);
    cy.contains('tr', people.child.lastName);

    cy.enterMuiInput('First Name', people.child.firstName);
    cy.contains('button', 'Search').click();
    cy.waitForSearcherLoaded();
    tableRows().should('have.length', 1).and('contain', people.child.lastName);
  });

  it('Shows the group history of an individual (OCM-1143)', () => {
    cy.visit(`/front/individuals/individual/${ids.child}`);
    cy.contains('General Information');
    openTab('Group History');
    cy.get('button:visible').contains('Search').click();
    ['ID', 'Joining Date', 'Role', 'Status Of Membership'].forEach((header) => cy.contains('th:visible', header));
    cy.contains('tr:visible', 'SON', { timeout: TIMEOUTS.BACKEND_VALIDATION });
    cy.contains(/[1-9]\d* Historical Records Found/, { timeout: TIMEOUTS.BACKEND_VALIDATION });
  });

  it('Filters the change log of a group (OCM-1145)', () => {
    const yesterday = new Date(Date.now() - 86400000);
    cy.visit(`/front/groups/group/${ids.mainGroup}`);
    cy.contains('General information');
    // The searcher rebuilds its filter pane on each fetch (OP-3273): act only once the
    // history request of the previous step has come back.
    cy.intercept('POST', '**/api/graphql', (req) => {
      if (/History\(/.test(JSON.stringify(req.body))) req.alias = 'history';
    });
    openTab('Change Log');
    cy.wait('@history');
    cy.contains(/(\d+) Historical Records Found/, { timeout: TIMEOUTS.BACKEND_VALIDATION });
    ['Primary Recipient', 'Head', 'Secondary Recipient', 'Location', 'Date Updated', 'Version', 'Members', 'Changed by']
      .forEach((header) => cy.contains('th', header));
    tableRows().should('have.length.at.least', 2);

    cy.enterMuiInput('Head', people.head.lastName);
    cy.contains('button', 'Search').click();
    cy.wait('@history');
    cy.waitForSearcherLoaded();
    tableRows().should(($rows) => {
      expect($rows.length).to.be.above(0);
      $rows.toArray().forEach((tr) => expect(tr.innerText).to.contain(people.head.lastName));
    });

    cy.contains('button', /Reset/).click();
    cy.wait('@history');
    pickDate('Date updated after', yesterday);
    cy.contains('button', 'Search').click();
    cy.wait('@history').its('request.body').then((body) => expect(JSON.stringify(body), 'date filter sent').to.contain('dateUpdated_Gte'));
    cy.waitForSearcherLoaded();
    tableRows().should('have.length.at.least', 2);

    cy.contains('button', /Reset/).click();
    cy.wait('@history');
    pickDate('Date updated before', yesterday);
    cy.contains('button', 'Search').click();
    cy.wait('@history').its('request.body').then((body) => expect(JSON.stringify(body), 'date filter sent').to.contain('dateUpdated_Lte'));
    cy.contains('0 Historical Records Found', { timeout: TIMEOUTS.BACKEND_VALIDATION });

    cy.contains('button', /Reset/).click();
    cy.wait('@history');
    cy.contains('button', 'Search').click();
    cy.waitForSearcherLoaded();
    tableRows().should('have.length.at.least', 2);
  });

  it('Filters the tasks of a group and opens one (OCM-1144)', () => {
    // OP-3274: opened before the members load, the tab queried every task (entityIds: [])
    // and never corrected itself. Hold the members back so the tab opens first.
    const taskQueries = [];
    cy.intercept('POST', '**/api/graphql', (req) => {
      const query = typeof req.body?.query === 'string' ? req.body.query : '';
      if (query.includes('groupIndividual(')) req.on('response', (res) => res.setDelay(1500));
      if (/\btask\(/.test(query)) taskQueries.push(query);
    });
    cy.visit(`/front/groups/group/${ids.taskGroup}`);
    cy.contains('General information');
    openTab('Tasks');
    cy.contains('2 Tasks Found', { timeout: TIMEOUTS.BACKEND_VALIDATION });
    cy.wrap(taskQueries).should((queries) => {
      expect(queries, 'task queries').to.not.be.empty;
      expect(queries.filter((q) => /entityIds:\s*\[\s*\]/.test(q)), 'task queries with no entity').to.be.empty;
    });
    ['Source', 'Type', 'Entity', 'Task Group', 'Date Created', 'Status'].forEach((header) => cy.contains('th', header));

    cy.chooseMuiSelect('Status', 'COMPLETED');
    cy.contains('button', 'Search').click();
    cy.contains('1 Tasks Found', { timeout: TIMEOUTS.BACKEND_VALIDATION });
    tableRows().should('have.length', 1).and('contain', 'COMPLETED');

    cy.contains('button', /Reset/).click();
    cy.contains('2 Tasks Found', { timeout: TIMEOUTS.BACKEND_VALIDATION });
    cy.chooseMuiSelect('Task Group', 'any');
    cy.contains('button', 'Search').click();
    cy.contains('1 Tasks Found', { timeout: TIMEOUTS.BACKEND_VALIDATION });
    tableRows().should('have.length', 1).and('contain', 'any');

    cy.contains('button', /Reset/).click();
    cy.contains('2 Tasks Found', { timeout: TIMEOUTS.BACKEND_VALIDATION });
    tableRows().first().find('button:is([title="View details"],[aria-label="View details"])').click({ force: true });
    cy.url().should('include', '/tasks/task/');
  });

  it('Deletes a group after the deletion task is approved (OCM-1149)', () => {
    searchGroups('Code', codes.remove);
    cy.contains(/(?<!\d)1 Groups Found/);

    cy.openRowAction(codes.remove, 'Delete');
    cy.contains('[role="dialog"]', `Delete ${ids.removeGroup}?`).contains('button', 'Cancel').click();
    cy.get('[role="dialog"]').should('not.exist');
    tableRows().should('have.length', 1);

    cy.openRowAction(codes.remove, 'Delete');
    cy.contains('[role="dialog"]', `Delete ${ids.removeGroup}?`).contains('button', /^Ok$/i).click();
    cy.contains('[role="dialog"]', 'Deletion request submitted').find('button').first().click();
    cy.waitForJournalProgress();

    // OP-3279: the group page tells about the pending deletion task.
    cy.visit(`/front/groups/group/${ids.removeGroup}`);
    cy.contains('.MuiChip-root', '1 pending task', { timeout: TIMEOUTS.BACKEND_VALIDATION }).should('be.visible');

    openAndAssignTask(ids.removeGroup);
    fabWithIcon('check').first().should('not.be.disabled').click();
    cy.contains('[role="dialog"] button', 'Ok').click();
    cy.waitForJournalProgress();
    pollUntil(
      () => gql(`{ group(code_Iexact: "${codes.remove}", isDeleted: false) { totalCount } }`).then((d) => d.group.totalCount),
      (count) => count === 0,
      'group deleted',
    );

    searchGroups('Code', codes.remove);
    cy.contains(/(?<!\d)0 Groups Found/);
    // The group is soft-deleted, not purged. The groups list has no 'Show Deleted' filter
    // (unlike the individuals list), so this is checked through the API.
    gql(`{ group(code_Iexact: "${codes.remove}", isDeleted: true) { totalCount } }`)
      .then((d) => expect(d.group.totalCount, 'soft-deleted group').to.eq(1));
  });

  it('Downloads the groups list (OCM-1150)', () => {
    cy.visit('/front/groups');
    cy.contains(/(\d+) Groups Found/, { timeout: TIMEOUTS.BACKEND_VALIDATION })
      .invoke('text')
      .then((text) => countIn(text, 'Groups'))
      .as('total');
    downloadCsv().then(({ columns, lines }) => {
      expect(columns.map((c) => c.toLowerCase())).to.include('id');
      cy.get('@total').then((total) => expect(lines.length, 'exported groups').to.eq(total));
    });
  });

  it('Downloads the filtered groups only (OCM-1151)', () => {
    searchGroups('Code', codes.main);
    cy.contains(/(?<!\d)1 Groups Found/);
    downloadCsv().then(({ columns, lines }) => {
      expect(lines, 'exported groups').to.have.length(1);
      const idIdx = columns.findIndex((c) => c.toLowerCase() === 'id');
      expect(lines[0].split(',')[idIdx]).to.contain(ids.mainGroup);
    });
  });

  it('Paginates the groups list (OCM-1152)', () => {
    cy.visit('/front/groups');
    cy.contains(/(\d+) Groups Found/, { timeout: TIMEOUTS.BACKEND_VALIDATION })
      .invoke('text')
      .then((text) => countIn(text, 'Groups'))
      .as('total');
    tableRows().should('have.length', 10);

    const chooseRowsPerPage = (n) => {
      cy.get('.MuiTablePagination-select').first().click();
      cy.contains('[role="listbox"] li', new RegExp(`^${n}$`)).click();
    };
    chooseRowsPerPage(100);
    cy.get('@total').then((total) => tableRows().should('have.length', Math.min(100, total)));
    chooseRowsPerPage(20);
    tableRows().should('have.length', 20);
  });
});
