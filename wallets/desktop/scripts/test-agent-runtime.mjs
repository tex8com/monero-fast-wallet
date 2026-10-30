#!/usr/bin/env node
// Compile the real agent transport/journal with explicit OS/credential/Tor
// fixtures. The network test uses only loopback; it never sends a real push.
import {readFileSync,writeFileSync,mkdirSync,mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
const desktop=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const directory=process.env.MFW_AGENT_TEST_DIR || mkdtempSync(join(tmpdir(),'mfw-agent-runtime-'));
mkdirSync(join(directory,'src'),{recursive:true});
const lock=readFileSync(join(desktop,'src-tauri/Cargo.lock'),'utf8');
const version=name=>lock.split('[[package]]').find(entry=>entry.includes(`\nname = "${name}"\n`))?.match(/\nversion = "([^"]+)"/)?.[1];
for(const name of ['serde','serde_json','sha2','getrandom','hex','rustls','tungstenite','zeroize']) if(!version(name)) throw new Error(`Missing locked fixture dependency: ${name}`);
writeFileSync(join(directory,'Cargo.toml'),`[package]
name="mfw-agent-network-fixture"
version="0.0.0"
edition="2021"
[dependencies]
serde={version="=${version('serde')}",features=["derive"]}
serde_json="=${version('serde_json')}"
sha2="=${version('sha2')}"
getrandom="=${version('getrandom')}"
hex="=${version('hex')}"
zeroize="=${version('zeroize')}"
rustls={version="=${version('rustls')}",default-features=false,features=["ring"]}
tungstenite={version="=${version('tungstenite')}",default-features=false,features=["handshake","rustls-tls-webpki-roots"]}
`);
writeFileSync(join(directory,'Cargo.lock'),lock);
const source=readFileSync(join(desktop,'src-tauri/src/bin/monero-fast-walletd.rs'),'utf8')
  .replaceAll('//!','//')
  .replace('#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]','')
  .replaceAll('any(target_os = "linux", target_os = "windows")','any(target_os = "linux", target_os = "windows", agent_fixture)')
  .replaceAll('#[cfg(target_os = "linux")]','#[cfg(any(target_os = "linux", agent_fixture))]')
  .replace('#[cfg(target_os = "windows")]\nfn open_saved_notification','#[cfg(any(target_os = "windows", agent_fixture))]\nfn open_saved_notification')
  .replaceAll('#[cfg(target_os = "windows")]','#[cfg(any())]')
  .replace('mod agent_runtime;',`#[path=${JSON.stringify(join(desktop,'src-tauri/src/bin/agent_runtime/mod.rs'))}] mod agent_runtime;`);
