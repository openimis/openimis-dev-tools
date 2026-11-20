// UAT "Clients / Individual- / Individuals": list, upload, edit with maker-checker,
// change log, tasks, export, pagination and advanced filters of /front/individuals.
//
// Maker-checker is on (pinned configuration): updates and deletions of an individual
// create an IndividualService task that an executor of the 'any' task group resolves.
// The data each case needs is seeded through the GraphQL API with run-unique names;
// tasks that are only a precondition are approved through the API as well.
import { TIMEOUTS } from '../support/constants';

const runId = Date.now().toString(36).slice(-5).toUpperCase();
// Names are letters only: the individual import rejects digits in names on some schemas.
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

// Sends a mutation and waits until it is processed; yields { status, error }.
const mutate = (name, input, label = `UAT clients ${name}`) => {
  const clientMutationId = uuidv4();
  return gql(`mutation { ${name}(input: { clientMutationId: "${clientMutationId}" clientMutationLabel: "${label}" ${input} }) { clientMutationId } }`)
    .then(() => cy.waitForMutationLog(clientMutationId));
};

const mutateOk = (name, input, label) => mutate(name, input, label).then(({ status, error }) => {
  expect(status, `${name}: ${error}`).to.eq(2);
});

const gqlJson = (obj) => JSON.stringify(JSON.stringify(obj));

const seedIndividual = ({ firstName, lastName: last, dob = '1990-05-17', ext = {} }) => {
  mutateOk(
    'createIndividual',
    `firstName: "${firstName}" lastName: "${last}" dob: "${dob}" jsonExt: ${gqlJson(ext)}`,
  );
  return gql(`{ individual(lastName_Iexact: "${last}", firstName_Iexact: "${firstName}") { edges { node { uuid } } } }`)
    .then((data) => {
      const uuid = data.individual.edges[0]?.node.uuid;
      expect(uuid, `seeded individual ${firstName} ${last}`).to.be.a('string');
      return uuid;
    });
};

const fetchIndividual = (uuid, isDeleted = false) => gql(`{ individual(id: "${uuid}", isDeleted: ${isDeleted}) { edges { node { firstName lastName dob version isDeleted } } } }`)
  .then((data) => data.individual.edges[0]?.node);

const updateIndividualApi = (uuid, { firstName, lastName: last, dob }) => mutateOk(
  'updateIndividual',
  `id: "${uuid}" firstName: "${firstName}" lastName: "${last}" dob: "${dob}"`,
);

const tasksOf = (entityId) => gql(`{ task(entityId: "${entityId}") { edges { node { uuid status businessEvent taskGroup { code } } } } }`)
  .then((data) => data.task.edges.map((e) => e.node));

// Approves the pending task of an entity as Admin, through the API (precondition only).
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

// Polls until `check(value)` is true for the value yielded by `fetch()`.
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
const tableRows = () => cy.get('table tbody tr');

const searchIndividuals = (label, value) => {
  cy.visit('/front/individuals');
  cy.contains(/\d+ Individuals Found/, { timeout: TIMEOUTS.BACKEND_VALIDATION });
  cy.enterMuiInput(label, value);
  cy.contains('button', 'Search').click();
  cy.waitForSearcherLoaded();
};

const openTab = (label) => cy.contains('button[role="tab"]', label, { matchCase: false }).click();

// Replaces the value of a text input of the individual form. The form resets its
// inputs when a late fetch of the individual completes (the typed text was lost or
// appended to the old value), so type over the value until it holds.
const formInput = (label) => cy.contains('label', label, { matchCase: false }).siblings('.MuiInputBase-root').find('input').first();
const setInput = (label, value, attempt = 1) => {
  formInput(label).type(`{selectall}${value}`, { force: true, delay: 0 }).blur({ force: true });
  // eslint-disable-next-line cypress/no-unnecessary-waiting
  cy.wait(1000);
  formInput(label).then(($input) => {
    if ($input.val() === value) return;
    if (attempt >= 4) throw new Error(`${label} kept "${$input.val()}" instead of "${value}"`);
    setInput(label, value, attempt + 1);
  });
};
const expectInput = (label, value) => formInput(label).should('have.value', value);
// Text filter of the searcher in the open tab (the form above has the same labels).
const setTabFilter = (label, value) => {
  cy.get('label').filter((_, l) => l.textContent.replace(/\*/g, '').trim() === label).last()
    .siblings('.MuiInputBase-root').find('input')
    .type(`{selectall}${value}`, { force: true, delay: 0 });
};
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



