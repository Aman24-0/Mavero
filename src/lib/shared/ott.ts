export type OttProvider = {
  key: string;
  label: string;
  providerId: number;
  icon: string;
  logoUrl: string;
};

function favicon(domain: string) {
  return `https://www.google.com/s2/favicons?domain=${domain}&sz=64`;
}

export const ottProviders: readonly OttProvider[] = [
  { key: 'netflix', label: 'Netflix', providerId: 8, icon: 'N', logoUrl: favicon('netflix.com') },
  { key: 'prime-video', label: 'Prime Video', providerId: 119, icon: 'P', logoUrl: favicon('primevideo.com') },
  { key: 'disney-plus', label: 'Disney+', providerId: 337, icon: 'D', logoUrl: favicon('disneyplus.com') },
  { key: 'apple-tv', label: 'Apple TV+', providerId: 350, icon: 'TV', logoUrl: favicon('tv.apple.com') },
  { key: 'max', label: 'Max', providerId: 1899, icon: 'M', logoUrl: favicon('max.com') },
  { key: 'hulu', label: 'Hulu', providerId: 15, icon: 'H', logoUrl: favicon('hulu.com') },
  { key: 'paramount-plus', label: 'Paramount+', providerId: 531, icon: 'P+', logoUrl: favicon('paramountplus.com') },
  { key: 'peacock', label: 'Peacock', providerId: 386, icon: 'P', logoUrl: favicon('peacocktv.com') },
  { key: 'crunchyroll', label: 'Crunchyroll', providerId: 269, icon: 'C', logoUrl: favicon('crunchyroll.com') },
  { key: 'discovery-plus', label: 'Discovery+', providerId: 510, icon: 'D+', logoUrl: favicon('discoveryplus.com') },
  { key: 'mubi', label: 'MUBI', providerId: 11, icon: 'M', logoUrl: favicon('mubi.com') },
  { key: 'youtube', label: 'YouTube Premium', providerId: 188, icon: 'YT', logoUrl: favicon('youtube.com') },
  { key: 'google-play', label: 'Google Play', providerId: 3, icon: 'G', logoUrl: favicon('play.google.com') },
  { key: 'amazon-video', label: 'Amazon Video', providerId: 10, icon: 'A', logoUrl: favicon('amazon.com') },
  { key: 'jiocinema', label: 'JioCinema', providerId: 2206, icon: 'J', logoUrl: favicon('jio.com') },
  { key: 'zee5', label: 'ZEE5', providerId: 232, icon: 'Z', logoUrl: favicon('zee5.com') },
  { key: 'sonyliv', label: 'Sony LIV', providerId: 237, icon: 'S', logoUrl: favicon('sonyliv.com') },
  { key: 'sunnxt', label: 'Sun Nxt', providerId: 309, icon: 'SN', logoUrl: favicon('sunnxt.com') },
  { key: 'mx-player', label: 'MX Player', providerId: 2285, icon: 'MX', logoUrl: favicon('mxplayer.in') },
  { key: 'aha', label: 'aha', providerId: 532, icon: 'A', logoUrl: favicon('aha.video') },
];

export function ottProvider(key: string) {
  return ottProviders.find((provider) => provider.key === key);
}
