// The UAT baseline: the reference data every UAT spec may rely on, fetched or created
// through the openIMIS API so the suite runs on an empty openIMIS database as well as
// on the demo dataset. Nothing here reuses demo records: every code starts with "BL"
// and the names exist in no demo dataset, so a baseline record is never mistaken for
// a demo one (or the reverse).
//
// Every ensure step looks the record up by its code first and creates it only when it
// is missing, so the baseline is created once per database and later calls only read
// it. Specs get the resolved records (codes, names, ids, uuids) from ensureBaseline(),
// never by hardcoding them: in Cypress through the `ensureBaseline` task, stored in
// Cypress.env('baseline') by support/e2e.js (see cypress/support/baseline.js).
//
// Locations are a fixed tree whose relations the specs rely on (the README lists them):
//   r1 ─ r1d1 ─ r1d1m1 ─ r1d1m1v1, r1d1m1v2     families, officer r1d1, the clerk
//      │      ├ r1d1m2 ─ r1d1m2v1
//      │      └ r1d1m3 ─ r1d1m3v1
//      └ r1d2 ─ r1d2m1 ─ r1d2m1v1, r1d2m1v2     hospital, health centre, officer r1d2
//   r2 ─ r2d1 ─ r2d1m1 ─ r2d1m1v1              a region of its own (other hospital)
//
// CLI (prints the resolved baseline):
//   node scripts/baseline.mjs [--base-url http://localhost:3001]
// Puts back the task group bindings saved by run-uat.mjs (reports/<run>/task-sources-before.json):
//   node scripts/baseline.mjs --restore-task-sources FILE [--base-url URL]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Api, dayOffset, decodeId } from "./lib/api.mjs";
import { connect as connectAdmin } from "./module-config.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const INDIVIDUALS_CSV = path.join(ROOT, "cypress", "fixtures", "individuals.csv");

// [alias, code, name, type, parent alias]
const LOCATIONS = [
  ["r1", "BLR1", "Arventa", "R", null],
  ["r1d1", "BLR1D1", "Kestrel", "D", "r1"],
  ["r1d1m1", "BLR1D1M1", "Lindale", "W", "r1d1"],
  ["r1d1m1v1", "BLR1D1M1V1", "Oakfield", "V", "r1d1m1"],
  ["r1d1m1v2", "BLR1D1M1V2", "Pinecrest", "V", "r1d1m1"],
  ["r1d1m2", "BLR1D1M2", "Marwick", "W", "r1d1"],
  ["r1d1m2v1", "BLR1D1M2V1", "Quarrytown", "V", "r1d1m2"],
  ["r1d1m3", "BLR1D1M3", "Mossbank", "W", "r1d1"],
  ["r1d1m3v1", "BLR1D1M3V1", "Rosemead", "V", "r1d1m3"],
  ["r1d2", "BLR1D2", "Heronvale", "D", "r1"],
  ["r1d2m1", "BLR1D2M1", "Norby", "W", "r1d2"],
  ["r1d2m1v1", "BLR1D2M1V1", "Redmoor", "V", "r1d2m1"],
  ["r1d2m1v2", "BLR1D2M1V2", "Stonebridge", "V", "r1d2m1"],
  ["r2", "BLR2", "Westmarch", "R", null],
  ["r2d1", "BLR2D1", "Tamsin", "D", "r2"],
  ["r2d1m1", "BLR2D1M1", "Upton", "W", "r2d1"],
  ["r2d1m1v1", "BLR2D1M1V1", "Valewood", "V", "r2d1m1"],
];

const ITEMS = [
  { code: "BLI001", name: "Baseline Paracetamol 500mg", price: "5.00" },
  { code: "BLI002", name: "Baseline Amoxicillin 250mg", price: "8.00" },
  { code: "BLI003", name: "Baseline Bandage roll", price: "3.00" },
  { code: "BLI004", name: "Baseline Oral rehydration salts", price: "2.00" },
];

const SERVICES = [
  { code: "BLS001", name: "Baseline Consultation", price: "15.00", category: "C" },
  { code: "BLS002", name: "Baseline Laboratory test", price: "12.00" },
  { code: "BLS003", name: "Baseline Ward day", price: "40.00", careType: "I" },
  { code: "BLS004", name: "Baseline Antenatal visit", price: "20.00", category: "A" },
  { code: "BLS005", name: "Baseline Minor surgery", price: "60.00", category: "S" },
];

const DIAGNOSES = [
  { code: "BLD01", name: "Baseline fever of unknown origin" },
  { code: "BLD02", name: "Baseline acute gastroenteritis" },
  { code: "BLD03", name: "Baseline minor injury" },
];

