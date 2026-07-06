export const FOLLOWUP_SCHEDULE_HOURS = [
  24,   // Follow-up 1: wait 24 hours after task creation
  24,   // Follow-up 2: wait 24 hours after follow-up 1
  12,   // Follow-up 3: wait 12 hours after follow-up 2
  6,    // Follow-up 4: wait 6 hours after follow-up 3
  4,    // Follow-up 5: wait 4 hours after follow-up 4
];

export const MAX_FOLLOWUPS = FOLLOWUP_SCHEDULE_HOURS.length; // 5

export function getNextFollowupDelayHours(
  currentFollowupCount: number
): number | null {
  if (currentFollowupCount >= MAX_FOLLOWUPS) return null;
  return FOLLOWUP_SCHEDULE_HOURS[currentFollowupCount];
}

export function calculateNextFollowupAt(
  currentFollowupCount: number,
  fromDate: Date = new Date()
): Date | null {
  const delayHours = getNextFollowupDelayHours(currentFollowupCount);
  if (delayHours === null) return null;

  const next = new Date(fromDate);
  next.setHours(next.getHours() + delayHours);
  return next;
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
