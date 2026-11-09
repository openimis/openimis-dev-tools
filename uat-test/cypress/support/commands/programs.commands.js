import { getTodayFormatted } from '../helpers/date';
import { TIMEOUTS } from '../constants';
import { approvePendingTasksOf } from '../tasks-api';

// gql, mutateOk and the checker step are shared with other commands (payroll cleanup).

export function registerProgramCommands() {
  Cypress.Commands.add('deleteProject', (projectPath) => {
    cy.visit(projectPath);
    cy.get('button:is([title="Delete"],[aria-label="Delete"])').click();
    cy.contains('button', 'Ok').click();

    // Check redirect
    cy.location('pathname').should('not.include', projectPath);

    // Check last journal message
    cy.get('ul.MuiList-root li').first().click();
    cy.contains('Delete project').should('exist');
    cy.contains('Failed to delete').should('not.exist');
    // The click opens the entry's popover; its invisible backdrop would cover the page.
    const popoverBackdrop = '.MuiModal-backdrop.MuiBackdrop-invisible';
    cy.get('body').then(($body) => {
      const $backdrop = $body.find(popoverBackdrop);
      if ($backdrop.length) cy.wrap($backdrop.last()).click({ force: true });
    });
    cy.get(popoverBackdrop).should('not.exist');
  });

  Cypress.Commands.add('createProject', (
    programName,
    projectName,
    activityName,
    regionName,
    districtName,
    targetBeneficiaries,
    workingDays,
  ) => {
    cy.visit('/front/benefitPlans');
    cy.openProgramForEditFromList(programName);
    cy.contains('button', 'Projects').click();
    cy.contains('button', 'Create Project').click();
    cy.contains('h6', 'Project details');

    cy.enterMuiInput('Name', projectName);

    cy.chooseMuiAutocomplete('Activity', activityName);

    cy.chooseMuiAutocomplete('Location', regionName);
    if (districtName) {
      cy.contains('li', districtName).click();
    }

    cy.enterMuiInput('Target Beneficiaries', targetBeneficiaries);

    cy.enterMuiInput('Working Days', workingDays);

    // Allow same beneficiary in multiple projects (avoids conflicts across E2E runs).
    // The project form of this assembly does not show the option (the API accepts
    // allowsMultipleEnrollments, no component renders it): set it only where shown.
    const multiple = 'Allow beneficiaries to enroll in multiple projects';
    cy.get('body').then(($body) => {
      if ($body.find('label').filter((_, l) => l.textContent.includes(multiple)).length) {
        cy.chooseMuiSelect(multiple, 'Yes');
      } else {
        cy.log(`"${multiple}" not in the form; skipped`);
      }
    });

    cy.saveAndAwaitJournal({
      saveTitle: 'Save',
      mutationLabel: `Create project ${projectName}`,
      assertNoFail: true,
    });
  });

  // Filters the program list by name: programs left by earlier runs push new ones
  // off the first page. Yields the filtered query's totalCount.
  Cypress.Commands.add('searchProgramByName', (programName) => {
    cy.waitForSearcherLoaded({ timeout: TIMEOUTS.BACKEND_VALIDATION });
    // Only a query filtered on this name: an unfiltered one (the list sorted by code,
    // 10 a page) answers too early and may not hold the program.
    cy.aliasGraphqlQuery(`name_Icontains: "${programName}"`, 'programSearch');
    cy.enterMuiInput('Name', programName);
    cy.contains('button', 'Search').click();
    return cy.wait('@programSearch', { timeout: TIMEOUTS.SERVER_RESULT })
      .its('response.body.data.benefitPlan.totalCount');
  });

  Cypress.Commands.add('deleteProgram', (programName) => {
    // Decided from a direct count of the live programs, not from the list: the title reads
    // "0 Programs" while a search is in flight, and an intercepted search response may be
    // an earlier one (the list refetches after a delete), still counting a deleted program.
    cy.request({
      method: 'POST',
      url: '/api/graphql',
      body: { query: `{ benefitPlan(name: ${JSON.stringify(programName)}, isDeleted: false) { totalCount } }` },
      log: false,
    }).then(({ body }) => {
      if (body.errors?.length) throw new Error(`benefitPlan: ${JSON.stringify(body.errors)}`);
      if (body.data.benefitPlan.totalCount === 0) {
        Cypress.log({ name: 'deleteProgram', message: `No live program named "${programName}", nothing to delete.` });
        return;
      }
      cy.visit('/front/benefitPlans');
      cy.searchProgramByName(programName);
      cy.contains('td', programName, { timeout: TIMEOUTS.SERVER_RESULT });
      deleteListedPrograms(programName);
    });
  });

  const deleteListedPrograms = (programName) => {
    cy.get('body').then(($body) => {
      const programRows = $body.find(`td:contains("${programName}")`).closest('tr');

      if (programRows.length > 0) {
        cy.log(`Found ${programRows.length} program(s) to delete`);

        programRows.each((_, row) => {
          cy.wrap(row).within(() => {
            // Find and click the Delete button in this row
            cy.get('button:is([title="Delete"],[aria-label="Delete"])')
              .click({ force: true });
          });

          // Confirm deletion in dialog
          cy.contains('button', 'Ok')
            .should('be.visible')
            .click();

          // Wait for deletion to complete
          cy.waitForJournalProgress();

          // Verify deletion in expanded journal drawer
          cy.get('.MuiDrawer-paperAnchorRight button')
            .first()
            .click();

          cy.get('ul.MuiList-root li')
            .first()
            .should('contain', 'Delete program');
          // .should('contain', `Delete program ${programName}`); //TODO: switch to this after fix

          // Close journal drawer
          cy.get('.MuiDrawer-paperAnchorRight button')
            .first()
            .click();
        });
      } else {
        Cypress.log({
          name: 'deleteProgram',
          message: `No programs found with name "${programName}"`,
        });
      }
    });
  };

  Cypress.Commands.add('createProgram', (programCode, programName, maxBeneficiaries, programType, schema) => {
    cy.visit('/front/benefitPlans');
    // Slow to load after a Django admin round-trip (the app starts from scratch).
    cy.get(':is([title="Create"],[aria-label="Create"]) button', { timeout: TIMEOUTS.APP_LOAD }).click();

    cy.enterMuiInput('Code', programCode);

    cy.enterMuiInput('Name', programName);

    cy.pickTodayInDatePicker('Date from');
    cy.pickTodayInDatePicker('Date to');

    cy.enterMuiInput('Max Beneficiaries', maxBeneficiaries);

    cy.contains('label', 'Type')
      .parent()
      .click();
    cy.contains('li[role="option"]', programType)
      .click();

    if (schema) {
      const schemaStr = typeof schema === 'string' ? schema : JSON.stringify(schema);
      // MUI multiline TextField renders a visible textarea + a hidden shadow textarea.
      // Target the visible one (without aria-hidden) inside the Schema field.
      cy.contains('label', 'Schema')
        .siblings('.MuiInputBase-root')
        .find('textarea:not([aria-hidden="true"])')
        .clear({ force: true })
        .type(schemaStr, { parseSpecialCharSequences: false, delay: 0, force: true });
      cy.contains('label', 'Schema')
        .siblings('.MuiInputBase-root')
        .find('.MuiInputAdornment-root svg', { timeout: TIMEOUTS.BACKEND_VALIDATION })
        .should('exist');
      cy.contains('label', 'Schema')
        .siblings('.MuiInputBase-root')
        .find('.MuiInputAdornment-root', { timeout: TIMEOUTS.BACKEND_VALIDATION })
        // Validated inputs show a spinner while checking, then a check (valid) or
        // error icon: an MUI SVG (ValidatedTextInput) or a Material Symbols span
        // (ValidatedTextAreaInput via GetIconComponent). No class name marks the state.
        .should(($adornment) => {
          const symbol = (name) => $adornment.find('[class*="material-symbols-"]').filter((_, el) => el.textContent.trim() === name).length;
          expect($adornment.find('[role="progressbar"]'), 'validation finished').to.have.length(0);
          expect($adornment.find('[data-testid="ErrorOutlineOutlinedIcon"]').length + symbol('error'), 'no validation error').to.eq(0);
          expect($adornment.find('[data-testid="CheckOutlinedIcon"]').length + symbol('check'), 'valid icon').to.eq(1);
        });
    }

    cy.saveAndAwaitJournal({
      saveTitle: 'Save changes',
      mutationLabel: 'Create program',
      assertNoFail: true,
    });
    // The page moves to benefitPlan/<uuid> only once the saved program is fetched
    // again; a reload before that opens an empty create form.
    cy.url({ timeout: TIMEOUTS.SERVER_RESULT }).should('match', /benefitPlan\/[0-9a-f-]{36}/);
  });

  Cypress.Commands.add('openProgramForEditFromList', (programName) => {
    cy.searchProgramByName(programName);
    cy.contains('td', programName, { timeout: TIMEOUTS.BACKEND_VALIDATION })
      .parent('tr').within(() => {
        // click on edit button
        cy.get('a.MuiIconButton-root').click();
      });
    cy.assertMuiInput('Name', programName);
  });

  // A program update goes through maker-checker on release (social_protection
  // gql_check_benefit_plan_update): the save only creates a BenefitPlanService task,
  // and while that task is open every further update of the program is refused
  // ("Another task is pending"). The checker's approval is given here through the
  // API, so the update is applied before the spec reads it back.
  // { approve: false } leaves the task open, for a spec that approves it itself (OCM-1169).
  Cypress.Commands.add('checkProgramUpdateCompleted', ({ approve = true } = {}) => {
    cy.waitForJournalProgress();
    cy.assertJournalFirstEntryContains('Update program');
    cy.assertJournalNoFail('Failed to');
    if (!approve) return;
    cy.location('pathname').then((path) => {
      const programUuid = path.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0];
      if (programUuid) approvePendingTasksOf(programUuid);
    });
  });

  Cypress.Commands.add(
    'checkProgramFieldValues',
    (
      programCode,
      programName,
      maxBeneficiaries,
      programType,
      institution = '',
      description = '',
    ) => {
      cy.assertMuiInput('Code', programCode);
      cy.assertMuiInput('Name', programName);
      const today = getTodayFormatted();
      cy.assertMuiDatePickerValue('Date from', today);
      cy.assertMuiDatePickerValue('Date to', today);
      cy.assertMuiInput('Max Beneficiaries', maxBeneficiaries);
      cy.assertMuiInput('Institution', institution);
      cy.assertMuiInput('Description', description, 'textarea');
    },
  );

  Cypress.Commands.add(
    'checkProgramFieldValuesInListView',
    (programCode, programName, maxBeneficiaries, programType) => {
      cy.searchProgramByName(programName);
      cy.contains('td', programName).should('exist');
      cy.contains('td', programName)
        .parent('tr').within(() => {
          cy.contains('td', programCode);
          cy.contains('td', programType);
          cy.contains('td', maxBeneficiaries);
          cy.contains('td', new Date().toISOString().substring(0, 10));
        });
    },
  );

  Cypress.Commands.add('configureDefaultEnrollmentCriteria', (
    programName, status, criterionField, criterionFilter, criterionValue,
  ) => {
    cy.visit('/front/benefitPlans');
    cy.openProgramForEditFromList(programName);

    cy.contains('button', 'Beneficiaries').click();
    cy.contains('button', status).click();

    cy.contains(`${status} Beneficiary Enrollment Criteria`);
    // Add a row only when there is none: the selects below fill the first row, so
    // on a second call a new row stayed empty and was saved as "____=", a filter
    // that matches nothing.
    cy.get('body').then(($body) => {
      const hasRow = $body.find('label').toArray().some((l) => l.textContent.trim().replace(/\s*\*$/, '') === 'Field');
      if (!hasRow) cy.contains('button', 'Add Filters').click();
    });

    cy.chooseMuiSelect('Field', criterionField);
    cy.chooseMuiSelect('Confirm Filters', criterionFilter);

    const isValueSelect = /^(True|False)$/.test(criterionValue);
    isValueSelect
      ? cy.chooseMuiSelect('Value', criterionValue)
      : cy.enterMuiInput('Value', criterionValue);

    cy.get(':is([title="Save changes"],[aria-label="Save changes"]) button').click();

    cy.checkProgramUpdateCompleted();
    cy.reload();

    cy.contains('button', 'Beneficiaries').click();
    cy.contains('button', status).click();

    cy.assertMuiSelectValue('Field', criterionField);
    cy.assertMuiSelectValue('Confirm Filters', criterionFilter);
    isValueSelect
      ? cy.assertMuiSelectValue('Value', criterionValue)
      : cy.assertMuiInput('Value', criterionValue);
  });

  // Custom filter string (field__filter__type=value, as built by fe-individual's
  // AdvancedCriteriaForm) for the criterion picked by label in the enrollment form.
  const FILTER_LOOKUPS = {
    Exact: 'exact',
    'Less than': 'lt',
    'Less than or equal to': 'lte',
    'Greater than': 'gt',
    'Greater than or equal to': 'gte',
    Contains: 'icontains',
    'Starts with': 'istartswith',
  };
  const enrollmentCustomFilter = (criterionField, criterionFilter, criterionValue) => {
    const lookup = FILTER_LOOKUPS[criterionFilter];
    if (!lookup) throw new Error(`No filter lookup for "${criterionFilter}"`);
    const field = criterionField.trim().toLowerCase().replace(/\s+/g, '_');
    let type = 'string';
    if (/^(True|False)$/.test(criterionValue)) type = 'boolean';
    else if (/^-?\d+$/.test(criterionValue)) type = 'integer';
    return `${field}__${lookup}__${type}=${criterionValue}`;
  };

  Cypress.Commands.add('enrollBeneficiariesIntoProgram', (
    programName,
    programCode,
    status,
    criterionField,
    criterionFilter,
    criterionValue,
    entityName,
  ) => {
    // By its unique code: the picker's search ORs the words of a name, and a long
    // E2E name matches more programmes than the 100 the list returns.
    cy.chooseMuiAutocomplete('Program', programCode);
    cy.chooseMuiSelect('Status', status.toUpperCase());

    cy.assertMuiSelectValue('Field', criterionField);
    cy.assertMuiSelectValue('Confirm Filters', criterionFilter);
    /^(True|False)$/.test(criterionValue)
      ? cy.assertMuiSelectValue('Value', criterionValue)
      : cy.assertMuiInput('Value', criterionValue);

    cy.contains('button', 'Preview Enrollment Process').click();

    // The preview must show the backend's own count for the same criterion. The
    // text is retried until it does: read once, it raced the preview query.
    // Enrollment skips whoever is already in the programme (in any status), so the
    // number enrolled is the summary's "to upload" for this programme, not "selected".
    const [summary, selected, toUpload] = entityName === 'Groups'
      ? ['groupEnrollmentSummary', 'numberOfSelectedGroups', 'numberOfGroupsToUpload']
      : ['individualEnrollmentSummary', 'numberOfSelectedIndividuals', 'numberOfIndividualsToUpload'];
    const customFilter = enrollmentCustomFilter(criterionField, criterionFilter, criterionValue);
    const gqlData = (query) => cy.request({ method: 'POST', url: '/api/graphql', body: { query }, log: false })
      .then(({ body }) => {
        if (body.errors?.length) throw new Error(`GraphQL: ${JSON.stringify(body.errors)}`);
        return body.data;
      });
    gqlData(`{ benefitPlan(code: "${programCode}", isDeleted: false) { edges { node { id } } } }`)
      .then((data) => {
        const node = data.benefitPlan.edges[0]?.node;
        if (!node) throw new Error(`No programme ${programCode}`);
        const benefitPlanId = atob(node.id).split(':')[1];
        const members = entityName === 'Groups' ? 'groupBeneficiary' : 'beneficiary';
        return gqlData(`{ ${summary}(customFilters: [${JSON.stringify(customFilter)}], benefitPlanId: "${benefitPlanId}") {
          ${selected} ${toUpload} }
          inStatus: ${members}(benefitPlan_Id: "${benefitPlanId}", status: ${status.toUpperCase()}, isDeleted: false) {
          totalCount } }`);
      })
      .then((data) => {
        const expected = Number(data[summary][selected]);
        const enrolled = Number(data[summary][toUpload]);
        const alreadyInStatus = Number(data.inStatus.totalCount);
        expect(expected, `${entityName.toLowerCase()} matching ${customFilter} in the database`)
          .to.be.greaterThan(0);
        expect(enrolled, `${entityName.toLowerCase()} to enrol, not yet in ${programCode}`).to.be.greaterThan(0);
        cy.contains('h6', `Number Of Selected ${entityName}`)
          .next('p')
          .should(($p) => {
            expect(Number($p.text().trim()), `previewed ${entityName.toLowerCase()}`).to.eq(expected);
          });
        // The status tab lists whoever was already in that status, plus the new ones.
        cy.wrap(alreadyInStatus + enrolled).as('numEnrolled');
      });

    cy.contains('button', 'Confirm Enrollment Process').click();

    // confirmation dialog
    cy.contains('h2', 'Confirm Enrollment Process');
    cy.contains('button', 'Ok').click();

    // The enrollment page doesn't trigger journal update correctly
    // so we'd have to reload the page here
    cy.reload();

    // Verify enrollment in expanded journal drawer
    cy.get('.MuiDrawer-paperAnchorRight button')
      .first()
      .click();

    cy.get('ul.MuiList-root li')
      .first()
      .should('contain', 'Enrollment has been confirmed');

    // maker-checker approves enrollment
    cy.ensurePermissiveTaskGroup();
    cy.visit('/front/AllTasks');
    cy.waitForSearcherLoaded();

    cy.aliasGraphqlQuery('task(id:', 'importTaskDetail');

    cy.get('tr')
      .filter((_, tr) => (
        Cypress.$(tr).find('td:contains("import_valid_items")').length > 0
        && Cypress.$(tr).find('td:contains("RECEIVED")').length > 0
      ))
      .first()
      .within(() => {
        cy.get('td')
          .contains(new RegExp(`^${programCode}\\b`))
          .should('exist');

        cy.get('button:is([title="View details"],[aria-label="View details"])').click();
      });

    cy.url({ timeout: TIMEOUTS.BACKEND_VALIDATION }).should('include', '/tasks/task/');
    cy.awaitSearcherRefresh('importTaskDetail');
    cy.contains('Import Valid Items Task', { timeout: TIMEOUTS.BACKEND_VALIDATION });
    // The task group field (formerly "Task Group"); options read "Group · any — ANY".
    cy.chooseMuiAutocomplete('Assigned to', '· any —');
    cy.get(':is([title="Save changes"],[aria-label="Save changes"]) button').click();

    cy.contains('div', 'Accept All')
      .find('button')
      .click();

    cy.contains('Beneficiary Upload Confirmation');
    cy.contains('button', 'Continue').click();
    cy.contains('div', 'Accept All')
      .find('button').should('be.disabled');

    // The task is resolved asynchronously: reload the task list until it is COMPLETED.
    const waitForImportCompleted = (attempt = 1) => {
      cy.visit('/front/AllTasks');
      cy.waitForSearcherLoaded();
      cy.get('body').then(($body) => {
        const done = $body.find('tr').filter((_, tr) => (
          Cypress.$(tr).find('td:contains("import_valid_items")').length > 0
          && Cypress.$(tr).find(`td:contains("${programCode}")`).length > 0
          && Cypress.$(tr).find('td:contains("COMPLETED")').length > 0
        )).length > 0;
        if (done) return;
        if (attempt >= 20) throw new Error(`import_valid_items task of ${programCode} not COMPLETED after ${attempt} reloads`);
        cy.wait(3000);
        waitForImportCompleted(attempt + 1);
      });
    };
    waitForImportCompleted();

    cy.visit('/front/benefitPlans');
    cy.openProgramForEditFromList(programName);
    cy.contains('button', 'Beneficiaries').click();
    cy.contains('button', status).click();
    // The beneficiary searcher may not auto-execute — click Search to load
    // results.  Alias the round-trip so the post-click count assertion
    // observes the REFRESHED title rather than the pre-search 0-count.
    const beneAlias = entityName === 'Groups' ? 'groupBeneficiary(' : 'beneficiary(';
    cy.aliasGraphqlQuery(beneAlias, 'beneficiarySearch');
    cy.contains('button', 'Search', { timeout: TIMEOUTS.BACKEND_VALIDATION }).click();
    cy.awaitSearcherRefresh('beneficiarySearch');

    cy.get('@numEnrolled').then((count) => {
      if (entityName === 'Groups') {
        cy.contains(`${count} Group Beneficiaries`, { timeout: 30000 });
      } else {
        cy.contains(`${count} Beneficiaries`, { timeout: 30000 });
      }
    });
  });

  Cypress.Commands.add('enrollIndividualBeneficiariesIntoProgram', (
    programName,
    programCode,
    status,
    criterionField,
    criterionFilter,
    criterionValue,
  ) => {
    cy.ensureSufficientIndividuals(120);

    cy.visit('/front/individuals/enrollment'); // the list's ENROLLMENT button opens this route

    cy.enrollBeneficiariesIntoProgram(
      programName, programCode, status,
      criterionField, criterionFilter, criterionValue, 'Individuals',
    );
  });

  Cypress.Commands.add('enrollGroupBeneficiariesIntoProgram', (
    programName,
    programCode,
    status,
    criterionField,
    criterionFilter,
    criterionValue,
  ) => {
    cy.ensureSufficientHouseholds(20);

    cy.visit('/front/groups/enrollment'); // the list's ENROLLMENT button opens this route

    cy.enrollBeneficiariesIntoProgram(
      programName, programCode, status,
      criterionField, criterionFilter, criterionValue, 'Groups',
    );
  });

  // Assign enrolled program beneficiaries to a project.
  // projectPath: the URL path to the project detail page (captured via cy.url()).
  Cypress.Commands.add('assignBeneficiariesToProject', (projectPath) => {
    cy.visit(projectPath);
    cy.contains('Beneficiaries Assigned');
    // The beneficiary table's loading overlay covers the button until its query returns.
    cy.contains('button', 'Assign Beneficiaries').click({ timeout: TIMEOUTS.SERVER_RESULT });
    cy.get('[role="progressbar"]').should('exist');
    cy.get('[role="progressbar"]', { timeout: TIMEOUTS.SERVER_RESULT }).should('not.exist');

    cy.get('[role="dialog"]').should('be.visible');

    // Bump the dialog's pagination to its largest option BEFORE select-all,
    // so every enrolled candidate is on the visible page and gets included.
    // Without this, select-all only checks the first page (default 10 rows),
    // leaving the rest unassigned and producing partial cohorts downstream.
    cy.get('[role="dialog"]').then(($dialog) => {
      // The class sits on both the wrapper and the combobox; only the combobox opens the menu.
      const $select = $dialog.find('.MuiTablePagination-select[role="combobox"]').first();
      if ($select.length) {
        cy.wrap($select).click({ force: true });
        cy.get('[role="listbox"] li').last().click({ force: true });
      }
    });

    // Click the select-all checkbox in the table header.
    // Use first() — the dialog may render multiple header rows.
    cy.get('[role="dialog"] th input[type="checkbox"]').first().click({ force: true });
    // The Save button may be scrolled out of view when many rows are visible.
    cy.get('[role="dialog"]').contains('button', 'Save').click({ force: true });
    cy.get('[role="progressbar"]').should('exist');
    cy.get('[role="progressbar"]').should('not.exist');
  });

  // Read the names of beneficiaries currently assigned to a project, by
  // scraping the project's "Enter time" bulk-edit table.  This is the
  // ground truth for who's in the project — distinct from the enrolled set
  // (which may be larger if assignment dialog pagination clipped some).
  // Returns a string array of "First Last" names in row order.
  //
  // Cohort-driven tests should drive their day-pattern map from THIS list,
  // not from a beneficiary GraphQL probe — names from the probe may not
  // appear in the project table if assignment is partial.
  Cypress.Commands.add('getProjectAssignedBeneficiaryNames', (projectPath) => {
    cy.visit(projectPath);
    cy.contains('Beneficiaries Assigned');
    // The beneficiary table's loading overlay covers the button until its query returns.
    cy.contains('button', 'Enter time').click({ timeout: TIMEOUTS.SERVER_RESULT });

    // Set pageSize to max so we read every row.
    cy.get('body').then(($body) => {
      const $select = $body.find('.MuiTablePagination-select[role="combobox"]').first();
      if (!$select.length) return;
      cy.wrap($select).click({ force: true });
      cy.get('[role="listbox"] li').last().click({ force: true });
    });

    cy.get('table tbody tr').should('have.length.at.least', 1);

    // Scope to the bulk-edit "Enter time" table specifically — anchor
    // via its unique "Work Day" inputs and walk up to the enclosing
    // <table>. Without this scoping, unrelated tables on the page (the
    // upper summary "Beneficiaries Assigned" table) get included and
    // each beneficiary appears twice in the returned name list.
    return cy.get('input[placeholder^="Work Day"]')
      .first()
      .closest('table')
      .find('tbody tr')
      .then(($rows) => {
      const names = $rows.toArray().map((tr) => {
        // Take the first TWO alphabetic-only tokens from the row's
        // innerText.  This survives table layouts where the name cells
        // may be preceded by a checkbox/select column or interleaved
        // with numeric cells (e.g. district code, day-percent values).
        const text = (tr.innerText || tr.textContent || '').trim();
        const tokens = text.split(/\s+/).filter((t) => /^[A-Za-z]+$/.test(t));
        return tokens.slice(0, 2).join(' ');
      }).filter((n) => n.split(/\s+/).length === 2);
      return cy.wrap(names);
    });
  });

  // Enter time entries for all enrolled beneficiaries on a project.
  // Fills every visible day cell with the given percentComplete value.
  Cypress.Commands.add('enterProjectTimeEntries', (projectPath, percentComplete) => {
    cy.visit(projectPath);
    cy.contains('Beneficiaries Assigned');
    // The beneficiary table's loading overlay covers the button until its query returns.
    cy.contains('button', 'Enter time').click({ timeout: TIMEOUTS.SERVER_RESULT });

    // Fill only the "Work Day" percentage inputs (not other numeric columns
    // like "Children" that also appear in bulk-edit mode).
    // PercentageEditField renders with placeholder="Work Day N".
    cy.get('table input[placeholder^="Work Day"]').its('length').then((count) => {
      for (let i = 0; i < count; i++) {
        cy.get('table input[placeholder^="Work Day"]').eq(i)
          .type(`{selectall}${String(percentComplete)}`, { force: true });
      }
    });

    // Save time entries — the same button toggles to "Save" in edit mode.
    cy.contains('button', 'Save').click();
    cy.get('[role="progressbar"]').should('not.exist');
  });

  // Per-beneficiary variant of enterProjectTimeEntries.  Accepts a
  // `daysByText` map of `{ "<row identifier>": [percentDay1, percentDay2, …] }`
  // where the key is any text (e.g. full name "Andrew Walker") whose tokens
  // collectively appear within the row's innerText.  Tokens are matched
  // case-insensitively and may be in any order — robust to first/last names
  // rendered in separate <td> cells (where row.text() has no separator).
  Cypress.Commands.add('enterProjectTimeEntriesPerBeneficiary', (projectPath, daysByText) => {
    cy.visit(projectPath);
    cy.contains('Beneficiaries Assigned');
    // The beneficiary table's loading overlay covers the button until its query returns.
    cy.contains('button', 'Enter time').click({ timeout: TIMEOUTS.SERVER_RESULT });

    // The bulk-edit table paginates (default 10 per page).  The exact cohort
    // we want to address must all be on one page, so set pageSize as high as
    // the picker allows; if no large option exists this is a no-op.
    cy.get('body').then(($body) => {
      const $select = $body.find('.MuiTablePagination-select[role="combobox"]').first();
      if (!$select.length) return;
      cy.wrap($select).click({ force: true });
      cy.get('[role="listbox"] li')
        .last()
        .click({ force: true });
    });

    cy.get('table tbody tr').should('have.length.at.least', 1);

    // Re-query row + input on every type to avoid detached-DOM errors when
    // the table re-renders between cell edits.  Slower but stable.
    Object.entries(daysByText).forEach(([key, dayPercents]) => {
      const tokens = key.split(/\s+/).filter(Boolean).map((t) => t.toLowerCase());
      dayPercents.forEach((percent, idx) => {
        cy.get('table tbody tr').then(($rows) => {
          const matched = $rows.toArray().find((tr) => {
            const text = (tr.innerText || tr.textContent || '').toLowerCase();
            return tokens.every((t) => text.includes(t));
          });
          if (!matched) {
            throw new Error(`enterProjectTimeEntriesPerBeneficiary: no row matched "${key}"`);
          }
          cy.wrap(matched)
            .find('input[placeholder^="Work Day"]')
            .eq(idx)
            .type(`{selectall}${String(percent)}`, { force: true });
        });
      });
    });

    cy.contains('button', 'Save').click();
    cy.waitForJournalProgress();
    cy.assertJournalNoFail();
  });

  // Change the status of a project (e.g. to COMPLETED).
  Cypress.Commands.add('updateProjectStatus', (projectPath, status) => {
    cy.visit(projectPath);
    cy.contains('Beneficiaries Assigned');
    cy.chooseMuiSelect('Status', status);

    cy.saveAndAwaitJournal({ saveTitle: 'Save' });
  });
}
