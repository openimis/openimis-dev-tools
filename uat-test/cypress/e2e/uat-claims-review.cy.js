import { baseline } from '../support/baseline';
import { TIMEOUTS } from '../support/constants';

// UAT "Benefits and Claims / Claim / Review": the Reviews page (filters, random and
// amount based selection, review and feedback status changes, processing) and the
// review and feedback pages.
//
// Every test works on its own checked claims, for a fresh insuree with an active
// policy, seeded through the GraphQL API (as scripts/claim-seed.mjs does). The
// searches are narrowed to that insuree, so selecting "all" rows never touches claims
// of other runs.
//
// The hospital (care type B), its claim administrator and officerR1d2 are in district
// r1d2; families are created in village r1d2m1v1 of that district (coherent). Feedback
// uses officerR1d2, who has a phone and covers that village.
//
// Care dates are today, claimed today (see CARE_DAY in scripts/claim-seed.mjs): the API
// refuses dates after today (OP-3250), and a policy entered today doesn't cover earlier
// days (OP-3234).
//
// CYPRESS_CLAIM_ONLY=OCM-36,OCM-43 runs only the tests whose title holds one of those ids.

const hospitalCode = () => baseline().healthFacilities.hospital.code;

const runId = Date.now().toString(36).slice(-4).toUpperCase();

// --- dates (local calendar, as the date pickers show them) -------------------------
const isoDay = (offset) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const CARE_DAY = 0;
const D = (offset = 0) => isoDay(CARE_DAY + offset);

// --- GraphQL seeding ---------------------------------------------------------------
const decodeId = (relayId) => Number(atob(relayId).split(':')[1]);

const graphqlLiteral = (value) => {
  if (Array.isArray(value)) return `[${value.map(graphqlLiteral).join(', ')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}: ${graphqlLiteral(v)}`).join(', ')}}`;
  }
  return JSON.stringify(value);
};

const gql = (query, variables = {}) =>
  cy.request({ method: 'POST', url: '/api/graphql', body: { query, variables }, log: false }).then(({ body }) => {
    if (body.errors?.length) throw new Error(`GraphQL: ${body.errors.map((e) => e.message).join('; ')}`);
    return body.data;
  });

const firstNode = (query, variables) =>
  gql(query, variables).then((data) => {
    const node = Object.values(data)[0]?.edges?.[0]?.node;
    if (!node) throw new Error(`Not found: ${query} ${JSON.stringify(variables)}`);
    return node;
  });

// Sends a mutation and waits for its MutationLog (the response only means "queued").
// `inline` writes the input into the query: TinyInt fields cannot be variables.
const mutate = (name, inputType, input, { inline = false, allowError = false } = {}) => {
  const clientMutationId = `uat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const full = { ...input, clientMutationId, clientMutationLabel: `UAT claims: ${name}` };
  const request = inline
    ? gql(`mutation { ${name}(input: ${graphqlLiteral(full)}) { clientMutationId } }`)
    : gql(`mutation($input: ${inputType}!) { ${name}(input: $input) { clientMutationId } }`, { input: full });
  return request
    .then(() => cy.waitForMutationLog(clientMutationId, { timeout: 120000 }))
    .then((log) => {
      if (log.status === 1 && !allowError) throw new Error(`${name} failed: ${log.error}`);
      return log;
    });
};

// Hospital of district r1d2, its claim administrator, officerR1d2 and village
// r1d2m1v1 (the officer's village, coherent with the hospital).
const loadRefs = () => {
  const B = baseline();
  const hf = B.healthFacilities.hospital;
  const district = B.locations[hf.district];
  return cy.wrap({
    hf: {
      intId: hf.id,
      uuid: hf.uuid,
      code: hf.code,
      location: { id: district.id, uuid: district.uuid },
      servicesPricelist: hf.servicesPricelist,
      itemsPricelist: hf.itemsPricelist,
    },
    adminId: B.users.hospitalClaimAdmin.id,
    // Not diagnoses[0]: claim checks and the HF spec also use that one, and a
    // diagnosis average (OCM-38) must not be diluted by their claims.
    icdId: B.diagnoses[1].id,
    officerId: B.users.officerR1d2.id,
    villageId: B.locations.r1d2m1v1.id,
  });
};

