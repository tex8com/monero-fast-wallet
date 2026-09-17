//! Availability lookup for public .mfw names.

use serde_json::Value;
use std::process::Command;

const ONION_RESOLVERS: [&str; 2] = [
    "http://fastrelayrpcf3hbc4qvykjgbpwpmcuq5dpcsdxoe7gwfh2zxdib3eid.onion",
    "http://quietportrpccujodzxhwcfefbmhftof5i6oiq7rrx5tnzna7rxirhqd.onion",
];
const CLEARNET_RESOLVERS: [&str; 2] = ["https://xmr.tex8.com", "https://mfw-resolver2.tex8.com"];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Availability {
    pub canonical_name: String,
    pub status: String,
    pub detail: String,
    pub chain_tip_height: u64,
}

pub fn canonical_name(value: &str) -> Result<String, String> {
    let normalized = value.trim().to_ascii_lowercase();
    let label = normalized.strip_suffix(".mfw").unwrap_or(&normalized);
    let valid = !label.is_empty()
        && label.len() <= 63
        && !label.starts_with('-')
        && !label.ends_with('-')
        && label
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-');
    if !valid {
        return Err(
            "Use 1-63 lowercase letters, numbers, or internal hyphens for an MFW name.".into(),
        );
    }
    Ok(format!("{label}.mfw"))
}

pub fn is_free(status: &str) -> bool {
    matches!(status, "available" | "available-again")
}

pub fn check_name(name: &str, network: &str) -> Result<Availability, String> {
    let canonical = canonical_name(name)?;
    let path = format!("/v1/mfw/names/{canonical}");
    let mut last = format!("{canonical} could not be checked.");
    for origin in ONION_RESOLVERS {
        match fetch_json(&format!("{}{path}", origin.trim_end_matches('/')), true) {
            Ok(body) => return interpret(&canonical, network, &body),
            Err(error) => last = error,
        }
    }
    for origin in CLEARNET_RESOLVERS {
        match fetch_json(&format!("{}{path}", origin.trim_end_matches('/')), false) {
            Ok(body) => return interpret(&canonical, network, &body),
            Err(error) => last = error,
        }
    }
    Err(last)
}

fn interpret(canonical: &str, network: &str, body: &str) -> Result<Availability, String> {
    let value: Value =
        serde_json::from_str(body).map_err(|_| "Resolver response is not JSON.".to_owned())?;
    let reported = value
        .get("canonicalName")
        .and_then(Value::as_str)
        .unwrap_or(canonical);
    let status_raw = value
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let reported_network = value.get("network").and_then(Value::as_str).unwrap_or("");
    if !reported_network.is_empty() && reported_network != network {
        return Err(format!(
            "{reported} is registered on {reported_network}, not {network}."
        ));
    }
    let chain_tip_height = value
        .get("chainTipHeight")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let expiry_height = value.get("expiryHeight").and_then(Value::as_u64);
    let status = match status_raw {
        "not_found" => "available",
        "expired" | "revoked" => "available-again",
        "reserved" => "reserved",
        "provisional" => "pending",
        "finalized" => "taken",
        other => other,
    };
    let detail = match status {
        "available" => format!("{reported} is available."),
        "available-again" => format!(
            "{reported} is available again{}.",
            expiry_height
                .map(|height| format!(" (expired at block {height})"))
                .unwrap_or_default()
        ),
        "taken" => format!("{reported} is taken."),
        "pending" => format!("{reported} has a pending registration."),
        "reserved" => format!("{reported} is reserved."),
        other => format!("{reported} status: {other}."),
    };
    Ok(Availability {
        canonical_name: reported.to_owned(),
        status: status.to_owned(),
        detail,
        chain_tip_height,
    })
}

fn fetch_json(url: &str, socks: bool) -> Result<String, String> {
    let mut command = Command::new("curl");
    command.args([
        "-sS",
        "--max-time",
        "8",
        "-H",
        "Accept: application/json",
        "--fail-with-body",
    ]);
    if socks {
        command.args(["--socks5-hostname", "127.0.0.1:9050"]);
    }
    command.arg(url);
    let output = command
        .output()
        .map_err(|error| format!("curl could not start: {error}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    if !output.status.success() && stdout.is_empty() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(if socks {
            format!("Onion resolver unreachable ({stderr})")
        } else {
            format!("Clearnet resolver unreachable ({stderr})")
        });
    }
    if stdout.trim().is_empty() {
        return Err("Resolver returned an empty body.".into());
    }
    Ok(stdout)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonicalizes_label() {
        assert_eq!(canonical_name("TEX8").unwrap(), "tex8.mfw");
        assert_eq!(canonical_name("tex8.mfw").unwrap(), "tex8.mfw");
        assert!(canonical_name("-bad").is_err());
    }

    #[test]
    fn maps_not_found_to_available() {
        let result = interpret(
            "tex8.mfw",
            "mainnet",
            r#"{"canonicalName":"tex8.mfw","status":"not_found","network":"mainnet","chainTipHeight":1}"#,
        )
        .unwrap();
        assert_eq!(result.status, "available");
        assert!(is_free(&result.status));
    }
}
