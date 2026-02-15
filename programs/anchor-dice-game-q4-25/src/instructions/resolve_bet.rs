use anchor_instruction_sysvar::Ed25519InstructionSignatures;
use anchor_lang::{
    prelude::*,
    system_program::{transfer, Transfer},
};
use solana_program::hash::hash;
use solana_program::sysvar::instructions::load_instruction_at_checked;

use crate::{errors::DiceError, state::Bet};

#[derive(Accounts)]
pub struct ResolveBet<'info> {
    #[account(mut)]
    pub house: Signer<'info>,
    #[account(mut)]
    pub player: SystemAccount<'info>,
    #[account(
        mut,
        seeds = [b"vault", house.key().as_ref()],
        bump
    )]
    pub vault: SystemAccount<'info>,
    #[account(
        mut,
        close = player,
        seeds = [b"bet", vault.key().as_ref(), bet.seed.to_le_bytes().as_ref()],
        bump = bet.bump
    )]
    pub bet: Account<'info, Bet>,
    /// CHECK: This is the instructions sysvar
    #[account(address = solana_program::sysvar::instructions::id())]
    pub instruction_sysvar: AccountInfo<'info>,
    pub system_program: Program<'info, System>,
}

impl<'info> ResolveBet<'info> {
    pub fn verify_ed25519_signature(&self, sig: &[u8]) -> Result<()> {
        let ix_sysvar = &self.instruction_sysvar;

        // The Ed25519 verify instruction should be at index 0 (prepended before this ix)
        let ed25519_ix =
            load_instruction_at_checked(0, ix_sysvar).map_err(|_| DiceError::Ed25519Header)?;

        // Verify the instruction is actually for the Ed25519 program
        require_keys_eq!(
            ed25519_ix.program_id,
            solana_program::ed25519_program::id(),
            DiceError::Ed25519Program
        );

        // Unpack the Ed25519 instruction data
        let signatures = Ed25519InstructionSignatures::unpack(&ed25519_ix.data)
            .map_err(|_| DiceError::Ed25519Header)?;

        let signature = &signatures.0.first().ok_or(DiceError::Ed25519Signature)?;

        // Verify the signing pubkey matches the house
        let signer = signature.public_key.ok_or(DiceError::Ed25519Pubkey)?;

        require_keys_eq!(signer, self.house.key(), DiceError::Ed25519Pubkey);

        // Verify the signature matches
        let sig_bytes = signature.signature.ok_or(DiceError::Ed25519Signature)?;

        require!(sig_bytes.as_ref() == sig, DiceError::Ed25519Signature);

        // Verify the message matches the bet data
        let msg = signature
            .message
            .as_ref()
            .ok_or(DiceError::Ed25519Message)?;

        require!(*msg == self.bet.to_slice(), DiceError::Ed25519Message);

        Ok(())
    }

    pub fn resolve_bet(&mut self, sig: &[u8], bumps: &ResolveBetBumps) -> Result<()> {
        let hash_result = hash(sig).to_bytes();
        let mut hash_ref = hash_result.as_ref();
        let mut result: u128 = 0;
        loop {
            if hash_ref.is_empty() {
                break;
            }
            let (value, rest) = hash_ref.split_at(16);
            hash_ref = rest;
            result = result.wrapping_add(u128::from_le_bytes(value.try_into().unwrap()));
        }

        // Map the result to 1-100 range
        let result = (result % 100) + 1;

        if result > self.bet.roll.into() {
            // Player wins — calculate payout
            let payout = (self.bet.amount as u128)
                .checked_mul(10000)
                .ok_or(DiceError::Overflow)?
                .checked_div(self.bet.roll as u128)
                .ok_or(DiceError::Overflow)?
                .checked_div(100)
                .ok_or(DiceError::Overflow)? as u64;

            let accounts = Transfer {
                from: self.vault.to_account_info(),
                to: self.player.to_account_info(),
            };

            let signer_seeds: &[&[&[u8]]] =
                &[&[b"vault", &self.house.key().to_bytes(), &[bumps.vault]]];

            let ctx = CpiContext::new_with_signer(
                self.system_program.to_account_info(),
                accounts,
                signer_seeds,
            );

            transfer(ctx, payout)?;
        }

        Ok(())
    }
}
