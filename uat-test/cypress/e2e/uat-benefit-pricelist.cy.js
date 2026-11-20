import { baseline } from '../support/baseline';

// UAT: Benefit Plan / Medical items and services price lists.
// Per kind, the tests share one price list and run in order:
// create -> override a price -> modify -> delete -> history.
// Each price list is filed under district r1d2 (region r1), the same district as the
// baseline hospital. This spec does not attach the list to that hospital, so the
// district only has to exist. Details are the first three baseline items or services,
// read in beforeEach.
const runId = Date.now().toString(36).slice(-5).toUpperCase();

// ------------------ MUTATIONS ------------------
// Journal labels carry the price list name, unique per run: check that MutationLog.
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

// ------------------ HELPERS ------------------
// Amounts follow the locale, e.g. "$ 1 001,00" or "$1,001.00".
const amount = (text) => {
  let t = String(text).replace(/[^0-9.,-]/g, '');
  if (/,\d{1,2}$/.test(t)) t = t.replace(/\./g, '').replace(',', '.');
  else t = t.replace(/,/g, '');
  return Number(t);
};

const searchPricelists = (kind, name, { history = false } = {}) => {
  cy.visit(`/front/medical/pricelists/${kind.path}`);
  cy.contains(/\d+ Pricelists/);
  cy.enterMuiInput('Name', name);
  if (history) cy.contains('label', 'Show Historical Values').find('input[type="checkbox"]').check({ force: true });
  cy.contains('button', 'Search').click({ force: true });
  cy.waitForSearcherLoaded();
};

const listRows = (name) => cy.get('tbody tr').filter((_, tr) => tr.innerText.includes(name));

const openPricelist = (kind, name) => {
  searchPricelists(kind, name);
  listRows(name).should('have.length', 1).first().dblclick({ force: true });
  cy.location('pathname').should('match', new RegExp(`/front/medical/pricelists/${kind.path}/[0-9a-f-]{36}$`));
  cy.contains(`Pricelist (${name})`).should('be.visible');
};

// Details table: filter by code, then take the row whose Code cell is exactly the code.
const detailRow = (code) => {
  cy.contains('label', /^Code$/).last().siblings('.MuiInputBase-root').find('input').clear().type(code);
  return cy.get('tbody tr').should(($rows) => {
    expect($rows.filter((_, tr) => tr.cells[1]?.innerText.trim() === code).length, `detail row ${code}`).to.eq(1);
  }).then(($rows) => cy.wrap($rows.filter((_, tr) => tr.cells[1].innerText.trim() === code).first()));
};

// Exact value, not a substring: a name merged with the old one still contains the new one.
const nameInput = () => cy.contains('label', /^Name\b/).first().siblings('.MuiInputBase-root').find('input').first();

const setDetail = (code, checked) => {
  detailRow(code).find('input[type="checkbox"]').then(($box) => {
    if ($box.is(':checked') !== checked) cy.wrap($box).click({ force: true });
  });
  detailRow(code).find('input[type="checkbox"]').should(checked ? 'be.checked' : 'not.be.checked');
};

const deleteLeftovers = (kind, names) => {
  // Price lists are not demo data here: remove the ones this run left behind.
  names.forEach((name) => {
    gql(`{ ${kind.query}(name: "${name}") { edges { node { uuid validityTo } } } }`).then((data) => {
      data[kind.query].edges.filter((e) => !e.node.validityTo).forEach((e) => {
        gql(`mutation { ${kind.deleteMutation}(input: { clientMutationId: "c${Date.now()}" clientMutationLabel: "UAT cleanup ${name}" uuids: ["${e.node.uuid}"] }) { clientMutationId } }`);
      });
    });
  });
};

const medicalCodes = (label) =>
  (label === 'items' ? baseline().items : baseline().services).slice(0, 3).map((row) => row.code);

const KINDS = [
  {
    label: 'items',
    path: 'items',
    query: 'itemsPricelists',
    deleteMutation: 'deleteItemsPricelist',
    ocm: { add: 189, override: 190, modify: 191, remove: 193, history: 194 },
    name: `UAT IPL ${runId}`,
  },
  {
    label: 'services',
    path: 'services',
    query: 'servicesPricelists',
    deleteMutation: 'deleteServicesPricelist',
    ocm: { add: 195, override: 196, modify: 197, remove: 199, history: 200 },
    name: `UAT SPL ${runId}`,
  },
];

