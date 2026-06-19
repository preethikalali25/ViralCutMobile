// Audio search service using iTunes Search API as a free, no-key-required
// source for song metadata and 30-second preview clips.

export interface AudioSearchResult {
  id: string;
  title: string;
  artist: string;
  previewUrl?: string;
  artworkUrl?: string;
  trending?: boolean;
}

export interface AudioSearchResponse {
  results: AudioSearchResult[];
  error?: string;
}

/**
 * Search for songs using the iTunes Search API.
 * Returns up to 10 matching tracks with 30-second preview URLs.
 */
export async function searchViralAudio(query: string): Promise<AudioSearchResponse> {
  if (!query?.trim()) return { results: [] };

  try {
    const encoded = encodeURIComponent(query.trim());
    const url = `https://itunes.apple.com/search?term=${encoded}&media=music&entity=song&limit=10`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);

    let response: Response;
    try {
      response = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }

    if (!response.ok) {
      return { results: [], error: `iTunes API error: ${response.status}` };
    }

    const data = await response.json();
    const tracks = (data.results ?? []) as Array<{
      trackId: number;
      trackName: string;
      artistName: string;
      previewUrl?: string;
      artworkUrl100?: string;
    }>;

    const results: AudioSearchResult[] = tracks
      .filter(t => t.trackId && t.trackName)
      .map(t => ({
        id: String(t.trackId),
        title: t.trackName,
        artist: t.artistName,
        previewUrl: t.previewUrl,
        artworkUrl: t.artworkUrl100,
        trending: false,
      }));

    return { results };
  } catch (err) {
    console.warn('[audioSearchService] search failed:', err);
    return { results: [], error: String(err) };
  }
}
