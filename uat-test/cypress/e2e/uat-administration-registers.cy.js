import { baseline } from '../support/baseline';

// Administration > Registers and Extracts (OCM-231..233, 322..324, 697..702, 704..708).
//
// Downloads: the pages open the file URL with window.open, which Cypress cannot follow.
// The spec stubs window.open, checks the URL the button opens, fetches it with the
// session cookie and saves it under the downloads folder, then checks the content
// against baseline records (locations, the hospital, an insuree, an item, a service,
// a diagnosis), not demo rows.
//
// Register uploads use the file the matching download produces, with "Dry run" ticked
// and the "Insert & Update" strategy, so nothing is written. The claim extract is the
// exception: it creates one claim at the baseline hospital (district r1d2), with that
// facility's claim administrator and the nearHospital family head (village r1d2m1v1,
// same district — coherent). The officer extract uses officer r1d1 (district r1d1).

const TIMEOUT = 5000;
// register and claim uploads are processed by the backend before the result dialog opens
const UPLOAD_TIMEOUT = 30000;
const REGISTERS_URL = '/front/tools/registers';
const EXTRACTS_URL = '/front/tools/extracts';
const downloadsFolder = () => Cypress.config('downloadsFolder');

// Blocks are papers whose header holds the title.
const block = (title) => cy.contains('.MuiPaper-root p', new RegExp(`^\\s*${title}\\s*$`), { timeout: TIMEOUT })
  .closest('.MuiPaper-root');

function openPage(url) {
  cy.visit(url, {
    onBeforeLoad(win) {
      cy.stub(win, 'open').as('windowOpen');
    },
  });
}

function chooseBlockSelect(title, label, option) {
  block(title).contains('label', label).siblings('.MuiInputBase-root').find('[role="combobox"]').click();
  cy.contains('[role="listbox"] li', new RegExp(`^\\s*${Cypress._.escapeRegExp(option)}\\s*$`)).click();
}

// Fetches the URL the last window.open call received and saves it as fileName.
// Yields the response body (a binary string when binary is true).
function fetchOpenedFile(fileName, { urlPattern, binary = false } = {}) {
  return cy.get('@windowOpen').should('have.been.called').then((stub) => {
    const url = stub.lastCall.args[0];
    if (urlPattern) expect(url).to.match(urlPattern);
    return cy.request({ url, encoding: binary ? 'binary' : 'utf8' }).then((response) => {
      expect(response.status).to.eq(200);
      expect(response.body, `${fileName} content`).to.have.length.greaterThan(0);
      const path = `${downloadsFolder()}/${fileName}`;
      cy.writeFile(path, response.body, binary ? 'binary' : 'utf8');
      return cy.readFile(path, binary ? 'binary' : 'utf8');
    });
  });
}

// Uploads `contents` in a register block with a dry run and checks the result dialog.
function dryRunUpload(title, { contents, fileName, mimeType, confirmText }) {
  block(title).contains('button', 'Upload').should('be.disabled');
  block(title).find('input[type="file"]').selectFile(
    { contents: Cypress.Buffer.from(contents), fileName, mimeType },
    { force: true },
  );
  chooseBlockSelect(title, 'Strategy', 'Insert & Update');
  block(title).contains('label', 'Dry run').find('input[type="checkbox"]').check({ force: true });
  block(title).contains('button', 'Upload').should('not.be.disabled').click();

  cy.get('[role="dialog"]').should('contain', confirmText);
  cy.get('[role="dialog"]').contains('button', 'Upload').click();

  cy.contains('[role="dialog"]', 'Upload Register', { timeout: UPLOAD_TIMEOUT }).as('result');
  cy.get('@result').find('[role="progressbar"]', { timeout: TIMEOUT }).should('not.exist');
  cy.get('@result').should('contain', 'Success').and('contain', 'Sent:');
  cy.get('@result').contains('button', 'Ok').click();
  cy.contains('[role="dialog"]', 'Upload Register').should('not.exist');
}

const apiFile = (url, binary = false) => cy.request({ url, encoding: binary ? 'binary' : 'utf8' }).its('body');

