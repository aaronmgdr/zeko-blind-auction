/**
 * NFTToken.ts — a one-of-one NFT using o1js TokenContract.
 *
 * Design decisions:
 *  - @state(Bool) minted enforces a single mint; the circuit cannot create a
 *    second token after the first has been issued.
 *  - approveBase delegates authority to any callee that satisfies the
 *    zero-net-change invariant — the AuctionContract uses this to escrow the
 *    NFT without needing special authorisation from NFTToken.
 *  - Permissions lock the contract after deployment so the deployer key cannot
 *    silently upgrade logic or re-enable minting.
 */
import {
  TokenContract,
  AccountUpdateForest,
  State,
  state,
  method,
  PublicKey,
  UInt64,
  Bool,
  DeployArgs,
  Permissions,
} from 'o1js';

export class NFTToken extends TokenContract {
  /** True after mint() has been called once. Prevents double-minting. */
  @state(Bool) minted = State<Bool>();

  // ── Deploy ────────────────────────────────────────────────────────────────

  async deploy(args: DeployArgs) {
    await super.deploy(args);

    // Explicit initial value so the guard in mint() is reliable from block 0.
    this.minted.set(Bool(false));

    this.account.permissions.set({
      ...Permissions.default(),
      // Prevent post-deployment logic changes.
      setVerificationKey: Permissions.VerificationKey.impossibleDuringCurrentVersion(),
      setPermissions:     Permissions.impossible(),
      // State changes and token minting both require a proof.
      editState:          Permissions.proof(),
      send:               Permissions.proof(),
    });
  }

  // ── Minting (one-shot) ────────────────────────────────────────────────────

  /**
   * Mint exactly one NFT token to `to`.
   *
   * Can only be called once — subsequent calls fail the minted guard.
   * Intended to be called by the seller during AuctionContract.initialize()
   * to simultaneously deploy the NFT and start the auction in one tx.
   *
   * In practice the seller must hold the deployer key OR the NFTToken
   * contract can be pre-deployed and mint() called as a separate step before
   * the auction starts.
   */
  @method async mint(to: PublicKey) {
    this.minted.getAndRequireEquals().assertFalse('NFT already minted');
    this.minted.set(Bool(true));
    this.internal.mint({ address: to, amount: UInt64.from(1) });
  }

  // ── Transfer approval ─────────────────────────────────────────────────────

  /**
   * Approve a forest of account updates that touch this token.
   *
   * The zero-balance-change check ensures no tokens are created or destroyed
   * in a transfer — only moved between accounts. This is the correct pattern
   * for a non-mintable-after-first-mint token.
   *
   * AuctionContract calls nft.approve(forest) when escrowing the NFT at
   * initialize() and when transferring it to the winner at claimNFT().
   */
  @method
  async approveBase(forest: AccountUpdateForest) {
    this.checkZeroBalanceChange(forest);
  }
}
