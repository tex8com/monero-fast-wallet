use fast_wallet_protocol::{
    key_id, Network, SigningKeyMaterial, WorkerDescriptor, WorkerDescriptorInput,
};

fn main() {
    let root = SigningKeyMaterial::from_bytes([7_u8; 32]);
    let online = SigningKeyMaterial::from_bytes([8_u8; 32]);
    let hpke_public_key = [9_u8; 32];
    let descriptor = WorkerDescriptor::sign(
        WorkerDescriptorInput {
            network: Network::Stagenet,
            issued_at: 1_800_000_000,
            expires_at: 1_800_003_600,
            worker_online_public_key: online.public_key(),
            hpke_public_key,
            relay_origin: "https://relay.tex8.com".to_owned(),
        },
        &root,
    )
    .expect("vector descriptor");
    println!(
        "descriptor_hex={}",
        hex::encode(descriptor.encode().unwrap())
    );
    println!(
        "worker_root_id={}",
        hex::encode(descriptor.worker_root_id())
    );
    println!(
        "online_key_id={}",
        hex::encode(descriptor.worker_online_key_id())
    );
    println!("hpke_key_id={}", hex::encode(key_id(&hpke_public_key)));
}
