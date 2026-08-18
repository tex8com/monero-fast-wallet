use clap::{Args, Parser, Subcommand, ValueEnum};
use community_matrix_core::{MatrixClientConfig, MatrixE2eeClient};
use community_search_core::{
    CommunitySearchCore, LocalQueryEmbedding, ModelContract, SearchFilters,
};
use ed25519_dalek::VerifyingKey;
use reqwest::{Client, Method, Response};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
    process::ExitCode,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use url::Url;
use zeroize::{Zeroize, Zeroizing};

const MAX_RESPONSE_BYTES: usize = 2 * 1024 * 1024;
const MAX_INPUT_BYTES: usize = 16 * 1024 * 1024;
const DELETE_CONFIRMATION: &str = "DELETE MY COMMUNITY PROFILE";

#[derive(Parser)]
#[command(
    name = "monero-fast-wallet-community",
    version,
    about = "Monero Fast Wallet CLI — Community automation and acceptance-test client"
)]
struct Cli {
    /// Community V1 API origin. HTTPS is mandatory except for explicit loopback tests.
    #[arg(long, default_value = "https://xmr.tex8.com")]
    api_origin: String,
    /// App-private CLI state. Files containing credentials are forced to mode 0600 on Unix.
    #[arg(long)]
    state_dir: PathBuf,
    /// Permit plain HTTP only when the origin host is localhost/127.0.0.1/::1.
    #[arg(long)]
    allow_loopback_http: bool,
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Show the current pseudonymous Community account status.
    Status,
    /// Create, inspect or delete the anonymous Community identity.
    Identity(IdentityArgs),
    /// Create, inspect, revise or withdraw the public profile.
    Profile(ProfileArgs),
    /// Create, inspect, revise or withdraw a public Community post.
    Post(PostArgs),
    /// Create, inspect, revise, republish or withdraw a public listing.
    Listing(ListingArgs),
    /// Create, inspect and moderate public Community entries.
    Content(ContentArgs),
    /// Request, accept, resolve and block contacts.
    Contacts(ContactArgs),
    /// Register and inspect opaque notification installations.
    Notifications(NotificationArgs),
    /// Submit an optional privacy-filtered common-query contribution.
    Query(QueryArgs),
    /// Install and search a signed catalog locally. No query is sent to the server.
    Catalog(CatalogArgs),
    /// Provision and exercise the encrypted Matrix chat core.
    Matrix(MatrixArgs),
    /// Explicit internal-only request for the moderation/operations testbench.
    Admin(AdminArgs),
}

#[derive(Args)]
struct IdentityArgs {
    #[command(subcommand)]
    command: IdentityCommand,
}

#[derive(Subcommand)]
enum IdentityCommand {
    Create,
    Status,
    Delete {
        /// Must exactly equal DELETE MY COMMUNITY PROFILE.
        #[arg(long)]
        confirm: String,
    },
}

#[derive(Args)]
struct ContentArgs {
    #[command(subcommand)]
    command: ContentCommand,
}

#[derive(Subcommand)]
enum ContentCommand {
    Submit {
        #[arg(long)]
        file: PathBuf,
    },
    List,
    Get {
        public_id: String,
    },
    Resubmit {
        public_id: String,
        #[arg(long)]
        file: PathBuf,
    },
    Withdraw {
        public_id: String,
        revision: u64,
    },
    Report {
        public_id: String,
        revision: u64,
        #[arg(long)]
        reason: String,
        #[arg(long)]
        illegal_content_notice: bool,
    },
    Outcomes,
    Appeal {
        case_id: String,
        #[arg(long)]
        reason: String,
    },
}

#[derive(Args)]
struct ProfileArgs {
    #[command(subcommand)]
    command: ProfileCommand,
}

#[derive(Subcommand)]
enum ProfileCommand {
    Create {
        #[arg(long)]
        file: PathBuf,
    },
    Show {
        public_id: String,
    },
    Update {
        public_id: String,
        #[arg(long)]
        file: PathBuf,
    },
    Withdraw {
        public_id: String,
        revision: u64,
    },
}

#[derive(Args)]
struct PostArgs {
    #[command(subcommand)]
    command: PostCommand,
}

#[derive(Subcommand)]
enum PostCommand {
    Create {
        #[arg(long)]
        file: PathBuf,
    },
    Show {
        public_id: String,
    },
    Update {
        public_id: String,
        #[arg(long)]
        file: PathBuf,
    },
    Withdraw {
        public_id: String,
        revision: u64,
    },
}

#[derive(Args)]
struct ListingArgs {
    #[command(subcommand)]
    command: ListingCommand,
}

#[derive(Subcommand)]
enum ListingCommand {
    Create {
        #[arg(long)]
        file: PathBuf,
    },
    List,
    Show {
        public_id: String,
    },
    Update {
        public_id: String,
        #[arg(long)]
        file: PathBuf,
    },
    Republish {
        public_id: String,
        #[arg(long)]
        file: PathBuf,
    },
    Withdraw {
        public_id: String,
        revision: u64,
    },
}

