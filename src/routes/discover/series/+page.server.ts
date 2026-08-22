import { loadCollectionData } from '$lib/server/content/discover-load';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ url }) => loadCollectionData('series', url);
