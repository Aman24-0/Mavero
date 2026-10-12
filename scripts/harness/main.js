// Mounts the REAL PlayerControls with representative props; the QA driver
// (player_v2_final_remediation_dom_qa.mjs) calls window.mountControls.
import { mount } from 'svelte';
import PlayerControls from '$lib/components/player/PlayerControls.svelte';
import { PLAYER_AUTO_QUALITY_ID } from '$lib/shared/player';

window.mountControls = (props) => {
  const host = document.getElementById('host');
  host.innerHTML = '';
  const component = mount(PlayerControls, {
    target: host,
    props: {
      playing: true,
      muted: false,
      volume: 1,
      currentTime: 95.4,
      duration: 5340,
      buffered: 220,
      playbackRate: 1,
      fullscreenActive: false,
      pictureInPictureSupported: true,
      locked: false,
      subtitles: [],
      selectedSubtitle: '',
      subtitleNotice: 'No subtitles available',
      qualities: [],
      selectedQuality: '',
      internalQualities: [{ id: '0', label: '1080p' }, { id: '1', label: '720p' }, { id: '2', label: '480p' }],
      selectedInternalQuality: PLAYER_AUTO_QUALITY_ID,
      displayMode: 'fit',
      castAvailable: false,
      castActive: false,
      ...props,
    },
  });
  // Force the surface visible (the shell normally fades it via the parent).
  const surface = host.querySelector('.controls');
  if (surface) surface.style.opacity = '1';
  return true;
};
