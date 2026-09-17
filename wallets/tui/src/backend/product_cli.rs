use super::{
    BackendError, BackendKind, CreateRequest, CreatedWallet, NodeConnection, OpenRequest,
    PreparedPayment, RestoreRequest, SendRequest, Subaddress, SubmittedPayment, Transaction,
    TxDirection, WalletBackend, WalletSnapshot,
};
use crate::action::NetworkChoice;
use crate::format::{format_atomic_xmr, parse_xmr_to_atomic};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, ExitStatus, Stdio};
use std::sync::mpsc::{self, Receiver, TryRecvError};
use std::thread;
use std::time::{Duration, Instant};
use zeroize::{Zeroize, Zeroizing};

pub struct ProductCliBackend {
    program: PathBuf,
    session: Option<Session>,
    pending: Option<PreparedPayment>,
    node: NodeConnection,
    refresh_rx: Option<Receiver<Result<WalletSnapshot, String>>>,
}

#[derive(Clone)]
struct Session {
    path: PathBuf,
    password: Zeroizing<String>,
    network: NetworkChoice,
    snapshot: WalletSnapshot,
}

impl ProductCliBackend {
    pub fn new(program: PathBuf) -> Self {
        Self {
            program,
            session: None,
            pending: None,
            node: NodeConnection::default(),
            refresh_rx: None,
        }
    }

    fn network_args(network: NetworkChoice) -> Vec<&'static str> {
        match network {
            NetworkChoice::Mainnet => vec![],
            NetworkChoice::Stagenet => vec!["--stagenet"],
            NetworkChoice::Testnet => vec!["--testnet"],
        }
    }

    fn run(
        &self,
        extra: &[&str],
        password: &str,
        stdin_text: Option<&str>,
    ) -> Result<String, BackendError> {
        let dir = tempfile_dir()?;
        let password_file = dir.join("password");
        write_private(&password_file, password.as_bytes())?;
        let mut command = Command::new(&self.program);
        command
            .arg("--password-file")
            .arg(&password_file)
            .arg("--log-file")
            .arg(if cfg!(windows) { "NUL" } else { "/dev/null" })
            .args(extra)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = command
            .spawn()
            .map_err(|error| BackendError::msg(format!("failed to start product CLI: {error}")))?;
        if let Some(text) = stdin_text {
            if let Some(mut stdin) = child.stdin.take() {
                stdin.write_all(text.as_bytes()).ok();
            }
        } else {
            drop(child.stdin.take());
        }
        let stdout_pipe = child.stdout.take();
        let stderr_pipe = child.stderr.take();
        let stdout_thread = thread::spawn(move || {
            let mut buf = Vec::new();
            if let Some(mut pipe) = stdout_pipe {
                let _ = pipe.read_to_end(&mut buf);
            }
            buf
        });
        let stderr_thread = thread::spawn(move || {
            let mut buf = Vec::new();
            if let Some(mut pipe) = stderr_pipe {
                let _ = pipe.read_to_end(&mut buf);
            }
            buf
        });
        let timeout = if extra.iter().any(|item| {
            item.contains("refresh") || item.contains("transfer") || item.contains("rescan")
        }) {
            Duration::from_secs(600)
        } else {
            Duration::from_secs(20)
        };
        let status = wait_for_child(&mut child, timeout);
        let stdout = String::from_utf8_lossy(&stdout_thread.join().unwrap_or_else(|_| Vec::new()))
            .into_owned();
        let stderr = String::from_utf8_lossy(&stderr_thread.join().unwrap_or_else(|_| Vec::new()))
            .into_owned();
        let _ = fs::remove_file(&password_file);
        let _ = fs::remove_dir(&dir);
        let status = status?;
        if !status.success()
            && !stdout.contains("Generated new wallet:")
            && !stdout.contains("Opened wallet:")
            && !stdout.contains("Balance:")
        {
            let detail = first_error(&stdout, &stderr)
                .unwrap_or_else(|| format!("product CLI exited {status}"));
            return Err(BackendError::msg(detail));
        }
        Ok(stdout)
    }

    fn with_wallet(
        &self,
        extra: &[&str],
        stdin_text: Option<&str>,
        offline: bool,
    ) -> Result<String, BackendError> {
        let session = self.session.as_ref().ok_or(BackendError::NoWallet)?;
        let mut args = vec![
            "--wallet-file".to_owned(),
            session.path.to_string_lossy().into_owned(),
        ];
        if offline {
            args.push("--offline".to_owned());
        } else {
            args.extend(self.node.cli_args());
        }
        for flag in Self::network_args(session.network) {
            args.push(flag.to_owned());
        }
        for item in extra {
            args.push((*item).to_owned());
        }
        let borrowed: Vec<&str> = args.iter().map(String::as_str).collect();
        self.run(&borrowed, &session.password, stdin_text)
    }
}