// Health facilities, keyed by role; `district` is a location alias.
const HEALTH_FACILITIES = {
  hospital: { code: "BLHOS01", name: "Baseline Heronvale Hospital", district: "r1d2", level: "H", careType: "B", legalForm: "G" },
  healthCentre: { code: "BLHC01", name: "Baseline Norby Health Centre", district: "r1d2", level: "C", careType: "O", legalForm: "P" },
  otherHospital: { code: "BLHOS02", name: "Baseline Westmarch Hospital", district: "r2d1", level: "H", careType: "B", legalForm: "G" },
};

const PASSWORD = "Baseline#2026";

// Users, keyed by role. Officers and claim administrators get their record of the
// same code; `interactive` users can log in (with PASSWORD) and get `roles` by name.
const USERS = {
  officerR1d1: { username: "BLEO01", otherNames: "Ada", lastName: "Fairbrook", types: ["OFFICER"], district: "r1d1" },
  officerR1d2: { username: "BLEO02", otherNames: "Bram", lastName: "Holloway", types: ["OFFICER"], district: "r1d2" },
  hospitalClaimAdmin: {
    username: "BLCA01", otherNames: "Cora", lastName: "Whitlock", types: ["INTERACTIVE", "CLAIM_ADMIN"],
    hf: "hospital", districts: ["r1d2"], roles: ["Claim Administrator"],
  },
  healthCentreClaimAdmin: { username: "BLCA02", otherNames: "Dane", lastName: "Marlow", types: ["CLAIM_ADMIN"], hf: "healthCentre" },
  clerk: { username: "BLCL01", otherNames: "Eli", lastName: "Thornbury", types: ["INTERACTIVE"], districts: ["r1d1"], roles: ["Clerk"] },
};

const PRODUCTS = {
  basic: { code: "BLBAS01", name: "Baseline Basic Cover", lumpSum: "100.00" },
  extended: { code: "BLEXT01", name: "Baseline Extended Cover", lumpSum: "250.00" },
};

const PAYER = { name: "Baseline Mutual Fund", type: "C", region: "r1" };

// Families, keyed by role; `policy` is a PRODUCTS key, kept active by ensureBaseline.
const FAMILIES = {
  insured: {
    village: "r1d1m1v1", officer: "officerR1d1", policy: "basic",
    head: { chfId: "880000011", otherNames: "Alden", lastName: "Brightwater", genderId: "M", dob: "1980-03-12" },
    members: [{ chfId: "880000012", otherNames: "Beatrix", lastName: "Brightwater", genderId: "F", dob: "1984-07-02" }],
  },
  uninsured: {
    village: "r1d1m1v1", officer: "officerR1d1",
    head: { chfId: "880000021", otherNames: "Corwin", lastName: "Ashdale", genderId: "M", dob: "1975-11-05" },
  },
  nearHospital: {
    village: "r1d2m1v1", officer: "officerR1d2", policy: "basic",
    head: { chfId: "880000031", otherNames: "Delia", lastName: "Penrose", genderId: "F", dob: "1990-05-20" },
  },
};

const ACTIVITY = "Baseline community work";

// Individuals (social protection), uploaded once from cypress/fixtures/individuals.csv.
const INDIVIDUALS_SOURCE = "uat-baseline-individuals";
const INDIVIDUALS_GROUP_PREFIX = "BL";

const log = (...args) => {
  if (process.env.UAT_BASELINE_QUIET !== "1") console.log("[baseline]", ...args);
};

// Looks a record up, creates it when missing, then looks it up again: two runs
// creating the same record at once leave one failed mutation, not a failed baseline.
async function ensure(what, find, create) {
  const found = await find();
  if (found) return found;
  log(`creating ${what}`);
  let error;
  try {
    await create();
  } catch (e) {
    error = e;
  }
  const created = await find();
  if (!created) throw new Error(`Cannot create ${what}${error ? `: ${error.message}` : ""}`);
  return created;
}

// --- locations ------------------------------------------------------------------

async function ensureLocations(api) {
  const locations = {};
  for (const [alias, code, name, type, parent] of LOCATIONS) {
    const find = () => api.first(`query($c: String!) { locations(code: $c) { edges { node { id uuid code name type } } } }`, { c: code });
    const node = await ensure(`location ${code}`, find, () =>
      api.mutate("createLocation", "CreateLocationMutationInput", {
        code, name, type, ...(parent ? { parentUuid: locations[parent].uuid } : {}),
      }));
    locations[alias] = {
      alias, id: decodeId(node.id), uuid: node.uuid, code: node.code, name: node.name, type: node.type, parent,
      // How the location pickers and the location tree show it.
      label: `${node.code} ${node.name}`,
      dashLabel: `${node.code} - ${node.name}`,
    };
  }
  return locations;
}

