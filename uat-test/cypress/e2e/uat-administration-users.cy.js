// Administration > Users (OCM-177, 178, 283, 284, 1153..1157), impersonation (OCM-1229)
// and password recovery (OCM-1127).
//
// The users created here have usernames and emails unique per run; the tests run in
// order (create, modify, delete) and after() deletes whatever is left through the API.
// Reads use the baseline, not the demo dataset. The interactive user and the enrolment
// officer are in district r1d1, coherent with municipality r1d1m1 (the officer panel
// must list it). The claim administrator is in district r1d2, coherent with the
// baseline hospital there. The location filter selects region r1 and its district
// r1d1 (the clerk is in r1d1; the hospital claim admin in r1d2 is not). Impersonation
// targets that hospital claim administrator. The last-name filter uses the clerk.
import { baseline } from '../support/baseline';

const runId = Date.now().toString(36).slice(-5).toLowerCase();
const USERS_URL = '/front/admin/users';
const TIMEOUT = 5000;

const users = {
  interactive: { username: `uat${runId}`, givenNames: 'Uat', lastName: `Tester${runId}`, email: `uat${runId}@example.org` },
  officer: { username: `uate${runId}`, givenNames: 'Uat', lastName: `Officer${runId}`, email: `uate${runId}@example.org` },
  claimAdmin: { username: `uatc${runId}`, givenNames: 'Uat', lastName: `ClaimAdm${runId}`, email: `uatc${runId}@example.org` },
};

const uuidv4 = () =>
  'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });

function gql(query) {
  return cy
    .request({ method: 'POST', url: '/api/graphql', body: { query }, log: false })
    .then(({ body }) => {
      if (body.errors?.length) throw new Error(`GraphQL error: ${JSON.stringify(body.errors)}`);
      return body.data;
    });
}

// Active users whose username is exactly the given one.
const activeUsers = (username) => gql(`{ users(username_Icontains: "${username}") { edges { node { id username } } } }`)
  .then((data) => data.users.edges.map((e) => e.node).filter((u) => u.username === username));

function deleteUserByApi(username) {
  activeUsers(username).then((found) => {
    found.forEach((user) => {
      const clientMutationId = uuidv4();
      const uuid = atob(user.id).split(':')[1];
      gql(`mutation { deleteUser(input: { clientMutationId: "${clientMutationId}" clientMutationLabel: "UAT cleanup - user ${username}" uuids: ["${uuid}"] }) { clientMutationId } }`)
        .then(() => cy.waitForMutationLog(clientMutationId));
    });
  });
}

const field = (label) => cy.contains('label', label, { matchCase: false, timeout: TIMEOUT })
  .siblings('.MuiInputBase-root')
  .find('input')
  .first();

const typeField = (label, value) => {
  field(label).clear({ force: true });
  field(label).type(value, { force: true, delay: 0 });
};

// The form FABs are icon-only (Material Symbols span); their tooltip key has no English text.
const fab = (icon) => cy.get('button.MuiFab-root', { timeout: TIMEOUT })
  .filter((_, b) => b.textContent.trim() === icon);

const parseCount = (text) => Number(text.match(/([\d,]+) user/)[1].replace(/,/g, ''));
const resultsTitle = () => cy.contains('.paperHeaderTitle, .tableTitle h6', /[\d,]+ user\(s\) found/, { timeout: TIMEOUT });
// Waits for a loaded, non-empty result list and yields its count.
const resultsCount = () => resultsTitle()
  .should(($title) => expect(parseCount($title.text()), 'users found').to.be.greaterThan(0))
  .then(($title) => parseCount($title.text()));

// Retries `check` on the count of the results title.
const countShould = (check) => resultsTitle().should(($title) => check(parseCount($title.text())));