#[derive(Args)]
struct ContactArgs {
    #[command(subcommand)]
    command: ContactCommand,
}

#[derive(Subcommand)]
enum ContactCommand {
    Request {
        peer_id: String,
    },
    Pending,
    Accepted,
    Accept {
        request_id: String,
    },
    Decline {
        request_id: String,
    },
    Resolve {
        peer_id: String,
    },
    Block {
        peer_id: String,
    },
    ReportMessage {
        peer_id: String,
        #[arg(long)]
        file: PathBuf,
    },
    ReportOutcome {
        case_id: String,
    },
    AppealReport {
        case_id: String,
        #[arg(long)]
        reason: String,
    },
}

#[derive(Args)]
struct NotificationArgs {
    #[command(subcommand)]
    command: NotificationCommand,
}

#[derive(Subcommand)]
enum NotificationCommand {
    Register {
        installation_id: String,
        #[arg(long, value_enum)]
        provider: PushProvider,
        #[arg(long)]
        token_file: PathBuf,
    },
    List,
    Remove {
        installation_id: String,
    },
}

#[derive(Clone, Copy, ValueEnum)]
enum PushProvider {
    Apns,
    Fcm,
}

impl PushProvider {
    fn as_str(self) -> &'static str {
        match self {
            Self::Apns => "apns",
            Self::Fcm => "fcm",
        }
    }
}

#[derive(Args)]
struct QueryArgs {
    #[command(subcommand)]
    command: QueryCommand,
}

#[derive(Subcommand)]
enum QueryCommand {
    Contribute {
        #[arg(long)]
        submission_id: String,
        #[arg(long)]
        query: String,
        #[arg(long, default_value = "en")]
        language: String,
    },
}

#[derive(Args)]
struct CatalogArgs {
    #[command(subcommand)]
    command: CatalogCommand,
}

#[derive(Subcommand)]
enum CatalogCommand {
    Install {
        #[arg(long)]
        scope: String,
        #[arg(long)]
        verifying_key_hex: String,
        #[arg(long)]
        manifest: PathBuf,
        #[arg(long)]
        payload: PathBuf,
        #[arg(long)]
        now_ms: Option<u64>,
    },
    Status {
        #[arg(long)]
        scope: String,
        #[arg(long)]
        verifying_key_hex: String,
        #[arg(long)]
        now_ms: Option<u64>,
    },
    Search {
        #[arg(long)]
        scope: String,
        #[arg(long)]
        verifying_key_hex: String,
        /// JSON array containing the local 640-dimensional Harrier query embedding.
        #[arg(long)]
        embedding_file: PathBuf,
        #[arg(long, default_value_t = 20)]
        limit: usize,
        #[arg(long)]
        coarse_region: Option<String>,
        #[arg(long)]
        now_ms: Option<u64>,
    },
}

#[derive(Args)]
struct MatrixArgs {
    #[command(subcommand)]
    command: MatrixCommand,
}

#[derive(Subcommand)]
enum MatrixCommand {
    Provision {
        #[arg(long)]
        password_file: PathBuf,
    },
    Login {
        #[arg(long)]
        homeserver: String,
        #[arg(long)]
        user_id: String,
        #[arg(long)]
        password_file: PathBuf,
        #[arg(long)]
        store_passphrase_file: PathBuf,
        #[arg(long, default_value = "Monero Fast Wallet CLI")]
        device_name: String,
    },
    Sync {
        #[command(flatten)]
        session: MatrixSessionArgs,
    },
    Open {
        peer_id: String,
        #[command(flatten)]
        session: MatrixSessionArgs,
    },
    Join {
        room_id: String,
        #[command(flatten)]
        session: MatrixSessionArgs,
    },
    Send {
        room_id: String,
        #[arg(long)]
        body: String,
        #[command(flatten)]
        session: MatrixSessionArgs,
    },
    Messages {
        room_id: String,
        #[arg(long)]
        from: Option<String>,
        #[arg(long, default_value_t = 50)]
        limit: usize,
        #[command(flatten)]
        session: MatrixSessionArgs,
    },
    RecoveryStatus {
        #[command(flatten)]
        session: MatrixSessionArgs,
    },
    EnableRecovery {
        #[arg(long)]
        recovery_output: PathBuf,
        #[arg(long)]
        recovery_passphrase_file: Option<PathBuf>,
        #[command(flatten)]
        session: MatrixSessionArgs,
    },
    Recover {
        #[arg(long)]
        recovery_file: PathBuf,
        #[command(flatten)]
        session: MatrixSessionArgs,
    },
    Logout {
        #[command(flatten)]
        session: MatrixSessionArgs,
    },
}