impl WalletBackend for ProductCliBackend {
    fn kind(&self) -> BackendKind {
        BackendKind::ProductCli
    }

    fn status_line(&self) -> String {
        format!("product CLI {}", self.program.display())
    }

    fn create_wallet(&mut self, request: CreateRequest) -> Result<CreatedWallet, BackendError> {
        let path = request.path.to_string_lossy().into_owned();
        let net = Self::network_args(request.network);
        let mut args = vec![
            "--generate-new-wallet",
            path.as_str(),
            "--offline",
            "--mnemonic-language",
            "English",
        ];
        args.extend(net);
        args.extend(["--command", "q"]);
        let output = self.run(&args, &request.password, None)?;
        let parsed = parse_cli_output(&output)?;
        let address = parsed
            .address
            .ok_or_else(|| BackendError::msg("create did not print a receive address"))?;
        let seed = parsed
            .seed
            .ok_or_else(|| BackendError::msg("create did not print a recovery seed"))?;
        let snapshot = WalletSnapshot {
            path: request.path.clone(),
            primary_address: address.clone(),
            balance_atomic: parsed.balance_atomic.unwrap_or(0),
            unlocked_atomic: parsed.unlocked_atomic.unwrap_or(0),
            network: request.network,
            synchronized: false,
            height: 0,
            daemon_height: 0,
            daemon_target_height: 0,
            connection_failed: false,
            hardware: false,
        };
        self.session = Some(Session {
            path: request.path,
            password: request.password,
            network: request.network,
            snapshot: snapshot.clone(),
        });
        Ok(CreatedWallet {
            address,
            seed: Zeroizing::new(seed),
            snapshot,
        })
    }

    fn restore_wallet(&mut self, request: RestoreRequest) -> Result<WalletSnapshot, BackendError> {
        let path = request.path.to_string_lossy().into_owned();
        let height = request.restore_height.to_string();
        let net = Self::network_args(request.network);
        let mut args = vec![
            "--restore-deterministic-wallet",
            "--generate-new-wallet",
            path.as_str(),
            "--offline",
            "--mnemonic-language",
            "English",
            "--restore-height",
            height.as_str(),
        ];
        args.extend(net);
        args.extend(["--command", "q"]);
        let stdin = format!("{}\n", request.seed.trim());
        let output = self.run(&args, &request.password, Some(&stdin))?;
        let parsed = parse_cli_output(&output)?;
        let address = parsed
            .address
            .ok_or_else(|| BackendError::msg("restore did not print a receive address"))?;
        let snapshot = WalletSnapshot {
            path: request.path.clone(),
            primary_address: address,
            balance_atomic: 0,
            unlocked_atomic: 0,
            network: request.network,
            synchronized: false,
            height: request.restore_height,
            daemon_height: 0,
            daemon_target_height: 0,
            connection_failed: false,
            hardware: false,
        };
        self.session = Some(Session {
            path: request.path,
            password: request.password,
            network: request.network,
            snapshot: snapshot.clone(),
        });
        Ok(snapshot)
    }

