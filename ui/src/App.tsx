import { useEffect, useRef, useState } from 'react';
import { ZkappWorkerClient } from './ZkappWorkerClient.js';

// 1 MINA flat bond — must match BOND_AMOUNT in the contracts package
const BOND_NANO = '1000000000';

// 'compiling' — startup: loading keys, compiling circuits, connecting to contract
// 'idle'      — connected to a deployed contract; ready to transact
type Phase = 'compiling' | 'idle';

type AuctionState = {
  initialized: boolean;
  winner:      string;
  auctionEnd:  string;
  revealEnd:   string;
};

// ── Salt generation (main thread — no o1js needed) ─────────────────────────
//
// A Field element is < 2^254. We generate 31 random bytes (248 bits) which
// always fits. The worker expects JSON.stringify(decimal-string), matching
// o1js Field.toJSON() output format.
function generateSaltJson(): string {
  const bytes = new Uint8Array(31);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
  return JSON.stringify(BigInt('0x' + hex).toString());
}

// Convert human MINA string ("5.5") → nanomina string ("5500000000")
function minaToNano(mina: string): string {
  const f = parseFloat(mina);
  if (isNaN(f) || f <= 0) throw new Error('Invalid MINA amount');
  return String(Math.round(f * 1e9));
}

// ── Component ──────────────────────────────────────────────────────────────

