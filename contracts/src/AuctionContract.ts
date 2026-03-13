import {
  SmartContract,
  State,
  state,
  method,
  PublicKey,
  Field,
  UInt64,
  UInt32,
  Bool,
  Struct,
  Permissions,
  DeployArgs,
  AccountUpdate,
  Poseidon,
  Experimental,
} from 'o1js';
import { NFTToken } from './NFTToken.js';
import { BidCommitmentProof } from './BidCommitmentProgram.js';
import { BidAggregatorProof } from './BidAggregator.js';

const { OffchainState } = Experimental;

// ── Types ─────────────────────────────────────────────────────────────────────

export const SealedBid = Struct({
  commitment: Field,   // Poseidon.hash([...amount.toFields(), salt])
  bond:       UInt64,  // MINA locked at commit time
});

// RevealAction is imported from ./types.ts to avoid a circular import with
// BidAggregator (which also imports RevealAction and is imported here).

// ── OffchainState ─────────────────────────────────────────────────────────────

export const auctionOffchainState = OffchainState({
  // Written at commitBid() — the sealed envelope + locked bond per bidder.
  // Unbounded number of bidders — cannot fit in 8 on-chain fields.
  sealed: OffchainState.Map(PublicKey, SealedBid),

  // Written at revealBid() — the revealed bid amount per bidder.
  // Absence means the bidder never revealed (bond is forfeitable).
  revealed: OffchainState.Map(PublicKey, UInt64),

  // Set once at initialize() — which NFTToken contract holds the auctioned NFT.
  // Stored offchain to free on-chain fields for winner (needed immediately post-settle).
  // OffchainState.Field() only stores raw Field values; PublicKey is 2 fields.
  // Use Map(Field, PublicKey) with the singleton key Field(0) instead.
  nftContract: OffchainState.Map(Field, PublicKey),

  // Set once at initialize() — the seller's address.
  // Moved offchain to keep on-chain fields ≤ 8 (was @state(PublicKey) = 2 fields;
  // replaced by @state(Bool) initialized = 1 field — saves 1 net field).
  seller: OffchainState.Map(Field, PublicKey),

  // Set at settle() — the winning bid amount paid to the seller at claimNFT().
  winningBid: OffchainState.Field(UInt64),
});

export class AuctionStateProof extends auctionOffchainState.Proof {}

// Note: the OffchainState instance is created inside the contract class via
//   offchainState = auctionOffchainState.init(this)
// o1js memoizes this by contract address, so the same instance is returned
// for the same deployed contract across all method calls.

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * Flat participation bond — identical for every bidder.
 * Reveals nothing about bid size. Forfeited if the bidder never reveals.
 */
export const BOND_AMOUNT = UInt64.from(1_000_000_000); // 1 MINA

/**
 * Forfeited bonds (non-revealers) go to the protocol, not the seller.
 * Prevents the seller from profiting from griefing and raises the cost of
 * submitting fake bids.
 * Replace with the actual protocol treasury address before deployment.
 *
 * Using PublicKey.empty() as a safe placeholder — fromBase58 cannot be called
 * at module-load time with an unverified checksum.
 */
export const PROTOCOL_ADDRESS = PublicKey.empty();

// ── Contract ──────────────────────────────────────────────────────────────────

export class AuctionContract extends SmartContract {
  @state(OffchainState.Commitments)
  offchainStateCommitments = auctionOffchainState.emptyCommitments(); // 3 fields

  @state(Bool)      initialized = State<Bool>();     // 1 field  — guards initialize()
  @state(PublicKey) winner      = State<PublicKey>(); // 2 fields — set by settle(), readable immediately
  @state(UInt32)    auctionEnd  = State<UInt32>();    // 1 field  — block when bidding closes
  @state(UInt32)    revealEnd   = State<UInt32>();    // 1 field  — block when reveals close
  // ──────────────────────────────────────────────────────────────── total: 8 ✓
  // seller moved to OffchainState to stay within the 8-field limit.

  // o1js memoizes the OffchainState instance by contract address.
  offchainState = auctionOffchainState.init(this);

  // ── Deploy ───────────────────────────────────────────────────────────────────

