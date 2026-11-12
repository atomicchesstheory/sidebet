/**
 * Supabase / Postgres helpers (uses DATABASE_URL):
 *   npm run db:migrate                 apply supabase/migrations/*.sql
 *   npm run db:seed                    seed the three fictional demos (needs SUPABASE_SERVICE_ROLE_KEY)
 *   npm run make-admin -- <username>   promote an account to admin
 */
import { createPgDb, runMigrations, setDbFactory } from "../src/lib/server/db";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set.");
  process.exit(1);
}
const [cmd, arg] = process.argv.slice(2);

async function main() {
  const db = await createPgDb(url!);
  setDbFactory(async () => db);
  if (cmd === "migrate") {
    const applied = await runMigrations({ exec: (sql) => db.query(sql), query: db.query }, false);
    console.log(applied.length ? `Applied: ${applied.join(", ")}` : "Already up to date.");
  } else if (cmd === "make-admin") {
    if (!arg) throw new Error("Usage: npm run make-admin -- <username>");
    const rows = await db.query("update public.profiles set is_admin = true where username = $1 returning username", [arg.toLowerCase()]);
    console.log(rows.length ? `${arg} is now an admin.` : `No account named ${arg}. Sign up first.`);
  } else if (cmd === "seed") {
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const sbUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    if (!key || !sbUrl) throw new Error("Seeding Supabase needs NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.");
    const { createClient } = await import("@supabase/supabase-js");
    const sb = createClient(sbUrl, key, { auth: { persistSession: false } });
    const { seedDemo } = await import("../src/lib/server/seed");
    const r = await seedDemo(async (username, password, display) => {
      const { data, error } = await sb.auth.admin.createUser({
        email: `${username}@demo.sidebet.invalid`,
        password,
        email_confirm: true,
        user_metadata: { username, display_name: display },
      });
      if (error) throw error;
      return data.user.id;
    });
    console.log("Seeded demo contests:", r);
  } else {
    console.log("Commands: migrate | seed | make-admin <username>");
  }
  await db.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
