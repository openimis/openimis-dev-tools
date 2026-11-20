// ------------------ TEST DATA ------------------
// Codes are unique per run (max 6 characters): demo item/service 0002 already exists.
const runId = Date.now().toString(36).slice(-5).toUpperCase();

const item = {
  code: `I${runId}`,
  name: 'Item Test Cypress',
  type: 'Drug',
  frequency: '1', // days; the field is free text but the backend stores a number
  package: '10 PIECES',
  quantity: 50,
  maximumAmount: 1000,
  price: 4500,
  careType: 'In - Patient',
  patientCategory: 'ADULT',
};

const service = {
  code: `S${runId}`,
  name: 'Service Test Cypress',
  packagetype: 'Simple/atomic',
  type: 'Curative',
  category: 'Surgery',
  level: 'Simple Service',
  maximumAmount: 2000,
  price: 5000,
  careType: 'Out - Patient',
  frequency: '2', // days
  patientCategory: 'CHILD',
};

// ------------------ ITEM ------------------
const goToItemList = () => {
  cy.goToSubMenu('Administration', '/front/medical/medicalItems');
};

const goToNewItemForm = () => {
  goToItemList();
  cy.get('[aria-label="Add a new medical item"]').find('button').click();
};

const goToExistingItemForm = (data) => {
  goToItemList();

  cy.enterMuiInput('Code', data.code, 'input');
  cy.contains('button', 'Search').click({ force: true });
  cy.openRowByValue(data.code);
};

const fillItemForm = (data) => {
  cy.enterMuiInput('Code', data.code);
  cy.enterMuiInput('Name', data.name);
  cy.chooseMuiSelect('Item Type', data.type);
  cy.enterMuiInput('Frequency (days)', data.frequency ?? '');
  cy.enterMuiInput('Package', data.package ?? '');
  cy.enterMuiInput('Quantity', data.quantity ?? '');
  cy.enterMuiInput('Maximum Amount per Claim', data.maximumAmount ?? '');
  cy.enterMuiInput('Price', data.price ?? '');
  cy.chooseMuiSelect('Care Type', data.careType);
};

const verifyItemDetails = (data, updatedData = null) => {
  data = updatedData ? { ...data, ...updatedData } : data;

  goToExistingItemForm(data);

  cy.verifyMuiInputValue('Code', data.code);
  cy.verifyMuiInputValue('Name', data.name);
  cy.verifyMuiSelectValue('Item Type', data.type);
  cy.verifyMuiInputValue('Frequency (days)', data.frequency ?? '');
  cy.verifyMuiInputValue('Package', data.package ?? '');
  cy.verifyMuiInputValue('Quantity', data.quantity ?? '');
  cy.verifyMuiInputValue('Maximum Amount per Claim', data.maximumAmount ?? '');
  cy.verifyMuiInputValue('Price', data.price ?? '');
  cy.verifyMuiSelectValue('Care Type', data.careType);
};

const verifyItemRemoved = (data) => {
  goToItemList();

  cy.enterMuiInput('Code', data.code, 'input');
  cy.contains('button', 'Search').click({ force: true });
  cy.waitForSearcherLoaded();
  cy.get('tbody').should('not.contain.text', data.code);
};

const deleteItem = (data, { failIfMissing = true } = {}) => {
  goToItemList();

  cy.enterMuiInput('Code', data.code, 'input');
  cy.contains('button', 'Search').click({ force: true });
  cy.waitForSearcherLoaded();

  const remove = () => {
    cy.clickRowAction(data.code, 'Delete');
    cy.contains('button', 'Yes', { matchCase: false }).click();
  };
  if (failIfMissing) {
    // Retries until the filtered result shows the row.
    cy.contains('tbody tr', data.code).then(remove);
    return;
  }
  // Clean-up: the item may not exist (the test failed before creating it).
  cy.get('body').then(($body) => {
    if ($body.find('tbody tr').toArray().some((row) => row.innerText.includes(data.code))) remove();
  });
};

// ------------------ SERVICE ------------------
const goToServiceList = () => {
  cy.goToSubMenu('Administration', '/front/medical/medicalServices');
};

