/**
 * deploy.ts — deploy NFTToken + AuctionContract to Zeko devnet.
 *
 * Usage
 * ─────
 *   # Step 1: generate a fresh deployer key
 *   bun scripts/deploy.ts
 *     → prints the address; fund it from the Zeko faucet, then:
 *
 *   # Step 2: deploy
 *   DEPLOYER_KEY=EKF... bun scripts/deploy.ts
 *
 * Optional env vars (all have defaults):
 *   AUCTION_DURATION=480   blocks for the commit (bid) phase   (~4 h at 30 s/block)
 *   REVEAL_DURATION=240    blocks for the reveal phase          (~2 h at 30 s/block)
 *
 * Output
 * ──────
 *   deploy-output.json  — addresses + private keys used during deployment.
 *   After initialize() completes, the vault is permanently locked (send:proof(),
 *   setPermissions:impossible()). No private key is needed at runtime — the
 *   browser only needs the user's Auro wallet signature and ZK proofs.
 *
 * After deploy, add to ui/.env.local:
 *   VITE_CONTRACT_ADDRESS=<auctionContract.address>
 */

import { Mina, PrivateKey, AccountUpdate, UInt32 } from 'o1js';
import {
  AuctionContract, NFTToken,
  BidCommitmentProgram, BidAggregator, auctionOffchainState,
} from '../dist/index.js';
import { writeFileSync, readFileSync, existsSync } from 'fs';

// ── Config ────────────────────────────────────────────────────────────────────

const ZEKO_URL             = 'https://devnet.zeko.io/graphql';
const ZEKO_FAUCET          = 'https://faucet.zeko.io';

const AUCTION_DURATION_BLOCKS = parseInt(process.env['AUCTION_DURATION'] ?? '480', 10);
const REVEAL_DURATION_BLOCKS  = parseInt(process.env['REVEAL_DURATION']  ?? '240', 10);

const OUTPUT_FILE = 'deploy-output.json';

// ── Helpers ───────────────────────────────────────────────────────────────────

const GREEN  = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED    = '\x1b[31m';
const DIM    = '\x1b[2m';
const RESET  = '\x1b[0m';

const ok   = (msg: string) => console.log(`${GREEN}  ✓${RESET}  ${msg}`);
const info = (msg: string) => console.log(`     ${msg}`);
const warn = (msg: string) => console.log(`${YELLOW}  ⚠${RESET}  ${msg}`);

