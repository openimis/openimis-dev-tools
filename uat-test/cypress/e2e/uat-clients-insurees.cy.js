// UAT "Clients / Insuree-": enrolment of a household (family, member, policy and
// contribution), enquiry, family and insuree changes, deletions, search and renewal.
// Families the cases start from are seeded through the GraphQL API; insurance numbers
// are 9 digits, unique per run. Everything created is deleted at the end.
import { TIMEOUTS } from '../support/constants';
import { baseline } from '../support/baseline';

const runSeq = Date.now() % 1000000;
// 7 + 6 run digits + 2 case digits would be 15: keep 9 digits, 2 for the case.
const chfId = (n) => `7${String(runSeq).padStart(6, '0')}${String(n).padStart(2, '0')}`;
const runTag = Date.now().toString(36).slice(-4).toUpperCase().replace(/\d/g, (d) => 'ABCDEFGHIJ'[d]);

// District r1d1 is coherent: families are created in village r1d1m1v1 and the policy
// officer is officerR1d1 (that district). The enquiry and the name search read the
// insured family, which lives in the same village. Nothing is placed in region r2.
const refs = () => {
  const B = baseline();
  return {
    villageId: B.locations.r1d1m1v1.id,
    villageLabel: B.locations.r1d1m1v1.label,
    product: B.products.basic,
    officerId: B.users.officerR1d1.id,
    officerCode: B.users.officerR1d1.code,
    payerName: B.payer.name,
    insuredHead: B.families.insured.head,
  };
};

// ------------------ API ------------------
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

const mutate = (name, input, label = `UAT clients ${name}`) => {
  const clientMutationId = uuidv4();
  return gql(`mutation { ${name}(input: { clientMutationId: "${clientMutationId}" clientMutationLabel: "${label}" ${input} }) { clientMutationId } }`)
    .then(() => cy.waitForMutationLog(clientMutationId));
};
const mutateOk = (name, input, label) => mutate(name, input, label)
  .then(({ status, error }) => expect(status, `${name}: ${error}`).to.eq(2));

const insureeInput = (i) => `chfId: "${i.chfId}" lastName: "${i.lastName}" otherNames: "${i.otherNames}" genderId: "${i.gender ?? 'M'}"
  dob: "${i.dob ?? '1980-06-15'}" cardIssued: false ${i.phone ? `phone: "${i.phone}"` : ''}`;

// Creates a family in village r1d1m1v1 with its head and members; yields { uuid, id } of the family.
const seedFamily = ({ head, members = [], confirmationNo = 'UAT-1', address = 'Seeded address' }) => {
  mutateOk('createFamily', `headInsuree: { ${insureeInput(head)} head: true } locationId: ${refs().villageId} poverty: false
    familyTypeId: "H" confirmationNo: "${confirmationNo}" address: "${address}"`);
  return gql(`{ families(headInsuree_ChfId: "${head.chfId}") { edges { node { id uuid } } } }`).then((data) => {
    const family = data.families.edges[0].node;
    const familyId = Number(atob(family.id).split(':')[1]);
    members.forEach((m) => mutateOk('createInsuree', `${insureeInput(m)} head: false familyId: ${familyId}`));
    // Yield through cy.wrap: the callback queued commands, so it may not return a plain value.
    return cy.wrap({ uuid: family.uuid, id: familyId }, { log: false });
  });
};

const seedPolicy = (familyId, { enrollDate, startDate, expiryDate, value = '10000.00' }) => mutateOk(
  'createPolicy',
  `enrollDate: "${enrollDate}" startDate: "${startDate}" expiryDate: "${expiryDate}" value: "${value}"
   productId: ${refs().product.id} familyId: ${familyId} officerId: ${refs().officerId}`,
);

// Policies covering the head insuree, i.e. the family's policies.
const familyPolicies = (headChfId) => gql(`{ policies(insureePolicies_Insuree_ChfId: "${headChfId}") { edges { node { uuid status stage value expiryDate } } } }`)
  .then((data) => [...new Map(data.policies.edges.map((e) => [e.node.uuid, e.node])).values()]);

const seededHeads = [];
const deleteFamilyApi = (headChfId) => gql(`{ families(headInsuree_ChfId: "${headChfId}") { edges { node { uuid } } } }`)
  .then((data) => {
    const uuid = data.families.edges[0]?.node.uuid;
    if (uuid) mutate('deleteFamilies', `uuids: ["${uuid}"] deleteMembers: true`);
  });

// ------------------ UI ------------------
const tableRows = () => cy.get('table tbody tr');

