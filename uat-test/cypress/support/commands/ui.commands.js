import { routeFor } from '../routes';
import { TIMEOUTS } from '../constants';
// The label of a field. With { editable: true }, the first one whose field is not
// read-only: a page can show the same label twice, e.g. an insuree's form under its
// family head's read-only summary, and cy.contains would return the head's.
const fieldLabel = (label, { editable = false } = {}) => {
  if (!editable) return cy.contains('label', label, { matchCase: false });
  // A page that also shows a read-only copy (the insuree page shows the family head's
  // fields first) has the editable field last. Taken by position: the read-only copy
  // isn't disabled yet while the page loads, so a disabled-state filter latched onto it.
  return cy.get('label')
    .filter((_, el) => el.textContent.toLowerCase().includes(label.toLowerCase()))
    .last();
};

export function registerUiCommands() {
  // Re-queries the input for each step and types without delay: validated inputs
  // (e.g. a program Code checked against the backend) and searcher filters re-render
  // while a value is typed, which detaches an input held across commands.
  Cypress.Commands.add('enterMuiInput', (label, value, inputTag = 'input', { editable = false } = {}) => {
    const field = () => fieldLabel(label, { editable })
      .siblings('.MuiInputBase-root')
      .find(inputTag)
      .first();
    field().clear({ force: true });
    field().type(value, { force: true, delay: 0 });
  });

  Cypress.Commands.add('chooseMuiSelect', (label, value) => {
    cy.contains('label', label, { matchCase: false })
      .siblings('.MuiInputBase-root')
      .find('[role="combobox"], [role="button"]')
      .first()
      .then(($field) => {
        if ($field.is('input')) {
          cy.wrap($field).clear({ force: true }).type(value, { force: true });
        } else {
          cy.wrap($field).click();
        }
      });

    cy.contains('[role="listbox"] li', value).click({ force: true });
  });

  Cypress.Commands.add('assertMuiInput', (label, value, inputTag = 'input') => {
    const field = () => cy.contains('label', label, { matchCase: false })
      .siblings('.MuiInputBase-root')
      .find(inputTag);
    // A field below the fold sits inside a scrolling container and counts as hidden.
    field().first().scrollIntoView();
    const input = field().should('be.visible');
    if (value !== undefined) {
      input.and('have.value', value);
    }
  });

  Cypress.Commands.add('assertMuiInputNotEmpty', (label, inputTag = 'input') => {
    cy.contains('label', label, { matchCase: false })
      .siblings('.MuiInputBase-root')
      .find(inputTag)
      .should('be.visible')
      .invoke('val')
      .should('not.be.empty');
  });

  Cypress.Commands.add('assertMuiAutoComplete', (label, value, { timeout } = {}) => {
    // Cypress rejects an explicit `timeout: undefined`: pass it only when given.
    const wait = timeout === undefined ? {} : { timeout };
    cy.contains('label', label, { matchCase: false, ...wait })
      .siblings('.MuiInputBase-root')
      .find('input', wait)
      .should('be.visible')
      // The value assertion retries `invoke`, so the wait has to be on it too: the
      // input is there at once, and fills in later (OP-3289).
      .invoke(wait, 'val')
      .should('include', value);
  });

  Cypress.Commands.add('assertMuiInputDisabled', (label, value = null, inputTag = 'input') => {
    // the page's fields appear once the entity is fetched
    const input = cy.contains('label', label, { matchCase: false, timeout: TIMEOUTS.SERVER_RESULT })
      .siblings('.MuiInputBase-root')
      .find(inputTag);
    input.should('be.disabled');

    if (value) {
      input.should('have.value', value);
    }
  });

  Cypress.Commands.add('assertMuiSelectValue', (label, value) => {
    // An editable select shows its label as text; a read-only one (fe-core SelectInput)
    // renders a text field and keeps the label in the input's value, with no text content.
    cy.contains('label', label, { matchCase: false })
      .siblings('.MuiInputBase-root')
      .should(($root) => {
        const shown = [$root.text(), ...$root.find('input').map((_, input) => input.value).get()];
        expect(shown.some((text) => text.includes(value)), `${label} shows ${value}`).to.equal(true);
      });
  });

  // Drive an openIMIS date-picker field by navigating its calendar popup.
  //
  // Works on both the current CRA build (MUI v3 @material-ui/pickers) and the
  // Vite build (MUI X v7+).  See cypress/docs/mui-date-picker-plan.md for the
  // DOM contract of each version.
  //
  // Accepts ISO (`YYYY-MM-DD`) or DMY (`DD-MM-YYYY`). The final value is
  // always asserted as `DD-MM-YYYY` — openIMIS stores it that way on both.
  //
  // Reason for calendar-navigation instead of typing: `.type()` into the v3
  // field races with the picker's own parser (observed off-by-one-month bugs
  // in payroll specs — `17-05-2026` landed as `17-04-2026`), and the v7
  // sectioned field cannot receive a whole `DD-MM-YYYY` string at once.
  const MONTHS = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];

  function parseDate(input) {
    const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input);
    const dmy = /^(\d{2})-(\d{2})-(\d{4})$/.exec(input);
    if (iso) return { year: +iso[1], month: +iso[2] - 1, day: +iso[3] };
    if (dmy) return { year: +dmy[3], month: +dmy[2] - 1, day: +dmy[1] };
    throw new Error(`selectDateFromCalendar: unsupported date "${input}" — use YYYY-MM-DD or DD-MM-YYYY`);
  }

  // v3 MUI @material-ui/pickers keeps the OUTGOING header paragraph in the
  // DOM during its SlideTransition, so reading `.text()` mid-animation yields
  // "May 2026April 2026" — never equal to the target. The fix below computes
  // the month delta up front and, between clicks, waits for the transition
  // to settle (exactly one <p> child) before reading again.
  Cypress.Commands.add('selectDateFromCalendar', (label, dateStr, options = {}) => {
    const { year, month, day } = parseDate(dateStr);
    const pad = (n) => String(n).padStart(2, '0');
    const expected = `${pad(day)}-${pad(month + 1)}-${year}`;

    fieldLabel(label, options).parent().then(($wrap) => {
      const isV7 = $wrap.find('.MuiPickersSectionList-root, button[aria-label^="Choose date"]').length > 0;

      const cfg = isV7
        ? {
          // v7 popper — single settled header label, no transition duplication.
          scope: '.MuiPickerPopper-root',
          open: () => cy.wrap($wrap).find('button[aria-label^="Choose date"]').click(),
          headerText: '.MuiPickersCalendarHeader-label',
          prev: '.MuiPickersArrowSwitcher-previousIconButton',
          next: '.MuiPickersArrowSwitcher-nextIconButton',
          yearSwitch: '.MuiPickersCalendarHeader-switchViewButton',
          yearSample: '.MuiYearCalendar-root button',
          dayCell: '.MuiDayCalendar-weekContainer .MuiPickersDay-root',
          hiddenDay: '.MuiPickersDay-hiddenDaySpacingFiller, .MuiPickersDay-dayOutsideMonth',
          disabledDay: '.Mui-disabled',
          settleSelector: null,
          ok: null,
        }
        : {
          // v3: scope to the inner Paper rather than `[role="dialog"]` which
          // matches BOTH the outer `.MuiDialog-root` and the inner paper.
          scope: '.MuiPickersModal-dialogRoot',
          open: () => cy.wrap($wrap).find('input').first().click({ force: true }),
          // The header container holds a <p> with the month+year. During the
          // slide animation a second <p> coexists — `:last-child` always
          // points at the newest view.
          headerText: '.MuiPickersCalendarHeader-transitionContainer p:last-child',
          // Scope arrow selectors to the switchHeader so `:nth-of-type` can't
          // drift if other IconButtons appear elsewhere in the paper.
          prev: '.MuiPickersCalendarHeader-switchHeader > button:nth-of-type(1)',
          next: '.MuiPickersCalendarHeader-switchHeader > button:nth-of-type(2)',
          yearSwitch: '.MuiPickersToolbar-toolbar .MuiPickersToolbarButton-toolbarBtn:first-of-type',
          yearSample: '.MuiPickersYear-root',
          dayCell: '.MuiPickersCalendar-week .MuiPickersDay-day',
          hiddenDay: '.MuiPickersDay-hidden',
          disabledDay: '.MuiPickersDay-dayDisabled',
          // Settle = exactly one paragraph in the header container (old exit
          // node has been removed after the slide completes).
          settleSelector: '.MuiPickersCalendarHeader-transitionContainer p',
          ok: 'button',
        };

      const waitForSettle = () => {
        if (cfg.settleSelector) {
          cy.get(`${cfg.scope} ${cfg.settleSelector}`, { timeout: 5000 })
            .should('have.length', 1);
        }
      };

      cfg.open();
      cy.get(`${cfg.scope} ${cfg.headerText}`).should('be.visible');
      waitForSettle();

      // Year jump (if needed). v3 preserves the viewed month after a year
      // pick, so the month-stepping loop below still works from the same
      // starting month.
      cy.get(`${cfg.scope} ${cfg.headerText}`).invoke('text').then((txt) => {
        const shownYearStr = txt.trim().split(/\s+/).pop();
        if (+shownYearStr !== year) {
          cy.get(`${cfg.scope} ${cfg.yearSwitch}`).click();
          cy.contains(`${cfg.scope} ${cfg.yearSample}`, new RegExp(`^${year}$`)).click();
          cy.get(`${cfg.scope} ${cfg.headerText}`).should('contain.text', String(year));
          waitForSettle();
        }
      });

      // Compute month delta from the settled header, then click N times
      // waiting for settle between clicks.
      cy.get(`${cfg.scope} ${cfg.headerText}`).invoke('text').then((txt) => {
        const shownMonthName = txt.trim().split(/\s+/)[0];
        const shownMonth = MONTHS.indexOf(shownMonthName);
        if (shownMonth < 0) {
          throw new Error(`selectDateFromCalendar: unrecognized month in header "${txt}"`);
        }
        const delta = month - shownMonth;
        const arrow = delta >= 0 ? cfg.next : cfg.prev;
        const steps = Math.abs(delta);
        for (let i = 0; i < steps; i += 1) {
          cy.get(`${cfg.scope} ${arrow}`).click();
          waitForSettle();
        }
      });

      // Assert we landed on the target month before picking the day.
      cy.get(`${cfg.scope} ${cfg.headerText}`)
        .should('contain.text', `${MONTHS[month]} ${year}`);

      cy.get(`${cfg.scope} ${cfg.dayCell}`)
        .not(cfg.hiddenDay)
        .not(cfg.disabledDay)
        .contains(new RegExp(`^${day}$`))
        .click();

      if (cfg.ok) {
        cy.contains(`${cfg.scope} ${cfg.ok}`, 'OK').click();
      }
      cy.get(cfg.scope, { timeout: 5000 }).should('not.exist');

      // Same field as the one picked: with { editable: true }, not a read-only copy.
      cy.assertMuiDatePickerValue(label, expected, options);
    });
  });

  // MUI X v7+ (sectioned PickersTextField, default in v8) hides the legacy
  // <input> behind aria-hidden and renders the value as spans in
  // .MuiPickersSectionList-root; read that when present, else the input.
  Cypress.Commands.add('assertMuiDatePickerValue', (label, value, options = {}) => {
    fieldLabel(label, options).parent().then(($wrap) => {
      const $sections = $wrap.find('.MuiPickersSectionList-root');
      if ($sections.length) {
        cy.wrap($sections).should('have.text', value);
      } else {
        cy.wrap($wrap).find('input').first().should('have.value', value);
      }
    });
  });

  // Pick today's date. MUI X v8 has no OK button: open the popper from the
  // "Choose date…" adornment and click the current day. Legacy pickers open
  // on a click of the field and confirm with OK.
  Cypress.Commands.add('pickTodayInDatePicker', (label) => {
    cy.contains('label', label, { matchCase: false }).parent().then(($wrap) => {
      const $trigger = $wrap.find('button[aria-label^="Choose date"]');
      if ($trigger.length) {
        cy.wrap($trigger).click();
        cy.get('.MuiPickerPopper-root').should('be.visible')
          .find('button[aria-current="date"]').click();
        cy.get('.MuiPickerPopper-root').should('not.exist');
      } else {
        cy.wrap($wrap).click();
        cy.contains('button', 'OK').click();
      }
    });
  });

  // Wait until a searcher has finished loading. The "Rows Per Page" footer is
  // not a usable signal: the table only renders pagination when it has rows.
  // fe-core shows the results title (e.g. "3 Programs", "0 Task Groups Found") in the
  // searcher header, or in the table header, and "Loading..." while fetching.
  Cypress.Commands.add('waitForSearcherLoaded', (options = {}) => {
    // a searcher's results come from the server
    const timeout = options.timeout ?? TIMEOUTS.SERVER_RESULT;
    // The filter panel ("Search Criteria") uses the same header class: look at all of them.
    cy.get('.paperHeaderTitle, .tableTitle h6', { timeout }).should(($titles) => {
      const texts = $titles.toArray().map((el) => el.textContent);
      expect(texts.some((t) => /\d/.test(t)), `searcher results title among ${JSON.stringify(texts)}`).to.be.true;
      expect(texts.some((t) => /loading/i.test(t)), 'still loading').to.be.false;
    });
  });

  // Back-compat alias — the original enterDateInput typed the value and
  // clicked OK, which produced off-by-one-month bugs. Every caller now goes
  // through the calendar-navigation path.
  Cypress.Commands.add('enterDateInput', (label, value) => {
    cy.selectDateFromCalendar(label, value);
  });

  // Open a MUI Select by label and pick the first available option.
  // Useful when the exact option value is dynamic (e.g. Payment Method list
  // returned by the backend).
  Cypress.Commands.add('chooseFirstMuiSelect', (label) => {
    cy.contains('label', label, { matchCase: false })
      .siblings('.MuiInputBase-root')
      .find('[role="combobox"], [role="button"]')
      .click();
    cy.get('[role="listbox"] li')
      .should('have.length.at.least', 1)
      .first()
      .click();
  });

  // Check or uncheck a MUI Checkbox identified by its hidden `input[name]`
  // (preferred — most searcher filters use this) or by the text of its label.
  Cypress.Commands.add('toggleMuiCheckbox', (nameOrLabel, checked = true) => {
    cy.get('body').then(($body) => {
      const byName = $body.find(`input[type="checkbox"][name="${nameOrLabel}"]`);
      if (byName.length) {
        if (checked) cy.wrap(byName.first()).check({ force: true });
        else cy.wrap(byName.first()).uncheck({ force: true });
        return;
      }
      const $input = cy.contains('label', nameOrLabel)
        .find('input[type="checkbox"]');
      if (checked) $input.check({ force: true });
      else $input.uncheck({ force: true });
    });
  });

  // Each step re-queries the input — some MUI autocomplete implementations
  // re-render the field as soon as you click/type (e.g. Task Group picker),
  // which detaches prior subjects and causes "subject is no longer attached"
  // errors on chained .clear() / .type() calls.
  // Picks an option of a MUI Autocomplete (or a read-only input opening a menu): the
  // one containing `value` (typed first to narrow server-side pickers) or, without a
  // value, the first one. Options come from the listbox the input controls
  // (aria-controls) when it has one, so a popup of another field that is still
  // closing cannot be picked; otherwise from the visible popups (by the popup's own
  // visibility: Cypress counts an option scrolled out of its menu as hidden).
  Cypress.Commands.add('chooseMuiAutocomplete', (label, value = null) => {
    const inputSelector = () => cy.contains('label', label, { matchCase: false })
      .siblings('.MuiInputBase-root')
      .find('input');

    // Pickers disable their input while their options load; a click then opens nothing.
    inputSelector().should('not.be.disabled');
    inputSelector().click({ force: true });
    if (value) {
      inputSelector().clear({ force: true });
      inputSelector().type(value, { force: true });
    }

    const popupOptions = '[role="menu"] li, [role="presentation"] li, [role="listbox"] li, li[role="option"]';
    const matchingOptions = ($input) => {
      const id = $input.attr('aria-controls');
      const $options = id
        ? Cypress.$(`[id="${id}"] li`)
        : Cypress.$(popupOptions).filter((_, li) => Cypress.$(li.parentElement).is(':visible'));
      return value ? $options.filter((_, li) => li.textContent.includes(value)) : $options;
    };
    // A server-side picker answers the typed search with a round trip: give its
    // options the server-result timeout, not the 5 s default.
    cy.contains('label', label, { matchCase: false })
      .siblings('.MuiInputBase-root')
      .find('input', { timeout: TIMEOUTS.SERVER_RESULT })
      .should(($input) => {
        expect(matchingOptions($input).length, `option ${value ?? '(first)'} for ${label}`).to.be.above(0);
      })
      .then(($input) => cy.wrap(matchingOptions($input).first()).click({ force: true }));
  });

  // Clicks a row action. Searchers built on fe-core ActionMenu put the actions
  // behind a "..." button (MoreHoriz icon) opening a menu; older ones render
  // the action as a button in the row. Handles both.
  Cypress.Commands.add('clickRowAction', (rowText, actionLabel) => {
    // "..." menu: an SVG icon (MoreHorizIcon) or a Material Symbols span ("more_horiz").
    const moreButton = ($row) => $row.find('button').filter((_, b) =>
      !!b.querySelector('[data-testid="MoreHorizIcon"]')
      || [...b.querySelectorAll('[class*="material-symbols"]')].some((el) => el.textContent.trim() === 'more_horiz'));
    // Inline action: button text, or the tooltip label of an icon button. The text leaves
    // out a Material Symbols start icon, whose glyph name is text too ("deleteDelete").
    const labelOf = (b) => [...b.childNodes]
      .filter((n) => !(n.nodeType === 1 && (n.matches('[class*="material-symbols"]') || n.querySelector('[class*="material-symbols"]'))))
      .map((n) => n.textContent).join('').trim();
    const inlineButton = ($row) => $row.find('button').filter((_, b) =>
      labelOf(b) === actionLabel
      || [b, b.parentElement].some((el) => el && [el.getAttribute('aria-label'), el.getAttribute('title')].includes(actionLabel)));
    cy.contains('tr', rowText)
      .should(($row) => {
        expect(moreButton($row).length + inlineButton($row).length, `"${actionLabel}" action or "..." menu in the row`).to.be.above(0);
      })
      .then(($row) => {
        const $more = moreButton($row);
        if ($more.length) {
          cy.wrap($more.first()).click({ force: true });
          cy.contains('[role="menuitem"]', actionLabel).click({ force: true });
        } else {
          cy.wrap(inlineButton($row).first()).click({ force: true });
        }
      });
  });

  Cypress.Commands.add('verifyMuiInputValue', (label, expectedValue, inputTag = 'input', { editable = false } = {}) => {
    fieldLabel(label, { editable })
      .siblings('.MuiInputBase-root')
      .find(inputTag)
      .first()
      .invoke('val')
      .then((actualValue) => {
        // Amount/quantity fields render decimals ("50.00"): compare numbers as numbers.
        const numeric = (v) => String(v).trim() !== '' && !Number.isNaN(Number(String(v).replace(/,/g, '')));
        if (numeric(actualValue) && numeric(expectedValue)) {
          expect(Number(String(actualValue).replace(/,/g, ''))).to.eq(Number(String(expectedValue).replace(/,/g, '')));
        } else {
          expect(String(actualValue).toLowerCase()).to.eq(String(expectedValue).toLowerCase());
        }
      });
  });

  // A Select's combobox is a div showing the choice; an Autocomplete's (e.g. Profession)
  // is the input itself, whose text is empty: read its value then.
  Cypress.Commands.add('verifyMuiSelectValue', (label, expectedValue) => {
    cy.contains('label', label, { matchCase: false })
      .siblings('.MuiInputBase-root')
      .find('[role="combobox"]')
      .first()
      .should(($field) => {
        const actual = $field.is('input') ? String($field.val()) : $field.text();
        expect(actual.trim().toLowerCase(), label).to.eq(String(expectedValue).toLowerCase());
      });
  });

  Cypress.Commands.add('verifyMuiAutocompleteValue', (label, expectedValue) => {
    cy.contains('label', label, { matchCase: false })
      .siblings('.MuiInputBase-root')
      .find('input')
      .invoke('val')
      .then((actualValue) => {
        expect(String(actualValue).toLowerCase()).to.eq(String(expectedValue).toLowerCase());
      });
  });

  // chooseMuiDatePicker(label, day, month, year) or (label, { day, month, year })
  // or (label, Date). Missing month/year default to the current ones. Delegates
  // to selectDateFromCalendar, which jumps to the year then steps months, for
  // both the MUI X v8 popper and the legacy modal picker.
  // Object form: { day, month, year, editable } (editable: see fieldLabel).
  Cypress.Commands.add('chooseMuiDatePicker', (label, dateOrDay, month, year) => {
    let day = dateOrDay;
    let editable = false;
    if (dateOrDay instanceof Date) {
      day = dateOrDay.getDate();
      month = dateOrDay.getMonth() + 1;
      year = dateOrDay.getFullYear();
    } else if (dateOrDay && typeof dateOrDay === 'object') {
      ({ day, month, year, editable = false } = dateOrDay);
    }
    const today = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const dmy = `${pad(+day)}-${pad(+(month ?? today.getMonth() + 1))}-${year ?? today.getFullYear()}`;
    cy.selectDateFromCalendar(label, dmy, { editable });
  });

  Cypress.Commands.add('verifyMuiDatePickerValue', (label, expectedValue, options = {}) => {
    cy.assertMuiDatePickerValue(label, expectedValue, options);
  });

  // Opens the page of a menu entry by URL (see support/routes.js); only an entry
  // with no known route is reached by clicking through the menu.
  Cypress.Commands.add('goToSubMenu', (menu, submenu) => {
    const route = routeFor(submenu);
    if (route) {
      cy.visit(route);
      return;
    }
    cy.contains(menu).click();
    cy.contains('a', submenu).click();
  });

  // A row shows its value as text, or - in fe-core picker dialogs (Picker's FakeInput) -
  // as the value of a read-only input, which cy.contains does not search.
  // The row is a search result: wait for the server (a picker also debounces its search).
  Cypress.Commands.add('openRowByValue', (value) => {
    const wanted = String(value).toLowerCase();
    const matches = (tr) => tr.innerText.toLowerCase().includes(wanted)
      || [...tr.querySelectorAll('input')].some((input) => input.value.toLowerCase().includes(wanted));
    cy.get('tr')
      // the innermost matching row, not a row of an enclosing table
      .filter((_, tr) => matches(tr) && ![...tr.querySelectorAll('tr')].some(matches), { timeout: TIMEOUTS.SERVER_RESULT })
      .first()
      .dblclick({ force: true });
  });
}
