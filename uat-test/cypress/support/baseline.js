// The UAT baseline as resolved by scripts/baseline.mjs before the spec started
// (support/e2e.js): locations, health facilities, users, medical items and services,
// diagnoses, products, payer, families with an active policy, individuals. Specs take
// codes, names, ids and uuids from here instead of hardcoding demo records, so they
// run on any database. Call it inside hooks and tests, not at the top of a spec file:
// the baseline is only known once the global before() hook has run.
//
//   const B = baseline();
//   cy.chooseLocation(B.locations.r1d2) ...; B.healthFacilities.hospital.code
//
// Location relations (see scripts/baseline.mjs for the whole tree):
//   r1d2 holds the hospital, the health centre and officer r1d2 (families nearHospital);
//   r1d1 holds the insured/uninsured families (village r1d1m1v1) and officer r1d1;
//   r2 is a region with nothing of the above (only otherHospital, in r2d1).
export function baseline() {
  const b = Cypress.env('baseline');
  if (!b) throw new Error('UAT baseline not loaded: support/e2e.js runs the ensureBaseline task before every spec file');
  return b;
}

// A baseline location by alias, e.g. location('r1d2m1v1').
export function location(alias) {
  const loc = baseline().locations[alias];
  if (!loc) throw new Error(`Unknown baseline location ${alias}`);
  return loc;
}

// The region, district, municipality and village names above a baseline location, in
// the shape cy.chooseLocation expects ({ region, district, municipality, village }).
export function locationPath(alias) {
  const keys = { R: 'region', D: 'district', W: 'municipality', V: 'village' };
  const path = {};
  for (let loc = location(alias); loc; loc = loc.parent ? location(loc.parent) : null) path[keys[loc.type]] = loc.name;
  return path;
}
