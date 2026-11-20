import { baseline } from '../support/baseline';

// Insurance numbers are unique: a run that fails before its clean-up leaves its insurees,
// so each run takes new 9-digit numbers (no modulo check by default).
const runSeq = Date.now() % 10000000;
const newChfId = (offset) => `6${String((runSeq + offset) % 10000000).padStart(7, '0')}${offset}`;

// ------------------ TEST DATA ------------------
const insurees = {
  head: {
    chfId: newChfId(0),
    givenNames: 'Sylvie',
    lastName: 'Chineze',
    gender: 'Female',
    phone: '602111111',
    email: 'sylvie@example.com',
    passport: 'AB7654321',
    maritalStatus: 'Married',
    profession: 'Employee',
    education: 'University',
    typeOfId: 'Passport',
    dob: { day: '15', month: '02', year: '1990' },
  },
  member: {
    chfId: newChfId(1),
    givenNames: 'Paul',
    lastName: 'Sandjong',
    gender: 'Male',
    phone: '602000000',
    email: 'paul@example.com',
    passport: 'AB1234567',
    maritalStatus: 'Married',
    profession: 'Employee',
    education: 'University',
    typeOfId: 'Passport',
    dob: { day: '18', month: '02', year: '1992' },
    updatedDob: { day: '19', month: '02', year: '1992' },
  },
};

const familyData = {
  // Village label, filled in before() from the baseline.
  location: null,
  familyType: 'Household',
  confirmationNo: 'CONF-001',
  confirmationType: 'Municipality',
  address: 'Douala, Cameroun',
};

// ------------------ GENERIC ------------------
const goToSubMenu = (menu, submenu) => cy.goToSubMenu(menu, submenu); // by route, see support/routes.js

// ------------------ INSUREE ------------------
const goToInsureeList = () => goToSubMenu('Insurees and Policies', 'Insurees');

const goToNewInsureeForm = () => {
  goToInsureeList();
  cy.get('[aria-label="Create new Insuree"]').click();
};

const goToExistingInsureeForm = (insuree) => {
  goToInsureeList();

  cy.enterMuiInput('Insurance No.', insuree.chfId, 'input');
  cy.scrollTo('right', { ensureScrollable: false });
  cy.contains('button', 'Search').click();
  cy.openRowByValue(insuree.chfId);
};

const fillInsureeForm = (insuree) => {
  cy.enterMuiInput('Insurance No.', insuree.chfId, 'input');
  cy.enterMuiInput('Last Name', insuree.lastName);
  cy.enterMuiInput('Given Names', insuree.givenNames);
  cy.enterMuiInput('Phone', insuree.phone);
  cy.enterMuiInput('Email', insuree.email);
  cy.chooseMuiDatePicker('Birth Date', insuree.dob);
  cy.chooseMuiSelect('Profession', insuree.profession);
  cy.chooseMuiSelect('Education', insuree.education);
  cy.chooseMuiSelect('Id Type', insuree.typeOfId);
  cy.chooseMuiSelect('Marital Status', insuree.maritalStatus);
  cy.chooseMuiSelect('Gender', insuree.gender);
};

const formatDate = ({ day, month, year }) => {
  const d = String(day).padStart(2, '0');
  const m = String(month).padStart(2, '0');
  return `${d}-${m}-${year}`;
};

const verifyInsureeDetails = (insuree, updatedData = null) => {
  insuree = updatedData ? { ...insuree, ...updatedData } : insuree;

  goToExistingInsureeForm(insuree);

  cy.verifyMuiInputValue('Insurance No.', insuree.chfId);
  cy.verifyMuiInputValue('Last Name', insuree.lastName);
  cy.verifyMuiInputValue('Given Names', insuree.givenNames);
  cy.verifyMuiInputValue('Phone', insuree.phone);
  cy.verifyMuiInputValue('Email', insuree.email);
  cy.verifyMuiSelectValue('Profession', insuree.profession);
  cy.verifyMuiSelectValue('Education', insuree.education);
  cy.verifyMuiSelectValue('Id Type', insuree.typeOfId);
  cy.verifyMuiSelectValue('Marital Status', insuree.maritalStatus);
  cy.verifyMuiSelectValue('Gender', insuree.gender);
  cy.verifyMuiDatePickerValue('Birth Date', formatDate(insuree.dob));
};

