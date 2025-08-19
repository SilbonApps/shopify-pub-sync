// publications.js
import { getPublications } from "./shopify.js";

export async function resolveTargetPublicationIds() {
  const whitelist = (process.env.PUBLICATIONS_WHITELIST || "")
    .split(",").map(s => s.trim()).filter(Boolean);
  if (whitelist.length > 0) return whitelist;

  const nameFilter = (process.env.PUBLICATION_NAME_FILTER || "")
    .toLowerCase().split(",").map(s => s.trim()).filter(Boolean);

  const pubs = await getPublications();
  if (nameFilter.length === 0) return pubs.map(p => p.id);
  return pubs
    .filter(p => nameFilter.some(nf => (p.name || "").toLowerCase().includes(nf)))
    .map(p => p.id);
}
