/**
 * zkappWorker.ts — runs in a Web Worker
 *
 * All o1js code lives here. The main thread never imports o1js directly;
 * it communicates through ZkappWorkerClient via Comlink.
 *
 * React StrictMode calls constructors twice — the useRef pattern in App.tsx
 * ensures only one Worker is ever created.
 *
 * COMPILE FLOW
 * ────────────
 * Compilation is split into fine-grained steps so the main thread can report
 * progress.  Call them in order:
 *   1. loadCircuitCache(onProgress)   — IDB / server fetch
 *   2. compileBidCommitmentProgram()
 *   3. compileBidAggregator()
 *   4. compileOffchainState()
 *   5. compileAuctionContract()       — also flushes IDB cache
 *
 * TRANSACTION FLOW
 * ────────────────
 * Each buildXxxTx() method builds the Mina.transaction but does NOT call
 * tx.prove().  Call proveTx() separately so the main thread can show a
 * distinct "Proving…" status before the slow step.
 */
import { expose }                   from 'comlink';
import { Mina, PublicKey, fetchAccount } from 'o1js';
import { makeIDBCache, type O1jsCache } from './idbCache.js';

// ── Module-level helpers ──────────────────────────────────────────────────────

function rethrow(label: string, e: unknown): never {
  const msg = e instanceof Error
    ? `${label}: ${e.message}\nStack: ${e.stack ?? '(no stack)'}`
    : `${label}: ${String(e)}`;
  throw new Error(msg);
}

// A progress callback proxied from the main thread via Comlink.
type OnProgress = (msg: string) => void | Promise<void>;

// ── Worker state ─────────────────────────────────────────────────────────────

type Contracts = Awaited<typeof import('blind-auction-contracts')>;

type WorkerState = {
  AuctionContract: Contracts['AuctionContract'] | null;
  zkapp:           InstanceType<Contracts['AuctionContract']> | null;
  // Most-recently built transaction — serialised by getTxJSON() for Auro.
  tx:              { toJSON(): string; prove(): Promise<unknown> } | null;
  // Set by loadCircuitCache, consumed by the four compile steps.
  contracts:       Contracts | null;
  circuitCache:    O1jsCache | null;
  persistFn:       (() => Promise<void>) | null;
};

const state: WorkerState = {
  AuctionContract: null,
  zkapp:           null,
  tx:              null,
  contracts:       null,
  circuitCache:    null,
  persistFn:       null,
};

// ── API ───────────────────────────────────────────────────────────────────────

