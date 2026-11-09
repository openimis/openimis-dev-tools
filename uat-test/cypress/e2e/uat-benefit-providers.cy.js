import { baseline } from '../support/baseline';

// UAT: Benefit Plan / Providers / Health facilities (OCM-358..361).
// Every health facility and price list used here is created by the spec (codes unique
// per run) and removed at the end. Baseline health facilities are only read:
// the hospital (district r1d2) and the other hospital (district r2d1).
//
// Locations are read from the baseline inside before()/it(), never at import.
// Same-district coherence is r1d1: the seeded facilities, price lists A/B and the
// catchments (municipalities r1d1m1 and r1d1m3, villages r1d1m1v1 and r1d1m3v1).
// The modify case moves one facility to r1d2 (still region r1) and uses that
// district's price lists and village r1d2m1v1. Region r2 is the incoherent other region.

const runId = Date.now().toString(36).slice(-5).toUpperCase();
const today = new Date().toISOString().slice(0, 10);

// District-level price lists: the HF form only offers the lists of the selected district.
// `district` is a baseline location alias, resolved when the list is seeded.
const priceLists = {
  servicesA: { kind: 'Services', name: `UAT HF SPL A ${runId}`, district: 'r1d1' },
  servicesB: { kind: 'Services', name: `UAT HF SPL B ${runId}`, district: 'r1d1' },
  servicesC: { kind: 'Services', name: `UAT HF SPL C ${runId}`, district: 'r1d2' },
  itemsA: { kind: 'Items', name: `UAT HF IPL A ${runId}`, district: 'r1d1' },
  itemsB: { kind: 'Items', name: `UAT HF IPL B ${runId}`, district: 'r1d1' },
  itemsC: { kind: 'Items', name: `UAT HF IPL C ${runId}`, district: 'r1d2' },
};

// Codes: 'HF' + letter + 5-char run id = 8 characters (max 8).
const hfCreate = { code: `HFC${runId}`, name: `UAT HF Create ${runId}` };
const hfModify = { code: `HFM${runId}`, name: `UAT HF Modify ${runId}` };
const hfDelete = { code: `HFD${runId}`, name: `UAT HF Delete ${runId}` };
const hfSearch = {
  code: `HFS${runId}`,
  name: `UAT HF Search ${runId}`,
  phone: `0700${runId}`,
  fax: `0800${runId}`,
  email: `hf${runId.toLowerCase()}@uat.example`,
};
const createdHfCodes = [hfCreate.code, hfModify.code, hfDelete.code, hfSearch.code];

// ------------------ GRAPHQL HELPERS ------------------
const uuidv4 = () =>
  'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
const decodeId = (relayId) => +atob(relayId).split(':')[1];

const gql = (query, variables) =>
  cy.request({ method: 'POST', url: '/api/graphql', body: { query, variables }, log: false }).then(({ body }) => {
    if (body.errors?.length) throw new Error(`GraphQL error: ${JSON.stringify(body.errors)}`);
    return body.data;
  });

// Sends a mutation and polls its MutationLog: the response only means it was queued.
const mutate = (name, input, { failOnError = true } = {}) => {
  const clientMutationId = uuidv4();
  return gql(`mutation { ${name}(input: { clientMutationId: "${clientMutationId}" clientMutationLabel: "UAT ${name}" ${input} }) { clientMutationId } }`)
    .then(() => cy.waitForMutationLog(clientMutationId))
    .then(({ status, error }) => {
      if (failOnError && status !== 2) throw new Error(`${name} failed: ${error}`);
      return status;
    });
};

const priceListId = (pl) =>
  gql(`{ ${pl.kind.toLowerCase()}Pricelists(name: "${pl.name}") { edges { node { id uuid } } } }`).then(
    (data) => data[`${pl.kind.toLowerCase()}Pricelists`].edges[0]?.node,
  );

const seedPriceList = (pl) =>
  mutate(`create${pl.kind}Pricelist`, `name: "${pl.name}" pricelistDate: "${today}" locationId: "${baseline().locations[pl.district].uuid}"`);

const hfNode = (code) =>
  gql(`{ healthFacilities(code: "${code}", showHistory: true) { edges { node {
    id uuid code name level careType phone fax email validityTo legalForm { code }
    location { code } servicesPricelist { name } itemsPricelist { name }
    catchments { catchment location { code } } } } } }`).then((d) => d.healthFacilities.edges.map((e) => e.node));