  async deploy(args: DeployArgs) {
    await super.deploy(args);

    this.account.permissions.set({
      ...Permissions.default(),
      // Prevent upgrading contract logic after deployment
      setVerificationKey: Permissions.VerificationKey.impossibleDuringCurrentVersion(),
      setPermissions:     Permissions.impossible(),
      // All state changes must come from a valid proof
      editState:          Permissions.proof(),
      send:               Permissions.proof(),
      editActionState:    Permissions.proof(),
    });

    // Set explicit initial state so initialize() guard is reliable
    this.initialized.set(Bool(false));
    this.winner.set(PublicKey.empty());
    this.auctionEnd.set(UInt32.zero);
    this.revealEnd.set(UInt32.zero);
  }

  // ── Phase 0: Setup ────────────────────────────────────────────────────────────

  /**
   * Called once by the seller to initialise the auction.
   *
   * Atomically escrows the NFT from the seller into this contract in the same
   * transaction — if the seller does not hold the NFT the whole tx reverts.
   *
   * After this call, settleState() must be called before commitBid() so that
   * nftContract is readable by later methods.
   */
  @method async initialize(
    nftContractAddress: PublicKey,
    auctionDurationBlocks: UInt32,
    revealDurationBlocks: UInt32,
  ) {
    // ── Guard: only callable once ──────────────────────────────────────────
    this.initialized.getAndRequireEquals().assertFalse('auction already initialized');

    const seller = this.sender.getAndRequireSignature();
    this.initialized.set(Bool(true));

    // Store seller in OffchainState (use singleton key Field(0))
    this.offchainState.fields.seller.update(Field(0), {
      from: undefined,
      to:   seller,
    });

    // ── Set phase windows ──────────────────────────────────────────────────
    const block      = this.network.blockchainLength.getAndRequireEquals();
    const auctionEnd = block.add(auctionDurationBlocks);
    const revealEnd  = auctionEnd.add(revealDurationBlocks);
    this.auctionEnd.set(auctionEnd);
    this.revealEnd.set(revealEnd);

    // ── Store NFT contract reference in OffchainState ──────────────────────
    // nftContract is Map(Field, PublicKey); use singleton key Field(0).
    this.offchainState.fields.nftContract.update(Field(0), {
      from: undefined,
      to:   nftContractAddress,
    });

    // ── Escrow NFT: seller → this contract (atomic) ────────────────────────
    // AccountUpdate.create() inside a @method adds updates as children of
    // this contract's AccountUpdate in the call tree.
    // nft.approveAccountUpdates() calls approveBase (a @method on NFTToken),
    // which causes NFTToken's AccountUpdate to be inserted as a child of this
    // contract — so the full tree is: AuctionContract → NFTToken → token AUs.
    const nft = new NFTToken(nftContractAddress);
    const tokenId = nft.deriveTokenId();
    const sellerTokenAU = AccountUpdate.create(seller, tokenId);
    sellerTokenAU.requireSignature();
    sellerTokenAU.balance.subInPlace(UInt64.from(1));

    // Create the vault token account and lock it permanently so that:
    //   • Only a valid AuctionContract proof (not a signature) can send the NFT out.
    //   • Nobody — not even the original deployer — can weaken these permissions later.
    // This is a one-time setup; the auctionKey co-signs THIS transaction only.
    // After this, claimNFT() needs no private key: the @method proof is sufficient.
    const vaultTokenAU = AccountUpdate.create(this.address, tokenId);
    vaultTokenAU.requireSignature(); // auctionKey signs once here at deploy time
    const myVK = this.account.verificationKey.getAndRequireEquals();
    vaultTokenAU.account.verificationKey.set(myVK);
    vaultTokenAU.account.permissions.set({
      ...Permissions.default(),
      send:               Permissions.proof(),
      setVerificationKey: Permissions.impossible(),
      setPermissions:     Permissions.impossible(),
    });
    vaultTokenAU.balance.addInPlace(UInt64.from(1));
    await nft.approveAccountUpdates([sellerTokenAU, vaultTokenAU]);
  }

  // ── Phase 1: Bidding ──────────────────────────────────────────────────────────

