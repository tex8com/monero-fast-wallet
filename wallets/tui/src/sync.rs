//! Presentation-only wallet sync, matching `packages/wallet-shared/src/walletSync.ts`.
//!
//! Heights never mark a wallet spendable. Only `core_confirmed` / native
//! `synchronized` does that.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SyncPhase {
    WaitingForNode,
    Syncing,
    Finalizing,
    Synchronized,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SyncPresentation {
    pub phase: SyncPhase,
    pub progress: Option<u8>,
    pub target_height: Option<u64>,
    pub wallet_height: u64,
    pub remaining_blocks: Option<u64>,
    pub core_confirmed: bool,
}

pub fn present_wallet_sync(
    wallet_height: u64,
    daemon_height: u64,
    daemon_target_height: u64,
    synchronized: bool,
    start_height: Option<u64>,
) -> SyncPresentation {
    let target_height = daemon_height.max(daemon_target_height);

    if synchronized {
        return SyncPresentation {
            phase: SyncPhase::Synchronized,
            progress: Some(100),
            target_height: if target_height > 0 {
                Some(target_height)
            } else {
                None
            },
            wallet_height,
            remaining_blocks: Some(0),
            core_confirmed: true,
        };
    }

    if target_height == 0 {
        return SyncPresentation {
            phase: SyncPhase::WaitingForNode,
            progress: None,
            target_height: None,
            wallet_height,
            remaining_blocks: None,
            core_confirmed: false,
        };
    }

    let start = start_height
        .filter(|height| *height > 0)
        .map(|height| height.min(target_height));
    let remaining_range = start.map(|height| target_height.saturating_sub(height));
    let completed_range = start.map(|height| {
        wallet_height
            .saturating_sub(height)
            .min(remaining_range.unwrap_or(0))
    });
    let remaining_blocks = Some(target_height.saturating_sub(wallet_height));
    let height_progress = match (remaining_range, completed_range) {
        (None, _) | (_, None) => None,
        (Some(0), _) => Some(100),
        (Some(range), Some(done)) => Some(((done.saturating_mul(100)) / range).min(100) as u8),
    };

    if height_progress == Some(100) || wallet_height >= target_height {
        return SyncPresentation {
            phase: SyncPhase::Finalizing,
            progress: None,
            target_height: Some(target_height),
            wallet_height,
            remaining_blocks,
            core_confirmed: false,
        };
    }

    SyncPresentation {
        phase: SyncPhase::Syncing,
        progress: height_progress,
        target_height: Some(target_height),
        wallet_height,
        remaining_blocks,
        core_confirmed: false,
    }
}

pub fn format_block_count(value: u64) -> String {
    let digits = value.to_string();
    let mut out = String::new();
    for (index, ch) in digits.chars().enumerate() {
        if index > 0 && (digits.len() - index).is_multiple_of(3) {
            out.push(',');
        }
        out.push(ch);
    }
    out
}

pub fn format_eta_seconds(seconds: u64) -> String {
    if seconds < 90 {
        format!("About {seconds}s remaining")
    } else if seconds < 3600 {
        format!("About {} min remaining", (seconds + 30) / 60)
    } else {
        format!("About {} h remaining", (seconds + 1800) / 3600)
    }
}

pub fn phase_label(phase: SyncPhase, failed: bool) -> &'static str {
    if failed && phase == SyncPhase::WaitingForNode {
        return "Connecting node";
    }
    match phase {
        SyncPhase::WaitingForNode => "Connecting node",
        SyncPhase::Syncing => "Scanning blocks",
        SyncPhase::Finalizing => "Verifying recent transactions",
        SyncPhase::Synchronized => "Synchronized",
    }
}

pub fn compact_status(phase: SyncPhase, progress: Option<u8>, failed: bool) -> String {
    match (failed && phase != SyncPhase::Synchronized, phase, progress) {
        (true, _, _) => "Node unreachable".into(),
        (_, SyncPhase::Synchronized, _) => "Synchronized".into(),
        (_, SyncPhase::Syncing, Some(percent)) => format!("Scanning blocks {percent}%"),
        (_, SyncPhase::Finalizing, _) => "Verifying recent transactions".into(),
        _ => phase_label(phase, failed).into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn waiting_without_daemon() {
        let view = present_wallet_sync(10, 0, 0, false, Some(1));
        assert_eq!(view.phase, SyncPhase::WaitingForNode);
        assert_eq!(view.progress, None);
        assert!(!view.core_confirmed);
    }

    #[test]
    fn syncing_uses_restore_baseline() {
        let view = present_wallet_sync(1_250, 2_000, 2_000, false, Some(1_000));
        assert_eq!(view.phase, SyncPhase::Syncing);
        assert_eq!(view.progress, Some(25));
        assert_eq!(view.remaining_blocks, Some(750));
        assert!(!view.core_confirmed);
    }

    #[test]
    fn caught_up_without_core_flag_is_finalizing() {
        let view = present_wallet_sync(2_000, 2_000, 2_000, false, Some(1_000));
        assert_eq!(view.phase, SyncPhase::Finalizing);
        assert_eq!(view.progress, None);
        assert!(!view.core_confirmed);
    }

    #[test]
    fn core_confirmed_is_one_hundred() {
        let view = present_wallet_sync(2_000, 2_000, 2_000, true, Some(1_000));
        assert_eq!(view.phase, SyncPhase::Synchronized);
        assert_eq!(view.progress, Some(100));
        assert!(view.core_confirmed);
    }

    #[test]
    fn formats_block_counts_like_the_gui() {
        assert_eq!(format_block_count(3_577_876), "3,577,876");
        assert_eq!(format_block_count(12), "12");
    }
}