describe('Administration / Registers', () => {
  beforeEach(() => {
    cy.login();
    openPage(REGISTERS_URL);
  });

  it('Shows the register blocks and downloads diagnoses (OCM-231)', () => {
    const diagnosisCode = baseline().diagnoses[0].code;
    ['Diagnoses', 'Locations', 'Health Facilities', 'Insurees', 'Medical Items', 'Medical Services']
      .forEach((title) => block(title).should('exist'));
    block('Diagnoses').contains('button', 'Download').click();
    fetchOpenedFile('diagnoses.xml', { urlPattern: /\/tools\/registers\/download_diagnoses$/ })
      .should('match', /^<\?xml|^</)
      .and('contain', diagnosisCode);
  });

  it('Uploads diagnoses in a dry run (OCM-322)', () => {
    apiFile('/api/tools/registers/download_diagnoses').then((xml) => {
      dryRunUpload('Diagnoses', {
        contents: xml, fileName: 'diagnoses.xml', mimeType: 'text/xml',
        confirmText: 'Are you sure you want to upload a new list of diagnoses?',
      });
    });
  });

  it('Downloads locations (OCM-232)', () => {
    // Both baseline regions: r1 and r2 (the other region).
    const B = baseline();
    block('Locations').contains('button', 'Download').click();
    fetchOpenedFile('locations.xml', { urlPattern: /\/tools\/registers\/download_locations$/ })
      .should('contain', B.locations.r1.code)
      .and('contain', B.locations.r2.name);
  });

  it('Uploads locations in a dry run (OCM-323)', () => {
    apiFile('/api/tools/registers/download_locations').then((xml) => {
      dryRunUpload('Locations', {
        contents: xml, fileName: 'locations.xml', mimeType: 'text/xml',
        confirmText: 'Are you sure you want to upload a new list of locations?',
      });
    });
  });

  it('Downloads health facilities (OCM-233)', () => {
    // The baseline hospital already exists (district r1d2).
    const hospitalCode = baseline().healthFacilities.hospital.code;
    block('Health Facilities').contains('button', 'Download').click();
    fetchOpenedFile('health_facilities.xml', { urlPattern: /\/tools\/registers\/download_healthfacilities$/ })
      .should('contain', hospitalCode);
  });

  it('Uploads health facilities in a dry run (OCM-324)', () => {
    apiFile('/api/tools/registers/download_healthfacilities').then((xml) => {
      dryRunUpload('Health Facilities', {
        contents: xml, fileName: 'health_facilities.xml', mimeType: 'text/xml',
        confirmText: 'Are you sure you want to upload a new list of Health Facilities?',
      });
    });
  });

  it('Downloads insurees as CSV (OCM-697)', () => {
    block('Insurees').contains('button', 'Download').should('be.disabled');
    chooseBlockSelect('Insurees', 'Format', 'CSV');
    block('Insurees').contains('button', 'Download').should('not.be.disabled').click();
    fetchOpenedFile('insurees.csv', { urlPattern: /\/im_export\/exports\/insurees\?file_format=csv$/ })
      .then((csv) => {
        const lines = csv.trim().split(/\r?\n/);
        expect(lines.length, 'header and insuree rows').to.be.greaterThan(1);
        expect(csv).to.contain(baseline().families.insured.head.chfId);
      });
  });

  it('Uploads insurees in a dry run (OCM-700)', () => {
    apiFile('/api/im_export/exports/insurees?file_format=csv').then((csv) => {
      dryRunUpload('Insurees', {
        contents: csv, fileName: 'insurees.csv', mimeType: 'text/csv',
        confirmText: 'Are you sure you want to upload a new list of insurees?',
      });
    });
  });

  it('Downloads medical items as XLSX (OCM-699)', () => {
    block('Medical Items').contains('button', 'Download').should('be.disabled');
    chooseBlockSelect('Medical Items', 'Format', 'XLSX');
    block('Medical Items').contains('button', 'Download').should('not.be.disabled').click();
    // An XLSX file is a ZIP archive: it starts with "PK".
    fetchOpenedFile('items.xlsx', { urlPattern: /\/tools\/exports\/items\?file_format=xlsx$/, binary: true })
      .then((content) => expect(content.slice(0, 2)).to.eq('PK'));
  });

  it('Uploads medical items in a dry run (OCM-698)', () => {
    apiFile('/api/tools/registers/download_items').then((xml) => {
      expect(xml).to.contain(baseline().items[0].code);
      dryRunUpload('Medical Items', {
        contents: xml, fileName: 'items.xml', mimeType: 'text/xml',
        confirmText: 'Are you sure you want to upload a new list of medical items?',
      });
    });
  });

  it('Downloads medical services as CSV (OCM-701)', () => {
    block('Medical Services').contains('button', 'Download').should('be.disabled');
    chooseBlockSelect('Medical Services', 'Format', 'CSV');
    block('Medical Services').contains('button', 'Download').should('not.be.disabled').click();
    fetchOpenedFile('services.csv', { urlPattern: /\/tools\/exports\/services\?file_format=csv$/ })
      .then((csv) => {
        expect(csv.trim().split(/\r?\n/).length, 'header and service rows').to.be.greaterThan(1);
        expect(csv).to.contain(baseline().services[0].code);
      });
  });

  it('Uploads medical services in a dry run (OCM-702)', () => {
    apiFile('/api/tools/registers/download_services').then((xml) => {
      dryRunUpload('Medical Services', {
        contents: xml, fileName: 'services.xml', mimeType: 'text/xml',
        confirmText: 'Are you sure you want to upload a new list of medical services?',
      });
    });
  });
});