// Resolves "@alias" location codes of a CSV (cypress/fixtures/individuals.csv) to the
// baseline location's code and name.
export function resolveCsvLocations(csv, locations) {
  const lines = csv.trim().split("\n");
  const header = lines[0].split(",");
  const nameIdx = header.indexOf("location_name");
  const codeIdx = header.indexOf("location_code");
  return [lines[0], ...lines.slice(1).map((line) => {
    const row = line.split(",");
    const ref = row[codeIdx];
    if (ref?.startsWith("@")) {
      const loc = locations[ref.slice(1)];
      if (!loc) throw new Error(`Unknown baseline location ${ref} in individuals CSV`);
      row[codeIdx] = loc.code;
      row[nameIdx] = loc.name;
    }
    return row.join(",");
  })].join("\n");
}

// --- medical --------------------------------------------------------------------

async function ensureMedical(api) {
  const ensureOne = async (kind, spec) => {
    const isItem = kind === "item";
    const find = () => api.first(
      `query($c: String!) { ${isItem ? "medicalItems" : "medicalServices"}(code: $c) { edges { node { id uuid code name price } } } }`,
      { c: spec.code },
    );
    const node = await ensure(`${kind} ${spec.code}`, find, () =>
      api.mutate(isItem ? "createItem" : "createService", isItem ? "CreateItemMutationInput" : "CreateServiceMutationInput", {
        code: spec.code,
        name: spec.name,
        type: isItem ? "D" : "P",
        careType: spec.careType ?? "B",
        price: spec.price,
        patientCategories: ["ADULT", "MINOR", "MALE", "FEMALE"],
        ...(isItem ? {} : { level: "C", category: spec.category ?? null, packagetype: "S" }),
      }));
    return { kind, id: decodeId(node.id), uuid: node.uuid, code: node.code, name: node.name, price: node.price, label: `${node.code} ${node.name}` };
  };
  const items = [];
  for (const spec of ITEMS) items.push(await ensureOne("item", spec));
  const services = [];
  for (const spec of SERVICES) services.push(await ensureOne("service", spec));
  return { items, services };
}

// Diagnoses have no GraphQL mutation: they go through the registers upload of the
// tools module, with the INSERT strategy (adds the missing codes, touches nothing else).
async function ensureDiagnoses(api) {
  const find = (code) => api.first(`query($c: String!) { diagnoses(code: $c) { edges { node { id code name } } } }`, { c: code });
  const missing = [];
  for (const d of DIAGNOSES) if (!(await find(d.code))) missing.push(d);
  if (missing.length) {
    log(`uploading diagnoses ${missing.map((d) => d.code).join(", ")}`);
    const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
    const xml = `<?xml version="1.0" encoding="utf-8"?>\n<Diagnoses>${missing
      .map((d) => `<Diagnosis><DiagnosisCode>${esc(d.code)}</DiagnosisCode><DiagnosisName>${esc(d.name)}</DiagnosisName></Diagnosis>`)
      .join("")}</Diagnoses>`;
    const result = await api.upload("tools/registers/upload_diagnoses", { dry_run: "false", strategy: "INSERT" },
      { content: xml, type: "text/xml", name: "uat-baseline-diagnoses.xml" });
    if (result?.success === false) throw new Error(`Diagnoses upload failed: ${JSON.stringify(result)}`);
  }
  const diagnoses = [];
  for (const d of DIAGNOSES) {
    const node = await find(d.code);
    if (!node) throw new Error(`Diagnosis ${d.code} missing after upload`);
    diagnoses.push({ id: decodeId(node.id), code: node.code, name: node.name, label: `${node.code} ${node.name}` });
  }
  return diagnoses;
}

// --- health facilities ----------------------------------------------------------

