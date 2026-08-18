use std::os::raw::c_int;

unsafe extern "C" {
    fn tex8_desktop_wallet_core_linked_with_monero() -> c_int;
}

pub fn is_linked() -> bool {
    // The C++ facade is the authority. The build-time value prevents a release
    // from accidentally claiming readiness if its native link configuration was
    // incomplete.
    let configured = option_env!("TEX8_DESKTOP_MONERO_LINKED") == Some("1");
    configured && unsafe { tex8_desktop_wallet_core_linked_with_monero() == 1 }
}

#[cfg(test)]
mod tests {
    use super::is_linked;

    #[test]
    fn build_status_matches_the_native_wallet_core() {
        if option_env!("TEX8_DESKTOP_MONERO_LINKED") == Some("1") {
            assert!(
                is_linked(),
                "configured native core must load through the FFI"
            );
        } else {
            assert!(!is_linked(), "shell build must never claim to link Monero");
        }
    }
}
