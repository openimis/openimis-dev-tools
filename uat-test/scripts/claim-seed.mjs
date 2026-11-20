// Builds the data the claim-check UAT cases (OCM-53..77, 98) need and the claims they
// submit, through the openIMIS GraphQL API, on the facilities, diagnosis and officer of
// the UAT baseline (scripts/baseline.mjs). Most rejections only happen once earlier
// claims have used a limit up, which is what makes these cases hard to run by hand.
//
// Used by cypress/e2e/claim-checks.cy.js (task `prepareClaimCheck`), and on its own
// to see what the backend does, without the UI:
//   node scripts/claim-seed.mjs [--base-url http://localhost:3001] [OCM-61 ...]
//
// Each case gets its own family, policy, items and services, so cases do not
// interfere and a rerun does not depend on data left by an earlier one.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Api, dayOffset, decodeId } from "./lib/api.mjs";
import { ensureBaseline } from "./baseline.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// 0 = Error: saved with a field error, not submittable (OP-3239)
const CLAIM_STATUS = { 0: "Error", 1: "Rejected", 2: "Entered", 4: "Checked", 8: "Processed", 16: "Valuated" };

const runTag = () => Date.now().toString(36).slice(-3).toUpperCase();

// References from the UAT baseline (scripts/baseline.mjs): the hospital (care type B)
// and the health centre (care type O, out-patient only) of district r1d2, their claim
// administrators, a diagnosis, the r1d2 officer and a village of that district.
function references(baseline) {
  const hf = (role, adminRole) => {
    const f = baseline.healthFacilities[role];
    return {
      intId: f.id, uuid: f.uuid, code: f.code, careType: f.careType, location: { uuid: baseline.locations[f.district].uuid },
      servicesPricelist: f.servicesPricelist, itemsPricelist: f.itemsPricelist, adminId: baseline.users[adminRole].id,
    };
  };
  return {
    hospital: hf("hospital", "hospitalClaimAdmin"),
    healthCentre: hf("healthCentre", "healthCentreClaimAdmin"),
    icdId: baseline.diagnoses[0].id,
    officerId: baseline.users.officerR1d2.id,
    villageId: baseline.locations.r1d2m1v1.id,
  };
}

// --- builders ---------------------------------------------------------------------

async function createMedical(api, kind, { code, name, careType = "B", category, patientCategories, frequency }) {
  const isItem = kind === "item";
  await api.mutate(isItem ? "createItem" : "createService", isItem ? "CreateItemMutationInput" : "CreateServiceMutationInput", {
    code,
    name,
    type: isItem ? "D" : "P",
    careType,
    price: "10.00",
    patientCategories: patientCategories ?? ["ADULT", "MINOR", "MALE", "FEMALE"],
    ...(frequency ? { frequency: String(frequency) } : {}),
    ...(isItem ? {} : { level: "C", category: category ?? null, packagetype: "S" }),
  });
  const node = await api.one(
    `query($c: String!) { ${isItem ? "medicalItems" : "medicalServices"}(code: $c) { edges { node { id uuid code } } } }`,
    { c: code },
  );
  return { kind, code, uuid: node.uuid, id: decodeId(node.id) };
}

async function addToPricelists(api, refs, medicals) {
  for (const hf of [refs.hospital, refs.healthCentre]) {
    for (const kind of ["item", "service"]) {
      const added = medicals.filter((m) => m.kind === kind).map((m) => m.uuid);
      if (!added.length) continue;
      const pl = kind === "item" ? hf.itemsPricelist : hf.servicesPricelist;
      await api.mutate(
        kind === "item" ? "updateItemsPricelist" : "updateServicesPricelist",
        kind === "item" ? "UpdateItemsPricelistMutationInput" : "UpdateServicesPricelistMutationInput",
        // locationId kept: an update without it clears the list's district.
        { uuid: pl.uuid, name: pl.name, pricelistDate: pl.pricelistDate.slice(0, 10), locationId: pl.locationUuid, addedDetails: added },
      );
    }
  }
}

