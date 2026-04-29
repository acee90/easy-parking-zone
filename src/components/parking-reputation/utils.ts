export function decodeHtmlEntities(text: string): string {
  const entities: Record<string, string> = {
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&#39;': "'",
    '&apos;': "'",
  }
  return text.replace(/&(?:amp|lt|gt|quot|apos|#39);/g, (m) => entities[m] ?? m)
}
