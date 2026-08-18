// SPDX-License-Identifier: GPL-3.0-only

use anyhow::{Context, Result, bail};
use serde_json::Value;

/// Rewrites all supported Stratum authentication forms so a client cannot use
/// the gateway as an open proxy or redirect donation work to another wallet.
pub fn rewrite_client_message(
    line: &[u8],
    donation_address: &str,
    backend_password: &str,
) -> Result<Vec<u8>> {
    let mut value: Value = serde_json::from_slice(line).context("client sent invalid JSON")?;
    let method = value
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or_default();

    match method {
        "login" => rewrite_login(&mut value, donation_address, backend_password)?,
        "mining.authorize" => {
            rewrite_mining_authorize(&mut value, donation_address, backend_password)?
        }
        _ => {}
    }

    let mut encoded = serde_json::to_vec(&value)?;
    encoded.push(b'\n');
    Ok(encoded)
}

fn rewrite_login(value: &mut Value, address: &str, password: &str) -> Result<()> {
    let params = value
        .get_mut("params")
        .and_then(Value::as_object_mut)
        .context("Stratum login params must be an object")?;

    params.insert("login".to_owned(), Value::String(address.to_owned()));
    params.insert("pass".to_owned(), Value::String(password.to_owned()));
    params.remove("url");
    params.remove("user");
    params.remove("wallet_address");
    params.remove("spend-secret-key");

    Ok(())
}

fn rewrite_mining_authorize(value: &mut Value, address: &str, password: &str) -> Result<()> {
    let params = value
        .get_mut("params")
        .and_then(Value::as_array_mut)
        .context("mining.authorize params must be an array")?;
    if params.len() < 2 {
        bail!("mining.authorize requires user and password");
    }

    params[0] = Value::String(address.to_owned());
    params[1] = Value::String(password.to_owned());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const ADDRESS: &str = "49aaK7WgMCQABhjHt1UyXijKRwbjjbtSq2xbDbB4AgYLGqtXpudonJq58aM4j7fhTWdph4LD7VxjpEwEzBXBdzK2K9vybrL";

    #[test]
    fn replaces_login_and_removes_connect_target() {
        let input = br#"{"id":1,"method":"login","params":{"login":"attacker","pass":"bad","url":"evil.example:3333","agent":"mfw"}}"#;
        let output = rewrite_client_message(input, ADDRESS, "mfw~rx/0").unwrap();
        let value: Value = serde_json::from_slice(&output).unwrap();
        let params = value["params"].as_object().unwrap();

        assert_eq!(params["login"], ADDRESS);
        assert_eq!(params["pass"], "mfw~rx/0");
        assert!(!params.contains_key("url"));
        assert_eq!(params["agent"], "mfw");
    }

    #[test]
    fn replaces_standard_authorize() {
        let input = br#"{"id":2,"method":"mining.authorize","params":["attacker","bad"]}"#;
        let output = rewrite_client_message(input, ADDRESS, "x").unwrap();
        let value: Value = serde_json::from_slice(&output).unwrap();
        assert_eq!(value["params"][0], ADDRESS);
        assert_eq!(value["params"][1], "x");
    }
}
