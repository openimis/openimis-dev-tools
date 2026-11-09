// Outside MODE=dev (release.openimis.org runs the prod settings, CSRF_USE_SESSIONS)
// every GraphQL mutation and list query needs an X-CSRFToken header matching the
// session's token, or it fails with "CSRF token missing or incorrect." On a dev backend
// the check is skipped and the header is harmless.
//
// The session holds one token: each getCsrfToken call replaces it, so the token the app
// stored in localStorage ("csrfToken") at login stops working. The specs' cy.request
// calls to /api/graphql therefore reuse the app's token, and only when there is none or
// it is refused fetch a new one, written back to localStorage for the app to use too.

const STORAGE_KEY = 'csrfToken';
const CSRF_ERROR = /CSRF token missing or incorrect/;

const isGraphql = (options) =>
  typeof options === 'object' && /\/api\/graphql\b/.test(options.url ?? '') && (options.method ?? 'GET').toUpperCase() === 'POST';

const hasCsrfHeader = (headers = {}) => Object.keys(headers).some((h) => h.toLowerCase() === 'x-csrftoken');

const isCsrfRefusal = ({ body }) => CSRF_ERROR.test(JSON.stringify(body?.errors ?? body ?? ''));

// The app stores the token JSON-encoded (fe-core helpers/useLocalStorage.js). Before the
// first visit the window is on another origin and its storage throws: no token then.
const readToken = (win) => {
  try {
    const item = win.localStorage.getItem(STORAGE_KEY);
    return item ? JSON.parse(item) : null;
  } catch {
    return null;
  }
};

const writeToken = (win, token) => {
  try {
    if (token) win.localStorage.setItem(STORAGE_KEY, JSON.stringify(token));
  } catch {
    // A window on another origin (before the first visit): the app fetches its own.
  }
};

// Plain promises from here on: these run inside the overwritten cy.request, where a
// cy command (cy.window) would not be chained and its result would not be the token.
const fetchToken = (originalFn, url, win) => originalFn({
  method: 'POST',
  url,
  body: { query: 'mutation { getCsrfToken { csrfToken } }' },
  failOnStatusCode: false,
  log: false,
}).then(({ body }) => {
  const token = body?.data?.getCsrfToken?.csrfToken ?? null;
  writeToken(win, token);
  return token;
});

const withToken = (options, token) => (token ? { ...options, headers: { ...options.headers, 'X-CSRFToken': token } } : options);

export function addCsrfToGraphqlRequests() {
  Cypress.Commands.overwrite('request', (originalFn, ...args) => {
    const options = args[0];
    if (args.length !== 1 || !isGraphql(options) || hasCsrfHeader(options.headers)) {
      return originalFn(...args);
    }
    return cy.window({ log: false }).then((win) => {
      const refreshAndSend = () => fetchToken(originalFn, options.url, win)
        .then((token) => originalFn(withToken(options, token)));
      const token = readToken(win);
      if (!token) return refreshAndSend();
      return originalFn({ ...withToken(options, token), failOnStatusCode: false }).then((res) => {
        if (isCsrfRefusal(res)) return refreshAndSend();
        if (options.failOnStatusCode !== false && res.status >= 400) {
          // Same failure the caller would have had without the CSRF handling.
          return originalFn(withToken(options, token));
        }
        return res;
      });
    });
  });
}