describe('Administration / Extracts', () => {
  beforeEach(() => {
    cy.login();
    openPage(EXTRACTS_URL);
  });

  it('Downloads feedbacks and renewals for an officer (OCM-704)', () => {
    // Officer r1d1 (district r1d1). An empty extract is still a zip; no demo officer is required.
    // The picker labels an officer with their names only, like users elsewhere in the app
    // (no code): search and pick by name.
    const { otherNames, lastName } = baseline().users.officerR1d1;
    const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const officerLabel = new RegExp(
      `^\\s*(${escape(otherNames)}\\s+${escape(lastName)}|${escape(lastName)}\\s+${escape(otherNames)})\\s*$`,
    );
    block('Download Data for Officer').within(() => {
      cy.contains('button', 'Download Feedbacks').should('be.disabled');
      cy.contains('button', 'Download Renewals').should('be.disabled');
      // Re-query after the click: opening the picker re-renders its input.
      const officerInput = () => cy.contains('label', 'Select Officer').siblings('.MuiInputBase-root').find('input');
      officerInput().click({ force: true });
      officerInput().type(lastName, { force: true });
    });
    cy.contains('[role="listbox"] li, li[role="option"]', officerLabel, { timeout: TIMEOUT }).click({ force: true });

    block('Download Data for Officer').contains('button', 'Download Feedbacks').should('not.be.disabled').click();
    fetchOpenedFile('officer_feedbacks.zip', { urlPattern: /\/tools\/extracts\/download_feedbacks\?officer_id=\d+$/, binary: true });

    block('Download Data for Officer').contains('button', 'Download Renewals').should('not.be.disabled').click();
    fetchOpenedFile('officer_renewals.zip', { urlPattern: /\/tools\/extracts\/download_renewals\?officer_id=\d+$/, binary: true });
  });

  it('Uploads a claim (OCM-705)', () => {
    // Coherent with district r1d2: the baseline hospital, its claim administrator, and
    // the nearHospital family head (village r1d2m1v1). Diagnosis and item are baseline.
    // The hospital already exists, so the upload does not create one.
    const B = baseline();
    const claimCode = `UX${Date.now().toString(36).slice(-6).toUpperCase()}`;
    const today = new Date();
    const dmy = `${String(today.getDate()).padStart(2, '0')}/${String(today.getMonth() + 1).padStart(2, '0')}/${today.getFullYear()}`;
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Claim>
  <Details>
    <ClaimDate>${dmy}</ClaimDate>
    <HFCode>${B.healthFacilities.hospital.code}</HFCode>
    <ClaimAdmin>${B.users.hospitalClaimAdmin.code}</ClaimAdmin>
    <ClaimCode>${claimCode}</ClaimCode>
    <CHFID>${B.families.nearHospital.head.chfId}</CHFID>
    <StartDate>${dmy}</StartDate>
    <EndDate>${dmy}</EndDate>
    <ICDCode>${B.diagnoses[0].code}</ICDCode>
    <Comment>UAT upload</Comment>
    <Total>10</Total>
    <VisitType>O</VisitType>
  </Details>
  <Items>
    <Item><ItemCode>${B.items[0].code}</ItemCode><ItemPrice>10</ItemPrice><ItemQuantity>1</ItemQuantity></Item>
  </Items>
  <Services></Services>
</Claim>`;

    block('Upload Claims').contains('button', 'Upload').should('be.disabled');
    block('Upload Claims').find('input[type="file"]').selectFile(
      { contents: Cypress.Buffer.from(xml), fileName: `${claimCode}.xml`, mimeType: 'text/xml' },
      { force: true },
    );
    block('Upload Claims').contains('button', 'Upload').should('not.be.disabled').click();
    cy.contains('[role="dialog"]', 'Claims Upload Done', { timeout: UPLOAD_TIMEOUT }).as('result');
    cy.get('@result').should('contain', 'Success');
    cy.get('@result').contains('button', 'OK').click();
    cy.contains('[role="dialog"]', 'Claims Upload Done').should('not.exist');

    cy.request({
      method: 'POST',
      url: '/api/graphql',
      body: { query: `{ claims(code: "${claimCode}") { totalCount } }` },
    }).its('body.data.claims.totalCount').should('eq', 1);
  });

  // Partial (OCM-706..708): a valid enrolment, feedback or renewal file is an
  // AES-encrypted archive produced by the mobile applications, which this spec cannot
  // build. Only the file selection is checked.
  [
    ['Upload Enrolments', 'OCM-706'],
    ['Upload Feedbacks', 'OCM-707'],
    ['Upload Renewals', 'OCM-708'],
  ].forEach(([title, id]) => {
    it(`${title}: enables Upload once a file is chosen (${id})`, () => {
      block(title).contains('button', 'Upload').should('be.disabled');
      block(title).find('input[type="file"]').selectFile(
        { contents: Cypress.Buffer.from('placeholder'), fileName: 'extract.zip', mimeType: 'application/zip' },
        { force: true },
      );
      block(title).contains('button', 'Upload').should('not.be.disabled');
    });
  });
});
