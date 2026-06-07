import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { PublicKey, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  getAccount,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { assert } from "chai";

// Standard Anchor test — runs against whatever [provider] cluster is set in
// Anchor.toml (here: an Octaze virtual testnet, i.e. a real Solana mainnet fork).
// Nothing Octaze-specific in the test itself: this is exactly how any team tests.

describe("anchor_escrow (make → take on an Octaze mainnet fork)", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.AnchorEscrow as Program;
  const connection = provider.connection;
  const payer = (provider.wallet as anchor.Wallet).payer;

  // Fresh actors so the test is repeatable.
  const maker = Keypair.generate();
  const taker = Keypair.generate();

  const seed = new BN(Math.floor(Math.random() * 1e9));
  const decimals = 6;
  const amount = new BN(1_000_000); // 1 token A the maker deposits
  const receive = new BN(2_000_000); // 2 token B the maker wants

  let mintA: PublicKey;
  let mintB: PublicKey;
  let escrow: PublicKey;
  let vault: PublicKey;

  before(async () => {
    // Fund maker + taker with SOL on the fork (faucet/airdrop).
    for (const kp of [maker, taker]) {
      const sig = await connection.requestAirdrop(kp.publicKey, 5 * LAMPORTS_PER_SOL);
      await connection.confirmTransaction(sig, "confirmed");
    }

    // Create two SPL token mints (real SPL Token program from mainnet).
    mintA = await createMint(connection, payer, payer.publicKey, null, decimals);
    mintB = await createMint(connection, payer, payer.publicKey, null, decimals);

    // Give the maker token A, the taker token B.
    const makerAtaA = await getOrCreateAssociatedTokenAccount(connection, payer, mintA, maker.publicKey);
    const takerAtaB = await getOrCreateAssociatedTokenAccount(connection, payer, mintB, taker.publicKey);
    await mintTo(connection, payer, mintA, makerAtaA.address, payer, BigInt(amount.toString()));
    await mintTo(connection, payer, mintB, takerAtaB.address, payer, BigInt(receive.toString()));

    // PDAs.
    [escrow] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), maker.publicKey.toBuffer(), seed.toArrayLike(Buffer, "le", 8)],
      program.programId,
    );
    vault = getAssociatedTokenAddressSync(mintA, escrow, true); // PDA owner
  });

  it("make: maker escrows token A into the vault", async () => {
    await program.methods
      .make(seed, receive, amount)
      .accountsPartial({
        maker: maker.publicKey,
        escrow,
        mintA,
        mintB,
        makerAtaA: getAssociatedTokenAddressSync(mintA, maker.publicKey),
        vault,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([maker])
      .rpc();

    const vaultAcc = await getAccount(connection, vault);
    assert.equal(vaultAcc.amount.toString(), amount.toString(), "vault holds the deposited A");
  });

  it("take: taker pays B to maker and receives A from the vault", async () => {
    await program.methods
      .take()
      .accountsPartial({
        taker: taker.publicKey,
        maker: maker.publicKey,
        escrow,
        mintA,
        mintB,
        vault,
        takerAtaA: getAssociatedTokenAddressSync(mintA, taker.publicKey),
        takerAtaB: getAssociatedTokenAddressSync(mintB, taker.publicKey),
        makerAtaB: getAssociatedTokenAddressSync(mintB, maker.publicKey),
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([taker])
      .rpc();

    // Taker now holds token A (the escrowed amount).
    const takerA = await getAccount(connection, getAssociatedTokenAddressSync(mintA, taker.publicKey));
    assert.equal(takerA.amount.toString(), amount.toString(), "taker received A");

    // Maker now holds token B (what they asked for).
    const makerB = await getAccount(connection, getAssociatedTokenAddressSync(mintB, maker.publicKey));
    assert.equal(makerB.amount.toString(), receive.toString(), "maker received B");

    // Vault is drained/closed.
    const vaultInfo = await connection.getAccountInfo(vault);
    assert.isNull(vaultInfo, "vault closed after take");
  });
});