const createMedical = (kind, { code, name, careType = 'B', category, price = '10.00' }) => {
  const isItem = kind === 'item';
  return mutate(isItem ? 'createItem' : 'createService', isItem ? 'CreateItemMutationInput' : 'CreateServiceMutationInput', {
    code,
    name,
    type: isItem ? 'D' : 'P',
    careType,
    price,
    patientCategories: ['ADULT', 'MINOR', 'MALE', 'FEMALE'],
    ...(isItem ? {} : { level: 'C', category: category ?? null, packagetype: 'S' }),
  })
    .then(() => firstNode(
      `query($c: String!) { ${isItem ? 'medicalItems' : 'medicalServices'}(code: $c) { edges { node { id uuid code } } } }`,
      { c: code },
    ))
    .then((node) => ({ kind, code, name, price, uuid: node.uuid, id: decodeId(node.id) }));
};

const updatePricelist = (refs, kind, { added, removed }) => {
  const pl = kind === 'item' ? refs.hf.itemsPricelist : refs.hf.servicesPricelist;
  return mutate(
    kind === 'item' ? 'updateItemsPricelist' : 'updateServicesPricelist',
    kind === 'item' ? 'UpdateItemsPricelistMutationInput' : 'UpdateServicesPricelistMutationInput',
    // locationId kept: an update without it clears the list's district.
    { uuid: pl.uuid, name: pl.name, pricelistDate: pl.pricelistDate.slice(0, 10), locationId: pl.locationUuid, addedDetails: added, removedDetails: removed },
  );
};

// 100 % co-insurance on every limitation: the item or service is fully covered.
const FULL_COVER = {
  priceOrigin: 'PRICELIST',
  ...Object.fromEntries(['', 'R', 'E'].map((s) => [`limitationType${s}`, 'CO_INSURANCE'])),
  ...Object.fromEntries(['Adult', 'Child', 'AdultR', 'ChildR', 'AdultE', 'ChildE'].map((s) => [`limit${s}`, '100.00'])),
};

const createProduct = ({ code, name, limits = {}, items = [], services = [] }) =>
  mutate('createProduct', 'CreateProductMutationInput', {
    code,
    name,
    dateFrom: isoDay(-365),
    dateTo: isoDay(365),
    insurancePeriod: 12,
    maxMembers: 10,
    lumpSum: '100.00',
    ...limits,
    items: items.map((m) => ({ itemUuid: m.uuid, ...FULL_COVER })),
    services: services.map((m) => ({ serviceUuid: m.uuid, ...FULL_COVER })),
  })
    .then(() => firstNode(`query($c: String!) { products(code: $c) { edges { node { id uuid } } } }`, { c: code }))
    .then((node) => ({ code, uuid: node.uuid, id: decodeId(node.id) }));

let chfSeq = 0;
const newChfId = () => `8${String(Date.now() + (chfSeq += 1)).slice(-8)}`;

// A family whose head is an adult man (last name `lastName`), optionally with a child.
const createFamily = (refs, { lastName = `UAT${runId}`, withChild = false } = {}) => {
  const head = { chfId: newChfId(), lastName, otherNames: 'Claim', genderId: 'M', dob: '1980-01-15', head: true };
  const result = {};
  return mutate('createFamily', 'CreateFamilyMutationInput', { locationId: refs.villageId, poverty: false, headInsuree: head })
    .then(() => firstNode(
      `query($c: String!) { insurees(chfId: $c) { edges { node { id uuid family { id uuid } } } } }`,
      { c: head.chfId },
    ))
    .then((node) => {
      result.family = { id: decodeId(node.family.id), uuid: node.family.uuid };
      result.head = { chfId: head.chfId, id: decodeId(node.id), uuid: node.uuid, name: `${lastName} Claim` };
      if (!withChild) return result;
      const child = { chfId: newChfId(), lastName, otherNames: 'Child', genderId: 'F', dob: isoDay(-5 * 365) };
      return mutate('createInsuree', 'CreateInsureeMutationInput', { ...child, familyId: result.family.id, head: false })
        .then(() => firstNode(`query($c: String!) { insurees(chfId: $c) { edges { node { id uuid } } } }`, { c: child.chfId }))
        .then((childNode) => {
          result.child = { chfId: child.chfId, id: decodeId(childNode.id), uuid: childNode.uuid };
          return result;
        });
    });
};