// The product mutation reads all six limitation pairs: 100 % co-insurance everywhere,
// i.e. the item or service is fully covered.
const FULL_COVER = {
  priceOrigin: "PRICELIST",
  ...Object.fromEntries(["", "R", "E"].map((s) => [`limitationType${s}`, "CO_INSURANCE"])),
  ...Object.fromEntries(["Adult", "Child", "AdultR", "ChildR", "AdultE", "ChildE"].map((s) => [`limit${s}`, "100.00"])),
};

async function createProduct(api, { code, name, limits = {}, items = [], services = [] }) {
  await api.mutate("createProduct", "CreateProductMutationInput", {
    code,
    name,
    dateFrom: dayOffset(-365),
    dateTo: dayOffset(365),
    insurancePeriod: 12,
    maxMembers: 10,
    lumpSum: "100.00",
    ...limits,
    items: items.map(({ medical, ...settings }) => ({ itemUuid: medical.uuid, ...FULL_COVER, ...settings })),
    services: services.map(({ medical, ...settings }) => ({ serviceUuid: medical.uuid, ...FULL_COVER, ...settings })),
  });
  const node = await api.one(`query($c: String!) { products(code: $c) { edges { node { id uuid } } } }`, { c: code });
  return { code, uuid: node.uuid, id: decodeId(node.id) };
}

let chfSeq = 0;
const newChfId = () => String(900000000 + ((Date.now() * 10 + (chfSeq += 1)) % 99999999)).slice(0, 9);

// A family whose head is an adult man, optionally with a child member.
async function createFamily(api, refs, { withChild = false } = {}) {
  const head = { chfId: newChfId(), lastName: "UAT", otherNames: "Claimcheck", genderId: "M", dob: "1980-01-15", head: true };
  await api.mutate("createFamily", "CreateFamilyMutationInput", {
    locationId: refs.villageId,
    poverty: false,
    headInsuree: head,
  });
  const headNode = await api.one(
    `query($c: String!) { insurees(chfId: $c) { edges { node { id uuid family { id uuid } } } } }`,
    { c: head.chfId },
  );
  const family = { id: decodeId(headNode.family.id), uuid: headNode.family.uuid };
  const result = { family, head: { chfId: head.chfId, id: decodeId(headNode.id) } };
  if (withChild) {
    const child = { chfId: newChfId(), lastName: "UAT", otherNames: "Child", genderId: "F", dob: dayOffset(-5 * 365) };
    await api.mutate("createInsuree", "CreateInsureeMutationInput", { ...child, familyId: family.id, head: false });
    const childNode = await api.one(`query($c: String!) { insurees(chfId: $c) { edges { node { id } } } }`, { c: child.chfId });
    result.child = { chfId: child.chfId, id: decodeId(childNode.id) };
  }
  return result;
}

// An active policy: started 40 days ago and fully paid on that day.
async function createActivePolicy(api, refs, product, family) {
  const enrollDate = dayOffset(-40);
  // The product has a lump sum of 100 and no cycles: the policy starts on enrolment
  // and runs 12 months, so the values are known without asking policyValues.
  const value = "100.00";
  const startDate = enrollDate;
  const expiry = new Date(`${enrollDate}T00:00:00Z`);
  expiry.setUTCFullYear(expiry.getUTCFullYear() + 1);
  expiry.setUTCDate(expiry.getUTCDate() - 1);
  const expiryDate = expiry.toISOString().slice(0, 10);
  await api.mutate("createPolicy", "CreatePolicyMutationInput", {
    enrollDate,
    startDate,
    expiryDate,
    value,
    productId: product.id,
    familyId: family.id,
    officerId: refs.officerId,
  });
  const { policiesByFamily } = await api.query(
    `query($f: String!) { policiesByFamily(familyUuid: $f) { edges { node { policyUuid status } } } }`,
    { f: family.uuid },
  );
  const policyUuid = policiesByFamily.edges[0].node.policyUuid;
  await api.mutate("createPremium", "CreatePremiumMutationInput", {
    policyUuid,
    amount: value,
    payDate: enrollDate,
    payType: "C",
    receipt: `UAT-${Date.now().toString(36)}`,
    isPhotoFee: false,
    action: "ENFORCE",
  });
  return { uuid: policyUuid, value, startDate };
}

