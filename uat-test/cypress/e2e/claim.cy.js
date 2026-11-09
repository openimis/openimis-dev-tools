import { baseline } from '../support/baseline';

// Claim restoration, complex (package) service and duplication.
//
// Claim codes are at most 8 characters: a short prefix plus a 4-character run
// suffix, so the spec can be re-run. The claim to restore is a rejected claim of
// this run (an insuree without a policy), not whichever rejected claim a database
// lists first. The insured insuree is the baseline family near the hospital
// (village r1d2m1v1), coherent with the hospital and its claim administrator in
// district r1d2. The package service is made of baseline items.

const LIST = '/front/claim/healthFacilities';
const runId = Date.now().toString(36).slice(-4).toUpperCase();

const decodeId = (relayId) => Number(atob(relayId).split(':')[1]);

const gql = (query, variables = {}) =>
  cy.request({ method: 'POST', url: '/api/graphql', body: { query, variables }, log: false }).then(({ body }) => {
    if (body.errors?.length) throw new Error(`GraphQL: ${body.errors.map((e) => e.message).join('; ')}`);
    return body.data;
  });

const firstNode = (query, variables) =>
  gql(query, variables).then((data) => {
    const node = Object.values(data)[0]?.edges?.[0]?.node;
    if (!node) throw new Error(`Not found: ${JSON.stringify(variables)}`);
    return node;
  });

