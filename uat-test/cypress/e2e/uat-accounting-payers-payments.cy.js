// UAT: Accounting / Payers (OCM-312..314) and Payments (OCM-310, 311).
//
// Payers and payments are seeded through the GraphQL API with names and receipt
// numbers unique to the run. Payers are placed in region r1, the same region as the
// baseline payer; the case does not check that a payer of another region is hidden.
// Payments carry no location.
import { baseline } from '../support/baseline';
import { TIMEOUTS } from '../support/constants';

const runId = Date.now().toString(36).slice(-5).toUpperCase();
const TODAY = new Date();
const iso = (d) => d.toISOString().slice(0, 10);
const region = () => baseline().locations.r1;

// ------------------ GraphQL seeding ------------------
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

const mutate = (name, input, { allowError = false } = {}) => {
  const id = uuidv4();
  return gql(`mutation { ${name}(input: { clientMutationId: "${id}" clientMutationLabel: "UAT seed ${name}" ${input} }) { clientMutationId } }`)
    .then(() => cy.waitForMutationLog(id))
    .then(({ status, error }) => {
      if (status !== 2 && !allowError) throw new Error(`${name} failed: ${error}`);
    });
};

const seeded = { payers: [] };

const seedPayer = (suffix) => {
  const payer = { name: `UAT payer ${runId} ${suffix}` };
  mutate('createPayer', `name: "${payer.name}" type: "D" locationUuid: "${region().uuid}" address: "UAT street ${suffix}"`);
  gql(`{ payers(name_Icontains: "${payer.name}") { edges { node { uuid } } } }`).then((data) => {
    payer.uuid = data.payers.edges[0].node.uuid;
    seeded.payers.push(payer.uuid);
  });
  return cy.wrap(payer);
};

const seedPayment = (receiptNo, amount = 150) => {
  mutate('createPayment', `expectedAmount: "${amount}" receivedAmount: "${amount}" receiptNo: "${receiptNo}"
    requestDate: "${iso(TODAY)}" receivedDate: "${iso(TODAY)}" typeOfPayment: "C" transactionNo: "${receiptNo}"`);
  return gql(`{ payments(receiptNo: "${receiptNo}") { edges { node { uuid } } } }`)
    .then((data) => data.payments.edges[0].node.uuid);
};

// ------------------ UI helpers ------------------
const dialog = () => cy.get('[role="dialog"]').filter(':visible').last();

const typeIn = (label, value) => {
  const field = () => cy.contains('label', label, { matchCase: false }).siblings('.MuiInputBase-root')
    .find('input, textarea').not('[aria-hidden="true"]').first();
  field().clear({ force: true });
  field().type(value, { force: true, delay: 0 });
};

const clickTooltip = ($scope, label) => {
  const $el = $scope.find(`:is([aria-label="${label}"],[title="${label}"])`).first();
  expect($el.length, `element with tooltip "${label}"`).to.eq(1);
  cy.wrap($el.is('button, a') ? $el : $el.find('button, a').first()).click({ force: true });
};
const rowAction = (rowText, label) => cy.contains('tbody tr', rowText).should('be.visible').then(($row) => clickTooltip($row, label));

const searcherTitle = (regex) => cy.contains('.paperHeaderTitle, .tableTitle h6, h6', regex);
const resultCount = (regex) => searcherTitle(regex).invoke('text').then((t) => Number(t.match(/\d+/)[0]));

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
// Today in the MUI X popper of the date field `label` (the page has one field per label).
const pickToday = (label) => {
  cy.contains('label', label, { matchCase: false }).parent().find('button[aria-label^="Choose date"]').click();
  cy.get('.MuiPickerPopper-root .MuiPickersCalendarHeader-label').should('have.text', `${MONTHS[TODAY.getMonth()]} ${TODAY.getFullYear()}`);
  cy.get('.MuiPickerPopper-root button[aria-current="date"]').click({ force: true });
  cy.get('.MuiPickerPopper-root').should('not.exist');
};

const searchPayer = (name, { history = false } = {}) => {
  cy.visit('/front/payer/payers');
  cy.waitForSearcherLoaded();
  cy.enterMuiInput('Name', name);
  if (history) cy.contains('label', 'Show Historical Values').click();
  cy.contains('button', 'Search').click({ force: true });
  cy.waitForSearcherLoaded();
};

