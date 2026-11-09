// UAT: Enrolment / Policies and Contributions searches (OCM-308, OCM-309). Read-only.
// The policy search filters on products.basic, which the insured family (district r1d1)
// and the nearHospital family (district r1d2) both hold. The contribution search uses
// the premium ensureBaseline paid on the insured family's policy. No region-r2 record.
import { baseline } from '../support/baseline';

const searcherTitle = (regex) => cy.contains('.paperHeaderTitle, .tableTitle h6, h6', regex);
const resultCount = (regex) => searcherTitle(regex).invoke('text').then((t) => Number(t.replace(/[,.\s]/g, '').match(/\d+/)[0]));

// Clicks Search and waits for the searcher's query to come back.
const search = (queryFragment) => {
  cy.aliasGraphqlQuery(queryFragment, 'searchQuery');
  cy.contains('button', 'Search').click({ force: true });
  cy.wait('@searchQuery');
  cy.waitForSearcherLoaded();
};

const toggleCheckbox = (label) => cy.contains('label', label).click();

// Column index of a results table header.
const columnIndex = (header) => cy.contains('thead th', header).invoke('index');

describe('UAT Enrolment - Searches', () => {
  beforeEach(() => cy.login());

  it('Searches for a policy (OCM-308)', () => {
    const productCode = baseline().products.basic.code;
    cy.visit('/front/policy/policies');
    cy.waitForSearcherLoaded();
    resultCount(/\d+ Policies/i).as('all');

    cy.chooseMuiAutocomplete('Product', productCode);
    search('policies');
    columnIndex('Product').then((col) => {
      cy.get('tbody tr').should('have.length.at.least', 1).each(($row) => {
        expect($row.find('td').eq(col).text(), 'product').to.contain(productCode);
      });
    });

    cy.chooseMuiSelect('Status', 'Active');
    search('policies');
    resultCount(/\d+ Policies/i).as('active');
    columnIndex('Status').then((col) => {
      cy.get('tbody tr').each(($row) => {
        if ($row.find('td').length > 1) expect($row.find('td').eq(col).text(), 'status').to.contain('Active');
      });
    });

    toggleCheckbox('Show historical');
    search('policies');
    cy.get('@active').then((active) => resultCount(/\d+ Policies/i).should('be.gte', active));
    toggleCheckbox('Show historical');

    // "Only with inactive insurees" narrows the policies of the product.
    cy.contains('label', 'Status').siblings('.MuiInputBase-root').find('[role="combobox"]').click();
    cy.get('[role="listbox"] li').first().click();
    search('policies');
    resultCount(/\d+ Policies/i).then((unfiltered) => {
      toggleCheckbox('Only with inactive insurees');
      search('policies');
      resultCount(/\d+ Policies/i).should('be.lte', unfiltered);
    });
  });

  it('Searches for a contribution (OCM-309)', () => {
    const premium = baseline().families.insured.policy?.premium;
    expect(premium, 'baseline contribution on the insured family').to.exist;
    const { receipt, payDate } = premium;
    cy.visit('/front/contribution/contributions');
    cy.waitForSearcherLoaded();
    searcherTitle(/\d+ contributions Found/).should('exist');

    cy.enterMuiInput('Receipt No.', receipt);
    search('premiums');
    columnIndex('Receipt No.').then((col) => {
      cy.get('tbody tr').should('have.length.at.least', 1).each(($row) => {
        expect($row.find('td').eq(col).text().trim(), 'receipt').to.eq(receipt);
      });
    });

    cy.contains('label', 'Receipt No.').siblings('.MuiInputBase-root').find('input').clear({ force: true });
    cy.selectDateFromCalendar('Payment Date from', payDate);
    cy.selectDateFromCalendar('Payment Date to', payDate);
    search('premiums');
    columnIndex('Payment Date').then((col) => {
      cy.get('tbody tr').should('have.length.at.least', 1).each(($row) => {
        expect($row.find('td').eq(col).text().trim(), 'payment date').to.eq(payDate);
      });
    });
    resultCount(/\d+ contributions Found/).then((current) => {
      toggleCheckbox('Show historical values');
      search('premiums');
      resultCount(/\d+ contributions Found/).should('be.gte', current);
    });
  });
});
