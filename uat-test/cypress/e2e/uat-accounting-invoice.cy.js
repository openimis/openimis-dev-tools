// UAT: Accounting / Customer invoices (OCM-690).
//
// A policy saved Idle/Active creates an invoice (calcrule_contribution_legacy) coded
// IV-{product}-{head CHF ID}-{YYYY-MM of the start date}. That code is per family,
// product and month, so the spec seeds a new family (unique CHF ID) per run and
// creates the policy through the UI. The policy is deleted at the end; the invoice stays.
//
// Coherent with district r1d1: the family is created in village r1d1m1v1 and the
// policy officer is officerR1d1. The product is the national basic cover.
import { baseline } from '../support/baseline';

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

const head = {
  chfId: String(900000000 + (Date.now() % 99999999)).slice(0, 9),
  lastName: 'UAT',
  otherNames: 'Invoice',
};
const created = {};

describe('UAT Accounting - Customer invoices', () => {
  before(() => {
    cy.login();
    mutate('createFamily', `locationId: ${baseline().locations.r1d1m1v1.id} poverty: false headInsuree: {
      chfId: "${head.chfId}" lastName: "${head.lastName}" otherNames: "${head.otherNames}" genderId: "M" dob: "1980-01-15" head: true }`);
  });

  after(() => {
    cy.login();
    gql(`{ policiesByInsuree(chfId: "${head.chfId}") { edges { node { policyUuid } } } }`).then((data) => {
      const uuids = (data?.policiesByInsuree?.edges ?? []).map((e) => `"${e.node.policyUuid}"`);
      if (uuids.length) mutate('deletePolicies', `uuids: [${uuids.join(', ')}]`, { allowError: true });
    });
  });

  it('Generates an invoice when a policy is created (OCM-690)', () => {
    const product = baseline().products.basic;
    const officerCode = baseline().users.officerR1d1.code;
    cy.login();
    cy.visit('/front/insuree/families');
    cy.enterMuiInput('Head Ins. No.', head.chfId);
    cy.contains('button', 'Search').click({ force: true });
    cy.openRowByValue(head.chfId);

    cy.contains('button', 'Add policy').click({ force: true });
    cy.url().should('include', '/policy/policy');
    cy.chooseMuiAutocomplete('Product', product.name);
    cy.chooseMuiSelect('Officer', officerCode);
    cy.save();
    cy.waitForJournalProgress();
    cy.assertJournalNoFail();

    gql(`{ policiesByInsuree(chfId: "${head.chfId}") { edges { node { policyUuid startDate status policyValue } } } }`).then((data) => {
      expect(data.policiesByInsuree.edges, 'created policy').to.have.length(1);
      const node = data.policiesByInsuree.edges[0].node;
      Object.assign(created, { uuid: node.policyUuid, startDate: node.startDate, status: node.status, value: node.policyValue });
      // 1 = Idle
      expect(created.status, 'policy status Idle').to.eq(1);
    });

    cy.then(() => {
      const code = `IV-${product.code}-${head.chfId}-${created.startDate.slice(0, 7)}`;
      cy.visit('/front/invoices');
      cy.waitForSearcherLoaded();
      cy.enterMuiInput('Code', code);
      cy.contains('button', 'Search').click({ force: true });
      cy.contains(/^\s*1 Invoices Found/).should('exist');
      cy.contains('tbody tr', code).should('exist').then(($row) => {
        // Status and subject are read-only selects: their label is an input value,
        // which $row.text() does not include.
        const text = [$row.text(), ...$row.find('input').toArray().map((input) => input.value)].join(' ');
        // The legacy contribution rule saves the invoice as Validated
        // (converters/policy_to_invoice.py build_status), not Draft.
        expect(text, 'status').to.match(/Validated/i);
        expect(text, 'amount = policy value').to.contain(Number(created.value).toFixed(2));
      });

      // The policy page lists the same invoice in its Invoices panel.
      cy.visit(`/front/policy/policy/${created.uuid}`);
      cy.contains('Invoices').should('exist');
      cy.contains('tr', code).should('exist');
    });
  });
});
