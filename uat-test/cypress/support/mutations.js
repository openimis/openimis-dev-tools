// Tracks the GraphQL mutations the app sends so a spec can wait for the one it
// just triggered to be *processed*, not merely accepted. With core.async_mutations
// the HTTP response only means a MutationLog row exists; completion is the log
// status leaving RECEIVED (0 = received, 1 = error, 2 = success).

import { TIMEOUTS } from './constants';

const CLIENT_MUTATION_ID = /clientMutationId:\s*"([^"]+)"/;
const tracker = { sent: [], consumed: 0 };

function recordMutation(body) {
  let payload = body;
  if (typeof body === 'string') {
    try { payload = JSON.parse(body); } catch { return; }
  }
  const query = payload?.query;
  if (!/^\s*mutation\b/.test(query ?? '')) return;
  // fe-core formatMutation inlines the id in the query; graphqlMutation passes it
  // as a variable (variables.input.clientMutationId).
  const id = payload?.variables?.input?.clientMutationId ?? query.match(CLIENT_MUTATION_ID)?.[1];
  if (id) tracker.sent.push(id);
}

// Wraps the page's fetch on every page load. Unlike cy.intercept, which Cypress clears
// between tests, the listener also sees mutations sent from a nested describe's
// before() hook (it runs before the root beforeEach could register an intercept).
export function trackMutations() {
  Cypress.on('window:before:load', (win) => {
    const fetch = win.fetch.bind(win);
    win.fetch = (input, init = {}) => {
      const isRequest = input instanceof win.Request;
      const url = isRequest ? input.url : String(input);
      const method = (init.method ?? (isRequest ? input.method : 'GET')).toUpperCase();
      if (/\/api\/graphql\b/.test(url) && method === 'POST') {
        if (init.body !== undefined) recordMutation(init.body);
        else if (isRequest) input.clone().text().then(recordMutation);
      }
      return fetch(input, init);
    };
  });
}

export function registerMutationCommands() {
  // Polls the MutationLog of one clientMutationId until it is processed; yields its status and error.
  Cypress.Commands.add('waitForMutationLog', (clientMutationId, { timeout = 5000, interval = 500 } = {}) => {
    const deadline = Date.now() + timeout;
    const poll = () =>
      cy
        .request({
          method: 'POST',
          url: '/api/graphql',
          body: { query: `{ mutationLogs(clientMutationId: "${clientMutationId}") { edges { node { status error } } } }` },
          log: false,
        })
        .then(({ body }) => {
          const node = body?.data?.mutationLogs?.edges?.[0]?.node;
          if (node && node.status !== 0) {
            Cypress.log({ name: 'mutation', message: `${clientMutationId} → ${node.status === 2 ? 'success' : 'error'}` });
            return { status: node.status, error: node.error };
          }
          if (Date.now() > deadline) throw new Error(`Mutation ${clientMutationId} not processed within ${timeout} ms`);
          // eslint-disable-next-line cypress/no-unnecessary-waiting
          return cy.wait(interval, { log: false }).then(poll);
        });
    return poll();
  });

  // Waits until every mutation sent since the previous call is processed, then until the
  // journal shows nothing in progress. Fails if no mutation was sent at all.
  Cypress.Commands.add('waitForSentMutations', ({ timeout = 5000 } = {}) => {
    cy.wrap(tracker, { log: false, timeout })
      .should((t) => expect(t.sent.length, 'a mutation was sent').to.be.greaterThan(t.consumed))
      .then((t) => {
        const ids = t.sent.slice(t.consumed);
        t.consumed = t.sent.length;
        ids.forEach((id) => cy.waitForMutationLog(id));
      });
    // The server outcome is asserted above; the journal polls it every 2 s and may lag behind.
    cy.get('ul.MuiList-root li [role="progressbar"]', { timeout: Math.max(timeout, TIMEOUTS.SERVER_RESULT) }).should('not.exist');
  });
}
