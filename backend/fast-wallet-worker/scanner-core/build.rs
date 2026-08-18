// Generates only the MFN block-stream client used by the outbound Worker.
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let proto = "../../../node/mfn-monero-fast-node/binaries/cuprated/proto/cuprate_stream.proto";
    let include = "../../../node/mfn-monero-fast-node/binaries/cuprated/proto";

    println!("cargo:rerun-if-changed={proto}");
    tonic_build::configure()
        .build_server(false)
        .compile_protos(&[proto], &[include])?;

    Ok(())
}
