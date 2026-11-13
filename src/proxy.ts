import { NextResponse, type NextRequest } from "next/server";

/**
 * Supabase mode only: refresh the auth session cookie on navigation so server
 * components always see a valid user. Demo mode uses a signed local cookie.
 */
export async function proxy(request: NextRequest) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key || !(process.env.DATABASE_URL || process.env.POSTGRES_URL)) return NextResponse.next();
  const { createServerClient } = await import("@supabase/ssr");
  let response = NextResponse.next({ request });
  const sb = createServerClient(url, key, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (list) => {
        for (const { name, value } of list) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of list) response.cookies.set(name, value, options);
      },
    },
  });
  // getClaims() refreshes an expired session and verifies the JWT.
  await sb.auth.getClaims();
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|icon.svg|api/live|api/cron).*)"],
};
