// UAT: Benefit Plan / Medical items and medical services (create, modify, delete, history).
// Codes are at most 6 characters and unique per run.
const runId = Date.now().toString(36).slice(-5).toUpperCase();

// ------------------ MUTATION CHECK ------------------
// The journal label does not carry the code, and other specs may run mutations at the
// same time: catch the mutation the page sends and check its own MutationLog.
const watchMutation = (operation) => {
  cy.intercept('POST', '/api/graphql', (req) => {
    const query = typeof req.body === 'string' ? req.body : req.body?.query;
    if (new RegExp(`mutation[^{]*\\{\\s*${operation}\\b`).test(query ?? '')) req.alias = `mut_${operation}`;
  });
};

const expectMutationSucceeded = (operation, label) => {
  cy.wait(`@mut_${operation}`).then(({ request }) => {
    const query = typeof request.body === 'string' ? request.body : request.body.query;
    const id = request.body.variables?.input?.clientMutationId ?? query.match(/clientMutationId:\s*"([^"]+)"/)[1];
    if (label) expect(query, 'journal label').to.match(new RegExp(`clientMutationLabel:\\s*"${label}`));
    cy.waitForMutationLog(id).then(({ status, error }) => {
      expect(status, `${operation} processed without error (${error})`).to.eq(2);
    });
  });
  cy.waitForJournalProgress();
};

// ------------------ HELPERS ------------------
const KINDS = {
  item: {
    list: '/front/medical/medicalItems',
    newTitle: 'New Medical Item',
    detailsTitle: 'Medical Item details',
    addFab: 'Add a new medical item',
    create: ['createItem', 'Create Medical Item'],
    update: ['updateItem', 'Update Medical Item'],
    remove: 'deleteItem',
    deleteMessage: 'Are you sure you want to delete this item?',
    summary: /medical item\(s\) found/i,
  },
  service: {
    list: '/front/medical/medicalServices',
    newTitle: 'New Medical Service',
    detailsTitle: 'Medical Service details',
    addFab: 'Add a new medical service',
    create: ['createService', 'Create Medical Service'],
    update: ['updateService', 'Update Medical Service'],
    remove: 'deleteService',
    deleteMessage: 'Are you sure you want to delete this service?',
    summary: /medical service\(s\) found/i,
  },
};

const PATIENT_CATEGORIES = ['Male', 'Female', 'Adult', 'Minor'];

const historyCheckbox = () => cy.contains('label', /show historical values/i).find('input[type="checkbox"]');

const searchByCode = (kind, code, { history = false } = {}) => {
  cy.visit(KINDS[kind].list);
  cy.contains(KINDS[kind].summary);
  cy.enterMuiInput('Code', code);
  if (history) historyCheckbox().check({ force: true });
  cy.contains('button', 'Search').click({ force: true });
  cy.waitForSearcherLoaded();
};

const rowsWithCode = (code) => cy.get('tbody tr').filter((_, tr) => tr.innerText.includes(code));

const openNewForm = (kind) => {
  cy.visit(KINDS[kind].list);
  cy.contains(KINDS[kind].summary);
  cy.get(`[aria-label="${KINDS[kind].addFab}"]`).find('button').click();
  cy.location('pathname').should('eq', `${KINDS[kind].list}/new`);
  cy.contains(KINDS[kind].newTitle).should('be.visible');
  // All patient categories are ticked on a new form.
  PATIENT_CATEGORIES.forEach((category) => {
    cy.contains('label', new RegExp(`^${category}$`)).find('input[type="checkbox"]').should('be.checked');
  });
};

// Save is not offered (or disabled) until the form is complete.
const assertNoEnabledSave = () => {
  cy.get('body').then(($body) => {
    const $buttons = $body.find('[aria-label="Save changes"] button');
    if ($buttons.length) expect($buttons.is(':disabled'), 'Save disabled').to.be.true;
  });
};

const fillItem = (data) => {
  cy.enterMuiInput('Code', data.code);
  cy.enterMuiInput('Name', data.name);
  cy.chooseMuiSelect('Item Type', data.type);
  if (data.frequency) cy.enterMuiInput('Frequency (days)', data.frequency);
  cy.enterMuiInput('Price', data.price);
  cy.chooseMuiSelect('Care Type', data.careType);
};

const fillService = (data) => {
  cy.enterMuiInput('Code', data.code);
  cy.enterMuiInput('Name', data.name);
  cy.chooseMuiSelect('Type', data.packagetype);
  cy.chooseMuiSelect('Service Type', data.type);
  cy.chooseMuiSelect('Service Category', data.category);
  cy.chooseMuiSelect('Service Level', data.level);
  cy.enterMuiInput('Price', data.price);
  cy.chooseMuiSelect('Care Type', data.careType);
  if (data.frequency) cy.enterMuiInput('Frequency (days)', data.frequency);
};

