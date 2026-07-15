// Comma-separated list of emails allowed to access the dashboard.
// Set DASHBOARD_ALLOWED_EMAILS in your Vercel environment variables.
// Example: "brandon@yourdomain.com,admin@yourdomain.com"
function getAllowedEmails(): string[] {
  const raw = process.env.DASHBOARD_ALLOWED_EMAILS ?? "";
  return raw
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

export function isAllowedEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return getAllowedEmails().includes(email.trim().toLowerCase());
}
