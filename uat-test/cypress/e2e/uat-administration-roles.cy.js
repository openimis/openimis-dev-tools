// Administration > Roles Management (OCM-172..175).
//
// Works on roles created by this spec, named per run; the tests run in order (create,
// modify, duplicate, delete) and after() deletes what is left through the API.

const runId = Date.now().toString(36).slice(-5).toUpperCase();
const ROLES_URL = '/front/roles';
const TIMEOUT = 5000;
const roleName = `UAT_ROLE_${runId}`;
const duplicateName = `UAT_DUP_${runId}`;

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

function deleteRoleByApi(name) {
  gql(`{ role(str: "${name}") { edges { node { uuid name } } } }`).then((data) => {
    data.role.edges.map((e) => e.node).filter((r) => r.name === name).forEach((role) => {
      const clientMutationId = uuidv4();
      gql(`mutation { deleteRole(input: { clientMutationId: "${clientMutationId}" clientMutationLabel: "UAT cleanup - role ${name}" uuids: ["${role.uuid}"] }) { clientMutationId } }`)
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

const fab = (icon) => cy.get('button.MuiFab-root', { timeout: TIMEOUT })
  .filter((_, b) => b.textContent.trim() === icon);

// The two permission lists of the role page: available first, chosen second.
const availableList = () => cy.get('ul.list', { timeout: TIMEOUT }).eq(0);
const chosenList = () => cy.get('ul.list', { timeout: TIMEOUT }).eq(1);
const itemTexts = ($items) => $items.toArray().map((li) => li.querySelector('.listItemText')?.textContent.trim());
const permissionItems = (list) => list().find('li').filter((_, li) => !!li.querySelector('.listItemText'));

function moveFirstPermission(fromList) {
  return permissionItems(fromList).first().then(($li) => {
    const text = $li.find('.listItemText').text().trim();
    cy.wrap($li).find('button').click();
    return cy.wrap(text);
  });
}

function filterRoles(name) {
  cy.visit(ROLES_URL);
  cy.contains(/\d+ Roles Found/, { timeout: TIMEOUT });
  typeField('Role Name', name);
  cy.contains('button', 'Search').click({ force: true });
  cy.waitForSearcherLoaded();
}

const roleRow = (name) => cy.contains('table tbody td', new RegExp(`^\\s*${name}\\s*$`), { timeout: TIMEOUT }).parent('tr');
const confirmOk = () => cy.get('[role="dialog"]').contains('button', 'Ok').click();

const permissions = { initial: [], current: [] };

describe('Administration / Roles Management', () => {
  beforeEach(() => {
    cy.login();
  });

  after(() => {
    cy.login();
    [roleName, duplicateName].forEach(deleteRoleByApi);
  });

  it('Adds a role (OCM-172)', () => {
    cy.visit(ROLES_URL);
    cy.contains(/\d+ Roles Found/, { timeout: TIMEOUT });
    ['Role Name', 'System', 'Blocked'].forEach((l) => cy.contains('label', l));
    cy.contains('label', 'Show Historical');

    cy.get(':is([title="Create new Role"],[aria-label="Create new Role"]) button').click();
    cy.contains('label', 'Role Name');
    cy.contains('label', 'Alternative Language');
    cy.contains('h6', 'Available permissions');
    cy.contains('h6', 'Chosen permissions');
    permissionItems(availableList).should('have.length.greaterThan', 10);
    permissionItems(chosenList).should('have.length', 0);

    typeField('Role Name', roleName);
    cy.contains('label', 'Filter').siblings('.MuiInputBase-root').find('input').type('Insuree');
    moveFirstPermission(availableList).then((p) => permissions.initial.push(p));
    moveFirstPermission(availableList).then((p) => permissions.initial.push(p));
    permissionItems(chosenList).should(($items) => {
      expect(itemTexts($items)).to.have.members(permissions.initial);
    });

    fab('save').should('not.be.disabled').click();
    cy.waitForJournalProgress();

    filterRoles(roleName);
    cy.get('table tbody tr').should('have.length', 1);
    roleRow(roleName);
  });

  it('Modifies a role (OCM-175)', () => {
    filterRoles(roleName);
    roleRow(roleName).contains('button', 'Edit').click();
    cy.contains(`Role Details`, { timeout: TIMEOUT });
    field('Role Name').should('have.value', roleName);
    permissionItems(chosenList).should('have.length', permissions.initial.length);

    let added;
    let removed;
    cy.contains('label', 'Filter').siblings('.MuiInputBase-root').find('input').type('Insuree');
    moveFirstPermission(availableList).then((p) => { added = p; });
    moveFirstPermission(chosenList).then((p) => { removed = p; });
    fab('save').should('not.be.disabled').click();
    cy.get('[role="dialog"]').should('contain', `Save changes in ${roleName}?`);
    confirmOk();
    cy.waitForJournalProgress();

    cy.then(() => {
      permissions.current = permissions.initial.filter((p) => p !== removed).concat(added);
    });
    filterRoles(roleName);
    roleRow(roleName).contains('button', 'Edit').click();
    permissionItems(chosenList).should(($items) => {
      expect(itemTexts($items)).to.have.members(permissions.current);
    });
  });

  it('Duplicates a role (OCM-174)', () => {
    filterRoles(roleName);
    roleRow(roleName).contains('button', 'Duplicate').click();
    field('Role Name').should('have.value', '');
    cy.contains('label', 'System').parent().find('input[type="checkbox"]').should('not.be.checked');
    cy.contains('label', 'Blocked').parent().find('input[type="checkbox"]').should('not.be.checked');
    permissionItems(chosenList).should(($items) => {
      expect(itemTexts($items)).to.have.members(permissions.current);
    });

    typeField('Role Name', duplicateName);
    fab('save').should('not.be.disabled').click();
    cy.waitForJournalProgress();

    filterRoles(duplicateName);
    roleRow(duplicateName).contains('button', 'Edit').click();
    permissionItems(chosenList).should(($items) => {
      expect(itemTexts($items)).to.have.members(permissions.current);
    });
  });

  it('Deletes a role (OCM-173)', () => {
    filterRoles(roleName);
    roleRow(roleName).contains('button', 'Delete').click();
    cy.get('[role="dialog"]').should('contain', `Are you sure you want to delete ${roleName}?`);
    confirmOk();
    cy.waitForJournalProgress();

    filterRoles(roleName);
    cy.contains('table tbody tr', roleName).should('not.exist');

    cy.contains('label', 'Show Historical').click();
    cy.contains('button', 'Search').click({ force: true });
    cy.waitForSearcherLoaded();
    cy.contains('table thead th', 'Valid to');
    // The deleted version carries a "Valid to" date.
    roleRow(roleName).find('td').eq(4).invoke('text').should('match', /\d/);
  });
});