#[derive(Args)]
struct MatrixSessionArgs {
    #[arg(long)]
    homeserver: String,
    #[arg(long)]
    store_passphrase_file: PathBuf,
}

#[derive(Args)]
struct AdminArgs {
    /// Private loopback operations origin, normally http://127.0.0.1:8091.
    #[arg(long)]
    origin: String,
    /// Private bearer-token file; symlinks and group/world access are rejected on Unix.
    #[arg(long)]
    token_file: PathBuf,
    #[arg(value_enum)]
    method: HttpMethod,
    /// Absolute API path beginning with /internal/.
    path: String,
    #[arg(long)]
    body_file: Option<PathBuf>,
}

#[derive(Clone, Copy, ValueEnum)]
enum HttpMethod {
    Get,
    Post,
    Delete,
}

impl From<HttpMethod> for Method {
    fn from(value: HttpMethod) -> Self {
        match value {
            HttpMethod::Get => Method::GET,
            HttpMethod::Post => Method::POST,
            HttpMethod::Delete => Method::DELETE,
        }
    }
}

#[derive(Debug, thiserror::Error)]
enum CliError {
    #[error("{0}")]
    Message(String),
}

type Result<T> = std::result::Result<T, CliError>;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredAccount {
    identity_id: String,
    access_token: String,
}

#[tokio::main]
async fn main() -> ExitCode {
    let cli = Cli::parse();
    match run(cli).await {
        Ok(value) => {
            println!(
                "{}",
                serde_json::to_string_pretty(&value).unwrap_or_else(|_| "null".to_owned())
            );
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("{}", json!({"ok": false, "error": error.to_string()}));
            ExitCode::FAILURE
        }
    }
}

async fn run(cli: Cli) -> Result<Value> {
    let Cli {
        api_origin,
        state_dir,
        allow_loopback_http,
        command,
    } = cli;
    let config = RuntimeConfig {
        api_origin,
        state_dir,
        allow_loopback_http,
    };
    ensure_private_directory(&config.state_dir)?;
    match command {
        Command::Catalog(args) => run_catalog(&config.state_dir, args.command),
        Command::Matrix(args) => run_matrix(&config, args.command).await,
        Command::Admin(args) => run_admin(&config, args).await,
        command => run_public(&config, command).await,
    }
}

struct RuntimeConfig {
    api_origin: String,
    state_dir: PathBuf,
    allow_loopback_http: bool,
}

