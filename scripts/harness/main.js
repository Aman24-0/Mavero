// Mounts the REAL PlayerControls with representative props; the QA driver
// (player_v2_final_remediation_dom_qa.mjs) calls window.mountControls.
import { mount } from 'svelte';
import PlayerControls from '$lib/components/player/PlayerControls.svelte';
import SubtitleOverlay from '$lib/components/player/PlayerSubtitleOverlay.svelte';
import { PLAYER_AUTO_QUALITY_ID } from '$lib/shared/player';

window.mountControls = (props) => {
  const host = document.getElementById('host');
  // STATEFUL parent mirror (focused fixes QA): the shell owns the prop
  // values and feeds every callback result back into the component. This
  // wrapper reproduces that loop with the legacy $set API so repeated
  // interactions (steppers, label mirroring) behave exactly like the real
  // integration — without remounting (the open sheet survives).
  const state = {
    playing: true, muted: false, volume: 1, currentTime: 95.4, duration: 5340,
    buffered: 220, playbackRate: 1, fullscreenActive: false,
    pictureInPictureSupported: true, locked: false,
    subtitles: [], selectedSubtitle: '', subtitleNotice: '',
    qualities: [], selectedQuality: '',
    internalQualities: [{ id: '0', label: '1080p' }, { id: '1', label: '720p' }, { id: '2', label: '480p' }],
    selectedInternalQuality: PLAYER_AUTO_QUALITY_ID,
    displayMode: 'fit', castAvailable: false, castActive: false,
    subtitlePrefs: undefined,
    ...props,
  };
  let component;
  const buildProps = () => ({
    ...state,
    onSubtitle: (url) => { state.selectedSubtitle = url; props.onSubtitle?.(url); sync({ selectedSubtitle: url }); },
    onSubtitlePreferences: (prefs) => { state.subtitlePrefs = prefs; props.onSubtitlePreferences?.(prefs); sync({ subtitlePrefs: prefs }); },
    onPlaybackRate: (v) => { state.playbackRate = v; props.onPlaybackRate?.(v); sync({ playbackRate: v }); },
    onDisplayMode: (m) => { state.displayMode = m; props.onDisplayMode?.(m); sync({ displayMode: m }); },
    onInternalQuality: (id) => { state.selectedInternalQuality = id; props.onInternalQuality?.(id); sync({ selectedInternalQuality: id }); },
    onQuality: (url) => { state.selectedQuality = url; props.onQuality?.(url); sync({ selectedQuality: url }); },
    onMenuOpenChange: (open) => props.onMenuOpenChange?.(open),
  });
  function sync(delta) { try { component?.$set?.(delta); } catch { /* legacy API unavailable */ } }
  // A legacy `new` APPENDS to the target — clear any previous mount first
  // (and destroy it) so querySelectors never see stale surfaces.
  try { component?.$destroy?.(); } catch { /* not yet created */ }
  host.innerHTML = '';
  component = new PlayerControls({ target: host, props: buildProps() });
  // Force the surface visible (the shell normally fades it via the parent).
  const surface = host.querySelector('.controls');
  if (surface) surface.style.opacity = '1';
  return true;
};

// Focused fixes (Issues 1+2) QA: mounts the REAL PlayerSubtitleOverlay with
// injectable track/video doubles. The overlay only reads `track.cues` and
// `video.currentTime`, so plain objects are sufficient doubles — the rAF
// render loop and Svelte reactivity are fully real.
window.mountSubtitleOverlay = (props) => {
  const host = document.getElementById('host');
  host.innerHTML = '';
  const component = mount(SubtitleOverlay, {
    target: host,
    props: {
      track: null,
      video: { currentTime: 0 },
      suppressed: false,
      offsetSeconds: 0,
      sizeScale: 1,
      position: 0,
      color: 'white',
      borderStyle: 'outline',
      ...props,
    },
  });
  return true;
};
