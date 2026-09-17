use monero_fast_wallet_tui::backend::default_backend;
use monero_fast_wallet_tui::launch::{
    discover_product_cli, plan_launch, LaunchContext, LaunchPlan,
};
use monero_fast_wallet_tui::ui;
use monero_fast_wallet_tui::{App, RunOutcome};
use std::env;
use std::io::{self, IsTerminal, Write};
use std::path::PathBuf;
use std::process::Command;

fn main() {
    if let Err(error) = run() {
        let _ = writeln!(io::stderr(), "fast-wallet-cli: {error}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let args: Vec<String> = env::args().skip(1).collect();
    let plan = plan_launch(&LaunchContext {
        args,
        stdin_is_tty: io::stdin().is_terminal(),
        stdout_is_tty: io::stdout().is_terminal(),
    });
    match plan {
        LaunchPlan::TuiVersion => {
            println!(
                "{}",
                serde_json::json!({
                    "product": "fast-wallet-tui",
                    "version": env!("CARGO_PKG_VERSION"),
                    "launcher": "fast-wallet-cli",
                    "classic_binary": "monero-fast-wallet-cli",
                })
            );
            Ok(())
        }
        LaunchPlan::Tui => start_tui(),
        LaunchPlan::Classic { args } => exec_classic(&args),
    }
}

fn start_tui() -> Result<(), String> {
    let product =
        discover_product_cli(&current_exe()?, env::var("MFW_PRODUCT_CLI").ok().as_deref());
    let app = App::new(default_backend(product));
    match ui::run(app).map_err(|error| error.to_string())? {
        RunOutcome::Exit(code) => {
            std::process::exit(code);
        }
        RunOutcome::Classic => exec_classic(&[]),
        RunOutcome::Continue => Ok(()),
    }
}

fn exec_classic(args: &[String]) -> Result<(), String> {
    let product =
        discover_product_cli(&current_exe()?, env::var("MFW_PRODUCT_CLI").ok().as_deref())
            .ok_or_else(|| {
                "monero-fast-wallet-cli was not found beside this launcher. Set MFW_PRODUCT_CLI."
                    .to_owned()
            })?;
    let mut command = Command::new(&product);
    command.args(args);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        let error = command.exec();
        Err(format!("failed to exec {}: {error}", product.display()))
    }
    #[cfg(not(unix))]
    {
        let status = command
            .status()
            .map_err(|error| format!("failed to start {}: {error}", product.display()))?;
        std::process::exit(status.code().unwrap_or(1));
    }
}

fn current_exe() -> Result<PathBuf, String> {
    env::current_exe().map_err(|error| error.to_string())
}
