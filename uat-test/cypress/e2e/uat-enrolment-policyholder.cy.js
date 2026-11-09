// UAT: Enrolment / Policy holders and policy holder users (OCM-248..261).
//
// The baseline has no policy holder, contribution plan or bundle. The spec seeds them
// through the GraphQL API (one contribution plan "CV: percent of income" on
// products.basic, one bundle holding it) and gives every case its own policy holder,
// so a case never depends on what another one did. Everything created is deleted at
// the end.
//
// Coherent with district r1d1: policy holders are created in village r1d1m1v1, and the
// insuree they cover is the insured family's head, who lives there. The policy-holder
// user is the clerk (districts [r1d1]). Where a second user is required, the hospital
// claim admin (district r1d2) is used: a different district, and the case only
// attaches the user, it does not check that one user cannot see the other.
import { baseline, locationPath } from '../support/baseline';
import { TIMEOUTS } from '../support/constants';

const runId = Date.now().toString(36).slice(-5).toUpperCase();
const TODAY = new Date();
const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (days) => new Date(Date.now() + days * 86400000);

// Class uuid of "CV: percent of income" (calcrule_contribution_income_percentage),
// registered by the installed module, not a row of the database.
const INCOME_PERCENT_RULE = '0e1b6dd4-04a0-4ee6-ac47-2a99cfa5e9a8';

const headInsuree = () => {
  const head = baseline().families.insured.head;
  return {
    id: head.id,
    chfId: head.chfId,
    lastName: head.lastName,
    otherNames: head.otherNames,
    name: `${head.otherNames} ${head.lastName}`,
  };
};
// Interactive baseline users. clerk shares district r1d1 with the policy holder;
// hospitalClaimAdmin is district r1d2.
const portalUser = (role) => {
  const user = baseline().users[role];
  return { uuid: user.userUuid, username: user.username };
};

// ------------------ GraphQL seeding ------------------
const uuidv4 = () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
  const r = (Math.random() * 16) | 0;
  return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
});
const decodeId = (relayId) => atob(relayId).split(':')[1];
const jsonExt = (obj) => JSON.stringify(JSON.stringify(obj));

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

const seeded = { policyHolders: [] };

const seedBundle = () => {
  const productId = baseline().products.basic.id;
  mutate('createContributionPlan', `code: "CP${runId}" name: "UAT CP ${runId}" calculation: "${INCOME_PERCENT_RULE}"
    benefitPlanType_Model: "Product" benefitPlanId: "${productId}" periodicity: 12 dateValidFrom: "${iso(TODAY)}"
    jsonExt: ${jsonExt({ calculation_rule: { rate: '5', includeFamily: false } })}`);
  mutate('createContributionPlanBundle', `code: "CB${runId}" name: "UAT bundle ${runId}" periodicity: 12 dateValidFrom: "${iso(TODAY)}"`);
  gql(`{ contributionPlan(code: "CP${runId}") { edges { node { id } } }
         contributionPlanBundle(code: "CB${runId}") { edges { node { id } } } }`).then((data) => {
    seeded.cpId = decodeId(data.contributionPlan.edges[0].node.id);
    seeded.bundleId = decodeId(data.contributionPlanBundle.edges[0].node.id);
    mutate('createContributionPlanBundleDetails',
      `contributionPlanBundleId: "${seeded.bundleId}" contributionPlanId: "${seeded.cpId}" dateValidFrom: "${iso(TODAY)}"`);
  });
};

