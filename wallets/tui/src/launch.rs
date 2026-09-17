use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

/// How the `fast-wallet-cli` launcher should start.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LaunchPlan {
    /// Fullscreen TUI.
    Tui,
    /// Print TUI version JSON and exit.
    TuiVersion,
    /// Exec the C++ product CLI with the remaining arguments.
    Classic { args: Vec<String> },
}

#[derive(Debug, Clone)]
pub struct LaunchContext {
    pub args: Vec<String>,
    pub stdin_is_tty: bool,
    pub stdout_is_tty: bool,
}

pub fn plan_launch(ctx: &LaunchContext) -> LaunchPlan {
    if ctx
        .args
        .iter()
        .any(|arg| arg == "--tui-version" || arg == "tui-version")
    {
        return LaunchPlan::TuiVersion;
    }

    let mut classic = false;
    let mut force_tui = false;
    let mut forwarded = Vec::new();
    for arg in &ctx.args {
        if arg == "--classic" || arg == "classic" {
            classic = true;
            continue;
        }
        if arg == "--tui" || arg == "tui" {
            force_tui = true;
            continue;
        }
        forwarded.push(arg.clone());
    }

    if classic {
        return LaunchPlan::Classic { args: forwarded };
    }
    if force_tui {
        return LaunchPlan::Tui;
    }
    if forwarded.is_empty() && ctx.stdin_is_tty && ctx.stdout_is_tty {
        return LaunchPlan::Tui;
    }
    LaunchPlan::Classic { args: forwarded }
}

pub fn discover_product_cli(current_exe: &Path, env_override: Option<&str>) -> Option<PathBuf> {
    if let Some(value) = env_override {
        let path = PathBuf::from(value);
        if path.is_file() {
            return Some(path);
        }
    }
    if let Some(path) = sibling_product_cli(current_exe) {
        return Some(path);
    }
    if extra_search_enabled() {
        if let Some(path) = on_path(PRODUCT_CLI_NAMES) {
            return Some(path);
        }
        if let Some(path) = in_cwd() {
            return Some(path);
        }
        if let Some(path) = in_home_bins() {
            return Some(path);
        }
        if let Some(path) = in_build_roots() {
            return Some(path);
        }
    }
    None
}

const PRODUCT_CLI_NAMES: &[&str] = &["monero-fast-wallet-cli", "monero-fast-wallet-cli.exe"];

fn extra_search_enabled() -> bool {
    match env::var("MFW_SEARCH_BUILD_CLI") {
        Ok(value) => {
            let value = value.to_ascii_lowercase();
            value != "0" && value != "false" && value != "no"
        }
        Err(_) => true,
    }
}

fn is_product_cli(path: &Path, current_exe: Option<&Path>) -> bool {
    path.is_file() && current_exe.is_none_or(|exe| path != exe)
}

fn sibling_product_cli(current_exe: &Path) -> Option<PathBuf> {
    let dir = current_exe.parent()?;
    for name in PRODUCT_CLI_NAMES {
        let candidate = dir.join(name);
        if is_product_cli(&candidate, Some(current_exe)) {
            return Some(candidate);
        }
    }
    None
}

