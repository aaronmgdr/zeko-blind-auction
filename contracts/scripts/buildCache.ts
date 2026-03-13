/**
 * buildCache.ts — pre-generates circuit proving/verification keys in Node.js
 * and writes them to ui/public/circuit-cache/ so the browser can download
 * them instead of computing the Lagrange basis itself (which is disabled in
 * the web WASM build of o1js).
 *
 * Run:  bun run build:cache        (from repo root or contracts/)
 * Then: bun run dev  (or bun run build)
 *
 * The generated files are gitignored (can be 100s of MB).
 * Re-run any time the circuit source code changes.
 */
import { BidCommitmentProgram, BidAggregator, AuctionContract, auctionOffchainState }
  from '../dist/index.js';
import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir    = join(__dirname, '../../ui/public/circuit-cache');
mkdirSync(outDir, { recursive: true });

const manifest: string[] = [];

// Simple write-only cache: never reads (forces full compile), writes each entry
// as a file named by its uniqueId.  The uniqueId encodes the circuit digest, so
// stale files from old circuits are simply ignored on the next load.
const cache = {
  read(_h: { uniqueId: string }): Uint8Array | undefined { return undefined; },
  write(header: { uniqueId: string }, data: Uint8Array) {
    writeFileSync(join(outDir, header.uniqueId), data);
    if (!manifest.includes(header.uniqueId)) manifest.push(header.uniqueId);
    process.stdout.write('.');
  },
  canWrite: true as const,
};

console.log('\nBuilding circuit cache for the browser…\n');

process.stdout.write('  BidCommitmentProgram ');
await BidCommitmentProgram.compile({ cache });
console.log(' ✓');

process.stdout.write('  BidAggregator        ');
await BidAggregator.compile({ cache });
console.log(' ✓');

// OffchainState.compile() wraps an internal 'merkle-map-rollup' ZkProgram.
// Try to pass the cache via a runtime cast — if the underlying ZkProgram
// accepts it, the browser avoids recomputing that circuit too.
process.stdout.write('  auctionOffchainState ');
try {
  await (auctionOffchainState.compile as (o: { cache: typeof cache }) => Promise<unknown>)({ cache });
} catch {
  // Fall back to uncached compile — the internal ZkProgram may not expose cache.
  await auctionOffchainState.compile();
}
console.log(' ✓');

process.stdout.write('  AuctionContract      ');
await AuctionContract.compile({ cache });
console.log(' ✓');

writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(`\n${manifest.length} entries written to ${outDir}`);
console.log('Run "bun run build:cache" again if circuit source changes.\n');
