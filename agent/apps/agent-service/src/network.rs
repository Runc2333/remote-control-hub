use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use agent_core::{FileCommandLedger, PersistedCommandState};
use agent_wire::{
    AGENT_PROTOCOL_VERSION, AgentAuthenticate, AgentAuthenticated, AgentChallenge, AgentCommand,
    AgentCommandResult, AgentHeartbeat, AgentHeartbeatAck, AgentHello, CommandErrorCode,
    CommandStatus, CommandType, MAX_FRAME_BYTES, build_authentication_payload,
};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use ed25519_dalek::Signer;
#[cfg(windows)]
use ed25519_dalek::SigningKey;
use futures_util::{SinkExt, StreamExt};
#[cfg(windows)]
use reqwest::redirect::Policy;
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;
use tokio::sync::watch;
use tokio::time::{MissedTickBehavior, interval, sleep, timeout};
use tokio_tungstenite::connect_async_with_config;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;

#[cfg(windows)]
use crate::identity::{IdentityStore, create_identity, normalize_service_origin};
use crate::identity::{MachineIdentity, websocket_url};

const AUTHENTICATION_TIMEOUT: Duration = Duration::from_secs(15);
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(15);
const MAX_RECONNECT_DELAY_SECONDS: u64 = 60;
const SERVICE_VERSION: &str = env!("CARGO_PKG_VERSION");
const SESSION_VERSION: &str = env!("CARGO_PKG_VERSION");

const CAPABILITIES: [CommandType; 8] = [
    CommandType::DisplayTurnOff,
    CommandType::MediaVolumeUp,
    CommandType::MediaVolumeDown,
    CommandType::MediaVolumeMuteToggle,
    CommandType::MediaPlayPause,
    CommandType::MediaPreviousTrack,
    CommandType::MediaNextTrack,
    CommandType::MediaStop,
];

#[cfg(windows)]
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct RegistrationResponse {
    device_id: String,
}

#[cfg(windows)]
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RegistrationRequest<'a> {
    capabilities: &'a [CommandType],
    computer_name: &'a str,
    enrollment_token: &'a str,
    platform: &'static str,
    public_key: &'a str,
    service_version: &'static str,
    session_version: &'static str,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ExecutionResult {
    pub error_code: Option<CommandErrorCode>,
    pub status: CommandStatus,
}

pub trait CommandExecutor: Send + Sync {
    fn execute<'a>(
        &'a self,
        command: &'a AgentCommand,
    ) -> Pin<Box<dyn Future<Output = ExecutionResult> + Send + 'a>>;
}

#[cfg(windows)]
pub async fn register(
    store: &IdentityStore,
    service_origin: &str,
    enrollment_token: &str,
) -> Result<MachineIdentity, String> {
    let allow_loopback_http =
        cfg!(debug_assertions) && std::env::var("RCH_ALLOW_HTTP_LOOPBACK").as_deref() == Ok("1");
    let service_origin =
        normalize_service_origin(service_origin, allow_loopback_http).map_err(str::to_owned)?;
    let mut private = [0_u8; 32];
    getrandom::fill(&mut private).map_err(|_| "key_generation_failed".to_owned())?;
    let signing_key = SigningKey::from_bytes(&private);
    private.fill(0);
    let public_key = URL_SAFE_NO_PAD.encode(signing_key.verifying_key().as_bytes());
    let computer_name = computer_name()?;
    let client = reqwest::Client::builder()
        .redirect(Policy::none())
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|_| "registration_client_failed".to_owned())?;
    let endpoint = format!("{service_origin}/api/v1/agent/register");
    let response = client
        .post(endpoint)
        .json(&RegistrationRequest {
            capabilities: &CAPABILITIES,
            computer_name: &computer_name,
            enrollment_token,
            platform: "windows",
            public_key: &public_key,
            service_version: SERVICE_VERSION,
            session_version: SESSION_VERSION,
        })
        .send()
        .await
        .map_err(|_| "device_registration_unavailable".to_owned())?;
    if !response.status().is_success() {
        return Err(if response.status().as_u16() == 400 {
            "enrollment_token_invalid".to_owned()
        } else {
            "device_registration_unavailable".to_owned()
        });
    }
    let response: RegistrationResponse = response
        .json()
        .await
        .map_err(|_| "registration_response_invalid".to_owned())?;
    let identity =
        create_identity(response.device_id, service_origin, &signing_key).map_err(str::to_owned)?;
    store
        .save(&identity)
        .map_err(|_| "identity_persistence_failed".to_owned())?;
    Ok(identity)
}