    fn create_from_device(
        &mut self,
        request: crate::backend::HardwareCreateRequest,
    ) -> Result<WalletSnapshot, BackendError> {
        if request.restore_height <= 1 {
            return Err(BackendError::msg(
                "Choose a Ledger scan start height before its first transaction.",
            ));
        }
        let path = request.path.to_string_lossy().into_owned();
        let height = request.restore_height.to_string();
        let device = request.transport.device_name();
        let net = Self::network_args(request.network);
        let mut args = vec![
            "--generate-from-device",
            path.as_str(),
            "--hw-device",
            device,
            "--restore-height",
            height.as_str(),
        ];
        args.extend(net);
        args.extend(["--command", "q"]);
        let output = self.run(&args, &request.password, None)?;
        let parsed = parse_cli_output(&output)?;
        let address = parsed.address.ok_or_else(|| {
            BackendError::msg(
                "Ledger did not return an address. Unlock the Nano, open the Monero app, and confirm on the device.",
            )
        })?;
        let snapshot = WalletSnapshot {
            path: request.path.clone(),
            primary_address: address,
            balance_atomic: parsed.balance_atomic.unwrap_or(0),
            unlocked_atomic: parsed.unlocked_atomic.unwrap_or(0),
            network: request.network,
            synchronized: false,
            height: request.restore_height,
            daemon_height: parsed.daemon_height.unwrap_or(0),
            daemon_target_height: parsed.daemon_height.unwrap_or(0),
            connection_failed: parsed.connection_failed,
            hardware: true,
        };
        self.session = Some(Session {
            path: request.path,
            password: request.password,
            network: request.network,
            snapshot: snapshot.clone(),
        });
        Ok(snapshot)
    }