async fn run_public(cli: &RuntimeConfig, command: Command) -> Result<Value> {
    let origin = validate_origin(&cli.api_origin, cli.allow_loopback_http, false)?;
    let http = http_client()?;
    match command {
        Command::Status => {
            authorized(
                cli,
                &http,
                &origin,
                Method::GET,
                &["v2", "account", "status"],
                None,
            )
            .await
        }
        Command::Identity(args) => match args.command {
            IdentityCommand::Create => {
                if account_path(&cli.state_dir).exists() {
                    return message("a Community identity already exists in this state directory");
                }
                let value = request_json(
                    &http,
                    Method::POST,
                    &endpoint(&origin, &["v2", "identities"])?,
                    None,
                    None,
                )
                .await?;
                let account: StoredAccount =
                    serde_json::from_value(value.clone()).map_err(|_| {
                        CliError::Message("the Community identity response is invalid".to_owned())
                    })?;
                validate_account(&account)?;
                write_private_json(&account_path(&cli.state_dir), &account)?;
                Ok(json!({"identityId": account.identity_id}))
            }
            IdentityCommand::Status => {
                authorized(
                    cli,
                    &http,
                    &origin,
                    Method::GET,
                    &["v2", "account", "status"],
                    None,
                )
                .await
            }
            IdentityCommand::Delete { confirm } => {
                if confirm != DELETE_CONFIRMATION {
                    return message("the exact deletion confirmation is required");
                }
                let value = authorized(
                    cli,
                    &http,
                    &origin,
                    Method::POST,
                    &["v2", "identity", "delete"],
                    Some(json!({"confirmation": confirm})),
                )
                .await?;
                remove_file_if_exists(&account_path(&cli.state_dir))?;
                remove_file_if_exists(&session_path(&cli.state_dir))?;
                Ok(value)
            }
        },
        Command::Profile(args) => {
            let command = match args.command {
                ProfileCommand::Create { file } => ContentCommand::Submit { file },
                ProfileCommand::Show { public_id } => ContentCommand::Get { public_id },
                ProfileCommand::Update { public_id, file } => {
                    ContentCommand::Resubmit { public_id, file }
                }
                ProfileCommand::Withdraw {
                    public_id,
                    revision,
                } => ContentCommand::Withdraw {
                    public_id,
                    revision,
                },
            };
            run_content(cli, &http, &origin, command).await
        }
        Command::Post(args) => {
            let command = match args.command {
                PostCommand::Create { file } => ContentCommand::Submit { file },
                PostCommand::Show { public_id } => ContentCommand::Get { public_id },
                PostCommand::Update { public_id, file } => {
                    ContentCommand::Resubmit { public_id, file }
                }
                PostCommand::Withdraw {
                    public_id,
                    revision,
                } => ContentCommand::Withdraw {
                    public_id,
                    revision,
                },
            };
            run_content(cli, &http, &origin, command).await
        }
        Command::Listing(args) => {
            let command = match args.command {
                ListingCommand::Create { file } => ContentCommand::Submit { file },
                ListingCommand::List => ContentCommand::List,
                ListingCommand::Show { public_id } => ContentCommand::Get { public_id },
                ListingCommand::Update { public_id, file }
                | ListingCommand::Republish { public_id, file } => {
                    ContentCommand::Resubmit { public_id, file }
                }
                ListingCommand::Withdraw {
                    public_id,
                    revision,
                } => ContentCommand::Withdraw {
                    public_id,
                    revision,
                },
            };
            run_content(cli, &http, &origin, command).await
        }
        Command::Content(args) => run_content(cli, &http, &origin, args.command).await,
        Command::Contacts(args) => match args.command {
            ContactCommand::Request { peer_id } => {
                authorized(
                    cli,
                    &http,
                    &origin,
                    Method::POST,
                    &["v2", "contacts", &peer_id, "requests"],
                    None,
                )
                .await
            }
            ContactCommand::Pending => {
                authorized(
                    cli,
                    &http,
                    &origin,
                    Method::GET,
                    &["v2", "contacts", "requests"],
                    None,
                )
                .await
            }
            ContactCommand::Accepted => {
                authorized(cli, &http, &origin, Method::GET, &["v2", "contacts"], None).await
            }
            ContactCommand::Accept { request_id } => {
                authorized(
                    cli,
                    &http,
                    &origin,
                    Method::POST,
                    &["v2", "contacts", "requests", &request_id, "accept"],
                    None,
                )
                .await
            }
            ContactCommand::Decline { request_id } => {
                authorized(
                    cli,
                    &http,
                    &origin,
                    Method::POST,
                    &["v2", "contacts", "requests", &request_id, "decline"],
                    None,
                )
                .await
            }
            ContactCommand::Resolve { peer_id } => {
                authorized(
                    cli,
                    &http,
                    &origin,
                    Method::GET,
                    &["v2", "contacts", &peer_id],
                    None,
                )
                .await
            }
            ContactCommand::Block { peer_id } => {
                authorized(
                    cli,
                    &http,
                    &origin,
                    Method::POST,
                    &["v2", "contacts", &peer_id, "block"],
                    None,
                )
                .await
            }
            ContactCommand::ReportMessage { peer_id, file } => {
                authorized(
                    cli,
                    &http,
                    &origin,
                    Method::POST,
                    &["v2", "contacts", &peer_id, "chat-reports"],
                    Some(read_json(&file)?),
                )
                .await
            }
            ContactCommand::ReportOutcome { case_id } => {
                authorized(
                    cli,
                    &http,
                    &origin,
                    Method::GET,
                    &["v2", "moderation", "chat-reports", &case_id],
                    None,
                )
                .await
            }
            ContactCommand::AppealReport { case_id, reason } => {
                authorized(
                    cli,
                    &http,
                    &origin,
                    Method::POST,
                    &["v2", "moderation", "chat-reports", &case_id, "appeals"],
                    Some(json!({"reason": reason})),
                )
                .await
            }
        },
        Command::Notifications(args) => match args.command {
            NotificationCommand::Register {
                installation_id,
                provider,
                token_file,
            } => {
                let mut token = read_private_text(&token_file, "notification token")?;
                let result = authorized(cli, &http, &origin, Method::POST, &["v2", "notifications", "installations"], Some(json!({"installationId": installation_id, "provider": provider.as_str(), "token": token.trim()}))).await;
                token.zeroize();
                result
            }
            NotificationCommand::List => {
                authorized(
                    cli,
                    &http,
                    &origin,
                    Method::GET,
                    &["v2", "notifications", "installations"],
                    None,
                )
                .await
            }
            NotificationCommand::Remove { installation_id } => {
                authorized(
                    cli,
                    &http,
                    &origin,
                    Method::DELETE,
                    &["v2", "notifications", "installations", &installation_id],
                    None,
                )
                .await
            }
        },
        Command::Query(args) => match args.command {
            QueryCommand::Contribute {
                submission_id,
                query,
                language,
            } => {
                authorized(
                    cli,
                    &http,
                    &origin,
                    Method::POST,
                    &["v2", "query-contributions"],
                    Some(json!({
                        "submissionId": submission_id, "query": query, "language": language,
                        "modelId": ModelContract::harrier_v1().id,
                        "queryPromptVersion": ModelContract::harrier_v1().query_prompt_version
                    })),
                )
                .await
            }
        },
        _ => message("unsupported public command"),
    }
}

