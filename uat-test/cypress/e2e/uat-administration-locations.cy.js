// Administration > Locations (OCM-342..357).
//
// Every case works in a sub-tree under a Region created by this spec, with codes unique
// per run (location codes are limited to 8 characters by the UI). The UI-driven cases
// build the tree in order; the delete and move cases seed the extra locations they need
// through the GraphQL API. Whatever is left is dropped in after().
//
// The page does not reload a list after a mutation: a created or deleted row stays in
// place, greyed out, until the page is reloaded. Each check therefore re-opens the page.
//
// The tree below is created by this spec. Checks that an existing region is listed use
// baseline regions r1 and r2 (another region than this tree; no coherence with it).
// The duplicate-code check reuses r1's code. No demo region is required.
import { baseline } from '../support/baseline';

const runId = Date.now().toString(36).slice(-5).toUpperCase();
const code = (suffix) => `U${runId}${suffix}`; // at most 8 characters
const LOCATIONS_URL = '/front/location/locations';
const PANELS = ['Regions', 'Districts', 'Municipalities', 'Villages'];
const TIMEOUT = 5000;

const uuidv4 = () =>
  'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });

function gql(query) {
  return cy
    .request({ method: 'POST', url: '/api/graphql', body: { query }, log: false })
    .then(({ body }) => {
      if (body.errors?.length) throw new Error(`GraphQL error: ${JSON.stringify(body.errors)}`);
      return body.data;
    });
}

function mutate(name, input, label) {
  const clientMutationId = uuidv4();
  return gql(
    `mutation { ${name}(input: { clientMutationId: "${clientMutationId}" clientMutationLabel: "${label}" ${input} }) { clientMutationId } }`,
  )
    .then(() => cy.waitForMutationLog(clientMutationId))
    .then(({ status, error }) => {
      if (status !== 2) throw new Error(`${label} failed: ${error}`);
    });
}

const locationByCode = (locationCode) =>
  gql(`{ locations(code: "${locationCode}") { edges { node { uuid code name parent { code } } } } }`)
    .then((data) => data.locations.edges[0]?.node ?? null);

// Creates a location through the API; parentCode is omitted for a Region.
function seedLocation({ code: locationCode, name, type, parentCode }) {
  const withParent = parentCode
    ? locationByCode(parentCode).then((parent) => {
      expect(parent, `parent ${parentCode}`).to.not.be.null;
      return `parentUuid: "${parent.uuid}"`;
    })
    : cy.wrap('');
  withParent.then((parentInput) => mutate(
    'createLocation',
    `code: "${locationCode}" name: "${name}" type: "${type}" ${parentInput}`,
    `UAT seed - location ${locationCode}`,
  ));
}

// Drops a location and its sub-tree through the API, if it still exists.
function dropLocation(locationCode) {
  locationByCode(locationCode).then((location) => {
    if (!location) return;
    mutate('deleteLocation', `uuid: "${location.uuid}" code: "${locationCode}"`, `UAT cleanup - location ${locationCode}`);
  });
}

const panel = (title) => cy.contains('.paperHeaderTitle', new RegExp(`^\\s*${title}\\s*$`), { timeout: TIMEOUT })
  .closest('.paper');
const row = (title, text) => panel(title).contains('.MuiListItemButton-root', text, { timeout: TIMEOUT });
const rowItem = (title, text) => row(title, text).closest('li');

// The child panel lists exactly the children of the selected parent. The page
// auto-selects the first region, so a click that beats that fetch used to show
// the first region's districts under the clicked one (OP-3276).
function shouldListOnlyChildrenOf(title, parentCode) {
  locationByCode(parentCode)
    .then((parent) => gql(`{ locations(parent_Uuid: "${parent.uuid}") { edges { node { code name } } } }`))
    .then((data) => {
      const expected = data.locations.edges.map(({ node }) => label(node));
      panel(title).find('.MuiListItemButton-root', { timeout: TIMEOUT }).should(($rows) => {
        const shown = [...$rows].map((r) => r.innerText);
        expect(shown, `${title} under ${parentCode}`).to.have.length(expected.length);
        shown.forEach((text) => expect(expected.some((e) => text.includes(e)), text).to.be.true);
      });
    });
}

