import { baseline } from "../support/baseline";
import { TIMEOUTS } from "../support/constants";

const dateParts = (daysFromToday) => {
  const d = new Date();
  d.setDate(d.getDate() + daysFromToday);
  const pad = (n) => String(n).padStart(2, '0');
  return { day: pad(d.getDate()), month: pad(d.getMonth() + 1), year: String(d.getFullYear()) };
};

const runId = Date.now().toString(36).slice(-5).toUpperCase();

// ------------------ TEST DATA ------------------
const product = {
  code: `P${runId}`, // unique per run: product codes are unique and a failed run leaves its product
  name: "Produit Test Cypress",
  maxMembers: "10",
  threshold: "5",
  insurancePeriod: "12",
  administrationPeriod: "2",
  recurrence: "1",
  ageMinimal: "18",
  ageMaximal: "65",
  // A new product cannot start in the past (Date from has disablePast).
  dateFrom: dateParts(1),
  dateTo: dateParts(366),
  // Filled in before() from the baseline. District r1d2 (region r1) replaces the
  // demo district: the product is not linked to a family or a health facility,
  // so the district only has to exist. Items and services are baseline records.
  region: "",
  district: "",
  services: [],
  items: [],
};

const updatedProduct = {
  name: "Produit Test Cypress Updated",
  maxMembers: "20",
};

// ------------------ NAVIGATION ------------------
const goToProductList = () => {
  cy.goToSubMenu('Administration', 'Products');
};

const goToNewProductForm = () => {
  goToProductList();
  cy.get('[aria-label="Add new product"]').click();
};

const goToExistingProductForm = (product) => {
  goToProductList();

  cy.enterMuiInput('Code', product.code, 'input');
  cy.contains('button', 'Search').click({ force: true });
  cy.openRowByValue(product.code);
};

// ------------------ FORM ------------------
const fillProductForm = (product) => {
  cy.enterMuiInput('Code', product.code);
  cy.enterMuiInput('Name', product.name);
  cy.enterMuiInput('Max members', product.maxMembers);
  cy.enterMuiInput('Threshold', product.threshold);
  cy.enterMuiInput('Insurance period', product.insurancePeriod);
  cy.enterMuiInput('Administration period', product.administrationPeriod);
  cy.enterMuiInput('Recurrence', product.recurrence);
  cy.enterMuiInput('Minimum Age', product.ageMinimal);
  cy.enterMuiInput('Maximum Age', product.ageMaximal);

  cy.chooseMuiSelect('Region', product.region);
  cy.chooseMuiSelect('District', product.district);

  cy.chooseMuiDatePicker('Date from', product.dateFrom);
  cy.chooseMuiDatePicker('Date to', product.dateTo);

  addProductItems(product.items);
  addProductServices(product.services);
};

const updateProduct = (product, updatedData) => {
  goToExistingProductForm(product);

  if (updatedData.name) {
    cy.enterMuiInput('Name', updatedData.name);
  }

  if (updatedData.maxMembers) {
    cy.enterMuiInput('Max members', updatedData.maxMembers);
  }

  cy.save();
};

// ------------------ ITEMS & SERVICES ------------------
const addProductItems = (items) => {
  cy.contains('button', 'Medical Items', { matchCase: false }).click();
  cy.contains('button', 'Add Items', { matchCase: false }).click();

  items.forEach(item => {
    // The dialog's picker shows no placeholder: take its (only) input.
    cy.get('[role="dialog"] input').first().clear().type(item.code);

    cy.get('body')
      .contains('li[role="option"]', item.code)
      .should('be.visible')
      .click({ force: true });
  });

  // The picker's option list stays open over the dialog's button (multi-select: neither
  // Escape nor a blur closes it): click the button through it.
  cy.contains('button', `Add ${items.length} items`, { matchCase: false }).click({ force: true });
};

const addProductServices = (services) => {
  cy.contains('button', 'Medical Services', { matchCase: false }).click();
  cy.contains('button', 'Add Services', { matchCase: false }).click();

  services.forEach(service => {
    // The dialog's picker shows no placeholder: take its (only) input.
    cy.get('[role="dialog"] input').first().clear().type(service.code);

    cy.get('body')
      .contains('li[role="option"]', service.code)
      .should('be.visible')
      .click({ force: true });
  });

  // The picker's option list stays open over the dialog's button (multi-select: neither
  // Escape nor a blur closes it): click the button through it.
  // The services dialog reuses ProductItemsDialog's texts: it reads "Add N items".
  cy.contains('button', new RegExp(`^Add ${services.length} (services|items)$`, 'i')).click({ force: true });
};

