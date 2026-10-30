//! Pure Linux installation contracts, exercised without a service manager.
use std::path::{Path, PathBuf};
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Dependency {
    pub name: String,
    pub path: PathBuf,
}
pub fn parse_ldd(output: &str) -> Result<Vec<Dependency>, &'static str> {
    let mut dependencies = Vec::new();
    for line in output.lines().map(str::trim) {
        if line.contains("not found") || line.contains("undefined symbol:") {
            return Err("The notification helper has unresolved runtime dependencies.");
        }
        let (name, resolved) = if let Some(pair) = line.split_once(" => ") {
            pair
        } else if line.starts_with('/') {
            let path = line.rsplit_once(" (").map_or(line, |(path, _)| path);
            let name = Path::new(path)
                .file_name()
                .and_then(|v| v.to_str())
                .ok_or("The notification dependency path is invalid.")?;
            (name, line)
        } else {
            continue;
        };
        if name.is_empty()
            || name
                .bytes()
                .any(|b| !b.is_ascii_alphanumeric() && !b"._+-".contains(&b))
        {
            return Err("The notification runtime dependency name is invalid.");
        }
        let path = resolved
            .rsplit_once(" (")
            .map_or(resolved, |(path, _)| path)
            .trim();
        if !Path::new(path).is_absolute() {
            return Err("The notification runtime dependency is unresolved.");
        }
        dependencies.push(Dependency {
            name: name.to_owned(),
            path: PathBuf::from(path),
        });
    }
    Ok(dependencies)
}
pub fn system_library(path: &Path) -> bool {
    ["/lib", "/lib64", "/usr/lib", "/usr/lib64"]
        .iter()
        .any(|root| path.starts_with(root))
}
pub fn transient_appimage(path: &Path) -> bool {
    path.components()
        .any(|part| part.as_os_str().to_string_lossy().starts_with(".mount_"))
}
pub fn unit_argument(path: &Path) -> Result<String, &'static str> {
    let value = path
        .to_str()
        .filter(|_| path.is_absolute())
        .ok_or("The notification service path is invalid.")?;
    if value.chars().any(char::is_control) {
        return Err("The notification service path contains a control character.");
    }
    Ok(format!(
        "\"{}\"",
        value
            .replace('\\', "\\\\")
            .replace('"', "\\\"")
            .replace('%', "%%")
            .replace('$', "$$")
    ))
}
pub fn render_unit(
    template: &str,
    agent: &Path,
    config: &Path,
    library: &Path,
) -> Result<String, &'static str> {
    let library = library
        .to_str()
        .filter(|_| library.is_absolute())
        .ok_or("The notification library path is invalid.")?;
    if library.chars().any(char::is_control) {
        return Err("The notification library path is invalid.");
    }
    // Environment= values do not expand shell/$ variables; systemd % specifiers do.
    let library = library
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('%', "%%");
    Ok(template
        .replace("@AGENT_EXEC@", &unit_argument(agent)?)
        .replace("@AGENT_CONFIG@", &unit_argument(config)?)
        .replace(
            "@AGENT_LIBRARY_ENV@",
            &format!("\"LD_LIBRARY_PATH={library}\""),
        ))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn actual_ldd_shapes_include_private_transitive_paths_with_spaces() {
        let parsed = parse_ldd("linux-vdso.so.1 (0x1)\n libcore.so => /tmp/.mount_test/usr/lib/Monero Fast Wallet/libcore.so (0x123)\n libdep.so.1 => /tmp/.mount_test/usr/lib/libdep.so.1 (0x456)\n libc.so.6 => /lib/x86_64-linux-gnu/libc.so.6 (0x789)\n /lib64/ld-linux-x86-64.so.2 (0x999)").unwrap();
        assert_eq!(parsed.len(), 4);
        assert!(parsed[0]
            .path
            .to_str()
            .unwrap()
            .contains("Monero Fast Wallet"));
        assert!(!system_library(&parsed[0].path));
        assert!(system_library(&parsed[2].path));
        assert!(!system_library(Path::new("/library/malicious.so")));
    }
    #[test]
    fn missing_unresolved_and_traversing_dependencies_fail_closed() {
        for text in [
            "libx.so => not found",
            "../secret => /tmp/x (0x1)",
            "libx.so => relative.so (0x1)",
            "undefined symbol: foo (/tmp/helper)",
        ] {
            assert!(parse_ldd(text).is_err());
        }
    }
    #[test]
    fn real_config_and_paths_are_quoted_without_shell_or_specifier_injection() {
        let template =
            "ExecStart=@AGENT_EXEC@ --config @AGENT_CONFIG@\nEnvironment=@AGENT_LIBRARY_ENV@\n";
        let result = render_unit(
            template,
            Path::new("/data/ä %u/$HOME/helper"),
            Path::new("/custom/XDG data/background-agent.json"),
            Path::new("/data/private libs"),
        )
        .unwrap();
        assert!(result.contains("\"/custom/XDG data/background-agent.json\""));
        assert!(result.contains("%%u/$$HOME"));
        assert!(!result.contains("@AGENT_"));
        assert!(unit_argument(Path::new("relative")).is_err());
        assert!(unit_argument(Path::new("/bad\npath")).is_err());
    }
    #[test]
    fn appimage_mount_is_not_a_durable_launcher() {
        assert!(transient_appimage(Path::new(
            "/tmp/.mount_Monero123/usr/bin/wallet"
        )));
        assert!(!transient_appimage(Path::new(
            "/home/user/Applications/Monero.AppImage"
        )));
    }
}