// Picks an option of a select or autocomplete of the open dialog by its label.
const chooseInDialog = (label, option) => {
  cy.get('[role="dialog"]').contains('label', label).siblings('.MuiInputBase-root')
    .find('[role="combobox"], input').first().click({ force: true });
  cy.contains('[role="listbox"] li, li[role="option"]', option).click({ force: true });
};

// Rows of the current results all satisfy `check` (retried until the search applies).
const everyRow = (check, message) => tableRows().should(($rows) => {
  expect($rows.length, 'rows').to.be.above(0);
  $rows.toArray().forEach((tr) => expect(check(tr.innerText), `${message}: ${tr.innerText}`).to.be.true);
});

// The coreAlert dialog shown after a save or deletion request.
const assertAlert = (title, message) => {
  cy.contains('[role="dialog"]', title).within(() => {
    cy.contains(message);
    cy.get('button').first().click();
  });
};

// A FAB identified by its Material Symbols icon name ('check', 'clear').
const fabWithIcon = (icon) => cy.get('button.MuiFab-root').filter((_, b) => (
  [...b.querySelectorAll('[class*="material-symbols"]')].some((s) => s.textContent.trim() === icon)
));

// Opens the task matching all `texts` from Tasks Management > All tasks (filtered by
// Entity = `entity`), assigns it to the 'any' group and saves.
const openAndAssignTask = (entity, texts = []) => {
  const all = [entity, ...texts];
  const findRow = (attempt = 1) => {
    cy.visit('/front/AllTasks');
    cy.contains('Tasks Found', { timeout: TIMEOUTS.BACKEND_VALIDATION });
    cy.enterMuiInput('Entity', entity);
    cy.contains('button', 'Search').click();
    cy.waitForSearcherLoaded();
    cy.get('body').then(($body) => {
      const found = $body.find('table tbody tr').toArray().some((tr) => all.every((t) => tr.innerText.includes(t)));
      if (found) return;
      if (attempt >= 6) throw new Error(`No task row with ${JSON.stringify(all)}`);
      // eslint-disable-next-line cypress/no-unnecessary-waiting
      cy.wait(5000).then(() => findRow(attempt + 1));
    });
  };
  findRow();
  cy.get('table tbody tr')
    .filter((_, tr) => all.every((t) => tr.innerText.includes(t)))
    .first()
    .find('button:is([title="View details"],[aria-label="View details"])')
    .click({ force: true });
  cy.url({ timeout: TIMEOUTS.BACKEND_VALIDATION }).should('include', '/tasks/task/');
  cy.chooseMuiAutocomplete('Assigned to', 'any');
  // The picked option reads "Group · any — ANY".
  cy.contains('label', 'Assigned to').siblings('.MuiInputBase-root').find('input').invoke('val').should('match', /\bany\b/);
  cy.clickSave();
  cy.waitForJournalProgress();
};