async fn run_content(
    cli: &RuntimeConfig,
    http: &Client,
    origin: &Url,
    command: ContentCommand,
) -> Result<Value> {
    match command {
        ContentCommand::Submit { file } => {
            authorized(
                cli,
                http,
                origin,
                Method::POST,
                &["v2", "content"],
                Some(read_json(&file)?),
            )
            .await
        }
        ContentCommand::List => {
            authorized(cli, http, origin, Method::GET, &["v2", "content"], None).await
        }
        ContentCommand::Get { public_id } => {
            authorized(
                cli,
                http,
                origin,
                Method::GET,
                &["v2", "content", &public_id],
                None,
            )
            .await
        }
        ContentCommand::Resubmit { public_id, file } => {
            authorized(
                cli,
                http,
                origin,
                Method::POST,
                &["v2", "content", &public_id],
                Some(read_json(&file)?),
            )
            .await
        }
        ContentCommand::Withdraw {
            public_id,
            revision,
        } => {
            authorized(
                cli,
                http,
                origin,
                Method::DELETE,
                &["v2", "content", &public_id, &revision.to_string()],
                None,
            )
            .await
        }
        ContentCommand::Report {
            public_id,
            revision,
            reason,
            illegal_content_notice,
        } => {
            authorized(
                cli,
                http,
                origin,
                Method::POST,
                &[
                    "v2",
                    "content",
                    &public_id,
                    &revision.to_string(),
                    "reports",
                ],
                Some(json!({"reason": reason, "illegalContentNotice": illegal_content_notice})),
            )
            .await
        }
        ContentCommand::Outcomes => {
            authorized(
                cli,
                http,
                origin,
                Method::GET,
                &["v2", "moderation", "outcomes"],
                None,
            )
            .await
        }
        ContentCommand::Appeal { case_id, reason } => {
            authorized(
                cli,
                http,
                origin,
                Method::POST,
                &["v2", "moderation", "cases", &case_id, "appeals"],
                Some(json!({"reason": reason})),
            )
            .await
        }
    }
}

async fn run_admin(cli: &RuntimeConfig, args: AdminArgs) -> Result<Value> {
    if !args.path.starts_with("/internal/") || args.path.contains("..") {
        return message("admin path must begin with /internal/ and may not contain ..");
    }
    let origin = validate_origin(&args.origin, cli.allow_loopback_http, true)?;
    let token = read_private_text(&args.token_file, "internal token")?;
    let body = args
        .body_file
        .as_ref()
        .map(|path| read_json(path))
        .transpose()?;
    let url = origin
        .join(args.path.trim_start_matches('/'))
        .map_err(|_| CliError::Message("invalid admin URL".to_owned()))?;
    request_json(
        &http_client()?,
        args.method.into(),
        &url,
        Some(token.trim()),
        body,
    )
    .await
}

fn run_catalog(state_dir: &Path, command: CatalogCommand) -> Result<Value> {
    let root = state_dir.join("catalog");
    ensure_private_directory(&root)?;
    match command {
        CatalogCommand::Install {
            scope,
            verifying_key_hex,
            manifest,
            payload,
            now_ms,
        } => {
            let core = CommunitySearchCore::open(&root, scope, verifying_key(&verifying_key_hex)?)
                .map_err(core_error)?;
            let generation = core
                .install(
                    &read_bounded(&manifest)?,
                    &read_bounded(&payload)?,
                    now_ms.unwrap_or_else(now),
                )
                .map_err(core_error)?;
            serde_json::to_value(generation).map_err(json_error)
        }
        CatalogCommand::Status {
            scope,
            verifying_key_hex,
            now_ms,
        } => {
            let core = CommunitySearchCore::open(&root, scope, verifying_key(&verifying_key_hex)?)
                .map_err(core_error)?;
            serde_json::to_value(
                core.active_generation(now_ms.unwrap_or_else(now))
                    .map_err(core_error)?,
            )
            .map_err(json_error)
        }
        CatalogCommand::Search {
            scope,
            verifying_key_hex,
            embedding_file,
            limit,
            coarse_region,
            now_ms,
        } => {
            if limit == 0 || limit > 50 {
                return message("search limit must be between 1 and 50");
            }
            let embedding: Vec<f32> =
                serde_json::from_value(read_json(&embedding_file)?).map_err(|_| {
                    CliError::Message("embedding file must contain a JSON float array".to_owned())
                })?;
            let query = LocalQueryEmbedding {
                model: ModelContract::harrier_v1(),
                embedding,
            };
            let core = CommunitySearchCore::open(&root, scope, verifying_key(&verifying_key_hex)?)
                .map_err(core_error)?;
            let results = core
                .search(
                    &query,
                    limit,
                    &SearchFilters {
                        kinds: Vec::new(),
                        coarse_region,
                        include_advertising: false,
                    },
                    now_ms.unwrap_or_else(now),
                )
                .map_err(core_error)?;
            serde_json::to_value(results).map_err(json_error)
        }
    }
}

