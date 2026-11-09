// UAT "Language Selection in OpenIMIS", "Workplace- / Profile" and "Tools":
// switching the interface language from the 'My account' dropdown, the profile
// pages and the master-data extract.
//
// The language is a setting of the logged-in user: every test restores English for
// Admin through the API, so the specs that follow find the English interface.
import { TIMEOUTS } from '../support/constants';

const runId = Date.now().toString(36).slice(-5).toLowerCase();

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

// Logs in through the API (JWT cookie), without the UI.
const apiLogin = (username, password) => cy.request({
  method: 'POST',
  url: '/api/graphql',
  body: { query: `mutation { tokenAuth(username: "${username}", password: "${password}") { token } }` },
});

// The backend refuses a change to the language the user already has (and the UI never
// sends one): only change it when it differs.
const setAdminLanguage = (code) => {
  cy.clearCookies();
  cy.fixture('cred').then((cred) => {
    apiLogin(cred.username, cred.password);
    gql(`{ users(username: "${cred.username}") { edges { node { iUser { languageId } } } } }`).then((data) => {
      if (data.users.edges[0]?.node.iUser.languageId === code) return;
      mutateOk('changeUserLanguage', `languageId: "${code}"`, `UAT set language ${code}`);
    });
  });
};

// The 'My account' dropdown of the app bar (AccountCircle icon; its tooltip is translated).
const openAccountMenu = () => {
  cy.get('button[aria-haspopup="true"]')
    .filter((_, b) => [...b.querySelectorAll('[class*="material-symbols"]')].some((s) => s.textContent.trim() === 'account_circle')
      || b.matches('[aria-label="My account"]'))
    .first()
    .click();
  cy.get('[role="menu"]').should('be.visible');
};

const languageItem = (name) => cy.contains('[role="menu"] li[role="menuitem"]', name);

// Logs in through the login page as any user; `welcome` is the expected home text.
const loginAs = (username, password, welcome) => {
  cy.clearCookies();
  cy.visit('/front/login');
  cy.get('input[type="text"]').first().clear().type(username);
  cy.get('input[type="password"]').first().clear().type(password, { log: false });
  cy.get('button[type="submit"]').click();
  if (welcome) cy.contains(welcome);
};

describe('Language selection', () => {
  afterEach(() => {
    setAdminLanguage('en');
  });

  it('Changes the language from English to French (OCM-1202)', () => {
    setAdminLanguage('en');
    cy.login();
    cy.visit('/front/home');
    cy.contains('Welcome Admin Admin!');

    openAccountMenu();
    cy.get('[role="menu"]').within(() => {
      // The profile module's entries read "My Profile" and "Change Password".
      cy.contains('li', /^\s*My profile\s*$/i);
      cy.contains('li', /^\s*Change password\s*$/i);
      cy.contains('li', 'Impersonate user');
      cy.get('hr, li.MuiDivider-root').should('exist');
    });
    languageItem('English').should('have.class', 'Mui-selected');
    languageItem('Français').should('not.have.class', 'Mui-selected').click();

    cy.contains('[role="dialog"]', 'Confirm Language').within(() => {
      cy.contains('You are about to change the language to Français. Do you want to proceed?');
      cy.contains('button', 'Confirm').click();
    });

    cy.contains('Bienvenue Admin Admin!');
    openAccountMenu();
    languageItem('Français').should('have.class', 'Mui-selected');
  });

  it('Changes the language from French to English (OCM-1203)', () => {
    setAdminLanguage('fr');
    cy.visit('/front/home');
    cy.contains('Bienvenue Admin Admin!');

    openAccountMenu();
    languageItem('Français').should('have.class', 'Mui-selected');
    languageItem('English').click();

    cy.contains('[role="dialog"]', 'Confirmer la langue').within(() => {
      cy.contains('button', 'Confirmer').click();
    });

    cy.contains('Welcome Admin Admin!');
    cy.contains('Administration');
    openAccountMenu();
    languageItem('English').should('have.class', 'Mui-selected');
  });
});