// Creates a policy holder; with `bundle` it gets the seeded bundle, with `insuree`
// that insuree (income 1000) and with `user` that user. Yields { code, tradeName, id }.
const seedPolicyHolder = (suffix, { bundle = false, insuree = null, user = null } = {}) => {
  const ph = { code: `U${runId}${suffix}`, tradeName: `UAT PH ${runId} ${suffix}` };
  mutate('createPolicyHolder', `code: "${ph.code}" tradeName: "${ph.tradeName}" locationsId: ${baseline().locations.r1d1m1v1.id} dateValidFrom: "${iso(TODAY)}"`);
  gql(`{ policyHolder(code: "${ph.code}") { edges { node { id } } } }`).then((data) => {
    ph.id = decodeId(data.policyHolder.edges[0].node.id);
    seeded.policyHolders.push(ph.id);
    if (bundle || insuree) {
      mutate('createPolicyHolderContributionPlanBundle',
        `policyHolderId: "${ph.id}" contributionPlanBundleId: "${seeded.bundleId}" dateValidFrom: "${iso(TODAY)}"`);
    }
    if (insuree) {
      mutate('createPolicyHolderInsuree', `policyHolderId: "${ph.id}" insureeId: ${insuree.id}
        contributionPlanBundleId: "${seeded.bundleId}" dateValidFrom: "${iso(TODAY)}" jsonExt: ${jsonExt({ calculation_rule: { income: 1000 } })}`);
    }
    if (user) {
      mutate('createPolicyHolderUser', `policyHolderId: "${ph.id}" userId: "${user.uuid}" dateValidFrom: "${iso(TODAY)}"`);
    }
  });
  return cy.wrap(ph);
};

// ------------------ UI helpers ------------------
const dialog = () => cy.get('[role="dialog"]').filter(':visible').last();

// Select / Autocomplete inside the open dialog: their option lists render outside it.
const fieldIn = (label) => dialog().contains('label', label, { matchCase: false }).siblings('.MuiInputBase-root');
const selectIn = (label, value) => {
  fieldIn(label).find('[role="combobox"], [role="button"]').first().click();
  cy.get('[role="listbox"]').filter(':visible').last().contains('li', value).click();
  fieldIn(label).should('contain.text', value);
};
const autocompleteIn = (label, value) => {
  fieldIn(label).find('input').first().should('not.be.disabled').clear({ force: true }).type(value, { force: true });
  cy.contains('[role="listbox"] li, li[role="option"]', value).click();
};

const confirmDialog = () => cy.get('[role="dialog"] button.primaryButton').filter(':visible').click();

