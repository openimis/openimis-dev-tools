// UAT: Enrolment / Contracts (OCM-262..270).
//
// The baseline has no policy holder, contribution plan or contract. The spec seeds
// one contribution plan ("CV: percent of income" on products.basic) in a bundle, and
// gives every case its own policy holder (that bundle, plus the insured family's head
// at an income of 1000) and, where the case starts from one, its own contract.
// Approving a contract creates policies for the insurees covered: that data is added
// next to the insured family and is not removed.
//
// Coherent with district r1d1: policy holders are created in village r1d1m1v1, and the
// insurees they cover are the insured family's head and member, who live there.
// Nothing is placed in region r2.
import { baseline } from '../support/baseline';

const runId = Date.now().toString(36).slice(-5).toUpperCase();
const TODAY = new Date();
const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (days) => new Date(Date.now() + days * 86400000);

// Class uuid of "CV: percent of income" (calcrule_contribution_income_percentage),
// registered by the installed module, not a row of the database.
const INCOME_PERCENT_RULE = '0e1b6dd4-04a0-4ee6-ac47-2a99cfa5e9a8';

const asInsuree = (person) => ({
  id: person.id,
  chfId: person.chfId,
  lastName: person.lastName,
  otherNames: person.otherNames,
});
const headInsuree = () => asInsuree(baseline().families.insured.head);
const memberInsuree = () => asInsuree(baseline().families.insured.members[0]);

// ------------------ GraphQL seeding ------------------
const uuidv4 = () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
  const r = (Math.random() * 16) | 0;
  return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
});
const decodeId = (relayId) => atob(relayId).split(':')[1];
const jsonExt = (obj) => JSON.stringify(JSON.stringify(obj));

const gql = (query) => cy
  .request({ method: 'POST', url: '/api/graphql', body: { query }, log: false })
  .then(({ body }) => {
    if (body.errors?.length) throw new Error(`GraphQL error: ${JSON.stringify(body.errors)}`);
    return body.data;
  });

const mutate = (name, input, { allowError = false } = {}) => {
  const id = uuidv4();
  return gql(`mutation { ${name}(input: { clientMutationId: "${id}" clientMutationLabel: "UAT seed ${name}" ${input} }) { clientMutationId } }`)
    .then(() => cy.waitForMutationLog(id))
    .then(({ status, error }) => {
      if (status !== 2 && !allowError) throw new Error(`${name} failed: ${error}`);
    });
};

const seeded = { policyHolders: [], contracts: [] };

const seedBundle = () => {
  const productId = baseline().products.basic.id;
  mutate('createContributionPlan', `code: "CP${runId}" name: "UAT CP ${runId}" calculation: "${INCOME_PERCENT_RULE}"
    benefitPlanType_Model: "Product" benefitPlanId: "${productId}" periodicity: 12 dateValidFrom: "${iso(TODAY)}"
    jsonExt: ${jsonExt({ calculation_rule: { rate: '5', includeFamily: false } })}`);
  mutate('createContributionPlanBundle', `code: "CB${runId}" name: "UAT bundle ${runId}" periodicity: 12 dateValidFrom: "${iso(TODAY)}"`);
  gql(`{ contributionPlan(code: "CP${runId}") { edges { node { id } } }
         contributionPlanBundle(code: "CB${runId}") { edges { node { id } } } }`).then((data) => {
    seeded.cpId = decodeId(data.contributionPlan.edges[0].node.id);
    seeded.bundleId = decodeId(data.contributionPlanBundle.edges[0].node.id);
    mutate('createContributionPlanBundleDetails',
      `contributionPlanBundleId: "${seeded.bundleId}" contributionPlanId: "${seeded.cpId}" dateValidFrom: "${iso(TODAY)}"`);
  });
};

const addPolicyHolderInsuree = (ph, insuree) => mutate('createPolicyHolderInsuree', `policyHolderId: "${ph.id}" insureeId: ${insuree.id}
  contributionPlanBundleId: "${seeded.bundleId}" dateValidFrom: "${iso(TODAY)}" jsonExt: ${jsonExt({ calculation_rule: { income: 1000 } })}`);