    fn open_wallet(&mut self, request: OpenRequest) -> Result<WalletSnapshot, BackendError> {
        let path = request.path.to_string_lossy().into_owned();
        let net = Self::network_args(request.network);
        let mut args = vec!["--wallet-file", path.as_str(), "--offline"];
        args.extend(net);
        args.extend(["--command", "balance"]);
        let output = self.run(&args, &request.password, None)?;
        let parsed = parse_cli_output(&output)?;
        let address = parsed
            .address
            .ok_or_else(|| BackendError::msg("open did not print a receive address"))?;
        let snapshot = WalletSnapshot {
            path: request.path.clone(),
            primary_address: address,
            balance_atomic: parsed.balance_atomic.unwrap_or(0),
            unlocked_atomic: parsed.unlocked_atomic.unwrap_or(0),
            network: request.network,
            synchronized: false,
            height: parsed.wallet_height.unwrap_or(0),
            daemon_height: parsed.daemon_height.unwrap_or(0),
            daemon_target_height: parsed.daemon_height.unwrap_or(0),
            connection_failed: parsed.connection_failed,
            hardware: request
                .path
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.contains("ledger")),
        };
        self.session = Some(Session {
            path: request.path,
            password: request.password,
            network: request.network,
            snapshot: snapshot.clone(),
        });
        Ok(snapshot)
    }

    fn snapshot(&self) -> Result<WalletSnapshot, BackendError> {
        self.session
            .as_ref()
            .map(|session| session.snapshot.clone())
            .ok_or(BackendError::NoWallet)
    }

    fn refresh(&mut self) -> Result<WalletSnapshot, BackendError> {
        let output = match self.with_wallet(&["--command", "refresh"], None, false) {
            Ok(output) => output,
            Err(error) => {
                let message = error.to_string();
                if is_connection_failure(&message) {
                    let session = self.session.as_mut().ok_or(BackendError::NoWallet)?;
                    session.snapshot.connection_failed = true;
                    session.snapshot.synchronized = false;
                    return Ok(session.snapshot.clone());
                }
                return Err(error);
            }
        };
        let parsed = parse_cli_output(&output)?;
        let session = self.session.as_mut().ok_or(BackendError::NoWallet)?;
        if let Some(balance) = parsed.balance_atomic {
            session.snapshot.balance_atomic = balance;
        }
        if let Some(unlocked) = parsed.unlocked_atomic {
            session.snapshot.unlocked_atomic = unlocked;
        }
        if let Some(height) = parsed.wallet_height {
            session.snapshot.height = height;
        }
        if let Some(daemon) = parsed.daemon_height {
            session.snapshot.daemon_height = daemon;
            session.snapshot.daemon_target_height = daemon;
        }
        session.snapshot.connection_failed = parsed.connection_failed;
        session.snapshot.synchronized = parsed.synchronized
            && !parsed.connection_failed
            && session.snapshot.daemon_height > 0
            && session.snapshot.height >= session.snapshot.daemon_height;
        Ok(session.snapshot.clone())
    }

    fn address(&self, _account: u32, index: u32) -> Result<String, BackendError> {
        if index == 0 {
            return Ok(self
                .session
                .as_ref()
                .ok_or(BackendError::NoWallet)?
                .snapshot
                .primary_address
                .clone());
        }
        let output = self.with_wallet(&["--command", "address", "all"], None, true)?;
        let parsed = parse_cli_output(&output)?;
        parsed
            .addresses
            .into_iter()
            .find(|item| item.index == index)
            .map(|item| item.address)
            .ok_or_else(|| BackendError::msg("unknown subaddress"))
    }

    fn create_subaddress(
        &mut self,
        _account: u32,
        label: &str,
    ) -> Result<Subaddress, BackendError> {
        let command = if label.is_empty() {
            "address new".to_owned()
        } else {
            format!("address new {label}")
        };
        let output = self.with_wallet(&["--command", &command], None, true)?;
        let parsed = parse_cli_output(&output)?;
        parsed
            .addresses
            .into_iter()
            .next()
            .ok_or_else(|| BackendError::msg("could not create subaddress"))
    }

    fn transactions(&self, _limit: u32) -> Result<Vec<Transaction>, BackendError> {
        match self.with_wallet(&["--command", "show_transfers"], None, true) {
            Ok(output) => Ok(parse_cli_output(&output)?.transactions),
            Err(error) => {
                if is_connection_failure(&error.to_string()) {
                    Ok(Vec::new())
                } else {
                    Err(error)
                }
            }
        }
    }

    fn validate_address(
        &self,
        address: &str,
        _network: NetworkChoice,
    ) -> Result<String, BackendError> {
        if address.len() >= 95 && address.len() <= 106 {
            Ok(address.to_owned())
        } else {
            Err(BackendError::msg("not a Monero address"))
        }
    }

    fn prepare_send(&mut self, request: SendRequest) -> Result<PreparedPayment, BackendError> {
        self.validate_address(&request.address, NetworkChoice::Mainnet)?;
        if request.amount_atomic == 0 {
            return Err(BackendError::msg("amount must be greater than zero"));
        }
        let session = self.session.as_ref().ok_or(BackendError::NoWallet)?;
        if session.snapshot.unlocked_atomic < request.amount_atomic {
            return Err(BackendError::msg("unlocked balance is too low"));
        }
        let prepared = PreparedPayment {
            address: request.address,
            amount_atomic: request.amount_atomic,
            fee_atomic: 0,
            token: "cli-review".into(),
        };
        self.pending = Some(prepared.clone());
        Ok(prepared)
    }

    fn commit_send(
        &mut self,
        prepared: &PreparedPayment,
    ) -> Result<SubmittedPayment, BackendError> {
        let pending = self
            .pending
            .as_ref()
            .ok_or(BackendError::NoPendingPayment)?;
        if pending.token != prepared.token || pending.address != prepared.address {
            return Err(BackendError::ReviewRequired);
        }
        let amount = format_atomic_xmr(prepared.amount_atomic);
        let transfer = format!("transfer {} {}", prepared.address, amount);
        let output = self.with_wallet(&["--command", &transfer], Some("y\n"), false)?;
        self.pending = None;
        let txid = parse_cli_output(&output)?
            .txid
            .unwrap_or_else(|| "submitted".into());
        Ok(SubmittedPayment { txid })
    }

    fn cancel_send(&mut self) -> Result<(), BackendError> {
        self.pending = None;
        Ok(())
    }

    fn confirm_seed_backup(&mut self) -> Result<(), BackendError> {
        Ok(())
    }

    fn recovery_seed(&mut self) -> Result<Zeroizing<String>, BackendError> {
        if self
            .session
            .as_ref()
            .is_some_and(|session| session.snapshot.hardware)
        {
            return Err(BackendError::msg(
                "The recovery seed remains on the Ledger device.",
            ));
        }
        let output = self.with_wallet(&["--command", "seed"], None, true)?;
        parse_cli_output(&output)?
            .seed
            .map(Zeroizing::new)
            .ok_or_else(|| BackendError::msg("seed command did not print a recovery seed"))
    }

    fn close(&mut self) -> Result<(), BackendError> {
        if let Some(mut session) = self.session.take() {
            session.password.zeroize();
        }
        self.pending = None;
        Ok(())
    }

    fn set_node(&mut self, node: NodeConnection) {
        self.node = node;
    }

    fn start_background_refresh(&mut self) -> bool {
        if self.refresh_rx.is_some() || self.session.is_none() {
            return self.refresh_rx.is_some();
        }
        let (tx, rx) = mpsc::channel();
        let mut worker = Self {
            program: self.program.clone(),
            session: self.session.clone(),
            pending: None,
            node: self.node.clone(),
            refresh_rx: None,
        };
        thread::spawn(move || {
            let result = worker.refresh().map_err(|error| error.to_string());
            let _ = tx.send(result);
        });
        self.refresh_rx = Some(rx);
        true
    }

    fn poll_background_refresh(&mut self) -> Option<Result<WalletSnapshot, BackendError>> {
        let received = match self.refresh_rx.as_ref()?.try_recv() {
            Ok(value) => value,
            Err(TryRecvError::Empty) => return None,
            Err(TryRecvError::Disconnected) => {
                self.refresh_rx = None;
                return Some(Err(BackendError::msg("refresh worker stopped")));
            }
        };
        self.refresh_rx = None;
        match received {
            Ok(snapshot) => {
                if let Some(session) = &mut self.session {
                    session.snapshot = snapshot.clone();
                }
                Some(Ok(snapshot))
            }
            Err(message) => Some(Err(BackendError::msg(message))),
        }
    }
}

