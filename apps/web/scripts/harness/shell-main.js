// Mounts the REAL PlayerShell with a fake DIRECT source + real content ids so
// the subtitle/intro lookups run against their real controllers. The QA driver
// calls window.mountShell(props). All network calls are recorded via the
// fetch wrapper installed by the page (see shell.html).
import { mount } from 'svelte';
import PlayerShell from '$lib/components/player/PlayerShell.svelte';

window.mountShell = (props) => {
  const host = document.getElementById('host');
  host.innerHTML = '';
  const component = mount(PlayerShell, {
    target: host,
    props: {
      source: {
        type: 'direct',
        url: 'https://zcdn.bluevelvet.space/fake/master.m3u8',
        providerId: 'bluevelvet',
        sourceId: 'src-bv',
        mediaType: 'movie',
        subtitles: [],
        qualities: [],
      },
      content: { id: 'movie-24428', tmdbId: '24428', type: 'movie', title: 'The Avengers', poster: '', backdrop: '' },
      initialProgress: 0,
      sourceOptions: [
        {
          id: 'src-bv',
          name: 'Blue Velvet',
          status: 'ready',
          providerSlug: 'bluevelvet',
        },
      ],
      episodes: [],
      currentEpisode: null,
      resolving: false,
      calibrationMode: false,
      resolutionError: '',
      resolutionKind: 'provider-error',
      resolutionSourceName: '',
      resolutionMessage: '',
      onProgress: () => {},
      onSourceChange: () => {},
      onEpisodeChange: () => {},
      onClose: () => {},
      onDetails: () => {},
      onIframeReady: () => {},
      embedPlaybackEvent: null,
      ...props,
    },
  });
  return true;
};
