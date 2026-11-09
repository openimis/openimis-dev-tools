import { getTimestamp } from '../support/utils';
import { baseline } from '../support/baseline';
import { TIMEOUTS } from '../support/constants';

// Programs left behind by an interrupted run keep their code and name; unique values
// per run keep a rerun from colliding with them (codes are at most 8 characters).
const runId = Date.now().toString(36).slice(-5).toUpperCase();
const seedTag = runId.replace(/\d/g, (d) => 'ABCDEFGHIJ'[d]);
// Exactly none selected: a plain '0 active…' text also matches inside '10 active…'.
const NONE_SELECTED = /^\s*0 active beneficiaries selected/;

// Saving an assignment queues a mutation: the response comes before the beneficiaries
// are assigned (core.async_mutations). Polls the backend until the project has them,
// then reloads the page so that its header is read from the saved state.
// A deleted programme is soft-deleted: the backend must no longer list it among
// the live ones. The delete is a queued mutation, hence the short poll.
function expectProgramDeleted(programCode, attempt = 0) {
  return cy.request({
    method: 'POST',
    url: '/api/graphql',
    body: { query: `{ benefitPlan(code: "${programCode}", isDeleted: false) { totalCount } }` },
    log: false,
  }).then(({ body }) => {
    if (body.errors?.length) throw new Error(`benefitPlan: ${JSON.stringify(body.errors)}`);
    const live = body.data.benefitPlan.totalCount;
    if (live === 0) return;
    if (attempt >= 10) throw new Error(`programme ${programCode} is still live after deletion`);
    cy.wait(500, { log: false }).then(() => expectProgramDeleted(programCode, attempt + 1));
  });
}

function waitForProjectBeneficiaries(projectPath, entity, expected, attempt = 0) {
  // The path also carries the program's id (benefitPlan/<id>/project/<id>): take the project's.
  const projectId = projectPath.match(/project\/([0-9a-f-]{36})/i)[1];
  return cy.request({
    method: 'POST',
    url: '/api/graphql',
    body: { query: `{ ${entity}(enrolledInProject: "${projectId}", isDeleted: false) { totalCount } }` },
    log: false,
  }).then(({ body }) => {
    if (body.errors?.length) throw new Error(`${entity}: ${JSON.stringify(body.errors)}`);
    const count = body.data[entity].totalCount;
    if (count === expected) return cy.reload();
    if (attempt >= 30) {
      throw new Error(`project ${projectId} has ${count} ${entity} rows after 60 s, expected ${expected}`);
    }
    return cy.wait(2000, { log: false })
      .then(() => waitForProjectBeneficiaries(projectPath, entity, expected, attempt + 1));
  });
}

// A standalone individual (individual enrollment skips anyone already in a group).
// Called from a hook: location and json come from the baseline, not demo rows.
function seedStandaloneIndividual(villageId, ext) {
  const clientMutationId = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
  const firstName = 'Nora';
  const lastName = `Highchild${seedTag}`;
  const jsonExt = JSON.stringify(JSON.stringify(ext));
  cy.request({
    method: 'POST',
    url: '/api/graphql',
    body: {
      query: `mutation {
        createIndividual(input: {
          clientMutationId: "${clientMutationId}"
          clientMutationLabel: "UAT seed individual ${firstName} ${lastName}"
          firstName: "${firstName}"
          lastName: "${lastName}"
          dob: "1988-04-04"
          locationId: ${villageId}
          jsonExt: ${jsonExt}
        }) { clientMutationId }
      }`,
    },
  }).then((res) => {
    expect(res.status).to.eq(200);
    if (res.body?.errors?.length) throw new Error(`GraphQL error: ${JSON.stringify(res.body.errors)}`);
  });
  cy.waitForMutationLog(clientMutationId).then(({ status, error }) => {
    expect(status, error).to.eq(2);
  });
}

