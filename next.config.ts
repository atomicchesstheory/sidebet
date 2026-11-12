import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // PGlite (demo database) and pg ship native/wasm assets; keep them out of the bundle.
  serverExternalPackages: ["@electric-sql/pglite", "pg"],
  outputFileTracingIncludes: {
    "/**": ["./supabase/**/*.sql", "./fixtures/**/*"],
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