const goToNewServiceForm = () => {
  goToServiceList();
  cy.get('[aria-label="Add a new medical service"]').find('button').click();
};

const goToExistingServiceForm = (data) => {
  goToServiceList();

  cy.enterMuiInput('Code', data.code, 'input');
  cy.contains('button', 'Search').click({ force: true });
  cy.openRowByValue(data.code);
};

const fillServiceForm = (data) => {
  cy.enterMuiInput('Code', data.code);
  cy.enterMuiInput('Name', data.name);
  cy.chooseMuiSelect('Type', data.packagetype);
  cy.chooseMuiSelect('Service Type', data.type);
  cy.chooseMuiSelect('Service Category', data.category);
  cy.chooseMuiSelect('Service Level', data.level);
  cy.enterMuiInput('Maximum Amount per Claim', data.maximumAmount ?? '');
  cy.enterMuiInput('Price', data.price ?? '');
  cy.chooseMuiSelect('Care Type', data.careType);
  cy.enterMuiInput('Frequency (days)', data.frequency ?? '');
};

const verifyServiceDetails = (data, updatedData = null) => {
  data = updatedData ? { ...data, ...updatedData } : data;

  goToExistingServiceForm(data);

  cy.verifyMuiInputValue('Code', data.code);
  cy.verifyMuiInputValue('Name', data.name);
  cy.verifyMuiSelectValue('Type', data.packagetype);
  cy.verifyMuiSelectValue('Service Type', data.type);
  cy.verifyMuiSelectValue('Service Category', data.category);
  cy.verifyMuiSelectValue('Service Level', data.level);
  cy.verifyMuiInputValue('Maximum Amount per Claim', data.maximumAmount ?? '');
  cy.verifyMuiInputValue('Price', data.price ?? '');
  cy.verifyMuiSelectValue('Care Type', data.careType);
  cy.verifyMuiInputValue('Frequency (days)', data.frequency ?? '');
};

const verifyServiceRemoved = (data) => {
  goToServiceList();

  cy.enterMuiInput('Code', data.code, 'input');
  cy.contains('button', 'Search').click({ force: true });
  cy.waitForSearcherLoaded();
  cy.get('tbody').should('not.contain.text', data.code);
};

const deleteService = (data, { failIfMissing = true } = {}) => {
  goToServiceList();

  cy.enterMuiInput('Code', data.code, 'input');
  cy.contains('button', 'Search').click({ force: true });
  cy.waitForSearcherLoaded();

  const remove = () => {
    cy.clickRowAction(data.code, 'Delete');
    cy.contains('button', 'Yes', { matchCase: false }).click();
  };
  if (failIfMissing) {
    // Retries until the filtered result shows the row.
    cy.contains('tbody tr', data.code).then(remove);
    return;
  }
  // Clean-up: the service may not exist (the test failed before creating it).
  cy.get('body').then(($body) => {
    if ($body.find('tbody tr').toArray().some((row) => row.innerText.includes(data.code))) remove();
  });
};

// ------------------ TEST ------------------
describe('Medical Items & Services Workflow', () => {

  afterEach(() => {
    cy.login();
    deleteService(service, { failIfMissing: false });
    deleteItem(item, { failIfMissing: false });
  });

  it('should execute complete medical flow cleanly', () => {

    cy.login();

    // --- Create item ---
    goToNewItemForm();
    fillItemForm(item);
    cy.save();
    verifyItemDetails(item);

    // --- Create service ---
    goToNewServiceForm();
    fillServiceForm(service);
    cy.save();
    verifyServiceDetails(service);

    // --- Update item ---
    goToExistingItemForm(item);
    cy.enterMuiInput('Frequency (days)', '3');
    cy.save();
    verifyItemDetails(item, { frequency: '3' });

    // --- Update service ---
    goToExistingServiceForm(service);
    cy.enterMuiInput('Frequency (days)', '4');
    cy.save();
    verifyServiceDetails(service, { frequency: '4' });

    // --- Delete item ---
    deleteItem(item);
    verifyItemRemoved(item);

    // --- Delete service ---
    deleteService(service);
    verifyServiceRemoved(service);

  });

});