fn main() -> Result<(), Box<dyn std::error::Error>> {
    let proto = "../../node/cuprate/binaries/cuprated/proto/cuprate_stream.proto";
    let include = "../../node/cuprate/binaries/cuprated/proto";

    println!("cargo:rerun-if-changed={proto}");
    tonic_build::configure()
        .build_server(false)
        .compile_protos(&[proto], &[include])?;

    Ok(())
}
