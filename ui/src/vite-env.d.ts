/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Deployed AuctionContract address on Zeko Devnet. Set in ui/.env.local */
  readonly VITE_CONTRACT_ADDRESS: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
