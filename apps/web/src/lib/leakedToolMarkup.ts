const COMPLETE = /<tool_call\b[\s\S]*?<\/tool_call>/gi;
const INCOMPLETE = /<tool_call\b[\s\S]*$/i;

export function stripLeakedToolMarkup(text: string): string {
  const cut = String(text ?? "").replace(COMPLETE, "");
  const at = cut.search(INCOMPLETE);
  return (at >= 0 ? cut.slice(0, at) : cut).replace(/\n{3,}/g, "\n\n");
}