// A policy holder with the seeded bundle and the insured family's head. Yields { code, tradeName, id }.
const seedPolicyHolder = (suffix) => {
  const ph = { code: `K${runId}${suffix}`, tradeName: `UAT PH ${runId} ${suffix}` };
  mutate('createPolicyHolder', `code: "${ph.code}" tradeName: "${ph.tradeName}" locationsId: ${baseline().locations.r1d1m1v1.id} dateValidFrom: "${iso(TODAY)}"`);
  gql(`{ policyHolder(code: "${ph.code}") { edges { node { id } } } }`).then((data) => {
    ph.id = decodeId(data.policyHolder.edges[0].node.id);
    seeded.policyHolders.push(ph.id);
    mutate('createPolicyHolderContributionPlanBundle',
      `policyHolderId: "${ph.id}" contributionPlanBundleId: "${seeded.bundleId}" dateValidFrom: "${iso(TODAY)}"`);
    addPolicyHolderInsuree(ph, headInsuree());
  });
  return cy.wrap(ph);
};

// A Draft contract (its details are generated from the policy holder insurees); with
// `submit` it is submitted, i.e. Negotiable. Yields { code, id, ph }.
const seedContract = (suffix, { submit = false } = {}) => seedPolicyHolder(suffix).then((ph) => {
  const contract = { code: `C${runId}${suffix}`, ph };
  mutate('createContract', `code: "${contract.code}" policyHolderId: "${ph.id}" dateValidFrom: "${iso(TODAY)}" dateValidTo: "${iso(addDays(364))}"`);
  gql(`{ contract(code: "${contract.code}") { edges { node { id } } } }`).then((data) => {
    contract.id = decodeId(data.contract.edges[0].node.id);
    seeded.contracts.push(contract.id);
    if (submit) mutate('submitContract', `id: "${contract.id}"`);
  });
  return cy.wrap(contract);
});

const contractState = (contract) => gql(`{ contract(code: "${contract.code}") { edges { node { state } } } }`)
  .then((data) => data.contract.edges[0].node.state);

const STATE = { DRAFT: 2, NEGOTIABLE: 4, EXECUTABLE: 5, COUNTER: 11 };