// Creates a health facility through the API (same mutation the form sends).
const seedHf = (hf, { district = 'r1d1', legalForm = 'G', level = 'C', careType = 'B', services, items } = {}) => {
  const locationId = baseline().locations[district].id;
  const extra = [];
  ['phone', 'fax', 'email'].forEach((k) => hf[k] && extra.push(`${k}: "${hf[k]}"`));
  const withLists = (services ? priceListId(services) : cy.wrap(null)).then((s) =>
    (items ? priceListId(items) : cy.wrap(null)).then((i) => {
      if (s) extra.push(`servicesPricelistId: ${decodeId(s.id)}`);
      if (i) extra.push(`itemsPricelistId: ${decodeId(i.id)}`);
    }));
  withLists.then(() => mutate('createHealthFacility', `code: "${hf.code}" name: "${hf.name}" locationId: ${locationId}
    level: "${level}" legalFormId: "${legalForm}" careType: "${careType}" ${extra.join(' ')}`));
};

// ------------------ UI HELPERS ------------------
const searchHf = (filters = {}) => {
  cy.visit('/front/location/healthFacilities');
  cy.waitForSearcherLoaded();
  Object.entries(filters).forEach(([label, value]) => cy.enterMuiInput(label, value));
  cy.contains('button', 'Search').click({ force: true });
  cy.waitForSearcherLoaded();
};

const resultRows = () => cy.get('tbody tr');

// A village (or other location) line of the catchment panel: "CODE - Name".
const catchmentRow = (text) => cy.contains('li', text);
const catchmentInput = (text) => catchmentRow(text).find('input');

// Location AutoSuggestion holding a value: an Autocomplete. Emptied, with few options,
// it re-renders as a Select (fe-core selectThreshold), which is then picked from.
const chooseLocation = (label, value) => {
  cy.contains('label', label).siblings('.MuiInputBase-root').find('input').first().clear({ force: true });
  cy.chooseMuiSelect(label, value);
};

const confirmDialog = () => cy.contains('button', /^(ok|yes)$/i).click();

