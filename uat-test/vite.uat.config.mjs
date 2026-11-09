// Second frontend dev server for UAT, next to the regular one: same assembly and
// modules (../frontend/vite.config.js, which the openIMIS generators rewrite, so it
// is wrapped rather than copied) on another port, with /api sent to the UAT backend.
//
//   cd ../frontend && npx vite --config ../uat-test/vite.uat.config.mjs
//
// UAT_FRONTEND_PORT (default 3001) and UAT_API_TARGET (default http://localhost:8001)
// override the defaults.
import path from "node:path";
import { fileURLToPath } from "node:url";
import baseConfig from "../frontend/vite.config.js";

const UAT_DIR = path.dirname(fileURLToPath(import.meta.url));

export default (env) => {
  const config = baseConfig(env);
  const port = Number(process.env.UAT_FRONTEND_PORT ?? 3001);
  const apiTarget = process.env.UAT_API_TARGET ?? "http://localhost:8001";
  const proxy = {
    ...config.server.proxy,
    "/api": {
      ...config.server.proxy["/api"],
      target: apiTarget,
      // Django admin views keep csrf_protect even in DEV, and settings/dev.py only
      // trusts :3000/:8000. Behind nginx the browser and the API share one origin;
      // present the API's own origin so the check sees the same thing here.
      configure: (proxy) => {
        proxy.on("proxyReq", (proxyReq) => {
          if (proxyReq.getHeader("origin")) proxyReq.setHeader("origin", apiTarget);
        });
      },
    },
  };
  return {
    ...config,
    // The assembly config forces dependency pre-bundling on every start; with the
    // default cacheDir both dev servers would rewrite the same node_modules/.vite/deps
    // under each other.
    cacheDir: "node_modules/.vite-uat",
    build: { ...config.build, outDir: path.join(UAT_DIR, "dist"), emptyOutDir: true },
    server: { ...config.server, port, strictPort: true, proxy },
    // `vite preview` serves the production build (UAT_FRONTEND_MODE=build in
    // start-uat-stack.sh): one bundle instead of ~500 dev modules per page load.
    preview: { port, strictPort: true, proxy },
    plugins: [
      ...(config.plugins ?? []),
      {
        // The dev server (and nginx in a deployment) redirects /front to /front/;
        // `vite preview` answers 404, and specs visit /front.
        name: "uat-base-redirect",
        configurePreviewServer(server) {
          const base = (config.base ?? "/").replace(/\/$/, "");
          server.middlewares.use((req, res, next) => {
            if (base && req.url === base) {
              res.statusCode = 301;
              res.setHeader("Location", `${base}/`);
              res.end();
              return;
            }
            next();
          });
        },
      },
    ],
  };
};
