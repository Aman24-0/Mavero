
## Temporary iframe test results

The isolated route used MAVERO’s existing `PlayerViewport` iframe renderer with no resolver, registry, Supabase, or provider changes. The movie test used `https://bingr.one/watch/movie/1493400`; the TV test used `https://bingr.one/watch/tv/95350/1/1`.

For both movie and TV, the parent iframe `load` event was received and the exact Bingr URL was present. With Sandbox On and Sandbox Off, the iframe region remained a black/loading surface and Bingr’s own player UI, video controls, episode content, and actual playback did not become visible. The Bingr page displayed only provider-owned humorous loading messages such as `Your movie is buffering...`, `We asked nicely. The server said fuck off. Trying again.`, and `Sleep is overrated. Your show is almost here.` No MAVERO resolver or player error appeared.

The browser console showed no console output or frame-blocking error in the available parent-console view. Response-header checks for both Bingr pages returned HTTP 200 HTML without `X-Frame-Options` or `Content-Security-Policy: frame-ancestors` headers, so the pages were not blocked at the initial HTTP framing-header stage. The iframe element had `allowfullscreen`; fullscreen invocation from the parent test was rejected by the browser permissions check, and Bingr’s own player controls were not visible to interact with.

The mobile 390×844 capture showed the temporary page and iframe region fitting the viewport with no horizontal overflow. It showed Bingr’s loading surface but no provider UI or playback.