const fixture=String.raw`
#![allow(unexpected_cfgs,dead_code)]
mod keyring {
 pub struct Entry;
 impl Entry { pub fn new(_: &str,_:&str)->Result<Self,()> {Ok(Self)} pub fn get_password(&self)->Result<String,()> {Err(())} }
}
mod monero_wallet_desktop { pub mod tor_transport {
 pub static STARTS:std::sync::atomic::AtomicUsize=std::sync::atomic::AtomicUsize::new(0);
 pub fn start_embedded_tor(_:std::path::PathBuf){STARTS.fetch_add(1,std::sync::atomic::Ordering::SeqCst);}
 pub fn socks_address()->String {"127.0.0.1:1".into()}
}}
mod notify_rust {
 pub static SHOWS:std::sync::atomic::AtomicUsize=std::sync::atomic::AtomicUsize::new(0);
 pub struct Notification;
 pub struct Handle;
 pub enum NotificationResponse {Default,Action(String),Closed}
 impl Notification {
  pub fn new()->Self {Self}
  pub fn summary(&mut self,_:&str)->&mut Self {self}
  pub fn body(&mut self,_:&str)->&mut Self {self}
  pub fn appname(&mut self,_:&str)->&mut Self {self}
  pub fn action(&mut self,_:&str,_:&str)->&mut Self {self}
  pub fn show(&self)->Result<Handle,()> {SHOWS.fetch_add(1,std::sync::atomic::Ordering::SeqCst);Ok(Handle)}
 }
 impl Handle {pub fn wait_for_response(self,_:impl FnOnce(&NotificationResponse))->Result<(),()> {Ok(())}}
}
`;
const tests=String.raw`
#[cfg(test)] mod transport_regression {
 use super::*;
 #[cfg(unix)]
 #[test] fn cold_protocol_activation_uses_owned_accepted_journal_without_network_or_health_mutation() {
  let directory=std::env::temp_dir().join(format!("mfw-agent-activation-{}",std::process::id()));fs::create_dir_all(&directory).unwrap();
  let config_path=directory.join("background-agent.json");
  let config=serde_json::json!({"version":5,"installationId":"fixture-installation-0123456789","platform":"windows","provider":"windows-agent","serviceUrl":"http://127.0.0.1:1","appCommand":"/usr/bin/true","enabled":true});
  agent_runtime::atomic_write(&config_path,&serde_json::to_vec(&config).unwrap()).unwrap();
  let id=format!("evt_{}","e".repeat(64));let mut journal=Journal::open(&directory).unwrap();
  journal.receive_event(&id,"monero.fast_wallet.test","tex8://notification/test",100).unwrap();journal.mark(&id,DeliveryStage::PresentationPending).unwrap();
  journal.mark(&id,DeliveryStage::OsAccepted).unwrap();drop(journal);
  fs::write(directory.join("agent-health.json"),b"existing-live-health").unwrap();
  let _running_daemon=InstanceGuard::acquire(&config_path).unwrap().unwrap();
  let path=config_path.to_str().unwrap();let config=read_config(path).unwrap();
  open_saved_notification(path,&config,&id).unwrap();
  let pending=fs::read(directory.join("pending-open-event.json")).unwrap();let event:NotificationEvent=serde_json::from_slice(&pending).unwrap();
  assert_eq!(event.id,id);assert_eq!(event.received_at,"100");assert!(event.opened);
  assert_eq!(fs::read(directory.join("agent-health.json")).unwrap(),b"existing-live-health");
  assert_eq!(monero_wallet_desktop::tor_transport::STARTS.load(std::sync::atomic::Ordering::SeqCst),0);
  let unknown=format!("evt_{}","f".repeat(64));assert!(open_saved_notification(path,&config,&unknown).is_err());
  assert_eq!(fs::read(directory.join("pending-open-event.json")).unwrap(),pending);
  let _=fs::remove_dir_all(directory);
 }
 #[test] fn actual_transport_survives_gateway_idle_dedupes_replay_and_stops_without_waiting_for_ping() {
  use std::{net::TcpListener,sync::atomic::Ordering};
  use tungstenite::{accept,Message};
  std::env::set_var("MONERO_FAST_WALLETD_TEST_AUTH","07".repeat(32));
  let directory=std::env::temp_dir().join(format!("mfw-agent-wire-{}",std::process::id()));
  fs::create_dir_all(&directory).unwrap();
  let config_path=directory.join("background-agent.json");
  let listener=TcpListener::bind("127.0.0.1:0").unwrap();
  let address=listener.local_addr().unwrap();
  let config=serde_json::json!({"version":5,"installationId":"fixture-installation-0123456789","platform":"linux","provider":"linux-agent","serviceUrl":format!("http://{address}"),"appCommand":std::env::current_exe().unwrap(),"enabled":true});
  agent_runtime::atomic_write(&config_path,&serde_json::to_vec(&config).unwrap()).unwrap();
  let event_id=format!("evt_{}","c".repeat(64));
  let server_path=config_path.clone(); let server_id=event_id.clone();
  let server=thread::spawn(move|| {
   let (tcp,_)=listener.accept().unwrap(); tcp.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
   let mut socket=accept(tcp).unwrap();
   // Production Gateway sends its first heartbeat at 25s. The old 20s
   // timeout dropped this exact connection before that heartbeat.
   thread::sleep(Duration::from_secs(25)); socket.send(Message::Ping(vec![].into())).unwrap();
   assert!(matches!(socket.read().unwrap(),Message::Pong(_)));
   for id in [server_id.clone(),server_id.clone(),format!("evt_{}","d".repeat(64))] {
    socket.send(Message::Text(serde_json::json!({"type":"event","event":{"id":id,"category":"monero.fast_wallet.test","deepLink":"tex8://notification/test"}}).to_string().into())).unwrap();
    let ack=socket.read().unwrap().into_text().unwrap();
    let ack:serde_json::Value=serde_json::from_str(&ack).unwrap(); assert_eq!(ack["type"],"ack"); assert_eq!(ack["eventId"],id);
   }
   let mut disabled=config; disabled["enabled"]=false.into();
   agent_runtime::atomic_write(&server_path,&serde_json::to_vec(&disabled).unwrap()).unwrap();
   thread::sleep(Duration::from_millis(1500));
  });
  let path=config_path.to_str().unwrap(); let config=read_config(path).unwrap();
  // Simulate both OS crash boundaries in the durable production journal.
  let mut journal=Journal::open(&directory).unwrap();
  journal.receive(&event_id,agent_runtime::now()-1).unwrap(); journal.mark(&event_id,DeliveryStage::PresentationPending).unwrap();
  let accepted=format!("evt_{}","d".repeat(64)); journal.receive(&accepted,agent_runtime::now()-1).unwrap();
  journal.mark(&accepted,DeliveryStage::PresentationPending).unwrap(); journal.mark(&accepted,DeliveryStage::OsAccepted).unwrap(); drop(journal);
  let mut journal=Journal::open(&directory).unwrap(); let log=AgentLog::new(&directory); let mut healthy=false;
  let started=Instant::now(); assert!(run_stream_connection(path,&config,&mut journal,&log,&mut healthy).unwrap());
  assert!(healthy); assert!(started.elapsed()>=Duration::from_secs(25)); assert!(started.elapsed()<Duration::from_secs(29));
  assert_eq!(notify_rust::SHOWS.load(Ordering::SeqCst),1,"a durable accepted replay must not request a second OS toast");
  server.join().unwrap();
  let record=Journal::open(&directory).unwrap().receive(&event_id,agent_runtime::now()).unwrap(); assert_eq!(record.stage,DeliveryStage::Acknowledged);
  let lines=fs::read_to_string(directory.join("agent.log")).unwrap();
  assert_eq!(lines.matches("os_accepted").count(),1); assert_eq!(lines.matches("ack_sent").count(),3); assert_eq!(lines.matches("socket_received").count(),3);
  assert!(lines.contains("presentation_unknown"),"unknown crash outcome must be retried and logged, never silently acknowledged");
  assert!(lines.contains("duplicate_suppressed"));
  let health:serde_json::Value=serde_json::from_slice(&fs::read(directory.join("agent-health.json")).unwrap()).unwrap(); assert_eq!(health["connected"],false);
  let _=fs::remove_dir_all(directory);
 }
}
`;
writeFileSync(join(directory,'src/main.rs'),fixture+source+tests);
console.log(`Explicit fixture only: loopback transport, no OS push or credential access. Artifacts: ${directory}`);
const result=spawnSync('cargo',['test','--offline','--manifest-path',join(directory,'Cargo.toml'),'--','--test-threads=1'],{
 cwd:desktop,stdio:'inherit',env:{...process.env,CARGO_BUILD_JOBS:'2',RUSTFLAGS:`${process.env.RUSTFLAGS||''} --cfg agent_fixture`},
});
process.exit(result.status??1);