describe('Cash transfer program creation workflows', () => {
  // No baseline records: each test creates and deletes its own program.
  let testProgramNames = [];

  beforeEach(function () {
    cy.login()
  });

  afterEach(() => {
    testProgramNames.forEach(name => {
      cy.deleteProgram(name)
    })
    testProgramNames = []
  })

  it('Creates and deletes an individual program', function () {
    const programCode = `IC${runId}`
    const programName = `E2E Individual Cash Program ${runId}`
    const maxBeneficiaries = "100"
    const programType = "INDIVIDUAL"

    cy.createProgram(programCode, programName, maxBeneficiaries, programType)

    // Ensure the created program gets cleaned up later
    testProgramNames.push(programName);

    // Check program field values are persisted
    cy.reload()
    cy.checkProgramFieldValues(programCode, programName, maxBeneficiaries, programType)

    // Check field values displayed in list view
    cy.visit('/front/benefitPlans');
    cy.checkProgramFieldValuesInListView(programCode, programName, maxBeneficiaries, programType)

    cy.deleteProgram(programName)
    expectProgramDeleted(programCode)
  })

  it('Creates and deletes an household program', function () {
    const programCode = `GC${runId}`
    const programName = `E2E Household Cash Program ${runId}`
    const maxBeneficiaries = "200"
    const programType = "GROUP"

    cy.createProgram(programCode, programName, maxBeneficiaries, programType)

    // Ensure the created program gets cleaned up later
    testProgramNames.push(programName);

    // Check program field values are persisted
    cy.reload()
    cy.checkProgramFieldValues(programCode, programName, maxBeneficiaries, programType)

    // Check field values displayed in list view
    cy.visit('/front/benefitPlans');
    cy.checkProgramFieldValuesInListView(programCode, programName, maxBeneficiaries, programType)

    cy.deleteProgram(programName)
    expectProgramDeleted(programCode)
  })
})

