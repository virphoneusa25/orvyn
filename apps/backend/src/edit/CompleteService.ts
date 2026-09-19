// apps/backend/src/edit/CompleteService.ts
//
// Ghost-text / Tab autocomplete. Returns a short continuation at the cursor
// so Monaco can show it as an inline suggestion.

import { ModelService } from "../services/ModelService";

export interface CompleteRequest {
  prefix: string;
  suffix?: string;
  language?: string;
  filePath?: string;
}

function stripFences(raw: string): string {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/^```[\w]*\n([\s\S]*?)```$/);
  if (fenced) return fenced[1].replace(/\n$/, "");
  return trimmed;
}

export class CompleteService {
  constructor(private modelService: ModelService) {}

  async complete(req: CompleteRequest): Promise<{ completion: string }> {
    const prefix = (req.prefix ?? "").slice(-4000);
    const suffix = (req.suffix ?? "").slice(0, 1200);
    if (!prefix.trim()) return { completion: "" };

    const provider = this.modelService.router.resolve("completion");
    const response = await provider.generate({
      messages: [
        {
          role: "user",
          content: [
            "You are a code completion engine inside an IDE.",
            "Continue the code at the cursor. Return ONLY the completion text.",
            "No markdown fences, no quotes around the result, no explanation.",
            "Keep it short: at most 8 lines. Prefer completing the current statement.",
            req.filePath ? `File: ${req.filePath}` : "",
            req.language ? `Language: ${req.language}` : "",
            "",
            "CODE BEFORE CURSOR:",
            prefix,
            "",
            "CODE AFTER CURSOR:",
            suffix || "(end of file)",
            "",
            "Completion:",
          ]
            .filter(Boolean)
            .join("\n"),
        },
      ],
      temperature: 0.15,
      maxOutputTokens: 96,
    });

    let completion = stripFences(response.content);
    if (completion.startsWith(prefix.slice(-40))) {
      completion = completion.slice(prefix.slice(-40).length);
    }
    const lines = completion.split("\n").slice(0, 8);
    return { completion: lines.join("\n") };
  }
}
