#!/usr/bin/env node
// Reads and writes openIMIS ModuleConfiguration rows (and clears django-axes login
// failures) through the Django admin, so it
// works against any target that exposes /api/admin (Vite dev proxy or docker stack).
// Saving through the admin calls ModuleConfiguration.save(), which hot-reloads the
// modules that register a reloader (individual, social_protection,
// grievance_social_protection); other modules only read their config at startup.
//
// CLI:
//   node scripts/module-config.mjs show    [--base-url URL]
//   node scripts/module-config.mjs backup  --file out.json [--base-url URL]
//   node scripts/module-config.mjs pin     [--file uat/module-config.pinned.json] [--base-url URL]
//   node scripts/module-config.mjs restore --file backup.json [--base-url URL]
//   node scripts/module-config.mjs reset-lockout [--base-url URL]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const PINNED_PROFILE = path.join(ROOT, "uat", "module-config.pinned.json");
const LIST_PATH = "/api/admin/core/moduleconfiguration/";

const unescapeHtml = (s) =>
  s
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

export class AdminClient {
  constructor(baseUrl, { username, password }) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.credentials = { username, password };
    this.cookies = new Map();
  }

  async request(urlPath, { method = "GET", form } = {}) {
    const headers = {
      Cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "),
      // Django's CSRF check compares the Referer with the host on POST.
      Referer: this.baseUrl + urlPath,
    };
    let body;
    if (form) {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      // An array of [key, value] pairs allows repeated keys (admin bulk actions).
      body = new URLSearchParams(form).toString();
    }
    const res = await fetch(this.baseUrl + urlPath, { method, headers, body, redirect: "manual" });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(";");
      const [k, ...v] = pair.split("=");
      this.cookies.set(k.trim(), v.join("="));
    }
    return { status: res.status, location: res.headers.get("location"), text: await res.text() };
  }

  csrfFrom(html) {
    const m = html.match(/name="csrfmiddlewaretoken" value="([^"]+)"/);
    if (!m) throw new Error("No CSRF token in admin page");
    return m[1];
  }

  async login() {
    const page = await this.request("/api/admin/login/");
    const res = await this.request("/api/admin/login/?next=/api/admin/", {
      method: "POST",
      form: { csrfmiddlewaretoken: this.csrfFrom(page.text), ...this.credentials, next: "/api/admin/" },
    });
    if (res.status !== 302) {
      const locked = /Too many failed|locked/i.test(res.text);
      throw new Error(
        locked
          ? `Login is locked out by django-axes (LOGIN_LOCKOUT_FAILURE_LIMIT reached for this IP). Wait LOGIN_LOCKOUT_COOLOFF_TIME minutes, or raise the limit / set AXES_ENABLED=false on the backend used for UAT.`
          : `Django admin login failed for ${this.credentials.username} (HTTP ${res.status})`,
      );
    }
  }

  async list() {
    const page = await this.request(LIST_PATH);
    if (page.status !== 200) throw new Error(`Cannot list module configurations (HTTP ${page.status})`);
    const ids = [...new Set([...page.text.matchAll(/moduleconfiguration\/([0-9a-f-]{36})\/change\//g)].map((m) => m[1]))];
    const rows = [];
    for (const id of ids) {
      const { text } = await this.request(`${LIST_PATH}${id}/change/`);
      const field = (name) => text.match(new RegExp(`name="${name}" value="([^"]*)"`))?.[1] ?? "";
      const configText = text.match(/<textarea name="config"[^>]*>([\s\S]*?)<\/textarea>/)?.[1] ?? "";
      rows.push({
        id,
        module: unescapeHtml(field("module")),
        layer: text.match(/<option value="(fe|be)" selected>/)?.[1] ?? "be",
        version: unescapeHtml(field("version")),
        is_exposed: /name="is_exposed"[^>]*checked/.test(text),
        is_disabled_until: [field("is_disabled_until_0"), field("is_disabled_until_1")],
        // Django renders the textarea content with a leading newline.
        config: unescapeHtml(configText).replace(/^\r?\n/, ""),
      });
    }
    return rows;
  }

  async remove(id) {
    const page = await this.request(`${LIST_PATH}${id}/delete/`);
    const res = await this.request(`${LIST_PATH}${id}/delete/`, {
      method: "POST",
      form: { csrfmiddlewaretoken: this.csrfFrom(page.text), post: "yes" },
    });
    if (res.status !== 302) throw new Error(`Delete of module configuration ${id} failed (HTTP ${res.status})`);
  }

  async create({ module, layer, version = "1", config, is_exposed = false, is_disabled_until = ["", ""] }) {
    const page = await this.request(`${LIST_PATH}add/`);
    const form = {
      csrfmiddlewaretoken: this.csrfFrom(page.text),
      module,
      layer,
      version: String(version),
      config: typeof config === "string" ? config : JSON.stringify(config, null, 2),
      is_disabled_until_0: is_disabled_until[0],
      is_disabled_until_1: is_disabled_until[1],
      _save: "Save",
    };
    if (is_exposed) form.is_exposed = "on";
    const res = await this.request(`${LIST_PATH}add/`, { method: "POST", form });
    if (res.status !== 302) {
      // The admin re-renders the form with errors (e.g. a module validator refusing the config).
      const errors = [...res.text.matchAll(/<ul class="errorlist[^"]*">([\s\S]*?)<\/ul>/g)].map((m) => m[1].replace(/<[^>]+>/g, " ").trim());
      throw new Error(`Cannot save ${module}/${layer} configuration: ${errors.join("; ") || `HTTP ${res.status}`}`);
    }
  }

  // Deletes every django-axes AccessAttempt. Lockout is per IP and the whole suite shares
  // one IP, so the deliberate failed logins of the auth tests would otherwise lock out
  // every later spec once LOGIN_LOCKOUT_FAILURE_LIMIT is reached.
  async resetLoginFailures() {
    const listPath = "/api/admin/axes/accessattempt/";
    const page = await this.request(listPath);
    if (page.status !== 200) throw new Error(`Cannot list axes access attempts (HTTP ${page.status})`);
    const ids = [...page.text.matchAll(/name="_selected_action" value="([^"]+)"/g)].map((m) => m[1]);
    // One at a time: the bulk delete_selected action answers HTTP 500 on release.openimis.org.
    for (const id of ids) {
      const confirm = await this.request(`${listPath}${id}/delete/`);
      const res = await this.request(`${listPath}${id}/delete/`, {
        method: "POST",
        form: { csrfmiddlewaretoken: this.csrfFrom(confirm.text), post: "yes" },
      });
      if (res.status !== 302) throw new Error(`Cannot delete axes access attempt ${id} (HTTP ${res.status})`);
    }
    return ids.length;
  }

  // Leaves exactly one row per (module, layer) of the profile; "absent" entries fall back to code defaults.
  async apply(entries) {
    const current = await this.list();
    for (const entry of entries) {
      for (const row of current.filter((r) => r.module === entry.module && r.layer === entry.layer)) await this.remove(row.id);
      if (!entry.absent) await this.create(entry);
    }
  }
}

function loadProfile(file) {
  // `configFile` entries keep large configurations (e.g. the fe-core menu) in their own file.
  return JSON.parse(fs.readFileSync(file, "utf8")).configs.map(({ configFile, source, ...entry }) =>
    configFile ? { ...entry, config: JSON.parse(fs.readFileSync(path.resolve(path.dirname(file), configFile), "utf8")) } : entry,
  );
}

export async function connect(baseUrl, credentials) {
  const client = new AdminClient(baseUrl, credentials);
  await client.login();
  return client;
}

export async function pin(baseUrl, credentials, file = PINNED_PROFILE) {
  const entries = loadProfile(file);
  await (await connect(baseUrl, credentials)).apply(entries);
  return entries.map((e) => `${e.module}/${e.layer}${e.absent ? " (defaults)" : ""}`);
}

export async function resetLoginFailures(baseUrl, credentials) {
  return (await connect(baseUrl, credentials)).resetLoginFailures();
}

export async function backup(baseUrl, credentials, file) {
  const rows = await (await connect(baseUrl, credentials)).list();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ takenAt: new Date().toISOString(), baseUrl, configs: rows }, null, 1));
  return rows.length;
}

// Puts every (module, layer) touched by the pinned profile or present in the backup back
// to its backed-up state, deleting rows that did not exist at backup time.
export async function restore(baseUrl, credentials, file, pinnedFile = PINNED_PROFILE) {
  const saved = JSON.parse(fs.readFileSync(file, "utf8")).configs;
  const client = await connect(baseUrl, credentials);
  const current = await client.list();
  const keys = new Set([...saved, ...current, ...loadProfile(pinnedFile)].map((r) => `${r.module}|${r.layer}`));
  for (const key of keys) {
    const [module, layer] = key.split("|");
    const before = saved.filter((r) => r.module === module && r.layer === layer);
    const now = current.filter((r) => r.module === module && r.layer === layer);
    const unchanged = before.length === now.length && before.every((b, i) => b.config === now[i]?.config && b.is_exposed === now[i]?.is_exposed);
    if (unchanged) continue;
    for (const row of now) await client.remove(row.id);
    for (const row of before) await client.create(row);
  }
}

async function cli() {
  const [cmd, ...rest] = process.argv.slice(2);
  const opt = (name, dflt) => {
    const i = rest.indexOf(`--${name}`);
    return i >= 0 ? rest[i + 1] : dflt;
  };
  const baseUrl = opt("base-url", process.env.CYPRESS_BASE_URL ?? "http://localhost:3001");
  const credentials = JSON.parse(fs.readFileSync(path.join(ROOT, "cypress", "fixtures", "cred.json"), "utf8"));
  const file = opt("file");
  if (cmd === "show") {
    for (const r of await (await connect(baseUrl, credentials)).list()) console.log(`${r.module}/${r.layer} v${r.version}${r.is_exposed ? " exposed" : ""}\n  ${r.config.replace(/\s+/g, " ").slice(0, 300)}`);
  } else if (cmd === "reset-lockout") {
    console.log(`Cleared ${await resetLoginFailures(baseUrl, credentials)} axes access attempt(s)`);
  } else if (cmd === "backup") {
    if (!file) throw new Error("--file is required");
    console.log(`Backed up ${await backup(baseUrl, credentials, file)} configuration(s) to ${file}`);
  } else if (cmd === "pin") {
    console.log(`Pinned: ${(await pin(baseUrl, credentials, file ?? PINNED_PROFILE)).join(", ")}`);
  } else if (cmd === "restore") {
    if (!file) throw new Error("--file is required");
    await restore(baseUrl, credentials, file);
    console.log(`Restored module configurations from ${file}`);
  } else {
    console.log(fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(8, 14).join("\n"));
    process.exit(cmd ? 1 : 0);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  cli().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