describe('Cash transfer program update workflows', () => {
  const treePlantingActivity = `E2E Tree Planting - ${getTimestamp()}`;
  const riverCleaningActivity = `E2E River Cleaning - ${getTimestamp()}`;
  const activities = [
    treePlantingActivity,
    riverCleaningActivity,
  ];

  before(() => {
    // Activities are created here: a later project update switches from one to the other.
    // Locations further down are baseline nodes, not the demo tree.
    // Disable maker checker
    cy.loginAdminInterface()
    cy.setModuleConfig('social_protection', 'social-protection-config.json')
    cy.setModuleConfig('individual', 'individual-config-minimal.json')
    cy.createActivities(activities)
    cy.logoutAdminInterface()
  })

  describe('Individual program', () => {
    let programCode = `IU${runId}`
    const programName = `E2E Individual Cash Program Updated ${runId}`
    const maxBeneficiaries = "100"
    const programType = "INDIVIDUAL"

    before(() => {
      cy.login()
      cy.createProgram(programCode, programName, maxBeneficiaries, programType)
      cy.logout()
    })

    after(() => {
      cy.deleteProgram(programName)
    })

    beforeEach(function () {
      cy.login()
    })

    it('Updates an individual program', function () {
      const updatedProgramCode = `IX${runId}`
      const updatedMaxBeneficiaries = "111"
      const updatedInstitution = "Social Protection Agency"
      const updatedDescription = "Foo bar baz"

      cy.visit('/front/benefitPlans');
      cy.openProgramForEditFromList(programName)

      cy.assertMuiInput('Code', programCode)
      cy.enterMuiInput('Code', updatedProgramCode)
      cy.assertMuiInput('Code', updatedProgramCode)

      cy.enterMuiInput('Max Beneficiaries', updatedMaxBeneficiaries)

      cy.enterMuiInput('Institution', updatedInstitution)

      cy.enterMuiInput('Description', updatedDescription, 'textarea')

      cy.get(':is([title="Save changes"],[aria-label="Save changes"]) button').click()

      cy.checkProgramUpdateCompleted()

      // Check program field values are persisted
      cy.reload()
      cy.checkProgramFieldValues(
        updatedProgramCode,
        programName,
        updatedMaxBeneficiaries,
        programType,
        updatedInstitution,
        updatedDescription,
      )
      // Update in case other test needs the programCode (as in the household group)
      programCode = updatedProgramCode
    })

    it('configures default enrollment criteria for an individual program and enrolls individuals', function () {
      const criterionField = 'Educated level'
      const criterionFilter = 'Contains'
      const criterionValue = 'prim'

      cy.configureDefaultEnrollmentCriteria(
        programName,
        'Potential',
        criterionField,
        criterionFilter,
        criterionValue,
      )

      cy.enrollIndividualBeneficiariesIntoProgram(
        programName,
        programCode,
        'Potential',
        criterionField,
        criterionFilter,
        criterionValue,
      )
    })

    it('Creates a project under an individual program (OCM-1205)', function () {
      const projectName = `E2E Individual Training Project - ${getTimestamp()}`
      // Region r1 only: coherent with the uploaded individuals (they live in r1). Not assigned here.
      const regionName = baseline().locations.r1.label
      const targetBeneficiaries = "100"
      const workingDays = "60"

      cy.createProject(
        programName, projectName, treePlantingActivity,
        regionName, null, targetBeneficiaries, workingDays,
      )

      // OP-3275: the page must move to the created project once its mutation succeeds,
      // not stay on the "create" URL (a reload would then show an empty form).
      cy.location('pathname', { timeout: 30000 })
        .should('match', /\/project\/[0-9a-f-]{36}$/i)

      cy.reload()

      cy.assertMuiInput('Name', projectName)
      cy.assertMuiInput('Activity', treePlantingActivity)
      cy.assertMuiInput('Location', regionName)
      cy.assertMuiInput('Target Beneficiaries', targetBeneficiaries)
      cy.assertMuiInput('Working Days', workingDays)
    })

    describe('Given a project and an individual program', function () {
      const projectName = `E2E Existing Individual Project - ${getTimestamp()}`
      const targetBeneficiaries = "20"
      const workingDays = "10"
      let projectPath = null
      // District r1d2, coherent with uploaded individuals in villages r1d2m1v1 and r1d2m1v2.
      // The update moves the project to municipality r1d1m2, another district of the same region.
      let districtName = null

      before(() => {
        const { locations } = baseline()
        const regionLabel = locations.r1.label
        const districtLabel = locations.r1d2.label
        districtName = locations.r1d2.name
        cy.login()
        // Uploaded standalone individuals in r1d2 all have fewer than 5 children, so the
        // assign dialog's children filter would not narrow the list. One more, with 8,
        // in village r1d2m1v1 (same district) is the row that filter excludes.
        seedStandaloneIndividual(locations.r1d2m1v1.id, {
          able_bodied: false,
          educated_level: 'none',
          number_of_children: 8,
        })
        cy.createProject(
          programName, projectName, treePlantingActivity,
          regionLabel, districtLabel, targetBeneficiaries, workingDays,
        )
        // the page moves to project/<uuid> only once the saved project is fetched again
        cy.url().should('match', /project\/[0-9a-f-]{36}/).then((currentUrl) => {
          projectPath = new URL(currentUrl).pathname;
        });
        cy.logout()
      })

      it('Enrolls active individuals into a project (OCM-1209)', function () {
        const criterionField = 'Able bodied'
        const criterionFilter = 'Exact'
        const criterionValue = 'False'

        cy.configureDefaultEnrollmentCriteria(
          programName,
          'Active',
          criterionField,
          criterionFilter,
          criterionValue,
        )

        cy.enrollIndividualBeneficiariesIntoProgram(
          programName,
          programCode,
          'Active',
          criterionField,
          criterionFilter,
          criterionValue,
        )

        cy.visit(projectPath)
        cy.contains('h6', '0 Beneficiaries Assigned')
        // The beneficiary table's loading overlay covers the button until its query returns.
        cy.contains('button', 'Assign Beneficiaries').click({ timeout: TIMEOUTS.SERVER_RESULT })
        cy.get('[role="progressbar"]').should('exist')
        cy.get('[role="progressbar"]', { timeout: TIMEOUTS.SERVER_RESULT }).should('not.exist')

        cy.contains('h2', 'Assign Active Beneficiaries')
        cy.contains('h6', NONE_SELECTED)
        cy.get('[role="dialog"] :is([title="Previous Page"],[aria-label="Previous Page"])')
          .next('span')
          .invoke('text')
          .then((text) => {
            // extract 304 from text e.g. 1-10 of 304
            const match = text.match(/of\s+(\d+)/);
            cy.wrap(Number(match[1])).as('numCandidates');
          });

        // filter beneficiaries by number of children
        cy.contains('[role="dialog"] button', '=').trigger('mouseover');
        cy.contains('li', '<').click();
        cy.get('[role="dialog"] input[type="number"]').first().clear({ force: true }).type('5', { force: true });

        cy.get('[role="progressbar"]').should('exist')
        cy.get('[role="progressbar"]', { timeout: TIMEOUTS.SERVER_RESULT }).should('not.exist')

        cy.get('@numCandidates').then((prevTotal) => {
          cy.get('[role="dialog"] :is([title="Previous Page"],[aria-label="Previous Page"])')
            .next('span')
            .invoke('text')
            .then((text) => {
              const match = text.match(/of\s+(\d+)/);
              const total = Number(match[1]);
              expect(prevTotal - total).to.gt(0);
            });
        });

        // assign all matching beneficiaries from the first page
        cy.get('[role="dialog"] th input[type="checkbox"]').first().check({ force: true })
        cy.contains('h6', NONE_SELECTED).should('not.exist')
        cy.get('[role="dialog"] h6')
          .invoke('text')
          .then((text) => {
            // 1 active beneficiaries selected
            const match = text.match(/(\d+) active beneficiaries selected/);
            cy.wrap(match[1]).as('assignedProjectBeneficiaries');
          });

        cy.contains('button', 'Save').click()
        cy.get('[role="progressbar"]').should('exist')
        cy.get('[role="progressbar"]', { timeout: TIMEOUTS.SERVER_RESULT }).should('not.exist')

        cy.get('@assignedProjectBeneficiaries').then((expectedNumAssigned) => {
          waitForProjectBeneficiaries(projectPath, 'beneficiary', Number(expectedNumAssigned))
          cy.contains('h6', `${expectedNumAssigned} Beneficiaries Assigned`)
        })

        // Check that all assigned beneficiaries share the project's district
        cy.get('table').first().within(() => {
          cy.get('th').then(($ths) => {
            const districtIndex = [...$ths].findIndex(
              (th) => th.innerText.trim().includes('District')
            );
            cy.get(`tbody tr td:nth-child(${districtIndex + 1})`)
              .each(($td, i) => {
                // skip the filter row; the cell is the district name, not its code
                if (i>0) expect($td.text().trim()).to.eq(districtName);
              });
          });
        });

        // Assigned beneficiaries can be filtered
        // fixedColumns renders the filter row twice, and the column sits past the table's
        // horizontal scroll: both copies share the filter state, so type in the first.
        cy.get('td input[aria-label="filter data by Educated Level"]')
          .first()
          .scrollIntoView()
          .clear({ force: true })
          .type('Ter', { force: true })
        cy.wait(500) // give the filter results to settle down
        cy.get('@assignedProjectBeneficiaries').then((assignedProjectBeneficiaries) => {
          cy.get(':is([title="Previous Page"],[aria-label="Previous Page"])')
            .next('span')
            .invoke('text')
            .then((text) => {
              const match = text.match(/of\s+(\d+)/);
              const filteredTotal = Number(match[1]);
              expect(assignedProjectBeneficiaries - filteredTotal).to.gt(0);
            });
        });
      })

      it('Updates a project (OCM-1206)', function () {
        cy.visit(projectPath)
        cy.assertMuiInput('Name', projectName)

        const projectNameUpdated = `${projectName} Updated`
        cy.enterMuiInput('Name', projectNameUpdated)

        cy.chooseMuiAutocomplete('Activity', riverCleaningActivity)

        // Same region r1, other district r1d1 (also has uploaded individuals), municipality r1d1m2.
        const { locations } = baseline()
        const regionNameUpdated = locations.r1.label
        const districtNameUpdated = locations.r1d1.label
        const municipalityName = locations.r1d1m2.label
        cy.chooseMuiAutocomplete('Location', regionNameUpdated)
        cy.contains('li', districtNameUpdated).click()
        cy.contains('li', municipalityName).click()

        const targetBeneficiariesUpdated = "20"
        cy.enterMuiInput('Target Beneficiaries', targetBeneficiariesUpdated)

        const workingDaysUpdated = "10"
        cy.enterMuiInput('Working Days', workingDaysUpdated)

        cy.get(':is([title="Save"],[aria-label="Save"]) button').click()

        // Wait for update to complete
        cy.waitForJournalProgress();

        // Check last journal message
        cy.get('ul.MuiList-root li').first().click()
        cy.contains(`Update project ${projectName}`).should('exist')
        cy.contains('Failed to update').should('not.exist')

        cy.visit(projectPath)

        cy.assertMuiInput('Name', projectNameUpdated)
        cy.assertMuiInput('Activity', riverCleaningActivity)
        cy.assertMuiInput('Location', municipalityName)
        cy.assertMuiInput('Target Beneficiaries', targetBeneficiariesUpdated)
        cy.assertMuiInput('Working Days', workingDaysUpdated)
      })

      it('Deletes and restores a project (OCM-1207, OCM-1208)', function () {
        cy.visit(projectPath)
        cy.contains('Beneficiaries Assigned')
        cy.contains('label', 'Name')
          .siblings('.MuiInputBase-root')
          .find('input')
          .invoke('val')
          .then((name) => {
            cy.deleteProject(projectPath);

            cy.contains('button', 'Projects').click()
            cy.contains('label', 'Show Deleted').click()
            cy.contains('button', 'Search').click()

            cy.contains('td', name)
              .parent('tr').within(() => {
                cy.get('button:is([title="Edit"],[aria-label="Edit"])').click({force: true});
              })

            cy.assertMuiInputDisabled('Name', name)
            cy.assertMuiInputDisabled('Activity')
            cy.assertMuiInputDisabled('Location')
            cy.assertMuiInputDisabled('Target Beneficiaries')
            cy.assertMuiInputDisabled('Working Days')
            cy.assertMuiInputDisabled('Status')
            cy.assertMuiInputDisabled('Program')

            cy.get('button:is([title="Undo Delete"],[aria-label="Undo Delete"])').click()
            cy.contains('button', 'Ok').click();

            // Wait for undo to complete
            cy.waitForJournalProgress();

            // Check last journal message
            cy.get('ul.MuiList-root li').first().click()
            cy.contains(`Restore project`).should('exist')
            cy.contains('Failed to restore').should('not.exist')

            cy.reload()

            cy.contains('button', 'Projects').click()
            cy.contains(name).should('exist');
          });
      })
    })
  })

  describe('Household program', () => {
    let programCode = `GU${runId}`
    const programName = `E2E Household Cash Program Updated ${runId}`
    const maxBeneficiaries = "200"
    const programType = "GROUP"

    before(() => {
      cy.login()
      cy.createProgram(programCode, programName, maxBeneficiaries, programType)
      cy.logout()
    })

    after(() => {
      cy.deleteProgram(programName)
    })

    beforeEach(() => {
      cy.login()
    })

    it('Updates a household program', function () {
      const updatedProgramCode = `GX${runId}`
      const updatedMaxBeneficiaries = "222"
      const updatedInstitution = "Family Support Services"
      const updatedDescription = "A functional program"

      cy.visit('/front/benefitPlans');
      cy.openProgramForEditFromList(programName)

      cy.assertMuiInput('Code', programCode)
      cy.enterMuiInput('Code', updatedProgramCode)
      cy.assertMuiInput('Code', updatedProgramCode)

      cy.enterMuiInput('Max Beneficiaries', updatedMaxBeneficiaries)

      cy.enterMuiInput('Institution', updatedInstitution)

      cy.enterMuiInput('Description', updatedDescription, 'textarea')

      cy.get(':is([title="Save changes"],[aria-label="Save changes"]) button').click()

      cy.checkProgramUpdateCompleted()

      // Check program field values are persisted
      cy.reload()
      cy.checkProgramFieldValues(
        updatedProgramCode,
        programName,
        updatedMaxBeneficiaries,
        programType,
        updatedInstitution,
        updatedDescription,
      )

      // Update in case other test needs the programCode
      programCode = updatedProgramCode
    })

    it('configures default enrollment criteria for a household program and enrolls households', function () {
      const criterionField = 'Number of children'
      const criterionFilter = 'Greater than or equal to'
      const criterionValue = '2'

      cy.configureDefaultEnrollmentCriteria(
        programName,
        'Active',
        criterionField,
        criterionFilter,
        criterionValue,
      )

      cy.enrollGroupBeneficiariesIntoProgram(
        programName,
        programCode,
        'Active',
        criterionField,
        criterionFilter,
        criterionValue,
      )
    })

    it('Creates a project under a household program', function () {
      const projectName = `E2E Public Works Project - ${getTimestamp()}`
      // Region r2 / district r2d1: a different region from the uploaded individuals (incoherent). Not assigned here.
      const { locations } = baseline()
      const regionName = locations.r2.label
      const districtName = locations.r2d1.label
      const targetBeneficiaries = "50"
      const workingDays = "20"

      cy.createProject(
        programName, projectName, treePlantingActivity,
        regionName, districtName, targetBeneficiaries, workingDays,
      )

      // OP-3275: the page must move to the created project once its mutation succeeds,
      // not stay on the "create" URL (a reload would then show an empty form).
      cy.location('pathname', { timeout: 30000 })
        .should('match', /\/project\/[0-9a-f-]{36}$/i)

      cy.reload()

      cy.assertMuiInput('Name', projectName)
      cy.assertMuiInput('Activity', treePlantingActivity)
      cy.assertMuiInput('Location', districtName)
      cy.assertMuiInput('Target Beneficiaries', targetBeneficiaries)
      cy.assertMuiInput('Working Days', workingDays)
    })

    describe('Given a project and a household program', function () {
      const projectName = `E2E Existing Group Project - ${getTimestamp()}`
      const targetBeneficiaries = "20"
      const workingDays = "10"
      let projectPath = null
      // Project at region r1 only, coherent with uploaded groups in districts r1d1 and r1d2.
      // Assignment is then narrowed to r1d1; groups in r1d2 make that filter reduce the list.
      // The update moves the project to municipality r1d1m2, still in region r1.
      let regionLabel = null

      before(() => {
        regionLabel = baseline().locations.r1.label
        cy.login()
        cy.createProject(
          programName, projectName, treePlantingActivity,
          regionLabel, null, targetBeneficiaries, workingDays,
        )
        // the page moves to project/<uuid> only once the saved project is fetched again
        cy.url().should('match', /project\/[0-9a-f-]{36}/).then((currentUrl) => {
          projectPath = new URL(currentUrl).pathname;
        });
        cy.logout()
      })

      it('Enrolls active households into a project', function () {
        const criterionField = 'Number of children'
        const criterionFilter = 'Less than'
        const criterionValue = '6'

        cy.configureDefaultEnrollmentCriteria(
          programName,
          'Active',
          criterionField,
          criterionFilter,
          criterionValue,
        )

        cy.enrollGroupBeneficiariesIntoProgram(
          programName,
          programCode,
          'Active',
          criterionField,
          criterionFilter,
          criterionValue,
        )

        // District name (not the picker label). Do not read it off the first row:
        // row order is not a baseline record. r1d1 has uploaded groups; r1d2 has others.
        cy.wrap(baseline().locations.r1d1.name).as('activeDistrict')

        cy.visit(projectPath)
        cy.contains('h6', '0 Beneficiaries Assigned')
        // The beneficiary table's loading overlay covers the button until its query returns.
        cy.contains('button', 'Assign Beneficiaries').click({ timeout: TIMEOUTS.SERVER_RESULT })
        cy.get('[role="progressbar"]').should('exist')
        cy.get('[role="progressbar"]', { timeout: TIMEOUTS.SERVER_RESULT }).should('not.exist')

        cy.contains('h2', 'Assign Active Beneficiaries')
        cy.contains('h6', NONE_SELECTED)
        cy.get('[role="dialog"] :is([title="Previous Page"],[aria-label="Previous Page"])')
          .next('span')
          .invoke('text')
          .then((text) => {
            // extract 304 from text e.g. 1-10 of 304
            const match = text.match(/of\s+(\d+)/);
            cy.wrap(Number(match[1])).as('numCandidates');
          });

        // filter beneficiaries by district
        cy.get('@activeDistrict').then((district) => {
          // The pinned left columns render a second, clipped copy of the table, and
          // District sits outside the visible part of both: force the input.
          cy.get('[role="dialog"] input[aria-label="filter data by District"]')
            .first()
            .scrollIntoView()
            .clear({ force: true })
            .type(district, { force: true })
          cy.get('[role="progressbar"]').should('exist')
          cy.get('[role="progressbar"]', { timeout: TIMEOUTS.SERVER_RESULT }).should('not.exist')
        });

        cy.get('@numCandidates').then((prevTotal) => {
          cy.get('[role="dialog"] :is([title="Previous Page"],[aria-label="Previous Page"])')
            .next('span')
            .invoke('text')
            .then((text) => {
              const match = text.match(/of\s+(\d+)/);
              const total = Number(match[1]);
              expect(prevTotal - total).to.gt(0);
            });
        });

        // assign all matching beneficiaries from the first page
        cy.get('[role="dialog"] th input[type="checkbox"]').first().check({ force: true })
        cy.contains('h6', NONE_SELECTED, { timeout: TIMEOUTS.SERVER_RESULT }).should('not.exist')
        cy.get('[role="dialog"] h6')
          .invoke('text')
          .then((text) => {
            // 1 active beneficiaries selected
            const match = text.match(/(\d+) active beneficiaries selected/);
            cy.wrap(match[1]).as('assignedProjectBeneficiaries');
          });

        cy.contains('button', 'Save').click()
        cy.get('[role="progressbar"]').should('exist')
        cy.get('[role="progressbar"]', { timeout: TIMEOUTS.SERVER_RESULT }).should('not.exist')

        cy.get('@assignedProjectBeneficiaries').then((expectedNumAssigned) => {
          waitForProjectBeneficiaries(projectPath, 'groupBeneficiary', Number(expectedNumAssigned))
          cy.contains('h6', `${expectedNumAssigned} Beneficiaries Assigned`)
        })

        // Check that all assigned beneficiaries share the same district
        cy.get('table').first().within(() => {
          cy.get('th').then(($ths) => {
            const districtIndex = [...$ths].findIndex(
              (th) => th.innerText.trim().includes('District')
            );
            cy.get('@activeDistrict').then((activeDistrict) => {
              cy.get(`tbody tr td:nth-child(${districtIndex + 1})`)
                .each(($td, i) => {
                  // skip the filter row
                  if (i>0) expect($td.text().trim()).to.eq(activeDistrict);
                });
            });
          });
        });
      })

      it('Updates a project', function () {
        cy.visit(projectPath)
        cy.assertMuiInput('Name', projectName)

        const projectNameUpdated = `${projectName} Updated`
        cy.enterMuiInput('Name', projectNameUpdated)

        cy.chooseMuiAutocomplete('Activity', riverCleaningActivity)

        // Same region r1, district r1d1, municipality r1d1m2 (coherent with groups uploaded there).
        const { locations } = baseline()
        const regionNameUpdated = locations.r1.label
        const districtNameUpdated = locations.r1d1.label
        const municipalityName = locations.r1d1m2.label
        cy.chooseMuiAutocomplete('Location', regionNameUpdated)
        cy.contains('li', districtNameUpdated).click()
        cy.contains('li', municipalityName).click()

        const targetBeneficiariesUpdated = "20"
        cy.enterMuiInput('Target Beneficiaries', targetBeneficiariesUpdated)

        const workingDaysUpdated = "10"
        cy.enterMuiInput('Working Days', workingDaysUpdated)

        cy.get(':is([title="Save"],[aria-label="Save"]) button').click()

        // Wait for update to complete
        cy.waitForJournalProgress();

        // Check last journal message
        cy.get('ul.MuiList-root li').first().click()
        cy.contains(`Update project ${projectName}`).should('exist')
        cy.contains('Failed to update').should('not.exist')

        cy.visit(projectPath)

        cy.assertMuiInput('Name', projectNameUpdated)
        cy.assertMuiInput('Activity', riverCleaningActivity)
        cy.assertMuiInput('Location', municipalityName)
        cy.assertMuiInput('Target Beneficiaries', targetBeneficiariesUpdated)
        cy.assertMuiInput('Working Days', workingDaysUpdated)
      })

      it('Deletes and restores a project', function () {
        cy.visit(projectPath)
        cy.contains('Beneficiaries Assigned')
        cy.contains('label', 'Name')
          .siblings('.MuiInputBase-root')
          .find('input')
          .invoke('val')
          .then((name) => {
            cy.deleteProject(projectPath);

            cy.contains('button', 'Projects').click()
            cy.contains('label', 'Show Deleted').click()
            cy.contains('button', 'Search').click()

            cy.contains('td', name)
              .parent('tr').within(() => {
                cy.get('button:is([title="Edit"],[aria-label="Edit"])').click({force: true});
              })

            cy.assertMuiInputDisabled('Name', name)
            cy.assertMuiInputDisabled('Activity')
            cy.assertMuiInputDisabled('Location')
            cy.assertMuiInputDisabled('Target Beneficiaries')
            cy.assertMuiInputDisabled('Working Days')
            cy.assertMuiInputDisabled('Status')
            cy.assertMuiInputDisabled('Program')

            cy.get('button:is([title="Undo Delete"],[aria-label="Undo Delete"])').click()
            cy.contains('button', 'Ok').click();

            // Wait for undo to complete
            cy.waitForJournalProgress();

            // Check last journal message
            cy.get('ul.MuiList-root li').first().click()
            cy.contains(`Restore project`).should('exist')
            cy.contains('Failed to restore').should('not.exist')

            cy.reload()

            cy.contains('button', 'Projects').click()
            cy.contains(name).should('exist');
          });
      })
    })
  })
})

