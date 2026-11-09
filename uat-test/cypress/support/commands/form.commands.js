// Generic form-action helpers shared across the suite.
//
// These commands replace the hand-rolled save/progressbar/journal patterns
// that appeared in payment-plan.commands.js, programs.commands.js, etc.

import { TIMEOUTS } from '../constants';

// The "Save" FAB uses one of three known tooltip titles depending on the
// form and its state.  Listed most-specific first.
// Why a form may keep its Save button disabled: required inputs without a value (MUI
// marks their label with an asterisk) and fields in error (Mui-error, aria-invalid or
// a validation error icon).
const emptyRequiredFields = (doc) => {
  const labelOf = (box) => box?.querySelector('label')?.textContent.replace(/\*/g, '').trim() || '(no label)';
  const empty = [...doc.querySelectorAll('label.Mui-required, label:has(.MuiFormLabel-asterisk)')]
    .filter((label) => {
      const box = label.closest('.MuiFormControl-root') ?? label.parentElement;
      const input = box?.querySelector('input, textarea');
      return input && !String(input.value).trim();
    })
    .map((label) => label.textContent.replace(/\*/g, '').trim());
  const invalid = [...doc.querySelectorAll('.MuiFormControl-root')]
    .filter((box) => box.querySelector('.Mui-error, [aria-invalid="true"], [data-testid="ErrorOutlineOutlinedIcon"]')
      || [...box.querySelectorAll('[class*="material-symbols"]')].some((el) => el.textContent.trim() === 'error'))
    .map((box) => `${labelOf(box)}="${box.querySelector('input, textarea')?.value ?? ''}"`);
  const parts = [];
  if (empty.length) parts.push(`empty required: ${[...new Set(empty)].join(', ')}`);
  if (invalid.length) parts.push(`in error: ${[...new Set(invalid)].join(', ')}`);
  return parts.length ? parts.join('; ') : '(no empty required field or field in error found)';
};

const KNOWN_SAVE_TITLES = [
  'Save changes',
  'Save',
  'Please fill General Information fields first',
];

export function registerFormCommands() {
  // Wait for the journal-progress indicator to appear and then disappear.
  // This is the "async mutation finished" signal used throughout the app.
  // Waiting for the indicator to appear raced fast mutations, so this now waits on
  // the MutationLog of the mutations just sent (see support/mutations.js).
  Cypress.Commands.add('waitForJournalProgress', () => {
    cy.waitForSentMutations({ timeout: TIMEOUTS.BACKEND_VALIDATION });
  });

  // Open the journal drawer (if not already open) and assert its first entry.
  Cypress.Commands.add('assertJournalFirstEntryContains', (text) => {
    cy.get('.MuiDrawer-paperAnchorRight button').first().click();
    // the entry is the mutation's: it shows once the server has answered
    cy.get('ul.MuiList-root li', { timeout: TIMEOUTS.SERVER_RESULT }).first().should('contain', text);
  });

  // Assert that the first journal entry does NOT contain the given prefix.
  // Typical use: assertJournalNoFail('Failed to create').
  Cypress.Commands.add('assertJournalNoFail', (prefix = 'Failed to') => {
    cy.get('ul.MuiList-root li').first().should('not.contain', prefix);
  });

  Cypress.Commands.add('clickCreate', (createTitle = 'Create') => {
    cy.get(`:is([title="${createTitle}"],[aria-label="${createTitle}"]) button`, { timeout: TIMEOUTS.BACKEND_VALIDATION })
      .should('not.be.disabled')
      .click();
  });

  // Click the Save FAB.  Tries each known tooltip title (most-specific
  // first) and clicks the first non-disabled match.  Pass an explicit
  // title string to scope to a single candidate.
  Cypress.Commands.add('clickSave', (saveTitle) => {
    const titles = saveTitle ? [saveTitle] : KNOWN_SAVE_TITLES;
    cy.get('body', { timeout: TIMEOUTS.BACKEND_VALIDATION }).should(($body) => {
      const hit = titles.find((t) => $body.find(`:is([title="${t}"],[aria-label="${t}"]) button`).length);
      expect(
        hit,
        `clickSave: no Save FAB found with any known title (${titles.join(', ')})`,
      ).to.exist;
    }).then(($body) => {
      const hit = titles.find((t) => $body.find(`:is([title="${t}"],[aria-label="${t}"]) button`).length);
      cy.get(`:is([title="${hit}"],[aria-label="${hit}"]) button`, { timeout: TIMEOUTS.BACKEND_VALIDATION })
        .should(($button) => {
          expect($button.is(':disabled'), `Save disabled; ${emptyRequiredFields($button[0].ownerDocument)}`).to.be.false;
        })
        .click();
    });
  });

  // Click the Save FAB and wait for the async journal to finish.
  //
  // Options:
  //   saveTitle    — exact `:is([title="..."],[aria-label="..."])` of the Save FAB.  When omitted
  //                  the helper tries KNOWN_SAVE_TITLES in order.
  //   mutationLabel — if set, asserts the first journal entry contains this text
  //   assertNoFail — if set, asserts the first journal entry doesn't start with 'Failed to'
  Cypress.Commands.add('saveAndAwaitJournal', ({
    saveTitle,
    mutationLabel,
    assertNoFail = false,
  } = {}) => {
    cy.clickSave(saveTitle);
    cy.waitForJournalProgress();
    if (mutationLabel || assertNoFail) {
      cy.assertJournalFirstEntryContains(mutationLabel || '');
      if (assertNoFail) {
        cy.assertJournalNoFail('Failed to');
      }
    }
  });

  // Assert the Save FAB.  Tries each known tooltip title; passes
  // if any of them matches.  Optionally scope to a specific title.
  // Retries like clickSave: right after a visit the form may not be rendered yet.
  Cypress.Commands.add('assertSave', (enabled = true, tooltipText) => {
    const titles = tooltipText ? [tooltipText] : KNOWN_SAVE_TITLES;
    const findHit = ($body) => titles.find((t) => $body.find(`:is([title="${t}"],[aria-label="${t}"]) button`).length);
    cy.get('body', { timeout: TIMEOUTS.BACKEND_VALIDATION }).should(($body) => {
      expect(findHit($body), `assertSave: no Save FAB found with any known title (${titles.join(', ')})`).to.exist;
    }).then(($body) => {
      const hit = findHit($body);
      const assertion = enabled ? 'not.be.disabled' : 'be.disabled';
      cy.get(`:is([title="${hit}"],[aria-label="${hit}"]) button`).should(assertion);
    });
  });

  Cypress.Commands.add('assertSaveDisabled', (tooltipText) => {
    cy.assertSave(false, tooltipText);
  });

  Cypress.Commands.add('assertSaveEnabled', (tooltipText) => {
    cy.assertSave(true, tooltipText);
  });

  Cypress.Commands.add('save', () => {
    cy.get('[aria-label="Save changes"]')
      .find('button')
      .should('be.visible')
      .and(($button) => {
        expect($button.is(':disabled'), `Save disabled; ${emptyRequiredFields($button[0].ownerDocument)}`).to.be.false;
      })
      .click();
  });
}
