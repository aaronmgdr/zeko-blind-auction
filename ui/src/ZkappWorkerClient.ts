/**
 * ZkappWorkerClient.ts — thin Comlink proxy over the Web Worker.
 *
 * Instantiated once via useRef in App.tsx to avoid double-creation
 * under React StrictMode.
 *
 * Callbacks passed to the worker (e.g. onProgress) are wrapped with
 * Comlink's proxy() so they can be called back from the worker thread.
 */
import { wrap, proxy, type Remote } from 'comlink';
import type { WorkerApi } from './zkappWorker.js';

export class ZkappWorkerClient {
  private api: Remote<WorkerApi>;

  constructor() {
    const worker = new Worker(
      new URL('./zkappWorker.ts', import.meta.url),
      { type: 'module' },
    );
    this.api = wrap<WorkerApi>(worker);
  }

  setNetwork()                                         { return this.api.setNetwork(); }
  setContractAddress(contractAddress: string)          { return this.api.setContractAddress(contractAddress); }
  fetchContractAccount(contractAddress: string)        { return this.api.fetchContractAccount(contractAddress); }
  getAuctionState()                                    { return this.api.getAuctionState(); }

  // ── Compile steps (call in order) ─────────────────────────────────────────

  /**
   * Step 1: load circuit keys from IndexedDB or server.
   * `onProgress` is proxied into the worker so it fires back on the main thread.
   */
  loadCircuitCache(onProgress: (msg: string) => void) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return this.api.loadCircuitCache(proxy(onProgress) as any);
  }

  /** Step 2: compile BidCommitmentProgram. */
  compileBidCommitmentProgram()  { return this.api.compileBidCommitmentProgram(); }

  /** Step 3: compile BidAggregator. */
  compileBidAggregator()         { return this.api.compileBidAggregator(); }

  /** Step 4: compile OffchainState. */
  compileOffchainState()         { return this.api.compileOffchainState(); }

  /** Step 5: compile AuctionContract (also flushes IDB cache). */
  compileAuctionContract()       { return this.api.compileAuctionContract(); }

  // ── Proof + transaction ───────────────────────────────────────────────────

  computeCommitment(amountNano: string, saltJson: string) {
    return this.api.computeCommitment(amountNano, saltJson);
  }

  proveBidCommitment(amountNano: string, saltJson: string) {
    return this.api.proveBidCommitment(amountNano, saltJson);
  }

  buildCommitBidTx(sender58: string, proofJson: string, bondNano: string) {
    return this.api.buildCommitBidTx(sender58, proofJson, bondNano);
  }

  buildRevealBidTx(sender58: string, amountNano: string, saltJson: string) {
    return this.api.buildRevealBidTx(sender58, amountNano, saltJson);
  }

  buildAggregatorProof(reveals: Array<{ bidder58: string; amountNano: string }>) {
    return this.api.buildAggregatorProof(reveals);
  }

  buildSettleTx(sender58: string, proofJson: string)   { return this.api.buildSettleTx(sender58, proofJson); }
  buildClaimNFTTx(sender58: string)                    { return this.api.buildClaimNFTTx(sender58); }
  buildReclaimDepositTx(sender58: string)              { return this.api.buildReclaimDepositTx(sender58); }

  /** Prove the most recently built transaction (slow — show a status before calling). */
  proveTx()                                            { return this.api.proveTx(); }

  getTxJSON()                                          { return this.api.getTxJSON(); }
}
