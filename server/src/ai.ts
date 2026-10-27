// AI write-up of campaign results. Everything else the AI writes goes through the Kompass bubble.
import type { CampaignResults } from "../../shared/types.ts";
import { complete } from "./llm.ts";

/** Three learnings from a campaign's numbers. */
export async function writeLearnings(name: string, r: CampaignResults): Promise<string> {
  const { content } = await complete(
    [
      {
        role: "system",
        content:
          "You are a CRM analyst. From the campaign numbers write exactly three short bullet points in English (start each with '- '): what worked, what did not, and what to change next time. Cite the numbers. Say clearly when results are simulated or a difference is not significant. No preamble.",
      },
      { role: "user", content: `Campaign: ${name}\n${JSON.stringify({ funnel: r.funnel, treated: r.treated, control: r.control, upliftPp: r.upliftPp, ci95: r.ci95, verdict: r.verdict, realisedDclvEur: r.realisedDclvEur, byOffer: r.byOffer, byTone: r.byTone, simulated: r.simulated })}` },
    ],
    { maxTokens: 2500, temperature: 0.3 },
  );
  return content.trim();
}