// Opens the Locations page and selects the given path, top-down (region, district, ...).
function openPath(...labels) {
  cy.visit(LOCATIONS_URL);
  // Baseline region r1: the regions list has rendered.
  row('Regions', baseline().locations.r1.dashLabel);
  labels.forEach((label, level) => {
    row(PANELS[level], label).click();
    row(PANELS[level], label).should('have.class', 'Mui-selected');
    if (PANELS[level + 1]) shouldListOnlyChildrenOf(PANELS[level + 1], label.split(' - ')[0]);
  });
}

const clickPanelAdd = (title) => panel(title).find('.paperHeader button')
  .filter((_, b) => b.textContent.trim() === 'add')
  .first()
  .click();

const clickRowIcon = (title, text, icon) => rowItem(title, text).find('button')
  .filter((_, b) => b.textContent.trim() === icon)
  .first()
  .click();

const dialog = () => cy.get('[role="dialog"]', { timeout: TIMEOUT });
const dialogInput = (label) => dialog().contains('label', label).siblings('.MuiInputBase-root').find('input');

function fillLocationDialog({ code: locationCode, name, population }) {
  if (locationCode !== undefined) dialogInput('Code').clear().type(locationCode);
  if (name !== undefined) dialogInput('Name').clear().type(name);
  if (population) {
    Object.entries(population).forEach(([label, value]) => dialogInput(label).clear().type(String(value)));
  }
}

function saveDialog() {
  dialog().contains('button', 'Save').should('not.be.disabled').click();
  cy.waitForJournalProgress();
  cy.get('[role="dialog"]').should('not.exist');
}

// Picks a value in an MUI Select of the open dialog, found by the id of its label.
function chooseDialogSelect(labelId, optionText) {
  dialog().find(`[role="combobox"][aria-labelledby~="${labelId}"]`).click();
  cy.contains('[role="listbox"] li', optionText).click();
}

const tree = {
  region: { code: code('R'), name: `UAT Region ${runId}` },
  district: { code: code('D'), name: `UAT District ${runId}` },
  municipality: { code: code('M'), name: `UAT Munic ${runId}` },
  village: { code: code('V'), name: `UAT Village ${runId}` },
};
const label = (l) => `${l.code} - ${l.name}`;

