# Landing hero background video — capability & asset spec (P0.2-Q)

The homepage hero supports an optional muted background video. The capability
is production-ready and **OFF by default**; no video plays until the owner
approves an asset and enables the flag. The graphite brand visual is the
permanent fallback.

## Runtime configuration (Render web service env)

| Env | Meaning | Default |
|---|---|---|
| `LANDING_HERO_VIDEO_ENABLED` | `true`/`1` turns the capability on | OFF |
| `LANDING_HERO_VIDEO_URL` | absolute URL of the MP4 asset (CDN/Supabase public) | empty |
| `LANDING_HERO_VIDEO_POSTER` | absolute URL of the poster image | empty |

Exposed to the client via `GET /api/preview/meta` (`landing_hero_video_*`).

## Client behavior (already implemented)

- `muted`, `autoPlay`, `loop`, `playsInline`, `preload="metadata"`, poster image
- dark overlay keeps hero text readable
- **not shown** when: flag off, no URL, `prefers-reduced-motion: reduce`,
  or the connection reports `saveData`/2G
- loading is deferred past first paint (`requestIdleCallback`) — never blocks LCP
- no audio track should exist in the asset at all (not just muted)

## Recommended asset spec (for the owner's video team)

- Container/codec: MP4, H.264 (High profile), + optional WebM/VP9 variant
- Resolution: 1920×1080 (or 1280×720 for a lighter file)
- Duration: 10–20 seconds, seamless loop
- Bitrate: 2–4 Mbps target; **file ≤ 4–6 MB**
- No audio track; no burned-in text (text lives in the HTML layer)
- Dark/graphite-leaning grade — the overlay darkens it further
- Poster: JPG frame of the video, ≤ 150 KB

Do not commit the video to the repo — host it on the canonical storage/CDN and
point `LANDING_HERO_VIDEO_URL` at it.