let claimSeq = 0;
// allowEntryError: the claim is saved even when its fields are wrong (status Error,
// OP-3239); its entry errors are returned instead of failing the setup.
async function createClaim(api, refs, { insureeId, hf = "hospital", dateFrom = D(), dateTo, dateClaimed, items = [], services = [], allowEntryError = false }) {
  const facility = refs[hf];
  const code = `CK${runTag()}${(claimSeq += 1).toString(36).toUpperCase().padStart(2, "0")}`.slice(0, 8);
  const log = await api.mutate("createClaim", "CreateClaimMutationInput", {
    code,
    insureeId,
    dateFrom,
    dateTo: dateTo ?? dateFrom,
    dateClaimed: dateClaimed ?? D(),
    icdId: refs.icdId,
    healthFacilityId: facility.intId,
    adminId: facility.adminId,
    visitType: "O",
    items: items.map((m) => ({ itemId: m.id, status: 1, qtyProvided: "1", priceAsked: "10.00" })),
    services: services.map((m) => ({ serviceId: m.id, status: 1, qtyProvided: "1", priceAsked: "10.00" })),
  }, { inline: true, allowError: allowEntryError });
  const node = await api.one(`query($c: String!) { claims(code: $c) { edges { node { uuid } } } }`, { c: code });
  const entryErrors = log.status === 1 ? JSON.parse(log.error || "[]") : [];
  return { code, uuid: node.uuid, entryErrorCodes: entryErrors.map((e) => e.code) };
}

// A rejected claim makes the submitClaims mutation end in error; the claim itself
// tells what happened.
export async function submitClaims(api, claims) {
  return api.mutate("submitClaims", "SubmitClaimsMutationInput", { uuids: claims.map((c) => c.uuid) }, { allowError: true });
}

export async function claimResult(api, code) {
  const node = await api.one(
    `query($c: String!) { claims(code: $c) { edges { node { code status rejectionReason category
       items { status rejectionReason item { code } } services { status rejectionReason service { code } } } } } }`,
    { c: code },
  );
  return {
    code: node.code,
    status: CLAIM_STATUS[node.status] ?? node.status,
    rejectionReason: node.rejectionReason,
    category: node.category,
    items: node.items.map((i) => ({ code: i.item.code, status: i.status, rejectionReason: i.rejectionReason })),
    services: node.services.map((s) => ({ code: s.service.code, status: s.status, rejectionReason: s.rejectionReason })),
  };
}

// CARE_DAY: every claim is for care today, claimed today (D = dayOffset(CARE_DAY)).
// - Never later than today: the API saves a claim dated in the future, or with care
//   after the claim date, in Error (OP-3250).
// - Never earlier than today: a policy is read as recorded on the care date
//   (get_valid_policies_qs, OP-3234), so a policy entered today does not cover care
//   on earlier days.
// - Today works since OP-3253: processing finds the price-list row created today
//   (get_queryset_valid_at_date compared it with midnight), as validation did.
// Earlier claims on the same day still count for frequencies, limits and maxima.
const CARE_DAY = 0;
const D = (offset = 0) => dayOffset(CARE_DAY + offset);

// --- the cases --------------------------------------------------------------------
// Each case returns the claim to submit and what the backend should answer:
// `claim` = claim status / claim-level reason, `rows` = row (item/service) reasons.
// Reason codes: claim/validations.py REJECTION_REASON_*.