pub async fn run_reconnecting(
    identity: MachineIdentity,
    ledger: Arc<Mutex<FileCommandLedger>>,
    executor: Arc<dyn CommandExecutor>,
    connected: Arc<AtomicBool>,
    mut shutdown: watch::Receiver<bool>,
) {
    let mut attempt = 0_u32;
    loop {
        if *shutdown.borrow() {
            return;
        }
        let result = run_connection(
            &identity,
            &ledger,
            executor.as_ref(),
            connected.as_ref(),
            &mut shutdown,
        )
        .await;
        connected.store(false, Ordering::Release);
        if *shutdown.borrow() {
            return;
        }
        if let Err(error) = result {
            eprintln!(
                "{{\"level\":\"warn\",\"event\":\"agent_connection_closed\",\"reason\":\"{}\"}}",
                sanitize_log_value(&error)
            );
        }
        attempt = attempt.saturating_add(1);
        let delay = reconnect_delay(attempt);
        tokio::select! {
            _ = sleep(delay) => {}
            changed = shutdown.changed() => {
                if changed.is_err() || *shutdown.borrow() {
                    return;
                }
            }
        }
    }
}

async fn run_connection(
    identity: &MachineIdentity,
    ledger: &Arc<Mutex<FileCommandLedger>>,
    executor: &dyn CommandExecutor,
    connected: &AtomicBool,
    shutdown: &mut watch::Receiver<bool>,
) -> Result<(), String> {
    let signing_key = identity.signing_key().map_err(str::to_owned)?;
    let url = websocket_url(&identity.service_origin).map_err(str::to_owned)?;
    let config = WebSocketConfig::default()
        .max_message_size(Some(MAX_FRAME_BYTES))
        .max_frame_size(Some(MAX_FRAME_BYTES));
    let (mut socket, _) = connect_async_with_config(url.as_str(), Some(config), true)
        .await
        .map_err(|_| "websocket_connect_failed".to_owned())?;
    send_json(
        &mut socket,
        &AgentHello {
            protocol_version: AGENT_PROTOCOL_VERSION,
            message_sequence: 0,
            capabilities: CAPABILITIES.to_vec(),
            device_id: identity.device_id.clone(),
            service_version: SERVICE_VERSION.to_owned(),
            session_version: SESSION_VERSION.to_owned(),
            message_type: "agent.hello".to_owned(),
        },
    )
    .await?;
    let challenge: AgentChallenge = receive_json_with_timeout(&mut socket).await?;
    validate_challenge(&challenge, &identity.device_id)?;
    let signature = signing_key.sign(
        build_authentication_payload(
            &challenge.session_id,
            &challenge.device_id,
            &challenge.nonce,
            &challenge.expires_at,
        )
        .as_bytes(),
    );
    send_json(
        &mut socket,
        &AgentAuthenticate {
            protocol_version: AGENT_PROTOCOL_VERSION,
            message_sequence: 1,
            device_id: challenge.device_id.clone(),
            expires_at: challenge.expires_at.clone(),
            nonce: challenge.nonce.clone(),
            session_id: challenge.session_id.clone(),
            signature: URL_SAFE_NO_PAD.encode(signature.to_bytes()),
            message_type: "agent.authenticate".to_owned(),
        },
    )
    .await?;
    let authenticated: AgentAuthenticated = receive_json_with_timeout(&mut socket).await?;
    validate_authenticated(&authenticated, &challenge)?;
    connected.store(true, Ordering::Release);
    let mut last_server_sequence = authenticated.message_sequence;
    let mut outbound_sequence = 1_u64;
    let mut heartbeat = interval(HEARTBEAT_INTERVAL);
    heartbeat.set_missed_tick_behavior(MissedTickBehavior::Delay);
    heartbeat.tick().await;

    loop {
        tokio::select! {
            changed = shutdown.changed() => {
                if changed.is_err() || *shutdown.borrow() {
                    let _ = socket.close(None).await;
                    return Ok(());
                }
            }
            _ = heartbeat.tick() => {
                outbound_sequence = outbound_sequence.saturating_add(1);
                send_json(&mut socket, &AgentHeartbeat {
                    protocol_version: AGENT_PROTOCOL_VERSION,
                    message_sequence: outbound_sequence,
                    device_id: identity.device_id.clone(),
                    sent_at: now_iso()?,
                    message_type: "agent.heartbeat".to_owned(),
                }).await?;
            }
            message = socket.next() => {
                let text = message_text(message)?;
                let value: serde_json::Value = serde_json::from_str(&text)
                    .map_err(|_| "agent_message_invalid".to_owned())?;
                let message_type = value.get("type").and_then(serde_json::Value::as_str)
                    .ok_or_else(|| "agent_message_invalid".to_owned())?;
                match message_type {
                    "agent.heartbeat_ack" => {
                        let ack: AgentHeartbeatAck = serde_json::from_value(value)
                            .map_err(|_| "agent_message_invalid".to_owned())?;
                        validate_server_sequence(
                            ack.protocol_version,
                            ack.message_sequence,
                            &ack.device_id,
                            &identity.device_id,
                            &mut last_server_sequence,
                        )?;
                    }
                    "command.execute" => {
                        let command: AgentCommand = serde_json::from_value(value)
                            .map_err(|_| "agent_message_invalid".to_owned())?;
                        command.validate(&identity.device_id, last_server_sequence)
                            .map_err(str::to_owned)?;
                        last_server_sequence = command.message_sequence;
                        process_command(
                            &mut socket,
                            ledger,
                            executor,
                            command,
                            &mut outbound_sequence,
                        ).await?;
                    }
                    _ => return Err("agent_message_unsupported".to_owned()),
                }
            }
        }
    }
}