async function ensurePricelist(api, kind, name, district, medicals) {
  const query = kind === "item" ? "itemsPricelists" : "servicesPricelists";
  const find = () => api.first(`query($n: String!) { ${query}(name: $n) { edges { node { id uuid name pricelistDate location { uuid } } } } }`, { n: name });
  const node = await ensure(`${kind}s price list ${name}`, find, () =>
    api.mutate(kind === "item" ? "createItemsPricelist" : "createServicesPricelist",
      kind === "item" ? "CreateItemsPricelistMutationInput" : "CreateServicesPricelistMutationInput", {
        name,
        pricelistDate: dayOffset(-1),
        locationId: district.uuid,
        addedDetails: medicals.map((m) => m.uuid),
      }));
  // An update that omits locationId clears the location (medical_pricelist
  // gql_mutations.py), which turns the list national: put the district back.
  if (node.location?.uuid !== district.uuid) {
    await api.mutate(kind === "item" ? "updateItemsPricelist" : "updateServicesPricelist",
      kind === "item" ? "UpdateItemsPricelistMutationInput" : "UpdateServicesPricelistMutationInput", {
        uuid: node.uuid,
        name: node.name,
        pricelistDate: node.pricelistDate.slice(0, 10),
        locationId: district.uuid,
      });
  }
  return { id: decodeId(node.id), uuid: node.uuid, name: node.name, pricelistDate: node.pricelistDate, locationUuid: district.uuid };
}

async function ensureHealthFacilities(api, locations, medical) {
  const facilities = {};
  for (const [role, spec] of Object.entries(HEALTH_FACILITIES)) {
    const district = locations[spec.district];
    const itemsPricelist = await ensurePricelist(api, "item", `${spec.code} items`, district, medical.items);
    const servicesPricelist = await ensurePricelist(api, "service", `${spec.code} services`, district, medical.services);
    const find = () => api.first(
      `query($c: String!) { healthFacilities(code_Iexact: $c) { edges { node { id uuid code name careType level location { uuid } } } } }`,
      { c: spec.code },
    );
    const node = await ensure(`health facility ${spec.code}`, find, () =>
      api.mutate("createHealthFacility", "CreateHealthFacilityMutationInput", {
        code: spec.code,
        name: spec.name,
        legalFormId: spec.legalForm,
        level: spec.level,
        careType: spec.careType,
        locationId: district.id,
        itemsPricelistId: itemsPricelist.id,
        servicesPricelistId: servicesPricelist.id,
      }));
    facilities[role] = {
      role, id: decodeId(node.id), uuid: node.uuid, code: node.code, name: node.name, careType: node.careType, level: node.level,
      district: spec.district, label: `${node.code} ${node.name}`, itemsPricelist, servicesPricelist,
    };
  }
  return facilities;
}

// --- users ----------------------------------------------------------------------

async function roleIds(api, names = []) {
  const ids = [];
  for (const name of names) {
    const { role } = await api.query(`query($n: String!) { role(name_Icontains: $n) { edges { node { id name } } } }`, { n: name });
    const node = role.edges.map((e) => e.node).find((n) => n.name.toLowerCase() === name.toLowerCase());
    if (!node) throw new Error(`Role "${name}" not found`);
    ids.push(decodeId(node.id));
  }
  return ids;
}

const villagesOf = (locations, districtAlias) =>
  Object.values(locations).filter((l) => l.type === "V" && locations[l.parent].parent === districtAlias);

// core.User's primary key is a UUID. UserGQLType does not expose a uuid field:
// the Relay global id is "UserGQLType:<uuid>".
const userPk = (relayId) => Buffer.from(relayId, "base64").toString().split(":").slice(1).join(":");

async function ensureUsers(api, locations, facilities) {
  const users = {};
  for (const [role, spec] of Object.entries(USERS)) {
    const find = () => api.first(`query($u: String!) { users(username: $u) { edges { node { id username iUser { id } } } } }`, { u: spec.username });
    const node = await ensure(`user ${spec.username}`, find, async () => {
      const isOfficer = spec.types.includes("OFFICER");
      await api.mutate("createUser", "CreateUserMutationInput", {
        username: spec.username,
        otherNames: spec.otherNames,
        lastName: spec.lastName,
        language: "en",
        userTypes: spec.types,
        ...(spec.types.includes("INTERACTIVE") ? { password: PASSWORD, roles: await roleIds(api, spec.roles) } : {}),
        ...(spec.districts ? { districts: spec.districts.map((d) => locations[d].id) } : {}),
        ...(spec.hf ? { healthFacilityId: facilities[spec.hf].id } : {}),
        ...(isOfficer ? {
          locationId: locations[spec.district].id,
          villageIds: villagesOf(locations, spec.district).map((v) => v.id),
          phone: "+255700000088",
        } : {}),
      });
    });
    const pk = userPk(node.id);
    const user = {
      role, username: node.username, userUuid: pk, userId: pk, iUserId: node.iUser ? decodeId(node.iUser.id) : null,
      otherNames: spec.otherNames, lastName: spec.lastName, fullName: `${spec.otherNames} ${spec.lastName}`,
      password: spec.types.includes("INTERACTIVE") ? PASSWORD : null, district: spec.district ?? spec.districts?.[0] ?? null,
      hf: spec.hf ?? null, roles: spec.roles ?? [],
    };
    if (spec.types.includes("OFFICER")) {
      const officer = await api.one(`query($c: String!) { enrolmentOfficers(code: $c) { edges { node { id uuid } } } }`, { c: spec.username });
      Object.assign(user, { code: spec.username, id: decodeId(officer.id), uuid: officer.uuid });
    }
    if (spec.types.includes("CLAIM_ADMIN")) {
      const admin = await api.one(`query($c: String!) { claimAdmins(code: $c) { edges { node { id uuid } } } }`, { c: spec.username });
      Object.assign(user, { code: spec.username, id: decodeId(admin.id), uuid: admin.uuid });
    }
    users[role] = user;
  }
  return users;
}

