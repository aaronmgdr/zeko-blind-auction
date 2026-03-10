---
name: zeko-app
description: Build the application layer for a Zeko zkApp — project structure, web worker setup, Auro wallet connection, network config, transaction flow end-to-end. Use when scaffolding a new zkApp frontend, connecting to Auro wallet, configuring the Zeko network, wiring the web worker, or sending a transaction from the browser. Delegates contract logic to zeko-contract, proof logic to zeko-zkprogram, state management to zeko-state, security to zeko-security, and testing to zeko-testing.
---

# Zeko App Architecture

## How it works

```
Browser (Next.js, static)
  │
  ├── Main Thread (React UI)
  │     └── Comlink calls ──► Web Worker (zkappWorker.ts)
  │                                 ├── o1js + WASM
  │                                 ├── compile contract (once)
  │                                 ├── fetchAccount / read state
  │                                 ├── Mina.transaction(...)
  │                                 └── tx.prove()  ← ZK proof here
  │
  ├── window.mina (Auro wallet)
  │     ├── signs proven tx JSON
  │     └── submits to Zeko sequencer
  │
  └── Zeko GraphQL
        ├── https://devnet.zeko.io/graphql
        └── https://devnet.zeko.io/archive  (needed for Actions)
```

**Proof generation is client-side** — private inputs never leave the browser. Zeko's near-instant finality means the 30–90s browser proving time dominates UX, not block time. No Node.js backend is needed; deploy as a static site (GitHub Pages, Vercel, Cloudflare Pages).

---

## Project structure (zkApp CLI scaffold)

```
my-zkapp/
├── contracts/
│   └── src/MyContract.ts       ← SmartContract (see zeko-contract skill)
└── ui/                         ← Next.js 14 app
    ├── next.config.mjs         ← COOP/COEP headers (required)
    ├── app/
    │   ├── page.tsx            ← React UI, calls worker via client
    │   ├── zkappWorker.ts      ← Web worker: all o1js runs here
    │   └── ZkappWorkerClient.ts ← Main-thread proxy to worker
    └── public/cache/           ← Optional: pre-compiled verification keys
```

Bootstrap with the CLI:
```bash
npm install -g zkapp-cli
zk project my-zkapp  # choose Next.js when prompted
```

---

## Required: COOP/COEP headers

o1js uses WASM + `SharedArrayBuffer`, which requires cross-origin isolation. Add to `next.config.mjs`:

```javascript
/** @type {import('next').NextConfig} */
const nextConfig = {
  async headers() {
    return [{
      source: '/(.*)',
      headers: [
        { key: 'Cross-Origin-Opener-Policy',   value: 'same-origin' },
        { key: 'Cross-Origin-Embedder-Policy', value: 'require-corp' },
      ],
    }];
  },
};
export default nextConfig;
```

Without these, WASM initialisation fails silently.

---

## Web worker (`zkappWorker.ts`)

All o1js work runs here — never in the main thread.

```typescript
import { Mina, PublicKey, fetchAccount, Field } from 'o1js';
import * as Comlink from 'comlink';

// Import compiled contract (built from contracts/)
import type { MyContract } from '../../contracts/src/MyContract';

type Transaction = Awaited<ReturnType<typeof Mina.transaction>>;

const state = {
  Contract: null as null | typeof MyContract,
  zkapp:    null as null | MyContract,
  tx:       null as null | Transaction,
};

export const api = {
  // 1. Configure the Zeko network
  async setNetwork() {
    const network = Mina.Network({
      networkId: 'zeko',                          // NOT 'testnet' — this is Zeko L2
      mina:    'https://devnet.zeko.io/graphql',
      archive: 'https://devnet.zeko.io/archive',  // required if using Actions
    });
    Mina.setActiveInstance(network);
  },

  // 2. Load + compile the contract (do once; takes 30–90s)
  async loadAndCompile() {
    const { MyContract } = await import('../../contracts/build/src/MyContract.js');
    state.Contract = MyContract;
    await MyContract.compile();
  },

  // 3. Bind contract instance to deployed address
  async initInstance(address58: string) {
    state.zkapp = new state.Contract!(PublicKey.fromBase58(address58));
  },

  // 4. Read on-chain state
  async fetchAccount(pk58: string) {
    return fetchAccount({ publicKey: PublicKey.fromBase58(pk58) });
  },
  async getFieldValue(): Promise<string> {
    const val = await state.zkapp!.myField.fetch();
    return JSON.stringify(val?.toJSON() ?? null);
  },

  // 5. Build + prove a transaction (two separate calls so UI can show progress)
  async buildTx(arg58: string) {
    await fetchAccount({ publicKey: state.zkapp!.address });
    state.tx = await Mina.transaction(async () => {
      await state.zkapp!.update(Field.fromJSON(JSON.parse(arg58)));
    });
  },
  async proveTx() {
    await state.tx!.prove(); // 30–90s
  },
  async getTxJSON(): Promise<string> {
    return state.tx!.toJSON();
  },
};

Comlink.expose(api);
```

---

## Worker client (`ZkappWorkerClient.ts`)

Thin proxy — main thread calls these as normal async functions.