const CASES = {
  "OCM-53": { title: "Family/group not found", build: async (ctx) => {
    const fam = await ctx.family();
    await createActivePolicy(ctx.api, ctx.refs, ctx.base, fam.family);
    const claim = await createClaim(ctx.api, ctx.refs, { insureeId: fam.head.id, items: [ctx.m.ok] });
    await ctx.api.mutate("deleteFamilies", "DeleteFamiliesMutationInput", { uuids: [fam.family.uuid], deleteMembers: true });
    return { claim, expect: { claim: { status: "Rejected" }, rows: { items: [7] } } };
  } },
  "OCM-54": { title: "No active policy on the family/group", build: async (ctx) => {
    const fam = await ctx.family();
    const claim = await createClaim(ctx.api, ctx.refs, { insureeId: fam.head.id, items: [ctx.m.ok] });
    // 21 = no active policy (REJECTION_REASON_NO_COVERAGE). Rows took 7 only while
    // Claim.reject() applied the family code to every error (fixed by OP-3232).
    return { claim, expect: { claim: { status: "Rejected" }, rows: { items: [21] } } };
  } },
  // OP-3250: care after the claim date is an entry error (10 start, 11 end after the
  // claim date): the claim is saved in Error and cannot be submitted, so it is no
  // longer rejected with reason 9 on submission. TestLink OCM-55 still says 9.
  "OCM-55": { title: "Claim date before the care 'From' date (API: the UI requires the From date)", build: async (ctx) => {
    const fam = await ctx.insured();
    const claim = await createClaim(ctx.api, ctx.refs, { insureeId: fam.head.id, dateFrom: D(), dateClaimed: D(-1), items: [ctx.m.ok], allowEntryError: true });
    return { claim, expect: { submit: false, entryErrorCodes: [10, 11], claim: { status: "Error" } } };
  } },
  // OP-3239: the claim is saved in Error with the entry error 4 ("End date is
  // smaller than start date") instead of being entered, and cannot be submitted.
  "OCM-56": { title: "Care 'To' date before 'From' date (API: the UI date pickers prevent it)", build: async (ctx) => {
    const fam = await ctx.insured();
    const claim = await createClaim(ctx.api, ctx.refs, { insureeId: fam.head.id, dateFrom: D(), dateTo: D(-3), dateClaimed: D(), items: [ctx.m.ok], allowEntryError: true });
    return { claim, expect: { submit: false, entryErrorCodes: [4], claim: { status: "Error" } } };
  } },
  "OCM-57": { title: "Item patient category (women only) excludes the insuree (man)", build: async (ctx) => {
    const fam = await ctx.insured();
    const claim = await createClaim(ctx.api, ctx.refs, { insureeId: fam.head.id, items: [ctx.m.womenItem] });
    return { claim, expect: { claim: { status: "Rejected" }, rows: { items: [4] } } };
  } },
  "OCM-58": { title: "Service patient category (women only) excludes the insuree (man)", build: async (ctx) => {
    const fam = await ctx.insured();
    const claim = await createClaim(ctx.api, ctx.refs, { insureeId: fam.head.id, services: [ctx.m.womenService] });
    return { claim, expect: { claim: { status: "Rejected" }, rows: { services: [4] } } };
  } },
  "OCM-59": { title: "Service within its waiting period (3 months, policy 40 days old)", build: async (ctx) => {
    const fam = await ctx.insured();
    const claim = await createClaim(ctx.api, ctx.refs, { insureeId: fam.head.id, services: [ctx.m.waitingService] });
    return { claim, expect: { claim: { status: "Rejected" }, rows: { services: [17] } } };
  } },
  "OCM-61": { title: "Service already provided the maximum number of times (adult, max 1)", build: async (ctx) => {
    const fam = await ctx.insured();
    await ctx.prior({ insureeId: fam.head.id, services: [ctx.m.limitService] });
    const claim = await createClaim(ctx.api, ctx.refs, { insureeId: fam.head.id, services: [ctx.m.limitService] });
    return { claim, expect: { claim: { status: "Rejected" }, rows: { services: [16] } } };
  } },
  "OCM-62": { title: "Item already provided the maximum number of times (child, max 1)", build: async (ctx) => {
    const fam = await ctx.insured({ withChild: true });
    await ctx.prior({ insureeId: fam.child.id, items: [ctx.m.limitItem] });
    const claim = await createClaim(ctx.api, ctx.refs, { insureeId: fam.child.id, items: [ctx.m.limitItem] });
    return { claim, expect: { claim: { status: "Rejected" }, rows: { items: [16] } } };
  } },
  ...Object.fromEntries([
    ["OCM-63", "consultations", "consultation", 13],
    ["OCM-64", "surgeries", "surgery", 14],
    ["OCM-65", "deliveries", "delivery", 15],
    ["OCM-98", "antenatal care", "antenatal", 19],
    ["OCM-66", "hospital admissions (in-patient)", "hospitalization", 11],
    ["OCM-67", "out-patient visits", "visit", 12],
  ].map(([id, label, key, reason]) => [id, { title: `Insuree has used all her ${label} (product maximum 1)`, build: async (ctx) => {
    const fam = await ctx.insured({ product: ctx.max });
    const inpatient = key === "hospitalization";
    // In-patient = 'To' date after 'From'; the stay ends on CARE_DAY.
    const days = { dateFrom: D(inpatient ? -2 : 0), dateTo: D() };
    await ctx.prior({ insureeId: fam.head.id, ...days, services: [ctx.m[key]] });
    const claim = await createClaim(ctx.api, ctx.refs, { insureeId: fam.head.id, ...days, services: [ctx.m[key]] });
    return { claim, expect: { claim: { status: "Rejected", rejectionReason: reason } } };
  } }])),
  "OCM-70": { title: "Item not covered by the policy (in the price list, not in the product)", build: async (ctx) => {
    const fam = await ctx.insured();
    const claim = await createClaim(ctx.api, ctx.refs, { insureeId: fam.head.id, items: [ctx.m.uncoveredItem] });
    return { claim, expect: { claim: { status: "Rejected" }, rows: { items: [3] } } };
  } },
  "OCM-71": { title: "Service not covered by the policy (in the price list, not in the product)", build: async (ctx) => {
    const fam = await ctx.insured();
    const claim = await createClaim(ctx.api, ctx.refs, { insureeId: fam.head.id, services: [ctx.m.uncoveredService] });
    return { claim, expect: { claim: { status: "Rejected" }, rows: { services: [3] } } };
  } },
  "OCM-74": { title: "In-patient item claimed at an out-patient health facility (the baseline health centre)", build: async (ctx) => {
    const fam = await ctx.insured();
    const claim = await createClaim(ctx.api, ctx.refs, { insureeId: fam.head.id, hf: "healthCentre", items: [ctx.m.inpatientItem] });
    return { claim, expect: { claim: { status: "Rejected" }, rows: { items: [10] } } };
  } },
  "OCM-75": { title: "In-patient service claimed at an out-patient health facility (the baseline health centre)", build: async (ctx) => {
    const fam = await ctx.insured();
    const claim = await createClaim(ctx.api, ctx.refs, { insureeId: fam.head.id, hf: "healthCentre", services: [ctx.m.inpatientService] });
    return { claim, expect: { claim: { status: "Rejected" }, rows: { services: [10] } } };
  } },
  "OCM-76": { title: "Service provided again within its frequency (30 days, already given the same day)", build: async (ctx) => {
    const fam = await ctx.insured();
    await ctx.prior({ insureeId: fam.head.id, services: [ctx.m.frequentService] });
    const claim = await createClaim(ctx.api, ctx.refs, { insureeId: fam.head.id, services: [ctx.m.frequentService] });
    return { claim, expect: { claim: { status: "Rejected" }, rows: { services: [5] } } };
  } },
  "OCM-77": { title: "Item provided again within its frequency (30 days, already given the same day)", build: async (ctx) => {
    const fam = await ctx.insured();
    await ctx.prior({ insureeId: fam.head.id, items: [ctx.m.frequentItem] });
    const claim = await createClaim(ctx.api, ctx.refs, { insureeId: fam.head.id, items: [ctx.m.frequentItem] });
    return { claim, expect: { claim: { status: "Rejected" }, rows: { items: [5] } } };
  } },
};