// An active policy: enrolled 40 days ago, fully paid on that day.
const createActivePolicy = (refs, product, family) => {
  const enrollDate = isoDay(-40);
  const expiry = new Date(`${enrollDate}T00:00:00`);
  expiry.setFullYear(expiry.getFullYear() + 1);
  expiry.setDate(expiry.getDate() - 1);
  const expiryDate = `${expiry.getFullYear()}-${String(expiry.getMonth() + 1).padStart(2, '0')}-${String(expiry.getDate()).padStart(2, '0')}`;
  return mutate('createPolicy', 'CreatePolicyMutationInput', {
    enrollDate, startDate: enrollDate, expiryDate, value: '100.00', productId: product.id, familyId: family.id, officerId: refs.officerId,
  })
    .then(() => gql(
      `query($f: String!) { policiesByFamily(familyUuid: $f) { edges { node { policyUuid } } } }`,
      { f: family.uuid },
    ))
    .then(({ policiesByFamily }) => mutate('createPremium', 'CreatePremiumMutationInput', {
      policyUuid: policiesByFamily.edges[0].node.policyUuid,
      amount: '100.00',
      payDate: enrollDate,
      payType: 'C',
      receipt: `UAT-${Date.now().toString(36)}`,
      isPhotoFee: false,
      action: 'ENFORCE',
    }));
};

const insuredFamily = (refs, product, opts) =>
  createFamily(refs, opts).then((fam) => createActivePolicy(refs, product, fam.family).then(() => fam));

let claimSeq = 0;
const claimCode = (prefix) => `${prefix}${runId}${(claimSeq += 1).toString(36).toUpperCase()}`.slice(0, 8);

// Enters a claim through the API (status Entered).
const apiClaim = (refs, { code, insureeId, dateFrom = D(), dateTo, dateClaimed, items = [], services = [], price = '10.00' }) =>
  mutate('createClaim', 'CreateClaimMutationInput', {
    code,
    insureeId,
    dateFrom,
    dateTo: dateTo ?? dateFrom,
    dateClaimed: dateClaimed ?? dateTo ?? dateFrom,
    icdId: refs.icdId,
    healthFacilityId: refs.hf.intId,
    adminId: refs.adminId,
    visitType: 'O',
    items: items.map((m) => ({ itemId: m.id, status: 1, qtyProvided: '1', priceAsked: price })),
    services: services.map((m) => ({ serviceId: m.id, status: 1, qtyProvided: '1', priceAsked: price })),
  }, { inline: true })
    .then(() => readClaim(code));

const readClaim = (code) =>
  firstNode(
    `query($c: String!) { claims(code: $c) { edges { node { uuid code status rejectionReason claimed approved attachmentsCount
       items { status rejectionReason item { code } } services { status rejectionReason service { code } } } } } }`,
    { c: code },
  );

// A rejected claim ends the submitClaims mutation in error: the claim tells the result.
const apiSubmit = (claims) =>
  mutate('submitClaims', 'SubmitClaimsMutationInput', { uuids: claims.map((c) => c.uuid) }, { allowError: true });

// Medical item and service of this run, on the baseline hospital price lists, and a
// product covering them. Feedback uses officerR1d2 (phone, villages of r1d2).
const seedRun = () => {
  const run = { m: {} };
  return loadRefs()
    .then((refs) => { run.refs = refs; })
    .then(() => {
      createMedical('service', { code: `S${runId}R`, name: `UAT review service ${runId}` }).then((m) => { run.m.svc = m; });
      createMedical('item', { code: `I${runId}R`, name: `UAT review item ${runId}` }).then((m) => { run.m.item = m; });
    })
    .then(() => {
      updatePricelist(run.refs, 'item', { added: [run.m.item.uuid] });
      updatePricelist(run.refs, 'service', { added: [run.m.svc.uuid] });
      createProduct({ code: `UR${runId}`, name: `UAT claim review ${runId}`, items: [run.m.item], services: [run.m.svc] })
        .then((p) => { run.product = p; });
    })
    .then(() => {
      run.officerCode = baseline().users.officerR1d2.code;
      return run;
    });
};

