import { baseline } from '../support/baseline';

// UAT: Benefit Plan / Products.
// Products are created with unique codes (<= 8 characters) and a Date From in the future
// (a new product cannot start in the past); every product created here is deleted in after().
// Items and services added to the basic product are baseline records (read when the test
// runs). The category services and the visit/hospitalization item the limit cases need
// are seeded through the API: the baseline has no delivery-category service and no item
// used only as a visit/hospitalization counter.
// District r1d2 (region r1) replaces the demo district. The product is not linked to a family
// or a health facility, so the district only has to exist.
const itemCode = (index) => baseline().items[index].code;
const serviceCode = (index) => baseline().services[index].code;
const runId = Date.now().toString(36).slice(-5).toUpperCase();

const addDays = (days) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d;
};
const dateParts = (d) => ({ day: d.getDate(), month: d.getMonth() + 1, year: d.getFullYear() });
const dmy = (d) => `${String(d.getDate()).padStart(2, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${d.getFullYear()}`;
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
// The searcher formats dates with formatDateFromISO (ISO in this set-up); accept either form.
const hasDate = (el, d) => el.innerText.includes(iso(d)) || el.innerText.includes(dmy(d));
// Deductibles & Ceilings tables: 0 deductible, 1 ceiling, 2 maximum numbers. Their header
// is not a <thead>: row 0 is the header, row 1 the ceiling-type row. The rows are rendered
// as <div role="row"> (TableRow with a styled div component), not <tr>.
const TABLE_ROW = 'tr, [role="row"]';
const tableHeader = (i) => cy.get('table').eq(i).find(TABLE_ROW).first();
const tableRow = (i) => cy.get('table').eq(i).find(TABLE_ROW).eq(1);
const DATE_FROM = addDays(1);
const DATE_TO = addDays(366);

// ------------------ API ------------------
const gql = (query) => cy.request({ method: 'POST', url: '/api/graphql', body: { query }, log: false })
  .then(({ body }) => {
    if (body.errors?.length) throw new Error(JSON.stringify(body.errors));
    return body.data;
  });

