import { WebClient } from "@slack/web-api";
import crypto from "crypto";

let _slack: WebClient | null = null;

export function getSlackClient(): WebClient {
  if (!_slack) {
    _slack = new WebClient(process.env.SLACK_BOT_TOKEN!);
  }
  return _slack;
}

export async function verifySlackSignature(
  request: Request,
  rawBody: string
): Promise<boolean> {
  const signingSecret = process.env.SLACK_SIGNING_SECRET!;
  const timestamp = request.headers.get("x-slack-request-timestamp");
  const slackSignature = request.headers.get("x-slack-signature");

  if (!timestamp || !slackSignature) return false;

  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - parseInt(timestamp)) > 300) return false;

  const sigBaseString = `v0:${timestamp}:${rawBody}`;
  const hmac = crypto.createHmac("sha256", signingSecret);
  hmac.update(sigBaseString);
  const computedSignature = `v0=${hmac.digest("hex")}`;

  try {
    return crypto.timingSafeEqual(
      Buffer.from(computedSignature),
      Buffer.from(slackSignature)
    );
  } catch {
    return false;
  }
}

export async function getSlackUserName(userId: string): Promise<string> {
  try {
    const slack = getSlackClient();
    const result = await slack.users.info({ user: userId });
    return (
      result.user?.profile?.display_name ||
      result.user?.profile?.real_name ||
      result.user?.name ||
      userId
    );
  } catch {
    return userId;
  }
}

export async function postThreadReply(
  channelId: string,
  threadTs: string,
  text: string,
  options?: { broadcast?: boolean }
): Promise<void> {
  const slack = getSlackClient();
  await slack.chat.postMessage({
    channel: channelId,
    thread_ts: threadTs,
    text,
    mrkdwn: true,
    reply_broadcast: options?.broadcast ?? false,
  });
}

// Post a message with a colored left-border stripe using Slack attachments.
// color: any hex like "#3B82F6" or Slack keywords "good", "warning", "danger"
// IMPORTANT: top-level `text` is intentionally omitted — Slack renders it in
// ADDITION to attachments, which doubles the message. The attachment's
// `fallback` field covers push/desktop notifications instead.
export async function postColoredMessage(
  channelId: string,
  threadTs: string,
  color: string,
  text: string,
  contextLine?: string,
  options?: { broadcast?: boolean }
): Promise<void> {
  const slack = getSlackClient();
  const blocks = contextLine
    ? [
        { type: "section", text: { type: "mrkdwn", text } },
        { type: "context", elements: [{ type: "mrkdwn", text: contextLine }] },
      ]
    : [{ type: "section", text: { type: "mrkdwn", text } }];

  await slack.chat.postMessage({
    channel: channelId,
    thread_ts: threadTs,
    reply_broadcast: options?.broadcast ?? false,
    attachments: [
      {
        color,
        fallback: text,
        blocks,
      },
    ],
  });
}

// Slack only notifies a user when the raw <@ID> syntax is used
export function slackMention(userId: string): string {
  return `<@${userId}>`;
}

export async function sendDirectMessage(
  userId: string,
  text: string
): Promise<void> {
  const slack = getSlackClient();
  const dmResult = await slack.conversations.open({ users: userId });
  const dmChannelId = dmResult.channel?.id;
  if (!dmChannelId) throw new Error("Could not open DM channel");

  await slack.chat.postMessage({
    channel: dmChannelId,
    text,
    mrkdwn: true,
  });
}
