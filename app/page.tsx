import { redirect } from "next/navigation";

// The dashboard is the app. proxy.ts bounces unauthenticated visitors to /login.
export default function Home() {
  redirect("/dashboard");
}
