//! Desktop encrypted-storage adapter for the shared payment-plan core.
pub use mfw_product_core::send_plan::*;
const JOURNAL_KEY: &str = "wallet.send-plans.v1";
static JOURNAL_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
pub struct VaultJournal;
impl Journal for VaultJournal {
    fn load(&mut self) -> Result<Vec<Plan>, String> {
        let _guard = JOURNAL_LOCK
            .lock()
            .map_err(|_| "Secure payment journal is busy.".to_owned())?;
        load_journal()
    }
    fn save(&mut self, plan: &Plan) -> Result<(), String> {
        let _guard = JOURNAL_LOCK
            .lock()
            .map_err(|_| "Secure payment journal is busy.".to_owned())?;
        let mut plans = load_journal()?;
        plans.retain(|p| p.id != plan.id);
        plans.push(plan.clone());
        while plans.len() > 64 {
            let index = plans
                .iter()
                .position(|p| !p.lease_held && p.uncertain_tx_ids.is_empty())
                .ok_or_else(|| {
                    "Resolve pending payment receipts before creating more payments.".to_owned()
                })?;
            plans.remove(index);
        }
        crate::app_vault::put_secret(
            JOURNAL_KEY,
            &serde_json::to_string(&plans)
                .map_err(|_| "Payment journal encoding failed.".to_owned())?,
        )
    }
}
fn load_journal() -> Result<Vec<Plan>, String> {
    match crate::app_vault::get_secret(JOURNAL_KEY)? {
        None => Ok(Vec::new()),
        Some(value) => {
            let plans: Vec<Plan> = serde_json::from_str(&value).map_err(|_| {
                "Secure payment journal is invalid; no payment was sent.".to_owned()
            })?;
            Ok(plans
                .into_iter()
                .map(|plan| {
                    if !plan.attempted() {
                        recovered(plan)
                    } else {
                        plan
                    }
                })
                .collect())
        }
    }
}