// ------------------ DATA ------------------
const people = {
  edit: { firstName: 'Edwina', lastName: lastName('Edit'), dob: '1985-03-12' },
  reject: { firstName: 'Rosalind', lastName: lastName('Rej'), dob: '1979-07-01' },
  pending: { firstName: 'Percival', lastName: lastName('Pend'), dob: '1991-11-23' },
  remove: { firstName: 'Dorian', lastName: lastName('Del'), dob: '1988-02-14' },
  audited: { firstName: 'Augusta', lastName: lastName('Aud'), dob: '1975-09-30' },
};
// Spec-seeded individuals (run-unique names, no location): the edit, reject and delete
// cases do not need a location, so coherence does not apply. The unfiltered list and
// the pagination case rely on the baseline individuals upload (>=120 people; villages
// r1d1m1v1, r1d1m1v2, r1d1m2v1, r1d1m3v1 in district r1d1 and r1d2m1v1, r1d2m1v2 in
// district r1d2, plus people with no location), not on demo records.
// Three individuals sharing a first-name prefix, for filters and the filtered export.
const filterPrefix = `Flt${runTag}`;
const filtered = [
  { firstName: `${filterPrefix}a`, lastName: lastName('Flt'), ext: { number_of_children: 1 } },
  { firstName: `${filterPrefix}b`, lastName: lastName('Flt'), ext: { number_of_children: 2 } },
  { firstName: `${filterPrefix}c`, lastName: lastName('Flt'), ext: { number_of_children: 5 } },
];
const ids = {};