describe('UAT Accounting - Payers', () => {
  beforeEach(() => cy.login());

  after(() => {
    cy.login();
    cy.then(() => {
      if (seeded.payers.length) {
        mutate('deletePayer', `uuids: [${seeded.payers.map((u) => `"${u}"`).join(', ')}]`, { allowError: true });
      }
    });
  });

  it('Adds a payer (OCM-312)', () => {
    const name = `UAT payer ${runId} new`;
    cy.visit('/front/payer/payers');
    cy.waitForSearcherLoaded();
    cy.get(':is([aria-label="Add new payer"],[title="Add new payer"])').filter(':visible').first()
      .then(($el) => cy.wrap($el.is('button, a') ? $el : $el.find('button, a').first()).click());
    cy.contains('New Payer').should('be.visible');
    typeIn('Name', name);
    cy.chooseMuiSelect('Type', 'Donor');
    cy.chooseMuiSelect('Region', region().label);
    typeIn('Address', `UAT street ${runId}`);
    cy.clickSave('Save changes');
    cy.waitForJournalProgress();
    cy.assertJournalFirstEntryContains(`Create payer ${name}`);
    cy.assertJournalNoFail();
    // The form is locked after the save.
    cy.contains('label', 'Name').siblings('.MuiInputBase-root').find('input').should('be.disabled');
    gql(`{ payers(name_Icontains: "${name}") { edges { node { uuid } } } }`).then((data) => {
      expect(data.payers.edges, 'created payer').to.have.length(1);
      seeded.payers.push(data.payers.edges[0].node.uuid);
    });
    searchPayer(name);
    cy.contains('tbody tr', name).should('contain', 'Donor');
  });

  it('Deletes a payer (OCM-313)', () => {
    seedPayer('D').then((payer) => {
      searchPayer(payer.name);
      rowAction(payer.name, 'Delete Payer');
      dialog().should('contain', 'Delete Payer').and('contain', `Are you sure to delete the payer ${payer.name}?`);
      dialog().find('button.primaryButton').click();
      cy.waitForJournalProgress();
      cy.assertJournalFirstEntryContains(`Delete payer ${payer.name}`);
      cy.assertJournalNoFail();
      searchPayer(payer.name);
      cy.contains('tbody tr', payer.name).should('not.exist');
      searchPayer(payer.name, { history: true });
      cy.contains('tbody tr', payer.name).should('exist');
    });
  });

  it('Modifies a payer (OCM-314)', () => {
    const phone = `07${Date.now().toString().slice(-8)}`;
    seedPayer('M').then((payer) => {
      searchPayer(payer.name);
      cy.contains('tbody tr', payer.name).dblclick({ force: true });
      cy.url().should('include', `/payer/payers/overview/`);
      cy.contains(`Payer ${payer.name}`).should('be.visible');
      cy.contains('Fundings').should('exist');
      typeIn('Phone', phone);
      cy.clickSave('Save changes');
      cy.waitForJournalProgress();
      cy.assertJournalFirstEntryContains(`Update payer ${payer.name}`);
      cy.assertJournalNoFail();
      cy.reload();
      cy.assertMuiInput('Phone', phone);
    });
  });
});

describe('UAT Accounting - Payments', () => {
  const kept = `UATP${runId}K`;
  const removed = `UATP${runId}X`;

  before(() => {
    cy.login();
    seedPayment(kept);
    // A deleted payment, for the historical values filter.
    seedPayment(removed).then((uuid) => mutate('deletePayment', `uuids: ["${uuid}"]`));
  });

  beforeEach(() => cy.login());

  it('Searches for a payment (OCM-310)', () => {
    cy.visit('/front/payment/payments');
    cy.waitForSearcherLoaded();
    searcherTitle(/\d+ payment\(s\) found/).should('exist');

    typeIn('Receipt No', kept);
    cy.contains('button', 'Search').click({ force: true });
    searcherTitle(/^\s*1 payment\(s\) found/).should('exist');
    cy.get('tbody tr').should('have.length', 1).first().should('contain', kept);

    cy.contains('label', 'Receipt No').siblings('.MuiInputBase-root').find('input').clear({ force: true });
    pickToday('Received date from');
    pickToday('Received date to');
    cy.contains('button', 'Search').click({ force: true });
    cy.waitForSearcherLoaded();
    cy.contains('tbody tr', kept).should('exist');
    cy.contains('tbody tr', removed).should('not.exist');
    resultCount(/payment\(s\) found/).then((current) => {
      cy.contains('label', 'Show historical values').click();
      cy.contains('button', 'Search').click({ force: true });
      cy.contains('tbody tr', removed, { timeout: TIMEOUTS.SERVER_RESULT }).should('exist');
      resultCount(/payment\(s\) found/).should('be.gte', current + 1);
    });
  });

  it('Deletes a payment (OCM-311)', () => {
    const receipt = `UATP${runId}D`;
    seedPayment(receipt);
    cy.visit('/front/payment/payments');
    cy.waitForSearcherLoaded();
    typeIn('Receipt No', receipt);
    cy.contains('button', 'Search').click({ force: true });
    rowAction(receipt, 'Delete payment');
    dialog().should('contain', 'Delete payment').and('contain', 'Are you sure you want to delete this payment?');
    dialog().contains('button', 'Yes').click();
    cy.waitForJournalProgress();
    cy.assertJournalNoFail();
    cy.contains('button', 'Search').click({ force: true });
    cy.waitForSearcherLoaded();
    cy.contains('tbody tr', receipt).should('not.exist');
    cy.contains('label', 'Show historical values').click();
    cy.contains('button', 'Search').click({ force: true });
    cy.contains('tbody tr', receipt).should('exist');
  });
});