async fn run_matrix(cli: &RuntimeConfig, command: MatrixCommand) -> Result<Value> {
    match command {
        MatrixCommand::Provision { password_file } => {
            let origin = validate_origin(&cli.api_origin, cli.allow_loopback_http, false)?;
            let mut password = read_private_text(&password_file, "Matrix password")?;
            let result = authorized(
                cli,
                &http_client()?,
                &origin,
                Method::POST,
                &["v2", "matrix", "provision"],
                Some(json!({"password": password.trim_end()})),
            )
            .await;
            password.zeroize();
            result
        }
        MatrixCommand::Login {
            homeserver,
            user_id,
            password_file,
            store_passphrase_file,
            device_name,
        } => {
            let mut password = read_private_text(&password_file, "Matrix password")?;
            let store_key = read_private_text(&store_passphrase_file, "Matrix store passphrase")?;
            let store = matrix_store(cli)?;
            let config = matrix_config(cli, &homeserver, &store, store_key.trim_end())?;
            let login =
                MatrixE2eeClient::login(config, &user_id, password.trim_end(), &device_name)
                    .await
                    .map_err(matrix_error)?;
            password.zeroize();
            write_private(&session_path(&cli.state_dir), &login.session_json)?;
            Ok(json!({"loggedIn": true, "userId": user_id}))
        }
        other => {
            let (session_args, operation) = match other {
                MatrixCommand::Sync { session } => (session, MatrixOperation::Sync),
                MatrixCommand::Open { peer_id, session } => {
                    (session, MatrixOperation::Open(peer_id))
                }
                MatrixCommand::Join { room_id, session } => {
                    (session, MatrixOperation::Join(room_id))
                }
                MatrixCommand::Send {
                    room_id,
                    body,
                    session,
                } => (session, MatrixOperation::Send(room_id, body)),
                MatrixCommand::Messages {
                    room_id,
                    from,
                    limit,
                    session,
                } => (session, MatrixOperation::Messages(room_id, from, limit)),
                MatrixCommand::RecoveryStatus { session } => {
                    (session, MatrixOperation::RecoveryStatus)
                }
                MatrixCommand::EnableRecovery {
                    recovery_output,
                    recovery_passphrase_file,
                    session,
                } => (
                    session,
                    MatrixOperation::EnableRecovery(recovery_output, recovery_passphrase_file),
                ),
                MatrixCommand::Recover {
                    recovery_file,
                    session,
                } => (session, MatrixOperation::Recover(recovery_file)),
                MatrixCommand::Logout { session } => (session, MatrixOperation::Logout),
                _ => unreachable!(),
            };
            let store_key = read_private_text(
                &session_args.store_passphrase_file,
                "Matrix store passphrase",
            )?;
            let store = matrix_store(cli)?;
            let config =
                matrix_config(cli, &session_args.homeserver, &store, store_key.trim_end())?;
            let session = read_private(&session_path(&cli.state_dir), "Matrix session")?;
            let client = MatrixE2eeClient::restore(config, &session)
                .await
                .map_err(matrix_error)?;
            let logging_out = matches!(operation, MatrixOperation::Logout);
            let result = match operation {
                MatrixOperation::Sync => {
                    client
                        .sync_once(Duration::from_secs(5))
                        .await
                        .map_err(matrix_error)?;
                    json!({"synced": true})
                }
                MatrixOperation::Open(peer) => {
                    json!({"roomId": client.create_or_get_direct_room(&peer).await.map_err(matrix_error)?.to_string()})
                }
                MatrixOperation::Join(room) => {
                    json!({"roomId": client.join_direct_room(&room).await.map_err(matrix_error)?.to_string(), "joined": true})
                }
                MatrixOperation::Send(room, body) => {
                    json!({"eventId": client.send_text(&room, &body).await.map_err(matrix_error)?.to_string()})
                }
                MatrixOperation::Messages(room, from, limit) => serde_json::to_value(
                    client
                        .text_messages(&room, from.as_deref(), limit)
                        .await
                        .map_err(matrix_error)?,
                )
                .map_err(json_error)?,
                MatrixOperation::RecoveryStatus => {
                    serde_json::to_value(client.recovery_state()).map_err(json_error)?
                }
                MatrixOperation::EnableRecovery(output, passphrase_file) => {
                    let passphrase = passphrase_file
                        .as_ref()
                        .map(|path| read_private_text(path, "Matrix recovery passphrase"))
                        .transpose()?;
                    let key = client
                        .enable_recovery(passphrase.as_deref().map(|value| value.trim_end()))
                        .await
                        .map_err(matrix_error)?;
                    write_private(&output, key.as_bytes())?;
                    json!({"recoveryEnabled": true, "recoveryKeyFile": output})
                }
                MatrixOperation::Recover(path) => {
                    let secret = read_private_text(&path, "Matrix recovery secret")?;
                    client
                        .recover(secret.trim_end())
                        .await
                        .map_err(matrix_error)?;
                    json!({"recovered": true})
                }
                MatrixOperation::Logout => {
                    client.logout().await.map_err(matrix_error)?;
                    remove_file_if_exists(&session_path(&cli.state_dir))?;
                    json!({"loggedOut": true})
                }
            };
            if !logging_out {
                write_private(
                    &session_path(&cli.state_dir),
                    &client.session_json().map_err(matrix_error)?,
                )?;
            }
            Ok(result)
        }
    }
}