const mutate = (name, input, label) => {
  const id = `uat-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  return gql(`mutation { ${name}(input: { clientMutationId: "${id}" clientMutationLabel: "${label}" ${input} }) { clientMutationId } }`)
    .then(() => cy.waitForMutationLog(id))
    .then(({ status, error }) => {
      if (status !== 2) throw new Error(`${label} failed: ${error}`);
    });
};

// Journal labels carry the product name, unique per run.
const expectMutationSucceeded = (label, { timeout = 5000 } = {}) => {
  cy.waitForJournalProgress();
  const deadline = Date.now() + timeout;
  const poll = () => gql(`{ mutationLogs(clientMutationLabel: "${label}", first: 1, orderBy: "-request_date_time") { edges { node { status error } } } }`)
    .then((data) => {
      const node = data.mutationLogs.edges[0]?.node;
      if (node && node.status !== 0) {
        expect(node.status, `"${label}" succeeded (${node.error})`).to.eq(2);
        return;
      }
      if (Date.now() > deadline) throw new Error(`Mutation "${label}" not found or not processed`);
      cy.wait(1000, { log: false }).then(poll);
    });
  poll();
};

const createdProducts = new Set();

// ------------------ UI HELPERS ------------------
const searchProducts = (code, { history = false } = {}) => {
  cy.visit('/front/admin/products');
  cy.contains(/\d+ Products/);
  cy.enterMuiInput('Code', code);
  if (history) cy.contains('label', 'Show Historical Values').find('input[type="checkbox"]').check({ force: true });
  cy.contains('button', 'Search').click({ force: true });
  cy.waitForSearcherLoaded();
};

const productRows = (code) => cy.get('tbody tr').filter((_, tr) => tr.innerText.includes(code));

const openProduct = (code) => {
  searchProducts(code);
  productRows(code).should('have.length', 1).first().dblclick({ force: true });
  cy.location('pathname').should('match', /\/front\/admin\/products\/[0-9a-f-]{36}$/);
  cy.contains('label', 'Name').siblings('.MuiInputBase-root').find('input').should('not.have.value', '');
};

const openTab = (label) => cy.contains('button, [role="tab"]', label, { matchCase: false }).click();

const fillHeader = (product) => {
  cy.enterMuiInput('Code', product.code);
  cy.enterMuiInput('Name', product.name);
  if (product.region) {
    cy.chooseMuiSelect('Region', product.region);
    cy.chooseMuiSelect('District', product.district);
  }
  cy.chooseMuiDatePicker('Date from', dateParts(DATE_FROM));
  cy.chooseMuiDatePicker('Date to', dateParts(DATE_TO));
  cy.contains('Product code already in use').should('not.exist');
};

const openNewProduct = () => {
  cy.visit('/front/admin/products');
  cy.contains(/\d+ Products/);
  cy.get('[aria-label="Add new product"]').click();
  cy.location('pathname').should('eq', '/front/admin/products/new');
  cy.contains('New Product').should('be.visible');
};

// Adds items or services through the tab's dialog ("Add items" / "Add services").
const addToGrid = (kind, codes) => {
  openTab(kind === 'items' ? 'Medical Items' : 'Medical Services');
  cy.contains('button', kind === 'items' ? 'Add Items' : 'Add Services', { matchCase: false }).click();
  codes.forEach((code) => {
    // The dialog's picker shows no placeholder: take its (only) input.
    cy.get('[role="dialog"] input').first().clear().type(code);
    cy.contains('li[role="option"]', code).should('be.visible').click({ force: true });
  });
  // Close the picker's option list, which covers the submit button.
  cy.get('[role="dialog"] input').first().type('{esc}');
  // The services dialog reuses the items dialog texts: it reads "Add N items".
  cy.contains('[role="dialog"] button', new RegExp(`^Add ${codes.length} (services|items)$`, 'i')).click({ force: true });
  cy.get('[role="dialog"]').should('not.exist');
  codes.forEach((code) => gridRow(code).should('exist'));
};

const gridRow = (code) => cy.get('.MuiDataGrid-row').filter((_, row) => [...row.querySelectorAll('[role="gridcell"]')].some((c) => c.innerText.trim() === code));

const limitCells = (code) => ['limitationType', 'limitationTypeR', 'limitationTypeE']
  .map((field) => `[data-field="${field}"]`).join(',');

// Row edit: switch Limit O/R/E to Co-insurance and save the row.
// The row is then found by its data-id: once the grid scrolls right to the R and E columns,
// it stops rendering the code and actions columns, and gridRow() matches on the code.
const setCoInsurance = (code) => {
  gridRow(code).invoke('attr', 'data-id').then((id) => {
    const row = () => cy.get(`.MuiDataGrid-row[data-id="${id}"]`);
    row().find('button[aria-label="edit"]').click({ force: true });
    ['limitationType', 'limitationTypeR', 'limitationTypeE'].forEach((field) => {
      row().find(`[data-field="${field}"] [role="combobox"]`).click({ force: true });
      cy.contains('[role="listbox"] li', 'Co-insurance').click({ force: true });
    });
    // The actions column comes first: scroll back to it so the grid renders it again.
    row().closest('.MuiDataGrid-virtualScroller').scrollTo('left', { ensureScrollable: false });
    row().find('button[aria-label="save"]').click({ force: true });
    row().find(limitCells(code)).each(($cell) => expect($cell.text().trim()).to.eq('Co-insurance'));
  });
};

const saveNewProduct = (product) => {
  cy.save();
  expectMutationSucceeded(`Create product ${product.name}`);
  createdProducts.add(product.code);
};

const maxTableRow = (label) => cy.contains('table', 'Number').contains('tr', label);
const setMaxNumber = (label, value) => {
  maxTableRow(label).find('input').first().clear().type(String(value));
  maxTableRow(label).find('input').first().should('have.value', String(value));
};


// ------------------ DATA ------------------
const base = {
  code: `PB${runId}`,
  name: `UAT product ${runId}`,
  // region and district are set in before() from baseline location r1d2.
};
const baseChanges = { name: `UAT product ${runId} v2`, maxMembers: '7' };
const duplicate = { code: `PD${runId}`, name: base.name };

// Seeded per run (codes <= 6 characters).
const categoryServices = {
  Consultation: { code: `C${runId}`, category: 'C' },
  Surgery: { code: `U${runId}`, category: 'S' },
  Delivery: { code: `D${runId}`, category: 'D' },
  Antenatal: { code: `A${runId}`, category: 'A' },
};
const visitItem = { code: `V${runId}` };

const limitCases = [
  { ocm: 709, prefix: 'CN', row: 'Consultations', number: 3, service: 'Consultation' },
  { ocm: 713, prefix: 'SU', row: 'Surgeries', number: 3, service: 'Surgery' },
  { ocm: 715, prefix: 'DL', row: 'Deliveries', number: 1, service: 'Delivery' },
  { ocm: 717, prefix: 'AN', row: 'Antenatal', number: 2, service: 'Antenatal' },
  { ocm: 719, prefix: 'HO', row: 'Hospitalizations', number: 3, item: true },
  { ocm: 720, prefix: 'VI', row: 'Visits', number: 3, item: true },
];

// ------------------ TESTS ------------------
describe('UAT Benefit plan - Products', () => {
  before(() => {
    const B = baseline();
    base.region = B.locations.r1.label;
    base.district = B.locations.r1d2.label;
    cy.login();
    Object.entries(categoryServices).forEach(([name, s]) => {
      mutate('createService', `code: "${s.code}" name: "UAT ${name} ${runId}" type: "C" careType: "B" patientCategory: 15
        price: "1000" level: "S" category: "${s.category}" packagetype: "S" manualPrice: "0"`, `UAT seed service ${s.code}`);
    });
    mutate('createItem', `code: "${visitItem.code}" name: "UAT Visit and Hospitalization ${runId}" type: "D" careType: "B"
      patientCategory: 15 price: "500"`, `UAT seed item ${visitItem.code}`);
  });

  beforeEach(() => {
    cy.login();
  });

  after(() => {
    cy.login();
    [...createdProducts, base.code, duplicate.code].forEach((code) => {
      gql(`{ products(code: "${code}") { edges { node { uuid validityTo } } } }`).then((data) => {
        data.products.edges.filter((e) => !e.node.validityTo).forEach((e) => {
          gql(`mutation { deleteProduct(input: { clientMutationId: "c${Date.now()}" clientMutationLabel: "UAT cleanup ${code}" uuids: ["${e.node.uuid}"] }) { clientMutationId } }`);
        });
      });
    });
    Object.values(categoryServices).forEach((s) => {
      gql(`{ medicalServices(code: "${s.code}") { edges { node { uuid } } } }`).then((data) => {
        const uuids = data.medicalServices.edges.map((e) => `"${e.node.uuid}"`);
        if (uuids.length) gql(`mutation { deleteService(input: { clientMutationId: "c${Date.now()}" clientMutationLabel: "UAT cleanup ${s.code}" uuids: [${uuids}] }) { clientMutationId } }`);
      });
    });
    gql(`{ medicalItems(code: "${visitItem.code}") { edges { node { uuid } } } }`).then((data) => {
      const uuids = data.medicalItems.edges.map((e) => `"${e.node.uuid}"`);
      if (uuids.length) gql(`mutation { deleteItem(input: { clientMutationId: "c${Date.now()}" clientMutationLabel: "UAT cleanup ${visitItem.code}" uuids: [${uuids}] }) { clientMutationId } }`);
    });
  });

  it('adds a basic product (OCM-315)', () => {
    openNewProduct();
    cy.assertSaveDisabled('Save changes');
    fillHeader(base);

    addToGrid('items', [itemCode(0), itemCode(1)]);
    gridRow(itemCode(1)).find('button[aria-label="delete"]').click();
    gridRow(itemCode(1)).should('not.exist');
    gridRow(itemCode(0)).should('have.length', 1);
    setCoInsurance(itemCode(0));

    addToGrid('services', [serviceCode(0), serviceCode(1)]);
    gridRow(serviceCode(1)).find('button[aria-label="delete"]').click();
    gridRow(serviceCode(1)).should('not.exist');
    setCoInsurance(serviceCode(0));

    saveNewProduct(base);

    searchProducts(base.code);
    productRows(base.code).should(($rows) => {
      expect($rows).to.have.length(1);
      expect($rows[0].innerText).to.include(base.name);
      expect(hasDate($rows[0], DATE_FROM), 'Date From in the list').to.be.true;
      expect(hasDate($rows[0], DATE_TO), 'Date To in the list').to.be.true;
    });
    productRows(base.code).first().dblclick({ force: true });
    cy.verifyMuiDatePickerValue('Date from', dmy(DATE_FROM));
    openTab('Medical Items');
    gridRow(itemCode(0)).should('have.length', 1);
    gridRow(itemCode(1)).should('not.exist');
    gridRow(itemCode(0)).find(limitCells(itemCode(0))).each(($cell) => expect($cell.text().trim()).to.eq('Co-insurance'));
    openTab('Medical Services');
    gridRow(serviceCode(0)).should('have.length', 1);
    gridRow(serviceCode(1)).should('not.exist');
    gridRow(serviceCode(0)).find(limitCells(serviceCode(0))).each(($cell) => expect($cell.text().trim()).to.eq('Co-insurance'));
  });

  it('modifies a product (OCM-204)', () => {
    openProduct(base.code);
    cy.contains(`Product ${base.name}`);
    // Code stays editable: the update mutation accepts a new code once it is unique.
    cy.verifyMuiInputValue('Code', base.code);
    // Date from cannot be changed on a saved product: the picker button is absent or disabled.
    cy.contains('label', 'Date from', { matchCase: false }).parent().then(($field) => {
      $field.find('button[aria-label^="Choose date"]').each((_, button) => expect(button, 'Date from picker').to.be.disabled);
    });
    cy.enterMuiInput('Name', baseChanges.name);
    cy.enterMuiInput('Max members', baseChanges.maxMembers);
    cy.save();
    expectMutationSucceeded(`Update product ${baseChanges.name}`);

    openProduct(base.code);
    cy.verifyMuiInputValue('Name', baseChanges.name);
    cy.verifyMuiInputValue('Max members', baseChanges.maxMembers);
    openTab('Medical Items');
    gridRow(itemCode(0)).should('have.length', 1);
    openTab('Medical Services');
    gridRow(serviceCode(0)).should('have.length', 1);
  });

  it('duplicates a product (OCM-203)', () => {
    searchProducts(base.code);
    cy.window().then((win) => cy.stub(win, 'open').as('windowOpen'));
    cy.clickRowAction(base.code, 'Duplicate');
    cy.get('@windowOpen').should('have.been.called').then((stub) => {
      const url = String(stub.firstCall.args[0]);
      expect(url).to.match(/\/front\/admin\/products\/duplicate\/[0-9a-f-]{36}/);
      cy.visit(url.replace(/^https?:\/\/[^/]+/, ''));
    });
    cy.verifyMuiInputValue('Name', baseChanges.name);
    cy.verifyMuiInputValue('Code', '');
    cy.enterMuiInput('Code', duplicate.code);
    cy.contains('Product code already in use').should('not.exist');
    cy.save();
    expectMutationSucceeded(`Duplicate product ${baseChanges.name}`);
    createdProducts.add(duplicate.code);

    openProduct(duplicate.code);
    cy.verifyMuiInputValue('Name', baseChanges.name);
    openTab('Medical Items');
    gridRow(itemCode(0)).should('have.length', 1);
    openTab('Medical Services');
    gridRow(serviceCode(0)).should('have.length', 1);
  });

  it('deletes a product (OCM-202)', () => {
    searchProducts(base.code);
    productRows(base.code).should('have.length', 1);
    cy.clickRowAction(base.code, 'Delete');
    cy.get('[role="dialog"]').should('contain.text', 'Delete Product')
      .and('contain.text', `Are you sure you want to delete the product ${baseChanges.name}?`);
    cy.contains('[role="dialog"] button', /^ok$/i).click();
    expectMutationSucceeded(`Delete product ${baseChanges.name}`);
    searchProducts(base.code);
    productRows(base.code).should('have.length', 0);
  });

  it('shows deleted products in the search list (OCM-321)', () => {
    searchProducts(base.code);
    productRows(base.code).should('have.length', 0);
    searchProducts(base.code, { history: true });
    // Created, modified then deleted: the first version and the deleted one, without actions.
    productRows(base.code).should('have.length.at.least', 2);
    productRows(base.code).each(($tr) => {
      expect(Cypress.$($tr).find('[data-testid="MoreHorizIcon"]').length, 'no action menu').to.eq(0);
    });
  });

  const newLimitedProduct = (product, { service, item } = {}) => {
    openNewProduct();
    fillHeader(product);
    if (item) addToGrid('items', [item]);
    if (service) addToGrid('services', [service]);
  };

  it('adds a product with a ceiling (OCM-316)', () => {
    // Automated: product set-up and persistence. Not automated: the claim capped at the ceiling.
    const product = { code: `CE${runId}`, name: `UAT ceiling ${runId}` };
    newLimitedProduct(product, { item: itemCode(0), service: serviceCode(0) });
    openTab('Deductibles & Ceilings');
    cy.verifyMuiSelectValue('Ceiling Discrimination', 'Based on Health Facility Type');
    cy.verifyMuiSelectValue('Ceiling Type', 'Insuree');
    tableHeader(0).should('contain.text', 'All');
    tableRow(0).should('contain.text', 'Insuree');

    cy.chooseMuiSelect('Ceiling Type', 'Policy');
    tableRow(0).should('contain.text', 'Policy');
    tableRow(1).should('contain.text', 'Policy');

    cy.contains('label', 'Split ceilings & deductibles').find('input[type="checkbox"]').check();
    tableHeader(0).should('contain.text', 'Hospitals').and('contain.text', 'Non-Hospitals');
    cy.chooseMuiSelect('Ceiling Discrimination', 'Based on Claim Type');
    tableHeader(0).should('contain.text', 'In-Patient').and('contain.text', 'Out-Patient');

    tableRow(1).find('input').first().clear().type('50000');
    saveNewProduct(product);

    openProduct(product.code);
    openTab('Deductibles & Ceilings');
    cy.verifyMuiSelectValue('Ceiling Type', 'Policy');
    tableRow(1).find('input').first().invoke('val')
      .then((v) => expect(Number(String(v).replace(/[^0-9.]/g, ''))).to.eq(50000));
  });

  it('adds a product with a deductible (OCM-317)', () => {
    // Automated: product set-up and persistence. Not automated: the claim deduction.
    const product = { code: `DE${runId}`, name: `UAT deductible ${runId}` };
    newLimitedProduct(product, { item: itemCode(0), service: serviceCode(0) });
    openTab('Deductibles & Ceilings');
    cy.chooseMuiSelect('Ceiling Type', 'Treatment');
    cy.chooseMuiSelect('Ceiling Discrimination', 'Based on Claim Type');
    cy.contains('label', 'Split ceilings & deductibles').find('input[type="checkbox"]').check();
    tableRow(0).should('contain.text', 'Treatment');
    tableHeader(0).should('contain.text', 'In-Patient').and('contain.text', 'Out-Patient');
    tableRow(0).find('input').eq(0).clear().type('1000');
    tableRow(0).find('input').eq(1).clear().type('500');
    saveNewProduct(product);

    openProduct(product.code);
    openTab('Deductibles & Ceilings');
    cy.verifyMuiSelectValue('Ceiling Type', 'Treatment');
    tableRow(0).find('input').then(($inputs) => {
      const values = [...$inputs].map((i) => Number(String(i.value).replace(/[^0-9.]/g, '')));
      expect(values.slice(0, 2), 'deductibles In-Patient / Out-Patient').to.deep.eq([1000, 500]);
    });
  });

  it('adds a product with enrolment cycles (OCM-319)', () => {
    // Automated: product set-up and persistence. Not automated: the policy start on the next cycle.
    const product = { code: `CY${runId}`, name: `UAT cycles ${runId}` };
    newLimitedProduct(product, { item: itemCode(0), service: serviceCode(0) });
    openTab('Pooling Management');
    cy.contains('Start Cycles');
    ['Cycle 1', 'Cycle 2', 'Cycle 3', 'Cycle 4'].forEach((c) => cy.contains(c));
    const cycle = (n) => cy.contains('p', `Cycle ${n}`).parent();
    const setCycle = (n, day, month) => {
      cycle(n).contains('label', 'Day').siblings('.MuiInputBase-root').find('input').clear().type(String(day));
      cycle(n).contains('label', 'Month').siblings('.MuiInputBase-root').find('input').clear().type(String(month));
    };
    setCycle(1, 1, 1);
    setCycle(2, 1, 7);
    saveNewProduct(product);

    openProduct(product.code);
    openTab('Pooling Management');
    const cycleValues = (n) => cycle(n).find('input').then(($i) => [...$i].map((i) => Number(i.value)));
    cycleValues(1).should('deep.eq', [1, 1]);
    cycleValues(2).should('deep.eq', [1, 7]);
  });

  it('adds a product with limited numbers of consultations, surgeries, deliveries, hospitalizations, antenatal and visits (OCM-325)', () => {
    // Automated: product set-up and persistence. Not automated: the claim rejected over a limit.
    const product = { code: `LI${runId}`, name: `UAT limits ${runId}` };
    openNewProduct();
    fillHeader(product);
    addToGrid('items', [visitItem.code]);
    addToGrid('services', Object.values(categoryServices).map((s) => s.code));
    openTab('Deductibles & Ceilings');
    ['Consultations', 'Surgeries', 'Deliveries', 'Hospitalizations', 'Antenatal', 'Visits']
      .forEach((row) => maxTableRow(row).find('input').first().invoke('val').should('be.oneOf', ['', '0']));
    cy.chooseMuiSelect('Ceiling Type', 'Policy');
    tableRow(0).should('contain.text', 'Policy');
    const numbers = { Consultations: 3, Surgeries: 3, Deliveries: 1, Hospitalizations: 3, Antenatal: 2, Visits: 3 };
    Object.entries(numbers).forEach(([row, n]) => setMaxNumber(row, n));
    saveNewProduct(product);

    openProduct(product.code);
    openTab('Deductibles & Ceilings');
    Object.entries(numbers).forEach(([row, n]) => maxTableRow(row).find('input').first().should('have.value', String(n)));
  });

  limitCases.forEach((c) => {
    it(`creates a product with ${c.number} ${c.row} (OCM-${c.ocm})`, () => {
      // The limit enforcement itself is a claim test.
      const product = { code: `${c.prefix}${c.number}${runId}`, name: `UAT ${c.row} ${runId}` };
      openNewProduct();
      fillHeader(product);
      openTab('Deductibles & Ceilings');
      setMaxNumber(c.row, c.number);
      if (c.item) addToGrid('items', [visitItem.code]);
      else addToGrid('services', [categoryServices[c.service].code]);
      saveNewProduct(product);

      openProduct(product.code);
      openTab('Deductibles & Ceilings');
      maxTableRow(c.row).find('input').first().should('have.value', String(c.number));
    });
  });
});
