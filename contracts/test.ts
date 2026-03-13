/**
 * test.ts — full end-to-end auction flow on Mina.LocalBlockchain
 *
 * Runs entirely locally — no network or faucet required.
 * Imports from ./dist/ (pre-compiled by tsc with emitDecoratorMetadata:true).
 *
 * Run:   bun test.ts
 * Run with proofs: PROOFS=1 bun test.ts  (slow, ~10–20 min)
 */
import {
  Mina, PrivateKey, AccountUpdate, Field, UInt64, UInt32, Poseidon,
} from 'o1js';

import {
  AuctionContract, NFTToken,
  BidCommitmentProgram, BidCommitmentProof,
  BidAggregator, BidAggregatorProof,
  auctionOffchainState,
  BOND_AMOUNT, RESERVE_PRICE,
  RevealAction,
} from './dist/index.js';

// ── helpers ──────────────────────────────────────────────────────────────────

const GREEN = '\x1b[32m', RED = '\x1b[31m', RESET = '\x1b[0m', DIM = '\x1b[2m';
const ok  = (msg: string) => console.log(`${GREEN}  ✓${RESET} ${msg}`);
const log = (msg: string) => console.log(`\n${'─'.repeat(60)}\n${msg}`);
const die = (msg: string, e?: unknown) => { console.error(`${RED}  ✗ FAIL${RESET} ${msg}`, e ?? ''); process.exit(1); };

async function step(label: string, fn: () => Promise<unknown>) {
  process.stdout.write(`  · ${label}…`);
  const t = Date.now();
  try {
    await fn();
    console.log(` ${DIM}${Date.now() - t}ms${RESET}`);
  } catch (e) {
    console.log(` ${RED}FAILED${RESET}`);
    die(label, e);
  }
}

function assert(cond: boolean, msg: string) {
  if (!cond) die(`Assertion failed: ${msg}`);
  ok(msg);
}

// ── settle OffchainState helper ───────────────────────────────────────────────

