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

// The clientMutationId of the last mutation the page sent, or undefined.
export const lastSentMutationId = () => tracker.sent[tracker.sent.length - 1];

// The journal is the user's, not the spec's: every spec logs in as the same user, so
// in a parallel run the journal also lists what the other specs sent, and a pending
// entry jumps to the top each time it is polled. Its rows show only a label and a
// minute, so a row is told apart by the mutation it renders. fe-core JournalDrawer
// keys each row "mutation-label<index>" (inside a "mutation<index>" fragment) in the
// displayedMutations of MutationList; the React fiber of the <li> leads to both.
// Returns that mutation, or null for a row that is not a mutation (the "more" row).
export function journalMutationOf(li) {
  const fiberKey = Object.keys(li).find((key) => key.startsWith('__reactFiber$'));
  let index = null;
  for (let fiber = fiberKey ? li[fiberKey] : null; fiber; fiber = fiber.return) {
    const match = index === null && /^mutation(?:-label)?(\d+)$/.exec(fiber.key ?? '');
    if (match) index = Number(match[1]);
    const mutations = fiber.memoizedProps?.displayedMutations;
    if (Array.isArray(mutations)) return index === null ? null : mutations[index] ?? null;
  }
  return null;
}

// The journal rows of the given clientMutationIds. Fails when no row at all can be
// mapped to its mutation, so a change of the JournalDrawer markup is reported as such
// instead of reading as "entry not found".
function journalRowsOf($rows, ids) {
  const mapped = $rows.toArray().map((li) => [li, journalMutationOf(li)]);
  expect(
    mapped.some(([, m]) => m),
    'journal rows mapped to their mutation (fe-core JournalDrawer changed?)',
  ).to.be.true;
  return Cypress.$(mapped.filter(([, m]) => ids.includes(m?.clientMutationId)).map(([li]) => li));
}

const JOURNAL_ROWS = 'ul.MuiList-root li.jrnlItem';

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
    const serverTimeout = Math.max(timeout, TIMEOUTS.SERVER_RESULT);
    cy.wrap(tracker, { log: false, timeout })
      .should((t) => expect(t.sent.length, 'a mutation was sent').to.be.greaterThan(t.consumed))
      .then((t) => {
        const ids = t.sent.slice(t.consumed);
        t.consumed = t.sent.length;
        // Processing is server work: a save touching hundreds of rows takes seconds.
        ids.forEach((id) => cy.waitForMutationLog(id, { timeout: serverTimeout }));
        // The server outcome is asserted above; the journal polls it every 2 s and may lag
        // behind. Only these mutations' rows count: another spec's may still be processing.
        cy.get('body', { timeout: serverTimeout }).should(($body) => {
          const $rows = $body.find(JOURNAL_ROWS);
          const $busy = $rows.length ? journalRowsOf($rows, ids).filter((_, li) => Cypress.$(li).find('[role="progressbar"]').length) : $rows;
          expect($busy.length, 'journal entries of the sent mutations still in progress').to.eq(0);
        });
      });
  });

  // Yields the journal row of the last mutation the page sent, once the journal shows it.
  // Optionally retries `check($row)` with it until it passes.
  Cypress.Commands.add('journalEntryOfLastMutation', (check = () => {}) => {
    const id = lastSentMutationId();
    expect(id, 'a mutation sent by the page').to.be.a('string');
    return cy.get(JOURNAL_ROWS, { timeout: TIMEOUTS.SERVER_RESULT }).should(($rows) => {
      const $row = journalRowsOf($rows, [id]);
      expect($row.length, `journal entry of mutation ${id}`).to.eq(1);
      check($row);
    }).then(($rows) => journalRowsOf($rows, [id]));
  });
}