enum MatrixOperation {
    Sync,
    Open(String),
    Join(String),
    Send(String, String),
    Messages(String, Option<String>, usize),
    RecoveryStatus,
    EnableRecovery(PathBuf, Option<PathBuf>),
    Recover(PathBuf),
    Logout,
}

fn matrix_store(cli: &RuntimeConfig) -> Result<PathBuf> {
    let store = cli.state_dir.join("matrix-store");
    ensure_private_directory(&store)?;
    Ok(store)
}

fn matrix_config<'a>(
    cli: &RuntimeConfig,
    homeserver: &'a str,
    store: &'a Path,
    store_key: &'a str,
) -> Result<MatrixClientConfig<'a>> {
    validate_origin(homeserver, cli.allow_loopback_http, false)?;
    Ok(MatrixClientConfig {
        homeserver,
        proxy: None,
        store_path: store,
        store_passphrase: store_key,
        allow_loopback_http_for_tests: cli.allow_loopback_http,
    })
}

async fn authorized(
    cli: &RuntimeConfig,
    http: &Client,
    origin: &Url,
    method: Method,
    segments: &[&str],
    body: Option<Value>,
) -> Result<Value> {
    let account: StoredAccount = serde_json::from_slice(&read_private(
        &account_path(&cli.state_dir),
        "Community account",
    )?)
    .map_err(|_| CliError::Message("the stored Community account is invalid".to_owned()))?;
    request_json(
        http,
        method,
        &endpoint(origin, segments)?,
        Some(&account.access_token),
        body,
    )
    .await
}

async fn request_json(
    http: &Client,
    method: Method,
    url: &Url,
    bearer: Option<&str>,
    body: Option<Value>,
) -> Result<Value> {
    let mut request = http.request(method, url.clone());
    if let Some(token) = bearer {
        request = request.bearer_auth(token);
    }
    if let Some(body) = body {
        request = request.json(&body);
    }
    let response = request
        .send()
        .await
        .map_err(|_| CliError::Message("Community request failed".to_owned()))?;
    checked_response(response).await
}

async fn checked_response(response: Response) -> Result<Value> {
    let status = response.status();
    let bytes = response
        .bytes()
        .await
        .map_err(|_| CliError::Message("Community response could not be read".to_owned()))?;
    if bytes.len() > MAX_RESPONSE_BYTES {
        return message("Community response exceeded the size limit");
    }
    let value = if bytes.is_empty() {
        json!({"ok": true, "status": status.as_u16()})
    } else {
        serde_json::from_slice(&bytes)
            .map_err(|_| CliError::Message("Community response was not valid JSON".to_owned()))?
    };
    if !status.is_success() {
        let code = value
            .get("code")
            .and_then(Value::as_str)
            .unwrap_or("request_failed");
        let detail = value
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("Community request failed");
        return Err(CliError::Message(format!(
            "HTTP {} {code}: {detail}",
            status.as_u16()
        )));
    }
    Ok(value)
}

fn http_client() -> Result<Client> {
    Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(20))
        .user_agent("TEX8-Monero-Fast-Wallet-CLI/0.1")
        .build()
        .map_err(|_| CliError::Message("HTTP client could not be created".to_owned()))
}

fn validate_origin(value: &str, allow_loopback: bool, internal: bool) -> Result<Url> {
    let url = Url::parse(value).map_err(|_| CliError::Message("origin is invalid".to_owned()))?;
    let loopback = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "::1"));
    if url.scheme() != "https" && !(allow_loopback && loopback && url.scheme() == "http") {
        return message("origin must use HTTPS; HTTP is allowed only for explicit loopback tests");
    }
    if internal && !loopback {
        return message("internal operations origin must be loopback");
    }
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return message("origin may not contain credentials, query or fragment");
    }
    Ok(url)
}

fn endpoint(origin: &Url, segments: &[&str]) -> Result<Url> {
    let mut url = origin.clone();
    {
        let mut path = url
            .path_segments_mut()
            .map_err(|_| CliError::Message("origin cannot be a base URL".to_owned()))?;
        path.pop_if_empty();
        for segment in segments {
            if segment.is_empty() || segment.contains('/') || segment.contains("..") {
                return message("endpoint identifier is invalid");
            }
            path.push(segment);
        }
    }
    Ok(url)
}

