const MALFORMED_GENERATED_IMAGE_URL =
  /https?:\/\/api\.images\/([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})(?=$|[\s)"'<>?#])/gi

export function normalizeGeneratedImageUrls(text: string): string {
  return text.replace(MALFORMED_GENERATED_IMAGE_URL, '/api/images/$1')
}