describe('Administration / Locations', () => {
  before(() => {
    cy.login();
  });

  beforeEach(() => {
    cy.login();
  });

  after(() => {
    cy.login();
    // Regions seeded or created by this run; drop removes their sub-trees.
    [tree.region.code, code('RB')].forEach(dropLocation);
  });

  it('Creates a Region and rejects a duplicate code (OCM-342)', () => {
    cy.visit(LOCATIONS_URL);
    PANELS.forEach((title) => panel(title).should('exist'));
    const regions = baseline().locations;
    row('Regions', regions.r1.dashLabel);
    row('Regions', regions.r2.dashLabel);

    clickPanelAdd('Regions');
    dialog().should('contain', 'New Region');
    dialog().contains('button', 'Save').should('be.disabled');
    fillLocationDialog(tree.region);
    saveDialog();
    row('Regions', label(tree.region));

    // An existing code is refused.
    clickPanelAdd('Regions');
    fillLocationDialog({ code: baseline().locations.r1.code, name: 'UAT duplicate' });
    dialog().should('contain', 'Location code already taken.');
    dialog().contains('button', 'Save').should('be.disabled');
    dialog().contains('button', 'Cancel').click();

    cy.reload();
    row('Regions', label(tree.region));
  });

  it('Modifies a Region (OCM-350)', () => {
    cy.visit(LOCATIONS_URL);
    row('Regions', label(tree.region)).dblclick();
    dialog().should('contain', `Modify Region`);
    dialogInput('Code').should('have.value', tree.region.code);
    dialogInput('Name').should('have.value', tree.region.name);
    tree.region.name = `${tree.region.name} upd`;
    fillLocationDialog({ name: tree.region.name });
    saveDialog();
    cy.reload();
    row('Regions', label(tree.region));
  });

  it('Creates a District (OCM-344)', () => {
    openPath(label(tree.region));
    panel('Districts').find('.MuiListItemButton-root').should('have.length', 0);
    clickPanelAdd('Districts');
    dialog().should('contain', 'New District');
    fillLocationDialog(tree.district);
    saveDialog();
    openPath(label(tree.region));
    row('Districts', label(tree.district));
  });

  it('Modifies a District (OCM-345)', () => {
    openPath(label(tree.region));
    row('Districts', label(tree.district)).dblclick();
    dialog().should('contain', `Modify District of ${label(tree.region)}`);
    tree.district.name = `${tree.district.name} upd`;
    fillLocationDialog({ name: tree.district.name });
    saveDialog();
    openPath(label(tree.region));
    row('Districts', label(tree.district));
  });

  it('Creates a Municipality (OCM-348)', () => {
    openPath(label(tree.region), label(tree.district));
    clickPanelAdd('Municipalities');
    dialog().should('contain', 'New Municipality');
    fillLocationDialog(tree.municipality);
    saveDialog();
    openPath(label(tree.region), label(tree.district));
    row('Municipalities', label(tree.municipality));
  });

  it('Modifies a Municipality (OCM-346)', () => {
    openPath(label(tree.region), label(tree.district));
    row('Municipalities', label(tree.municipality)).dblclick();
    dialog().should('contain', `Modify Municipality of ${label(tree.district)}`);
    tree.municipality.name = `${tree.municipality.name} upd`;
    fillLocationDialog({ name: tree.municipality.name });
    saveDialog();
    openPath(label(tree.region), label(tree.district));
    row('Municipalities', label(tree.municipality));
  });

  it('Creates a Village with its population (OCM-343)', () => {
    openPath(label(tree.region), label(tree.district), label(tree.municipality));
    clickPanelAdd('Villages');
    dialog().should('contain', 'New Village');
    ['Code', 'Name', 'Male', 'Female', 'Other', 'Family'].forEach((l) => dialog().contains('label', l));
    fillLocationDialog({ ...tree.village, population: { Male: 10, Female: 12, Other: 1, Family: 5 } });
    saveDialog();

    openPath(label(tree.region), label(tree.district), label(tree.municipality));
    row('Villages', label(tree.village)).dblclick();
    dialogInput('Male').should('have.value', '10');
    dialogInput('Female').should('have.value', '12');
    dialogInput('Other').should('have.value', '1');
    dialogInput('Family').should('have.value', '5');
    dialog().contains('button', 'Cancel').click();
  });

  it('Modifies a Village (OCM-347)', () => {
    openPath(label(tree.region), label(tree.district), label(tree.municipality));
    row('Villages', label(tree.village)).dblclick();
    dialog().should('contain', `Modify Village of ${label(tree.municipality)}`);
    dialogInput('Male').should('have.value', '10');
    tree.village.name = `${tree.village.name} upd`;
    fillLocationDialog({ name: tree.village.name, population: { Male: 20 } });
    saveDialog();

    openPath(label(tree.region), label(tree.district), label(tree.municipality));
    row('Villages', label(tree.village)).dblclick();
    dialogInput('Name').should('have.value', tree.village.name);
    dialogInput('Male').should('have.value', '20');
    dialog().contains('button', 'Cancel').click();
  });

  it('Moves a Municipality to another District (OCM-349)', () => {
    const districtB = { code: code('DB'), name: `UAT District B ${runId}` };
    seedLocation({ ...districtB, type: 'D', parentCode: tree.region.code });

    openPath(label(tree.region), label(tree.district));
    clickRowIcon('Municipalities', label(tree.municipality), 'shuffle');
    dialog().should('contain', `Move ${label(tree.municipality)} Municipality`);
    dialogInput('Current parent').should('have.value', label(tree.district));
    dialog().should('contain', 'New parent:');
    chooseDialogSelect('reassign-to-label-0', label(tree.region));
    chooseDialogSelect('reassign-to-label-1', label(districtB));
    dialog().contains('button', 'Move').click();
    cy.waitForJournalProgress();

    locationByCode(tree.municipality.code).its('parent.code').should('eq', districtB.code);
    openPath(label(tree.region), label(districtB));
    row('Municipalities', label(tree.municipality));
    openPath(label(tree.region), label(tree.district));
    panel('Municipalities').should('not.contain', label(tree.municipality));
    tree.districtB = districtB;
  });

  it('Deletes a Village (OCM-351)', () => {
    const districtB = tree.districtB ?? tree.district;
    openPath(label(tree.region), label(districtB), label(tree.municipality));
    clickRowIcon('Villages', label(tree.village), 'delete');
    dialog().should('contain', `Delete ${label(tree.village)} Village`)
      .and('contain', `Are you sure you want to delete Village ${label(tree.village)}?`);
    dialog().contains('button', 'Delete').click();
    cy.waitForJournalProgress();

    locationByCode(tree.village.code).should('be.null');
    openPath(label(tree.region), label(districtB), label(tree.municipality));
    panel('Villages').should('not.contain', label(tree.village));
  });

  it('Deletes a Municipality and its Villages (OCM-352)', () => {
    const municipality = { code: code('M2'), name: `UAT Munic 2 ${runId}` };
    const village = { code: code('V2'), name: `UAT Village 2 ${runId}` };
    seedLocation({ ...municipality, type: 'W', parentCode: tree.district.code });
    seedLocation({ ...village, type: 'V', parentCode: municipality.code });
    // A sibling, so the dialog offers both options.
    const sibling = { code: code('M5'), name: `UAT Munic 5 ${runId}` };
    seedLocation({ ...sibling, type: 'W', parentCode: tree.district.code });

    openPath(label(tree.region), label(tree.district));
    clickRowIcon('Municipalities', label(municipality), 'delete');
    dialog().should('contain', `Delete ${label(municipality)} Municipality and all its Villages`)
      .and('contain', `Delete ${label(municipality)} Municipality and move its Villages to`);
    // No "Do you want to:" question: with children to reassign, the dialog shows the two
    // choices as radio options only (DeleteLocationDialog renders `confirm` when there is
    // nothing to reassign), so the options asserted above are the question.
    dialog().contains('label', 'and all its Villages').click();
    dialog().contains('button', 'Delete').click();
    cy.waitForJournalProgress();

    locationByCode(municipality.code).should('be.null');
    locationByCode(village.code).should('be.null');
    openPath(label(tree.region), label(tree.district));
    panel('Municipalities').should('not.contain', label(municipality));
  });

  it('Deletes a Municipality and moves its Villages (OCM-353)', () => {
    const municipalityA = { code: code('M3'), name: `UAT Munic 3 ${runId}` };
    const municipalityB = { code: code('M4'), name: `UAT Munic 4 ${runId}` };
    const village = { code: code('V3'), name: `UAT Village 3 ${runId}` };
    seedLocation({ ...municipalityA, type: 'W', parentCode: tree.district.code });
    seedLocation({ ...municipalityB, type: 'W', parentCode: tree.district.code });
    seedLocation({ ...village, type: 'V', parentCode: municipalityA.code });

    openPath(label(tree.region), label(tree.district));
    clickRowIcon('Municipalities', label(municipalityA), 'delete');
    dialog().should('contain', `and all its Villages`).and('contain', 'and move its Villages to');
    dialog().contains('label', 'and move its Villages to').click();
    chooseDialogSelect('reassign-to-label', label(municipalityB));
    dialog().contains('button', 'Delete').click();
    cy.waitForJournalProgress();

    locationByCode(municipalityA.code).should('be.null');
    locationByCode(village.code).its('parent.code').should('eq', municipalityB.code);
    openPath(label(tree.region), label(tree.district), label(municipalityB));
    row('Villages', label(village));
  });

  it('Deletes a District and moves its Municipalities (OCM-355)', () => {
    const districtC = { code: code('DC'), name: `UAT District C ${runId}` };
    const municipality = { code: code('M6'), name: `UAT Munic 6 ${runId}` };
    seedLocation({ ...districtC, type: 'D', parentCode: tree.region.code });
    seedLocation({ ...municipality, type: 'W', parentCode: districtC.code });

    openPath(label(tree.region));
    clickRowIcon('Districts', label(districtC), 'delete');
    dialog().should('contain', `Delete ${label(districtC)} District`)
      .and('contain', 'and move its Municipalities to');
    dialog().contains('label', 'and move its Municipalities to').click();
    chooseDialogSelect('reassign-to-label', label(tree.district));
    dialog().contains('button', 'Delete').click();
    cy.waitForJournalProgress();

    locationByCode(districtC.code).should('be.null');
    locationByCode(municipality.code).its('parent.code').should('eq', tree.district.code);
    openPath(label(tree.region), label(tree.district));
    row('Municipalities', label(municipality));
  });

  it('Deletes a District and its sub-locations (OCM-354)', () => {
    // District B holds the moved municipality of OCM-349; seed it if that case did not run.
    const districtB = tree.districtB ?? { code: code('DB'), name: `UAT District B ${runId}` };
    const municipality = { code: code('M7'), name: `UAT Munic 7 ${runId}` };
    const village = { code: code('V7'), name: `UAT Village 7 ${runId}` };
    locationByCode(districtB.code).then((existing) => {
      if (!existing) seedLocation({ ...districtB, type: 'D', parentCode: tree.region.code });
    });
    seedLocation({ ...municipality, type: 'W', parentCode: districtB.code });
    seedLocation({ ...village, type: 'V', parentCode: municipality.code });

    openPath(label(tree.region));
    clickRowIcon('Districts', label(districtB), 'delete');
    dialog().should('contain', `Delete ${label(districtB)} District and all its Municipalities and Villages`);
    // No "Do you want to:" question: with children to reassign, the dialog shows the two
    // choices as radio options only (DeleteLocationDialog renders `confirm` when there is
    // nothing to reassign), so the options asserted above are the question.
    dialog().contains('label', 'and all its Municipalities and Villages').click();
    dialog().contains('button', 'Delete').click();
    cy.waitForJournalProgress();

    locationByCode(districtB.code).should('be.null');
    locationByCode(municipality.code).should('be.null');
    locationByCode(village.code).should('be.null');
    openPath(label(tree.region));
    panel('Districts').should('not.contain', label(districtB));
  });

  it('Deletes a Region and moves its Districts (OCM-357)', () => {
    const regionB = { code: code('RB'), name: `UAT Region B ${runId}` };
    const district = { code: code('D8'), name: `UAT District 8 ${runId}` };
    seedLocation({ ...regionB, type: 'R' });
    seedLocation({ ...district, type: 'D', parentCode: regionB.code });

    cy.visit(LOCATIONS_URL);
    clickRowIcon('Regions', label(regionB), 'delete');
    dialog().should('contain', `Delete ${label(regionB)} Region`)
      .and('contain', 'and move its Districts to');
    dialog().contains('label', 'and move its Districts to').click();
    chooseDialogSelect('reassign-to-label', label(tree.region));
    dialog().contains('button', 'Delete').click();
    cy.waitForJournalProgress();

    locationByCode(regionB.code).should('be.null');
    locationByCode(district.code).its('parent.code').should('eq', tree.region.code);
    openPath(label(tree.region));
    row('Districts', label(district));
  });

  it('Deletes a Region and its sub-tree (OCM-356)', () => {
    cy.visit(LOCATIONS_URL);
    clickRowIcon('Regions', label(tree.region), 'delete');
    dialog().should('contain', `Delete ${label(tree.region)} Region and all its Districts, Municipalities and Villages`)
      .and('contain', 'and move its Districts to');
    dialog().contains('label', 'and all its Districts, Municipalities and Villages').click();
    dialog().contains('button', 'Delete').click();
    cy.waitForJournalProgress();

    locationByCode(tree.region.code).should('be.null');
    locationByCode(tree.district.code).should('be.null');
    locationByCode(tree.municipality.code).should('be.null');
    cy.visit(LOCATIONS_URL);
    row('Regions', baseline().locations.r1.dashLabel);
    panel('Regions').should('not.contain', label(tree.region));
  });
});