// ------------------ UI helpers ------------------
const dialog = () => cy.get('[role="dialog"]').filter(':visible').last();
const confirmDialog = () => cy.get('[role="dialog"] button.primaryButton').filter(':visible').click();
const fieldIn = (label) => dialog().contains('label', label, { matchCase: false }).siblings('.MuiInputBase-root');
const selectIn = (label, value) => {
  fieldIn(label).find('[role="combobox"], [role="button"]').first().click();
  cy.get('[role="listbox"]').filter(':visible').last().contains('li', value).click();
  fieldIn(label).should('contain.text', value);
};
// Text of a row including the values of its read-only inputs (pickers render the
// bundle and the insuree as disabled inputs).
const rowValues = ($row) => [$row.text(), ...$row.find('input').toArray().map((i) => i.value)].join(' ');

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const pickDate = (scope, label, date) => {
  cy.get(scope).filter(':visible').last()
    .contains('label', label, { matchCase: false }).parent()
    .find('button[aria-label^="Choose date"]').click();
  const header = '.MuiPickerPopper-root .MuiPickersCalendarHeader-label';
  const target = `${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
  // While the month slides, the old and the new label are both rendered: read one.
  const step = (n = 0) => cy.get(header).should('have.length', 1).invoke('text').then((text) => {
    if (text.trim() === target || n > 24) return;
    const [m, y] = text.trim().split(/\s+/);
    const forward = +y < date.getFullYear() || (+y === date.getFullYear() && MONTHS.indexOf(m) < date.getMonth());
    cy.get(`.MuiPickerPopper-root .MuiPickersArrowSwitcher-${forward ? 'next' : 'previous'}IconButton`).click({ force: true });
    cy.get(header).should('not.have.text', text);
    step(n + 1);
  });
  step();
  cy.get(header).should('have.text', target);
  cy.get('.MuiPickerPopper-root .MuiPickersDay-root')
    .not('.MuiPickersDay-dayOutsideMonth, .MuiPickersDay-hiddenDaySpacingFiller')
    .contains(new RegExp(`^${date.getDate()}$`)).click({ force: true });
  cy.get('.MuiPickerPopper-root').should('not.exist');
};

const clickTooltip = ($scope, label) => {
  const $el = $scope.find(`:is([aria-label="${label}"],[title="${label}"])`).first();
  expect($el.length, `element with tooltip "${label}"`).to.eq(1);
  cy.wrap($el.is('button, a') ? $el : $el.find('button, a').first()).click({ force: true });
};
const rowAction = (rowText, label) => cy.contains('tbody tr', rowText).should('exist').then(($row) => clickTooltip($row, label));
const fab = (label) => cy.get(`:is([aria-label="${label}"],[title="${label}"])`).first()
  .then(($el) => ($el.is('button') ? $el : $el.find('button').first()));

const searcherTitle = (regex) => cy.contains('.paperHeaderTitle, .tableTitle h6, h6', regex);

const searchContract = (contract) => {
  cy.visit('/front/contracts');
  cy.waitForSearcherLoaded();
  cy.enterMuiInput('Code', contract.code);
  // Wait for the search's own result: a row clicked in the list it replaces loses its selection.
  cy.aliasGraphqlQuery('contract(', 'contractSearch');
  cy.contains('button', 'Search').click({ force: true });
  cy.awaitSearcherRefresh('contractSearch');
  cy.contains('tbody tr', contract.code).should('have.length', 1);
};

const openContract = (contract) => {
  searchContract(contract);
  rowAction(contract.code, 'Edit');
  cy.contains(`Contract ${contract.code}`).should('be.visible');
  cy.waitForSearcherLoaded();
};

// The State field of the contract page (a read-only select) and the State column.
// Read-only selects render their value in an input: compare text and input values.
const valuesOf = ($el) => [$el.text(), ...$el.find('input').toArray().map((i) => i.value)].join(' ');
const expectPageState = (label) => cy.contains('label', /^State$/).siblings('.MuiInputBase-root')
  .should(($field) => expect(valuesOf($field), 'State field').to.contain(label));
const expectListState = (contract, label) => {
  searchContract(contract);
  cy.contains('tbody tr', contract.code).should(($row) => expect(valuesOf($row), 'State column').to.contain(label));
};

const selectRowsAction = (contract, action) => {
  searchContract(contract);
  cy.contains('tbody tr', contract.code).find('td').first().click();
  cy.contains(/1 Contract\(s\) Selected/).should('be.visible');
  cy.get('body').then(($body) => {
    const direct = $body.find('button').filter((_, b) => b.textContent.trim() === action);
    if (direct.length) {
      cy.wrap(direct.first()).click();
      return;
    }
    // More than two selection actions are grouped behind a "more" icon in the results header.
    cy.contains(/1 Contract\(s\) Selected/).closest('.MuiGrid-container, .MuiToolbar-root, div')
      .parent().find('button').filter((_, b) => /more_(vert|horiz)|MoreVert|MoreHoriz/.test(b.innerHTML))
      .first().click();
    cy.contains('[role="menuitem"]', action).click();
  });
};

describe('UAT Enrolment - Contracts', () => {
  before(() => {
    cy.login();
    seedBundle();
  });

  beforeEach(() => cy.login());

  after(() => {
    cy.login();
    cy.then(() => {
      // Executable contracts cannot be deleted; deletion of the others only deactivates them.
      if (seeded.contracts.length) {
        mutate('deleteContract', `uuids: [${seeded.contracts.map((u) => `"${u}"`).join(', ')}]`, { allowError: true });
      }
      if (seeded.policyHolders.length) {
        mutate('deletePolicyHolder', `uuids: [${seeded.policyHolders.map((u) => `"${u}"`).join(', ')}]`, { allowError: true });
      }
    });
  });

  it('Adds a contract (OCM-262)', () => {
    seedPolicyHolder('A').then((ph) => {
      const code = `N${runId}`;
      cy.visit('/front/contracts');
      cy.waitForSearcherLoaded();
      fab('Create new Contract').click();
      cy.contains('To start creating new Contract Details, you need to fill in General Information fields and click Save.')
        .should('be.visible');
      ['Contract Details', 'Payments', 'Persons Covered'].forEach((tab) => cy.contains('[role="tab"]', tab).should('exist'));
      cy.enterMuiInput('Code', code);
      cy.chooseMuiSelect('Policy Holder', ph.code);
      pickDate('main, #root', 'Valid from', TODAY);
      pickDate('main, #root', 'Valid to', addDays(364));
      cy.clickSave('Save changes');
      cy.waitForJournalProgress();
      cy.assertJournalFirstEntryContains(`Create Contract ${code}`);
      cy.assertJournalNoFail();
      gql(`{ contract(code: "${code}") { edges { node { id state } } } }`).then((data) => {
        expect(data.contract.edges, 'created contract').to.have.length(1);
        seeded.contracts.push(decodeId(data.contract.edges[0].node.id));
        expect(data.contract.edges[0].node.state, 'state Draft').to.eq(STATE.DRAFT);
      });
      openContract({ code });
      expectPageState('Draft');
      // The details are generated from the policy holder insurees.
      searcherTitle(/1 Contract Details Found/).should('exist');
      cy.get('tbody tr').first().should(($row) => expect(rowValues($row)).to.contain(`CB${runId}`));
    });
  });

  it('Adds a contract detail (OCM-263)', () => {
    seedContract('B').then((contract) => {
      // The member joins the policy holder after the contract was made: not in it yet.
      const member = memberInsuree();
      addPolicyHolderInsuree(contract.ph, member);
      openContract(contract);
      searcherTitle(/1 Contract Details Found/).should('exist');
      cy.get('.MuiFab-sizeSmall').first().click();
      dialog().should('contain', 'Create new Contract Details');
      selectIn('Insuree', member.otherNames);
      dialog().within(() => cy.enterMuiInput('Income', '1200'));
      dialog().find('button').contains('Create').click();
      dialog().should('contain', 'Create new Contract Details?')
        .and('contain', 'Are you sure you want to create new Contract Details?');
      confirmDialog();
      cy.waitForJournalProgress();
      cy.assertJournalFirstEntryContains('Create Contract Detail');
      cy.assertJournalNoFail();
      cy.contains('button', 'Search').click({ force: true });
      searcherTitle(/2 Contract Details Found/).should('exist');
    });
  });

  it('Edits contract details (OCM-264)', () => {
    seedContract('C').then((contract) => {
      openContract(contract);
      cy.get('tbody tr').first().then(($row) => clickTooltip($row, 'Edit'));
      dialog().should('contain', 'Edit Contract Details');
      fieldIn('Insuree').find('[role="combobox"], input').first()
        .should(($el) => expect($el.is(':disabled') || $el.attr('aria-disabled') === 'true', 'insuree read-only').to.be.true);
      // Income comes from the calculation rule of the bundle (CalculationInput): it appears
      // only after the linked classes and the rule parameters are fetched for the row.
      dialog().contains('label', 'Income').should('exist');
      dialog().within(() => cy.enterMuiInput('Income', '3000'));
      dialog().find('button').contains('Save').click();
      dialog().should('contain', 'Save changes in Contract Details?');
      confirmDialog();
      cy.waitForJournalProgress();
      cy.assertJournalFirstEntryContains('Update Contract Detail');
      cy.assertJournalNoFail();
      gql(`{ contractDetails(contract_Id: "${contract.id}") { edges { node { jsonExt } } } }`).then((data) => {
        expect(data.contractDetails.edges[0].node.jsonExt, 'income saved').to.match(/"income":\s*"?3000/);
      });
      cy.get('tbody tr').first().then(($row) => clickTooltip($row, 'Edit'));
      // numberInput shows the value with a thousands separator ("3,000").
      dialog().contains('label', 'Income')
        .siblings('.MuiInputBase-root').find('input')
        .invoke('val').should('match', /^3[,\u202f ]?000$/);
    });
  });

  it('Deletes contract details (OCM-265)', () => {
    seedContract('D').then((contract) => {
      openContract(contract);
      searcherTitle(/1 Contract Details Found/).should('exist');
      cy.get('tbody tr').first().then(($row) => clickTooltip($row, 'Delete'));
      dialog().should('contain', 'Are you sure you want to delete').and('contain', `CB${runId}`)
        .and('contain', 'Deleting data does not mean erasing it');
      confirmDialog();
      cy.waitForJournalProgress();
      cy.assertJournalFirstEntryContains('Delete Contract Detail');
      cy.assertJournalNoFail();
      cy.contains('button', 'Search').click({ force: true });
      searcherTitle(/0 Contract Details Found/).should('exist');
    });
  });

  it('Submits a contract (OCM-266)', () => {
    seedContract('E').then((contract) => {
      openContract(contract);
      fab('Submit').click();
      dialog().should('contain', 'Submit Contract?').and('contain', `Are you sure you want to submit Contract ${contract.code}?`);
      confirmDialog();
      cy.waitForJournalProgress();
      cy.assertJournalFirstEntryContains(`Submit Contract ${contract.code}`);
      cy.assertJournalNoFail();
      contractState(contract).should('eq', STATE.NEGOTIABLE);
      cy.reload();
      expectPageState('Negotiable');
      expectListState(contract, 'Negotiable');
    });
  });

  it('Approves a contract from the list (OCM-267)', () => {
    seedContract('F', { submit: true }).then((contract) => {
      selectRowsAction(contract, 'Approve selected');
      dialog().should('contain', 'Approve selected Contract(s)?').and('contain', 'Are you sure you want to approve 1 Contract(s)?');
      confirmDialog();
      cy.waitForJournalProgress();
      cy.assertJournalFirstEntryContains('Approve 1 Contract(s)');
      cy.assertJournalNoFail();
      contractState(contract).should('eq', STATE.EXECUTABLE);
      expectListState(contract, 'Executable');
    });
  });

  it('Approves a contract from its page (OCM-268)', () => {
    seedContract('G', { submit: true }).then((contract) => {
      openContract(contract);
      fab('Counter').should('exist');
      fab('Approve').click();
      dialog().should('contain', 'Approve Contract?').and('contain', `Are you sure you want to approve Contract ${contract.code}?`);
      confirmDialog();
      cy.waitForJournalProgress();
      cy.assertJournalFirstEntryContains(`Approve Contract ${contract.code}`);
      cy.assertJournalNoFail();
      contractState(contract).should('eq', STATE.EXECUTABLE);
      cy.reload();
      expectPageState('Executable');
      expectListState(contract, 'Executable');
    });
  });

  it('Counters a contract from the list (OCM-269)', () => {
    seedContract('H', { submit: true }).then((contract) => {
      selectRowsAction(contract, 'Counter selected');
      dialog().should('contain', 'Counter selected Contract(s)?').and('contain', 'Are you sure you want to counter 1 Contract(s)?');
      confirmDialog();
      cy.waitForJournalProgress();
      cy.assertJournalFirstEntryContains('Counter 1 Contract(s)');
      cy.assertJournalNoFail();
      contractState(contract).should('eq', STATE.COUNTER);
      expectListState(contract, 'Counter');
      // A countered contract can be edited and submitted again.
      openContract(contract);
      fab('Submit').should('exist');
    });
  });

  it('Counters a contract from its page (OCM-270)', () => {
    seedContract('I', { submit: true }).then((contract) => {
      openContract(contract);
      fab('Approve').should('exist');
      fab('Counter').click();
      dialog().should('contain', 'Counter Contract?').and('contain', `Are you sure you want to counter Contract ${contract.code}?`);
      confirmDialog();
      cy.waitForJournalProgress();
      cy.assertJournalFirstEntryContains(`Counter Contract ${contract.code}`);
      cy.assertJournalNoFail();
      contractState(contract).should('eq', STATE.COUNTER);
      cy.reload();
      expectPageState('Counter');
    });
  });
});
