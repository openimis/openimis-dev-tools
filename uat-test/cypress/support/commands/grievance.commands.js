import { TIMEOUTS } from '../constants';

export function registerGrievanceCommands() {
  // TicketForm opens a "Grievance saved" alert after every grievance mutation (create,
  // update, comment, resolve, reopen); its modal covers the form and the journal.
  // TicketForm raises "Grievance saved" when the mutation response arrives, which can be
  // after the journal check: a single look missed it and the dialog then covered the next
  // click. Polls for it for a while, and closes it when it shows.
  Cypress.Commands.add('closeGrievanceSavedDialog', ({ within = 5000 } = {}) => {
    const deadline = Date.now() + within;
    const saved = (root) => Cypress.$(root).find('[role="dialog"]').filter((_, d) => d.textContent.includes('Grievance saved'));
    const attempt = () => cy.get('body', { log: false }).then(($body) => {
      const $close = saved($body).find('button').filter((_, b) => /^close$/i.test(b.textContent.trim()));
      if ($close.length) {
        cy.wrap($close.first()).click();
        cy.get('body').should(($b) => expect(saved($b).length, '"Grievance saved" closed').to.eq(0));
        return;
      }
      if (Date.now() < deadline) cy.wait(250, { log: false }).then(attempt); // eslint-disable-line cypress/no-unnecessary-waiting
    });
    attempt();
  });

  // Opens the grievance list the way a user finds it: the top-bar "Grievance" icon
  // (core.AppBarIcons, grievance module since 62b29ef on develop) or, without it,
  // the release menu entry Workplace > Task Management > Grievances (matched by its
  // route: the release config gives that entry no label of its own).
  Cypress.Commands.add('openGrievanceListFromNavigation', () => {
    const link = 'a[href$="/ticket/tickets"]';
    cy.visit('/front');
    // The top bar holds the icons; the menu (here "Workplace") is a separate bar below.
    const icon = ':is(button[aria-label="Grievance"], button[title="Grievance"])';
    cy.get('body').should(($body) => {
      expect($body.find(icon).length > 0 || $body.text().includes('Workplace'), 'grievance icon or Workplace menu').to.be.true;
    }).then(($body) => {
      const $icon = $body.find(icon);
      if ($icon.length) {
        cy.wrap($icon.first()).click();
        return;
      }
      cy.contains('Workplace').click({ force: true });
      cy.get('body').then(($body) => {
        if (!$body.find(`${link}:visible`).length) cy.contains('Task Management').click({ force: true });
      });
      cy.get(link).filter(':visible').first().click();
    });
    cy.url().should('include', '/front/ticket/tickets');
  });

  Cypress.Commands.add('getGrievanceCount', () => {
    const pattern = /\(\d+\) Grievance\(s\)/;
    return cy.contains(pattern)
      .invoke('text')
      .then((text) => {
        const match = text.match(/\((\d+)\) Grievance/);
        return parseInt(match?.[1], 10);
      });
  });

  Cypress.Commands.add('createGrievance', (grievanceData) => {
    cy.visit('/front/ticket/newTicket');

    // Required fields
    cy.enterMuiInput('Grievance Title', grievanceData.title);
    cy.chooseMuiAutocomplete('Category', grievanceData.category);
    cy.chooseMuiAutocomplete('Flag', grievanceData.flag);
    cy.chooseMuiAutocomplete('Channel', grievanceData.channel);

    // Optional fields
    if (grievanceData.priority) {
      cy.chooseMuiSelect('Priority', grievanceData.priority);
    }

    if (grievanceData.dateOfIncident) {
      cy.contains('label', 'Date Of Incident')
        .parent()
        .find('input')
        .type(grievanceData.dateOfIncident);
    }

    if (grievanceData.assignedUser) {
      cy.chooseMuiAutocomplete('Assigned User', grievanceData.assignedUser);
    }

    if (grievanceData.details) {
      cy.enterMuiInput('DETAILS OF EVENT', grievanceData.details);
    }

    // Reporter type handling
    if (grievanceData.reporterType) {
      cy.chooseMuiSelect('Reporter Type', grievanceData.reporterType);

      if (grievanceData.reporterType === 'Individual') {
        if (grievanceData.benefitPlan) {
          cy.chooseMuiAutocomplete('Program', grievanceData.benefitPlan);
        }
        if (grievanceData.individual) {
          cy.chooseMuiAutocomplete('Individual', grievanceData.individual);
        } else {
          cy.chooseMuiAutocomplete('Individual');
        }
      } else if (grievanceData.reporterType === 'Beneficiary') {
        if (grievanceData.benefitPlan) {
          cy.chooseMuiAutocomplete('Program', grievanceData.benefitPlan);
        }
        if (grievanceData.beneficiary) {
          cy.chooseMuiAutocomplete('BeneficiaryPicker', grievanceData.beneficiary);
        } else {
          cy.chooseMuiAutocomplete('BeneficiaryPicker');
        }
      } else if (grievanceData.reporterType === 'Attending Staff') {
        if (grievanceData.attendingStaff) {
          cy.chooseMuiAutocomplete('Complainant', grievanceData.attendingStaff);
        } else {
          cy.chooseMuiAutocomplete('Complainant');
        }
      }
    }

    // Save the grievance
    cy.clickSave(); // fe-core Form save FAB

    // Wait for creation to complete
    cy.waitForJournalProgress();

    // Close the "Grievance saved" dialog, then check the journal.
    // The label is "Create Ticket {label}" with the ticket code, which a new ticket does
    // not have yet (TicketPage.jsx): the entry reads only "Create Ticket".
    cy.closeGrievanceSavedDialog();
    cy.get('ul.MuiList-root li').first().should('contain.text', 'Create Ticket');
    cy.contains('Failed to create').should('not.exist');
  });

  Cypress.Commands.add('updateGrievance', (grievanceCode, updateData, immutableFields = {}) => {
    cy.visit('/front/ticket/tickets');
    cy.waitForSearcherLoaded();

    // Search for grievance by code
    cy.enterMuiInput('Code', grievanceCode);
    cy.contains('button', 'Search').click();
    cy.waitForSearcherLoaded();

    // Open grievance for edit
    cy.contains('td', grievanceCode)
      .parent('tr')
      .within(() => {
        cy.get('button:is([title="Edit"],[aria-label="Edit"])').click();
      });

    if (immutableFields.reporterType) {
      cy.assertMuiInputDisabled('Reporter Type', immutableFields.reporterType);
    }

    if (immutableFields.reporterFieldLabel) {
      cy.get('body').then(($body) => {
        const labelText = immutableFields.reporterFieldLabel;
        const hasLabel = $body.find('label').toArray()
          .some((el) => el.textContent?.trim() === labelText);
        if (hasLabel) {
          cy.assertMuiInputDisabled(
            labelText,
            immutableFields.reporterFieldValue ?? null,
          );
        }
      });
    }

    // Update fields (excluding reporter type and reporter info)
    if (updateData.title) {
      cy.enterMuiInput('Title', updateData.title);
    }

    if (updateData.category) {
      cy.chooseMuiAutocomplete('Category', updateData.category);
    }

    if (updateData.flag) {
      cy.chooseMuiAutocomplete('Flag', updateData.flag);
    }

    if (updateData.channel) {
      cy.chooseMuiAutocomplete('Channel', updateData.channel);
    }

    if (updateData.priority) {
      cy.chooseMuiSelect('Priority', updateData.priority);
    }

    if (updateData.details) {
      cy.enterMuiInput('Description', updateData.details);
    }

    // Save changes
    cy.clickSave(); // fe-core Form save FAB

    // Wait for update to complete
    cy.waitForJournalProgress();
    cy.closeGrievanceSavedDialog();

    // Check journal for success
    cy.get('ul.MuiList-root li').first().click();
    // The journal label is "Update Ticket <code>" (fe-grievance_social_protection 1691545).
    cy.contains('Update Ticket', { timeout: TIMEOUTS.SERVER_RESULT }).should('exist');
    cy.contains('Failed to update').should('not.exist');
  });

  Cypress.Commands.add('resolveGrievance', (grievanceCode, comment = 'Resolved Grievance') => {
    cy.searchAndOpenGrievanceForEdit(grievanceCode);
    cy.addGrievanceComment(comment);

    // Click the tick mark icon on the first/latest comment to resolve
    cy.get('button:is([title="Resolve grievance with this comment."],[aria-label="Resolve grievance with this comment."])').first().click();

    // Wait for resolve to complete
    cy.waitForJournalProgress();
    cy.closeGrievanceSavedDialog();

    // Check journal for success
    cy.get('ul.MuiList-root li').first().click();
    cy.contains('Resolve Ticket using comment', { timeout: TIMEOUTS.SERVER_RESULT }).should('exist');
    cy.contains('Failed').should('not.exist');
  });

  Cypress.Commands.add('unlockGrievance', (grievanceCode) => {
    cy.searchAndOpenGrievanceForEdit(grievanceCode);

    // Click the unlock icon (lock icon in header action area)
    cy.get('div[class*="paperHeaderAction"] button.MuiIconButton-root').click();

    cy.waitForJournalProgress();
    cy.closeGrievanceSavedDialog();

    cy.get('ul.MuiList-root li').first().click();
    cy.contains('Failed').should('not.exist');
    // The click opens the entry's popover; its invisible backdrop would cover the page.
    const popoverBackdrop = '.MuiModal-backdrop.MuiBackdrop-invisible';
    cy.get('body').then(($body) => {
      const $backdrop = $body.find(popoverBackdrop);
      if ($backdrop.length) cy.wrap($backdrop.last()).click({ force: true });
    });
    cy.get(popoverBackdrop).should('not.exist');
  });

  Cypress.Commands.add('checkGrievanceFieldValues', (title, category, flag, channel, priority = null, details = null) => {
    cy.assertMuiInput('Grievance Title', title);
    cy.assertMuiInput('Category', category);
    cy.assertMuiInput('Flag', flag);
    cy.assertMuiInput('Channel', channel);
    if (priority) {
      cy.assertMuiSelectValue('Priority', priority);
    }

    if (details) {
      cy.assertMuiInput('Description', details);
    }
  });

  Cypress.Commands.add('checkGrievanceFieldValuesInListView', (title, category) => {
    cy.waitForSearcherLoaded();

    cy.enterMuiInput('Title', title);
    cy.contains('button', 'Search').click();
    cy.waitForSearcherLoaded();

    cy.contains('td', title).should('exist');
    cy.contains('td', title)
      .parent('tr')
      .within(() => {
        cy.contains('td', category).should('exist');
      });
  });

  Cypress.Commands.add('getGrievanceCodeFromList', (title) => {
    cy.visit('/front/ticket/tickets');
    cy.waitForSearcherLoaded();

    cy.enterMuiInput('Title', title);
    cy.contains('button', 'Search').click();
    cy.waitForSearcherLoaded();

    return cy.contains('td', title)
      .parent('tr')
      .find('td')
      .first()
      .invoke('text')
      .then((code) => code.trim());
  });

  Cypress.Commands.add('searchAndOpenGrievanceForEdit', (grievanceCode) => {
    cy.visit('/front/ticket/tickets');
    cy.waitForSearcherLoaded();

    cy.enterMuiInput('Code', grievanceCode);
    cy.contains('button', 'Search').click();
    cy.waitForSearcherLoaded();

    cy.contains('td', grievanceCode)
      .parent('tr')
      .within(() => {
        cy.get('button:is([title="Edit"],[aria-label="Edit"])').click();
      });
  });

  Cypress.Commands.add('addGrievanceComment', (commentText, commentData = {}) => {
    cy.contains('button', 'Add Comment').click();
    // Use native HTMLInputElement value setter to avoid DOM detachment caused by
    // React's per-keystroke re-renders in TicketCommentsPanel (setInterval + controlled input).
    // That panel reloads every 5 s and can drop a value set just before: set it again
    // until the input keeps it.
    const setComment = (inputEl) => {
      const win = inputEl.ownerDocument.defaultView || window;
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
        win.HTMLInputElement.prototype, 'value',
      ).set;
      nativeInputValueSetter.call(inputEl, commentText);
      inputEl.dispatchEvent(new Event('input', { bubbles: true }));
    };
    cy.contains('label', 'Comment')
      .siblings('.MuiInputBase-root')
      .find('input', { timeout: TIMEOUTS.BACKEND_VALIDATION })
      .first()
      .should(($input) => {
        if ($input.val() !== commentText) setComment($input[0]);
        expect($input.val(), 'comment kept').to.eq(commentText);
      });

    if (commentData.reporterType) {
      cy.chooseMuiSelect('Reporter Type', commentData.reporterType);

      if (commentData.reporterType === 'Individual') {
        if (commentData.benefitPlan) {
          cy.chooseMuiAutocomplete('Program', commentData.benefitPlan);
        }
        if (commentData.individual) {
          cy.chooseMuiAutocomplete('Individual', commentData.individual);
        } else {
          cy.chooseMuiAutocomplete('Individual');
        }
      } else if (commentData.reporterType === 'Beneficiary') {
        if (commentData.benefitPlan) {
          cy.chooseMuiAutocomplete('Program', commentData.benefitPlan);
        }
        if (commentData.beneficiary) {
          cy.chooseMuiAutocomplete('Beneficiary', commentData.beneficiary);
        } else {
          cy.chooseMuiAutocomplete('Beneficiary');
        }
      } else if (commentData.reporterType === 'Attending Staff') {
        if (commentData.attendingStaff) {
          cy.chooseMuiAutocomplete('Commenter', commentData.attendingStaff);
        } else {
          cy.chooseMuiAutocomplete('Commenter');
        }
      }
    }

    // Save is enabled once the form state holds the comment; a reload may still have
    // dropped it after the check above, so set it again while Save stays disabled.
    cy.contains('button', 'Save', { timeout: TIMEOUTS.BACKEND_VALIDATION }).should(($save) => {
      if ($save.is(':disabled')) {
        const $input = Cypress.$('label:contains("Comment")').siblings('.MuiInputBase-root').find('input').first();
        if ($input.length) setComment($input[0]);
      }
      expect($save, 'Save enabled').not.to.be.disabled;
    });
    cy.contains('button', 'Save').click();

    // Wait for save mutation to complete before reloading
    cy.waitForJournalProgress();
    cy.closeGrievanceSavedDialog();

    cy.contains(commentText).should('exist');
  });
}