// Picks a date in the MUI X popper of the date field `label` inside `$scope` (dialogs
// render the popper outside themselves, so the shared within-less helpers pick the
// filter field with the same label instead).
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const pickDate = (scope, label, date) => {
  cy.get(scope).filter(':visible').last()
    .contains('label', label, { matchCase: false }).parent()
    .find('button[aria-label^="Choose date"]').click();
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

// Clicks the icon action whose tooltip is `label` in the row containing `rowText`.
const rowAction = (rowText, label) => {
  cy.contains('tbody tr', rowText).should('exist')
    .find(`:is([aria-label="${label}"],[title="${label}"])`).first()
    .then(($el) => cy.wrap($el.is('button, a') ? $el : $el.find('button, a').first()).click({ force: true }));
};

// Text of a row including the values of its read-only inputs (pickers render the
// bundle and the insuree name as disabled inputs).
const rowValues = ($row) => [$row.text(), ...$row.find('input').toArray().map((i) => i.value)].join(' ');
const firstRow = () => cy.get('tbody tr', { timeout: TIMEOUTS.SERVER_RESULT }).first();
const firstRowAction = (label) => firstRow().find(`:is([aria-label="${label}"],[title="${label}"])`).first()
  .then(($el) => cy.wrap($el.is('button, a') ? $el : $el.find('button, a').first()).click({ force: true }));

const searcherTitle = (regex) => cy.contains('.paperHeaderTitle, .tableTitle h6, h6', regex);
const countOf = (regex) => searcherTitle(regex).invoke('text').then((t) => Number(t.match(/\d+/)[0]));

const openPolicyHolder = (ph) => {
  cy.visit('/front/policyHolders');
  cy.enterMuiInput('Code', ph.code);
  cy.contains('button', 'Search').click({ force: true });
  cy.contains('tbody tr', ph.code).should('have.length', 1);
  rowAction(ph.code, 'Edit');
  cy.contains(`Policy Holder ${ph.code} - ${ph.tradeName}`).should('be.visible');
};

const openTab = (name, titleRegex) => {
  cy.contains('[role="tab"]', name).click();
  cy.waitForSearcherLoaded();
  searcherTitle(titleRegex).should('exist');
};

const expectDisabled = (label) => cy.contains('label', label, { matchCase: false }).parent()
  .find('input').first().should('be.disabled');

describe('UAT Enrolment - Policy holders', () => {
  before(() => {
    cy.login();
    seedBundle();
  });

  beforeEach(() => cy.login());

  after(() => {
    cy.login();
    cy.then(() => {
      // Deleting a policy holder only deactivates it (with its links).
      if (seeded.policyHolders.length) {
        mutate('deletePolicyHolder', `uuids: [${seeded.policyHolders.map((u) => `"${u}"`).join(', ')}]`, { allowError: true });
      }
      if (seeded.bundleId) mutate('deleteContributionPlanBundle', `uuids: ["${seeded.bundleId}"]`, { allowError: true });
      if (seeded.cpId) mutate('deleteContributionPlan', `uuids: ["${seeded.cpId}"]`, { allowError: true });
    });
  });

  it('Adds a policy holder (OCM-248)', () => {
    const code = `N${runId}`;
    cy.visit('/front/policyHolders');
    cy.waitForSearcherLoaded();
    cy.get(':is([aria-label="Create new Policy Holder"],[title="Create new Policy Holder"])').find('button, a').first().click({ force: true });
    cy.contains('To start creating new Policy Holder Insuree, you need to fill in General Information fields and click Save.')
      .should('be.visible');
    cy.enterMuiInput('Code', code);
    cy.enterMuiInput('Trade Name', `UAT new PH ${runId}`);
    cy.chooseLocation(locationPath('r1d1m1v1'));
    cy.pickTodayInDatePicker('Date Valid From');
    cy.clickSave('Save changes');
    cy.waitForJournalProgress();
    cy.assertJournalFirstEntryContains(`Create Policy Holder`);
    cy.assertJournalNoFail();
    // Once saved the code and start date are locked and the tabs can be used.
    expectDisabled('Code');
    cy.contains('To start creating new Policy Holder Insuree').should('not.exist');
    ['Policy Holder Insurees', 'Contribution Plan Bundles', 'Payments', 'Policy Holder Users', 'Contracts']
      .forEach((tab) => cy.contains('[role="tab"]', tab).should('not.have.attr', 'aria-disabled', 'true'));
    gql(`{ policyHolder(code: "${code}") { edges { node { id } } } }`).then((data) => {
      expect(data.policyHolder.edges, 'created policy holder').to.have.length(1);
      seeded.policyHolders.push(decodeId(data.policyHolder.edges[0].node.id));
    });
  });

  it('Edits a policy holder (OCM-249)', () => {
    const email = `uat-${runId.toLowerCase()}-${Date.now() % 100000}@example.org`;
    seedPolicyHolder('E').then((ph) => {
      openPolicyHolder(ph);
      expectDisabled('Code');
      cy.contains('label', 'Date Valid From').parent().find('button[aria-label^="Choose date"]').should('be.disabled');
      cy.enterMuiInput('Email', email);
      cy.clickSave('Save changes');
      cy.waitForJournalProgress();
      cy.assertJournalFirstEntryContains('Update Policy Holder');
      cy.assertJournalNoFail();
      cy.reload();
      cy.assertMuiInput('Email', email);
    });
  });

  it('Assigns a contribution plan bundle to a policy holder (OCM-250)', () => {
    seedPolicyHolder('B').then((ph) => {
      openPolicyHolder(ph);
      openTab('Contribution Plan Bundles', /0 Contribution Plan Bundles Found/);
      cy.get('.MuiFab-sizeSmall').first().click();
      dialog().should('contain', 'Add new Contribution Plan Bundle');
      dialog().find('button').contains('Add').should('be.disabled');
      selectIn('Contribution Plan Bundle', `CB${runId}`);
      pickDate('[role="dialog"]', 'Date Valid From', TODAY);
      dialog().find('button').contains('Add').click();
      cy.waitForJournalProgress();
      cy.assertJournalFirstEntryContains(`Create Contribution Plan Bundle for ${ph.code}`);
      cy.assertJournalNoFail();
      searcherTitle(/1 Contribution Plan Bundles Found/).should('exist');
      firstRow().should(($row) => expect(rowValues($row)).to.contain(`CB${runId}`));
    });
  });

  it('Edits an assigned contribution plan bundle (OCM-251)', () => {
    const validTo = addDays(60);
    seedPolicyHolder('C', { bundle: true }).then((ph) => {
      openPolicyHolder(ph);
      openTab('Contribution Plan Bundles', /1 Contribution Plan Bundles Found/);
      firstRowAction('Edit');
      dialog().should('contain', 'Edit Contribution Plan Bundle');
      dialog().contains('label', 'Contribution Plan Bundle').parent().find('input, [role="combobox"]').first()
        .should(($el) => expect($el.is(':disabled') || $el.attr('aria-disabled') === 'true', 'bundle read-only').to.be.true);
      dialog().contains('label', 'Date Valid From').parent().find('button[aria-label^="Choose date"]').should('be.disabled');
      pickDate('[role="dialog"]', 'Date Valid To', validTo);
      dialog().find('button').contains('Save').click();
      cy.waitForJournalProgress();
      cy.assertJournalFirstEntryContains(`Update Contribution Plan Bundle of ${ph.code}`);
      cy.assertJournalNoFail();
      firstRow().should('contain', iso(validTo));
    });
  });

  it('Replaces an assigned contribution plan bundle (OCM-252)', () => {
    seedPolicyHolder('R', { bundle: true }).then((ph) => {
      openPolicyHolder(ph);
      openTab('Contribution Plan Bundles', /1 Contribution Plan Bundles Found/);
      firstRowAction('Replace');
      dialog().should('contain', 'Add new version of Contribution Plan Bundle');
      dialog().contains('label', 'Date Valid From').parent().find('button[aria-label^="Choose date"]').should('not.be.disabled');
      pickDate('[role="dialog"]', 'Date Valid From', addDays(10));
      dialog().find('button').contains('Add').click();
      cy.waitForJournalProgress();
      cy.assertJournalFirstEntryContains(`Replace Contribution Plan Bundle of ${ph.code}`);
      cy.assertJournalNoFail();
      searcherTitle(/2 Contribution Plan Bundles Found/).should('exist');
      // The replaced version can no longer be edited or replaced.
      cy.contains('tbody tr', iso(addDays(10)), { timeout: TIMEOUTS.SERVER_RESULT }).should('exist');
      // The old version is the row valid from today.
      cy.get('tbody tr').filter((_, r) => r.innerText.match(/\d{4}-\d{2}-\d{2}/)?.[0] !== iso(addDays(10))).first()
        .find(':is([aria-label="Edit"],[title="Edit"])').then(($el) => {
          const $btn = $el.is('button') ? $el : $el.find('button');
          expect($btn.is(':disabled'), 'Edit of the replaced version disabled').to.be.true;
        });
    });
  });

  it('Deletes an assigned contribution plan bundle (OCM-253)', () => {
    seedPolicyHolder('D', { bundle: true }).then((ph) => {
      openPolicyHolder(ph);
      openTab('Contribution Plan Bundles', /1 Contribution Plan Bundles Found/);
      firstRowAction('Delete');
      dialog().should('contain', `Are you sure you want to delete CB${runId} - UAT bundle ${runId}?`)
        .and('contain', 'Deleting data does not mean erasing it');
      confirmDialog();
      cy.waitForJournalProgress();
      cy.assertJournalFirstEntryContains(`Delete Contribution Plan Bundle from ${ph.code}`);
      cy.assertJournalNoFail();
      // Collapse the journal drawer opened above: expanded, it covers the filter checkbox.
      cy.get('.MuiDrawer-paperAnchorRight button').first().click();
      cy.contains('button', 'Search').click({ force: true });
      searcherTitle(/0 Contribution Plan Bundles Found/).should('exist');
      cy.contains('label', 'Show Deleted Contribution Plan Bundles').click();
      cy.contains('button', 'Search').click({ force: true });
      firstRow().should(($row) => expect(rowValues($row)).to.contain(`CB${runId}`));
    });
  });

  it('Assigns a policy holder insuree (OCM-254)', () => {
    const head = headInsuree();
    seedPolicyHolder('I', { bundle: true }).then((ph) => {
      openPolicyHolder(ph);
      openTab('Policy Holder Insurees', /0 Policy Holder Insurees Found/);
      cy.get('.MuiFab-sizeSmall').first().click();
      dialog().should('contain', 'Add new Policy Holder Insuree');
      dialog().find('input').first().type(head.chfId);
      cy.get('[role="dialog"]', { timeout: TIMEOUTS.SERVER_RESULT }).filter(':visible').last().should('contain.html', head.otherNames);
      selectIn('Contribution Plan Bundle', `CB${runId}`);
      dialog().within(() => cy.enterMuiInput('Income', '1000'));
      pickDate('[role="dialog"]', 'Date Valid From', TODAY);
      dialog().find('button').contains('Add').click();
      cy.waitForJournalProgress();
      cy.assertJournalFirstEntryContains(`Create Policy Holder Insuree for ${ph.code}`);
      cy.assertJournalNoFail();
      searcherTitle(/1 Policy Holder Insurees Found/).should('exist');
      firstRow().should(($row) => expect(rowValues($row)).to.contain(head.lastName).and.contain(`CB${runId}`));
    });
  });

  it('Replaces an assigned policy holder insuree (OCM-255)', () => {
    seedPolicyHolder('P', { insuree: headInsuree() }).then((ph) => {
      openPolicyHolder(ph);
      openTab('Policy Holder Insurees', /1 Policy Holder Insurees Found/);
      firstRowAction('Replace');
      dialog().should('contain', 'Add new version of Policy Holder Insuree');
      dialog().find('input').first().should('be.disabled');
      pickDate('[role="dialog"]', 'Date Valid From', addDays(10));
      dialog().find('button').contains('Add').click();
      cy.waitForJournalProgress();
      cy.assertJournalFirstEntryContains(`Replace Policy Holder Insuree of ${ph.code}`);
      cy.assertJournalNoFail();
      searcherTitle(/2 Policy Holder Insurees Found/).should('exist');
    });
  });

  it('Edits an assigned policy holder insuree (OCM-256)', () => {
    seedPolicyHolder('Q', { insuree: headInsuree() }).then((ph) => {
      openPolicyHolder(ph);
      openTab('Policy Holder Insurees', /1 Policy Holder Insurees Found/);
      firstRowAction('Edit');
      dialog().should('contain', 'Edit Policy Holder Insuree');
      dialog().find('input').first().should('be.disabled');
      dialog().contains('label', 'Date Valid From').parent().find('button[aria-label^="Choose date"]').should('be.disabled');
      dialog().within(() => cy.enterMuiInput('Income', '2500'));
      dialog().find('button').contains('Save').click();
      cy.waitForJournalProgress();
      cy.assertJournalFirstEntryContains(`Update Policy Holder Insuree of ${ph.code}`);
      cy.assertJournalNoFail();
      firstRowAction('Edit');
      dialog().within(() => cy.verifyMuiInputValue('Income', '2500'));
    });
  });

  it('Deletes an assigned policy holder insuree (OCM-257)', () => {
    const head = headInsuree();
    seedPolicyHolder('X', { insuree: head }).then((ph) => {
      openPolicyHolder(ph);
      openTab('Policy Holder Insurees', /1 Policy Holder Insurees Found/);
      firstRowAction('Delete');
      dialog().should('contain', `Are you sure you want to delete ${head.name}?`)
        .and('contain', 'Deleting data does not mean erasing it');
      confirmDialog();
      cy.waitForJournalProgress();
      cy.assertJournalFirstEntryContains(`Delete Policy Holder Insuree from ${ph.code}`);
      cy.assertJournalNoFail();
      cy.contains('button', 'Search').click({ force: true });
      searcherTitle(/0 Policy Holder Insurees Found/).should('exist');
      cy.contains('label', 'Show Deleted Insurees').click();
      cy.contains('button', 'Search').click({ force: true });
      firstRow().should(($row) => expect(rowValues($row)).to.contain(head.lastName));
    });
  });

  describe('Policy holder users', () => {
    const filterUsers = (ph) => {
      cy.visit('/front/policyHolderUsers');
      cy.waitForSearcherLoaded();
      cy.chooseMuiSelect('Policy Holder', ph.code);
      cy.contains('button', 'Search').click({ force: true });
      // Searching the filter refetches the list: wait for the rows of this policy holder
      // only, so a row action is not clicked on a row about to be replaced.
      cy.get('tbody').should(($body) => {
        const rows = $body.find('tr').toArray();
        expect(rows.every((r) => r.innerText.includes(ph.code)), 'rows of the policy holder only').to.be.true;
      });
    };

    it('Adds a policy holder user (OCM-258)', () => {
      const user = portalUser('clerk');
      seedPolicyHolder('U').then((ph) => {
        filterUsers(ph);
        searcherTitle(/0 Policy Holder Users Found/).should('exist');
        cy.get(':is([aria-label="Add new Policy Holder User"],[title="Add new Policy Holder User"])').filter(':visible')
          .first().then(($el) => cy.wrap($el.is('button') ? $el : $el.find('button')).click());
        dialog().should('contain', 'Add new Policy Holder User');
        dialog().find('button').contains('Add').should('be.disabled');
        autocompleteIn('User', user.username);
        selectIn('Policy Holder', ph.code);
        pickDate('[role="dialog"]', 'Date Valid From', TODAY);
        dialog().find('button').contains('Add').click();
        cy.waitForJournalProgress();
        cy.assertJournalFirstEntryContains(`is added on`);
        cy.assertJournalNoFail();
        cy.contains('button', 'Search').click({ force: true });
        searcherTitle(/1 Policy Holder Users Found/).should('exist');
        cy.contains('tbody tr', user.username).should('contain', ph.code);
      });
    });

    it('Replaces a policy holder user (OCM-259)', () => {
      const user = portalUser('clerk');
      const replacement = portalUser('hospitalClaimAdmin');
      seedPolicyHolder('V', { user }).then((ph) => {
        filterUsers(ph);
        rowAction(user.username, 'Replace');
        dialog().should('contain', 'Add new version of Policy Holder User');
        autocompleteIn('User', replacement.username);
        pickDate('[role="dialog"]', 'Date Valid From', addDays(5));
        dialog().find('button').contains('Add').click();
        cy.waitForJournalProgress();
        cy.assertJournalFirstEntryContains('is replacing');
        cy.assertJournalNoFail();
        cy.contains('button', 'Search').click({ force: true });
        cy.contains('tbody tr', replacement.username).should('exist');
      });
    });

    it('Edits a policy holder user (OCM-260)', () => {
      const user = portalUser('clerk');
      const validTo = addDays(90);
      seedPolicyHolder('W', { user }).then((ph) => {
        filterUsers(ph);
        rowAction(user.username, 'Edit');
        // The title is checked last, so a wrong title does not hide the rest of the case.
        dialog().should('contain', 'User');
        dialog().contains('label', 'Date Valid From').parent().find('button[aria-label^="Choose date"]').should('be.disabled');
        pickDate('[role="dialog"]', 'Date Valid To', validTo);
        dialog().find('button').contains('Save').click();
        cy.waitForJournalProgress();
        cy.assertJournalFirstEntryContains('is updated');
        cy.assertJournalNoFail();
        // The new date is saved (server side) before it is looked for in the list.
        gql(`{ policyHolderUser(policyHolder_Code: "${ph.code}", user_Username: "${user.username}") { edges { node { dateValidTo } } } }`)
          .then((data) => {
            const saved = data.policyHolderUser.edges.map((e) => String(e.node.dateValidTo).slice(0, 10));
            expect(saved, 'Date Valid To saved').to.include(iso(validTo));
          });
        cy.contains('tbody tr', user.username, { timeout: TIMEOUTS.SERVER_RESULT }).should('contain', iso(validTo));
        rowAction(user.username, 'Edit');
        dialog().should('contain', 'Edit Policy Holder User');
      });
    });

    it('Deletes a policy holder user (OCM-261)', () => {
      const user = portalUser('clerk');
      seedPolicyHolder('Y', { user }).then((ph) => {
        filterUsers(ph);
        searcherTitle(/1 Policy Holder Users Found/).should('exist');
        rowAction(user.username, 'Delete');
        dialog().should('contain', 'Are you sure you want to delete')
          .and('contain', 'Deleting data does not mean erasing it');
        confirmDialog();
        cy.waitForJournalProgress();
        cy.assertJournalFirstEntryContains('is removed from');
        cy.assertJournalNoFail();
        cy.contains('button', 'Search').click({ force: true });
        searcherTitle(/0 Policy Holder Users Found/).should('exist');
        cy.contains('label', 'Show Deleted Users').click();
        cy.contains('button', 'Search').click({ force: true });
        cy.contains('tbody tr', user.username, { timeout: TIMEOUTS.SERVER_RESULT }).should('exist');
      });
    });
  });
});