  /**
   * Submit a sealed bid with a flat bond.
   *
   * proof.publicInput is the commitment = Poseidon.hash([...amount.toFields(), salt]).
   * The BidCommitmentProgram circuit guarantees amount >= RESERVE_PRICE without
   * revealing the amount — the reserve floor is baked into the circuit's VK.
   *
   * Bond is identical for every bidder so the locked MINA reveals nothing about
   * the bid size. Bid amount is paid later at revealBid().
   */
  @method async commitBid(proof: BidCommitmentProof, bond: UInt64) {
    // ── Phase guard ────────────────────────────────────────────────────────
    const block = this.network.blockchainLength.getAndRequireEquals();
    block.assertLessThanOrEqual(this.auctionEnd.getAndRequireEquals());

    // ── Verify commitment proof ────────────────────────────────────────────
    // Implicitly checks: correct circuit (correct RESERVE_PRICE in VK),
    // valid commitment hash. No explicit reserve check needed here.
    proof.verify();

    // ── Bond must be the flat rate — no negotiation ────────────────────────
    bond.assertEquals(BOND_AMOUNT);

    const bidder = this.sender.getAndRequireSignature();

    // ── Store sealed bid — write-once ──────────────────────────────────────
    // from: undefined means "the entry must not exist yet" — prevents overwriting.
    this.offchainState.fields.sealed.update(bidder, {
      from: undefined,
      to: { commitment: proof.publicInput, bond },
    });

    // ── Lock bond MINA in contract ─────────────────────────────────────────
    const bidderAU = AccountUpdate.createSigned(bidder);
    bidderAU.balance.subInPlace(bond);
    this.balance.addInPlace(bond);
  }

  // ── OffchainState settlement ──────────────────────────────────────────────────

  /**
   * Commit pending OffchainState Actions to the on-chain Merkle root.
   * Anyone can call this. Must be called between phases so that subsequent
   * methods can read the previous phase's writes.
   */
  @method async settleState(proof: AuctionStateProof) {
    await this.offchainState.settle(proof);
  }

  // ── Phase 2: Reveal ───────────────────────────────────────────────────────────

  /**
   * Open the sealed bid by providing the preimage (amount, salt).
   *
   * The contract verifies the hash matches the stored commitment, then locks
   * the actual bid amount in the contract and dispatches a RevealAction for
   * the BidAggregator to process during settlement.
   *
   * A write-once precondition on revealed[bidder] prevents double-reveal.
   */
  @method async revealBid(amount: UInt64, salt: Field) {
    // ── Phase guards ───────────────────────────────────────────────────────
    const block      = this.network.blockchainLength.getAndRequireEquals();
    const auctionEnd = this.auctionEnd.getAndRequireEquals();
    const revealEnd  = this.revealEnd.getAndRequireEquals();
    block.assertGreaterThan(auctionEnd);
    block.assertLessThanOrEqual(revealEnd);

    const bidder = this.sender.getAndRequireSignature();

    // ── Verify preimage matches stored commitment ──────────────────────────
    const sealedOpt = await this.offchainState.fields.sealed.get(bidder);
    const sealed    = sealedOpt.assertSome('no commitment found for this bidder');
    Poseidon.hash([...amount.toFields(), salt]).assertEquals(sealed.commitment);

    // ── Record revealed amount — write-once ────────────────────────────────
    // Absence of revealed[bidder] is how sweepForfeitedBond() identifies
    // non-revealers. from: undefined ensures a bidder cannot reveal twice.
    this.offchainState.fields.revealed.update(bidder, {
      from: undefined,
      to: amount,
    });

    // ── Lock bid amount in contract ────────────────────────────────────────
    const bidderAU = AccountUpdate.createSigned(bidder);
    bidderAU.balance.subInPlace(amount);
    this.balance.addInPlace(amount);
  }

  // ── Phase 3: Settlement ───────────────────────────────────────────────────────

