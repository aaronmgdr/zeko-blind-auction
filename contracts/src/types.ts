/**
 * types.ts — shared structs used by both AuctionContract and BidAggregator.
 *
 * Kept in a separate file to break the circular import that would arise if
 * AuctionContract defined RevealAction and BidAggregator imported it while
 * AuctionContract also imports BidAggregatorProof.
 *
 * Uses `class X extends Struct({...}) {}` rather than `const X = Struct({...})`,
 * so that `X` as a TypeScript *type* refers to *instances* of the struct
 * (not the constructor). This makes ZkProgram method signatures type-check
 * correctly (methods return Promise<{ publicOutput: WinningBid }> etc.).
 */
import { PublicKey, UInt64, Struct } from 'o1js';

/**
 * Action dispatched by revealBid(). One action per bidder per reveal.
 * The BidAggregator ZkProgram folds all of these into a single WinningBid.
 */
export class RevealAction extends Struct({
  bidder: PublicKey,
  amount: UInt64,
}) {}

/**
 * The public output of the BidAggregator proof — the highest bidder so far.
 * Returned by BidAggregator methods and written to OffchainState by settle().
 */
export class WinningBid extends Struct({
  winner: PublicKey,
  amount: UInt64,
}) {}