// Creates through the UI and checks the code is free, the journal and the list.
const createThroughUi = (kind, data) => {
  openNewForm(kind);
  assertNoEnabledSave();
  (kind === 'item' ? fillItem : fillService)(data);
  cy.contains('Code already taken').should('not.exist');
  watchMutation(KINDS[kind].create[0]);
  cy.save();
  expectMutationSucceeded(...KINDS[kind].create);
  searchByCode(kind, data.code);
  rowsWithCode(data.code).should('have.length', 1).and('contain.text', data.name);
};

const openByCode = (kind, code) => {
  searchByCode(kind, code);
  cy.openRowByValue(code);
  cy.location('pathname').should('match', new RegExp(`${KINDS[kind].list}/overview/[0-9a-f-]{36}$`));
  cy.contains(KINDS[kind].detailsTitle).should('be.visible');
};

// A read-only fe-core SelectInput renders a plain read-only text input, without combobox.
// Every field of a saved item or service stays editable, the classification pickers too.
const assertSelectEditable = (label) => {
  cy.contains('label', label, { matchCase: false })
    .closest('.MuiFormControl-root')
    .find('[role="combobox"]')
    .should('exist')
    .and('not.have.attr', 'aria-disabled', 'true');
};

const deleteThroughUi = (kind, code) => {
  searchByCode(kind, code);
  rowsWithCode(code).should('have.length', 1);
  cy.clickRowAction(code, 'Delete');
  cy.get('[role="dialog"]').should('contain.text', 'Confirm delete').and('contain.text', KINDS[kind].deleteMessage);
  watchMutation(KINDS[kind].remove);
  cy.contains('[role="dialog"] button', 'Yes', { matchCase: false }).click();
  expectMutationSucceeded(KINDS[kind].remove);
};

// Clean-up through the API: delete every still-valid row of the given codes.
const gql = (query) => cy.request({ method: 'POST', url: '/api/graphql', body: { query }, failOnStatusCode: false, log: false });
const cleanUp = (kind, codes) => {
  const [list, op] = kind === 'item' ? ['medicalItems', 'deleteItem'] : ['medicalServices', 'deleteService'];
  codes.forEach((code) => {
    gql(`{ ${list}(code: "${code}") { edges { node { uuid } } } }`).then(({ body }) => {
      const uuids = (body?.data?.[list]?.edges ?? []).map((e) => `"${e.node.uuid}"`);
      if (uuids.length) gql(`mutation { ${op}(input: { clientMutationId: "cleanup-${code}-${Date.now()}" clientMutationLabel: "UAT cleanup ${code}" uuids: [${uuids.join(',')}] }) { clientMutationId } }`);
    });
  });
};

// ------------------ DATA ------------------
const item = {
  code: `I${runId}`,
  name: `UAT item ${runId}`,
  type: 'Drug',
  frequency: '1',
  price: '4500',
  careType: 'In - Patient',
};
const itemChanges = { name: `UAT item ${runId} upd`, price: '4600', frequency: '3', careType: 'Out - Patient' };
const visitItem = {
  code: `V${runId}`,
  name: 'Visit and Hospitalization test',
  type: 'Drug',
  price: '500',
  careType: 'In & Out - Patient',
};

const service = {
  code: `S${runId}`,
  name: `UAT service ${runId}`,
  packagetype: 'Simple/atomic',
  type: 'Curative',
  category: 'Surgery',
  level: 'Simple Service',
  price: '5000',
  careType: 'Out - Patient',
  frequency: '2',
};
const serviceChanges = { name: `UAT service ${runId} upd`, price: '5100', frequency: '4', careType: 'In - Patient' };

const categoryService = (prefix, category, ocm) => ({
  ocm,
  code: `${prefix}${runId}`,
  name: category,
  packagetype: 'Simple/atomic',
  type: 'Curative',
  category,
  level: 'Simple Service',
  price: '1000',
  careType: 'In & Out - Patient',
});
const categoryServices = [
  categoryService('C', 'Consultation', 711),
  categoryService('U', 'Surgery', 712),
  categoryService('D', 'Delivery', 714),
  categoryService('A', 'Antenatal', 716),
];