// Clean-up decides from the API whether there is something to delete, not from the
// searcher: right after "Search" the table still shows the previous results, and reading
// it there skipped every delete without a word (each run left its member insuree behind).
const gqlCount = (query, field) => cy
  .request({ method: 'POST', url: '/api/graphql', body: { query }, log: false })
  .then(({ body }) => {
    if (body.errors?.length) throw new Error(`GraphQL error: ${JSON.stringify(body.errors)}`);
    return body.data[field].totalCount;
  });
const countInsurees = (chfId) => gqlCount(`{ insurees(chfId: "${chfId}") { totalCount } }`, 'insurees');
const countFamilies = (headChfId) => gqlCount(`{ families(headInsuree_ChfId: "${headChfId}") { totalCount } }`, 'families');

// Deletes through the UI what the API lists, then checks through the API that it is gone.
// Nothing to delete is an error unless failIfMissing is false (clean-up after a test that
// may have stopped before creating it), and is logged either way.
const deleteThroughList = ({ what, count, openList, search, rowText, confirm }, { failIfMissing }) => {
  count().then((existing) => {
    if (!existing) {
      if (failIfMissing) throw new Error(`${what} not found`);
      cy.log(`${what} does not exist: nothing to delete`);
      return;
    }
    openList();
    search();
    cy.scrollTo('right', { ensureScrollable: false });
    cy.waitForSearcherLoaded();
    cy.clickRowAction(rowText, 'Delete');
    cy.contains('[role="dialog"] button', confirm, { matchCase: false }).click();
    cy.waitForJournalProgress();
    count().then((left) => expect(left, `${what} left after its delete`).to.eq(0));
  });
};

const deleteInsuree = (insuree, { failIfMissing = true } = {}) => deleteThroughList({
  what: `Insuree ${insuree.chfId}`,
  count: () => countInsurees(insuree.chfId),
  openList: goToInsureeList,
  search: () => {
    cy.enterMuiInput('Insurance No.', insuree.chfId, 'input');
    cy.contains('button', 'Search').click();
  },
  rowText: insuree.chfId,
  confirm: 'Ok',
}, { failIfMissing });

// ------------------ FAMILY ------------------
const goToFamilyList = () => goToSubMenu('Insurees and Policies', 'Families/Group');

const goToExistingFamilyForm = (head) => {
  goToFamilyList();

  cy.enterMuiInput('Head Ins. No.', head.chfId, 'input');
  cy.scrollTo('right', { ensureScrollable: false });
  cy.contains('button', 'Search').click({ force: true });

  cy.openRowByValue(head.chfId);
};

const goToNewFamilyForm = () => {
  goToFamilyList();

  cy.get('[aria-label="Create new Family"]')
    .find('button')
    .click({ force: true });
};

const fillFamilyForm = (data) => {
  cy.chooseMuiSelect('Village', data.location);
  cy.chooseMuiSelect('Family Type', data.familyType);
  cy.chooseMuiSelect('Confirmation Type', data.confirmationType);
  cy.enterMuiInput('Confirmation No.', data.confirmationNo);
  cy.enterMuiInput('Address details', data.address, 'textarea');
};

