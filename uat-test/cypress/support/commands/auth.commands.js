import { TIMEOUTS } from '../constants';

export function registerAuthCommands() {
  Cypress.Commands.add('login', () => {
    // Clear cookies so we always land on a clean login page regardless of
    // the state the previous test left the browser in.
    cy.clearCookies();
    cy.visit('/front/login');

    cy.get('body', { timeout: TIMEOUTS.APP_LOAD })
      .should(($body) => {
        const loggedIn = $body.find('button:is([title="Log out"],[aria-label="Log out"])').length > 0
          || $body.text().includes('Welcome Admin Admin!');
        const onLoginPage = $body.find('input[type="password"]').length > 0
          || $body.find('button').toArray().some((el) => el.textContent.trim() === 'Log In');
        expect(
          loggedIn || onLoginPage,
          'frontend authenticated shell or login page should be visible',
        ).to.be.true;
      })
      .then(($body) => {
        const loggedIn = $body.find('button:is([title="Log out"],[aria-label="Log out"])').length > 0
          || $body.text().includes('Welcome Admin Admin!');

        if (loggedIn) {
          return;
        }

        cy.fixture('cred').then((cred) => {
          // Use force:true — a "Session Expired" dialog may cover the
          // login form after an admin-interface logout.
          cy.get('input[type="text"]', { timeout: TIMEOUTS.APP_LOAD })
            .first()
            .clear({ force: true })
            .type(cred.username, { force: true });
          cy.get('input[type="password"]')
            .first()
            .clear({ force: true })
            .type(cred.password, { force: true });
          cy.get('button[type="submit"]').click({ force: true });
          cy.contains('Welcome Admin Admin!', { timeout: TIMEOUTS.APP_LOAD }).should('be.visible');
        });
      });
  });

  Cypress.Commands.add('logout', () => {
    cy.visit('/front');

    // Wait until the SPA has settled: either the logout button is in the navbar
    // (logged in) or the login form is visible (already logged out).
    cy.get('body', { timeout: TIMEOUTS.APP_LOAD })
      .should(($body) => {
        const loggedIn = $body.find('button:is([title="Log out"],[aria-label="Log out"])').length > 0;
        const onLoginPage = $body.find('input[type="password"]').length > 0
          || $body.find('button').toArray().some((el) => el.textContent.trim() === 'Log In');
        expect(loggedIn || onLoginPage, 'app should show logout button or login form').to.be.true;
      })
      .then(($body) => {
        if ($body.find('button:is([title="Log out"],[aria-label="Log out"])').length > 0) {
          cy.get('button:is([title="Log out"],[aria-label="Log out"])').click();
          cy.contains('button', 'Log In', { timeout: TIMEOUTS.APP_LOAD }).should('be.visible');
          return;
        }

        // Already logged out — just confirm login state
        cy.visit('/front/login');
        cy.contains('button', 'Log In', { timeout: TIMEOUTS.APP_LOAD }).should('be.visible');
      });
  });

  Cypress.Commands.add('loginAdminInterface', () => {
    // Start from no session: after a front login, /api/admin/ shows "Site administration"
    // with no login form, yet the model pages still redirect to the login. Only the
    // admin's own login gives a session the whole admin accepts. (cy.login, for the
    // front, clears the cookies in turn.)
    // On release the first POST is sometimes refused (CSRF/session race just after the
    // front's session was dropped): the login page comes back. Log in once more then.
    const ADMIN_HOME = 'Site administration';
    const attempt = (retry) => {
      cy.clearCookies();
      cy.visit('/api/admin/');
      cy.fixture('cred').then((cred) => {
        cy.get('input[type="text"]').type(cred.username);
        cy.get('input[type="password"]').type(cred.password, { log: false });
        cy.get('input[type="submit"]').click();
      });
      // Wait for the answer to the POST: the admin home, or a refusal (Django's CSRF 403
      // page, or the login form again with an error).
      cy.get('body', { timeout: TIMEOUTS.APP_LOAD })
        .should(($body) => {
          const answered = $body.find('.errornote').length > 0
            || new RegExp(`${ADMIN_HOME}|CSRF verification failed|Forbidden`).test($body.text());
          expect(answered, 'admin login answered').to.be.true;
        })
        .then(($body) => {
          if ($body.text().includes(ADMIN_HOME) || !retry) {
            cy.contains(ADMIN_HOME).should('be.visible');
          } else {
            attempt(false);
          }
        });
    };
    attempt(true);
  });

  Cypress.Commands.add('logoutAdminInterface', () => {
    cy.visit('/api/admin');
    cy.get('body').then(($body) => {
      if ($body.find('button:contains("Log out"), a:contains("Log out")').length > 0) {
        cy.contains('button, a', 'Log out').click();
      }
    });
  });
}