fn on_path(names: &[&str]) -> Option<PathBuf> {
    let path = env::var_os("PATH")?;
    for dir in env::split_paths(&path) {
        for name in names {
            let candidate = dir.join(name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

fn in_cwd() -> Option<PathBuf> {
    let cwd = env::current_dir().ok()?;
    for name in PRODUCT_CLI_NAMES {
        let candidate = cwd.join(name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

fn in_home_bins() -> Option<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(home) = env::var_os("HOME").or_else(|| env::var_os("USERPROFILE")) {
        let home = PathBuf::from(home);
        dirs.push(home.join("bin"));
        dirs.push(home.join(".local/bin"));
        dirs.push(home.join(".cargo/bin"));
    }
    dirs.push(PathBuf::from("/usr/local/bin"));
    dirs.push(PathBuf::from("/opt/homebrew/bin"));
    for dir in dirs {
        for name in PRODUCT_CLI_NAMES {
            let candidate = dir.join(name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

fn in_build_roots() -> Option<PathBuf> {
    let mut roots = Vec::new();
    if let Some(custom) = env::var_os("MFW_CLI_ROOT") {
        roots.push(PathBuf::from(custom));
    }
    roots.push(PathBuf::from(
        "/Volumes/4TB/07_Monero/01_Build/monero-fast-wallet-build-current",
    ));
    roots.push(PathBuf::from(
        "/Volumes/4TB/07_Monero/01_Build/community-cli-integration/output",
    ));
    let mut best: Option<(SystemTime, PathBuf)> = None;
    for root in roots {
        consider_cli(&root, &mut best);
        let Ok(entries) = fs::read_dir(&root) else {
            continue;
        };
        for entry in entries.flatten() {
            consider_cli(&entry.path(), &mut best);
            consider_cli(&entry.path().join("monero-fast-wallet-cli"), &mut best);
        }
    }
    best.map(|(_, path)| path)
}

fn consider_cli(path: &Path, best: &mut Option<(SystemTime, PathBuf)>) {
    let candidate = if path.is_dir() {
        path.join("monero-fast-wallet-cli")
    } else {
        path.to_path_buf()
    };
    if candidate.file_name().and_then(|name| name.to_str()) != Some("monero-fast-wallet-cli") {
        return;
    }
    if !candidate.is_file() {
        return;
    }
    let Ok(modified) = candidate.metadata().and_then(|meta| meta.modified()) else {
        return;
    };
    if best.as_ref().is_none_or(|(stamp, _)| modified > *stamp) {
        *best = Some((modified, candidate));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx(args: &[&str], tty: bool) -> LaunchContext {
        LaunchContext {
            args: args.iter().map(|s| (*s).to_owned()).collect(),
            stdin_is_tty: tty,
            stdout_is_tty: tty,
        }
    }

    #[test]
    fn no_args_on_tty_starts_tui() {
        assert_eq!(plan_launch(&ctx(&[], true)), LaunchPlan::Tui);
    }

    #[test]
    fn no_args_on_pipe_stays_classic() {
        assert_eq!(
            plan_launch(&ctx(&[], false)),
            LaunchPlan::Classic { args: vec![] }
        );
    }

    #[test]
    fn quickstart_forwards_to_classic() {
        assert_eq!(
            plan_launch(&ctx(&["quickstart"], true)),
            LaunchPlan::Classic {
                args: vec!["quickstart".into()]
            }
        );
    }

    #[test]
    fn classic_flag_strips_and_forwards() {
        assert_eq!(
            plan_launch(&ctx(&["--classic", "version", "--json"], true)),
            LaunchPlan::Classic {
                args: vec!["version".into(), "--json".into()]
            }
        );
    }

    #[test]
    fn tui_flag_forces_tui_even_without_tty() {
        assert_eq!(plan_launch(&ctx(&["--tui"], false)), LaunchPlan::Tui);
        assert_eq!(plan_launch(&ctx(&["tui"], false)), LaunchPlan::Tui);
    }

    #[test]
    fn classic_wins_over_tui() {
        assert_eq!(
            plan_launch(&ctx(&["--tui", "--classic"], true)),
            LaunchPlan::Classic { args: vec![] }
        );
    }

    #[test]
    fn tui_version_is_dedicated() {
        assert_eq!(
            plan_launch(&ctx(&["--tui-version"], false)),
            LaunchPlan::TuiVersion
        );
    }

    #[test]
    fn discovers_sibling_product_cli() {
        let dir = tempfile::tempdir().unwrap();
        let launcher = dir.path().join("fast-wallet-cli");
        let product = dir.path().join("monero-fast-wallet-cli");
        fs::write(&launcher, b"tui").unwrap();
        fs::write(&product, b"cli").unwrap();
        assert_eq!(
            discover_product_cli(&launcher, None).as_deref(),
            Some(product.as_path())
        );
    }

    #[test]
    fn env_override_wins() {
        let dir = tempfile::tempdir().unwrap();
        let launcher = dir.path().join("fast-wallet-cli");
        let product = dir.path().join("override-cli");
        fs::write(&launcher, b"tui").unwrap();
        fs::write(&product, b"cli").unwrap();
        assert_eq!(
            discover_product_cli(&launcher, Some(product.to_str().unwrap())).as_deref(),
            Some(product.as_path())
        );
    }

    #[test]
    fn missing_sibling_without_extra_search_is_none() {
        let previous = std::env::var_os("MFW_SEARCH_BUILD_CLI");
        std::env::set_var("MFW_SEARCH_BUILD_CLI", "0");
        let dir = tempfile::tempdir().unwrap();
        let launcher = dir.path().join("fast-wallet-cli");
        fs::write(&launcher, b"tui").unwrap();
        let found = discover_product_cli(&launcher, None);
        match previous {
            Some(value) => std::env::set_var("MFW_SEARCH_BUILD_CLI", value),
            None => std::env::remove_var("MFW_SEARCH_BUILD_CLI"),
        }
        assert_eq!(found, None);
    }
}
