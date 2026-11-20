import { baseline } from '../support/baseline';

// UAT: Analytics / Reports (OCM-327, 328, 774..789).
//
// Partial automation: each case opens Tools > Reports, fills the report's required
// parameters in "Configure Report Generation", clicks Generate and checks that the URL
// the page opens returns a non-empty PDF; the same URL in XLSX must return a
// spreadsheet. The content of the reports is not checked (manual).

const TODAY = new Date();
const FIRST_OF_MONTH = new Date(TODAY.getFullYear(), TODAY.getMonth(), 1);

const dialog = () => cy.get('[role="dialog"]').filter(':visible').last();
const labelRe = (label) => new RegExp(`^\\s*${label}[\\s\\u2009*]*$`);
const fieldIn = (label) => dialog().contains('label', labelRe(label)).parent();

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const pickDate = (label, date) => {
  fieldIn(label).find('button[aria-label^="Choose date"]').click();
  const header = '.MuiPickerPopper-root .MuiPickersCalendarHeader-label';
  const target = `${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
  const step = (n = 0) => cy.get(header).invoke('text').then((text) => {
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
const dateRange = (from, to) => {
  pickDate(from, FIRST_OF_MONTH);
  pickDate(to, TODAY);
};

// A Select (combobox div) or an Autocomplete (input typed to narrow the options).
const choose = (label, value) => {
  fieldIn(label).find('[role="combobox"]').first().then(($field) => {
    if ($field.is('input')) {
      cy.wrap($field).clear({ force: true }).type(value ?? '', { force: true });
      if (!value) cy.wrap($field).click({ force: true });
    } else {
      cy.wrap($field).click();
    }
  });
  // Match in the open list, then scroll: a long list (Year: 2010-2039) clips its
  // options, and a ':visible' filter would drop the one looked for.
  const listbox = () => cy.get('[role="listbox"]').filter(':visible').last();
  (value ? listbox().contains('li', value) : listbox().find('li').not('[data-value=""]').first())
    .scrollIntoView()
    .click({ force: true });
};

// The Insuree field is a generic Picker: clicking it opens a search dialog, where a
// row is picked by double-click.
const pickInsuree = (label, chfId) => {
  fieldIn(label).find('input').first().click({ force: true });
  dialog().within(() => {
    cy.contains('label', 'Insurance No.').parent().find('input').first().type(chfId);
    // Each result is a read-only input ("Name (chfId)"): picked by double-click.
    cy.get('tbody tr', { timeout: 15000 })
      .filter((_, tr) => [...tr.querySelectorAll('input')].some((input) => input.value.includes(chfId)))
      .first()
      .dblclick();
  });
  fieldIn(label).find('input').first().should('contain.value', chfId);
};

// The Location field is a LocationCascader (rc-cascader, no combobox role): open it and
// take the first location of the first level (changeOnSelect makes it a valid pick).
const pickLocation = (label) => {
  fieldIn(label).find('input').first().click({ force: true });
  cy.get('.openimis-location-cascader-dropdown .rc-cascader-menu-item', { timeout: 15000 })
    .filter(':visible').first().click();
  // Escape would close the report dialog too: click outside the dropdown instead. While
  // the dropdown is open it covers the dialog (same z-index), so Cypress does not count
  // the dialog as ':visible': reach the title without dialog(), then wait for it to close.
  cy.contains('[role="dialog"] h2', 'Configure Report Generation').click({ force: true });
  cy.get('.openimis-location-cascader-dropdown:visible').should('not.exist');
  fieldIn(label).find('input').first().should(($input) => expect($input.val(), `${label} picked`).to.not.be.empty);
};

const openReport = (description) => {
  cy.visit('/front/tools/reports');
  cy.contains('tr', description).should('exist').within(() => cy.contains('button', 'Generate Report').click());
  dialog().should('contain', 'Configure Report Generation');
  dialog().contains('label', 'Output Format').should('exist');
};

const generateButton = () => dialog().contains('button', /^Generate$/);

// Clicks Generate and checks the opened URL returns the PDF, then the XLSX variant.
const generateAndCheck = (name) => {
  cy.window().then((win) => cy.stub(win, 'open').as('open'));
  generateButton().should('not.be.disabled').click();
  cy.get('@open').should('have.been.calledOnce').then((stub) => {
    const url = stub.firstCall.args[0];
    expect(url, 'report URL').to.match(new RegExp(`/api/report/${name}/pdf/`));
    cy.request({ url, encoding: 'binary', timeout: 120000 }).then((res) => {
      expect(res.status, 'PDF status').to.eq(200);
      expect(res.headers['content-type'], 'PDF content type').to.contain('application/pdf');
      expect(res.body.length, 'PDF size').to.be.greaterThan(500);
      expect(res.body.slice(0, 4), 'PDF signature').to.eq('%PDF');
    });
    cy.request({ url: url.replace('/pdf/', '/xlsx/'), encoding: 'binary', timeout: 120000 }).then((res) => {
      expect(res.status, 'XLSX status').to.eq(200);
      expect(res.headers['content-type'], 'XLSX content type').to.match(/spreadsheet|excel|octet-stream/);
      expect(res.body.slice(0, 2), 'XLSX (zip) signature').to.eq('PK');
    });
  });
};

// description in the list, report name, required-parameter filler.
// Record parameters are read from the baseline when fill() runs, not at import.
// The claim-history insuree is the insured family head (village r1d1m1v1), coherent
// with officer r1d1. The referrals report uses region r1 and its district r1d1.
// Product reports use the national basic product. Pickers with no value take the
// first option; the PDF content is not asserted.
const REPORTS = [
  { ocm: 789, title: 'Generates the claim history report', description: 'Claim history', name: 'claim_history',
    fill: () => { dateRange('Date From', 'Date To'); pickInsuree('Insuree', baseline().families.insured.head.chfId); } },
  { ocm: 788, title: 'Generates the claims overview report', description: 'Overview of the processing of claims', name: 'claims_overview',
    fill: () => dateRange('Date From', 'Date To') },
  { ocm: 787, title: 'Generates the claim percentage referrals report', description: 'Percentage of referrals in claims', name: 'claim_percentage_referrals',
    fill: () => {
      const B = baseline();
      choose('Region', B.locations.r1.name);
      choose('District', B.locations.r1d1.name);
      dateRange('Date From', 'Date To');
    } },
  { ocm: 786, title: 'Generates the claims primary operational indicators report', description: 'Claims Primary operational indicators', name: 'claims_primary_operational_indicators',
    fill: () => { choose('Year', String(TODAY.getFullYear())); choose('Region', baseline().locations.r1.name); } },
  { ocm: 785, title: 'Generates the insuree family overview report', description: 'Simple claim report', name: 'insuree_family_overview',
    fill: () => dateRange('From Date', 'To Date') },
  { ocm: 784, title: 'Generates the premium collection report', description: 'Premium collection', name: 'premium_collection',
    fill: () => dateRange('Date From', 'Date To') },
  { ocm: 783, title: 'Generates the insurees pending enrollment report', description: 'Insurees pending enrollment', name: 'insurees_pending_enrollment',
    fill: () => {
      // The date and officer labels are untranslated keys (InsureePendingEnrollmentReport.*).
      // Officer r1d1 is the insured family's officer (district r1d1).
      dateRange('(?:From Date|InsureePendingEnrollmentReport.dateFrom)', '(?:To Date|InsureePendingEnrollmentReport.dateTo)');
      choose('(?:Officer|InsureePendingEnrollmentReport.officer)', baseline().users.officerR1d1.code);
      pickLocation('Location');
    } },
  { ocm: 782, title: 'Generates the payment category overview report', description: 'Payment category overview', name: 'payment_category_overview',
    fill: () => dateRange('Date From', 'Date To') },
  { ocm: 781, title: 'Generates the policy renewals report', description: 'Policy renewals', name: 'policy_renewals',
    fill: () => dateRange('Date From', 'Date To') },
  { ocm: 780, title: 'Generates the insuree missing photo report', description: 'Missing insuree photos', name: 'insuree_missing_photo',
    fill: () => {} },
  { ocm: 779, title: 'Generates the user activity report', description: 'User activity', name: 'user_activity',
    fill: () => dateRange('From', 'To') },
  { ocm: 778, title: 'Generates the registers status report', description: 'Registers status', name: 'registers_status',
    fill: () => {} },
  { ocm: 776, title: 'Generates the enrolled families report', description: 'Enrolled families', name: 'enrolled_families',
    fill: () => { pickLocation('Location'); dateRange('From Date', 'To Date'); } },
  { ocm: 775, title: 'Generates the contributions distribution report', description: 'Contributions distribution', name: 'contributions_distribution',
    fill: () => { choose('Product', baseline().products.basic.code); choose('Year', String(TODAY.getFullYear())); } },
  { ocm: 327, title: 'Generates the product sales report', description: 'Product sales', name: 'product_sales',
    fill: () => dateRange('From', 'To') },
  { ocm: 774, title: 'Generates the product derived operational indicators report', description: 'Product Derived operational indicators', name: 'product_derived_operational_indicators',
    fill: () => { choose('Product', baseline().products.basic.code); choose('Year', String(TODAY.getFullYear())); } },
];

describe('UAT Analytics - Reports', () => {
  beforeEach(() => cy.login());

  REPORTS.forEach(({ ocm, title, description, name, fill }) => {
    it(`${title} (OCM-${ocm})`, () => {
      openReport(description);
      cy.get(`span:is([aria-label="${name}"],[title="${name}"])`).should('exist');
      fill();
      generateAndCheck(name);
    });
  });

  // Partial: only the designer dialog is checked; editing the ReportBro canvas and the
  // modified PDF are manual.
  it('Opens the report designer of a report (OCM-328)', () => {
    cy.visit('/front/tools/reports');
    cy.contains('tr', 'Product sales').within(() => cy.contains('button', 'Edit').click());
    dialog().should('contain', 'Report Designer');
    dialog().contains('button', 'Reset to default').should('exist');
    dialog().find('iframe[src*="/api/report/reportbro/designer"]').should('exist');
    dialog().contains('button', 'Cancel').click();
  });
});