KINDS.forEach((kind) => {
  const newName = `${kind.name} v2`;
  let first;
  let second;
  let third;
  let regionLabel;
  let districtLabel;

  describe(`UAT Benefit plan - Medical ${kind.label} price lists`, () => {
    beforeEach(() => {
      const B = baseline();
      regionLabel = B.locations.r1.label;
      districtLabel = B.locations.r1d2.label;
      [first, second, third] = medicalCodes(kind.label);
      cy.login();
    });

    after(() => {
      cy.login();
      deleteLeftovers(kind, [kind.name, newName]);
    });

    it(`adds a medical ${kind.label} price list (OCM-${kind.ocm.add})`, () => {
      cy.visit(`/front/medical/pricelists/${kind.path}`);
      cy.contains(/\d+ Pricelists/);
      cy.get('[aria-label="Add a new pricelist"]').find('button').click();
      cy.contains('New Pricelist').should('be.visible');
      cy.contains('h6', 'Details').should('be.visible');

      cy.enterMuiInput('Name', kind.name);
      cy.chooseMuiSelect('Region', regionLabel);
      cy.chooseMuiSelect('District', districtLabel);
      cy.pickTodayInDatePicker('Date');
      setDetail(first, true);
      setDetail(second, true);
      cy.contains('Name already taken').should('not.exist');
      cy.clickSave('Save changes');
      expectMutationSucceeded(`Pricelist created - ${kind.name}`);

      searchPricelists(kind, kind.name);
      listRows(kind.name).should('have.length', 1);
    });

    it(`overrides a price in the ${kind.label} price list (OCM-${kind.ocm.override})`, () => {
      openPricelist(kind, kind.name);
      detailRow(first).then(($row) => {
        const basePrice = amount($row[0].cells[4].innerText);
        const newPrice = basePrice + 1;
        cy.wrap($row).contains('button', 'Edit').click();
        cy.get('[role="dialog"]').should('contain.text', 'Override Price')
          .and('contain.text', 'You can override the price of this element for this pricelist');
        cy.get('[role="dialog"]').contains('label', 'Price').siblings('.MuiInputBase-root').find('input')
          .clear().type(String(newPrice));
        cy.contains('[role="dialog"] button', 'Save').click();
        cy.get('[role="dialog"]').should('not.exist');
        detailRow(first).should(($r) => {
          expect(amount($r[0].cells[4].innerText), 'Base Price unchanged').to.eq(basePrice);
          expect(amount($r[0].cells[5].innerText), 'List Price').to.eq(newPrice);
        });
        cy.clickSave('Save changes');
        expectMutationSucceeded(`Pricelist updated - ${kind.name}`);

        openPricelist(kind, kind.name);
        detailRow(first).should(($r) => {
          expect(amount($r[0].cells[5].innerText), 'List Price after re-open').to.eq(newPrice);
        });
      });
    });

    it(`modifies a medical ${kind.label} price list (OCM-${kind.ocm.modify})`, () => {
      openPricelist(kind, kind.name);
      cy.enterMuiInput('Name', newName);
      setDetail(second, false);
      setDetail(third, true);
      // OP-3277: the price list fetched on opening must not overwrite these edits.
      nameInput().should('have.value', newName);
      detailRow(second).find('input[type="checkbox"]').should('not.be.checked');
      detailRow(third).find('input[type="checkbox"]').should('be.checked');
      cy.clickSave('Save changes');
      expectMutationSucceeded(`Pricelist updated - ${newName}`);

      openPricelist(kind, newName);
      nameInput().should('have.value', newName);
      detailRow(first).find('input[type="checkbox"]').should('be.checked');
      detailRow(second).find('input[type="checkbox"]').should('not.be.checked');
      detailRow(third).find('input[type="checkbox"]').should('be.checked');
      // The previous version is kept in history.
      searchPricelists(kind, kind.name, { history: true });
      listRows(kind.name).should('have.length.at.least', 2);
    });

    it(`deletes a medical ${kind.label} price list (OCM-${kind.ocm.remove})`, () => {
      searchPricelists(kind, newName);
      listRows(newName).should('have.length', 1).first().contains('button', 'Delete').click();
      cy.get('[role="dialog"]').should('contain.text', 'Delete pricelist')
        .and('contain.text', `Are you sure you want to delete the pricelist ${newName}?`);
      cy.contains('[role="dialog"] button', /^ok$/i).click();
      expectMutationSucceeded(`Pricelist deleted - ${newName}`);
      searchPricelists(kind, kind.name);
      listRows(kind.name).should('have.length', 0);
    });

    it(`finds all edited and deleted medical ${kind.label} price lists (OCM-${kind.ocm.history})`, () => {
      searchPricelists(kind, kind.name);
      listRows(kind.name).should('have.length', 0);
      searchPricelists(kind, kind.name, { history: true });
      listRows(kind.name).should('have.length.at.least', 2);
      listRows(newName).should('have.length.at.least', 1);
      // The version from before the rename is kept under its old name.
      listRows(kind.name).filter((_, tr) => tr.cells[0].innerText.trim() === kind.name).should('have.length.at.least', 1);
      // Every listed version is closed (Valid To set).
      cy.get('thead th').then(($th) => {
        const validTo = [...$th].findIndex((th) => th.innerText.trim() === 'Valid To');
        expect(validTo, 'Valid To column').to.be.at.least(0);
        listRows(kind.name).each(($tr) => {
          expect($tr[0].cells[validTo].innerText.trim(), 'Valid To').not.to.eq('');
        });
      });
    });
  });
});