// A fresh insured family and one checked claim per price (service qty 1 at that price).
const checkedClaims = (run, prices, { prefix } = {}) =>
  insuredFamily(run.refs, run.product).then((fam) => {
    const claims = [];
    prices.forEach((price, i) => {
      const code = prefix ? `${prefix}${i}` : claimCode('R');
      apiClaim(run.refs, { code, insureeId: fam.head.id, dateFrom: D(), dateClaimed: D(), services: [run.m.svc], price })
        .then((c) => claims.push(c));
    });
    return cy.then(() => apiSubmit(claims))
      .then(() => {
        claims.forEach((c, i) => readClaim(c.code).then((r) => {
          expect(r.status, `setup claim ${c.code} checked`).to.eq(4);
          claims[i] = r;
        }));
      })
      .then(() => ({ fam, claims }));
  });

// --- UI helpers --------------------------------------------------------------------
const REVIEWS = '/front/claim/reviews';

// Status columns of Reviews hold a picker (or its read-only value) and an icon button:
// keep the picker's text.
const cellText = (cell) => {
  const picker = cell.querySelector('[role="combobox"], input:not(.MuiSelect-nativeInput):not([type="hidden"])');
  if (picker) return (picker.value ?? picker.innerText ?? '').trim() || picker.innerText.trim();
  const copy = cell.cloneNode(true);
  copy.querySelectorAll('.material-symbols-outlined, button').forEach((el) => el.remove());
  return (copy.innerText || copy.textContent || '').trim().split('\n')[0].trim();
};

const readSearcher = ($tables) => {
  // The header row (column names) follows a pre-header row, in a thead of its own.
  const headerRow = (t) => [...t.querySelectorAll('thead tr')].find((r) => /Claim No\./.test(r.textContent) && /Status/.test(r.textContent));
  const table = [...$tables].find(headerRow);
  if (!table) return [];
  const names = [...headerRow(table).cells].map((c) => c.innerText.split('\n')[0].trim());
  return [...table.querySelectorAll('tbody tr')]
    .filter((r) => r.cells.length > 1)
    .map((r) => Object.fromEntries(names.map((n, i) => [n || `#${i}`, cellText(r.cells[i])])));
};

// Retries until the searcher rows satisfy `check`, so a stale result never passes.
const expectRows = (check) =>
  cy.get('table', { timeout: TIMEOUTS.SERVER_RESULT }).should(($tables) => check(readSearcher($tables)));

const amount = (s) => Number(String(s).replace(/[^\d,.-]/g, '').replace(/\.(?=\d{3})/g, '').replace(',', '.'));

const openReviews = () => {
  cy.visit(REVIEWS);
  cy.waitForSearcherLoaded({});
};

const field = (label) => cy.contains('label', label, { matchCase: false }).siblings('.MuiInputBase-root');

// Filters of the Reviews searcher; `undefined` leaves a filter as it is.
const filter = ({ status, review, feedback, code, chfId } = {}) => {
  if (status) cy.chooseMuiSelect('Claim Status', new RegExp(`^${status}$`));
  if (review) cy.chooseMuiSelect('Review Status', new RegExp(`^${review}$`));
  if (feedback) cy.chooseMuiSelect('Feedback Status', new RegExp(`^${feedback}$`));
  if (code !== undefined) cy.enterMuiInput('Claim No.', code);
  if (chfId !== undefined) cy.enterMuiInput('Insuree No.', chfId);
};

const searchNow = () => cy.contains('button', 'Search').click({ force: true });

// Toggles one of the Reviews quick filters (Random, Claimed Amount Above, ... Avg.);
// like the other filters, it applies on the next search.
const quickFilter = (label, value) => {
  const box = () => cy.contains('label', new RegExp(`^${label.replace(/[.]/g, '\\.')}\\s*\\*?$`)).siblings('.MuiInputBase-root');
  box().find('input').clear({ force: true }).type(String(value), { force: true, delay: 0 });
  box().find('button').click();
};