async function sendAndWait(
  label: string,
  txFn: () => Promise<{ hash: string; wait: () => Promise<unknown> }>,
): Promise<string> {
  process.stdout.write(`  · ${label}…`);
  const start = Date.now();
  const tx    = await txFn();
  const hash  = tx.hash;
  process.stdout.write(` sent (${hash.slice(0, 12)}…), waiting…`);
  await tx.wait();
  console.log(` ${DIM}${Date.now() - start}ms${RESET}`);
  return hash;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {

  // ── Network ───────────────────────────────────────────────────────────────
  Mina.setActiveInstance(Mina.Network({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    networkId: 'zeko' as any,
    mina:      ZEKO_URL,
  }));
  console.log(`\nNetwork: ${ZEKO_URL}`);

  // ── Deployer key ──────────────────────────────────────────────────────────
  const deployerKeyB58 = process.env['DEPLOYER_KEY'];

  if (!deployerKeyB58) {
    const fresh = PrivateKey.random();
    const addr  = fresh.toPublicKey().toBase58();
    console.log('\nNo DEPLOYER_KEY set. Generated a fresh key:');
    console.log(`\n  Address:  ${addr}`);
    console.log(`  Key:      ${fresh.toBase58()}`);
    console.log(`\nFund it at: ${ZEKO_FAUCET}?address=${addr}`);
    console.log(`\nThen re-run:\n  DEPLOYER_KEY=${fresh.toBase58()} bun scripts/deploy.ts\n`);
    process.exit(0);
  }

  const deployerKey = PrivateKey.fromBase58(deployerKeyB58);
  const deployer    = deployerKey.toPublicKey();
  info(`Deployer: ${deployer.toBase58()}`);

  // ── Balance check ─────────────────────────────────────────────────────────
  // Deployment needs ~6 fundNewAccount calls + fees ≈ 8+ MINA.
  const { account } = await Mina.getAccount(deployer);
  const balance      = Number(account?.balance?.toString() ?? 0);
  const balanceMina  = (balance / 1e9).toFixed(3);
  info(`Balance: ${balanceMina} MINA`);

  if (balance < 8_000_000_000) {
    console.error(`\n${RED}Insufficient balance.${RESET} Need at least 8 MINA.`);
    console.error(`Fund via: ${ZEKO_FAUCET}?address=${deployer.toBase58()}\n`);
    process.exit(1);
  }

  // ── Generate contract keys ────────────────────────────────────────────────
  const nftKey     = PrivateKey.random();
  const auctionKey = PrivateKey.random();
  const nftAddr    = nftKey.toPublicKey();
  const auctionAddr = auctionKey.toPublicKey();

  info(`NFT contract:     ${nftAddr.toBase58()}`);
  info(`Auction contract: ${auctionAddr.toBase58()}`);
  info(`Auction duration: ${AUCTION_DURATION_BLOCKS} blocks (~${Math.round(AUCTION_DURATION_BLOCKS * 30 / 3600)} h)`);
  info(`Reveal duration:  ${REVEAL_DURATION_BLOCKS} blocks (~${Math.round(REVEAL_DURATION_BLOCKS * 30 / 3600)} h)`);

  // ── Compile ───────────────────────────────────────────────────────────────
  console.log('\nCompiling circuits…');
  process.stdout.write('  · NFTToken');
  await NFTToken.compile();
  console.log(' ✓');

  process.stdout.write('  · BidCommitmentProgram');
  await BidCommitmentProgram.compile();
  console.log(' ✓');

  process.stdout.write('  · BidAggregator');
  await BidAggregator.compile();
  console.log(' ✓');

  process.stdout.write('  · auctionOffchainState');
  await auctionOffchainState.compile();
  console.log(' ✓');

  process.stdout.write('  · AuctionContract');
  await AuctionContract.compile();
  console.log(' ✓');

  // ── Deploy NFTToken ───────────────────────────────────────────────────────
  console.log('\nDeploying NFTToken…');
  const nft = new NFTToken(nftAddr);
  await sendAndWait('deploy NFTToken', async () => {
    const tx = await Mina.transaction({ sender: deployer, fee: 100_000_000 }, async () => {
      AccountUpdate.fundNewAccount(deployer);
      await nft.deploy({});
    });
    await tx.prove();
    return tx.sign([deployerKey, nftKey]).send();
  });
  ok(`NFTToken deployed at ${nftAddr.toBase58()}`);

  // ── Mint NFT to deployer (= seller) ──────────────────────────────────────
  console.log('\nMinting NFT to deployer (seller)…');
  await sendAndWait('mint NFT', async () => {
    const tx = await Mina.transaction({ sender: deployer, fee: 100_000_000 }, async () => {
      AccountUpdate.fundNewAccount(deployer); // creates deployer's token account
      await nft.mint(deployer);
    });
    await tx.prove();
    return tx.sign([deployerKey]).send();
  });
  ok('NFT minted to deployer');

  // ── Deploy AuctionContract ────────────────────────────────────────────────
  console.log('\nDeploying AuctionContract…');
  const auction = new AuctionContract(auctionAddr);
  await sendAndWait('deploy AuctionContract', async () => {
    const tx = await Mina.transaction({ sender: deployer, fee: 100_000_000 }, async () => {
      AccountUpdate.fundNewAccount(deployer);
      await auction.deploy({});
    });
    await tx.prove();
    return tx.sign([deployerKey, auctionKey]).send();
  });
  ok(`AuctionContract deployed at ${auctionAddr.toBase58()}`);

  // ── Initialize (escrow NFT) ───────────────────────────────────────────────
  // auctionKey co-signs once here so initialize() can set send:proof() + impossible
  // permissions on the vault token account. After this tx, auctionKey is never
  // needed again — the vault only accepts AuctionContract @method proofs.
  console.log('\nInitializing auction (escrows NFT, locks vault permissions)…');
  await sendAndWait('initialize', async () => {
    const tx = await Mina.transaction({ sender: deployer, fee: 100_000_000 }, async () => {
      AccountUpdate.fundNewAccount(deployer); // auction's token account (holds the NFT)
      await auction.initialize(
        nftAddr,
        UInt32.from(AUCTION_DURATION_BLOCKS),
        UInt32.from(REVEAL_DURATION_BLOCKS),
      );
    });
    await tx.prove();
    return tx.sign([deployerKey, auctionKey]).send();
  });
  ok('Auction initialized — NFT escrowed, vault locked to proof-only');

  // ── SettleState (flush OffchainState writes from initialize) ──────────────
  console.log('\nSettling OffchainState…');
  auction.offchainState.setContractInstance(auction);
  await sendAndWait('settleState', async () => {
    const proof = await auction.offchainState.createSettlementProof();
    const tx = await Mina.transaction({ sender: deployer, fee: 100_000_000 }, async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await auction.settleState(proof as any);
    });
    await tx.prove();
    return tx.sign([deployerKey]).send();
  });
  ok('OffchainState settled — auction is live');

  // ── Save output ───────────────────────────────────────────────────────────
  const output = {
    network:      'zeko-devnet',
    deployedAt:   new Date().toISOString(),
    deployer:     deployer.toBase58(),
    nftContract: {
      address:    nftAddr.toBase58(),
      privateKey: nftKey.toBase58(),
    },
    auctionContract: {
      address:    auctionAddr.toBase58(),
      privateKey: auctionKey.toBase58(),
    },
    auctionDurationBlocks: AUCTION_DURATION_BLOCKS,
    revealDurationBlocks:  REVEAL_DURATION_BLOCKS,
  };

  writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log(`\n${GREEN}Deployment complete!${RESET}`);
  console.log(`\nOutput saved to: ${OUTPUT_FILE}`);
  console.log('\nAdd to ui/.env.local:');
  console.log(`${YELLOW}  VITE_CONTRACT_ADDRESS=${auctionAddr.toBase58()}${RESET}`);
  console.log(`\n${DIM}Note: ${OUTPUT_FILE} contains the private keys used during deployment.`);
  console.log(`The vault is now permanently locked — no private key is needed at runtime.`);
  console.log(`Store ${OUTPUT_FILE} offline for record-keeping; it is inert for further state changes.${RESET}`);
  console.log('');
}

main().catch(e => {
  console.error(`\n${RED}Deploy failed:${RESET}`, e?.message ?? e);
  process.exit(1);
});