// --- products, payer, families --------------------------------------------------

// The product mutation reads all six limitation pairs: 100 % co-insurance everywhere,
// i.e. the item or service is fully covered.
const FULL_COVER = {
  priceOrigin: "PRICELIST",
  ...Object.fromEntries(["", "R", "E"].map((s) => [`limitationType${s}`, "CO_INSURANCE"])),
  ...Object.fromEntries(["Adult", "Child", "AdultR", "ChildR", "AdultE", "ChildE"].map((s) => [`limit${s}`, "100.00"])),
};

async function ensureProducts(api, medical) {
  const products = {};
  for (const [role, spec] of Object.entries(PRODUCTS)) {
    const find = () => api.first(`query($c: String!) { products(code: $c) { edges { node { id uuid code name } } } }`, { c: spec.code });
    const node = await ensure(`product ${spec.code}`, find, () =>
      api.mutate("createProduct", "CreateProductMutationInput", {
        code: spec.code,
        name: spec.name,
        dateFrom: "2020-01-01",
        dateTo: "2099-12-31",
        insurancePeriod: 12,
        maxMembers: 10,
        lumpSum: spec.lumpSum,
        items: medical.items.map((m) => ({ itemUuid: m.uuid, ...FULL_COVER })),
        services: medical.services.map((m) => ({ serviceUuid: m.uuid, ...FULL_COVER })),
      }));
    products[role] = { role, id: decodeId(node.id), uuid: node.uuid, code: node.code, name: node.name, lumpSum: spec.lumpSum, label: `${node.code} ${node.name}` };
  }
  return products;
}

async function ensurePayer(api, locations) {
  const find = async () => {
    const { payers } = await api.query(`query($s: String!) { payers(search: $s) { edges { node { id uuid name } } } }`, { s: PAYER.name });
    return payers.edges.map((e) => e.node).find((n) => n.name === PAYER.name) ?? null;
  };
  const node = await ensure(`payer ${PAYER.name}`, find, () =>
    api.mutate("createPayer", "CreatePayerMutationInput", { name: PAYER.name, type: PAYER.type, locationUuid: locations[PAYER.region].uuid }));
  return { id: decodeId(node.id), uuid: node.uuid, name: node.name, region: PAYER.region };
}

const insureeNode = (api, chfId) =>
  api.first(`query($c: String!) { insurees(chfId: $c) { edges { node { id uuid chfId otherNames lastName family { id uuid } } } } }`, { c: chfId });

// A policy that covers today and the next 60 days, paid in full; a new one is created
// once the previous one is about to expire.
async function ensureActivePolicy(api, family, product, officer) {
  const { policiesByFamily } = await api.query(
    `query($f: String!) { policiesByFamily(familyUuid: $f) { edges { node { policyUuid productCode status startDate expiryDate } } } }`,
    { f: family.uuid },
  );
  const horizon = dayOffset(60);
  const current = policiesByFamily.edges.map((e) => e.node)
    .find((p) => p.productCode === product.code && p.status === 2 && p.startDate <= dayOffset(0) && p.expiryDate >= horizon);
  if (current) return current;
  log(`creating a ${product.code} policy for family ${family.headChfId}`);
  const enrollDate = dayOffset(-40);
  const expiry = new Date(`${enrollDate}T00:00:00Z`);
  expiry.setUTCFullYear(expiry.getUTCFullYear() + 1);
  expiry.setUTCDate(expiry.getUTCDate() - 1);
  await api.mutate("createPolicy", "CreatePolicyMutationInput", {
    enrollDate, startDate: enrollDate, expiryDate: expiry.toISOString().slice(0, 10), value: product.lumpSum,
    productId: product.id, familyId: family.id, officerId: officer.id,
  });
  const after = await api.query(
    `query($f: String!) { policiesByFamily(familyUuid: $f) { edges { node { policyUuid productCode status startDate expiryDate } } } }`,
    { f: family.uuid },
  );
  const created = after.policiesByFamily.edges.map((e) => e.node).find((p) => p.productCode === product.code && p.startDate === enrollDate);
  if (!created) throw new Error(`Policy for family ${family.headChfId} not found after creation`);
  await api.mutate("createPremium", "CreatePremiumMutationInput", {
    policyUuid: created.policyUuid, amount: product.lumpSum, payDate: enrollDate, payType: "C",
    receipt: `BL${family.headChfId.slice(-3)}${Date.now().toString(36).slice(-5).toUpperCase()}`, isPhotoFee: false, action: "ENFORCE",
  });
  return { ...created, status: 2 };
}

