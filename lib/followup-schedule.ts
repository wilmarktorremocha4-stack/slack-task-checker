// All follow-ups are 24 hours apart (uniform — no escalating hours)
// Weekends are skipped: if the next follow-up falls on Sat or Sun,
// it is pushed forward to Monday at the same time of day.
// The assignee's timezone is respected when checking for weekends.

export const FOLLOWUP_INTERVAL_HOURS = 24;
export const MAX_FOLLOWUPS = 5;

function skipWeekend(date: Date, timezone: string): Date {
  let result = new Date(date);

  const localDay = new Date(
    result.toLocaleString("en-US", { timeZone: timezone })
  ).getDay();

  if (localDay === 6) {
    // Saturday → push to Monday (add 2 days)
    result = new Date(result.getTime() + 2 * 24 * 60 * 60 * 1000);
  } else if (localDay === 0) {
    // Sunday → push to Monday (add 1 day)
    result = new Date(result.getTime() + 1 * 24 * 60 * 60 * 1000);
  }

  return result;
}

export function calculateNextFollowupAt(
  currentFollowupCount: number,
  fromDate: Date = new Date(),
  timezone: string = "America/New_York"
): Date | null {
  if (currentFollowupCount >= MAX_FOLLOWUPS) return null;

  const candidate = new Date(
    fromDate.getTime() + FOLLOWUP_INTERVAL_HOURS * 60 * 60 * 1000
  );

  return skipWeekend(candidate, timezone);
}

export function getFollowupUrgency(
  followupNumber: number
): "gentle" | "friendly" | "firm" | "urgent" | "final" {
  if (followupNumber === 1) return "gentle";
  if (followupNumber === 2) return "friendly";
  if (followupNumber === 3) return "firm";
  if (followupNumber === 4) return "urgent";
  return "final";
}

export function getNextFollowupDelayHours(): number {
  return FOLLOWUP_INTERVAL_HOURS;
}
