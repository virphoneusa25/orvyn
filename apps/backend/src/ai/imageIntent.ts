// Detect when the user is asking for artwork so Chat can generate it
// instead of the language model refusing ("I can't create images").
//
// Keep this from catching code work: "create an image component" is not a picture.

export function looksLikeImageRequest(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (/^\/image\b/i.test(t)) return true;

  const coding =
    /\b(component|element|tag|jsx|tsx|html|css|react|div|img\s+tag|src=)\b/i.test(t) &&
    !/\b(draw|paint|sketch|render|mock-?up|logo|icon)\b/i.test(t);
  if (coding) return false;

  const artNoun =
    /\b(images?|pictures?|photos?|icons?|logos?|illustrations?|artwork|mock-?ups?|banners?|thumbnails?)\b/i;
  const artVerb =
    /\b(generate|draw|render|paint|sketch|imagine|design|make|create|mock-?up)\b/i;
  const logoFor = /\b(logo|icon|illustration|artwork|mock-?up)\b.{0,48}\b(for|of|that)\b/i;
  const asked =
    /\b(can you|could you|please|i (?:need|want)|make me|design me)\b/i.test(t) && artNoun.test(t);

  return (artVerb.test(t) && artNoun.test(t)) || logoFor.test(t) || asked;
}

export function stripImagePrefix(text: string): string {
  return text.replace(/^\/image\b\s*/i, "").trim();
}