describe('Profile', () => {
  const user = {
    username: `uatpw${runId}`,
    otherNames: 'Uat',
    lastName: `Pw${runId}`,
    password: 'Uat#Start2026x',
    newPassword: 'Uat#Changed2026y',
  };

  before(() => {
    cy.login();
    // Dedicated user so Admin's password never changes. "Clerk" is a system role,
    // looked up by name (not the demo id 4). No district and no insuree: location
    // coherence does not apply.
    gql('{ role(name_Icontains: "Clerk") { edges { node { id name } } } }').then((data) => {
      const role = data.role.edges.map((e) => e.node).find((n) => n.name.toLowerCase() === 'clerk');
      expect(role, 'Clerk role').to.exist;
      const roleId = atob(role.id).split(':')[1];
      mutateOk('createUser', `username: "${user.username}" userTypes: [INTERACTIVE] lastName: "${user.lastName}"
        otherNames: "${user.otherNames}" password: "${user.password}" language: "en" roles: [${roleId}] districts: []`);
    });
  });

  after(() => {
    cy.task('resetLoginFailures');
    cy.login();
    gql(`{ users(username: "${user.username}") { edges { node { id } } } }`).then((data) => {
      const id = data.users.edges[0]?.node.id;
      if (id) mutateOk('deleteUser', `uuids: ["${atob(id).split(':')[1]}"]`);
    });
  });

  it('Shows the profile of the logged-in user (OCM-696)', () => {
    cy.login();
    cy.visit('/front/profile/myProfile');
    cy.contains('My Profile');
    const readOnly = ($input) => expect($input.is(':disabled') || $input.prop('readOnly'), 'read-only').to.be.true;
    cy.contains('label', 'Username').siblings('.MuiInputBase-root').find('input')
      .should('have.value', 'Admin')
      .and(readOnly);
    ['Other Names', 'Last Name', 'Default Rows Per Page', 'Email', 'Phone Number', 'Interface Language'].forEach((label) => {
      cy.contains('label', label).siblings('.MuiInputBase-root').find('input').should(readOnly);
    });
    cy.contains('label', 'Other Names').siblings('.MuiInputBase-root').find('input').should('have.value', 'Admin');
    cy.contains('label', 'Last Name').siblings('.MuiInputBase-root').find('input').should('have.value', 'Admin');
    // Admin's roles as the API reports them: role names differ between datasets.
    gql('{ users(username: "Admin") { edges { node { iUser { roles { name isSystem } } } } } }').then((data) => {
      const roles = data.users.edges[0].node.iUser.roles;
      const admin = roles.find((r) => r.isSystem === 64);
      expect(admin, 'administrator system role of Admin').to.exist;
      cy.contains('table', 'Assigned Roles').should('contain', admin.name);
    });
    cy.contains('table', 'Assigned Regions');
    cy.contains('table', 'Assigned Districts');
  });

  it('Changes the password of the logged-in user (OCM-205)', () => {
    const welcome = `Welcome ${user.otherNames} ${user.lastName}!`;
    loginAs(user.username, user.password, welcome);

    cy.visit('/front/profile/changePassword');
    cy.contains('Change Password');
    cy.contains('button', 'Submit').should('be.disabled');
    cy.enterMuiInput('Current Password', user.password);
    cy.enterMuiInput('New Password', user.newPassword);
    cy.enterMuiInput('Confirm New Password', `${user.newPassword}x`);
    cy.contains('The passwords are not the same');
    cy.contains('button', 'Submit').should('be.disabled');
    cy.enterMuiInput('Confirm New Password', user.newPassword);
    cy.contains('button', 'Submit').should('not.be.disabled').click();

    cy.location('pathname', { timeout: TIMEOUTS.BACKEND_VALIDATION }).should('match', /^\/front\/?(home)?$/);
    cy.contains(welcome);
    cy.waitForJournalProgress();
    cy.assertJournalFirstEntryContains('Change password');
    cy.assertJournalNoFail();

    cy.logout();
    loginAs(user.username, user.newPassword, welcome);
    cy.logout();
    loginAs(user.username, user.password);
    cy.contains("The password or the username you've entered is incorrect.", { timeout: TIMEOUTS.BACKEND_VALIDATION });
  });
});

describe('Tools', () => {
  it('Downloads the master data (OCM-703)', () => {
    cy.login();
    cy.visit('/front/tools/extracts', {
      onBeforeLoad(win) {
        cy.stub(win, 'open').as('windowOpen');
      },
    });
    ['Download Master Data', 'Download Data for Officer', 'Upload Claims', 'Upload Enrolments', 'Upload Renewals', 'Upload Feedbacks']
      .forEach((title) => cy.contains(title));

    cy.contains('Download Master Data').parents('.MuiPaper-root').first().contains('button', 'Download').click();
    cy.get('@windowOpen').should('have.been.calledOnce');
    cy.get('@windowOpen').then((stub) => {
      const url = stub.firstCall.args[0];
      expect(url).to.contain('download_master_data');
      // The extract the browser would download: a non-empty file.
      cy.request({ url, encoding: 'binary', timeout: 120000 }).then((response) => {
        expect(response.status).to.eq(200);
        expect(response.body.length, 'master data size').to.be.above(100);
      });
    });
  });
});
