import { WebClient } from "@slack/web-api";
import crypto from "crypto";

let _slackClient: WebClient | null = null;

export function getCompanionSlackClient(): WebClient {
  if (!_slackClient) {
    _slackClient = new WebClient(process.env.COMPANION_SLACK_BOT_TOKEN!);
  }
  return _slackClient;
}

export async function verifySlackSignature(
  request: Request,
  rawBody: string
): Promise<boolean> {
  const signingSecret = process.env.COMPANION_SLACK_SIGNING_SECRET!;
  const timestamp = request.headers.get("x-slack-request-timestamp");
  const slackSignature = request.headers.get("x-slack-signature");

  if (!timestamp || !slackSignature) return false;

  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - parseInt(timestamp)) > 300) return false;

  const sigBase = `v0:${timestamp}:${rawBody}`;
  const hmac = crypto.createHmac("sha256", signingSecret);
  hmac.update(sigBase);
  const computed = `v0=${hmac.digest("hex")}`;

  try {
    return crypto.timingSafeEqual(
      Buffer.from(computed),
      Buffer.from(slackSignature)
    );
  } catch {
    return false;
  }
}

export async function postToThread(
  channelId: string,
  threadTs: string,
  text: string
): Promise<string | undefined> {
  const slack = getCompanionSlackClient();
  const result = await slack.chat.postMessage({
    channel: channelId,
    thread_ts: threadTs,
    text,
    mrkdwn: true,
  });
  return result.ts;
}

export async function postToChannel(
  channelId: string,
  text: string
): Promise<{ ts: string | undefined }> {
  const slack = getCompanionSlackClient();
  const result = await slack.chat.postMessage({
    channel: channelId,
    text,
    mrkdwn: true,
  });
  return { ts: result.ts };
}

export async function sendDM(
  userId: string,
  text: string
): Promise<void> {
  const slack = getCompanionSlackClient();
  const dm = await slack.conversations.open({ users: userId });
  const channelId = dm.channel?.id;
  if (!channelId) throw new Error("Could not open DM");
  await slack.chat.postMessage({ channel: channelId, text, mrkdwn: true });
}

export async function downloadFile(fileUrl: string): Promise<Buffer | null> {
  try {
    const res = await fetch(fileUrl, {
      headers: { Authorization: `Bearer ${process.env.COMPANION_SLACK_BOT_TOKEN}` },
    });
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  }
}

let _cachedBotId = "";
export async function getBotId(): Promise<string> {
  if (_cachedBotId) return _cachedBotId;
  try {
    const result = await getCompanionSlackClient().auth.test();
    _cachedBotId = result.user_id ?? "";
  } catch {}
  return _cachedBotId;
}
