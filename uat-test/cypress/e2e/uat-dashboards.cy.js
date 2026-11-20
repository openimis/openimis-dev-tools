import { TIMEOUTS } from '../support/constants';

// UAT cases of "Analytics- / Project Dashboards". The report pages embed OpenSearch
// Dashboards through the '/opensearch' proxy.
//
// Partial: these tests check that each page embeds the dashboard configured for it
// (iframe "OpenSearch Dashboard" pointing at /opensearch/goto/<id>). Whether
// OpenSearch Dashboards then renders the dashboard needs a running OpenSearch with
// imported dashboards and indexed data, which the UAT stack does not provide.

const REPORT_PAGES = [
  { id: 1195, route: '/front/individualReports', dashboard: 'Individual' },
  { id: 1196, route: '/front/beneficiaryReports', dashboard: 'Beneficiary' },
  { id: 1197, route: '/front/groupReports', dashboard: 'Group' },
  { id: 1198, route: '/front/invoiceReports', dashboard: 'Invoice' },
  { id: 1199, route: '/front/paymentReports', dashboard: 'Payment' },
  { id: 1200, route: '/front/grievanceReports', dashboard: 'Grievance' },
];

function gql(query) {
  return cy.request({ method: 'POST', url: '/api/graphql', body: { query }, log: false })
    .then(({ body }) => {
      if (body.errors?.length) throw new Error(`GraphQL error: ${JSON.stringify(body.errors)}`);
      return body.data;
    });
}

// The dashboard URL configured for a dashboard name (Manage Dashboards).
const dashboardUrl = (name) => gql(`{ opensearchDashboard(name_Iexact: "${name}") { edges { node { name url } } } }`)
  .then((data) => data.opensearchDashboard.edges[0]?.node.url);

const dashboardRow = (name) => cy.get('table tbody tr', { timeout: TIMEOUTS.BACKEND_VALIDATION })
  .filter((_, tr) => tr.children[0]?.innerText.trim() === name);

describe('Project dashboards', () => {
  // Original URL of the dashboard edited by OCM-1201, restored if the test stops midway.
  const edited = {};

  beforeEach(() => {
    cy.login();
  });

  after(() => {
    if (!edited.name) return;
    cy.login();
    gql(`{ opensearchDashboard(name_Iexact: "${edited.name}") { edges { node { id url synchDisabled } } } }`).then((data) => {
      const node = data.opensearchDashboard.edges[0].node;
      if (node.url === edited.url) return;
      cy.visit('/front/dashboardConfiguration');
      dashboardRow(edited.name).contains('button', 'Edit').click();
      cy.enterMuiInput('Dashboard URL', edited.url);
      cy.get('[role="dialog"]').contains('button', 'Save').click();
      cy.waitForJournalProgress();
    });
  });

  REPORT_PAGES.forEach(({ id, route, dashboard }) => {
    it(`Opens the ${dashboard} report page with its dashboard embedded (OCM-${id})`, () => {
      cy.contains('Welcome Admin Admin!').should('be.visible');
      cy.contains('Analytics').should('be.visible');
      dashboardUrl(dashboard).then((url) => {
        expect(url, `${dashboard} dashboard URL`).to.match(/^goto\//);
        cy.visit(route);
        cy.get('iframe[title="OpenSearch Dashboard"]', { timeout: TIMEOUTS.BACKEND_VALIDATION })
          .should('have.attr', 'src', `/opensearch/${url}`);
      });
    });
  });

  it('Edits the URL of a dashboard and restores it (OCM-1201)', () => {
    const name = 'Payment';
    const editRow = (newUrl) => {
      dashboardRow(name).contains('button', 'Edit').click();
      cy.contains('[role="dialog"]', `Edit Details - ${name}`).should('be.visible');
      cy.enterMuiInput('Dashboard URL', newUrl);
      cy.get('[role="dialog"]').contains('button', 'Save').click();
      cy.get('[role="dialog"]').should('not.exist');
      cy.waitForJournalProgress();
      cy.assertJournalNoFail();
    };

    cy.visit('/front/dashboardConfiguration');
    ['Beneficiary', 'Invoice', 'Payment', 'Grievance', 'Individual', 'Group', 'DataUpdates']
      .forEach((dashboard) => dashboardRow(dashboard).should('have.length', 1).and('contain', '/opensearch/goto/'));

    dashboardUrl(name).then((originalUrl) => {
      Object.assign(edited, { name, url: originalUrl });
      const changedUrl = `${originalUrl}&test=1`;
      editRow(changedUrl);
      cy.reload();
      dashboardRow(name).should('contain', changedUrl);

      editRow(originalUrl);
      cy.reload();
      dashboardRow(name).should('contain', originalUrl).and('not.contain', '&test=1');
    });
  });
});
