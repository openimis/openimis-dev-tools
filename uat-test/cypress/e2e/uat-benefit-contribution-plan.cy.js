import { baseline } from '../support/baseline';

// UAT: Benefit Plan / Contribution plans and contribution plan bundles.
// The tests share the data they create and run in order:
// plans (create, edit, delete) -> bundle (create, edit, attach, attached plan edit/version/delete,
// bundle version, delete).
const runId = Date.now().toString(36).slice(-5).toUpperCase();

const addDays = (days) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d;
};
const dmy = (d) => `${String(d.getDate()).padStart(2, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${d.getFullYear()}`;
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
// Tables format dates with formatDateFromISO (ISO in this set-up); accept either form.
const hasDate = (tr, d) => tr.innerText.includes(iso(d)) || tr.innerText.includes(dmy(d));

// Baseline basic product (national, no district). Read when a plan is created, not at import.
const productCode = () => baseline().products.basic.code;
const CALC_RULE = 'CV: percent of income';

const plan = { code: `CP${runId}`, name: `UAT CP ${runId}`, newName: `UAT CP ${runId} edited`, periodicity: '12' };
const planToDelete = { code: `CD${runId}`, name: `UAT CP ${runId} deleted`, periodicity: '12' };
const bundle = { code: `CB${runId}`, name: `UAT CPB ${runId}`, newName: `UAT CPB ${runId} edited`, periodicity: '12' };

// ------------------ MUTATIONS ------------------
// Journal labels carry the plan/bundle names, which are unique per run: check the
// MutationLog of that label instead of the journal drawer.
const gql = (query) => cy.request({ method: 'POST', url: '/api/graphql', body: { query }, log: false })
  .then(({ body }) => {
    if (body.errors?.length) throw new Error(JSON.stringify(body.errors));
    return body.data;
  });

const expectMutationSucceeded = (label, { timeout = 5000 } = {}) => {
  cy.waitForJournalProgress();
  const deadline = Date.now() + timeout;
  const poll = () => gql(`{ mutationLogs(clientMutationLabel: "${label}", first: 1, orderBy: "-request_date_time") { edges { node { status error } } } }`)
    .then((data) => {
      const node = data.mutationLogs.edges[0]?.node;
      if (node && node.status !== 0) {
        expect(node.status, `"${label}" succeeded (${node.error})`).to.eq(2);
        return;
      }
      if (Date.now() > deadline) throw new Error(`Mutation "${label}" not found or not processed`);
      cy.wait(1000, { log: false }).then(poll);
    });
  poll();
};

// ------------------ UI HELPERS ------------------
const tickFilter = (label) => cy.contains('label', label).find('input[type="checkbox"]').check({ force: true });
const confirmOk = () => cy.contains('[role="dialog"] button', /^ok$/i).click();