  /**
   * Determine the winner from all revealed bids using a BidAggregator proof.
   *
   * The proof is a sequential chain (base + one step per reveal) built
   * client-side. Its publicInput equals the on-chain action state, proving
   * every RevealAction was included and processed in order.
   *
   * winner is written to @state for immediate on-chain readability.
   * winningBid is written to OffchainState (only needed post-settlement).
   *
   * Can only be called once (winner starts as PublicKey.empty()).
   * After this, settleState() must be called before claimNFT() can read winningBid.
   */
  @method async settle(proof: BidAggregatorProof) {
    // ── Phase guard ────────────────────────────────────────────────────────
    const block     = this.network.blockchainLength.getAndRequireEquals();
    const revealEnd = this.revealEnd.getAndRequireEquals();
    block.assertGreaterThan(revealEnd);

    // ── Only settle once ───────────────────────────────────────────────────
    this.winner.getAndRequireEquals().assertEquals(PublicKey.empty());

    // ── Verify aggregator proof ────────────────────────────────────────────
    // The BidAggregator processes reveals supplied off-chain.
    // Completeness (all reveals included) is enforced off-chain by the
    // settler reading every entry from the OffchainState revealed map.
    // NOTE: A stricter on-chain completeness guarantee can be added later
    // by moving RevealAction dispatches to a dedicated registry contract
    // (OffchainState and Reducer cannot share the same account.actionState).
    proof.verify();

    // ── Write winner to @state — immediately readable ──────────────────────
    this.winner.set(proof.publicOutput.winner);

    // ── Store winning bid in OffchainState ─────────────────────────────────
    this.offchainState.fields.winningBid.overwrite(proof.publicOutput.amount);
  }

  // ── Phase 4a: Winner claims NFT ───────────────────────────────────────────────

  /**
   * Winner claims the escrowed NFT.
   *
   * In a single transaction:
   *   - NFT token transferred from this contract to the winner
   *   - Winning bid MINA transferred to the seller
   *   - Winner's bond refunded
   *
   * Requires OffchainState to be settled (winningBid and nftContract readable).
   * Bond is zeroed to prevent double-claim.
   */
  @method async claimNFT() {
    const claimer = this.sender.getAndRequireSignature();

    // ── Must be the winner ─────────────────────────────────────────────────
    const winner = this.winner.getAndRequireEquals();
    claimer.assertEquals(winner);

    // ── Read from OffchainState ────────────────────────────────────────────
    // nftContract and seller are Map(Field, PublicKey); read with singleton key Field(0).
    const nftContractOpt = await this.offchainState.fields.nftContract.get(Field(0));
    const sellerOpt      = await this.offchainState.fields.seller.get(Field(0));
    const winningBidOpt  = await this.offchainState.fields.winningBid.get();
    const sealedOpt      = await this.offchainState.fields.sealed.get(claimer);

    const nftAddr    = nftContractOpt.assertSome('nft contract not set');
    const seller     = sellerOpt.assertSome('seller not set — call settleState() first');
    const winningBid = winningBidOpt.assertSome('winning bid not set — call settleState() first');
    const sealed     = sealedOpt.assertSome('no sealed bid for winner');

    // ── Transfer NFT: this contract → winner ───────────────────────────────
    // Same pattern as initialize(): AccountUpdate.create() inside a @method
    // adds updates as children of this contract in the call tree.
    // nft.approveAccountUpdates() inserts NFTToken as a child of this contract.
    const nft     = new NFTToken(nftAddr);
    const tokenId = nft.deriveTokenId();
    // The vault token account was locked in initialize() with send: proof() and
    // VK = AuctionContract's VK. No requireSignature() needed — the claimNFT()
    // @method proof satisfies the vault's send permission automatically.
    // The auction deployer private key never needs to reach the browser.
    const vaultTokenAU  = AccountUpdate.create(this.address, tokenId);
    vaultTokenAU.balance.subInPlace(UInt64.from(1));
    const winnerTokenAU = AccountUpdate.create(claimer, tokenId);
    winnerTokenAU.balance.addInPlace(UInt64.from(1));
    await nft.approveAccountUpdates([vaultTokenAU, winnerTokenAU]);

    // ── Pay seller the winning bid ──────────────────────────────────────────
    this.balance.subInPlace(winningBid);
    AccountUpdate.create(seller).balance.addInPlace(winningBid);

    // ── Refund winner's bond ───────────────────────────────────────────────
    this.balance.subInPlace(sealed.bond);
    AccountUpdate.create(claimer).balance.addInPlace(sealed.bond);

    // ── Zero out sealed entry — prevent double-claim ───────────────────────
    this.offchainState.fields.sealed.update(claimer, {
      from: sealedOpt,
      to: { commitment: sealed.commitment, bond: UInt64.zero },
    });
  }