export default function App() {
  // useRef prevents double-instantiation under React StrictMode
  const clientRef = useRef<ZkappWorkerClient | null>(null);

  const [wallet, setWallet]             = useState<string | null>(null);
  const [phase, setPhase]               = useState<Phase>('compiling');
  const [auctionState, setAuctionState] = useState<AuctionState | null>(null);
  const [status, setStatus]             = useState('Initialising…');

  // Commit form
  const [bidAmount, setBidAmount] = useState('');   // human MINA, e.g. "7.5"
  const [bidSalt, setBidSalt]     = useState('');   // JSON field string
  const [bidProof, setBidProof]   = useState('');   // proof JSON after prove()

  // Reveal form (user pastes the same amount + salt they committed with)
  const [revealAmount, setRevealAmount] = useState('');
  const [revealSalt, setRevealSalt]     = useState('');

  // Settle: reveals input + built proof
  // Each line: "B62q… 7.5" (address space amount-in-MINA).
  const [revealsText, setRevealsText] = useState('');
  const [aggProof, setAggProof]       = useState('');

  // ── Startup: compile circuits and connect to contract ───────────────────
  //
  // The contract address is baked in at build time via VITE_CONTRACT_ADDRESS
  // (set in ui/.env.local — see ui/.env.example).  No user interaction is
  // needed during startup; the UI becomes active once this effect resolves.
  //
  // Compilation is split into named steps so the status bar shows exactly
  // which circuit is loading.  The onProgress callback is Comlink-proxied into
  // the worker so download progress fires back to the main thread in real time.
  useEffect(() => {
    if (clientRef.current) return;
    clientRef.current = new ZkappWorkerClient();

    (async () => {
      try {
        const contractAddress = import.meta.env.VITE_CONTRACT_ADDRESS;
        if (!contractAddress) throw new Error(
          'Contract address not configured — set VITE_CONTRACT_ADDRESS in ui/.env.local',
        );

        setStatus('Setting up Zeko network…');
        await clientRef.current!.setNetwork();

        // Load circuit keys — first visit downloads ~1 GB from /circuit-cache/
        // and stores in IndexedDB; repeat visits load from IDB (fast).
        // onProgress fires back from the worker with live download counts.
        setStatus('Loading circuit keys…');
        await clientRef.current!.loadCircuitCache(msg => setStatus(msg));

        setStatus('Compiling BidCommitmentProgram (1 / 4)…');
        await clientRef.current!.compileBidCommitmentProgram();

        setStatus('Compiling BidAggregator (2 / 4)…');
        await clientRef.current!.compileBidAggregator();

        setStatus('Compiling OffchainState (3 / 4)…');
        await clientRef.current!.compileOffchainState();

        setStatus('Compiling AuctionContract (4 / 4)…');
        await clientRef.current!.compileAuctionContract();

        setStatus('Connecting to contract…');
        await clientRef.current!.setContractAddress(contractAddress);

        setStatus('Fetching auction state…');
        await clientRef.current!.fetchContractAccount(contractAddress);
        const s = await clientRef.current!.getAuctionState();
        setAuctionState(s);

        setPhase('idle');
        setStatus('Ready');
      } catch (e: any) {
        setStatus(`Startup error: ${e?.message ?? String(e)}`);
      }
    })();
  }, []);

  // ── Auro wallet ────────────────────────────────────────────────────────
  async function connectWallet() {
    const mina = (window as any).mina;
    if (!mina) { alert('Auro Wallet not found'); return; }
    alert('Please switch to the Zeko Devnet in Auro Wallet and refresh the page.');
    await mina.addChain({ name: 'Zeko Devnet', url: 'https://devnet.zeko.io/graphql' });
    await mina.switchChain({ networkID: 'zeko:testnet' });

    const [address] = await mina.requestAccounts();
    setWallet(address);
  }

  // ── Submit a proved tx via Auro ────────────────────────────────────────
  async function sendTx() {
    const txJson = await clientRef.current!.getTxJSON();
    const mina   = (window as any).mina;
    const { hash } = await mina.sendTransaction({
      transaction: txJson,
      feePayer: { fee: '0.1', memo: 'blind-auction' },
    });
    setStatus(`Submitted: ${hash}`);
  }

  // ── Phase 1: Commit ────────────────────────────────────────────────────
  async function handleCommitBid() {
    if (!wallet) return;
    try {
      const amountNano = minaToNano(bidAmount);
      const salt       = bidSalt || (() => { const s = generateSaltJson(); setBidSalt(s); return s; })();

      setStatus('Generating bid commitment proof (1 / 2 — may take ~1 min)…');
      const proof = await clientRef.current!.proveBidCommitment(amountNano, salt);
      setBidProof(proof);

      setStatus('Building commitBid transaction…');
      await clientRef.current!.buildCommitBidTx(wallet, proof, BOND_NANO);

      setStatus('Proving transaction (2 / 2 — may take ~1 min)…');
      await clientRef.current!.proveTx();

      setStatus('Waiting for Auro signature…');
      await sendTx();

      setStatus('Bid committed! ✓  Save your amount and salt — you need them to reveal.');
    } catch (e: any) {
      setStatus(`Error: ${e?.message ?? String(e)}`);
    }
  }

  // ── Phase 2: Reveal ────────────────────────────────────────────────────
  async function handleRevealBid() {
    if (!wallet) return;
    try {
      const amountNano = minaToNano(revealAmount);

      setStatus('Building revealBid transaction…');
      await clientRef.current!.buildRevealBidTx(wallet, amountNano, revealSalt);

      setStatus('Proving transaction (may take ~1 min)…');
      await clientRef.current!.proveTx();

      setStatus('Waiting for Auro signature…');
      await sendTx();

      setStatus('Bid revealed! ✓');
    } catch (e: any) {
      setStatus(`Error: ${e?.message ?? String(e)}`);
    }
  }

  // ── Phase 3: Settle ────────────────────────────────────────────────────

  // Parse the reveals textarea: one "B62q… 7.5" entry per line.
  function parseReveals(): Array<{ bidder58: string; amountNano: string }> {
    return revealsText
      .split('\n')
      .map(l => l.trim())
      .filter(Boolean)
      .map(line => {
        const [bidder58, mina] = line.split(/\s+/);
        if (!bidder58 || !mina) throw new Error(`Bad reveal line: "${line}"`);
        return { bidder58, amountNano: String(Math.round(parseFloat(mina) * 1e9)) };
      });
  }

  async function handleBuildAggregatorProof() {
    try {
      const reveals = parseReveals();
      if (reveals.length === 0) throw new Error('Enter at least one reveal (address + amount).');
      setStatus(`Building aggregator proof over ${reveals.length} reveal(s)…`);
      const proof = await clientRef.current!.buildAggregatorProof(reveals);
      setAggProof(proof);
      setStatus('Aggregator proof ready. Click "Settle Auction" to submit.');
    } catch (e: any) {
      setStatus(`Error: ${e?.message ?? String(e)}`);
    }
  }

  async function handleSettle() {
    if (!wallet || !aggProof) return;
    try {
      setStatus('Building settle transaction…');
      await clientRef.current!.buildSettleTx(wallet, aggProof);

      setStatus('Proving transaction (may take ~1 min)…');
      await clientRef.current!.proveTx();

      setStatus('Waiting for Auro signature…');
      await sendTx();

      setStatus('Auction settled! ✓  Refreshing state…');
      const s = await clientRef.current!.getAuctionState();
      setAuctionState(s);
    } catch (e: any) {
      setStatus(`Error: ${e?.message ?? String(e)}`);
    }
  }

  // ── Phase 4: Claim / Reclaim ───────────────────────────────────────────
  async function handleClaimNFT() {
    if (!wallet) return;
    try {
      setStatus('Building claimNFT transaction…');
      await clientRef.current!.buildClaimNFTTx(wallet);

      setStatus('Proving transaction (may take ~1 min)…');
      await clientRef.current!.proveTx();

      setStatus('Waiting for Auro signature…');
      await sendTx();
    } catch (e: any) {
      setStatus(`Error: ${e?.message ?? String(e)}`);
    }
  }

  async function handleReclaim() {
    if (!wallet) return;
    try {
      setStatus('Building reclaimDeposit transaction…');
      await clientRef.current!.buildReclaimDepositTx(wallet);

      setStatus('Proving transaction (may take ~1 min)…');
      await clientRef.current!.proveTx();

      setStatus('Waiting for Auro signature…');
      await sendTx();
    } catch (e: any) {
      setStatus(`Error: ${e?.message ?? String(e)}`);
    }
  }

  // ── Render ─────────────────────────────────────────────────────────────
  const row: React.CSSProperties  = { display: 'flex', gap: 8, alignItems: 'center', margin: '6px 0' };
  const note: React.CSSProperties = { fontSize: '0.82em', color: '#555', marginBottom: 8 };

  return (
    <main style={{ fontFamily: 'monospace', padding: '2rem', maxWidth: 680 }}>
      <h1>Blind Auction</h1>

      <p><strong>Status:</strong> {status}</p>

      {phase === 'idle' && (
        <>
          {auctionState && (
            <section>
              <h2>Auction State</h2>
              <p>Initialized: {auctionState.initialized ? 'yes' : 'no'}</p>
              <p>Winner:      {auctionState.winner}</p>
              <p>Auction end: block {auctionState.auctionEnd}</p>
              <p>Reveal end:  block {auctionState.revealEnd}</p>
            </section>
          )}

          {!wallet ? (
            <button onClick={connectWallet}>Connect Auro Wallet</button>
          ) : (
            <>
              <p><strong>Wallet:</strong> {wallet}</p>

              {/* ── 1 · Commit ─────────────────────────────────────────────── */}
              <section>
                <h2>1 · Commit Bid</h2>
                <p style={note}>
                  Bond: 1 MINA (flat, refunded if you reveal).
                  Your bid amount stays hidden until the reveal phase.{' '}
                  <strong>Save your amount + salt — you need them to reveal.</strong>
                </p>
                <div style={row}>
                  <label>Amount (MINA):&nbsp;
                    <input
                      value={bidAmount}
                      onChange={e => setBidAmount(e.target.value)}
                      placeholder="e.g. 7.5"
                      style={{ width: 90 }}
                    />
                  </label>
                </div>
                <div style={row}>
                  <label>Salt:&nbsp;
                    <input
                      value={bidSalt}
                      onChange={e => setBidSalt(e.target.value)}
                      placeholder="click Generate →"
                      style={{ width: 260 }}
                    />
                  </label>
                  <button onClick={() => setBidSalt(generateSaltJson())}>Generate</button>
                </div>
                <button onClick={handleCommitBid} disabled={!bidAmount}>
                  Prove + Commit Bid
                </button>
                {bidProof && <span style={{ marginLeft: 8, color: '#080' }}>✓ proof generated</span>}
              </section>

              {/* ── 2 · Reveal ─────────────────────────────────────────────── */}
              <section>
                <h2>2 · Reveal Bid</h2>
                <p style={note}>
                  Enter the <em>exact same</em> amount and salt you used in the commit step.
                </p>
                <div style={row}>
                  <label>Amount (MINA):&nbsp;
                    <input
                      value={revealAmount}
                      onChange={e => setRevealAmount(e.target.value)}
                      placeholder="must match commit"
                      style={{ width: 90 }}
                    />
                  </label>
                </div>
                <div style={row}>
                  <label>Salt:&nbsp;
                    <input
                      value={revealSalt}
                      onChange={e => setRevealSalt(e.target.value)}
                      placeholder="paste saved salt"
                      style={{ width: 280 }}
                    />
                  </label>
                </div>
                <button onClick={handleRevealBid} disabled={!revealAmount || !revealSalt}>
                  Reveal Bid
                </button>
              </section>

              {/* ── 3 · Settle ─────────────────────────────────────────────── */}
              <section>
                <h2>3 · Settle Auction</h2>
                <p style={note}>
                  Anyone can settle after the reveal period ends. Enter every bidder
                  who revealed — one per line, format: <code>B62q… &lt;amount-in-MINA&gt;</code>.
                  These are public: look up <code>revealBid</code> transactions on the explorer.
                </p>
                <textarea
                  value={revealsText}
                  onChange={e => setRevealsText(e.target.value)}
                  placeholder={'B62qABC… 10\nB62qDEF… 7.5'}
                  rows={4}
                  style={{ width: '100%', fontFamily: 'monospace', fontSize: '0.9em' }}
                />
                <div style={{ ...row, marginTop: 6 }}>
                  <button onClick={handleBuildAggregatorProof} disabled={!revealsText.trim()}>
                    1 · Build Aggregator Proof
                  </button>
                  {aggProof && <span style={{ color: '#080' }}>✓ proof ready</span>}
                </div>
                <button onClick={handleSettle} disabled={!aggProof}>
                  2 · Submit Settle Transaction
                </button>
              </section>

              {/* ── 4 · Claim / Reclaim ────────────────────────────────────── */}
              <section>
                <h2>4 · Claim / Reclaim</h2>
                <p style={note}>
                  Winner: claim the NFT + bond refund. Losers: reclaim bond + bid.
                </p>
                <div style={row}>
                  <button onClick={handleClaimNFT}>Claim NFT (winner)</button>
                  <button onClick={handleReclaim}>Reclaim Deposit (losers)</button>
                </div>
              </section>
            </>
          )}
        </>
      )}
    </main>
  );
}