#[derive(Debug, Default)]
pub struct ParsedCli {
    pub address: Option<String>,
    pub seed: Option<String>,
    pub balance_atomic: Option<u128>,
    pub unlocked_atomic: Option<u128>,
    pub addresses: Vec<Subaddress>,
    pub transactions: Vec<Transaction>,
    pub txid: Option<String>,
    pub wallet_height: Option<u64>,
    pub daemon_height: Option<u64>,
    pub synchronized: bool,
    pub connection_failed: bool,
    pub refresh_done: bool,
}

pub fn parse_cli_output(output: &str) -> Result<ParsedCli, BackendError> {
    let mut parsed = ParsedCli::default();
    let mut collecting_seed = false;
    let mut seed_words: Vec<String> = Vec::new();

    for raw in output.lines() {
        let line = raw.trim();
        if line.starts_with("Generated new wallet:") || line.starts_with("Opened wallet:") {
            parsed.address = line.split_once(':').map(|(_, rest)| rest.trim().to_owned());
        }
        if let Some(rest) = line.strip_prefix("Balance:") {
            if let Some((balance, unlocked)) = rest.split_once(", unlocked balance:") {
                parsed.balance_atomic = Some(
                    parse_xmr_to_atomic(balance.trim())
                        .map_err(|error| BackendError::msg(error.to_string()))?,
                );
                parsed.unlocked_atomic = Some(
                    parse_xmr_to_atomic(unlocked.trim())
                        .map_err(|error| BackendError::msg(error.to_string()))?,
                );
            }
        }
        if line.contains("can be used to recover access to your wallet") {
            collecting_seed = true;
            continue;
        }
        if collecting_seed {
            if line.starts_with("****") {
                collecting_seed = false;
                continue;
            }
            let words: Vec<_> = line
                .split_whitespace()
                .filter(|word| word.chars().all(|c| c.is_ascii_alphabetic()))
                .map(ToOwned::to_owned)
                .collect();
            seed_words.extend(words);
            if seed_words.len() >= 25 {
                collecting_seed = false;
            }
        }
        if let Some(sub) = parse_address_line(line) {
            parsed.addresses.push(sub);
            if parsed.address.is_none() {
                parsed.address = parsed.addresses.first().map(|item| item.address.clone());
            }
        }
        if let Some(tx) = parse_transfer_line(line) {
            parsed.transactions.push(tx);
        }
        if let Some((wallet, daemon)) = parse_height_line(line) {
            parsed.wallet_height = Some(wallet);
            parsed.daemon_height = Some(daemon);
        }
        let lower = line.to_ascii_lowercase();
        if lower.contains("no connection to daemon") || lower.contains("failed to connect") {
            parsed.connection_failed = true;
        }
        if lower.contains("refresh done") || lower.contains(", synced") {
            parsed.refresh_done = true;
        }
        if parsed.refresh_done
            && parsed
                .wallet_height
                .zip(parsed.daemon_height)
                .is_some_and(|(wallet, daemon)| daemon > 0 && wallet >= daemon)
        {
            parsed.synchronized = true;
        }
        if let Some(rest) = line.strip_prefix("Transaction successfully submitted, transaction <") {
            parsed.txid = rest
                .trim_end_matches('>')
                .split('>')
                .next()
                .map(str::to_owned);
        }
        if line.to_ascii_lowercase().contains("transaction id:") {
            parsed.txid = line.split(':').nth(1).map(|item| item.trim().to_owned());
        }
    }
    if seed_words.len() >= 24 {
        parsed.seed = Some(
            seed_words
                .into_iter()
                .take(25)
                .collect::<Vec<_>>()
                .join(" "),
        );
    }
    Ok(parsed)
}