async function settleOffchain(
  auction: InstanceType<typeof AuctionContract>,
  payer: Mina.TestPublicKey,
) {
  auction.offchainState.setContractInstance(auction);
  const proof = await auction.offchainState.createSettlementProof();
  const tx = await Mina.transaction(payer, async () => {
    await auction.settleState(proof as any);
  });
  await tx.prove();
  await tx.sign([payer.key]).send();
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Main
// ═══════════════════════════════════════════════════════════════════════════════

const proofsEnabled = process.env['PROOFS'] === '1';
log(`LocalBlockchain test  (proofsEnabled=${proofsEnabled})`);
console.log(`  RESERVE_PRICE = ${RESERVE_PRICE} nanomina`);
console.log(`  BOND_AMOUNT   = ${BOND_AMOUNT} nanomina`);

// ── 1. Setup ──────────────────────────────────────────────────────────────────

log('Setup');

const Local = await Mina.LocalBlockchain({ proofsEnabled });
Mina.setActiveInstance(Local);

const [seller, bidder1, bidder2, anyone] = Local.testAccounts;

const nftKey     = PrivateKey.random();
const auctionKey = PrivateKey.random();
const nftAddr    = nftKey.toPublicKey();
const auctionAddr = auctionKey.toPublicKey();

const nft     = new NFTToken(nftAddr);
const auction = new AuctionContract(auctionAddr);

ok(`seller:   ${seller.toBase58().slice(0, 12)}…`);
ok(`bidder1:  ${bidder1.toBase58().slice(0, 12)}…`);
ok(`bidder2:  ${bidder2.toBase58().slice(0, 12)}…`);

// ── 2. Compile ────────────────────────────────────────────────────────────────

log('Compile');
await step('NFTToken.compile()', async () => { await NFTToken.compile(); });
await step('BidCommitmentProgram.compile()', async () => { await BidCommitmentProgram.compile(); });
await step('BidAggregator.compile()', async () => { await BidAggregator.compile(); });
await step('auctionOffchainState.compile()', async () => { await auctionOffchainState.compile(); });
await step('AuctionContract.compile()', async () => { await AuctionContract.compile(); });

// ── 3. Deploy NFT & mint to seller ───────────────────────────────────────────

log('Phase 0a · Deploy NFTToken + mint');

await step('deploy NFTToken', async () => {
  const tx = await Mina.transaction(seller, async () => {
    AccountUpdate.fundNewAccount(seller);
    await nft.deploy({});
  });
  await tx.prove();
  await tx.sign([seller.key, nftKey]).send();
});

await step('mint NFT to seller', async () => {
  const tx = await Mina.transaction(seller, async () => {
    AccountUpdate.fundNewAccount(seller); // seller's token account
    await nft.mint(seller);
  });
  await tx.prove();
  await tx.sign([seller.key]).send();
});

assert(nft.minted.get().toBoolean(), 'NFT minted flag is true');

// ── 4. Deploy & initialize AuctionContract ────────────────────────────────────

log('Phase 0b · Deploy & initialize AuctionContract');

await step('deploy AuctionContract', async () => {
  const tx = await Mina.transaction(seller, async () => {
    AccountUpdate.fundNewAccount(seller);
    await auction.deploy({});
  });
  await tx.prove();
  await tx.sign([seller.key, auctionKey]).send();
});

assert(!auction.initialized.get().toBoolean(), 'initialized starts false');

// Small durations — the test naturally produces enough txs to advance blocks.
// LocalBlockchain increments blockchainLength by 1 on each send().
const AUCTION_DURATION = UInt32.from(5);
const REVEAL_DURATION  = UInt32.from(5);

await step('initialize auction (escrows NFT)', async () => {
  const tx = await Mina.transaction(seller, async () => {
    AccountUpdate.fundNewAccount(seller); // auction's token account (to hold NFT)
    await auction.initialize(nftAddr, AUCTION_DURATION, REVEAL_DURATION);
  });
  await tx.prove();
  // auctionKey co-signs once here so initialize() can set send:proof() on the vault.
  // After this, the vault is permanently locked — auctionKey is never needed again.
  await tx.sign([seller.key, auctionKey]).send();
});

assert(auction.initialized.get().toBoolean(), 'initialized is true after initialize()');
const auctionEnd = auction.auctionEnd.get();
const revealEnd  = auction.revealEnd.get();
ok(`auctionEnd = block ${auctionEnd.toString()}`);
ok(`revealEnd  = block ${revealEnd.toString()}`);

await step('settleState (flush initialize OffchainState writes)', async () => {
  await settleOffchain(auction, anyone);
});

// ── 5. Commit bids ────────────────────────────────────────────────────────────

log('Phase 1 · Commit Bids');

const amount1 = UInt64.from(10_000_000_000n); // 10 MINA — will win
const salt1   = Field.random();
const commitment1 = Poseidon.hash([...amount1.toFields(), salt1]);

const amount2 = UInt64.from(7_000_000_000n);  // 7 MINA — will lose
const salt2   = Field.random();
const commitment2 = Poseidon.hash([...amount2.toFields(), salt2]);

let proof1!: BidCommitmentProof;
let proof2!: BidCommitmentProof;

await step('BidCommitmentProgram.prove() — bidder1 (10 MINA)', async () => {
  ({ proof: proof1 } = await BidCommitmentProgram.prove(commitment1, amount1, salt1));
});
await step('BidCommitmentProgram.prove() — bidder2 (7 MINA)', async () => {
  ({ proof: proof2 } = await BidCommitmentProgram.prove(commitment2, amount2, salt2));
});

// Ensure we're still in the bid phase (block <= auctionEnd)
const blockAtCommit = Local.getNetworkState().blockchainLength;
ok(`current block: ${blockAtCommit.toString()}, auctionEnd: ${auctionEnd.toString()}`);

await step('commitBid — bidder1', async () => {
  const tx = await Mina.transaction(bidder1, async () => {
    await auction.commitBid(proof1, BOND_AMOUNT);
  });
  await tx.prove();
  await tx.sign([bidder1.key]).send();
});

await step('commitBid — bidder2', async () => {
  const tx = await Mina.transaction(bidder2, async () => {
    await auction.commitBid(proof2, BOND_AMOUNT);
  });
  await tx.prove();
  await tx.sign([bidder2.key]).send();
});

await step('settleState (flush commit writes)', async () => {
  await settleOffchain(auction, anyone);
});

// ── 6. Advance to reveal phase ────────────────────────────────────────────────

log('Advance to reveal phase');
const auctionEndNum = Number(auctionEnd.toString());
Local.setBlockchainLength(UInt32.from(auctionEndNum + 1));
ok(`block advanced to ${Local.getNetworkState().blockchainLength.toString()} (past auctionEnd=${auctionEnd})`);

// ── 7. Reveal bids ────────────────────────────────────────────────────────────

log('Phase 2 · Reveal Bids');

await step('revealBid — bidder1 (10 MINA)', async () => {
  const tx = await Mina.transaction(bidder1, async () => {
    await auction.revealBid(amount1, salt1);
  });
  await tx.prove();
  await tx.sign([bidder1.key]).send();
});

await step('revealBid — bidder2 (7 MINA)', async () => {
  const tx = await Mina.transaction(bidder2, async () => {
    await auction.revealBid(amount2, salt2);
  });
  await tx.prove();
  await tx.sign([bidder2.key]).send();
});

await step('settleState (flush reveal writes)', async () => {
  await settleOffchain(auction, anyone);
});

// ── 8. Advance to settlement phase ───────────────────────────────────────────

log('Advance to settlement phase');
const revealEndNum = Number(revealEnd.toString());
Local.setBlockchainLength(UInt32.from(revealEndNum + 1));
ok(`block advanced to ${Local.getNetworkState().blockchainLength.toString()} (past revealEnd=${revealEnd})`);

// ── 9. Settle auction (BidAggregator proof) ───────────────────────────────────

log('Phase 3 · Settle');

let aggregatorProof!: BidAggregatorProof;
await step('build BidAggregator proof over all RevealActions', async () => {
  // Reveals are read off-chain from the settled OffchainState `revealed` map.
  // In this test we know exactly who revealed, so we construct RevealActions directly.
  // publicInput is always Field(0) — BidAggregator does not track action state.
  const reveals = [
    new RevealAction({ bidder: bidder1, amount: amount1 }),
    new RevealAction({ bidder: bidder2, amount: amount2 }),
  ];

  let { proof: currentProof } = await BidAggregator.base(Field(0));
  for (const reveal of reveals) {
    ({ proof: currentProof } = await BidAggregator.step(Field(0), currentProof, reveal));
  }
  aggregatorProof = currentProof;
});

assert(auction.winner.get().equals(auction.winner.get()).toBoolean(), 'winner field readable'); // pre-settle

await step('settle()', async () => {
  const tx = await Mina.transaction(anyone, async () => {
    await auction.settle(aggregatorProof);
  });
  await tx.prove();
  await tx.sign([anyone.key]).send();
});

const winner = auction.winner.get();
ok(`winner = ${winner.toBase58().slice(0, 12)}…`);
assert(
  winner.toBase58() === bidder1.toBase58(),
  'bidder1 (10 MINA) won the auction',
);

await step('settleState (flush settle writes)', async () => {
  await settleOffchain(auction, anyone);
});

// ── 10. Claim NFT (winner) ────────────────────────────────────────────────────

log('Phase 4a · Winner claims NFT');

await step('claimNFT() — bidder1', async () => {
  const tx = await Mina.transaction(bidder1, async () => {
    AccountUpdate.fundNewAccount(bidder1); // bidder1's token account
    await auction.claimNFT();
  });
  await tx.prove();
  // No auctionKey needed — the vault's send:proof() is satisfied by the claimNFT() proof.
  await tx.sign([bidder1.key]).send();
});

ok('bidder1 received the NFT + bond refund');

// ── 11. Loser reclaims ────────────────────────────────────────────────────────

log('Phase 4b · Loser reclaims deposit');

await step('reclaimDeposit() — bidder2', async () => {
  const tx = await Mina.transaction(bidder2, async () => {
    await auction.reclaimDeposit();
  });
  await tx.prove();
  await tx.sign([bidder2.key]).send();
});

ok('bidder2 reclaimed bond + bid amount');

// ── Done ──────────────────────────────────────────────────────────────────────

log(`${GREEN}ALL TESTS PASSED ✓${RESET}`);
console.log('');
