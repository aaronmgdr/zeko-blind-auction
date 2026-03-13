/**
 * BidAggregator.ts — sequential ZkProgram for winner determination.
 *
 * After the reveal phase ends, the settler reads every entry from the
 * AuctionContract's OffchainState `revealed` map and builds a linear chain
 * of proofs — one per reveal — folding them into a single WinningBid.
 * The final proof is passed to AuctionContract.settle().
 *
 * ── Why not use Reducer / action state? ──────────────────────────────────────
 *
 * OffchainState and Reducer both write to account.actionState.
 * Mixing them causes "invalid action size" when the OffchainState settlement
 * processes RevealActions (different field count). To avoid this conflict,
 * reveals are supplied off-chain by the settler reading the settled
 * OffchainState `revealed` map.
 *
 * ── Proof structure (linear chain) ──────────────────────────────────────────
 *
 *   base()               → WinningBid{ empty, 0 }
 *   step(base, reveal_1) → WinningBid{ winner_1, amount_1 }
 *   step(prev, reveal_2) → WinningBid{ winner_2, amount_2 }
 *   ...
 *   step(prev, reveal_N) → WinningBid{ winnerFinal, amountFinal }
 *
 * publicInput is always Field(0) — no action state chain is tracked.
 *
 * ── Winner selection ─────────────────────────────────────────────────────────
 *
 * Highest bid wins. Ties go to the earlier-supplied reveal.
 * The selector is purely arithmetic using Provable.if.
 */
import {
  ZkProgram,
  Field,
  PublicKey,
  UInt64,
  SelfProof,
  Provable,
} from 'o1js';
import { RevealAction, WinningBid } from './types.js';

export const BidAggregator = ZkProgram({
  name: 'bid-aggregator',

  /**
   * publicInput: always Field(0).
   * Kept for structural reasons (ZkProgram requires a publicInput type).
   */
  publicInput: Field,

  /**
   * publicOutput: the running best bid after processing all reveals so far.
   * The final proof's publicOutput is { winner, amount } written to state.
   */
  publicOutput: WinningBid,

  methods: {
    /**
     * Base case — no reveals processed yet.
     */
    base: {
      privateInputs: [],
      async method(_zero: Field): Promise<{ publicOutput: WinningBid }> {
        return {
          publicOutput: new WinningBid({ winner: PublicKey.empty(), amount: UInt64.zero }),
        };
      },
    },

    /**
     * Inductive step — fold one reveal into the running winner.
     *
     * @param _zero     publicInput — always Field(0), not used.
     * @param prevProof The proof for all previous reveals.
     * @param action    The RevealAction (bidder, amount) to apply.
     */
    step: {
      privateInputs: [SelfProof, RevealAction],
      async method(
        _zero: Field,
        prevProof: SelfProof<Field, WinningBid>,
        action: RevealAction,
      ): Promise<{ publicOutput: WinningBid }> {
        prevProof.verify();

        const prev = prevProof.publicOutput;
        const currentWins = action.amount.greaterThan(prev.amount);

        return {
          publicOutput: new WinningBid({
            winner: Provable.if(currentWins, PublicKey, action.bidder, prev.winner),
            amount: Provable.if(currentWins, UInt64, action.amount, prev.amount),
          }),
        };
      },
    },
  },
});

/** Proof class — pass an instance to AuctionContract.settle(). */
export class BidAggregatorProof extends BidAggregator.Proof {}