const moreMenu = () =>
  cy.get('button.MuiIconButton-root')
    .filter(':has(.material-symbols-outlined:contains("more_horiz"))')
    .filter((_, b) => !b.closest('tbody'))
    .first()
    .click();

const chooseAction = (label) => {
  moreMenu();
  cy.contains('[role="menuitem"]', label).should('be.visible').click();
};

// Selects the rows of the given codes and checks the header count. The click goes to
// the code cell (other cells may hold pickers) and is repeated when a searcher
// refresh dropped the selection.
const selectRow = (code, attempt = 0) => {
  cy.contains('tbody tr td', code).click();
  cy.wait(500); // eslint-disable-line cypress/no-unnecessary-waiting
  cy.contains('tbody tr', code).then(($tr) => {
    if ($tr.hasClass('Mui-selected')) return;
    if (attempt >= 3) throw new Error(`Row ${code} could not be selected`);
    selectRow(code, attempt + 1);
  });
};

const selectRows = (codes) => {
  cy.waitForSearcherLoaded({});
  codes.forEach((code) => selectRow(code));
  cy.contains(`Selected ${codes.length} claim(s)`).should('exist');
};

const journalFirst = () => cy.get('.MuiDrawer-paperAnchorRight li.jrnlItem', { timeout: TIMEOUTS.SERVER_RESULT }).first();

const expectJournal = (label) => {
  journalFirst().should('contain', label);
  journalFirst().find('.jrnlIcon').should('contain', 'check_circle');
};

const closeAlert = () => cy.get('[role="dialog"]').contains('button', /ok|close/i).click();

const openReview = (claim) => {
  openReviews();
  filter({ status: 'Any', code: claim.code });
  searchNow();
  expectRows((rows) => expect(rows.map((r) => r['Claim No.'])).to.deep.eq([claim.code]));
  cy.contains('tbody tr', claim.code).dblclick();
  cy.location('pathname').should('eq', `${REVIEWS}/review/${claim.uuid}`);
  cy.contains('label', 'Claim No.').siblings('.MuiInputBase-root').find('input').should('have.value', claim.code);
};

// Input of a column in the first row of the Service table (first row = headers).
const serviceCell = (column) =>
  cy.get('table', { timeout: TIMEOUTS.SERVER_RESULT }).should(($tables) => {
    const t = [...$tables].find((x) => x.rows[0] && /App\. Quantity/.test(x.rows[0].innerText) && /Service/.test(x.rows[0].cells[0]?.innerText + x.rows[0].cells[1]?.innerText));
    expect(t, 'Service table').to.exist;
  }).then(($tables) => {
    const t = [...$tables].find((x) => x.rows[0] && /App\. Quantity/.test(x.rows[0].innerText) && /Service/.test(x.rows[0].cells[0]?.innerText + x.rows[0].cells[1]?.innerText));
    const idx = [...t.rows[0].cells].findIndex((c) => c.innerText.trim() === column);
    expect(idx, `${column} column`).to.be.greaterThan(-1);
    return cy.wrap(t.rows[1].cells[idx]).find('input').first();
  });

const reviewByApi = (code) =>
  firstNode(
    `query($c: String!) { claims(code: $c) { edges { node { uuid code status reviewStatus feedbackStatus claimed approved adjustment dateProcessed } } } }`,
    { c: code },
  );

// --- tests -------------------------------------------------------------------------
const only = (Cypress.env('CLAIM_ONLY') ?? '').split(',').filter(Boolean);
const test = (title, fn) => (!only.length || only.some((id) => new RegExp(`\\b${id}\\b`).test(title))
  ? it(title, fn) : it.skip(title, fn));