describe('Individuals and groups/households', () => {
  // Re-uploads the individuals fixture (ensureBaseline already placed it on baseline
  // villages) and asserts the count delta. No demo locations.
  before(() => {
    // Disable maker checker
    cy.loginAdminInterface()
    cy.setModuleConfig('individual', 'individual-config-minimal.json')
    cy.logoutAdminInterface()
  })

  it('Imports individuals and groups (OCM-1128)', function () {
    cy.login()
    cy.visit('/front/groups')
    cy.getItemCount('Group').as('initialGroupCount');

    cy.visit('/front/individuals')
    cy.getItemCount('Individual').as('initialIndividualCount');

    cy.uploadIndividualsCSV()

    // Expected counts come from the file actually uploaded: the fixture has changed
    // size before (100 -> 120 individuals).
    cy.readFile('cypress/fixtures/tmp_individuals.csv').then((csv) => {
      const [header, ...rows] = csv.trim().split(/\r?\n/);
      const groupIdx = header.split(',').indexOf('group_code');
      const groups = new Set(rows.map((r) => r.split(',')[groupIdx]).filter(Boolean));
      cy.wrap(rows.length).as('uploadedIndividuals');
      cy.wrap(groups.size).as('uploadedGroups');
    });

    cy.visit('/front/individuals')
    cy.getItemCount("Individual").then(newCount => {
      cy.get('@initialIndividualCount').then(initial => {
        cy.get('@uploadedIndividuals').then((uploaded) => expect(newCount - initial).to.eq(uploaded));
      });
    });

    cy.wait(10000) // group creation takes time

    cy.visit('/front/groups')
    cy.getItemCount("Group").then(newCount => {
      cy.get('@initialGroupCount').then(initial => {
        cy.get('@uploadedGroups').then((uploaded) => expect(newCount - initial).to.eq(uploaded));
      });
    });
  })
})