// Runs a mutation (input inlined: claim TinyInt fields cannot be variables) and waits
// for its MutationLog; a rejected claim ends submitClaims in error, hence allowError.
const mutate = (name, input, { allowError = false } = {}) => {
  const clientMutationId = `uat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return gql(`mutation { ${name}(input: { clientMutationId: "${clientMutationId}" clientMutationLabel: "UAT ${name}" ${input} }) { clientMutationId } }`)
    .then(() => cy.waitForMutationLog(clientMutationId))
    .then((log) => {
      if (log.status === 1 && !allowError) throw new Error(`${name} failed: ${log.error}`);
    });
};

const isoDay = (offset) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

// A rejected claim at the baseline hospital: a new insuree without a policy, in a
// village of the hospital's district (r1d2, coherent), and a baseline item. Care was
// yesterday and is claimed today: the API keeps care within the claim date (OP-3250).
const seedRejectedClaim = (code) => {
  const B = baseline();
  const chfId = `7${String(Date.now()).slice(-8)}`;
  const ids = {
    hf: B.healthFacilities.hospital.id,
    village: B.locations.r1d2m1v1.id,
    admin: B.users.hospitalClaimAdmin.id,
    icd: B.diagnoses[0].id,
    item: B.items[0].id,
  };
  const care = isoDay(-1);
  const claimed = isoDay(0);
  return mutate('createFamily', `locationId: ${ids.village} poverty: false
      headInsuree: { chfId: "${chfId}" lastName: "UAT" otherNames: "Restore" genderId: "M" dob: "1980-01-15" head: true }`)
    .then(() => firstNode(`{ insurees(chfId: "${chfId}") { edges { node { id } } } }`)).then((n) => { ids.insuree = decodeId(n.id); })
    .then(() => mutate('createClaim', `code: "${code}" insureeId: ${ids.insuree} dateFrom: "${care}" dateTo: "${care}"
      dateClaimed: "${claimed}" icdId: ${ids.icd} healthFacilityId: ${ids.hf} adminId: ${ids.admin} visitType: "O"
      items: [{ itemId: ${ids.item} status: 1 qtyProvided: "1" priceAsked: "10.00" }]`))
    .then(() => firstNode(`{ claims(code: "${code}") { edges { node { uuid } } } }`))
    .then((claim) => mutate('submitClaims', `uuids: ["${claim.uuid}"]`, { allowError: true })
      .then(() => firstNode(`{ claims(code: "${code}") { edges { node { uuid status } } } }`)))
    .then((claim) => {
      expect(claim.status, `setup claim ${code} rejected`).to.eq(1);
      return claim;
    });
};

const fab = (icon) => cy.get('button.MuiFab-root').filter(`:has(.material-symbols-outlined:contains("${icon}"))`).first();

// Searches Health Facility Claims by code (any status) and waits for the row.
const findClaim = (code) => {
  cy.visit(LIST);
  cy.waitForSearcherLoaded({});
  cy.chooseMuiSelect('Claim Status', 'Any');
  cy.enterMuiInput('Claim No.', code);
  cy.contains('button', 'Search').click({ force: true });
  return cy.contains('tbody tr', code);
};

const openClaim = (code) => {
  findClaim(code).dblclick();
  cy.contains('label', 'Claim No.').siblings('.MuiInputBase-root').find('input').should('have.value', code);
};

const save = (code) => {
  cy.clickSave('Save changes');
  cy.waitForJournalProgress();
  cy.get('.MuiDrawer-paperAnchorRight li.jrnlItem').first().should('contain', code)
    .find('.jrnlIcon').should('contain', 'check_circle');
};

describe('Test for claim restoration', () => {
  let data;

  before(() => {
    // Coherent with district r1d2: hospital, hospitalClaimAdmin, nearHospital family.
    const B = baseline();
    const head = B.families.nearHospital.head;
    const serviceCode = `SC${runId}`; // service codes are at most 6 characters
    data = {
      claim: {
        code: `CP${runId}`,
        chfId: head.chfId,
        services: [{
          name: serviceCode,
          subservicesItems: [
            { code: B.items[0].code, qty: 3 },
            { code: B.items[1].code, qty: 2 },
            { code: B.items[2].code, qty: 1 },
          ],
        }],
      },
      restore: { code: `RS${runId}` },
      duplicate: { code: `DU${runId}`, chfId: head.chfId },
    };
    cy.login();
    cy.seedComplexService({
      code: serviceCode,
      name: `UAT complex service ${runId}`,
      items: data.claim.services[0].subservicesItems,
      hfCode: B.healthFacilities.hospital.code,
    });
    data.rejected = `RJ${runId}`;
    seedRejectedClaim(data.rejected).then((claim) => { data.rejectedUuid = claim.uuid; });
  });

  beforeEach(() => {
    cy.login();
  });

  it('Claim restoration workflow', () => {
    cy.visit(`${LIST}/claim/${data.rejectedUuid}`);
    cy.contains('h6', `Claim ${data.rejected}`).should('be.visible');
    fab('restore_page').click();
    cy.enterMuiInput('Claim No.', data.restore.code);
    cy.contains('h6', `Claim ${data.restore.code}`).should('be.visible');
    save(data.restore.code);
    findClaim(data.restore.code).should('contain', 'Entered');
  });

  // Through GraphQL, not the form: the form's own date rules are front-end data
  // entry, and the backend tests never send sub-items (serviceItemSet: []).
  it('Saves the sub-item quantities of a complex service (API)', () => {
    const B = baseline();
    const service = data.claim.services[0];
    const ids = {};
    firstNode(`{ insurees(chfId: "${data.claim.chfId}") { edges { node { id } } } }`)
      .then((n) => { ids.insuree = decodeId(n.id); })
      .then(() => firstNode(`{ medicalServices(code: "${service.name}") { edges { node { id } } } }`))
      .then((n) => { ids.service = decodeId(n.id); })
      .then(() => {
        const subItems = service.subservicesItems
          // as the claim form sends them: without a price the API fails on a
          // None * float instead of reporting the missing field
          .map((sub) => `{ subItemCode: "${sub.code}" qtyProvided: "${sub.qty}" qtyAsked: "${sub.qty}" priceAsked: "1.00" }`)
          .join(' ');
        return mutate('createClaim', `code: "${data.claim.code}" insureeId: ${ids.insuree}
          dateFrom: "${isoDay(-1)}" dateTo: "${isoDay(-1)}" dateClaimed: "${isoDay(0)}"
          icdId: ${B.diagnoses[0].id} healthFacilityId: ${B.healthFacilities.hospital.id}
          adminId: ${B.users.hospitalClaimAdmin.id} visitType: "O" items: []
          services: [{ serviceId: ${ids.service} status: 1 qtyProvided: "1" priceAsked: "10.00"
            serviceItemSet: [${subItems}] serviceServiceSet: [] }]`);
      })
      .then(() => firstNode(`{ claims(code: "${data.claim.code}") { edges { node {
        status services { service { code } items { item { code } qtyProvided } } } } } }`))
      .then((claim) => {
        expect(claim.status, 'claim status: Entered').to.eq(2);
        expect(claim.services.map((s) => s.service.code)).to.deep.eq([service.name]);
        const saved = Object.fromEntries(claim.services[0].items.map((i) => [i.item.code, Number(i.qtyProvided)]));
        service.subservicesItems.forEach((sub) => {
          expect(saved[sub.code], `quantity of sub-item ${sub.code}`).to.eq(sub.qty);
        });
      });
  });

  it('Claim duplication workflow', () => {
    openClaim(data.claim.code);
    fab('file_copy').click();
    cy.enterMuiInput('Insurance No.', data.duplicate.chfId);
    cy.enterMuiInput('Claim No.', data.duplicate.code);
    save(data.duplicate.code);
    findClaim(data.duplicate.code).should('contain', 'Entered');
  });

  // The review workflow (select for review, adjust, deliver) is in
  // uat-claims-review.cy.js (OCM-42, OCM-43, OCM-159): it needs its own checked claims.
});
