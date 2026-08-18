// SPDX-License-Identifier: GPL-3.0-only

use std::path::PathBuf;

use anyhow::{Context, Result};
use clap::Parser;
use mfw_donation_gateway::{admin, config::Config, gateway, state::AppState};
use tracing::info;
use tracing_subscriber::EnvFilter;

#[derive(Parser, Debug)]
#[command(version, about)]
struct Args {
    #[arg(long, default_value = "gateway.toml")]
    config: PathBuf,

    /// Validate configuration and exit without opening a listener.
    #[arg(long)]
    check: bool,
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .compact()
        .init();

    let args = Args::parse();
    let config = Config::load(&args.config)?;
    if args.check {
        println!("configuration valid");
        return Ok(());
    }

    let admin_token = if config.admin.enabled {
        Some(
            std::env::var(&config.admin.token_env)
                .with_context(|| format!("{} is required", config.admin.token_env))?,
        )
    } else {
        None
    };
    let state = AppState::new(config, admin_token);
    let gateway_task = tokio::spawn(gateway::serve(state.clone()));
    let admin_task = if state.config.admin.enabled {
        info!(listen = %state.config.admin.listen, "local admin API enabled");
        Some(tokio::spawn(admin::serve(state.clone())))
    } else {
        None
    };

    tokio::select! {
        result = gateway_task => result.context("gateway task panicked")??,
        result = async {
            if let Some(task) = admin_task {
                task.await.context("admin task panicked")??;
            } else {
                std::future::pending::<()>().await;
            }
            Ok::<(), anyhow::Error>(())
        } => result?,
        result = tokio::signal::ctrl_c() => {
            result?;
            info!("shutdown requested");
        }
    }

    Ok(())
}
