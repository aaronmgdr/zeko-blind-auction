# Blind Auction zkApp

A zero-knowledge blind auction running on [Zeko](https://zeko.io), built with [o1js](https://docs.minaprotocol.com/zkapps/o1js).

## Why zero-knowledge blind auctions?

In a traditional blind auction, participants submit sealed bids without seeing each other's offers. The problem: you have to trust the auctioneer not to peek. On a public blockchain without ZK, every bid is visible on-chain the moment it lands.

Zero-knowledge proofs solve both problems at once. Bids are committed as cryptographic hashes — the bid amount is provably hidden from everyone, including the chain, until the bidder chooses to reveal it. No trusted auctioneer. No peeking. The rules are enforced by math.

## How it works

The auction runs in four phases, each enforced on-chain:

1. **Commit** — Bidders submit `Poseidon.hash([amount, salt])` with a flat participation bond. The bond is identical for all bidders so the locked MINA reveals nothing about bid size.
2. **Reveal** — After the commit window closes, bidders publish their `(amount, salt)` preimage. The contract verifies it matches the stored commitment and locks the actual bid amount.
3. **Settle** — A `BidAggregator` ZkProgram recursively processes every revealed bid off-chain and produces a single proof of the winner. Anyone can submit this proof — the settler has no special trust.
4. **Claim / Reclaim** — The winner claims the escrowed NFT; losers reclaim their bond and bid. Non-revealers forfeit their bond to a protocol address (not the seller, to prevent griefing incentives).

## What the NFT represents

The auctioned asset is an NFT issued by a custom `NFTToken` contract, but it can represent anything with a clear owner:

- Digital art or media rights
- A domain name or username
- A software licence
- A **service contract** — flip to lowest-bid-wins and the winner is the party offering to do the work for the least 

That last case is particularly interesting for the **agent economy**: autonomous agents bidding to fulfil tasks, process jobs, or provide compute — with the auction outcome determined by cryptographic proof, not a trusted coordinator.

## Security model

- Bid amounts are hidden until the reveal phase; only the commitment hash is ever stored.
- The NFT escrow vault is locked at initialisation with `send: proof()` + `setVerificationKey/setPermissions: impossible()`. The auction contract's private key is used once at deploy time and is inert forever after — the browser never touches it.
- Reserve price compliance is baked into the `BidCommitmentProgram` circuit verification key, not checked as a runtime parameter, so it cannot be tampered with after deployment.

## Project layout

```
contracts/   o1js smart contracts + ZkPrograms
  src/
    AuctionContract.ts     main auction logic
    NFTToken.ts            custom token (the auctioned asset)
    BidCommitmentProgram.ts  proves amount ≥ reserve without revealing it
    BidAggregator.ts       recursive proof that determines the winner
  scripts/
    deploy.ts              deploy to Zeko devnet
    buildCache.ts          pre-build circuit keys for the browser cache
  test.ts                  full end-to-end test on LocalBlockchain

ui/          React + Vite frontend
  src/
    zkappWorker.ts         o1js runs in a Web Worker (keeps UI responsive)
    ZkappWorkerClient.ts   Comlink bridge — main thread ↔ worker
    App.tsx                auction UI
```

## Getting started

```bash
# Install
bun install

# Run the local end-to-end test (fast, no proofs)
bun test

# Run with full ZK proofs (~10–20 min)
PROOFS=1 bun test

# Deploy to Zeko devnet
bun run deploy                       # step 1: generates a deployer key, prints funding URL
DEPLOYER_KEY=EKF... bun run deploy   # step 2: deploys

# Start the UI
bun run dev
```

After deploying, add `VITE_CONTRACT_ADDRESS=<address>` to `ui/.env.local` and the frontend will connect automatically.
