import { baseline } from '../support/baseline';

// UAT: Benefit Plan / Payment Plan — creation of payment plans per calculation rule.
// Product-type plans use baseline products (national, no district — read when the
// test runs). Fees, capitation and fee-for-service use basic; commission uses extended.
// The Program-type plan uses a program seeded through the API.
// No module configuration is changed here.
const productCode = (role) => baseline().products[role].code;

const runId = Date.now().toString(36).slice(-5).toUpperCase();

const todayDmy = () => {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}-${pad(d.getMonth() + 1)}-${d.getFullYear()}`;
};
const todayIso = (offsetYears = 0) => {
  const d = new Date();
  d.setFullYear(d.getFullYear() + offsetYears);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

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

const mutate = (name, input, label) => {
  const clientMutationId = uuidv4();
  return gql(`mutation { ${name}(input: { clientMutationId: "${clientMutationId}" clientMutationLabel: "${label}" ${input} }) { clientMutationId } }`)
    .then(() => cy.waitForMutationLog(clientMutationId))
    .then(({ status, error }) => {
      if (status !== 2) throw new Error(`${label} failed: ${error}`);
    });
};

const program = { code: `PPB${runId}`, name: `UAT Payment Plan Program ${runId}` };

const seedProgram = () => mutate(
  'createBenefitPlan',
  `code: "${program.code}" name: "${program.name}" maxBeneficiaries: 50 type: INDIVIDUAL
   dateValidFrom: "${todayIso()}" dateValidTo: "${todayIso(1)}" institution: "" description: ""
   beneficiaryDataSchema: "{}"`,
  `UAT seed - program ${program.code}`,
);

const deleteProgram = () => gql(`{ benefitPlan(code: "${program.code}") { edges { node { id isDeleted } } } }`)
  .then((data) => {
    const node = data.benefitPlan.edges.map((e) => e.node).find((n) => !n.isDeleted);
    if (!node) return;
    const uuid = atob(node.id).split(':')[1];
    mutate('deleteBenefitPlan', `ids: ["${uuid}"]`, `UAT cleanup - program ${program.code}`);
  });

// Calculation parameters: numbers/strings are text inputs, selects are MUI Selects.
const fillParams = ({ inputs = {}, selects = {} }) => {
  Object.entries(selects).forEach(([label, option]) => {
    cy.contains('label', label).should('be.visible');
    cy.chooseMuiSelect(label, option);
  });
  Object.entries(inputs).forEach(([label, value]) => {
    cy.contains('label', label).should('be.visible');
    cy.enterMuiInput(label, String(value));
  });
};

const verifyParams = ({ inputs = {}, selects = {} }) => {
  Object.entries(selects).forEach(([label, option]) => cy.assertMuiSelectValue(label, option));
  Object.entries(inputs).forEach(([label, value]) => cy.verifyMuiInputValue(label, String(value)));
};

const created = [];

const createProductPlan = (plan) => {
  cy.openCreatePaymentPlan();
  cy.chooseMuiSelect('Type', 'Product');
  // Product type: 'Product' picker and 'Periodicity (no of months)' shown.
  cy.contains('label', 'Product').should('be.visible');
  cy.contains('label', 'Periodicity (no of months)').should('be.visible');

  cy.enterMuiInput('Code', plan.code);
  cy.enterMuiInput('Name', plan.name);
  cy.chooseMuiSelect('Calculation Rule', plan.rule);
  cy.chooseMuiAutocomplete('Product', plan.product);
  cy.enterMuiInput('Periodicity (no of months)', '1');
  cy.enterDateInput('Valid from', todayDmy());
  cy.contains('Additional parameters').should('be.visible');
  fillParams(plan.params);

  cy.savePaymentPlan('Create Payment Plan');
  cy.assertJournalNoFail('Failed to');
  created.push(plan.code);

  cy.filterPaymentPlans({ code: plan.code });
  // The Benefit Product column renders a read-only picker: its value is in an input.
  cy.contains('table tbody tr', plan.code).should(($row) => {
    const values = $row.find('input').toArray().map((i) => i.value);
    expect(values.join(' | '), 'Benefit Product column').to.contain(plan.product);
  });

  cy.openPaymentPlanForEditFromList(plan.code);
  cy.assertMuiInput('Code', plan.code);
  cy.assertMuiInput('Name', plan.name);
  cy.assertMuiSelectValue('Calculation Rule', plan.rule);
  cy.assertMuiAutoComplete('Product', plan.product);
  verifyParams(plan.params);
};

const planCode = (prefix) => `${prefix}${runId}`;

describe('UAT Benefit Plan - Payment Plans', () => {
  before(() => {
    cy.login();
    seedProgram();
  });

  after(() => {
    cy.login();
    created.forEach((code) => cy.deletePaymentPlan(code, { useCodeFilter: true }));
    deleteProgram();
  });

  beforeEach(() => {
    cy.login();
  });

  it('creates a Program payment plan with the social protection rule (OCM-1227)', () => {
    const plan = { code: planCode('PPCT'), name: `UAT PP Cash Transfer ${runId}` };
    cy.openCreatePaymentPlan();
    cy.chooseMuiSelect('Type', 'Program');
    cy.contains('label', 'Periodicity (no of months)').should('not.exist');

    cy.enterMuiInput('Code', plan.code);
    cy.enterMuiInput('Name', plan.name);
    cy.chooseMuiSelect('Calculation Rule', 'Calculation rule: social protection');
    cy.chooseMuiAutocomplete('Program', program.code);
    cy.enterDateInput('Valid from', todayDmy());
    const params = { inputs: { 'Fixed amount': 100, 'Limit Per Single Transaction': 200 } };
    fillParams(params);

    cy.savePaymentPlan('Create Payment Plan');
    cy.assertJournalNoFail('Failed to');
    created.push(plan.code);

    cy.filterPaymentPlans({ code: plan.code });
    cy.assertTableRowVisible([plan.code, plan.name]);

    cy.openPaymentPlanForEditFromList(plan.code);
    cy.assertMuiAutoComplete('Program', program.code);
    verifyParams(params);
  });

  it('creates a Product payment plan with the fees rule (OCM-410)', () => {
    createProductPlan({
      code: planCode('PPFE'),
      name: `UAT PP Fees ${runId}`,
      rule: 'payment: fees',
      product: productCode('basic'),
      params: { inputs: { 'Fee rate(%)': 1, 'Payment origin': 'Mobile' } },
    });
  });

  it('creates a Product payment plan with the commission rule (OCM-409)', () => {
    createProductPlan({
      code: planCode('PPCO'),
      name: `UAT PP Commission ${runId}`,
      rule: 'payment: commission',
      product: productCode('extended'),
      params: { inputs: { 'Commission rate(%)': 10 } },
    });
  });

  it('creates a Product payment plan with the capitation rule (OCM-408)', () => {
    createProductPlan({
      code: planCode('PPCA'),
      name: `UAT PP Capitation ${runId}`,
      rule: 'payment: capitation',
      product: productCode('basic'),
      params: {
        selects: { 'claim type': 'All', 'Level 1': 'Health center' },
        inputs: { 'Share Contribution': 40, 'Weight Adjusted Amount': 100 },
      },
    });
  });

  it('creates a Product payment plan with the fee-for-service rule (OCM-407)', () => {
    const distributions = Object.fromEntries(
      Array.from({ length: 12 }, (_, i) => [`distribution ${i + 1}`, 50]),
    );
    createProductPlan({
      code: planCode('PPFS'),
      name: `UAT PP Fee for Service ${runId}`,
      rule: 'payment: fee for service',
      product: productCode('basic'),
      params: {
        selects: { 'claim type': 'All', 'Level 1': 'Hospital', 'Level 2': 'Dispensary' },
        inputs: distributions,
      },
    });
  });
});
