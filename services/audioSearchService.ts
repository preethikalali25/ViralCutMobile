export interface AudioSearchResult {
  id: string;
  title: string;
  artist: string;
  artworkUrl?: string;
  previewUrl?: string;
}

// iTunes Search API — public, no key required. Returns a ~30s preview clip
// (previewUrl) for most catalog tracks, which is the only legally fetchable
// real audio we have access to for trending/viral songs without a paid
// music-licensing integration.
export async function searchViralAudio(
  query: string,
): Promise<{ results: AudioSearchResult[]; error?: string }> {
  if (!query.trim()) return { results: [] };
  try {
    const url = `https://itunes.apple.com/search?term=${encodeURIComponent(query)}&media=music&entity=song&limit=12`;
    const res = await fetch(url);
    if (!res.ok) return { results: [], error: `Search failed (${res.status})` };
    const json = await res.json();
    const results: AudioSearchResult[] = (json.results ?? [])
      .filter((t: any) => t.trackId && t.trackName && t.artistName)
      .map((t: any) => ({
        id: String(t.trackId),
        title: t.trackName,
        artist: t.artistName,
        artworkUrl: t.artworkUrl100,
        previewUrl: t.previewUrl,
      }));
    return { results };
  } catch (e: any) {
    return { results: [], error: e?.message ?? 'Could not search audio' };
  }
}
