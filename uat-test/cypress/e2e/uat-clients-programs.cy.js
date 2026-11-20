// UAT "Clients / Individual-": searching the beneficiaries of the program an
// individual (OCM-1131) or a group (OCM-1148) is enrolled in, reached from the
// PROGRAMS tab. Programs, individuals, groups and active beneficiaries are seeded
// through the GraphQL API; the beneficiary tasks (maker-checker) are approved there too.
import { TIMEOUTS } from '../support/constants';

const runId = Date.now().toString(36).slice(-5).toUpperCase();
const runTag = runId.replace(/\d/g, (d) => 'ABCDEFGHIJ'[d]);

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

const seedIndividual = (firstName, lastName, ext) => {
  mutateOk('createIndividual', `firstName: "${firstName}" lastName: "${lastName}" dob: "1984-08-08" jsonExt: ${gqlJson(ext)}`);
  return gql(`{ individual(lastName_Iexact: "${lastName}", firstName_Iexact: "${firstName}") { edges { node { uuid } } } }`)
    .then((data) => data.individual.edges[0].node.uuid);
};

const seedProgram = (code, type) => {
  const year = new Date().getFullYear();
  mutateOk('createBenefitPlan', `code: "${code}" name: "UAT ${code}" type: ${type} maxBeneficiaries: 100 institution: ""
    description: "" beneficiaryDataSchema: "{}" dateValidFrom: "${year}-01-01" dateValidTo: "${year + 1}-12-31"`);
  return gql(`{ benefitPlan(code: "${code}") { edges { node { uuid } } } }`).then((data) => data.benefitPlan.edges[0].node.uuid);
};

// Approves, as Admin, every received task of `source` whose data mentions one of `ids`.
const approveTasksMentioning = (source, ids) => {
  gql(`{ taskGroup(code: "any") { edges { node { uuid } } } users(username: "Admin") { edges { node { id } } }
         task(source: "${source}", status: RECEIVED, first: 100, orderBy: ["-date_created"]) { edges { node { uuid data } } } }`)
    .then((data) => {
      const groupUuid = data.taskGroup.edges[0].node.uuid;
      const adminUuid = atob(data.users.edges[0].node.id).split(':')[1];
      const tasks = data.task.edges.map((e) => e.node).filter((t) => ids.some((id) => String(t.data).includes(id)));
      expect(tasks, `${source} tasks to approve`).to.have.length(ids.length);
      tasks.forEach((task) => {
        mutateOk('updateTask', `id: "${task.uuid}" status: ACCEPTED taskGroupId: "${groupUuid}"`);
        mutateOk('resolveTask', `id: "${task.uuid}" businessStatus: ${gqlJson({ [adminUuid]: 'APPROVED' })}`);
      });
    });
};

const tableRows = () => cy.get('table tbody tr');
const openTab = (label) => cy.contains('button[role="tab"]', label, { matchCase: false }).click();

// Opens the program `code` from the PROGRAMS tab of the current individual or group page.
const openProgramFromTab = (code) => {
  openTab('PROGRAMS');
  cy.contains('tr', code, { timeout: TIMEOUTS.BACKEND_VALIDATION }).dblclick({ force: true });
  cy.url().should('include', '/benefitPlans/benefitPlan/');
  ['Potential', 'Active', 'Graduated', 'Suspended'].forEach((tab) => cy.contains('button[role="tab"]', tab));
  openTab('Active');
};

const individualCode = `UPI${runId}`;
const groupCode = `UPG${runId}`;
const firstPrefix = `Bnf${runTag}`;
const beneficiaries = [
  { firstName: `${firstPrefix}a`, noc: 1 },
  { firstName: `${firstPrefix}b`, noc: 2 },
  { firstName: `${firstPrefix}c`, noc: 5 },
];
const groupCodes = [`UBA${runId}`, `UBB${runId}`];
const ids = { individuals: [], groups: [] };