```typescript
import * as Comlink from 'comlink';

export class ZkappWorkerClient {
  private api: Comlink.Remote<typeof import('./zkappWorker').api>;

  constructor() {
    const worker = new Worker(new URL('./zkappWorker.ts', import.meta.url), { type: 'module' });
    this.api = Comlink.wrap(worker);
  }

  setNetwork()                       { return this.api.setNetwork(); }
  loadAndCompile()                   { return this.api.loadAndCompile(); }
  initInstance(addr: string)         { return this.api.initInstance(addr); }
  fetchAccount(pk: string)           { return this.api.fetchAccount(pk); }
  getFieldValue()                    { return this.api.getFieldValue(); }
  buildTx(arg: string)               { return this.api.buildTx(arg); }
  proveTx()                          { return this.api.proveTx(); }
  getTxJSON()                        { return this.api.getTxJSON(); }
}
```

---

## Auro wallet (`page.tsx`)

```typescript
'use client';
import { useEffect, useState } from 'react';
import { ZkappWorkerClient } from './ZkappWorkerClient';

export default function Page() {
  const [client]    = useState(() => new ZkappWorkerClient());
  const [wallet, setWallet] = useState<string | null>(null);
  const [status, setStatus] = useState('');

  // Initialise worker on mount
  useEffect(() => {
    (async () => {
      setStatus('Setting up network...');
      await client.setNetwork();
      setStatus('Compiling contract...');
      await client.loadAndCompile();
      await client.initInstance(process.env.NEXT_PUBLIC_ZKAPP_ADDRESS!);
      setStatus('Ready');
    })();
  }, []);

  // Connect Auro wallet
  async function connectWallet() {
    const mina = (window as any).mina;
    if (!mina) { alert('Install Auro wallet'); return; }
    const [pk] = await mina.requestAccounts();
    setWallet(pk);
  }

  // Full transaction flow
  async function sendTx() {
    if (!wallet) return;

    setStatus('Fetching account...');
    await client.fetchAccount(wallet);

    setStatus('Building transaction...');
    await client.buildTx(/* your arg */);

    setStatus('Proving (this takes ~60s)...');
    await client.proveTx();

    setStatus('Waiting for wallet...');
    const txJSON = await client.getTxJSON();
    const { hash } = await (window as any).mina.sendTransaction({
      transaction: txJSON,
      feePayer: { fee: '100000000', memo: '' }, // integer nanomina string
    });

    setStatus(`Submitted: ${hash}`);
  }

  return (
    <main>
      <p>{status}</p>
      {!wallet
        ? <button onClick={connectWallet}>Connect Auro</button>
        : <button onClick={sendTx}>Send Transaction</button>
      }
    </main>
  );
}
```

---

## Auro network switching

Users must have Zeko configured in Auro. Use these wallet APIs to add/switch programmatically:

```typescript
const mina = (window as any).mina;

// Check current network
const current = await mina.requestNetwork(); // { networkID: string }

// Add Zeko devnet to Auro
await mina.addChain({
  name: 'Zeko Devnet',
  url:  'https://devnet.zeko.io/graphql',
  networkID: 'zeko:devnet',
});

// Switch to Zeko
await mina.switchChain({ networkID: 'zeko:devnet' });
```

Minimum Auro versions: **browser v2.4.1+**, **mobile v2.2.0+**.

---

## Fee rules

Always pass fees as **integer nanomina strings** — never decimals.

```typescript
// WRONG — causes BigInt error
feePayer: { fee: 0.1 }

// CORRECT — 0.1 MINA
feePayer: { fee: '100000000' }
```

---

## ZkProgram + SmartContract in the worker

For heavy computation, run the `ZkProgram` proof first, then use it in the transaction. See **zeko-zkprogram** skill for ZkProgram authoring.

```typescript
// In zkappWorker.ts
async buildAndProveTx(privateInput: string) {
  // 1. Generate ZkProgram proof (private inputs stay in worker)
  const proof = await MyProgram.compute(
    Field.fromJSON(JSON.parse(privateInput))
  );

  // 2. Build SmartContract transaction using that proof
  state.tx = await Mina.transaction(async () => {
    await state.zkapp!.settle(proof);
  });

  // 3. Prove the transaction wrapper
  await state.tx.prove();
}
```

---

## Reading state and events

```typescript
// In worker — always fetchAccount first before reading state
await fetchAccount({ publicKey: zkappAddress });
const root = await zkapp.root.fetch(); // Field | undefined

// Fetch events (requires archive node endpoint)
const events = await zkapp.fetchEvents();
// [{ type: 'myEvent', event: { data: Field[], transactionInfo: { ... } } }]

// Fetch with block range
const recent = await zkapp.fetchEvents(UInt32.from(0));
```

For state management patterns (Merkle trees, OffchainState, Actions), see the **zeko-state** skill.

---

## Deployment environment variable

```
NEXT_PUBLIC_ZKAPP_ADDRESS=B62q...   # deployed contract address (public, client-readable)
```

For security best practices and permission hardening, see the **zeko-security** skill.
For writing the SmartContract, see the **zeko-contract** skill.
For testing the full stack, see the **zeko-testing** skill.