async function ensureFamilies(api, locations, users, products) {
  const families = {};
  for (const [role, spec] of Object.entries(FAMILIES)) {
    const village = locations[spec.village];
    await ensure(`family of ${spec.head.chfId}`, () => insureeNode(api, spec.head.chfId), () =>
      api.mutate("createFamily", "CreateFamilyMutationInput", {
        locationId: village.id, poverty: false, headInsuree: { ...spec.head, head: true },
      }));
    const head = await insureeNode(api, spec.head.chfId);
    const family = { id: decodeId(head.family.id), uuid: head.family.uuid, headChfId: head.chfId };
    const members = [];
    for (const m of spec.members ?? []) {
      const node = await ensure(`insuree ${m.chfId}`, () => insureeNode(api, m.chfId), () =>
        api.mutate("createInsuree", "CreateInsureeMutationInput", { ...m, familyId: family.id, head: false }));
      members.push({ id: decodeId(node.id), uuid: node.uuid, chfId: node.chfId, otherNames: node.otherNames, lastName: node.lastName, genderId: m.genderId, dob: m.dob });
    }
    let policy = null;
    if (spec.policy) {
      const product = products[spec.policy];
      const p = await ensureActivePolicy(api, family, product, users[spec.officer]);
      policy = { uuid: p.policyUuid, productCode: product.code, startDate: p.startDate, expiryDate: p.expiryDate };
    }
    families[role] = {
      role, ...family, village: spec.village, officer: spec.officer, policy,
      head: { id: decodeId(head.id), uuid: head.uuid, chfId: head.chfId, otherNames: head.otherNames, lastName: head.lastName, genderId: spec.head.genderId, dob: spec.head.dob },
      members,
    };
  }
  // The latest contribution of the insured family, for the contribution searches.
  const { premiumsByPolicies } = await api.query(
    `query($p: [String]!) { premiumsByPolicies(policyUuids: $p) { edges { node { uuid receipt payDate amount } } } }`,
    { p: [families.insured.policy.uuid] },
  ).catch(() => ({ premiumsByPolicies: { edges: [] } }));
  const premium = premiumsByPolicies.edges.map((e) => e.node).sort((a, b) => (a.payDate < b.payDate ? 1 : -1))[0];
  if (premium) families.insured.policy.premium = premium;
  return families;
}

// --- social protection ----------------------------------------------------------

// The activity model has no mutation: it is created through the Django admin.
async function ensureActivity(admin) {
  const listPath = "/api/admin/social_protection/activity/";
  const exists = async () => {
    const page = await admin.request(`${listPath}?q=${encodeURIComponent(ACTIVITY)}`);
    return page.text.includes(`>${ACTIVITY}<`);
  };
  if (!(await exists())) {
    log(`creating activity ${ACTIVITY}`);
    const page = await admin.request(`${listPath}add/`);
    await admin.request(`${listPath}add/`, { method: "POST", form: { csrfmiddlewaretoken: admin.csrfFrom(page.text), name: ACTIVITY, _save: "Save" } });
    if (!(await exists())) throw new Error(`Cannot create activity ${ACTIVITY}`);
  }
  return { name: ACTIVITY };
}

const uploadsOf = async (api, prefix) => {
  const { individualDataSourceUpload } = await api.query(
    `query($s: String!) { individualDataSourceUpload(sourceName_Istartswith: $s) { edges { node { uuid sourceName status error } } } }`,
    { s: prefix },
  );
  return individualDataSourceUpload.edges.map((e) => e.node);
};