// MUI X date picker scoped to a container (the attach dialogs repeat the page's labels).
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const pickDateIn = (scope, label, date) => {
  cy.get(scope).contains('label', label).parent().find('button[aria-label^="Choose date"]').click();
  const target = `${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
  const step = (n = 0) => cy.get('.MuiPickerPopper-root .MuiPickersCalendarHeader-label').invoke('text').then((text) => {
    if (text.trim() === target) return;
    if (n > 24) throw new Error(`pickDateIn: could not reach ${target}`);
    // The popper keeps repositioning inside the dialog: Cypress sees it as animating.
    cy.get('.MuiPickerPopper-root .MuiPickersArrowSwitcher-nextIconButton').click({ waitForAnimations: false });
    step(n + 1);
  });
  step();
  cy.get('.MuiPickerPopper-root .MuiPickersDay-root')
    .not('.MuiPickersDay-dayOutsideMonth')
    .contains(new RegExp(`^${date.getDate()}$`))
    .click({ force: true, waitForAnimations: false });
  cy.get('.MuiPickerPopper-root').should('not.exist');
};

const searchPlans = (code, { showDeleted = false } = {}) => {
  cy.visit('/front/contributionPlans');
  cy.contains('Contribution Plans Found');
  cy.enterMuiInput('Code', code);
  if (showDeleted) tickFilter('Show Deleted');
  cy.contains('button', 'Search').click();
  cy.waitForSearcherLoaded();
};

const searchBundles = (code, { showDeleted = false, showHistory = false } = {}) => {
  cy.visit('/front/contributionPlanBundles');
  cy.contains('Contribution Plan Bundles Found');
  cy.enterMuiInput('Code', code);
  if (showDeleted) tickFilter('Show Deleted');
  if (showHistory) tickFilter('Show History');
  cy.contains('button', 'Search').click();
  cy.waitForSearcherLoaded();
};

const rowsWith = (text) => cy.get('tbody tr').filter((_, tr) => tr.innerText.includes(text));
const rowButton = (row, tooltip) => row.find(`:is([title="${tooltip}"],[aria-label="${tooltip}"])`).find('a, button').first();

const createPlan = (data) => {
  cy.visit('/front/contributionPlans');
  cy.contains('Contribution Plans Found');
  cy.clickCreate('Create new Contribution Plan');
  cy.contains('General Information');
  cy.enterMuiInput('Code', data.code);
  cy.enterMuiInput('Name', data.name);
  cy.chooseMuiSelect('Calculation Rule', CALC_RULE);
  // The form labels the insurance product picker "Product".
  cy.chooseMuiSelect('Product', productCode());
  cy.enterMuiInput('Periodicity (no of months)', data.periodicity);
  cy.selectDateFromCalendar('Valid from', dmy(addDays(0)));
};

const openBundle = (code) => {
  searchBundles(code);
  rowButton(cy.contains('tbody tr', code), 'Edit').click({ force: true });
  cy.contains('General Information');
  cy.contains(/\d+ Contribution Plans Attached/);
};

const attachedTitle = () => cy.contains('.tableTitle', /Contribution Plans Attached/);
const attachedPanel = () => attachedTitle().closest('.MuiPaper-root');
// A replaced attached plan has its "Add New Version" and "Edit" buttons disabled.
const isReplacedRow = (tr) => Cypress.$(tr)
  .find(':is([title="Add New Version"],[aria-label="Add New Version"],[title="Edit"],[aria-label="Edit"]) button:disabled').length >= 2;
const attachedRows = () => attachedPanel().find('tbody tr').filter((_, tr) => tr.innerText.includes(plan.code));

describe('UAT Benefit plan - Contribution plans and bundles', () => {
  beforeEach(() => {
    cy.login();
  });

  after(() => {
    // Delete what is left (plans and bundle) through the API.
    cy.login();
    gql(`{ contributionPlanBundle(code: "${bundle.code}") { edges { node { id isDeleted } } } }`).then((data) => {
      data.contributionPlanBundle.edges.filter((e) => !e.node.isDeleted).forEach((e) => {
        gql(`mutation { deleteContributionPlanBundle(input: { clientMutationId: "c${Date.now()}" clientMutationLabel: "UAT cleanup ${bundle.code}" uuids: ["${atob(e.node.id).split(':')[1]}"] }) { clientMutationId } }`);
      });
    });
    [plan, planToDelete].forEach((p) => {
      gql(`{ contributionPlan(code: "${p.code}") { edges { node { id isDeleted } } } }`).then((data) => {
        data.contributionPlan.edges.filter((e) => !e.node.isDeleted).forEach((e) => {
          gql(`mutation { deleteContributionPlan(input: { clientMutationId: "c${Date.now()}" clientMutationLabel: "UAT cleanup ${p.code}" uuids: ["${atob(e.node.id).split(':')[1]}"] }) { clientMutationId } }`);
        });
      });
    });
  });

  describe('Contribution plans', () => {
    it('adds a contribution plan (OCM-237)', () => {
      createPlan(plan);
      cy.contains('Additional parameters');
      cy.contains('label', 'Percentage of income').should('be.visible');
      cy.clickSave('Save changes');
      expectMutationSucceeded(`Create Contribution Plan - ${plan.name}`);
      searchPlans(plan.code);
      rowsWith(plan.code).should('have.length', 1).and('contain.text', plan.name);
    });

    it('edits a contribution plan (OCM-238)', () => {
      searchPlans(plan.code);
      cy.contains('tbody tr', plan.code).contains('a, button', 'Edit').click({ force: true });
      cy.contains('General Information');
      cy.assertMuiInputDisabled('Code', plan.code);
      cy.enterMuiInput('Name', plan.newName);
      cy.clickSave('Save changes');
      expectMutationSucceeded(`Update Contribution Plan - ${plan.newName}`);
      searchPlans(plan.code);
      rowsWith(plan.code).should('have.length', 1).and('contain.text', plan.newName);
    });

    it('deletes a contribution plan (OCM-239)', () => {
      createPlan(planToDelete);
      cy.clickSave('Save changes');
      expectMutationSucceeded(`Create Contribution Plan - ${planToDelete.name}`);
      searchPlans(planToDelete.code);
      cy.contains('tbody tr', planToDelete.code).contains('button', 'Delete').click({ force: true });
      cy.get('[role="dialog"]')
        .should('contain.text', `Delete Contribution Plan ${planToDelete.name}`)
        .and('contain.text', `Are you sure you want to delete ${planToDelete.name}?`);
      confirmOk();
      expectMutationSucceeded(`Delete Contribution Plan - ${planToDelete.name}`);
      searchPlans(planToDelete.code);
      rowsWith(planToDelete.code).should('have.length', 0);
    });

    it('finds the deleted contribution plan with Show Deleted (OCM-240)', () => {
      searchPlans(planToDelete.code, { showDeleted: true });
      cy.contains(/1 Contribution Plans? Found/);
      rowsWith(planToDelete.code).should(($rows) => {
        expect($rows, 'deleted plan row').to.have.length(1);
        const actions = $rows.find('a, button').filter((_, b) => /^(Edit|Delete)$/.test(b.textContent.trim()));
        expect(actions, 'Edit/Delete actions').to.have.length(0);
      });
    });
  });

  describe('Contribution plan bundles', () => {
    it('adds a contribution plan bundle (OCM-241)', () => {
      cy.visit('/front/contributionPlanBundles');
      cy.contains('Contribution Plan Bundles Found');
      cy.clickCreate('Create new Contribution Plan Bundle');
      cy.contains('General Information');
      attachedTitle().should('contain.text', '0 Contribution Plans Attached');
      cy.contains('To start creating new Contribution Plan, you need to fill in General Information fields and click Save.');
      attachedPanel().find('.paperHeaderAction button').should('be.disabled');

      cy.enterMuiInput('Code', bundle.code);
      cy.enterMuiInput('Name', bundle.name);
      cy.enterMuiInput('Periodicity (no of months)', bundle.periodicity);
      cy.selectDateFromCalendar('Valid from', dmy(addDays(0)));
      cy.clickSave('Save changes');
      expectMutationSucceeded(`Create Contribution Plan Bundle - ${bundle.name}`);

      searchBundles(bundle.code);
      rowsWith(bundle.code).should('have.length', 1).and('contain.text', bundle.name);
      openBundle(bundle.code);
      cy.assertMuiInputDisabled('Code', bundle.code);
      attachedPanel().find('.paperHeaderAction button').should('not.be.disabled');
    });

    it('edits a contribution plan bundle (OCM-246)', () => {
      openBundle(bundle.code);
      cy.assertMuiInputDisabled('Code', bundle.code);
      cy.enterMuiInput('Name', bundle.newName);
      cy.clickSave('Save changes');
      expectMutationSucceeded(`Update Contribution Plan Bundle - ${bundle.newName}`);
      searchBundles(bundle.code);
      rowsWith(bundle.code).should('have.length', 1).and('contain.text', bundle.newName);
    });

    it('attaches a contribution plan (OCM-242)', () => {
      openBundle(bundle.code);
      attachedPanel().find('.paperHeaderAction button').click();
      cy.contains('[role="dialog"]', 'Attach new contribution plan').should('be.visible');
      cy.contains('[role="dialog"] button', 'Create').should('be.disabled');
      cy.get('[role="dialog"]').contains('label', 'Contribution Plan')
        .siblings('.MuiInputBase-root').find('[role="combobox"], [role="button"]').first().click();
      cy.contains('[role="listbox"] li', plan.code).click();
      pickDateIn('[role="dialog"]', 'Valid from', addDays(0));
      cy.contains('[role="dialog"] button', 'Create').should('not.be.disabled').click();
      expectMutationSucceeded(`Attach new Contribution Plan to ${bundle.newName}`);

      openBundle(bundle.code);
      attachedTitle().should('contain.text', '1 Contribution Plans Attached');
      attachedRows().should('have.length', 1);
    });

    it('edits and versions the attached contribution plan (OCM-243)', () => {
      const validTo = addDays(60);
      const newVersionFrom = addDays(30);
      openBundle(bundle.code);
      rowButton(attachedRows().first(), 'Edit').click({ force: true });
      cy.contains('[role="dialog"]', 'Edit Contribution Plan').should('be.visible');
      pickDateIn('[role="dialog"]', 'Valid to', validTo);
      cy.contains('[role="dialog"] button', 'Save').click();
      expectMutationSucceeded(`Update ${plan.newName} of ${bundle.newName}`);

      openBundle(bundle.code);
      attachedRows().first().should(($tr) => expect(hasDate($tr[0], validTo), 'new Valid to').to.be.true);

      rowButton(attachedRows().first(), 'Add New Version').click({ force: true });
      cy.contains('[role="dialog"]', 'Add New Version of Contribution Plan').should('be.visible');
      pickDateIn('[role="dialog"]', 'Valid from', newVersionFrom);
      cy.contains('[role="dialog"] button', /^Add$/).click();
      expectMutationSucceeded(`Replace ${plan.newName} of ${bundle.newName}`);

      openBundle(bundle.code);
      attachedTitle().should('contain.text', '2 Contribution Plans Attached');
      // The replaced row ends at the new version's start and can no longer be edited or versioned.
      attachedRows().should(($rows) => {
        expect($rows.filter((_, tr) => hasDate(tr, newVersionFrom)), 'rows showing the new version start').to.have.length(2);
        expect($rows.filter((_, tr) => isReplacedRow(tr)), 'replaced row').to.have.length(1);
      });
    });

    it('deletes an attached contribution plan (OCM-244)', () => {
      openBundle(bundle.code);
      // Read the count once the rows are in: the title says 0 while they load.
      attachedRows().should('have.length.at.least', 1);
      attachedTitle().invoke('text').then((before) => {
        const count = parseInt(before, 10);
        attachedRows().filter((_, tr) => !isReplacedRow(tr)).first()
          // The Delete tooltip wraps the button itself (Edit and Add New Version wrap a div).
          .find('button:is([title="Delete"],[aria-label="Delete"]), :is([title="Delete"],[aria-label="Delete"]) button')
          .first()
          .click({ force: true });
        cy.get('[role="dialog"]')
          .should('contain.text', `Delete Contribution Plan ${plan.newName}`)
          .and('contain.text', `Are you sure you want to delete ${plan.newName}?`);
        confirmOk();
        expectMutationSucceeded(`Delete ${plan.newName} from ${bundle.newName}`);
        openBundle(bundle.code);
        attachedTitle().should('contain.text', `${count - 1} Contribution Plans Attached`);
      });
    });

    it('creates a new version of a contribution plan bundle (OCM-245)', () => {
      const newFrom = addDays(30);
      searchBundles(bundle.code);
      rowButton(cy.contains('tbody tr', bundle.code), 'Add New Version').click({ force: true });
      cy.location('pathname').should('match', /\/front\/contributionPlanBundles\/replaceContributionPlanBundle\//);
      // OP-3297: the app opens the bundle's edit page instead, and its save edits in place.
      cy.contains(`Add New Version of Contribution Plan Bundle ${bundle.newName}`);
      cy.assertMuiInputDisabled('Code', bundle.code);
      cy.selectDateFromCalendar('Valid from', dmy(newFrom));
      cy.clickSave('Save changes');
      expectMutationSucceeded(`Replace Contribution Plan Bundle - ${bundle.newName}`);

      // One current version; with history, the replaced one is listed too.
      searchBundles(bundle.code);
      rowsWith(bundle.code).should('have.length', 1);
      searchBundles(bundle.code, { showHistory: true });
      rowsWith(bundle.code).should('have.length', 2);
      // The old version ends where the new one starts.
      rowsWith(bundle.code).should(($rows) => expect($rows.filter((_, tr) => hasDate(tr, newFrom))).to.have.length(2));
    });

    it('deletes a contribution plan bundle (OCM-247)', () => {
      searchBundles(bundle.code);
      rowsWith(bundle.code).should('have.length', 1);
      rowButton(cy.contains('tbody tr', bundle.code), 'Delete').click({ force: true });
      cy.get('[role="dialog"]').should('contain.text', `Delete Contribution Plan Bundle ${bundle.newName}?`);
      confirmOk();
      expectMutationSucceeded(`Delete Contribution Plan Bundle - ${bundle.newName}`);
      searchBundles(bundle.code);
      rowsWith(bundle.code).should('have.length', 0);
      searchBundles(bundle.code, { showDeleted: true });
      rowsWith(bundle.code).should('have.length.at.least', 1);
    });
  });
});