// ------------------ HELPERS ------------------
const formatDate = ({ day, month, year }) => {
  const d = String(day).padStart(2, '0');
  const m = String(month).padStart(2, '0');
  return `${d}-${m}-${year}`;
};

// ------------------ VERIFY ------------------
const verifyProductDetails = (product, updatedData = null) => {
  product = updatedData ? { ...product, ...updatedData } : product;

  goToExistingProductForm(product);

  cy.verifyMuiInputValue('Code', product.code);
  cy.verifyMuiInputValue('Name', product.name);
  cy.verifyMuiInputValue('Max members', product.maxMembers);
  cy.verifyMuiInputValue('Threshold', product.threshold);
  cy.verifyMuiInputValue('Insurance period', product.insurancePeriod);
  cy.verifyMuiInputValue('Administration period', product.administrationPeriod);
  cy.verifyMuiInputValue('Recurrence', product.recurrence);
  cy.verifyMuiInputValue('Minimum Age', product.ageMinimal);
  cy.verifyMuiInputValue('Maximum Age', product.ageMaximal);

  cy.verifyMuiDatePickerValue('Date from', formatDate(product.dateFrom));
  cy.verifyMuiDatePickerValue('Date to', formatDate(product.dateTo));

  // The form opens on the Contribution Plan tab: the item and service grids render only on their tabs.
  cy.contains('button', 'Medical Items', { matchCase: false }).click();
  product.items.forEach(item => {
    cy.contains(item.code).should('exist');
  });

  cy.contains('button', 'Medical Services', { matchCase: false }).click();
  product.services.forEach(service => {
    cy.contains(service.code).should('exist');
  });
};

// The search answers later than the click: wait for the filtered title ("0 Products" or
// "1 Products", the unfiltered list has more) before reading the rows once.
const searchProductByCode = (code) => {
  cy.enterMuiInput('Code', code, 'input');
  cy.contains('button', 'Search').click({ force: true });
  cy.contains('.paperHeaderTitle, .tableTitle h6', /^\s*[01] Products\s*$/, { timeout: TIMEOUTS.BACKEND_VALIDATION });
};

const verifyProductRemoved = (product) => {
  goToProductList();

  searchProductByCode(product.code);

  cy.get('body').then(($body) => {
    const exists = $body.find('tr').toArray().some(row =>
      row.innerText.includes(product.code)
    );

    expect(exists).to.be.false;
  });
};

// ------------------ DELETE ------------------
const deleteProduct = (product, { failIfMissing = true } = {}) => {
  goToProductList();

  searchProductByCode(product.code);

  cy.get('body').then(($body) => {
    const exists = $body.find('tr').toArray().some(row =>
      row.innerText.includes(product.code)
    );

    if (!exists) {
      if (!failIfMissing) return;
      throw new Error(`Product ${product.code} not found`);
    }

    cy.clickRowAction(product.code, 'Delete');

    cy.contains('button', 'OK', { matchCase: false }).click();
    // The delete is queued: let it finish before the list is searched again.
    cy.waitForJournalProgress();
  });
};

// ------------------ TEST ------------------
describe('Product Workflow', () => {

  before(() => {
    const B = baseline();
    product.region = B.locations.r1.label;
    product.district = B.locations.r1d2.label;
    product.items = B.items.slice(0, 2).map((item) => ({ code: item.code }));
    product.services = B.services.slice(0, 2).map((service) => ({ code: service.code }));
  });

  afterEach(() => {
    cy.login();
    deleteProduct(product, { failIfMissing: false });
  });

  it('should execute complete product flow cleanly', () => {

    cy.login();

    // --- Create ---
    goToNewProductForm();
    fillProductForm(product);
    cy.save();
    verifyProductDetails(product);

    // --- Update ---
    updateProduct(product, updatedProduct);
    verifyProductDetails(product, updatedProduct);

    // --- Delete ---
    deleteProduct(product);
    verifyProductRemoved(product);

  });

});