export const CASE_IDS = Object.keys(CASES);
export const caseTitle = (id) => CASES[id].title;

// Shared setup: the medical items/services and the two products of this run.
export async function prepareRun(baseUrl, credentials, baseline) {
  const api = new Api(baseUrl, "UAT claim checks");
  await api.login(credentials);
  const refs = references(baseline ?? (await ensureBaseline(baseUrl, credentials)));
  const tag = runTag();
  const spec = {
    ok: ["item", {}],
    womenItem: ["item", { patientCategories: ["ADULT", "MINOR", "FEMALE"] }],
    womenService: ["service", { patientCategories: ["ADULT", "MINOR", "FEMALE"] }],
    waitingService: ["service", {}],
    limitService: ["service", {}],
    limitItem: ["item", {}],
    uncoveredItem: ["item", {}],
    uncoveredService: ["service", {}],
    inpatientItem: ["item", { careType: "I" }],
    inpatientService: ["service", { careType: "I" }],
    frequentItem: ["item", { frequency: 30 }],
    frequentService: ["service", { frequency: 30 }],
    consultation: ["service", { category: "C" }],
    surgery: ["service", { category: "S" }],
    delivery: ["service", { category: "D" }],
    antenatal: ["service", { category: "A" }],
    hospitalization: ["service", { category: "O" }],
    visit: ["service", { category: "V" }],
  };
  const m = {};
  let n = 0;
  for (const [key, [kind, opts]] of Object.entries(spec)) {
    n += 1;
    const code = `${kind === "item" ? "I" : "S"}${tag}${n.toString(36).toUpperCase().padStart(2, "0")}`;
    m[key] = await createMedical(api, kind, { code, name: `UAT ${key} ${tag}`, ...opts });
  }
  await addToPricelists(api, refs, Object.values(m));
  const covered = (keys) => keys.map((k) => ({ medical: m[k] }));
  const base = await createProduct(api, {
    code: `UB${tag}`,
    name: `UAT claim checks ${tag}`,
    items: [
      ...covered(["ok", "womenItem", "inpatientItem", "frequentItem"]),
      { medical: m.limitItem, limitNoAdult: 1, limitNoChild: 1 },
    ],
    services: [
      ...covered(["womenService", "inpatientService", "frequentService"]),
      { medical: m.waitingService, waitingPeriodAdult: 3, waitingPeriodChild: 3 },
      { medical: m.limitService, limitNoAdult: 1, limitNoChild: 1 },
    ],
  });
  const max = await createProduct(api, {
    code: `UM${tag}`,
    name: `UAT claim maxima ${tag}`,
    limits: { maxNoConsultation: 1, maxNoSurgery: 1, maxNoDelivery: 1, maxNoAntenatal: 1, maxNoHospitalization: 1, maxNoVisits: 1 },
    items: covered(["ok"]),
    services: covered(["consultation", "surgery", "delivery", "antenatal", "hospitalization", "visit"]),
  });
  return { refs, m, base, max };
}

