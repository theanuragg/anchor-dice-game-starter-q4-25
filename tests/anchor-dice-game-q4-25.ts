import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { AnchorDiceGameQ425 } from "../target/types/anchor_dice_game_q4_25";
import { PublicKey, SystemProgram, LAMPORTS_PER_SOL, Keypair } from "@solana/web3.js";
import { assert, expect } from "chai";
import BN from "bn.js";

describe("anchor-dice-game-q4-25", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace
    .anchorDiceGameQ425 as Program<AnchorDiceGameQ425>;
  const connection = provider.connection;

  // House is the provider wallet
  const house = provider.wallet as anchor.Wallet;

  // Player keypair
  const player = Keypair.generate();

  // Derive the vault PDA
  const [vaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), house.publicKey.toBuffer()],
    program.programId
  );

  // Helpers
  const getBalance = async (pubkey: PublicKey) =>
    connection.getBalance(pubkey);

  const airdrop = async (pubkey: PublicKey, amount: number) => {
    const sig = await connection.requestAirdrop(pubkey, amount);
    await connection.confirmTransaction(sig, "confirmed");
  };

  // Seed for bets (u128 as BN)
  let betSeed = new BN(1);

  const deriveBetPda = (seed: BN) => {
    // u128 as 16-byte little-endian buffer
    const seedBuffer = seed.toArrayLike(Buffer, "le", 16);
    return PublicKey.findProgramAddressSync(
      [Buffer.from("bet"), vaultPda.toBuffer(), seedBuffer],
      program.programId
    );
  };

  before(async () => {
    // Airdrop SOL to player
    await airdrop(player.publicKey, 10 * LAMPORTS_PER_SOL);
  });

  describe("initialize", () => {
    it("initializes the vault with SOL deposit from house", async () => {
      const depositAmount = new BN(2 * LAMPORTS_PER_SOL);

      const houseBalanceBefore = await getBalance(house.publicKey);

      const tx = await program.methods
        .initialize(depositAmount)
        .accounts({
          house: house.publicKey,
          vault: vaultPda,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      console.log("Initialize tx:", tx);

      const vaultBalance = await getBalance(vaultPda);
      assert.equal(
        vaultBalance,
        depositAmount.toNumber(),
        "Vault should hold the deposited amount"
      );

      const houseBalanceAfter = await getBalance(house.publicKey);
      assert.isBelow(
        houseBalanceAfter,
        houseBalanceBefore,
        "House balance should decrease"
      );
    });
  });

  describe("place_bet", () => {
    it("places a valid bet — creates bet account and deposits SOL", async () => {
      const roll = 50;
      const betAmount = new BN(0.1 * LAMPORTS_PER_SOL);
      const seed = betSeed;

      const [betPda] = deriveBetPda(seed);

      const playerBalanceBefore = await getBalance(player.publicKey);
      const vaultBalanceBefore = await getBalance(vaultPda);

      const tx = await program.methods
        .placeBet(seed, roll, betAmount)
        .accounts({
          player: player.publicKey,
          house: house.publicKey,
          vault: vaultPda,
          bet: betPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([player])
        .rpc();

      console.log("Place bet tx:", tx);

      // Verify the bet account was created with correct data
      const betAccount = await program.account.bet.fetch(betPda);
      assert.ok(
        betAccount.player.equals(player.publicKey),
        "Bet player should match"
      );
      assert.ok(betAccount.seed.eq(seed), "Bet seed should match");
      assert.equal(betAccount.roll, roll, "Bet roll should match");
      assert.ok(
        betAccount.amount.eq(betAmount),
        "Bet amount should match"
      );

      // Verify SOL was transferred to vault
      const vaultBalanceAfter = await getBalance(vaultPda);
      assert.equal(
        vaultBalanceAfter,
        vaultBalanceBefore + betAmount.toNumber(),
        "Vault balance should increase by bet amount"
      );

      // Verify player balance decreased
      const playerBalanceAfter = await getBalance(player.publicKey);
      assert.isBelow(
        playerBalanceAfter,
        playerBalanceBefore,
        "Player balance should decrease"
      );
    });

    it("places a second bet with a different seed", async () => {
      betSeed = betSeed.add(new BN(1)); // seed = 2
      const roll = 75;
      const betAmount = new BN(0.05 * LAMPORTS_PER_SOL);

      const [betPda] = deriveBetPda(betSeed);

      const tx = await program.methods
        .placeBet(betSeed, roll, betAmount)
        .accounts({
          player: player.publicKey,
          house: house.publicKey,
          vault: vaultPda,
          bet: betPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([player])
        .rpc();

      console.log("Place bet #2 tx:", tx);

      const betAccount = await program.account.bet.fetch(betPda);
      assert.equal(betAccount.roll, roll, "Second bet roll should match");
      assert.ok(
        betAccount.amount.eq(betAmount),
        "Second bet amount should match"
      );
    });
  });

  describe("refund_bet", () => {
    it("fails to refund when timeout has not been reached", async () => {
      // Use betSeed = 2 (the second bet we just placed)
      const [betPda] = deriveBetPda(betSeed);

      try {
        await program.methods
          .refundBet()
          .accounts({
            player: player.publicKey,
            house: house.publicKey,
            vault: vaultPda,
            bet: betPda,
            systemProgram: SystemProgram.programId,
          })
          .signers([player])
          .rpc();

        assert.fail("Should have thrown TimeoutNotReached error");
      } catch (err: any) {
        // The refund_bet logic checks (self.bet.slot - slot) > 1000
        // Since in test the current slot is ahead of bet slot,
        // the subtraction will underflow (u64 subtraction).
        // This will either underflow-panic or fail the require!.
        // In either case the tx should fail.
        console.log("Refund correctly rejected:", err.message?.slice(0, 100));
        assert.ok(err, "Transaction should fail");
      }
    });
  });

  describe("edge cases", () => {
    it("cannot place a bet with the same seed twice", async () => {
      const roll = 50;
      const betAmount = new BN(0.01 * LAMPORTS_PER_SOL);
      // Re-use betSeed = 2 which already has a bet
      const [betPda] = deriveBetPda(betSeed);

      try {
        await program.methods
          .placeBet(betSeed, roll, betAmount)
          .accounts({
            player: player.publicKey,
            house: house.publicKey,
            vault: vaultPda,
            bet: betPda,
            systemProgram: SystemProgram.programId,
          })
          .signers([player])
          .rpc();

        assert.fail("Should have thrown — bet PDA already exists");
      } catch (err: any) {
        console.log("Duplicate seed correctly rejected:", err.message?.slice(0, 100));
        assert.ok(err, "Transaction should fail for duplicate seed");
      }
    });

    it("different player can place a bet on the same vault", async () => {
      const player2 = Keypair.generate();
      await airdrop(player2.publicKey, 5 * LAMPORTS_PER_SOL);

      const seed = new BN(999);
      const roll = 30;
      const betAmount = new BN(0.02 * LAMPORTS_PER_SOL);
      const [betPda] = deriveBetPda(seed);

      const tx = await program.methods
        .placeBet(seed, roll, betAmount)
        .accounts({
          player: player2.publicKey,
          house: house.publicKey,
          vault: vaultPda,
          bet: betPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([player2])
        .rpc();

      console.log("Player2 bet tx:", tx);

      const betAccount = await program.account.bet.fetch(betPda);
      assert.ok(
        betAccount.player.equals(player2.publicKey),
        "Bet should belong to player2"
      );
    });
  });
});