const openFamilyByHead = (head) => {
  cy.visit('/front/insuree/families');
  cy.enterMuiInput('Head Ins. No.', head.chfId);
  cy.contains('button', 'Search').click({ force: true });
  cy.openRowByValue(head.chfId);
  cy.contains(/Family\/Group/);
};

const searchInsuree = (label, value) => {
  cy.visit('/front/insuree/insurees');
  cy.contains(/\d+ Insurees Found/, { timeout: TIMEOUTS.BACKEND_VALIDATION });
  cy.enterMuiInput(label, value);
  cy.contains('button', 'Search').click({ force: true });
};

const confirmDialog = (titleText, buttonText = /^ok$/i) => {
  cy.contains('[role="dialog"]', titleText, { timeout: TIMEOUTS.BACKEND_VALIDATION }).contains('button', buttonText).click();
};

const fillInsuree = (i) => {
  cy.enterMuiInput('Insurance No.', i.chfId);
  cy.contains('label', 'Insurance No.').siblings('.MuiInputBase-root').find('input')
    .should('have.attr', 'aria-invalid', 'false');
  cy.enterMuiInput('Last Name', i.lastName);
  cy.enterMuiInput('Given Names', i.otherNames);
  cy.chooseMuiDatePicker('Birth Date', i.dobPicker);
  cy.chooseMuiSelect('Gender', i.genderLabel);
};

// Adds a contribution of `amount` to the selected policy and confirms the dialog.
const addContribution = (amount, receiptNo) => {
  cy.get('[aria-label="Add new contribution"]').click({ force: true });
  cy.pickTodayInDatePicker('Payment Date');
  cy.chooseMuiSelect('Payer', refs().payerName);
  cy.chooseMuiSelect('Payment Type', 'Cash');
  cy.enterMuiInput('Amount', String(amount));
  cy.enterMuiInput('Receipt No.', receiptNo);
  cy.save();
  cy.contains('[role="dialog"]', 'Contribution confirmation', { timeout: TIMEOUTS.BACKEND_VALIDATION })
    .should('contain', 'The contribution matches the value of the policy')
    .contains('button', /^ok$/i)
    .click();
  cy.waitForJournalProgress();
};

// ------------------ DATA ------------------
const person = (n, otherNames, extra = {}) => ({
  chfId: chfId(n), lastName: `Uat${runTag}`, otherNames, ...extra,
});

