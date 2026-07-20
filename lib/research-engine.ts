import OpenAI from "openai";
import { createPersonalSupabaseAdmin } from "./supabase-personal";

let _openai: OpenAI | null = null;
function openai() {
  if (!_openai) _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _openai;
}

const CRAWLER_URL = process.env.CRAWLER_SERVICE_URL;
const CRAWLER_SECRET = process.env.CRAWLER_SECRET;

async function searchDuckDuckGo(query: string): Promise<Array<{
  title: string;
  url: string;
  snippet: string;
}>> {
  if (CRAWLER_URL && CRAWLER_SECRET) {
    try {
      const res = await fetch(`${CRAWLER_URL}/search`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-crawler-secret": CRAWLER_SECRET,
        },
        body: JSON.stringify({ query, max_results: 5, crawl_top_n: 2 }),
        signal: AbortSignal.timeout(30_000),
      });
      if (res.ok) {
        const data = await res.json();
        return data.results ?? [];
      }
    } catch {}
  }

  return [];
}

export async function conductResearch(
  query: string,
  ideaId?: string
): Promise<string> {
  const supabase = createPersonalSupabaseAdmin();

  const { data: cached } = await supabase
    .from("research_cache")
    .select("results")
    .eq("query", query)
    .gte("expires_at", new Date().toISOString())
    .single();

  if (cached?.results) {
    return cached.results;
  }

  const searchResults = await searchDuckDuckGo(query);

  let researchContent = "";
  if (searchResults.length > 0) {
    researchContent = searchResults
      .map(r => `${r.title}\n${r.snippet}\nSource: ${r.url}`)
      .join("\n\n");
  }

  const response = await openai().chat.completions.create({
    model: "gpt-4o",
    messages: [
      {
        role: "system",
        content: `You are Jarvis — synthesize research findings for Brandon.
Be precise, thorough, and strategic. Structure the findings clearly.
Focus on what's most actionable and relevant.
If no search results were available, use your knowledge to answer.`,
      },
      {
        role: "user",
        content: `Research query: "${query}"${researchContent ? `\n\nSearch findings:\n${researchContent}` : "\n\nProvide your best knowledge-based answer."}`,
      },
    ],
    max_tokens: 800,
    temperature: 0.3,
  });

  const synthesized =
    response.choices[0]?.message?.content?.trim() ??
    "Research could not be completed at this time.";

  await supabase.from("research_cache").insert({
    query,
    results: synthesized,
    source_urls: searchResults.map(r => r.url),
  });

  if (ideaId) {
    await supabase.from("ideas").update({
      research_results: synthesized,
      research_query: query,
    }).eq("id", ideaId);

    await supabase.from("idea_updates").insert({
      idea_id: ideaId,
      update_type: "research_completed",
      content: `Research completed: "${query}"`,
      sent_to_slack: true,
    });
  }

  return synthesized;
}