// Builds one case on a prepared run; the returned claim is entered, not submitted.
export async function prepareCase(baseUrl, credentials, run, caseId) {
  const api = new Api(baseUrl, "UAT claim checks");
  await api.login(credentials);
  const ctx = {
    api,
    refs: run.refs,
    m: run.m,
    base: run.base,
    max: run.max,
    family: (opts) => createFamily(api, run.refs, opts),
    insured: async ({ product = run.base, ...opts } = {}) => {
      const fam = await createFamily(api, run.refs, opts);
      fam.policy = await createActivePolicy(api, run.refs, product, fam.family);
      return fam;
    },
    // An earlier claim that is submitted and checked, using up a limit.
    prior: async (claimInput) => {
      const claim = await createClaim(api, run.refs, claimInput);
      await submitClaims(api, [claim]);
      const result = await claimResult(api, claim.code);
      if (result.status !== "Checked") throw new Error(`Setup claim ${claim.code} was not accepted: ${JSON.stringify(result)}`);
      return claim;
    },
  };
  const { claim, expect } = await CASES[caseId].build(ctx);
  return { caseId, title: CASES[caseId].title, claim, expect };
}

export async function submitAndRead(baseUrl, credentials, claim, { submit = true } = {}) {
  const api = new Api(baseUrl, "UAT claim checks");
  await api.login(credentials);
  if (submit) await submitClaims(api, [claim]);
  return claimResult(api, claim.code);
}

