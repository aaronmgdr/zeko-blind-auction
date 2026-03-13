/**
 * BidCommitmentProgram.ts — ZkProgram for sealed-bid commitment.
 *
 * A bidder calls prove() locally in the browser (Web Worker) with their
 * chosen amount and random salt as private inputs. The resulting proof is
 * sent to commitBid() on the AuctionContract.
 *
 * What the proof guarantees (without revealing amount or salt):
 *  1. commitment = Poseidon.hash([...amount.toFields(), salt])
 *  2. amount >= RESERVE_PRICE
 *
 * The reserve price is baked into the circuit's verification key at compile
 * time, not stored per-bidder — any proof generated with a different
 * RESERVE_PRICE constant will have a different VK and will be rejected by
 * the contract's proof.verify() call.
 *
 * Privacy properties:
 *  - amount and salt never leave the browser; only the proof + commitment go
 *    on-chain.
 *  - All commitments look identical to an observer (all are Poseidon hashes).
 *  - The flat bond in commitBid() is the same for every bidder, so on-chain
 *    MINA flows reveal nothing about bid size either.
 */
import { ZkProgram, Field, UInt64, Poseidon } from 'o1js';

/** Minimum bid — baked into the circuit VK, not a per-bidder on-chain value. */
export const RESERVE_PRICE = UInt64.from(5_000_000_000n); // 5 MINA

export const BidCommitmentProgram = ZkProgram({
  name: 'bid-commitment',

  /**
   * Public input: the commitment hash.
   * This is stored on-chain in OffchainState.sealed[bidder].commitment.
   * The verifier can see it; only the preimage (amount, salt) is private.
   */
  publicInput: Field,

  methods: {
    /**
     * Prove that:
     *  - amount >= RESERVE_PRICE                  (bid floor enforced privately)
     *  - Poseidon.hash([...amount.toFields(), salt]) == commitment  (binding)
     *
     * @param commitment  Public — stored on-chain.  Field
     * @param amount      Private — the actual bid in nanomina.  UInt64
     * @param salt        Private — random blinding factor.  Field
     */
    prove: {
      privateInputs: [UInt64, Field],
      async method(commitment: Field, amount: UInt64, salt: Field) {
        // ── Reserve price gate (private) ───────────────────────────────────
        // This assertion runs entirely inside the circuit; amount is never
        // revealed. The VK encodes the constant RESERVE_PRICE, so any proof
        // compiled with a different threshold is rejected by commitBid().
        amount.assertGreaterThanOrEqual(
          RESERVE_PRICE,
          'bid is below the reserve price',
        );

        // ── Binding commitment check ───────────────────────────────────────
        // The prover cannot substitute a different amount at reveal time
        // because the commitment is already on-chain and revealBid() will
        // verify Poseidon.hash([...amount.toFields(), salt]) == commitment.
        const computed = Poseidon.hash([...amount.toFields(), salt]);
        computed.assertEquals(commitment, 'commitment does not match preimage');
      },
    },
  },
});

/** Proof class — pass an instance to AuctionContract.commitBid(). */
export class BidCommitmentProof extends BidCommitmentProgram.Proof {}
