// Minimal openIMIS API client for the UAT scripts (Node side): GraphQL with a JWT,
// mutations awaited through their MutationLog, and authenticated REST uploads.

export const dayOffset = (days, from = new Date()) => {
  const d = new Date(from);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

// Relay ids are base64("TypeName:pk").
export const decodeId = (relayId) => Number(Buffer.from(relayId, "base64").toString().split(":")[1]);

export const graphqlLiteral = (value) => {
  if (Array.isArray(value)) return `[${value.map(graphqlLiteral).join(", ")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}: ${graphqlLiteral(v)}`).join(", ")}}`;
  }
  return JSON.stringify(value);
};

export class Api {
  constructor(baseUrl, label = "UAT") {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.url = `${this.baseUrl}/api/graphql`;
    this.label = label;
    // Cookies set by the server (the JWT cookie at login) and the CSRF token: a
    // server that enforces CSRF (release.openimis.org) refuses authenticated
    // requests without them, as the frontend sends them (fe-core actions.jsx).
    this.cookies = new Map();
    this.csrfToken = null;
  }

  async login({ username, password }) {
    const { tokenAuth } = await this.query(
      `mutation($u: String!, $p: String!) { tokenAuth(username: $u, password: $p) { token } }`,
      { u: username, p: password },
    );
    this.token = tokenAuth.token;
    try {
      const { getCsrfToken } = await this.query("mutation { getCsrfToken { csrfToken } }");
      this.csrfToken = getCsrfToken?.csrfToken ?? null;
    } catch {
      // A server without CSRF enforcement (the local UAT stack) works without it.
      this.csrfToken = null;
    }
    return this;
  }

  get authHeaders() {
    const headers = this.token ? { authorization: `Bearer ${this.token}` } : {};
    if (this.csrfToken) headers["x-csrftoken"] = this.csrfToken;
    if (this.cookies.size) headers.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    // Django compares the Referer with the host for a POST over HTTPS.
    headers.referer = `${this.baseUrl}/front/`;
    return headers;
  }

  keepCookies(res) {
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [k, ...v] = c.split(";")[0].split("=");
      this.cookies.set(k.trim(), v.join("="));
    }
  }

  async query(query, variables = {}) {
    const res = await fetch(this.url, {
      method: "POST",
      headers: { "content-type": "application/json", ...this.authHeaders },
      body: JSON.stringify({ query, variables }),
    });
    this.keepCookies(res);
    const body = await res.json();
    if (body.errors?.length) throw new Error(`GraphQL: ${body.errors.map((e) => e.message).join("; ")}`);
    return body.data;
  }

  // Runs a mutation and waits for its MutationLog: with async mutations the response
  // only means the request was queued. `inline` writes the input into the query, as
  // the frontend does: core's TinyInt cannot be passed as a variable
  // (TinyInt.coerce_int calls super() in a staticmethod).
  async mutate(name, inputType, input, { inline = false, allowError = false } = {}) {
    const clientMutationId = `uat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const full = { ...input, clientMutationId, clientMutationLabel: `${this.label}: ${name}` };
    if (inline) await this.query(`mutation { ${name}(input: ${graphqlLiteral(full)}) { clientMutationId } }`);
    else await this.query(`mutation($input: ${inputType}!) { ${name}(input: $input) { clientMutationId } }`, { input: full });
    for (let i = 0; i < 120; i += 1) {
      const { mutationLogs } = await this.query(
        `query($id: String!) { mutationLogs(clientMutationId: $id) { edges { node { status error } } } }`,
        { id: clientMutationId },
      );
      const log = mutationLogs.edges[0]?.node;
      if (log && log.status !== 0) {
        if (log.status === 1 && !allowError) throw new Error(`${name} failed: ${log.error}`);
        return log;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`${name} not processed within 60 s`);
  }

  // First node of the first connection in the answer, or null.
  async first(query, variables) {
    const data = await this.query(query, variables);
    return Object.values(data)[0]?.edges?.[0]?.node ?? null;
  }

  async one(query, variables) {
    const node = await this.first(query, variables);
    if (!node) throw new Error(`Not found: ${query.replace(/\s+/g, " ").slice(0, 80)} ${JSON.stringify(variables)}`);
    return node;
  }

  // multipart/form-data POST to a REST endpoint under /api (e.g. tools uploads).
  async upload(apiPath, fields, file) {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.append(k, String(v));
    if (file) form.append("file", new Blob([file.content], { type: file.type }), file.name);
    const res = await fetch(`${this.baseUrl}/api/${apiPath.replace(/^\//, "")}`, {
      method: "POST",
      headers: this.authHeaders,
      body: form,
    });
    this.keepCookies(res);
    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    if (!res.ok) throw new Error(`POST ${apiPath} failed (HTTP ${res.status}): ${text.slice(0, 300)}`);
    return body;
  }
}