describe('Clients / Programs of individuals and groups', () => {
  before(() => {
    cy.login();
    cy.ensurePermissiveTaskGroup();
    seedProgram(individualCode, 'INDIVIDUAL').then((uuid) => { ids.individualProgram = uuid; });
    seedProgram(groupCode, 'GROUP').then((uuid) => { ids.groupProgram = uuid; });
    beneficiaries.forEach((b) => {
      seedIndividual(b.firstName, `Uat${runTag}Bnf`, { number_of_children: b.noc }).then((uuid) => ids.individuals.push(uuid));
    });
    groupCodes.forEach((code, i) => {
      seedIndividual(`Grp${runTag}${'ab'[i]}`, `Uat${runTag}Grp`, { number_of_children: 1 }).then((head) => {
        mutateOk('createGroup', `code: "${code}" individualsData: [{ individualId: "${head}" role: HEAD recipientType: PRIMARY }]`);
        gql(`{ group(code_Iexact: "${code}") { edges { node { uuid } } } }`).then((d) => ids.groups.push(d.group.edges[0].node.uuid));
      });
    });
    cy.then(() => {
      ids.individuals.forEach((uuid) => mutateOk('createBeneficiary', `individualId: "${uuid}" benefitPlanId: "${ids.individualProgram}" status: ACTIVE`));
      ids.groups.forEach((uuid) => mutateOk('createGroupBeneficiary', `groupId: "${uuid}" benefitPlanId: "${ids.groupProgram}" status: ACTIVE`));
    });
    cy.then(() => {
      approveTasksMentioning('BeneficiaryService', ids.individuals);
      approveTasksMentioning('GroupBeneficiaryService', ids.groups);
    });
  });

  beforeEach(() => {
    cy.login();
  });

  it('Filters the beneficiaries of an individual program (OCM-1131)', () => {
    cy.visit(`/front/individuals/individual/${ids.individuals[0]}`);
    cy.contains('General Information');
    openProgramFromTab(individualCode);
    cy.contains(`${beneficiaries.length} Beneficiaries`, { timeout: TIMEOUTS.BACKEND_VALIDATION });

    cy.enterMuiInput('First name', beneficiaries[1].firstName);
    cy.contains('button', 'Search').click();
    cy.contains('1 Beneficiaries', { timeout: TIMEOUTS.BACKEND_VALIDATION });
    tableRows().should('have.length', 1).and('contain', beneficiaries[1].firstName);
    cy.contains('button', /Reset/).click();
    cy.contains(`${beneficiaries.length} Beneficiaries`, { timeout: TIMEOUTS.BACKEND_VALIDATION });

    cy.contains('button', 'Advanced Filters').click();
    cy.get('[role="dialog"]').within(() => {
      cy.contains('label', 'Field');
      cy.contains('button', 'Add filter');
      cy.contains('button', 'Clear All Filters');
    });
    [['Field', 'Number of children'], ['Filter', 'Greater than or equal to']].forEach(([label, option]) => {
      cy.get('[role="dialog"]').contains('label', label).siblings('.MuiInputBase-root')
        .find('[role="combobox"], input').first().click({ force: true });
      cy.contains('[role="listbox"] li, li[role="option"]', option).click({ force: true });
    });
    cy.get('[role="dialog"]').within(() => {
      cy.contains('label', 'Value').siblings('.MuiInputBase-root').find('input').clear().type('2');
      cy.contains('button', /^Filter$/).click();
    });
    cy.get('[role="dialog"]').should('not.exist');
    cy.contains('2 Beneficiaries', { timeout: TIMEOUTS.BACKEND_VALIDATION });
    cy.contains('tr', beneficiaries[0].firstName).should('not.exist');

    cy.contains('button', /Reset/).click();
    cy.contains(`${beneficiaries.length} Beneficiaries`, { timeout: TIMEOUTS.BACKEND_VALIDATION });
  });

  it('Searches the group beneficiaries of a household program (OCM-1148)', () => {
    cy.visit(`/front/groups/group/${ids.groups[0]}`);
    cy.contains('General information');
    openProgramFromTab(groupCode);
    cy.contains(`${groupCodes.length} Group Beneficiaries`, { timeout: TIMEOUTS.BACKEND_VALIDATION });

    cy.enterMuiInput('Code', groupCodes[1]);
    cy.contains('button', 'Search').click();
    cy.contains('1 Group Beneficiaries', { timeout: TIMEOUTS.BACKEND_VALIDATION });
    tableRows().should('have.length', 1).and('contain', groupCodes[1]);
  });
});