fn account_path(state: &Path) -> PathBuf {
    state.join("account.json")
}
fn session_path(state: &Path) -> PathBuf {
    state.join("matrix-session.json")
}

fn validate_account(account: &StoredAccount) -> Result<()> {
    if !account.identity_id.starts_with("person_")
        || account.identity_id.len() > 128
        || account.access_token.len() < 32
        || account.access_token.len() > 512
    {
        return message("the Community identity credentials are invalid");
    }
    Ok(())
}

fn read_json(path: &Path) -> Result<Value> {
    serde_json::from_slice(&read_bounded(path)?)
        .map_err(|_| CliError::Message(format!("{} is not valid JSON", path.display())))
}

fn read_bounded(path: &Path) -> Result<Vec<u8>> {
    let metadata = fs::symlink_metadata(path).map_err(|error| {
        CliError::Message(format!("could not inspect {}: {error}", path.display()))
    })?;
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.len() as usize > MAX_INPUT_BYTES
    {
        return message("input must be a bounded regular non-symlink file");
    }
    fs::read(path)
        .map_err(|error| CliError::Message(format!("could not read {}: {error}", path.display())))
}

fn read_private(path: &Path, label: &str) -> Result<Zeroizing<Vec<u8>>> {
    require_private_file(path, label)?;
    read_bounded(path).map(Zeroizing::new)
}

fn read_private_text(path: &Path, label: &str) -> Result<Zeroizing<String>> {
    let bytes = read_private(path, label)?;
    String::from_utf8(bytes.to_vec())
        .map(Zeroizing::new)
        .map_err(|_| CliError::Message(format!("{label} is not UTF-8")))
}

#[cfg(unix)]
fn require_private_file(path: &Path, label: &str) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| CliError::Message(format!("could not inspect {label}: {error}")))?;
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.permissions().mode() & 0o077 != 0
    {
        return message(&format!(
            "{label} must be a regular non-symlink file with mode 0600 or stricter"
        ));
    }
    Ok(())
}

#[cfg(not(unix))]
fn require_private_file(path: &Path, label: &str) -> Result<()> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| CliError::Message(format!("could not inspect {label}: {error}")))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return message(&format!("{label} must be a regular non-symlink file"));
    }
    Ok(())
}

fn ensure_private_directory(path: &Path) -> Result<()> {
    fs::create_dir_all(path).map_err(|error| {
        CliError::Message(format!("could not create {}: {error}", path.display()))
    })?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(|error| {
            CliError::Message(format!("could not protect {}: {error}", path.display()))
        })?;
    }
    Ok(())
}

fn write_private_json(path: &Path, value: &impl Serialize) -> Result<()> {
    write_private(path, &serde_json::to_vec(value).map_err(json_error)?)
}

fn write_private(path: &Path, bytes: &[u8]) -> Result<()> {
    if let Some(parent) = path.parent() {
        ensure_private_directory(parent)?;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        let mut options = fs::OpenOptions::new();
        options.write(true).create(true).truncate(true).mode(0o600);
        let mut file = options.open(path).map_err(|error| {
            CliError::Message(format!("could not write {}: {error}", path.display()))
        })?;
        use std::io::Write;
        file.write_all(bytes).map_err(|error| {
            CliError::Message(format!("could not write {}: {error}", path.display()))
        })?;
        file.sync_all().map_err(|error| {
            CliError::Message(format!("could not sync {}: {error}", path.display()))
        })?;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600)).map_err(|error| {
            CliError::Message(format!("could not protect {}: {error}", path.display()))
        })?;
    }
    #[cfg(not(unix))]
    {
        fs::write(path, bytes).map_err(|error| {
            CliError::Message(format!("could not write {}: {error}", path.display()))
        })?;
    }
    Ok(())
}

fn remove_file_if_exists(path: &Path) -> Result<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(CliError::Message(format!(
            "could not remove {}: {error}",
            path.display()
        ))),
    }
}

fn verifying_key(value: &str) -> Result<VerifyingKey> {
    let bytes = hex::decode(value)
        .map_err(|_| CliError::Message("catalog verifying key must be hexadecimal".to_owned()))?;
    let bytes: [u8; 32] = bytes
        .try_into()
        .map_err(|_| CliError::Message("catalog verifying key must contain 32 bytes".to_owned()))?;
    VerifyingKey::from_bytes(&bytes)
        .map_err(|_| CliError::Message("catalog verifying key is invalid".to_owned()))
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn core_error(error: impl std::fmt::Display) -> CliError {
    CliError::Message(error.to_string())
}
fn matrix_error(error: impl std::fmt::Display) -> CliError {
    CliError::Message(error.to_string())
}
fn json_error(error: impl std::fmt::Display) -> CliError {
    CliError::Message(format!("JSON error: {error}"))
}
fn message<T>(text: &str) -> Result<T> {
    Err(CliError::Message(text.to_owned()))
}
