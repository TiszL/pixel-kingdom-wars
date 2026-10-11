//! Disposable local-validator test fixture. Never a production dependency or
//! authority: forwards only privileges already supplied by the caller, with no
//! state, PDA signing seeds, custody, or application admission behavior.
use anchor_lang::prelude::*;
use anchor_lang::solana_program::{instruction::{AccountMeta, Instruction}, program::invoke};

declare_id!("GGRZUzCunNTqAkny7sLZW6ZkCcj918nDJuzt7SQUYNbK");

#[program]
pub mod seeker_cpi_probe {
    use super::*;

    pub fn forward<'info>(ctx: Context<'_, '_, '_, 'info, Forward<'info>>,
        data: Vec<u8>, catch_failure: bool) -> Result<()> {
        let instruction = Instruction {
            program_id: ctx.accounts.target_program.key(),
            accounts: ctx.remaining_accounts.iter().map(|account| AccountMeta {
                pubkey: account.key(), is_signer: account.is_signer, is_writable: account.is_writable,
            }).collect(),
            data,
        };
        let mut infos = ctx.remaining_accounts.to_vec();
        infos.push(ctx.accounts.target_program.to_account_info());
        match invoke(&instruction, &infos) {
            Ok(()) => Ok(()),
            Err(error) if catch_failure => {
                // Deliberately attempt recovery to test the runtime boundary.
                // Pinned Agave 2.3.13 traps the invoking VM on a callee error;
                // the corresponding tests require failure and no such log.
                msg!("Probe caught CPI failure: {}", error);
                Ok(())
            },
            Err(error) => Err(error.into()),
        }
    }
}

#[derive(Accounts)]
pub struct Forward<'info> {
    /// CHECK: explicit executable target; invoke enforces the caller's supplied privileges.
    #[account(executable)]
    pub target_program: UncheckedAccount<'info>,
}