const api = {

  // ── Setup ──────────────────────────────────────────────────────────────────

  async setNetwork() {
    const Zeko = Mina.Network({
      // Zeko devnet uses a custom network ID not in o1js's NetworkId union.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      networkId: 'zeko' as any,
      mina:      'https://devnet.zeko.io/graphql',
    });
    Mina.setActiveInstance(Zeko);
  },

  // ── Compile steps ──────────────────────────────────────────────────────────

  /**
   * Step 1 — import the contracts bundle and load circuit keys.
   *
   * On first visit: downloads ~1 GB of pre-built key files from
   * /circuit-cache/ and stores them in IndexedDB.
   * On repeat visits: reads from IndexedDB (fast, no network).
   *
   * `onProgress` is called with human-readable status strings throughout.
   * Pass a Comlink proxy() so it fires back to the main thread.
   */
  async loadCircuitCache(onProgress?: OnProgress): Promise<void> {
    let contracts: Contracts;
    try {
      contracts = await import('blind-auction-contracts');
    } catch (e) { rethrow('import(blind-auction-contracts)', e); }

    state.contracts       = contracts!;
    state.AuctionContract = contracts!.AuctionContract;

    // Placeholder address — address is not part of the VK.
    try {
      state.zkapp = new contracts!.AuctionContract(PublicKey.empty());
    } catch (e) { rethrow('new AuctionContract()', e); }

    const { cache, persist } = await makeIDBCache(onProgress);
    state.circuitCache = cache;
    state.persistFn    = persist;
  },

  /** Step 2 — compile BidCommitmentProgram (no dependencies). */
  async compileBidCommitmentProgram(): Promise<void> {
    if (!state.contracts || !state.circuitCache)
      throw new Error('Call loadCircuitCache() first');
    try {
      await state.contracts.BidCommitmentProgram.compile({ cache: state.circuitCache });
    } catch (e) { rethrow('BidCommitmentProgram.compile()', e); }
  },

  /** Step 3 — compile BidAggregator (no dependencies). */
  async compileBidAggregator(): Promise<void> {
    if (!state.contracts || !state.circuitCache)
      throw new Error('Call loadCircuitCache() first');
    try {
      await state.contracts.BidAggregator.compile({ cache: state.circuitCache });
    } catch (e) { rethrow('BidAggregator.compile()', e); }
  },

  /**
   * Step 4 — compile OffchainState.
   *
   * OffchainState.compile() is typed with no arguments but the underlying
   * ZkProgram may accept { cache } at runtime — try it, fall back if not.
   */
  async compileOffchainState(): Promise<void> {
    if (!state.contracts || !state.circuitCache)
      throw new Error('Call loadCircuitCache() first');
    const { auctionOffchainState } = state.contracts;
    try {
      try {
        await (auctionOffchainState.compile as (o: { cache?: O1jsCache }) => Promise<unknown>)(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          { cache: state.circuitCache } as any,
        );
      } catch (inner) {
        // If the runtime function rejected the cache option, retry without it.
        if (inner instanceof TypeError) await auctionOffchainState.compile();
        else throw inner;
      }
    } catch (e) { rethrow('auctionOffchainState.compile()', e); }
  },

  /**
   * Step 5 — compile AuctionContract (depends on all prior VKs).
   * Also flushes any new cache entries to IndexedDB in the background.
   */
  async compileAuctionContract(): Promise<void> {
    if (!state.contracts || !state.circuitCache)
      throw new Error('Call loadCircuitCache() first');
    try {
      await state.contracts.AuctionContract.compile({ cache: state.circuitCache });
    } catch (e) { rethrow('AuctionContract.compile()', e); }

    // Write new entries to IndexedDB in the background — don't block the caller.
    state.persistFn?.().catch(e => console.warn('Circuit cache write failed:', e));
  },

  /**
   * Point the worker at a deployed contract address.
   * Must be called after all compile steps and before any transaction methods.
   *
   * `new AuctionContract(addr)` triggers `offchainState = auctionOffchainState.init(this)`
   * which memoises the OffchainStateInstance by contract address.
   */
  async setContractAddress(contractAddress: string) {
    if (!state.AuctionContract) throw new Error('Call loadCircuitCache() first');
    state.zkapp = new state.AuctionContract(PublicKey.fromBase58(contractAddress));
  },

  async fetchContractAccount(contractAddress: string) {
    await fetchAccount({ publicKey: PublicKey.fromBase58(contractAddress) });
  },

  // ── Read state ─────────────────────────────────────────────────────────────

  async getAuctionState() {
    if (!state.zkapp) throw new Error('Contract not loaded');
    await fetchAccount({ publicKey: state.zkapp.address });
    return {
      initialized: state.zkapp.initialized.get().toBoolean(),
      winner:      state.zkapp.winner.get().toBase58(),
      auctionEnd:  state.zkapp.auctionEnd.get().toString(),
      revealEnd:   state.zkapp.revealEnd.get().toString(),
    };
  },

  // ── Phase 1: Commit ────────────────────────────────────────────────────────

  /**
   * Compute the bid commitment privately in the worker.
   * amount (nanomina string) and salt (field JSON string) never leave this
   * worker. Returns the commitment as a JSON field string.
   */
  async computeCommitment(amountNano: string, saltJson: string): Promise<string> {
    const { Poseidon, Field, UInt64 } = await import('o1js');
    const amount = UInt64.from(BigInt(amountNano));
    const salt   = Field.fromJSON(JSON.parse(saltJson));
    const commitment = Poseidon.hash([...amount.toFields(), salt]);
    return JSON.stringify(commitment.toJSON());
  },

  /**
   * Generate a ZK proof that:
   *   1. amount >= RESERVE_PRICE
   *   2. commitment = Poseidon.hash([...amount.toFields(), salt])
   *
   * amount and salt stay private inside this worker. Only the proof + the
   * commitment (public input) are returned to the main thread.
   *
   * Returns the proof as a JSON string — pass to buildCommitBidTx().
   *
   * Note: ZkProgram methods return { proof, auxiliaryOutput } — we extract
   * the proof before serialising.
   */
  async proveBidCommitment(
    amountNano: string,
    saltJson:   string,
  ): Promise<string> {
    const { BidCommitmentProgram }     = await import('blind-auction-contracts');
    const { Field, UInt64, Poseidon }  = await import('o1js');

    const amount     = UInt64.from(BigInt(amountNano));
    const salt       = Field.fromJSON(JSON.parse(saltJson));
    const commitment = Poseidon.hash([...amount.toFields(), salt]);

    const { proof } = await BidCommitmentProgram.prove(commitment, amount, salt);
    return JSON.stringify(proof.toJSON());
  },

  /**
   * Build the commitBid transaction without proving.
   * Call proveTx() next, then getTxJSON() + Auro for signing.
   */
  async buildCommitBidTx(
    sender58:  string,
    proofJson: string,
    bondNano:  string,
  ): Promise<void> {
    if (!state.zkapp) throw new Error('Contract not loaded');
    const { BidCommitmentProof, BOND_AMOUNT } = await import('blind-auction-contracts');
    const { PublicKey, UInt64 }                = await import('o1js');

    const sender = PublicKey.fromBase58(sender58);
    // Proof.fromJSON is async in o1js v2
    const proof  = await BidCommitmentProof.fromJSON(JSON.parse(proofJson));
    const bond   = UInt64.from(BigInt(bondNano));

    if (bond.toString() !== BOND_AMOUNT.toString()) {
      throw new Error(`bond must be exactly ${BOND_AMOUNT} nanomina (1 MINA)`);
    }

    await fetchAccount({ publicKey: state.zkapp.address });

    state.tx = await Mina.transaction({ sender, fee: 100_000_000 }, async () => {
      await state.zkapp!.commitBid(proof, bond);
    });
  },

  // ── Phase 2: Reveal ────────────────────────────────────────────────────────

  /**
   * Build the revealBid transaction without proving.
   * Call proveTx() next, then getTxJSON() + Auro for signing.
   */
  async buildRevealBidTx(
    sender58:   string,
    amountNano: string,
    saltJson:   string,
  ): Promise<void> {
    if (!state.zkapp) throw new Error('Contract not loaded');
    const { Field, UInt64, PublicKey } = await import('o1js');
    const sender = PublicKey.fromBase58(sender58);
    const amount = UInt64.from(BigInt(amountNano));
    const salt   = Field.fromJSON(JSON.parse(saltJson));

    await fetchAccount({ publicKey: state.zkapp.address });

    state.tx = await Mina.transaction({ sender, fee: 100_000_000 }, async () => {
      await state.zkapp!.revealBid(amount, salt);
    });
  },

  // ── Phase 3: Settle ────────────────────────────────────────────────────────

  /**
   * Build the sequential BidAggregator proof chain from the supplied reveals.
   *
   * The Reducer was removed from AuctionContract to avoid a conflict with
   * OffchainState (both write to account.actionState with incompatible action
   * sizes).  Reveals are now enumerated off-chain by the settler, who reads
   * them from the settled OffchainState `revealed` map or their own records.
   *
   * reveals — array of { bidder58, amountNano } for every bidder who revealed.
   * Returns the final aggregator proof JSON — pass to buildSettleTx().
   *
   * BidAggregator.publicInput is always Field(0) (no action-state tracking).
   */
  async buildAggregatorProof(
    reveals: Array<{ bidder58: string; amountNano: string }>,
  ): Promise<string> {
    if (!state.zkapp) throw new Error('Contract not loaded');
    const { BidAggregator, RevealAction } = await import('blind-auction-contracts');
    const { Field, PublicKey, UInt64 }    = await import('o1js');

    // Base proof — no reveals processed yet.
    // ZkProgram methods return { proof, auxiliaryOutput } — extract the proof.
    let { proof: currentProof } = await BidAggregator.base(Field(0));

    for (const { bidder58, amountNano } of reveals) {
      const action = new RevealAction({
        bidder: PublicKey.fromBase58(bidder58),
        amount: UInt64.from(BigInt(amountNano)),
      });
      ({ proof: currentProof } = await BidAggregator.step(Field(0), currentProof, action));
    }

    return JSON.stringify(currentProof.toJSON());
  },

  /**
   * Build the settle transaction without proving.
   * Call proveTx() next, then getTxJSON() + Auro for signing.
   */
  async buildSettleTx(sender58: string, proofJson: string): Promise<void> {
    if (!state.zkapp) throw new Error('Contract not loaded');
    const { BidAggregatorProof } = await import('blind-auction-contracts');
    const { PublicKey }           = await import('o1js');

    const sender = PublicKey.fromBase58(sender58);
    // Proof.fromJSON is async in o1js v2
    const proof  = await BidAggregatorProof.fromJSON(JSON.parse(proofJson));

    await fetchAccount({ publicKey: state.zkapp.address });

    state.tx = await Mina.transaction({ sender, fee: 100_000_000 }, async () => {
      await state.zkapp!.settle(proof);
    });
  },

  // ── Phase 4: Claim / Reclaim ───────────────────────────────────────────────

  /**
   * Build the claimNFT transaction without proving.
   * Call proveTx() next, then getTxJSON() + Auro for signing.
   */
  async buildClaimNFTTx(sender58: string): Promise<void> {
    if (!state.zkapp) throw new Error('Contract not loaded');
    const { PublicKey } = await import('o1js');
    const sender = PublicKey.fromBase58(sender58);

    await fetchAccount({ publicKey: state.zkapp.address });

    state.tx = await Mina.transaction({ sender, fee: 100_000_000 }, async () => {
      await state.zkapp!.claimNFT();
    });
  },

  /**
   * Build the reclaimDeposit transaction without proving.
   * Call proveTx() next, then getTxJSON() + Auro for signing.
   */
  async buildReclaimDepositTx(sender58: string): Promise<void> {
    if (!state.zkapp) throw new Error('Contract not loaded');
    const { PublicKey } = await import('o1js');
    const sender = PublicKey.fromBase58(sender58);

    await fetchAccount({ publicKey: state.zkapp.address });

    state.tx = await Mina.transaction({ sender, fee: 100_000_000 }, async () => {
      await state.zkapp!.reclaimDeposit();
    });
  },

  // ── Transaction helpers ────────────────────────────────────────────────────

  /**
   * Prove the most recently built transaction.
   * This is the slow step (~30–120 s depending on the circuit).
   * Separated from buildXxxTx() so the caller can show a distinct status.
   */
  async proveTx(): Promise<void> {
    if (!state.tx) throw new Error('No transaction built');
    await state.tx.prove();
  },

  async getTxJSON(): Promise<string> {
    if (!state.tx) throw new Error('No transaction built');
    return state.tx.toJSON();
  },
};

export type WorkerApi = typeof api;

expose(api);