// ------------------ TESTS ------------------
describe('Benefit Plan - Providers - Health facilities', () => {
  before(() => {
    cy.login();
    Object.values(priceLists).forEach(seedPriceList);
    seedHf(hfModify, { services: priceLists.servicesA, items: priceLists.itemsA });
    seedHf(hfDelete);
    seedHf(hfSearch, { level: 'H', careType: 'I' });
  });

  after(() => {
    cy.login();
    createdHfCodes.forEach((code) => {
      hfNode(code).then((nodes) => {
        const live = nodes.find((n) => !n.validityTo);
        if (live) mutate('deleteHealthFacility', `uuid: "${live.uuid}" code: "${code}"`, { failOnError: false });
      });
    });
    Object.values(priceLists).forEach((pl) => {
      priceListId(pl).then((node) => {
        if (node) mutate(`delete${pl.kind}Pricelist`, `uuids: ["${node.uuid}"]`, { failOnError: false });
      });
    });
  });

  beforeEach(() => {
    cy.login();
  });

  it('Creates a health facility with price lists and catchments (OCM-358)', () => {
    // Coherent with district r1d1: price lists A/B and catchments in r1d1m1 / r1d1m1v1
    // and r1d1m3 / r1d1m3v1. Region r2 (and the hospital in r1d2) must not be offered.
    const B = baseline();
    const region = B.locations.r1;
    const district = B.locations.r1d1;
    const municipalityA = B.locations.r1d1m1;
    const villageA = B.locations.r1d1m1v1;
    const municipalityB = B.locations.r1d1m3;
    const villageB = B.locations.r1d1m3v1;

    cy.visit('/front/location/healthFacilities');
    cy.waitForSearcherLoaded();
    cy.get('.fab button').click();
    cy.location('pathname').should('eq', '/front/location/healthFacility');
    cy.assertSaveDisabled();

    // Every mandatory field but Care Type: Save stays disabled.
    cy.chooseMuiSelect('Region', region.label);
    cy.chooseMuiSelect('District', district.label);
    cy.chooseMuiAutocomplete('Health Facility Legal Form', 'Government');
    cy.chooseMuiSelect('Health Facility Level', 'Health Center');
    cy.enterMuiInput('Code', hfCreate.code);
    cy.enterMuiInput('Name', hfCreate.name);
    cy.assertSaveDisabled();
    cy.chooseMuiSelect('Care Type', 'In & Out - Patient');
    cy.assertSaveEnabled();

    // Price list pickers only offer the lists of the selected district.
    ['Services Pricelist', 'Items Pricelist'].forEach((label) => {
      cy.contains('label', label).siblings('.MuiInputBase-root').find('[role="combobox"]').click();
      cy.get('[role="listbox"]').should(($list) => {
        const options = $list.find('li').toArray().map((li) => li.textContent.trim());
        const kind = label.startsWith('Services') ? 'SPL' : 'IPL';
        expect(options, label).to.include.members([`UAT HF ${kind} A ${runId}`, `UAT HF ${kind} B ${runId}`]);
        // Lists of the district, its region or national ones are valid. Region r2 is not,
        // nor is another district of region r1 (the hospital's lists, and list C).
        const otherHf = B.healthFacilities.otherHospital;
        const hospital = B.healthFacilities.hospital;
        const otherList = label.startsWith('Services') ? otherHf.servicesPricelist.name : otherHf.itemsPricelist.name;
        const hospitalList = label.startsWith('Services') ? hospital.servicesPricelist.name : hospital.itemsPricelist.name;
        expect(
          options.filter((o) => o.includes(B.locations.r2.name) || o === otherList),
          `${label}: lists of another region`,
        ).to.be.empty;
        expect(options, `${label}: list of another district`).not.to.include(`UAT HF ${kind} C ${runId}`);
        expect(options, `${label}: hospital list is district r1d2`).not.to.include(hospitalList);
      });
      cy.contains('[role="listbox"] li', `UAT HF ${label.startsWith('Services') ? 'SPL' : 'IPL'} A ${runId}`).click();
    });

    // Catchments: region > district > municipality, then a percentage per village.
    catchmentRow(region.dashLabel).find('.MuiListItemButton-root').click();
    catchmentRow(district.dashLabel).find('.MuiListItemButton-root').click();
    catchmentRow(municipalityA.dashLabel).find('.MuiListItemButton-root').click();
    catchmentInput(villageA.dashLabel).clear();
    catchmentInput(villageA.dashLabel).type('50');
    catchmentRow(municipalityB.dashLabel).find('.MuiListItemButton-root').click();
    catchmentInput(villageB.dashLabel).clear();
    catchmentInput(villageB.dashLabel).type('30');
    catchmentRow(municipalityA.dashLabel).find('.MuiListItemButton-root').click();
    catchmentInput(villageA.dashLabel).should('have.value', '50');
    catchmentRow(municipalityB.dashLabel).find('.MuiListItemButton-root').click();
    catchmentInput(villageB.dashLabel).should('have.value', '30');

    cy.clickSave();
    cy.waitForJournalProgress();
    cy.assertJournalFirstEntryContains(`Create Health Facility ${hfCreate.code}`);
    cy.assertJournalNoFail();

    searchHf({ Code: hfCreate.code });
    resultRows().should('have.length', 1).first()
      .should('contain', hfCreate.name).and('contain', 'Government').and('contain', 'Health Center')
      .and('contain', district.dashLabel);
    hfNode(hfCreate.code).then(([hf]) => {
      expect(hf.servicesPricelist?.name).to.eq(priceLists.servicesA.name);
      expect(hf.itemsPricelist?.name).to.eq(priceLists.itemsA.name);
      const catchments = Object.fromEntries(hf.catchments.map((c) => [c.location.code, c.catchment]));
      expect(catchments).to.deep.include({ [villageA.code]: 50, [villageB.code]: 30 });
    });
  });

  it('Searches health facilities by location, classification and text filters (OCM-359)', () => {
    // Coherent: region r1, then its district r1d1 (where this spec's facilities were seeded).
    const region = baseline().locations.r1;
    const district = baseline().locations.r1d1;

    cy.visit('/front/location/healthFacilities');
    cy.waitForSearcherLoaded();

    const expectEveryRow = (text) =>
      resultRows().should(($rows) => {
        expect($rows.length, 'result rows').to.be.above(0);
        $rows.toArray().forEach((row) => expect(row.innerText, `row ${row.innerText.split('\t')[0]}`).to.include(text));
      });
    const search = () => {
      cy.contains('button', 'Search').click({ force: true });
      cy.waitForSearcherLoaded();
    };

    cy.chooseMuiSelect('Region', region.label);
    search();
    cy.contains(/\d+ Health Facilities Found/).should('be.visible');
    expectEveryRow(region.dashLabel);

    cy.chooseMuiSelect('District', district.label);
    search();
    expectEveryRow(district.dashLabel);

    // Classification filters, one at a time (the seeded HF is a hospital, In - Patient).
    cy.visit('/front/location/healthFacilities');
    cy.waitForSearcherLoaded();
    cy.chooseMuiAutocomplete('Health Facility Legal Form', 'Government');
    search();
    expectEveryRow('Government');

    cy.visit('/front/location/healthFacilities');
    cy.waitForSearcherLoaded();
    cy.chooseMuiSelect('Health Facility Level', 'Hospital');
    search();
    expectEveryRow('Hospital');

    cy.visit('/front/location/healthFacilities');
    cy.waitForSearcherLoaded();
    cy.chooseMuiSelect('Care Type', 'In - Patient');
    search();
    expectEveryRow('In - Patient');

    // Text filters, each with a part of the seeded HF's value.
    [
      ['Code', hfSearch.code.slice(0, 6)],
      ['Name', `Search ${runId}`],
      ['Phone', hfSearch.phone.slice(2)],
      ['Fax', hfSearch.fax.slice(2)],
      ['Email', hfSearch.email.split('@')[0]],
    ].forEach(([label, value]) => {
      cy.visit('/front/location/healthFacilities');
      cy.waitForSearcherLoaded();
      cy.enterMuiInput(label, value);
      search();
      expectEveryRow(value);
      cy.contains('tbody tr', hfSearch.code).should('exist');
    });

    // History: one more version of the seeded HF, then 'Show historical values'.
    hfNode(hfSearch.code).then(([hf]) => {
      // Same district r1d1: the new version stays where the facility was seeded.
      const locationId = baseline().locations.r1d1.id;
      mutate('updateHealthFacility', `uuid: "${hf.uuid}" code: "${hf.code}" name: "${hf.name} v2" locationId: ${locationId}
        level: "H" legalFormId: "G" careType: "I"`);
    });
    cy.visit('/front/location/healthFacilities');
    cy.waitForSearcherLoaded();
    cy.enterMuiInput('Code', hfSearch.code);
    cy.contains('label', 'Show historical values').find('input[type="checkbox"]').check({ force: true });
    search();
    cy.contains('th', 'Validity To').should('be.visible');
    resultRows().should('have.length', 2);
    cy.contains('tbody tr', `${hfSearch.name} v2`).should('exist');
  });

  it('Modifies a health facility: price lists, district, catchments and details (OCM-360)', () => {
    // The facility starts in r1d1. Moving it to r1d2 stays in region r1 and uses that
    // district's price lists and village r1d2m1v1 (coherent with the new district).
    const B = baseline();
    const region = B.locations.r1;
    const district = B.locations.r1d2;
    const municipality = B.locations.r1d2m1;
    const village = B.locations.r1d2m1v1;

    searchHf({ Code: hfModify.code });
    cy.openRowByValue(hfModify.code);
    cy.contains(`Health Facility ${hfModify.code}`).should('be.visible');
    cy.verifyMuiInputValue('Name', hfModify.name);
    cy.assertMuiSelectValue('Services Pricelist', priceLists.servicesA.name);
    cy.assertMuiSelectValue('Items Pricelist', priceLists.itemsA.name);

    // Other price lists of the same district.
    cy.chooseMuiSelect('Services Pricelist', priceLists.servicesB.name);
    cy.chooseMuiSelect('Items Pricelist', priceLists.itemsB.name);
    cy.assertMuiSelectValue('Services Pricelist', priceLists.servicesB.name);
    cy.assertMuiSelectValue('Items Pricelist', priceLists.itemsB.name);

    // New district: its price lists, then catchments in its villages.
    chooseLocation('District', district.label);
    cy.chooseMuiSelect('Services Pricelist', priceLists.servicesC.name);
    cy.chooseMuiSelect('Items Pricelist', priceLists.itemsC.name);
    catchmentRow(region.dashLabel).find('.MuiListItemButton-root').click();
    catchmentRow(district.dashLabel).find('.MuiListItemButton-root').click();
    catchmentRow(municipality.dashLabel).find('.MuiListItemButton-root').click();
    catchmentInput(village.dashLabel).clear();
    catchmentInput(village.dashLabel).type('40');

    cy.chooseMuiAutocomplete('Health Facility Legal Form', 'Private organization');
    cy.chooseMuiSelect('Health Facility Level', 'Dispensary');
    cy.chooseMuiSelect('Care Type', 'Out - Patient');
    const updated = {
      name: `${hfModify.name} upd`,
      phone: `0711${runId}`,
      fax: `0811${runId}`,
      email: `m${runId.toLowerCase()}@uat.example`,
    };
    cy.enterMuiInput('Name', updated.name);
    cy.enterMuiInput('Phone', updated.phone);
    cy.enterMuiInput('Fax', updated.fax);
    cy.enterMuiInput('Email', updated.email);

    cy.clickSave();
    cy.waitForJournalProgress();
    cy.assertJournalFirstEntryContains(hfModify.code);
    cy.assertJournalNoFail();

    // Re-open: the new values are stored.
    searchHf({ Code: hfModify.code });
    cy.openRowByValue(hfModify.code);
    cy.verifyMuiInputValue('Name', updated.name);
    cy.verifyMuiInputValue('Phone', updated.phone);
    cy.verifyMuiInputValue('Fax', updated.fax);
    cy.verifyMuiInputValue('Email', updated.email);
    cy.assertMuiSelectValue('Health Facility Level', 'Dispensary');
    cy.assertMuiSelectValue('Care Type', 'Out - Patient');
    cy.assertMuiSelectValue('Services Pricelist', priceLists.servicesC.name);
    cy.assertMuiSelectValue('Items Pricelist', priceLists.itemsC.name);
    hfNode(hfModify.code).then((nodes) => {
      const hf = nodes.find((n) => !n.validityTo);
      expect(hf.location.code).to.eq(district.code);
      expect(hf.legalForm.code).to.eq('P');
      expect(hf.catchments.map((c) => [c.location.code, c.catchment])).to.deep.include([village.code, 40]);
    });

    // The previous version is listed with 'Show historical values'.
    cy.visit('/front/location/healthFacilities');
    cy.waitForSearcherLoaded();
    cy.enterMuiInput('Code', hfModify.code);
    cy.contains('label', 'Show historical values').find('input[type="checkbox"]').check({ force: true });
    cy.contains('button', 'Search').click({ force: true });
    cy.waitForSearcherLoaded();
    cy.contains('tbody tr', hfModify.name).should('exist');
    cy.contains('tbody tr', updated.name).should('exist');
  });

  it('Deletes a health facility (OCM-361)', () => {
    searchHf({ Code: hfDelete.code });
    cy.contains('tbody tr', hfDelete.code).should('exist');
    cy.clickRowAction(hfDelete.code, 'Delete');
    cy.contains('Delete Health Facility').should('be.visible');
    cy.contains(`Are you sure you want to delete Health Facility ${hfDelete.code} - ${hfDelete.name}?`).should('be.visible');
    confirmDialog();
    cy.waitForJournalProgress();
    cy.assertJournalFirstEntryContains(`Delete Health Facility ${hfDelete.code}`);
    cy.assertJournalNoFail();

    // The result list should drop the row once the deletion is done; checked at the end
    // so the rest of the case still runs when it does not.
    let rowLeftAfterDelete;
    cy.wait(5000); // eslint-disable-line cypress/no-unnecessary-waiting -- give the searcher time to refresh
    cy.get('tbody').then(($tbody) => { rowLeftAfterDelete = $tbody.text().includes(hfDelete.code); });
    searchHf({ Code: hfDelete.code });
    cy.get('tbody').should('not.contain', hfDelete.code);

    cy.contains('label', 'Show historical values').find('input[type="checkbox"]').check({ force: true });
    cy.contains('button', 'Search').click({ force: true });
    cy.waitForSearcherLoaded();
    cy.contains('tbody tr', hfDelete.code).should('exist');
    cy.then(() => expect(rowLeftAfterDelete, 'deleted HF still listed (greyed) after the journal completed').to.be.false);
  });
});
