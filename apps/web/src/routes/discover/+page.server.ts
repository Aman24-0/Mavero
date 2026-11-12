import { loadDiscoverData } from '$lib/server/content/discover-load';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async () => loadDiscoverData();