fn parse_height_line(line: &str) -> Option<(u64, u64)> {
    let looks = line.starts_with("Height ") || line.to_ascii_lowercase().starts_with("refreshed ");
    if !looks {
        return None;
    }
    let mut numbers = line
        .split(|ch: char| !ch.is_ascii_digit())
        .filter(|part| !part.is_empty())
        .filter_map(|part| part.parse::<u64>().ok());
    Some((numbers.next()?, numbers.next()?))
}

fn parse_address_line(line: &str) -> Option<Subaddress> {
    let mut parts = line.split_whitespace();
    let index = parts.next()?.parse().ok()?;
    let address = parts.next()?.to_owned();
    if address.len() < 95 {
        return None;
    }
    let label = parts.collect::<Vec<_>>().join(" ");
    Some(Subaddress {
        index,
        address,
        label,
    })
}

fn parse_transfer_line(line: &str) -> Option<Transaction> {
    let lower = line.to_ascii_lowercase();
    let direction = if lower.contains("out") || lower.contains("spent") {
        TxDirection::Out
    } else if lower.contains("pending") || lower.contains("pool") {
        TxDirection::Pending
    } else if lower.contains("in") || lower.contains("received") {
        TxDirection::In
    } else {
        return None;
    };
    let amount = line
        .split_whitespace()
        .find_map(|token| parse_xmr_to_atomic(token).ok())?;
    let txid = line
        .split_whitespace()
        .find(|token| token.len() == 64 && token.chars().all(|c| c.is_ascii_hexdigit()))
        .unwrap_or("unknown")
        .to_owned();
    Some(Transaction {
        direction,
        amount_atomic: amount,
        txid,
        height: 0,
    })
}

