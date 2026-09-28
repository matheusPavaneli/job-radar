import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { composeServices } from '@theguild/federation-composition';
import { parse } from 'graphql';

const root = join(import.meta.dirname, '..', '..', '..');
const subgraphs = [
  { name: 'jobs', file: 'apps/jobs/schema.graphql', url: 'env:JOBS_SUBGRAPH_URL' },
  { name: 'matching', file: 'services/matching/schema.graphql', url: 'env:MATCHING_SUBGRAPH_URL' },
];

const services = await Promise.all(
  subgraphs.map(async ({ name, file, url }) => ({
    name,
    url,
    typeDefs: parse(await readFile(join(root, file), 'utf8')),
  })),
);

const result = composeServices(services);
if (result.errors) {
  for (const error of result.errors) console.error(`composition error: ${error.message}`);
  process.exit(1);
}

await writeFile(join(import.meta.dirname, '..', 'supergraph.graphql'), result.supergraphSdl);
await writeFile(join(root, 'docs', 'public-schema.graphql'), result.publicSdl);
console.log('supergraph composed');