// ------------------ TESTS ------------------
describe('UAT Benefit plan - Medical items and services', () => {
  beforeEach(() => {
    cy.login();
  });

  after(() => {
    cy.login();
    cleanUp('item', [item.code, visitItem.code]);
    cleanUp('service', [service.code, ...categoryServices.map((s) => s.code)]);
  });

  describe('Medical items', () => {
    it('adds a medical item (OCM-179)', () => {
      createThroughUi('item', item);
    });

    it('modifies a medical item (OCM-181)', () => {
      openByCode('item', item.code);
      cy.enterMuiInput('Name', itemChanges.name);
      cy.enterMuiInput('Price', itemChanges.price);
      cy.enterMuiInput('Frequency (days)', itemChanges.frequency);
      watchMutation('updateItem');
      cy.save();
      expectMutationSucceeded(...KINDS.item.update);

      searchByCode('item', item.code);
      rowsWithCode(item.code).should('have.length', 1).and('contain.text', itemChanges.name);
      cy.openRowByValue(item.code);
      cy.verifyMuiInputValue('Name', itemChanges.name);
      cy.verifyMuiInputValue('Price', itemChanges.price);
      cy.verifyMuiInputValue('Frequency (days)', itemChanges.frequency);
      // Then a classification picker (OP-3291): a second save, so the modification above
      // (needed by OCM-183) is made even if this fails.
      assertSelectEditable('Item Type');
      cy.chooseMuiSelect('Care Type', itemChanges.careType);
      watchMutation('updateItem');
      cy.save();
      expectMutationSucceeded(...KINDS.item.update);
      searchByCode('item', item.code);
      cy.openRowByValue(item.code);
      cy.verifyMuiSelectValue('Care Type', itemChanges.careType);
    });

    it('deletes a medical item (OCM-180)', () => {
      deleteThroughUi('item', item.code);
      searchByCode('item', item.code);
      rowsWithCode(item.code).should('have.length', 0);
      searchByCode('item', item.code, { history: true });
      rowsWithCode(item.code).should('have.length.at.least', 1);
    });

    it('finds all edited and deleted medical items (OCM-183)', () => {
      searchByCode('item', item.code);
      rowsWithCode(item.code).should('have.length', 0);
      // Created, modified then deleted: the original version and the deleted one.
      searchByCode('item', item.code, { history: true });
      rowsWithCode(item.code).should('have.length.at.least', 2);
      rowsWithCode(item.code).filter(`:contains("${item.name}")`).should('exist');
      rowsWithCode(item.code).filter(`:contains("${itemChanges.name}")`).should('exist');
    });

    it('adds a medical item for visit and hospitalization (OCM-718)', () => {
      createThroughUi('item', visitItem);
      cy.openRowByValue(visitItem.code);
      cy.verifyMuiSelectValue('Care Type', visitItem.careType);
      cy.verifyMuiInputValue('Price', visitItem.price);
    });
  });

  describe('Medical services', () => {
    it('adds a medical service (OCM-184)', () => {
      createThroughUi('service', service);
    });

    it('modifies a medical service (OCM-186)', () => {
      openByCode('service', service.code);
      cy.enterMuiInput('Name', serviceChanges.name);
      cy.enterMuiInput('Price', serviceChanges.price);
      cy.enterMuiInput('Frequency (days)', serviceChanges.frequency);
      watchMutation('updateService');
      cy.save();
      expectMutationSucceeded(...KINDS.service.update);

      searchByCode('service', service.code);
      rowsWithCode(service.code).should('have.length', 1).and('contain.text', serviceChanges.name);
      cy.openRowByValue(service.code);
      cy.verifyMuiInputValue('Name', serviceChanges.name);
      cy.verifyMuiInputValue('Price', serviceChanges.price);
      cy.verifyMuiInputValue('Frequency (days)', serviceChanges.frequency);
      // Then a classification picker (OP-3291), in a second save (see OCM-181).
      ['Service Type', 'Service Category', 'Service Level'].forEach(assertSelectEditable);
      cy.chooseMuiSelect('Care Type', serviceChanges.careType);
      watchMutation('updateService');
      cy.save();
      expectMutationSucceeded(...KINDS.service.update);
      searchByCode('service', service.code);
      cy.openRowByValue(service.code);
      cy.verifyMuiSelectValue('Care Type', serviceChanges.careType);
    });

    it('deletes a medical service (OCM-185)', () => {
      deleteThroughUi('service', service.code);
      searchByCode('service', service.code);
      rowsWithCode(service.code).should('have.length', 0);
      searchByCode('service', service.code, { history: true });
      rowsWithCode(service.code).should('have.length.at.least', 1);
    });

    it('finds all edited and deleted medical services (OCM-188)', () => {
      searchByCode('service', service.code);
      rowsWithCode(service.code).should('have.length', 0);
      searchByCode('service', service.code, { history: true });
      rowsWithCode(service.code).should('have.length.at.least', 2);
      rowsWithCode(service.code).filter(`:contains("${service.name}")`).should('exist');
      rowsWithCode(service.code).filter(`:contains("${serviceChanges.name}")`).should('exist');
    });

    categoryServices.forEach((data) => {
      it(`adds a medical service - ${data.category} (OCM-${data.ocm})`, () => {
        createThroughUi('service', data);
        cy.openRowByValue(data.code);
        cy.verifyMuiSelectValue('Service Category', data.category);
        cy.verifyMuiSelectValue('Care Type', data.careType);
      });
    });
  });
});