const verifyFamilyDetails = (head, updatedData = null) => {
  head = updatedData ? { ...head, ...updatedData } : head;

  goToExistingFamilyForm(head);

  cy.verifyMuiInputValue('Head Ins. No.', head.chfId);
  // The confirmation number is the family's (familyData), unless the update changed it.
  cy.verifyMuiInputValue('Confirmation No.', updatedData?.confirmationNo ?? familyData.confirmationNo);
  cy.verifyMuiSelectValue('Village', familyData.location);
  cy.verifyMuiSelectValue('Family Type', familyData.familyType);
  cy.verifyMuiSelectValue('Confirmation Type', familyData.confirmationType);
  cy.verifyMuiInputValue('Address details', familyData.address, 'textarea');

  // When the head was given members, they are listed on the family.
  if (head.members?.length) {
    head.members.forEach((member) => {
      cy.contains('tr', member.chfId).should('exist');
    });
  }
};

const addFamilyMember = (head, member) => {
  goToExistingFamilyForm(head);
  cy.contains('button', 'Add existing').click();
  // The family page has its own "Insurance No." field: type in the search dialog's.
  cy.get('[role="dialog"]').within(() => cy.enterMuiInput('Insurance No.', member.chfId, 'input'));
  cy.openRowByValue(member.chfId);
  cy.contains('button', /^Move and cancel policies$/i).click();
};

const removeFamilyMember = (head, member) => {
  goToExistingFamilyForm(head);
  cy.contains('tr', member.chfId)
    .within(() => cy.contains('button', 'Remove').click());
  cy.contains('button', /^Remove and cancel policies$/i).click();
};

const deleteFamily = (head, { failIfMissing = true } = {}) => deleteThroughList({
  what: `Family of ${head.chfId}`,
  count: () => countFamilies(head.chfId),
  openList: goToFamilyList,
  search: () => {
    cy.enterMuiInput('Head Ins. No.', head.chfId, 'input');
    cy.contains('button', 'Search').click();
  },
  rowText: head.chfId,
  confirm: 'Delete family and members',
}, { failIfMissing });

const verifyFamilyMemberRemoved = (head, member) => {
  goToExistingFamilyForm(head);

  cy.get('body').then(($body) => {
    const exists = $body.find('tr').toArray().some(row =>
      row.innerText.includes(member.chfId)
    );

    expect(exists).to.be.false;
  });
};

// ------------------ TESTS ------------------
describe('Family & Insuree Workflow', () => {
  before(() => {
    // The family this test creates sits in village r1d1m1v1, the same district (r1d1)
    // as the enrolment families. It picks no officer and checks no other region.
    familyData.location = baseline().locations.r1d1m1v1.label;
  });

  afterEach(() => {
    deleteFamily(insurees.head, { failIfMissing: false });
    deleteInsuree(insurees.member, { failIfMissing: false });
    deleteInsuree(insurees.head, { failIfMissing: false });
  });

  it('should execute complete flow cleanly (OCM-368)', () => {
    cy.login();

    // --- Insuree creation ---
    goToNewInsureeForm();
    fillInsureeForm(insurees.member);
    cy.save();
    verifyInsureeDetails(insurees.member);

    // --- Family creation ---
    goToNewFamilyForm();
    fillFamilyForm(familyData);
    fillInsureeForm(insurees.head);
    cy.save();
    verifyFamilyDetails(insurees.head);

    // --- Insuree update ---
    // The family page does not list the member yet: open it from the insurees list.
    goToExistingInsureeForm(insurees.member);
    cy.chooseMuiDatePicker('Birth Date', insurees.member.updatedDob);
    cy.save();
    verifyInsureeDetails(insurees.member, { dob: insurees.member.updatedDob });

    // --- Family update ---
    goToExistingFamilyForm(insurees.head);
    cy.enterMuiInput('Confirmation No.', 'CONF-002');
    cy.save();
    verifyFamilyDetails(insurees.head, { confirmationNo: 'CONF-002' });

    // --- Add / Remove family member ---
    addFamilyMember(insurees.head, insurees.member);
    removeFamilyMember(insurees.head, insurees.member);
    verifyFamilyMemberRemoved(insurees.head, insurees.member);
  });

});