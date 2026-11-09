import { baseline } from '../support/baseline';

// ------------------ TEST DATA ------------------
// Filled in before(). The uninsured family (village r1d1m1v1) has no policy, so the
// policy this spec creates and deletes is the only one on it. The insured family's
// active policy is left alone. The officer is officerR1d1, coherent with that village
// (same district, r1d1). The product is the national basic cover; the payer is the
// baseline payer of region r1. Nothing is placed in region r2.
const openIMISHeadInsuree = {
  chfId: null,
};

const policy = {
  product: { code: null, name: null },
  officer: { code: null },
};

const premium = {
  amount: null, // half the product lump sum, so the payment stays below the policy value
  receiptNo: `Receipt-${Date.now().toString(36)}`,
  paymentDate: { day: '26', month: '02', year: '2026' },
  payer: null,
  paymentType: 'Cash',
};

// ------------------ NAVIGATION ------------------
const goToFamilyList = () => {
  cy.goToSubMenu('Insurees and Policies', 'Families/Group');
};

const goToExistingFamilyForm = (head) => {
  goToFamilyList();

  cy.enterMuiInput('Head Ins. No.', head.chfId, 'input');
  cy.scrollTo('right', { ensureScrollable: false });
  cy.contains('button', 'Search').click({ force: true });

  cy.openRowByValue(head.chfId);
};

// ------------------ HELPERS ------------------
const selectPolicy = (policy) => {
  cy.contains('tr', policy.product.code).click();
};

// ------------------ POLICY ------------------
const addPolicy = (head, policy) => {
  goToExistingFamilyForm(head);

  cy.contains('button', 'Add policy').click({ force: true });
  cy.chooseMuiAutocomplete('Product', policy.product.name);
  cy.chooseMuiSelect('Officer', policy.officer.code);

  cy.save();
  cy.contains('button', 'Close').click();
};

const verifyPolicyDetails = (head, policy, updatedData = null) => {
  policy = updatedData ? { ...policy, ...updatedData } : policy;

  goToExistingFamilyForm(head);

  cy.contains('tr', policy.product.code).should('exist');
  cy.contains('tr', policy.product.code).within(() => {
    cy.contains(policy.product.name).should('exist');
  });
};

const verifyPolicyRemoved = (head, policy) => {
  goToFamilyList();

  cy.enterMuiInput('Head Ins. No.', head.chfId, 'input');
  cy.contains('button', 'Search').click({ force: true });

  cy.get('body').then(($body) => {
    const exists = $body.find('tr').toArray().some(row =>
      row.innerText.includes(policy.product.code)
    );

    expect(exists).to.be.false;
  });
};

// ------------------ PREMIUM ------------------
const payPremium = (head, policy, premium) => {
  goToExistingFamilyForm(head);
  selectPolicy(policy);

  cy.get('[aria-label="Add new contribution"]').click({ force: true });

  cy.chooseMuiDatePicker('Payment Date', premium.paymentDate);
  cy.chooseMuiSelect('Payer', premium.payer);
  cy.chooseMuiSelect('Payment Type', premium.paymentType);
  cy.enterMuiInput('Amount', premium.amount);
  cy.enterMuiInput('Receipt No.', premium.receiptNo);

  cy.save();

  cy.get('body').then(($dialog) => {
    if ($dialog.text().includes('lower than the policy value')) {
      cy.contains('button', 'OK').click();
      cy.contains('button', 'Yes').click();
    }

    if ($dialog.text().includes('matches the value')) {
      cy.contains('button', 'OK').click();
    }
  });
};

const verifyPremiumDetails = (head, policy, premium, updatedData = null) => {
  premium = updatedData ? { ...premium, ...updatedData } : premium;

  goToExistingFamilyForm(head);
  selectPolicy(policy);

  cy.contains('tr', premium.receiptNo).should('exist');
  // Amounts are shown formatted after fe-core's thousandSeparator locale ("fr" by
  // default: "1 000,00"; "en": "1,000.00"): look for the amount in either form.
  cy.contains('tr', premium.receiptNo).should(($row) => {
    const plain = (text) => text.replace(/[\u00a0\u202f]/g, ' ');
    const formatted = ['en-US', 'fr'].map((locale) => plain(new Intl.NumberFormat(locale, {
      minimumFractionDigits: 2, maximumFractionDigits: 2,
    }).format(Number(premium.amount))));
    const text = plain($row.text());
    expect(
      formatted.some((amount) => new RegExp(`(^|[^\\d])${amount.replace(/[.]/g, '\\.')}($|[^\\d])`).test(text)),
      `amount ${formatted.join(' or ')} in the premium row "${text}"`,
    ).to.be.true;
  });
};