async fn process_command<S>(
    socket: &mut tokio_tungstenite::WebSocketStream<S>,
    ledger: &Arc<Mutex<FileCommandLedger>>,
    executor: &dyn CommandExecutor,
    command: AgentCommand,
    outbound_sequence: &mut u64,
) -> Result<(), String>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let existing = ledger
        .lock()
        .map_err(|_| "command_ledger_unavailable".to_owned())?
        .state(&command.command_id);
    if let Some(state) = existing
        && is_terminal(state)
    {
        return send_result(
            socket,
            &command.command_id,
            persisted_status(state),
            None,
            outbound_sequence,
        )
        .await;
    }
    let expired = OffsetDateTime::parse(&command.expires_at, &Rfc3339)
        .map_err(|_| "command_expiry_invalid".to_owned())?
        <= OffsetDateTime::now_utc();
    if expired {
        {
            let mut ledger = ledger
                .lock()
                .map_err(|_| "command_ledger_unavailable".to_owned())?;
            if existing.is_none() {
                ledger
                    .accept(command.clone())
                    .map_err(|_| "command_ledger_write_failed".to_owned())?;
            }
            ledger
                .finish(&command.command_id, PersistedCommandState::Expired)
                .map_err(|_| "command_ledger_write_failed".to_owned())?;
        }
        return send_result(
            socket,
            &command.command_id,
            CommandStatus::Expired,
            None,
            outbound_sequence,
        )
        .await;
    }
    {
        let mut ledger = ledger
            .lock()
            .map_err(|_| "command_ledger_unavailable".to_owned())?;
        ledger
            .accept(command.clone())
            .map_err(|_| "command_ledger_write_failed".to_owned())?;
    }
    send_result(
        socket,
        &command.command_id,
        CommandStatus::Accepted,
        None,
        outbound_sequence,
    )
    .await?;
    let queued = ledger
        .lock()
        .map_err(|_| "command_ledger_unavailable".to_owned())?
        .dequeue()
        .map_err(|_| "command_ledger_write_failed".to_owned())?;
    let Some(queued) = queued else {
        return Ok(());
    };
    send_result(
        socket,
        &queued.command_id,
        CommandStatus::Executing,
        None,
        outbound_sequence,
    )
    .await?;
    let result = executor.execute(&queued).await;
    let persisted = match result.status {
        CommandStatus::Succeeded => PersistedCommandState::Succeeded,
        CommandStatus::OutcomeUnknown => PersistedCommandState::OutcomeUnknown,
        CommandStatus::Expired => PersistedCommandState::Expired,
        _ => PersistedCommandState::Failed,
    };
    ledger
        .lock()
        .map_err(|_| "command_ledger_unavailable".to_owned())?
        .finish(&queued.command_id, persisted)
        .map_err(|_| "command_ledger_write_failed".to_owned())?;
    send_result(
        socket,
        &queued.command_id,
        result.status,
        result.error_code,
        outbound_sequence,
    )
    .await
}