// Uploads cypress/fixtures/individuals.csv once (120 individuals, 20 groups, 20
// individuals in no group), on the baseline villages. The upload runs with the
// individual maker-checker switched off, so no task waits for an approval; the
// module configuration is put back afterwards (the spec run pins it anyway).
async function ensureIndividuals(api, admin, locations) {
  const done = (await uploadsOf(api, INDIVIDUALS_SOURCE)).find((u) => ["SUCCESS", "PARTIAL_SUCCESS"].includes(u.status));
  if (done) return { source: done.sourceName, status: done.status };

  const csv = resolveCsvLocations(fs.readFileSync(INDIVIDUALS_CSV, "utf8"), locations);
  const lines = csv.split("\n");
  const groupIdx = lines[0].split(",").indexOf("group_code");
  const content = [lines[0], ...lines.slice(1).map((line) => {
    const row = line.split(",");
    if (row[groupIdx]) row[groupIdx] = `${INDIVIDUALS_GROUP_PREFIX}${row[groupIdx]}`;
    return row.join(",");
  })].join("\n");

  const rows = await admin.list();
  const saved = rows.filter((r) => r.module === "individual" && r.layer === "be");
  const config = saved.length ? JSON.parse(saved[0].config || "{}") : {};
  const off = Object.fromEntries(Object.keys(config).filter((k) => k.startsWith("enable_maker_checker")).map((k) => [k, false]));
  await admin.apply([{
    module: "individual", layer: "be", config: {
      ...config, ...off, enable_maker_checker_logic_import: false, enable_maker_checker_for_individual_upload: false, enable_maker_checker_for_group_upload: false,
    },
  }]);
  const sourceName = `${INDIVIDUALS_SOURCE}-${Date.now().toString(36)}.csv`;
  log(`uploading individuals (${sourceName})`);
  try {
    await api.upload("individual/import_individuals/", {
      workflow_name: "Python Import Individuals", workflow_group: "individual", group_aggregation_column: "group_code",
    }, { content, type: "text/csv", name: sourceName });
    for (let i = 0; i < 300; i += 1) {
      const upload = (await uploadsOf(api, sourceName))[0];
      if (upload && ["SUCCESS", "PARTIAL_SUCCESS"].includes(upload.status)) return { source: sourceName, status: upload.status };
      if (upload && ["FAIL", "WAITING_FOR_VERIFICATION"].includes(upload.status)) {
        throw new Error(`Individuals upload ended ${upload.status}: ${JSON.stringify(upload.error)}`);
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error("Individuals upload not finished within 5 minutes");
  } finally {
    const now = (await admin.list()).filter((r) => r.module === "individual" && r.layer === "be");
    for (const row of now) await admin.remove(row.id);
    for (const row of saved) await admin.create(row);
  }
}

// --- task groups ----------------------------------------------------------------

// TaskService.create gives a new task to the task group bound to its source, as
// ACCEPTED, and leaves it RECEIVED without a group when no group is bound; a source
// binds to one group at most. The specs test both, so the baseline owns every binding:
// the groups below get exactly their sources, Admin among their executors, and every
// other group loses its sources (a server's own group, such as TG1 on
// release.openimis.org; run-uat.mjs binds them back after the run). Applied before
// every spec, it also undoes a binding a failed spec left behind.
//   any        no source: specs assign tasks to it by hand (uat-tasks binds
//              BenefitPlanService to it while seeding its ACCEPTED task)
//   pc-cycles  PaymentCycleService: payment cycle tasks arrive ACCEPTED
const TASK_GROUPS = [
  { code: "any", taskSources: [] },
  { code: "pc-cycles", taskSources: ["PaymentCycleService"] },
];

const TASK_GROUP_FIELDS = "id uuid code completionPolicy threshold jsonExt taskexecutorSet { edges { node { user { id } } } }";
const relayUuid = (relayId) => Buffer.from(relayId, "base64").toString().split(":")[1];
const sourcesOf = (group) => JSON.parse(group.jsonExt || "{}").task_sources ?? [];
const executorsOf = (group) => group.taskexecutorSet.edges.map((e) => relayUuid(e.node.user.id));

async function listTaskGroups(api) {
  const { taskGroup } = await api.query(`{ taskGroup(isDeleted: false, first: 100) { edges { node { ${TASK_GROUP_FIELDS} } } } }`);
  return taskGroup.edges.map((e) => e.node);
}

// The update replaces the executors and the sources: both are always sent.
const updateTaskGroup = (api, group, taskSources, userIds = executorsOf(group)) =>
  api.mutate("updateTaskGroup", "UpdateTaskGroupMutationInput", {
    id: group.uuid,
    code: group.code,
    completionPolicy: group.completionPolicy,
    threshold: group.threshold ?? undefined,
    userIds,
    taskSources,
  });

// Unbinds every source a group holds beyond `wanted(group)`. Run before any binding.
async function unbindExtraSources(api, wanted) {
  for (const group of await listTaskGroups(api)) {
    const target = wanted(group);
    const extra = sourcesOf(group).filter((s) => !target.includes(s));
    if (!extra.length) continue;
    log(`unbinding ${extra.join(", ")} from task group ${group.code}`);
    await updateTaskGroup(api, group, sourcesOf(group).filter((s) => target.includes(s)));
  }
}

async function ensureTaskGroups(api, credentials) {
  const user = await api.one(`query($u: String) { users(username: $u, first: 1) { edges { node { id } } } }`, { u: credentials.username });
  const adminId = relayUuid(user.id);
  const sourcesFor = new Map(TASK_GROUPS.map((g) => [g.code, g.taskSources]));
  await unbindExtraSources(api, (group) => sourcesFor.get(group.code) ?? []);
  const groups = {};
  for (const { code, taskSources } of TASK_GROUPS) {
    const group = await ensure(
      `task group ${code}`,
      async () => (await listTaskGroups(api)).find((g) => g.code === code),
      () => api.mutate("createTaskGroup", "CreateTaskGroupMutationInput", { code, completionPolicy: "ANY", userIds: [adminId], taskSources }),
    );
    const executors = executorsOf(group);
    if (!executors.includes(adminId) || taskSources.some((s) => !sourcesOf(group).includes(s))) {
      log(`updating task group ${code}: executor ${credentials.username}, sources [${taskSources.join(", ")}]`);
      await updateTaskGroup(api, group, taskSources, [...new Set([...executors, adminId])]);
    }
    groups[code] = { code, uuid: group.uuid, taskSources };
  }
  return groups;
}

// The server's own bindings, saved by run-uat.mjs before the baseline changes them.
export async function backupTaskSources(baseUrl, credentials) {
  const api = await new Api(baseUrl, "UAT baseline").login(credentials);
  return (await listTaskGroups(api)).map((g) => ({ uuid: g.uuid, code: g.code, taskSources: sourcesOf(g) }));
}

export async function restoreTaskSources(baseUrl, credentials, saved) {
  const api = await new Api(baseUrl, "UAT restore").login(credentials);
  const before = new Map(saved.map((g) => [g.uuid, g.taskSources]));
  await unbindExtraSources(api, (group) => before.get(group.uuid) ?? []);
  for (const group of await listTaskGroups(api)) {
    const target = before.get(group.uuid) ?? [];
    if (target.some((s) => !sourcesOf(group).includes(s))) await updateTaskGroup(api, group, target);
  }
}

// --- entry point ----------------------------------------------------------------

export async function ensureBaseline(baseUrl, credentials) {
  const started = Date.now();
  const api = await new Api(baseUrl, "UAT baseline").login(credentials);
  const admin = await connectAdmin(baseUrl, credentials);
  const locations = await ensureLocations(api);
  const medical = await ensureMedical(api);
  const diagnoses = await ensureDiagnoses(api);
  const healthFacilities = await ensureHealthFacilities(api, locations, medical);
  const users = await ensureUsers(api, locations, healthFacilities);
  const products = await ensureProducts(api, medical);
  const payer = await ensurePayer(api, locations);
  const families = await ensureFamilies(api, locations, users, products);
  const activity = await ensureActivity(admin);
  const individuals = await ensureIndividuals(api, admin, locations);
  const taskGroups = await ensureTaskGroups(api, credentials);
  log(`ready in ${Math.round((Date.now() - started) / 1000)} s`);
  return {
    locations, items: medical.items, services: medical.services, diagnoses, healthFacilities, users, products, payer,
    families, activity, individuals, taskGroups,
  };
}

async function cli() {
  const args = process.argv.slice(2);
  const i = args.indexOf("--base-url");
  const baseUrl = i >= 0 ? args[i + 1] : process.env.CYPRESS_BASE_URL ?? "http://localhost:3001";
  const credentials = JSON.parse(fs.readFileSync(path.join(ROOT, "cypress", "fixtures", "cred.json"), "utf8"));
  const r = args.indexOf("--restore-task-sources");
  if (r >= 0) {
    await restoreTaskSources(baseUrl, credentials, JSON.parse(fs.readFileSync(args[r + 1], "utf8")));
    console.log(`Restored task group bindings from ${args[r + 1]}`);
    return;
  }
  const baseline = await ensureBaseline(baseUrl, credentials);
  console.log(JSON.stringify(baseline, null, 1));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  cli().catch((e) => {
    console.error(process.env.DEBUG ? e.stack : e.message);
    process.exit(1);
  });
}