export async function readClaim(baseUrl, credentials, code) {
  const api = new Api(baseUrl, "UAT claim checks");
  await api.login(credentials);
  return claimResult(api, code);
}

// Compares a claim result with a case's expectation; returns the differences.
export function compare(expect, result, claim = {}) {
  const problems = [];
  if (expect.entryErrorCodes && JSON.stringify(claim.entryErrorCodes) !== JSON.stringify(expect.entryErrorCodes)) {
    problems.push(`entry errors: expected ${expect.entryErrorCodes}, got ${claim.entryErrorCodes}`);
  }
  for (const [key, value] of Object.entries(expect.claim ?? {})) {
    if (result[key] !== value) problems.push(`claim ${key}: expected ${value}, got ${result[key]}`);
  }
  for (const kind of ["items", "services"]) {
    const reasons = expect.rows?.[kind];
    if (!reasons) continue;
    const got = result[kind].map((r) => r.rejectionReason);
    if (JSON.stringify(got) !== JSON.stringify(reasons)) problems.push(`${kind} rejection reasons: expected ${reasons}, got ${got}`);
  }
  return problems;
}

async function cli() {
  const args = process.argv.slice(2);
  const i = args.indexOf("--base-url");
  const baseUrl = i >= 0 ? args.splice(i, 2)[1] : process.env.CYPRESS_BASE_URL ?? "http://localhost:3001";
  const ids = args.length ? args : CASE_IDS;
  const credentials = JSON.parse(fs.readFileSync(path.join(ROOT, "cypress", "fixtures", "cred.json"), "utf8"));
  console.log(`Preparing items, services and products on ${baseUrl}...`);
  const run = await prepareRun(baseUrl, credentials);
  let failed = 0;
  for (const id of ids) {
    try {
      const c = await prepareCase(baseUrl, credentials, run, id);
      const result = await submitAndRead(baseUrl, credentials, c.claim, { submit: c.expect.submit !== false });
      const problems = compare(c.expect, result, c.claim);
      failed += problems.length ? 1 : 0;
      const rows = [...result.items.map((r) => `item R=${r.rejectionReason}`), ...result.services.map((r) => `service R=${r.rejectionReason}`)].join(", ");
      console.log(`${problems.length ? "FAIL" : "ok  "} ${id} ${c.title}\n     claim ${result.code}: ${result.status}, reason ${result.rejectionReason}, category ${result.category}; ${rows}${problems.length ? `\n     ${problems.join("\n     ")}` : ""}`);
    } catch (error) {
      failed += 1;
      console.log(`ERR  ${id}: ${process.env.DEBUG ? error.stack : error.message}`);
    }
  }
  process.exitCode = failed ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await cli();