async fn send_result<S>(
    socket: &mut tokio_tungstenite::WebSocketStream<S>,
    command_id: &str,
    status: CommandStatus,
    error_code: Option<CommandErrorCode>,
    outbound_sequence: &mut u64,
) -> Result<(), String>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    *outbound_sequence = outbound_sequence.saturating_add(1);
    send_json(
        socket,
        &AgentCommandResult {
            protocol_version: AGENT_PROTOCOL_VERSION,
            message_sequence: *outbound_sequence,
            command_id: command_id.to_owned(),
            status,
            error_code,
            message_type: "command.result".to_owned(),
        },
    )
    .await
}

async fn send_json<S, T>(
    socket: &mut tokio_tungstenite::WebSocketStream<S>,
    value: &T,
) -> Result<(), String>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
    T: Serialize,
{
    let serialized =
        serde_json::to_string(value).map_err(|_| "agent_serialize_failed".to_owned())?;
    if serialized.len() > MAX_FRAME_BYTES {
        return Err("agent_message_too_large".to_owned());
    }
    socket
        .send(Message::Text(serialized.into()))
        .await
        .map_err(|_| "websocket_send_failed".to_owned())
}

async fn receive_json_with_timeout<S, T>(
    socket: &mut tokio_tungstenite::WebSocketStream<S>,
) -> Result<T, String>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
    T: for<'de> Deserialize<'de>,
{
    let message = timeout(AUTHENTICATION_TIMEOUT, socket.next())
        .await
        .map_err(|_| "authentication_timeout".to_owned())?;
    let text = message_text(message)?;
    serde_json::from_str(&text).map_err(|_| "agent_message_invalid".to_owned())
}

fn message_text(
    message: Option<Result<Message, tokio_tungstenite::tungstenite::Error>>,
) -> Result<String, String> {
    match message {
        Some(Ok(Message::Text(text))) if text.len() <= MAX_FRAME_BYTES => Ok(text.to_string()),
        Some(Ok(Message::Close(_))) | None => Err("websocket_closed".to_owned()),
        Some(Ok(_)) => Err("agent_message_invalid".to_owned()),
        Some(Err(_)) => Err("websocket_receive_failed".to_owned()),
    }
}