describe('Clients / Insurees', () => {
  after(() => {
    cy.login();
    seededHeads.forEach((head) => deleteFamilyApi(head));
  });

  beforeEach(() => {
    cy.login();
  });

  it('Enrols a new household with a member, a policy and its contribution (OCM-149)', () => {
    const head = person(1, 'Hanna', { dobPicker: { day: 10, month: 3, year: 1982 }, genderLabel: 'Female' });
    const member = person(2, 'Milo', { dobPicker: { day: 4, month: 9, year: 2010 }, genderLabel: 'Male' });
    seededHeads.push(head.chfId);
    const { villageLabel, product, officerCode } = refs();

    cy.visit('/front/insuree/families');
    cy.get('[aria-label="Create new Family"]').find('button').click({ force: true });
    cy.url().should('include', '/insuree/family');
    cy.chooseMuiSelect('Village', villageLabel);
    cy.chooseMuiSelect('Family Type', 'Household');
    cy.chooseMuiSelect('Confirmation Type', 'Municipality');
    cy.enterMuiInput('Confirmation No.', `C-${head.chfId}`);
    cy.enterMuiInput('Address details', 'Enrolment street 1', 'textarea');
    fillInsuree(head);
    cy.save();
    cy.waitForJournalProgress();
    cy.assertJournalNoFail();

    openFamilyByHead(head);
    cy.contains('tr', head.chfId);

    // Member
    cy.contains('button', 'Add new').click();
    fillInsuree(member);
    cy.save();
    cy.waitForJournalProgress();
    openFamilyByHead(head);
    cy.contains('tr', member.chfId);

    // Policy
    cy.contains('button', 'Add policy').click({ force: true });
    cy.chooseMuiAutocomplete('Product', product.name);
    cy.chooseMuiSelect('Officer', officerCode);
    cy.save();
    cy.waitForJournalProgress();
    openFamilyByHead(head);
    cy.contains('tr', product.code).should('contain', 'Idle');

    // Contribution of the policy value
    familyPolicies(head.chfId)
      .then((policies) => {
        expect(policies, 'policies of the family').to.have.length(1);
        const value = Number(policies[0].value);
        cy.contains('tr', product.code).click();
        addContribution(value, `R${head.chfId}`);
      });
    openFamilyByHead(head);
    cy.contains('tr', product.code).click();
    cy.contains('tr', `R${head.chfId}`);
    cy.contains('tr', product.code).should('contain', 'Active');
  });

  it('Enquires an insuree from the app bar (OCM-150)', () => {
    const enquire = (number) => {
      cy.get('input[placeholder="Insuree enquiry…"]').clear().type(`${number}{enter}`);
    };
    const { insuredHead, product } = refs();
    cy.visit('/front/home');
    enquire(insuredHead.chfId);
    cy.get('[role="dialog"]', { timeout: TIMEOUTS.BACKEND_VALIDATION }).within(() => {
      cy.contains(insuredHead.chfId);
      cy.contains(insuredHead.lastName);
      cy.contains(product.code);
      cy.contains('button', 'Close').click();
    });
    cy.get('[role="dialog"]').should('not.exist');
    cy.url().should('include', '/front/home');

    enquire('999999999');
    cy.contains('[role="dialog"]', 'No insuree with chfid 999999999 found.', { timeout: TIMEOUTS.BACKEND_VALIDATION })
      .contains('button', 'Close')
      .click();
  });

  it('Modifies a family (OCM-151)', () => {
    const head = person(10, 'Fabien');
    seededHeads.push(head.chfId);
    seedFamily({ head, confirmationNo: 'OLD-1', address: 'Old address' });

    openFamilyByHead(head);
    cy.enterMuiInput('Confirmation No.', `NEW-${runTag}`);
    cy.enterMuiInput('Address details', `New address ${runTag}`, 'textarea');
    cy.save();
    cy.waitForJournalProgress();
    cy.assertJournalNoFail();

    openFamilyByHead(head);
    cy.verifyMuiInputValue('Confirmation No.', `NEW-${runTag}`);
    cy.verifyMuiInputValue('Address details', `New address ${runTag}`, 'textarea');
  });

  it('Deletes an insuree from the family overview (OCM-163)', () => {
    const head = person(20, 'Gaston');
    const member = person(21, 'Gisele', { gender: 'F' });
    seededHeads.push(head.chfId);
    seedFamily({ head, members: [member] });

    searchInsuree('Insurance No.', member.chfId);
    cy.contains('1 Insurees Found', { timeout: TIMEOUTS.BACKEND_VALIDATION });
    cy.clickRowAction(member.chfId, 'Family');
    cy.url().should('include', '/familyOverview/');
    cy.contains('tr', member.chfId).contains('button', 'Delete').click();
    confirmDialog(`Delete insuree - `);
    cy.waitForJournalProgress();
    cy.assertJournalNoFail();
    cy.contains('tr', member.chfId).should('not.exist');
    gql(`{ insurees(chfId: "${member.chfId}") { totalCount } }`).then((d) => expect(d.insurees.totalCount).to.eq(0));
  });

  it('Searches insurees and shows historical values (OCM-305)', () => {
    const { insuredHead } = refs();
    searchInsuree('Last Name', insuredHead.lastName);
    cy.contains('tr', insuredHead.chfId, { timeout: TIMEOUTS.BACKEND_VALIDATION });
    tableRows().should(($rows) => {
      $rows.toArray().forEach((tr) => expect(tr.innerText).to.contain(insuredHead.lastName));
    });
    cy.contains('th', 'Valid To').should('not.exist');

    cy.toggleMuiCheckbox('Show historical values', true);
    cy.contains('button', 'Search').click({ force: true });
    cy.contains('th', 'Valid From', { timeout: TIMEOUTS.BACKEND_VALIDATION });
    cy.contains('th', 'Valid To');
  });

  it('Deletes an insuree from the insurees list (OCM-306)', () => {
    const head = person(30, 'Ines');
    const member = person(31, 'Igor');
    seededHeads.push(head.chfId);
    seedFamily({ head, members: [member] });

    searchInsuree('Insurance No.', member.chfId);
    cy.contains('1 Insurees Found', { timeout: TIMEOUTS.BACKEND_VALIDATION });
    cy.clickRowAction(member.chfId, 'Delete');
    cy.contains('[role="dialog"]', `Are you sure you want to delete insuree`).contains('button', /^ok$/i).click();
    cy.waitForJournalProgress();
    cy.assertJournalNoFail();

    searchInsuree('Insurance No.', member.chfId);
    cy.contains('0 Insurees Found', { timeout: TIMEOUTS.BACKEND_VALIDATION });
    cy.toggleMuiCheckbox('Show historical values', true);
    cy.contains('button', 'Search').click({ force: true });
    cy.contains('tr', member.chfId, { timeout: TIMEOUTS.BACKEND_VALIDATION });
  });

  it('Adds an insuree to an existing family (OCM-307)', () => {
    const head = person(40, 'Julien');
    const member = person(41, 'Jade', { dobPicker: { day: 2, month: 2, year: 2012 }, genderLabel: 'Female' });
    seededHeads.push(head.chfId);
    seedFamily({ head });

    openFamilyByHead(head);
    cy.contains('button', 'Add new').click();
    cy.url().should('include', '/insuree');
    fillInsuree(member);
    cy.save();
    cy.waitForJournalProgress();
    cy.assertJournalNoFail();

    openFamilyByHead(head);
    cy.contains('tr', member.chfId);
  });

  it('Modifies an insuree (OCM-368)', () => {
    const head = person(50, 'Karl');
    const member = person(51, 'Katia', { gender: 'F', phone: '600111222', dob: '1990-01-20' });
    seededHeads.push(head.chfId);
    seedFamily({ head, members: [member] });

    searchInsuree('Insurance No.', member.chfId);
    cy.openRowByValue(member.chfId);
    ['Insurance No.', 'Last Name', 'Given Names', 'Birth Date'].forEach((label) => cy.contains('label', label));
    // The page also shows the family head's read-only fields first: target the insuree's own.
    cy.enterMuiInput('Phone', '600999888', 'input', { editable: true });
    cy.chooseMuiDatePicker('Birth Date', { day: 21, month: 1, year: 1990, editable: true });
    cy.save();
    cy.waitForJournalProgress();
    cy.assertJournalNoFail();

    searchInsuree('Insurance No.', member.chfId);
    cy.openRowByValue(member.chfId);
    cy.verifyMuiInputValue('Phone', '600999888', 'input', { editable: true });
    cy.verifyMuiDatePickerValue('Birth Date', '21-01-1990', { editable: true });
  });

  it('Renews a policy and pays the renewal (OCM-152)', () => {
    const head = person(60, 'Lena');
    seededHeads.push(head.chfId);
    const year = new Date().getFullYear() - 1;
    const { product } = refs();
    seedFamily({ head }).then((family) => {
      seedPolicy(family.id, { enrollDate: `${year}-01-01`, startDate: `${year}-01-01`, expiryDate: `${year}-12-31` });
    });

    openFamilyByHead(head);
    cy.contains('tr', product.code).contains('button', 'Renew').click();
    cy.url().should('include', '/policy');
    // The renewal copies the product into the product picker: an input value
    // ("CODE Name"), which cy.contains does not search.
    cy.get('input', { timeout: TIMEOUTS.SERVER_RESULT }).should(($inputs) => {
      expect([...$inputs].map((input) => input.value)).to.include(`${product.code} ${product.name}`);
    });
    // The renewal copies the product but not the officer (PolicyForm._renewPolicy),
    // and a policy can't be saved without one.
    cy.chooseMuiSelect('Officer', refs().officerCode);
    cy.save();
    cy.waitForJournalProgress();
    cy.assertJournalNoFail();

    // The family overview shows no policy stage: the renewed policy's row is the one
    // with its expiry date (the expired one ends on ${year}-12-31).
    let renewedRow;
    cy.then(() => {
      pollUntilRenewed(head.chfId);
      familyPolicies(head.chfId).then((policies) => {
        const renewed = policies.find((p) => p.stage === 'R');
        expect(renewed, 'renewed policy').to.exist;
        renewedRow = () => cy.contains('tr', renewed.expiryDate.slice(0, 10));
        openFamilyByHead(head);
        renewedRow().should('contain', 'Idle').click();
        addContribution(Number(renewed.value), `RN${head.chfId}`);
      });
    });
    cy.then(() => {
      openFamilyByHead(head);
      renewedRow().click();
      cy.contains('tr', `RN${head.chfId}`);
      renewedRow().should('contain', 'Active');
    });
  });
});

// Waits until the family of the head has a renewed (stage R) policy.
function pollUntilRenewed(headChfId, attempt = 1) {
  familyPolicies(headChfId).then((policies) => {
    if (policies.some((p) => p.stage === 'R')) return;
    if (attempt >= 20) throw new Error(`family of ${headChfId} has no renewed policy: ${JSON.stringify(policies)}`);
    // eslint-disable-next-line cypress/no-unnecessary-waiting
    cy.wait(1000).then(() => pollUntilRenewed(headChfId, attempt + 1));
  });
}