describe('Clients / Individuals', () => {
  before(() => {
    cy.login();
    cy.ensurePermissiveTaskGroup();
    Object.entries(people).forEach(([key, person]) => {
      seedIndividual(person).then((uuid) => { ids[key] = uuid; });
    });
    filtered.forEach((person) => seedIndividual(person));
    // Change log and task history: one approved update, then one pending update.
    cy.then(() => {
      updateIndividualApi(ids.audited, { ...people.audited, firstName: 'Augustina' });
      approveTaskApi(ids.audited);
      pollUntil(() => fetchIndividual(ids.audited), (i) => i?.firstName === 'Augustina', 'approved update of the audited individual');
      updateIndividualApi(ids.audited, { ...people.audited, firstName: 'Augustina', lastName: `${people.audited.lastName}x` });
    });
  });

  beforeEach(() => {
    cy.login();
  });

  it('Lists individuals with columns, filters and actions (OCM-1129)', () => {
    cy.visit('/front/individuals');
    cy.contains(/Individuals/);
    cy.contains(/(\d+) Individuals Found/, { timeout: TIMEOUTS.BACKEND_VALIDATION })
      .invoke('text')
      .then((text) => expect(Number(text.match(/(\d+) Individuals Found/)[1])).to.be.at.least(1));

    ['First Name', 'Last Name', 'Day of birth'].forEach((header) => cy.contains('th', header));
    // Actions are checked on a spec-seeded row, not whichever record sorts first.
    cy.enterMuiInput('Last Name', people.reject.lastName);
    cy.contains('button', 'Search').click();
    cy.waitForSearcherLoaded();
    cy.contains('table tbody tr', people.reject.lastName).within(() => {
      cy.get(':is([title="Edit"],[aria-label="Edit"])').should('exist');
      cy.get(':is([title="Delete"],[aria-label="Delete"])').should('exist');
    });

    cy.contains('label', 'First Name');
    cy.contains('label', 'Last Name');
    cy.contains('Show Deleted');
    cy.contains('Missing Location');
    cy.contains('button', 'Search');
    cy.contains('button', /Reset/);
    cy.contains('button', 'Advanced Filters');
    ['DOWNLOAD', 'ENROLLMENT', 'UPLOAD', 'UPLOAD HISTORY'].forEach((action) => cy.contains(action));
  });

  it('Uploads individuals and imports them once the task is approved (OCM-1128)', () => {
    const uploadLast = lastName('Upl');
    const fileBase = `uatcli${runId.toLowerCase()}`;
    const header = 'first_name,last_name,dob,group_code,recipient_info,individual_role,location_name,location_code,able_bodied,educated_level,number_of_children';
    const rows = ['Ulla', 'Ursula', 'Umberto'].map((first, i) => `${first},${uploadLast},198${i}-04-1${i},,,,,,True,primary,${i}`);
    const csv = [header, ...rows].join('\n');

    cy.visit('/front/individuals');
    cy.contains(/\d+ Individuals Found/, { timeout: TIMEOUTS.BACKEND_VALIDATION });
    cy.contains('li', /^UPLOAD$/).click();
    cy.contains('[role="dialog"]', 'Upload Individuals').within(() => {
      cy.get('input[type="file"]').should('exist');
      cy.contains('label', 'Workflow');
      cy.contains('button', 'Cancel');
      cy.contains('button', 'Template');
      cy.contains('button', 'Upload Individuals');
    });

    // Template: the individual columns plus the fields of the individual schema.
    cy.intercept('GET', '**/individual/download_template_file/**').as('template');
    cy.contains('button', 'Template').click();
    cy.wait('@template').then(({ response }) => {
      const firstLine = String(response.body).split(/\r?\n/)[0];
      ['first_name', 'last_name', 'dob', 'location_name', 'location_code', 'id', 'number_of_children']
        .forEach((col) => expect(firstLine, 'template header').to.contain(col));
    });

    cy.get('[role="dialog"] input[type="file"]').selectFile(
      { contents: Cypress.Buffer.from(csv), fileName: `${fileBase}.csv`, mimeType: 'text/csv' },
      { force: true },
    );
    cy.chooseMuiSelect('Workflow', 'Python Import Individuals');
    cy.contains('button', 'Upload Individuals').should('not.be.disabled').click();
    assertAlert('Upload successful', 'sent to the task group for approval');

    cy.contains('li', 'UPLOAD HISTORY').click();
    cy.contains('[role="dialog"]', 'Upload History Table').within(() => {
      cy.contains('tr', fileBase, { timeout: TIMEOUTS.BACKEND_VALIDATION }).should('contain', 'Python Import Individuals');
      cy.get('button').last().click({ force: true });
    });

    // Maker-checker: approve the import task ("Accept All" of the upload panel).
    openAndAssignTask(fileBase);
    fabWithIcon('check').last().should('not.be.disabled').click();
    cy.contains('[role="dialog"] button', 'Continue').click();
    // The resolution is followed through the imported rows (the mutation tracker does
    // not see this panel's mutation).
    pollUntil(
      () => gql(`{ individual(lastName_Iexact: "${uploadLast}", isDeleted: false) { totalCount } }`).then((d) => d.individual.totalCount),
      (count) => count === rows.length,
      `${rows.length} imported individuals named ${uploadLast}`,
      { tries: 60 },
    );
    searchIndividuals('Last Name', uploadLast);
    cy.contains(`${rows.length} Individuals Found`);
  });

  it('Edits an individual; the change applies once the update task is approved (OCM-1130, OCM-1136)', () => {
    const person = people.edit;
    const changed = { firstName: 'Edmonda', lastName: `${person.lastName}n`, dob: { day: 20, month: 6, year: 1986 } };

    searchIndividuals('Last Name', person.lastName);
    cy.openRowByValue(person.lastName);
    cy.url().should('include', `/individuals/individual/${ids.edit}`);
    cy.contains('General Information');
    // Location: the location levels down to the village.
    ['First Name', 'Last Name', 'Day of birth', 'Region', 'Village'].forEach((label) => cy.contains('label', label));

    openTab('PROGRAMS');
    cy.contains(/\d+ Programs? Found|Programs/i);

    setInput('First Name', changed.firstName);
    setInput('Last Name', changed.lastName);
    cy.chooseMuiDatePicker('Day of birth', changed.dob);
    cy.clickSave('Save changes');
    assertAlert('Success', 'Record updated successfully and sent to the task group for approval.');
    cy.waitForJournalProgress();

    // Pending approval: the stored values are unchanged.
    cy.reload();
    expectInput('First Name', person.firstName);
    expectInput('Last Name', person.lastName);

    tasksOf(ids.edit).then((tasks) => {
      expect(tasks.map((t) => `${t.businessEvent}:${t.status}`)).to.deep.eq(['IndividualService.update:RECEIVED']);
    });

    // Data update module: the task shows the new value, the approver resolves it.
    openAndAssignTask(`${person.firstName} ${person.lastName}`, ['IndividualService']);
    cy.contains(changed.lastName);
    fabWithIcon('check').first().should('not.be.disabled').click();
    cy.contains('[role="dialog"] button', 'Ok').click();
    cy.waitForJournalProgress();
    pollUntil(() => tasksOf(ids.edit), (tasks) => tasks[0]?.status === 'COMPLETED', 'update task COMPLETED');

    cy.visit(`/front/individuals/individual/${ids.edit}`);
    expectInput('First Name', changed.firstName);
    expectInput('Last Name', changed.lastName);
    cy.verifyMuiDatePickerValue('Day of birth', '20-06-1986');
    openTab('Change Log');
    cy.contains(/(\d+) Historical Records Found/, { timeout: TIMEOUTS.BACKEND_VALIDATION })
      .invoke('text')
      .then((text) => expect(Number(text.match(/(\d+) Historical/)[1])).to.be.at.least(2));
  });

  it('Rejects an individual update task; the individual keeps its data (OCM-1137)', () => {
    const person = people.reject;
    cy.visit(`/front/individuals/individual/${ids.reject}`);
    cy.contains('General Information');
    setInput('First Name', 'Rejected');
    cy.clickSave('Save changes');
    assertAlert('Success', 'sent to the task group for approval.');
    cy.waitForJournalProgress();

    openAndAssignTask(`${person.firstName} ${person.lastName}`, ['IndividualService']);
    fabWithIcon('clear').first().should('not.be.disabled').click();
    cy.contains('[role="dialog"]', 'fail this task').contains('button', 'Ok').click();
    cy.waitForJournalProgress();
    pollUntil(() => tasksOf(ids.reject), (tasks) => tasks[0]?.status === 'FAILED', 'update task FAILED');

    cy.visit(`/front/individuals/individual/${ids.reject}`);
    expectInput('First Name', person.firstName);
  });

  it('Refuses a second update while an update task is pending (OCM-1138)', () => {
    const person = people.pending;
    cy.visit(`/front/individuals/individual/${ids.pending}`);
    cy.contains('General Information');
    setInput('Last Name', `${person.lastName}x`);
    cy.clickSave('Save changes');
    assertAlert('Success', 'sent to the task group for approval.');
    cy.waitForJournalProgress();

    cy.reload();
    cy.contains('General Information');
    // OP-3279: the page tells about the pending task before anything is submitted.
    cy.contains('.MuiChip-root', '1 pending task', { timeout: TIMEOUTS.BACKEND_VALIDATION }).should('be.visible');
    setInput('First Name', 'Peregrin');
    cy.clickSave('Save changes');
    cy.contains('[role="dialog"]', 'Update not submitted')
      .should('contain', 'Another task is pending')
      .find('button')
      .first()
      .click();

    openTab('Tasks');
    cy.contains('1 Tasks Found', { timeout: TIMEOUTS.BACKEND_VALIDATION });
    tasksOf(ids.pending).then((tasks) => expect(tasks.filter((t) => t.status === 'RECEIVED')).to.have.length(1));

    // OP-3279: for a user who may search tasks, the count opens the tasks of this individual.
    cy.contains('.MuiChip-root', '1 pending task').click();
    cy.location('pathname').should('eq', '/front/allTasks');
    cy.location('search').should('eq', `?entityIds=${ids.pending}`);
    cy.contains('1 Tasks Found', { timeout: TIMEOUTS.BACKEND_VALIDATION });
  });

  it('Filters the change log of an individual (OCM-1139)', () => {
    const yesterday = new Date(Date.now() - 86400000);
    cy.visit(`/front/individuals/individual/${ids.audited}`);
    cy.contains('General Information');
    // The searcher rebuilds its filter pane on each fetch (OP-3273): act only once the
    // history request of the previous step has come back.
    cy.intercept('POST', '**/api/graphql', (req) => {
      if (/History\(/.test(JSON.stringify(req.body))) req.alias = 'history';
    });
    openTab('Change Log');
    cy.wait('@history');
    cy.contains(/(\d+) Historical Records Found/, { timeout: TIMEOUTS.BACKEND_VALIDATION });
    ['First Name', 'Last Name', 'Day of birth', 'Location', 'Date Updated', 'Version', 'Additional fields', 'Changed by']
      .forEach((header) => cy.contains('th', header));
    tableRows().should('have.length.at.least', 2);

    // The first version had the old first name only.
    setTabFilter('First Name', people.audited.firstName);
    cy.contains('button', 'Search').click();
    cy.wait('@history');
    everyRow((text) => text.includes(people.audited.firstName) && !text.includes('Augustina'), 'old first name only');

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

  it('Filters the tasks of an individual and opens one (OCM-1140)', () => {
    cy.visit(`/front/individuals/individual/${ids.audited}`);
    cy.contains('General Information');
    openTab('Tasks');
    cy.contains('2 Tasks Found', { timeout: TIMEOUTS.BACKEND_VALIDATION });
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
    cy.contains('General Information');
  });

  it('Deletes an individual after the deletion task is approved (OCM-1132)', () => {
    const person = people.remove;
    searchIndividuals('Last Name', person.lastName);
    cy.contains(/(?<!\d)1 Individuals Found/);

    cy.openRowAction(person.lastName, 'Delete');
    cy.contains('[role="dialog"]', `Delete ${person.firstName} ${person.lastName}?`).contains('button', 'Cancel').click();
    cy.get('[role="dialog"]').should('not.exist');
    tableRows().should('have.length', 1);

    cy.openRowAction(person.lastName, 'Delete');
    cy.contains('[role="dialog"]', `Delete ${person.firstName} ${person.lastName}?`).contains('button', /^Ok$/i).click();
    assertAlert('Deletion request submitted', 'Deletion request submitted and sent to the task group for approval.');
    cy.waitForJournalProgress();
    cy.get('td.tableLockedCell, td.tableDisabledCell').should('exist');

    openAndAssignTask(`${person.firstName} ${person.lastName}`, ['IndividualService']);
    fabWithIcon('check').first().should('not.be.disabled').click();
    cy.contains('[role="dialog"] button', 'Ok').click();
    cy.waitForJournalProgress();
    pollUntil(() => fetchIndividual(ids.remove, true), (i) => i?.isDeleted === true, 'individual deleted');

    searchIndividuals('Last Name', person.lastName);
    cy.contains(/(?<!\d)0 Individuals Found/);
    cy.toggleMuiCheckbox('isDeleted', true);
    cy.contains('button', 'Search').click();
    cy.contains('1 Individuals Found', { timeout: TIMEOUTS.BACKEND_VALIDATION });
    cy.get(':is([title="Undo Delete"],[aria-label="Undo Delete"])').should('exist');
  });

  it('Exports the individuals with the chosen columns (OCM-1133)', () => {
    cy.visit('/front/individuals');
    cy.contains(/(\d+) Individuals Found/, { timeout: TIMEOUTS.BACKEND_VALIDATION })
      .invoke('text')
      .then((text) => Number(text.match(/(\d+) Individuals Found/)[1]))
      .as('total');

    cy.intercept('GET', '**/core/fetch_export*').as('export');
    cy.contains('DOWNLOAD').click();
    cy.contains('[role="dialog"]', 'Export configuration').within(() => {
      cy.contains('Select columns you want to export');
      cy.contains('label', 'date_of_birth').find('input[type="checkbox"]').uncheck({ force: true });
      cy.contains('button', /^Ok$/i).click();
    });
    cy.wait('@export', { timeout: 60000 }).then(({ response }) => {
      const [head, ...lines] = String(response.body).trim().split(/\r?\n/);
      expect(head).to.contain('first_name');
      expect(head).not.to.contain('date_of_birth');
      cy.get('@total').then((total) => expect(lines.length, 'exported rows').to.eq(total));
    });
  });

  it('Exports the filtered individuals only (OCM-1134)', () => {
    searchIndividuals('First Name', filterPrefix);
    cy.contains(`${filtered.length} Individuals Found`);

    cy.intercept('GET', '**/core/fetch_export*').as('export');
    cy.contains('DOWNLOAD').click();
    cy.contains('[role="dialog"]', 'Export configuration').contains('button', /^Ok$/i).click();
    cy.wait('@export', { timeout: 60000 }).then(({ response }) => {
      const [head, ...lines] = String(response.body).trim().split(/\r?\n/);
      const firstNameIdx = head.split(',').findIndex((c) => c.replace(/"/g, '') === 'first_name');
      expect(firstNameIdx, 'first_name column').to.be.at.least(0);
      expect(lines, 'exported rows').to.have.length(filtered.length);
      lines.forEach((line) => expect(line.split(',')[firstNameIdx]).to.contain(filterPrefix));
    });
  });

  it('Paginates the individuals list (OCM-1135)', () => {
    cy.visit('/front/individuals');
    cy.contains(/(\d+) Individuals Found/, { timeout: TIMEOUTS.BACKEND_VALIDATION })
      .invoke('text')
      .then((text) => Number(text.match(/(\d+) Individuals Found/)[1]))
      .as('total');
    tableRows().should('have.length', 10);

    const chooseRowsPerPage = (n) => {
      cy.get('.MuiTablePagination-select').first().click();
      cy.contains('[role="listbox"] li', new RegExp(`^${n}$`)).click();
    };
    chooseRowsPerPage(100);
    cy.get('@total').then((total) => {
      const shown = Math.min(100, total);
      tableRows().should('have.length', shown);
      cy.contains('.MuiTablePagination-displayedRows', `1-${shown} of ${total}`);
    });

    chooseRowsPerPage(20);
    tableRows().should('have.length', 20);
    cy.get('.MuiTablePagination-actions button').last().click();
    cy.get('@total').then((total) => cy.contains('.MuiTablePagination-displayedRows', `21-40 of ${total}`));
    tableRows().should('have.length', 20);
  });

  it('Filters individuals with advanced criteria (OCM-1141)', () => {
    searchIndividuals('First Name', filterPrefix);
    cy.contains(`${filtered.length} Individuals Found`);

    cy.contains('button', 'Advanced Filters').click();
    cy.get('[role="dialog"]').within(() => {
      cy.contains('label', 'Field');
      cy.contains('button', 'Add filter');
      cy.contains('button', 'Clear All Filters');
      cy.contains('button', 'Cancel');
    });
    chooseInDialog('Field', 'Number of children');
    chooseInDialog('Filter', 'Greater than or equal to');
    cy.get('[role="dialog"]').within(() => {
      cy.contains('label', 'Value').siblings('.MuiInputBase-root').find('input').clear().type('2');
      cy.contains('button', /^Filter$/).click();
    });
    cy.get('[role="dialog"]').should('not.exist');
    cy.contains('button', 'Search').click();

    cy.contains('2 Individuals Found', { timeout: TIMEOUTS.BACKEND_VALIDATION });
    cy.contains('tr', `${filterPrefix}b`);
    cy.contains('tr', `${filterPrefix}c`);
    cy.contains('tr', `${filterPrefix}a`).should('not.exist');
    // Badge with the number of applied advanced filters.
    cy.contains('button', 'Advanced Filters').parent().contains(/^1$/);

    cy.contains('button', 'Advanced Filters').click();
    cy.get('[role="dialog"]').within(() => {
      cy.contains('button', 'Clear All Filters').click();
      cy.contains('button', /^Filter$/).click();
    });
    cy.contains(`${filtered.length} Individuals Found`, { timeout: TIMEOUTS.BACKEND_VALIDATION });
  });

  // Partial: no payroll pays these individuals, so the filter by payroll name is not
  // automated; the tab, its summary and its searcher are.
  it('Shows the benefits tab of an individual (OCM-1142)', () => {
    cy.visit(`/front/individuals/individual/${ids.audited}`);
    cy.contains('General Information');
    openTab('Benefits');
    cy.contains(/Total Number Of Benefits/i);
    cy.contains(/Total Amount Due/i);
    cy.contains(/Total Amount Received/i);
    cy.contains(/\d+ Benefit Consumptions Found/, { timeout: TIMEOUTS.BACKEND_VALIDATION });
    cy.contains('label', 'Payroll Name');
  });
});