fn validate_challenge(challenge: &AgentChallenge, device_id: &str) -> Result<(), String> {
    if challenge.protocol_version != AGENT_PROTOCOL_VERSION
        || challenge.message_sequence != 0
        || challenge.device_id != device_id
        || challenge.message_type != "agent.challenge"
        || OffsetDateTime::parse(&challenge.expires_at, &Rfc3339)
            .map_err(|_| "agent_challenge_invalid".to_owned())?
            <= OffsetDateTime::now_utc()
    {
        return Err("agent_challenge_invalid".to_owned());
    }
    Ok(())
}

fn validate_authenticated(
    authenticated: &AgentAuthenticated,
    challenge: &AgentChallenge,
) -> Result<(), String> {
    if authenticated.protocol_version != AGENT_PROTOCOL_VERSION
        || authenticated.message_sequence != 1
        || authenticated.device_id != challenge.device_id
        || authenticated.session_id != challenge.session_id
        || authenticated.generation == 0
        || authenticated.message_type != "agent.authenticated"
    {
        return Err("agent_authentication_invalid".to_owned());
    }
    Ok(())
}

fn validate_server_sequence(
    protocol_version: u16,
    sequence: u64,
    device_id: &str,
    expected_device_id: &str,
    last_sequence: &mut u64,
) -> Result<(), String> {
    if protocol_version != AGENT_PROTOCOL_VERSION
        || device_id != expected_device_id
        || sequence <= *last_sequence
    {
        return Err("agent_message_replay".to_owned());
    }
    *last_sequence = sequence;
    Ok(())
}

fn is_terminal(state: PersistedCommandState) -> bool {
    matches!(
        state,
        PersistedCommandState::Succeeded
            | PersistedCommandState::Failed
            | PersistedCommandState::Expired
            | PersistedCommandState::OutcomeUnknown
    )
}

fn persisted_status(state: PersistedCommandState) -> CommandStatus {
    match state {
        PersistedCommandState::Accepted => CommandStatus::Accepted,
        PersistedCommandState::Executing => CommandStatus::Executing,
        PersistedCommandState::Succeeded => CommandStatus::Succeeded,
        PersistedCommandState::Failed => CommandStatus::Failed,
        PersistedCommandState::Expired => CommandStatus::Expired,
        PersistedCommandState::OutcomeUnknown => CommandStatus::OutcomeUnknown,
    }
}

fn now_iso() -> Result<String, String> {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .map_err(|_| "clock_format_failed".to_owned())
}

fn reconnect_delay(attempt: u32) -> Duration {
    let exponent = attempt.saturating_sub(1).min(6);
    let base = 1_u64 << exponent;
    let mut random = [0_u8; 2];
    let jitter = if getrandom::fill(&mut random).is_ok() {
        u16::from_le_bytes(random) as u64 % 1_000
    } else {
        0
    };
    Duration::from_millis(base.min(MAX_RECONNECT_DELAY_SECONDS) * 1_000 + jitter)
}

#[cfg(windows)]
fn computer_name() -> Result<String, String> {
    let value = std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .map_err(|_| "computer_name_unavailable".to_owned())?;
    let value = value.trim();
    if value.is_empty() || value.len() > 255 {
        return Err("computer_name_invalid".to_owned());
    }
    Ok(value.to_owned())
}

fn sanitize_log_value(value: &str) -> String {
    value
        .chars()
        .filter(|character| character.is_ascii_alphanumeric() || matches!(character, '_' | '-'))
        .take(64)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reconnect_delay_is_bounded_and_increases() {
        assert!(reconnect_delay(1) >= Duration::from_secs(1));
        assert!(reconnect_delay(10) < Duration::from_secs(61));
    }

    #[test]
    fn terminal_states_map_to_wire_statuses() {
        assert_eq!(
            persisted_status(PersistedCommandState::OutcomeUnknown),
            CommandStatus::OutcomeUnknown
        );
        assert!(is_terminal(PersistedCommandState::Expired));
        assert!(!is_terminal(PersistedCommandState::Accepted));
    }
}