fn first_error(stdout: &str, stderr: &str) -> Option<String> {
    stdout
        .lines()
        .chain(stderr.lines())
        .map(str::trim)
        .find(|line| line.starts_with("Error:") || line.starts_with("error:"))
        .map(ToOwned::to_owned)
}

fn tempfile_dir() -> Result<PathBuf, BackendError> {
    let base = std::env::temp_dir().join(format!("mfw-tui-{}", std::process::id()));
    let dir = base.join(format!(
        "{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or(Duration::from_secs(0))
            .as_nanos()
    ));
    fs::create_dir_all(&dir).map_err(|error| BackendError::msg(error.to_string()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&dir, fs::Permissions::from_mode(0o700));
    }
    Ok(dir)
}

fn wait_for_child(
    child: &mut std::process::Child,
    timeout: Duration,
) -> Result<ExitStatus, BackendError> {
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Ok(status),
            Ok(None) if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(BackendError::msg(
                    "Timed out connecting to the node. Open Menu → Node Status to pick another route.",
                ));
            }
            Ok(None) => thread::sleep(Duration::from_millis(40)),
            Err(error) => {
                return Err(BackendError::msg(format!(
                    "product CLI did not finish: {error}"
                )));
            }
        }
    }
}

fn is_connection_failure(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    lower.contains("no connection")
        || lower.contains("failed to connect")
        || lower.contains("timed out")
        || lower.contains("timeout")
}

fn write_private(path: &Path, bytes: &[u8]) -> Result<(), BackendError> {
    {
        let mut file =
            fs::File::create(path).map_err(|error| BackendError::msg(error.to_string()))?;
        file.write_all(bytes)
            .map_err(|error| BackendError::msg(error.to_string()))?;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))
            .map_err(|error| BackendError::msg(error.to_string()))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_create_and_balance_output() {
        let address = "4".to_owned() + &"A".repeat(94);
        assert_eq!(address.len(), 95);
        let output = format!(
            "\
FAST-WALLET-CLI BY TEX8\n\
Generated new wallet: {address}\n\
NOTE: the following 25 words can be used to recover access to your wallet. Write them down\n\
alpha bravo charlie delta echo foxtrot golf hotel india juliet\n\
kilo lima mike november oscar papa quebec romeo sierra tango\n\
uniform victor whiskey xray yankee\n\
**********************************************************************\n\
Balance: 1.250000000000, unlocked balance: 0.500000000000\n\
0  {address}  Primary address\n"
        );
        let parsed = parse_cli_output(&output).unwrap();
        assert!(parsed.address.unwrap().starts_with('4'));
        assert_eq!(parsed.balance_atomic, Some(1_250_000_000_000));
        assert_eq!(parsed.unlocked_atomic, Some(500_000_000_000));
        let seed = parsed.seed.unwrap();
        assert_eq!(seed.split_whitespace().count(), 25);
        assert!(!seed.contains("NOTE"));
        assert_eq!(parsed.addresses.len(), 1);
    }

    #[test]
    fn parses_height_progress_like_the_gui() {
        let parsed = parse_cli_output(
            "Height 3577876 / 3734791 (95.8%)\nRefresh done, blocks received: 156915\nRefreshed 3734791/3734791, synced\n",
        )
        .unwrap();
        assert_eq!(parsed.wallet_height, Some(3_734_791));
        assert_eq!(parsed.daemon_height, Some(3_734_791));
        assert!(parsed.synchronized);
        assert!(parsed.refresh_done);
    }

    #[test]
    fn ignores_view_key_lines() {
        let output = "View key: 00deadbeef\nOpened wallet: 4AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n";
        let parsed = parse_cli_output(output).unwrap();
        assert!(parsed.seed.is_none());
        assert!(parsed.address.unwrap().starts_with('4'));
    }
}
