// Only these people can access the dashboard.
export const ALLOWED_EMAILS = [
  "wilmarktorremocha4@gmail.com",
  "wil@operationamz.com",
  "brandon@operationamz.com",
];

export function isAllowedEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return ALLOWED_EMAILS.includes(email.trim().toLowerCase());
}
