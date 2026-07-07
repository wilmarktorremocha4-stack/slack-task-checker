// Only these people can access the dashboard.
export const ALLOWED_EMAILS = [
  "wil@operationamz.com",
  "brandon@operationamz.com",
  "brandon@firesidetrade.com",
];

export function isAllowedEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return ALLOWED_EMAILS.includes(email.trim().toLowerCase());
}