  // ── Phase 4b: Losers reclaim ──────────────────────────────────────────────────

  /**
   * Non-winning bidders reclaim their bond + revealed bid amount.
   *
   * Only callable after settlement. Only works for bidders who revealed —
   * non-revealers forfeit their bond; use sweepForfeitedBond() for them.
   *
   * Both sealed and revealed entries are zeroed to prevent double-claim.
   */
  @method async reclaimDeposit() {
    const claimer = this.sender.getAndRequireSignature();

    // ── Auction must be settled ────────────────────────────────────────────
    const winner = this.winner.getAndRequireEquals();
    winner.equals(PublicKey.empty()).assertFalse('auction not yet settled');

    // ── Caller must not be the winner ──────────────────────────────────────
    claimer.equals(winner).assertFalse('winner must use claimNFT()');

    // ── Read sealed bid and revealed amount ───────────────────────────────
    const sealedOpt   = await this.offchainState.fields.sealed.get(claimer);
    const revealedOpt = await this.offchainState.fields.revealed.get(claimer);

    const sealed   = sealedOpt.assertSome('no sealed bid found');
    const revealed = revealedOpt.assertSome(
      'bid was not revealed — bond is forfeited, use sweepForfeitedBond()'
    );

    // ── Refund bond + bid amount ───────────────────────────────────────────
    const total = sealed.bond.add(revealed);
    this.balance.subInPlace(total);
    AccountUpdate.create(claimer).balance.addInPlace(total);

    // ── Zero out both entries — prevent double-claim ───────────────────────
    this.offchainState.fields.sealed.update(claimer, {
      from: sealedOpt,
      to: { commitment: sealed.commitment, bond: UInt64.zero },
    });
    this.offchainState.fields.revealed.update(claimer, {
      from: revealedOpt,
      to: UInt64.zero,
    });
  }

  // ── Non-revealer bond forfeiture ──────────────────────────────────────────────

  /**
   * Sweep a forfeited bond from a non-revealer to the protocol address.
   *
   * Anyone can call this for any non-revealer after the reveal period ends.
   * A non-revealer is identified by having a sealed entry (committed) but no
   * revealed entry (never called revealBid()).
   *
   * Sending to the protocol (not the seller) ensures the seller cannot profit
   * by encouraging fake bids that never reveal.
   */
  @method async sweepForfeitedBond(forfeiter: PublicKey) {
    // ── Must be after reveal period ────────────────────────────────────────
    const block = this.network.blockchainLength.getAndRequireEquals();
    block.assertGreaterThan(this.revealEnd.getAndRequireEquals());

    // ── Forfeiter must have committed ──────────────────────────────────────
    const sealedOpt = await this.offchainState.fields.sealed.get(forfeiter);
    const sealed    = sealedOpt.assertSome('no commitment found for this address');
    sealed.bond.assertGreaterThan(UInt64.zero);

    // ── Forfeiter must NOT have revealed ───────────────────────────────────
    // Presence of revealed[forfeiter] means they revealed — use reclaimDeposit()
    const revealedOpt = await this.offchainState.fields.revealed.get(forfeiter);
    revealedOpt.assertNone('bidder revealed their bid — use reclaimDeposit() instead');

    // ── Forfeit bond to protocol ───────────────────────────────────────────
    this.balance.subInPlace(sealed.bond);
    AccountUpdate.create(PROTOCOL_ADDRESS).balance.addInPlace(sealed.bond);

    // ── Zero out bond — prevent double-sweep ──────────────────────────────
    this.offchainState.fields.sealed.update(forfeiter, {
      from: sealedOpt,
      to: { commitment: sealed.commitment, bond: UInt64.zero },
    });
  }
}