describe('Claim reviews (UAT)', () => {
  let run;

  before(() => {
    cy.login();
    seedRun().then((r) => { run = r; });
  });

  beforeEach(() => {
    cy.login();
  });

  test('Searches with several filters (OCM-34)', () => {
    checkedClaims(run, ['10.00', '20.00']).then(({ fam, claims }) => {
      mutate('selectClaimsForReview', 'SelectClaimsForReviewMutationInput', { uuids: [claims[1].uuid] });
      openReviews();
      cy.chooseMuiAutocomplete('Health Facility', hospitalCode());
      cy.selectDateFromCalendar('Claimed From', D(0));
      cy.selectDateFromCalendar('Claimed To', D(0));
      searchNow();
      const inRange = (r) => r['Claimed Date'] >= D(0) && r['Claimed Date'] <= D(0);
      expectRows((rows) => {
        expect(rows.length, 'rows').to.be.greaterThan(1);
        rows.forEach((r) => {
          expect(r['Health Facility'], r['Claim No.']).to.eq(hospitalCode());
          expect(r.Status, r['Claim No.']).to.eq('Checked');
          expect(inRange(r), `${r['Claim No.']} claimed ${r['Claimed Date']}`).to.be.true;
        });
      });
      cy.contains('.paperHeaderTitle, .tableTitle h6', /\d+ Claims Found/).should('exist');

      filter({ chfId: fam.head.chfId });
      searchNow();
      expectRows((rows) => expect(rows.map((r) => r['Claim No.']).sort()).to.deep.eq(claims.map((c) => c.code).sort()));

      filter({ code: claims[0].code });
      searchNow();
      expectRows((rows) => expect(rows.map((r) => r['Claim No.'])).to.deep.eq([claims[0].code]));
      cy.contains('.paperHeaderTitle, .tableTitle h6', /(?<!\d)1 Claims Found/).should('exist');

      openReviews();
      filter({ review: 'Selected', chfId: fam.head.chfId });
      searchNow();
      expectRows((rows) => {
        expect(rows.map((r) => r['Claim No.'])).to.deep.eq([claims[1].code]);
        rows.forEach((r) => expect(r['Review Status']).to.eq('Selected'));
      });
    });
  });

  test('Selects the claims above an amount for review (OCM-36)', () => {
    checkedClaims(run, ['10.00', '15.00', '500.00', '600.00']).then(({ fam, claims }) => {
      const above = claims.filter((c) => Number(c.claimed) > 100).map((c) => c.code);
      openReviews();
      filter({ status: 'Checked', review: 'Idle', feedback: 'Idle', chfId: fam.head.chfId });
      searchNow();
      expectRows((rows) => expect(rows).to.have.length(4));
      quickFilter('Claimed Amount Above', 100);
      searchNow();
      expectRows((rows) => {
        expect(rows.map((r) => r['Claim No.']).sort()).to.deep.eq(above.sort());
        rows.forEach((r) => expect(amount(r.Claimed), r['Claim No.']).to.be.greaterThan(100));
      });
      selectRows(above);
      chooseAction('Select For Review');
      cy.waitForJournalProgress();
      expectJournal(`Selected ${above.length} claims for review`);
      openReviews();
      filter({ status: 'Checked', chfId: fam.head.chfId });
      searchNow();
      expectRows((rows) => {
        expect(rows).to.have.length(4);
        rows.forEach((r) => expect(r['Review Status'], r['Claim No.']).to.eq(above.includes(r['Claim No.']) ? 'Selected' : 'Idle'));
      });
    });
  });

  test('Selects a percentage of the claims for feedback at random (OCM-37)', () => {
    checkedClaims(run, ['10.00', '10.00', '10.00', '10.00', '10.00', '10.00']).then(({ fam }) => {
      openReviews();
      filter({ status: 'Checked', review: 'Idle', feedback: 'Idle', chfId: fam.head.chfId });
      searchNow();
      expectRows((rows) => expect(rows).to.have.length(6));
      quickFilter('Random Filter', 1);
      cy.contains('[role="dialog"]', 'Invalid random filtering!').should('contain', 'Random filtering 1% of 6 claims would provide an empty result!');
      closeAlert();
      quickFilter('Random Filter', 150);
      cy.contains('[role="dialog"]', 'Random filtering (150%) must be 1 or more, and maximum 100').should('be.visible');
      closeAlert();
      quickFilter('Random Filter', 50);
      searchNow();
      expectRows((rows) => expect(rows, 'half of the 6 claims').to.have.length(3));
      cy.get('tbody tr').then(($rows) => {
        const codes = [...$rows].map((r) => cellText(r.cells[0])).filter(Boolean);
        selectRows(codes);
        chooseAction('Select For Feedback');
        cy.waitForJournalProgress();
        expectJournal(`Selected ${codes.length} claims for feedback`);
        openReviews();
        filter({ status: 'Checked', chfId: fam.head.chfId });
        searchNow();
        expectRows((rows) => {
          expect(rows).to.have.length(6);
          rows.forEach((r) => expect(r['Feedback Status'], r['Claim No.']).to.eq(codes.includes(r['Claim No.']) ? 'Selected' : 'Idle'));
        });
      });
    });
  });

  test('Selects the claims above the diagnosis average for review (OCM-38)', () => {
    // diagnoses[1] is used only here, so the average is this spec's claims (about 10,
    // plus one 2000). 2000 is above that average by 10 %; 10 is not. Two claims
    // alone average 1005, and 110 % of that is still under 2000.
    checkedClaims(run, ['10.00', '2000.00']).then(({ fam, claims }) => {
      openReviews();
      filter({ status: 'Checked', review: 'Idle', feedback: 'Idle', chfId: fam.head.chfId });
      searchNow();
      expectRows((rows) => expect(rows).to.have.length(2));
      quickFilter('Claimed Amount Above Diagnosis Avg.', 10);
      searchNow();
      expectRows((rows) => expect(rows.map((r) => r['Claim No.'])).to.deep.eq([claims[1].code]));
      selectRows([claims[1].code]);
      chooseAction('Select For Review');
      cy.waitForJournalProgress();
      expectJournal(`Select claim ${claims[1].code} for review`);
      reviewByApi(claims[1].code).its('reviewStatus').should('eq', 4);
    });
  });

  test('Adjusts a claim (OCM-42)', () => {
    const text = `UAT adjustment ${runId} ${Date.now()}`;
    checkedClaims(run, ['10.00']).then(({ claims: [claim] }) => {
      openReview(claim);
      cy.enterMuiInput('Adjustment', text);
      cy.clickSave('Save changes');
      cy.waitForJournalProgress();
      expectJournal(`Save claim ${claim.code} review`);
      cy.reload();
      cy.contains('label', 'Adjustment').siblings('.MuiInputBase-root').find('input, textarea').first().should('have.value', text);
    });
  });

  test('Sets an approved quantity and price (OCM-159)', () => {
    checkedClaims(run, ['10.00']).then(({ claims: [claim] }) => {
      openReview(claim);
      serviceCell('App. Quantity').clear({ force: true }).type('1', { force: true });
      serviceCell('App. Price').clear({ force: true }).type('6', { force: true });
      cy.clickSave('Save changes');
      cy.waitForJournalProgress();
      expectJournal(`Save claim ${claim.code} review`);
      // The value cell of the "Total Approved" row (text or read-only input), not its label.
      cy.contains('tr', 'Total Approved').should(($tr) => {
        const values = $tr.find('td').toArray().filter((td) => !td.innerText.includes('Total Approved'))
          .map((td) => [td.innerText, ...[...td.querySelectorAll('input')].map((i) => i.value)].join(' ')).join(' ');
        expect(values, 'Total Approved').to.contain('6');
      });
      openReviews();
      filter({ status: 'Any', code: claim.code });
      searchNow();
      expectRows((rows) => {
        expect(rows.map((r) => r['Claim No.'])).to.deep.eq([claim.code]);
        expect(amount(rows[0].Approved), 'Approved').to.eq(6);
      });
    });
  });

  test('Delivers a claim review (OCM-43)', () => {
    checkedClaims(run, ['10.00']).then(({ claims: [claim] }) => {
      openReviews();
      filter({ status: 'Checked', code: claim.code });
      searchNow();
      expectRows((rows) => expect(rows.map((r) => r['Claim No.'])).to.deep.eq([claim.code]));
      selectRows([claim.code]);
      chooseAction('Select For Review');
      cy.waitForJournalProgress();
      expectJournal(`Select claim ${claim.code} for review`);

      openReview(claim);
      cy.get('[aria-label="Deliver review"]').find('button').should('be.visible').click();
      cy.waitForJournalProgress();
      expectJournal(`Deliver claim ${claim.code} review`);

      openReviews();
      filter({ status: 'Any', code: claim.code });
      searchNow();
      expectRows((rows) => expect(rows[0]?.['Review Status']).to.eq('Delivered'));
      openReview(claim);
      cy.contains('label', 'Adjustment').siblings('.MuiInputBase-root').find('input, textarea').first().should('be.disabled');
      cy.get('[aria-label="Deliver review"]').should('not.exist');
    });
  });

  test('Skips a review (OCM-160)', () => {
    checkedClaims(run, ['10.00']).then(({ fam, claims: [claim] }) => {
      mutate('selectClaimsForReview', 'SelectClaimsForReviewMutationInput', { uuids: [claim.uuid] });
      openReviews();
      filter({ status: 'Checked', review: 'Selected', chfId: fam.head.chfId });
      searchNow();
      expectRows((rows) => expect(rows.map((r) => r['Claim No.'])).to.deep.eq([claim.code]));
      selectRows([claim.code]);
      chooseAction('Skip Review');
      cy.waitForJournalProgress();
      expectJournal(`Skip claim ${claim.code} review`);
      openReviews();
      filter({ status: 'Any', code: claim.code });
      searchNow();
      expectRows((rows) => expect(rows[0]?.['Review Status']).to.eq('Not Selected'));
    });
  });

  test('Delivers feedback (OCM-161)', () => {
    checkedClaims(run, ['10.00']).then(({ claims: [claim] }) => {
      mutate('selectClaimsForFeedback', 'SelectClaimsForFeedbackMutationInput', { uuids: [claim.uuid] });
      openReviews();
      filter({ status: 'Checked', code: claim.code });
      searchNow();
      expectRows((rows) => expect(rows[0]?.['Feedback Status']).to.eq('Selected'));
      cy.contains('tbody tr', claim.code).contains('button', /feedback/i).click();
      cy.location('pathname').should('eq', `/front/claim/feedback/${claim.uuid}`);
      cy.contains('h6', 'Feedback').should('exist');
      cy.pickTodayInDatePicker('Feedback Date');
      cy.chooseMuiAutocomplete('Enrolment Officer', run.officerCode);
      // Tristate sliders (Unknown / No / Yes) and the assessment slider: click a mark label.
      const mark = (question, answer) =>
        cy.contains('p, span, div', new RegExp(`^${question}$`)).closest('.MuiGrid-container').find('.MuiSlider-markLabel').contains(answer).click({ force: true });
      mark('Care Rendered', 'Yes');
      mark('Payment Asked', 'No');
      mark('Drugs Prescribed', 'Yes');
      mark('Drugs Received', 'Yes');
      cy.get('.assessment .MuiSlider-markLabel').contains(/^Good$/).click({ force: true });
      cy.clickSave('Save changes');
      cy.waitForJournalProgress();
      expectJournal(`Deliver claim ${claim.code} feedback`);
      cy.location('pathname').should('eq', REVIEWS);
      openReviews();
      filter({ status: 'Any', code: claim.code });
      searchNow();
      expectRows((rows) => expect(rows[0]?.['Feedback Status']).to.eq('Delivered'));
      reviewByApi(claim.code).its('feedbackStatus').should('eq', 8);
    });
  });

  test('Processes a claim (OCM-162)', () => {
    checkedClaims(run, ['10.00']).then(({ claims: [claim] }) => {
      openReviews();
      filter({ status: 'Checked', code: claim.code });
      searchNow();
      expectRows((rows) => expect(rows.map((r) => r['Claim No.'])).to.deep.eq([claim.code]));
      selectRows([claim.code]);
      chooseAction('Process Selected');
      cy.waitForJournalProgress();
      expectJournal(`Process claim ${claim.code}`);
      openReviews();
      filter({ status: 'Any', code: claim.code });
      searchNow();
      expectRows((rows) => {
        expect(rows[0]?.Status).to.be.oneOf(['Processed', 'Valuated']);
        expect(rows[0]?.['Processed On'], 'Processed On').to.match(/\d{4}-\d{2}-\d{2}/);
      });
    });
  });
});