const verifyPremiumRemoved = (head, policy, premium) => {
  goToExistingFamilyForm(head);
  selectPolicy(policy);

  cy.get('body').then(($body) => {
    const exists = $body.find('tr').toArray().some(row =>
      row.innerText.includes(premium.receiptNo)
    );

    expect(exists).to.be.false;
  });
};

// ------------------ DELETE ------------------
const deletePremium = (head, policy, premium, { failIfMissing = true } = {}) => {
  goToExistingFamilyForm(head);

  if (failIfMissing) {
    // A policy's premiums are listed once the policy is selected, after their own
    // fetch: wait for the row rather than inspecting the page once.
    selectPolicy(policy);
    cy.contains('tr', premium.receiptNo, { timeout: 15000 }).should('exist');
    // The delete is an icon button; its tooltip reads "Delete contribution".
    cy.clickRowAction(premium.receiptNo, 'Delete contribution');
    cy.contains('button', 'Yes').click();
    return;
  }

  cy.get('body').then(($body) => {
    const exists = $body.find('tr').toArray().some(row =>
      row.innerText.includes(premium.receiptNo)
    );

    if (!exists) {
      if (!failIfMissing) return;
      throw new Error(`Premium ${premium.receiptNo} not found`);
    }

    selectPolicy(policy);

    cy.clickRowAction(premium.receiptNo, 'Delete contribution');

    cy.contains('button', 'Yes').click();
  });
};

const deletePolicy = (head, policy, { failIfMissing = true } = {}) => {
  goToExistingFamilyForm(head);

  if (failIfMissing) {
    // The family's policies arrive after the page: wait for the row.
    cy.contains('tr', policy.product.code, { timeout: 15000 }).should('exist');
    cy.clickRowAction(policy.product.code, 'Delete');
    cy.contains('button', 'Ok').click();
    return;
  }

  cy.get('body').then(($body) => {
    const exists = $body.find('tr').toArray().some(row =>
      row.innerText.includes(policy.product.code)
    );

    if (!exists) {
      if (!failIfMissing) return;
      throw new Error(`Policy ${policy.product.code} not found`);
    }

    cy.clickRowAction(policy.product.code, 'Delete');

    cy.contains('button', 'Ok').click();
  });
};

// ------------------ TEST ------------------
// The flow works on the policy it creates and then deletes.
describe('Policy Workflow', () => {
  before(() => {
    const B = baseline();
    openIMISHeadInsuree.chfId = B.families.uninsured.head.chfId;
    policy.product.code = B.products.basic.code;
    policy.product.name = B.products.basic.name;
    policy.officer.code = B.users.officerR1d1.code;
    premium.amount = String(Number(B.products.basic.lumpSum) / 2);
    premium.payer = B.payer.name;
  });

  afterEach(() => {
    cy.login();
    deletePremium(openIMISHeadInsuree, policy, premium, { failIfMissing: false });
    deletePolicy(openIMISHeadInsuree, policy, { failIfMissing: false });
  });

  it('should execute complete policy flow cleanly', () => {

    cy.login();

    // --- Add policy ---
    addPolicy(openIMISHeadInsuree, policy);
    verifyPolicyDetails(openIMISHeadInsuree, policy);

    // --- Pay premium ---
    payPremium(openIMISHeadInsuree, policy, premium);
    verifyPremiumDetails(openIMISHeadInsuree, policy, premium);

    // --- Delete premium ---
    deletePremium(openIMISHeadInsuree, policy, premium);
    verifyPremiumRemoved(openIMISHeadInsuree, policy, premium);

    // --- Delete policy ---
    deletePolicy(openIMISHeadInsuree, policy);
    verifyPolicyRemoved(openIMISHeadInsuree, policy);

  });

});
