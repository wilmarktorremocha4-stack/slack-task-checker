import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { isAllowedEmail } from "@/lib/auth";

// Paths that require a logged-in, allowlisted user.
// Slack webhooks (signature-verified) and cron (CRON_SECRET) stay open.
const PROTECTED_PAGES = ["/dashboard", "/reset-password"];
const PROTECTED_APIS = ["/api/dashboard", "/api/slack/users", "/api/tasks"];

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  const isProtectedPage = PROTECTED_PAGES.some(p => pathname.startsWith(p));
  const isProtectedApi = PROTECTED_APIS.some(p => pathname.startsWith(p));

  if (!isProtectedPage && !isProtectedApi) {
    return NextResponse.next();
  }

  // Machine-to-machine calls (cron-job.org hitting GET /api/tasks) use a
  // bearer token that the route itself validates against CRON_SECRET.
  if (isProtectedApi && request.headers.get("authorization")?.startsWith("Bearer ")) {
    return NextResponse.next();
  }

  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const authorized = user && isAllowedEmail(user.email);

  if (!authorized) {
    if (isProtectedApi) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const loginUrl = new URL("/login", request.url);
    if (user) loginUrl.searchParams.set("error", "not_allowed");
    return NextResponse.redirect(loginUrl);
  }

  return response;
}

export const config = {
  matcher: [
    "/dashboard/:path*",
    "/reset-password",
    "/api/dashboard/:path*",
    "/api/slack/users",
    "/api/tasks/:path*",
    "/api/tasks",
  ],
};
