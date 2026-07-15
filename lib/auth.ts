// Always-allowed accounts — no env var needed.
const HARDCODED_ALLOWED = ["brandon@firesidetrade.com", "wilmarktorremocha4@gmail.com"];

// Comma-separated list of emails allowed to access the dashboard.
// Set DASHBOARD_ALLOWED_EMAILS in your Vercel environment variables.
function getAllowedEmails(): string[] {
  const raw = process.env.DASHBOARD_ALLOWED_EMAILS ?? "";
  return raw
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

export function isAllowedEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const normalized = email.trim().toLowerCase();
  return HARDCODED_ALLOWED.includes(normalized) || getAllowedEmails().includes(normalized);
}