// Counts the users list queries (the searcher sends them with totalCount), so a search
// waits for its own answer rather than for an earlier one.
const usersQueries = { sent: 0, done: 0 };
function trackUsersQueries() {
  cy.intercept('POST', '/api/graphql', (req) => {
    const query = req.body?.query;
    if (typeof query === 'string' && /\busers\(/.test(query) && query.includes('totalCount')) {
      usersQueries.sent += 1;
      req.continue(() => { usersQueries.done += 1; });
    }
  });
}

function clickAndAwaitUsers(buttonText) {
  cy.then(() => {
    const before = usersQueries.sent;
    cy.contains('button', buttonText).click({ force: true });
    cy.wrap(usersQueries, { timeout: TIMEOUT }).should((q) => {
      expect(q.sent, 'users query sent').to.be.greaterThan(before);
      expect(q.done, 'users query answered').to.eq(q.sent);
    });
  });
  cy.waitForSearcherLoaded();
}

const search = () => clickAndAwaitUsers('Search');
const resetFilters = () => clickAndAwaitUsers('Reset filters');

// Region is a Select, the other location levels may be Autocompletes.
function chooseLocationFilter(label, text) {
  cy.contains('label', label).siblings('.MuiInputBase-root').then(($box) => {
    if ($box.find('div[role="combobox"]').length) {
      cy.wrap($box).find('div[role="combobox"]').click();
      cy.contains('[role="listbox"] li', text, { timeout: TIMEOUT }).click({ force: true });
    } else {
      chooseAutocomplete(label, text);
    }
  });
}

const usernameCells = () => cy.get('table tbody tr td:first-child');

function openUsers() {
  cy.visit(USERS_URL);
  resultsCount();
}

function filterByUsername(username) {
  openUsers();
  typeField('User name', username);
  search();
}

// Picks an option of an Autocomplete after typing a search text, then closes the popup
// (a multiple one stays open, with a "Confirm" button).
function chooseAutocomplete(label, text, optionText = text) {
  field(label).should('not.be.disabled').click({ force: true });
  field(label).type(text, { force: true });
  cy.contains('[role="listbox"] li, li[role="option"]', optionText, { timeout: TIMEOUT }).click({ force: true });
  cy.get('body').then(($body) => {
    const $confirm = $body.find('.MuiAutocomplete-popper button').filter((_, b) => /confirm/i.test(b.textContent));
    if ($confirm.length) cy.wrap($confirm.first()).click({ force: true });
    else if ($body.find('.MuiAutocomplete-popper').length) field(label).type('{esc}', { force: true });
  });
  cy.get('.MuiAutocomplete-popper').should('not.exist');
}

// Fills the "Login Details" part shared by every new user.
function fillLoginDetails(user, { role, district = baseline().locations.r1d1.label } = {}) {
  typeField('User name', user.username);
  typeField('Given names', user.givenNames);
  typeField('Last name', user.lastName);
  typeField('Email', user.email);
  chooseAutocomplete('User role(s)', role);
  chooseAutocomplete('Districts', district);
  cy.chooseMuiSelect('Interface Language', 'English');
  cy.contains('button', 'Generate Password').click();
}

function openNewUser() {
  openUsers();
  cy.get(':is([title="Add new user"],[aria-label="Add new user"]) button').click();
  cy.location('pathname').should('include', '/admin/users/new');
  cy.contains('New User', { timeout: TIMEOUT });
}

// After a create the form stays locked on /new; its "replay" header button opens the
// saved user (UserForm.reload).
function saveNewUser() {
  fab('save').should('not.be.disabled').click();
  cy.waitForJournalProgress();
  cy.get('button').filter((_, b) => b.textContent.trim() === 'replay').first().click({ force: true });
  cy.location('pathname', { timeout: TIMEOUT }).should('match', /\/admin\/users\/overview\/.+/);
}

const panelOf = (title) => cy.contains('h6', title, { timeout: TIMEOUT }).closest('.MuiPaper-root');

describe('Administration / Users', () => {
  beforeEach(() => {
    trackUsersQueries();
    cy.login();
  });

  after(() => {
    cy.login();
    Object.values(users).forEach((u) => deleteUserByApi(u.username));
  });

  it('Lists users (OCM-1153)', () => {
    openUsers();
    ['User name', 'Other names', 'Last name', 'Email', 'Phone', 'Birth date'].forEach((header) => {
      cy.contains('table thead th', header);
    });
    typeField('User name', 'Admin');
    search();
    cy.contains('table tbody tr', /^\s*Admin\s*Admin\s*Admin/).within(() => {
      cy.get('td').eq(0).should('have.text', 'Admin');
      cy.get('td').eq(1).should('have.text', 'Admin');
      cy.get('td').eq(2).should('have.text', 'Admin');
    });
    cy.clickRowAction(/^\s*Admin\s*Admin/, 'Open');
    cy.get('body').type('{esc}');
  });

  it('Filters users by role (OCM-1154)', () => {
    openUsers();
    resultsCount().then((all) => {
      chooseAutocomplete('User role(s)', 'Claim Administrator');
      search();
      countShould((n) => expect(n).to.be.lessThan(all).and.greaterThan(0));
      // Every listed user has the role (checked against the roles the API reports).
      // One lookup per listed user: the users connection caps `first` at 100.
      usernameCells().should('have.length.greaterThan', 0).each(($td) => {
        const username = $td.text();
        gql(`{ users(username: ${JSON.stringify(username)}) { edges { node { iUser { roles { name } } } } } }`).then((data) => {
          const roles = (data.users.edges[0]?.node.iUser?.roles ?? []).map((r) => r.name);
          expect(roles, `roles of ${username}`).to.include('Claim Administrator');
        });
      });

      resetFilters();
      countShould((n) => expect(n).to.eq(all));
    });
  });

  it('Filters users by location, user name and last name (OCM-1155)', () => {
    openUsers();
    resultsCount().then((all) => {
      const B = baseline();
      chooseLocationFilter('Region', B.locations.r1.label);
      chooseLocationFilter('District', B.locations.r1d1.label);
      search();
      countShould((n) => expect(n).to.be.lessThan(all).and.greaterThan(0));

      resetFilters();
      countShould((n) => expect(n).to.eq(all));

      typeField('User name', 'Admin');
      search();
      usernameCells().should('have.length.greaterThan', 0)
        .each(($td) => expect($td.text().toLowerCase()).to.contain('admin'));

      resetFilters();
      const clerkLastName = baseline().users.clerk.lastName;
      typeField('Last name', clerkLastName);
      search();
      cy.get('table thead th').then(($ths) => {
        // Sortable headers also hold the sort icon's ligature text (e.g. "arrow_downward"),
        // so match the start of the label, and fail here rather than on .eq(-1).
        const lastNameColumn = $ths.toArray().findIndex((th) => th.textContent.trim().startsWith('Last name'));
        expect(lastNameColumn, '"Last name" column').to.be.at.least(0);
        cy.get('table tbody tr').should('have.length.greaterThan', 0)
          .each(($tr) => expect($tr.find('td').eq(lastNameColumn).text()).to.equal(clerkLastName));
      });
    });
  });

  it('Adds a new interactive user (OCM-1157)', () => {
    const user = users.interactive;
    openNewUser();
    panelOf('Enrolment Officer').find('.MuiSwitch-root').should('exist');
    panelOf('Claim Administrator').find('.MuiSwitch-root').should('exist');

    typeField('User name', user.username);
    typeField('Given names', user.givenNames);
    fab('save').should('be.disabled');

    typeField('Last name', user.lastName);
    typeField('Email', user.email);
    // The administrator system role (isSystem 64) is named after the dataset: "IMIS
    // Administrator" in the demo data, "LOCAL Administrator" on release.
    gql('{ role(isSystem: true, first: 50) { edges { node { name isSystem } } } }').then((data) => {
      const admin = data.role.edges.map((e) => e.node).find((r) => r.isSystem === 64);
      expect(admin, 'administrator system role').to.exist;
      chooseAutocomplete('User role(s)', admin.name);
    });
    chooseAutocomplete('Districts', baseline().locations.r1d1.label);
    cy.chooseMuiSelect('Interface Language', 'English');
    fab('save').should('be.disabled'); // no password yet

    cy.contains('button', 'Generate Password').click();
    field('New Password').invoke('val').then((password) => {
      expect(password).to.have.length.of.at.least(8);
      field('Confirm Password').should('have.value', password);
    });
    fab('save').should('not.be.disabled');

    cy.get('[aria-label="toggle password visibility"]').first().click();
    field('New Password').should('have.attr', 'type', 'text')
      .invoke('val')
      .should('match', /[a-z]/)
      .and('match', /[A-Z]/)
      .and('match', /\d/)
      .and('match', /[^A-Za-z0-9]/);

    saveNewUser();
    filterByUsername(user.username);
    cy.contains('table tbody tr', user.username).should('contain', user.lastName);
  });

  it('Modifies a user (OCM-178)', () => {
    const user = users.interactive;
    filterByUsername(user.username);
    cy.contains('table tbody tr', user.username).dblclick();
    cy.location('pathname', { timeout: TIMEOUT }).should('match', /\/admin\/users\/overview\/.+/);
    cy.contains('User Details');
    field('User name').should('have.value', user.username);

    user.lastName = `${user.lastName}_upd`;
    typeField('Last name', user.lastName);
    typeField('Phone', '0700000001');
    fab('save').should('not.be.disabled').click();
    cy.waitForJournalProgress();

    cy.reload();
    field('Last name', { timeout: TIMEOUT }).should('have.value', user.lastName);
    field('Phone').should('have.value', '0700000001');
    filterByUsername(user.username);
    cy.contains('table tbody tr', user.username).should('contain', user.lastName);
  });

  it('Creates an enrolment officer (OCM-283)', () => {
    const user = users.officer;
    openNewUser();
    fillLoginDetails(user, { role: 'Enrolment Officer' });

    // The role switches the officer panel on; make sure it is on.
    panelOf('Enrolment Officer').find('input[type="checkbox"]').then(($switch) => {
      if (!$switch.is(':checked')) cy.wrap($switch).click({ force: true });
    });
    panelOf('Enrolment Officer').within(() => {
      cy.contains('label', 'Birth date');
      cy.contains('label', 'Works to');
      cy.contains('label', 'Address');
      cy.contains('label', 'Substitution Officer');
      cy.contains('button', 'Add a municipality');
      // Choosing district r1d1 fills the table with its municipalities and villages.
      // r1d1m1 (coherent: a municipality of that district) is among them, with its villages.
      cy.contains('table tbody tr', baseline().locations.r1d1m1.label, { timeout: TIMEOUT })
        .find('.MuiChip-root').should('have.length.greaterThan', 0);
    });

    saveNewUser();

    openUsers();
    chooseAutocomplete('User type(s)', 'Enrolment Officer');
    typeField('User name', user.username);
    search();
    cy.contains('table tbody tr', user.username);

    // The officer is offered in Tools > Extracts.
    cy.visit('/front/tools/extracts');
    chooseAutocomplete('Select Officer', user.lastName);
  });

  it('Creates a claim administrator (OCM-284)', () => {
    const user = users.claimAdmin;
    openNewUser();
    const hospital = baseline().healthFacilities.hospital;
    // Same district as the hospital (r1d2): the facility picker only lists that district.
    fillLoginDetails(user, { role: 'Claim Administrator', district: baseline().locations.r1d2.label });

    panelOf('Claim Administrator').find('input[type="checkbox"]').then(($switch) => {
      if (!$switch.is(':checked')) cy.wrap($switch).click({ force: true });
    });
    // Save stays disabled until a health facility is chosen.
    fab('save').should('be.disabled');
    // The picker shows "CODE Name" and searches code or name, so type the code.
    chooseAutocomplete('Health Facility', hospital.code, hospital.label);
    saveNewUser();

    openUsers();
    chooseAutocomplete('User type(s)', 'Claim admin');
    typeField('User name', user.username);
    search();
    cy.contains('table tbody tr', user.username);
  });

  it('Deletes a user (OCM-177)', () => {
    const user = users.interactive;
    filterByUsername(user.username);
    cy.get('table tbody tr').should('have.length', 1);
    cy.clickRowAction(user.username, 'Delete');
    cy.get('[role="dialog"]').should('contain', 'Delete user')
      .and('contain', 'Are you sure you want to delete this user?');
    cy.get('[role="dialog"]').contains('button', 'Ok').click();
    cy.waitForJournalProgress();

    search();
    cy.contains('table tbody tr', user.username).should('not.exist');

    cy.contains('label', 'Show Deleted').click();
    search();
    cy.contains('table tbody tr', user.username).as('deletedRow');
    // A deleted row offers no Delete action.
    cy.get('@deletedRow').find('button').last().click({ force: true });
    cy.get('[role="menuitem"]').should('not.contain', 'Delete');
    cy.get('body').type('{esc}');
  });

  it('Shows deleted users (OCM-1156)', () => {
    openUsers();
    resultsCount().then((active) => {
      cy.contains('label', 'Show Deleted').click();
      search();
      countShould((n) => expect(n).to.be.greaterThan(active));
      cy.contains('label', 'Show Deleted').click();
      search();
      countShould((n) => expect(n).to.eq(active));
    });
  });

  it('Impersonates a user and stops (OCM-1229)', () => {
    const accountButton = () => cy.get('button:is([title="My account"],[aria-label="My account"])', { timeout: TIMEOUT });
    cy.visit('/front/home');
    cy.get('header').should('contain', 'Administration');
    accountButton().click();
    cy.contains('[role="menuitem"], li', 'My profile');
    cy.contains('[role="menuitem"], li', 'Impersonate user…').click();
    cy.get('[role="dialog"]').should('contain', 'Impersonate user');
    const claimAdmin = baseline().users.hospitalClaimAdmin.username;
    cy.get('[role="dialog"] input').type(claimAdmin, { force: true });
    cy.contains('[role="listbox"] li, li[role="option"]', claimAdmin, { timeout: TIMEOUT }).click({ force: true });
    cy.get('[role="dialog"]').should('not.exist');

    // The claim administrator has no administration rights.
    cy.get('header').should('not.contain', 'Administration');
    accountButton().click();
    cy.contains('[role="menuitem"], li', 'Stop impersonating').should('contain', claimAdmin).click();
    cy.get('header').should('contain', 'Administration');
  });

  it('Requests a password recovery (OCM-1127)', () => {
    // Partial: the e-mailed link (step 3) needs a mail catcher and is not automated.
    const user = users.claimAdmin;
    cy.clearCookies();
    cy.visit('/front/login');
    cy.contains('Forgot Password ?').click();
    cy.location('pathname').should('include', '/forgot_password');
    cy.contains('Recover your account');
    typeField('Username', user.username);
    cy.contains('button', 'Submit').click();
    cy.contains('Done ! Check your inbox and click on the verification link to reset your password.', { timeout: TIMEOUT });
  });
});
