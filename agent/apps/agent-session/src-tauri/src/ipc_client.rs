use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use agent_ipc_protocol::{IPC_PROTOCOL_VERSION, IpcMessage, RegistrationRequest, StatusResponse};
use serde::Serialize;
use tokio::sync::{mpsc, oneshot};
use tokio::time::timeout;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);

struct ClientRequest {
    correlation_id: String,
    message: IpcMessage,
    response: oneshot::Sender<Result<IpcMessage, String>>,
}

#[derive(Clone)]
pub struct ServiceClient {
    correlation: Arc<AtomicU64>,
    sender: mpsc::Sender<ClientRequest>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStatus {
    pub connected: bool,
    pub device_id: Option<String>,
    pub registered: bool,
    pub service_origin: Option<String>,
}

impl ServiceClient {
    pub fn start() -> Self {
        let (sender, receiver) = mpsc::channel(8);
        tauri::async_runtime::spawn(platform::run(receiver));
        Self {
            correlation: Arc::new(AtomicU64::new(0)),
            sender,
        }
    }

    pub async fn register(
        &self,
        service_origin: String,
        enrollment_token: String,
    ) -> Result<String, String> {
        let correlation_id = self.next_correlation();
        let response = self
            .request(
                correlation_id.clone(),
                IpcMessage::RegistrationRequest(RegistrationRequest {
                    protocol_version: IPC_PROTOCOL_VERSION,
                    correlation_id,
                    service_origin,
                    enrollment_token,
                }),
            )
            .await?;
        let IpcMessage::RegistrationResponse(response) = response else {
            return Err("registration_response_invalid".to_owned());
        };
        if let Some(error) = response.error_code {
            return Err(error);
        }
        response
            .device_id
            .ok_or_else(|| "registration_response_invalid".to_owned())
    }

    pub async fn status(&self) -> Result<AgentStatus, String> {
        let correlation_id = self.next_correlation();
        let response = self
            .request(
                correlation_id.clone(),
                IpcMessage::StatusRequest {
                    protocol_version: IPC_PROTOCOL_VERSION,
                    correlation_id,
                },
            )
            .await?;
        let IpcMessage::StatusResponse(StatusResponse {
            connected,
            device_id,
            registered,
            service_origin,
            ..
        }) = response
        else {
            return Err("status_response_invalid".to_owned());
        };
        Ok(AgentStatus {
            connected,
            device_id,
            registered,
            service_origin,
        })
    }

    pub async fn unregister(&self) -> Result<(), String> {
        let correlation_id = self.next_correlation();
        let response = self
            .request(
                correlation_id.clone(),
                IpcMessage::UnregistrationRequest {
                    protocol_version: IPC_PROTOCOL_VERSION,
                    correlation_id,
                },
            )
            .await?;
        let IpcMessage::UnregistrationResponse(response) = response else {
            return Err("unregistration_response_invalid".to_owned());
        };
        if let Some(error) = response.error_code {
            return Err(error);
        }
        Ok(())
    }

    async fn request(
        &self,
        correlation_id: String,
        message: IpcMessage,
    ) -> Result<IpcMessage, String> {
        let (sender, receiver) = oneshot::channel();
        self.sender
            .send(ClientRequest {
                correlation_id,
                message,
                response: sender,
            })
            .await
            .map_err(|_| "agent_service_unavailable".to_owned())?;
        timeout(REQUEST_TIMEOUT, receiver)
            .await
            .map_err(|_| "agent_service_timeout".to_owned())?
            .map_err(|_| "agent_service_unavailable".to_owned())?
    }

    fn next_correlation(&self) -> String {
        format!(
            "{}-{}",
            std::process::id(),
            self.correlation.fetch_add(1, Ordering::AcqRel) + 1
        )
    }
}

#[cfg(windows)]
mod platform {
    use std::os::windows::io::AsRawHandle;

    use agent_ipc_protocol::{
        CommandOutcome, CommandResponse, IPC_PROTOCOL_VERSION, IpcCommand, IpcMessage,
        MAX_IPC_MESSAGE_BYTES, SessionHello, decode_frame, encode_frame,
    };
    use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
    use tokio::net::windows::named_pipe::{ClientOptions, NamedPipeClient};
    use tokio::sync::mpsc;
    use tokio::time::sleep;
    use windows_platform::{
        DesktopCommand, DesktopControl, PlatformDesktopControl, current_process_session_id,
        current_process_user_sid, named_pipe_server_is_service,
    };

    use super::ClientRequest;

    const PIPE_NAME: &str = r"\\.\pipe\RemoteControlHub.Agent.v2";
    const RECONNECT_DELAY: std::time::Duration = std::time::Duration::from_secs(2);
    const SERVICE_NAME: &str = "RemoteControlHubAgent";

    pub async fn run(mut requests: mpsc::Receiver<ClientRequest>) {
        loop {
            match connect().await {
                Ok(pipe) => {
                    let _ = run_connection(pipe, &mut requests).await;
                }
                Err(error) => {
                    tokio::select! {
                        request = requests.recv() => {
                            let Some(request) = request else {
                                return;
                            };
                            let _ = request.response.send(Err(error));
                        }
                        _ = sleep(RECONNECT_DELAY) => {}
                    }
                }
            }
        }
    }

    async fn connect() -> Result<NamedPipeClient, String> {
        let mut pipe = ClientOptions::new()
            .open(PIPE_NAME)
            .map_err(|_| "agent_service_unavailable".to_owned())?;
        let is_service = named_pipe_server_is_service(pipe.as_raw_handle(), SERVICE_NAME)
            .map_err(str::to_owned)?;
        let development_override = cfg!(debug_assertions)
            && std::env::var("RCH_ALLOW_NON_SYSTEM_PIPE").as_deref() == Ok("1");
        if !is_service && !development_override {
            return Err("agent_service_identity_invalid".to_owned());
        }
        let user_sid = current_process_user_sid().map_err(str::to_owned)?;
        write_message(
            &mut pipe,
            &IpcMessage::SessionHello(SessionHello {
                protocol_version: IPC_PROTOCOL_VERSION,
                process_id: std::process::id(),
                session_id: current_process_session_id().map_err(str::to_owned)?,
                claimed_user_sid: user_sid.clone(),
            }),
        )
        .await?;
        let acknowledgement = read_message(&mut pipe).await?;
        let IpcMessage::SessionHelloAck(acknowledgement) = acknowledgement else {
            return Err("session_handshake_invalid".to_owned());
        };
        if acknowledgement.protocol_version != IPC_PROTOCOL_VERSION
            || acknowledgement.generation == 0
            || acknowledgement.bound_user_sid != user_sid
        {
            return Err("session_handshake_invalid".to_owned());
        }
        Ok(pipe)
    }

    async fn run_connection(
        pipe: NamedPipeClient,
        requests: &mut mpsc::Receiver<ClientRequest>,
    ) -> Result<(), String> {
        let (mut reader, mut writer) = tokio::io::split(pipe);
        let mut pending: Option<ClientRequest> = None;
        let result = loop {
            tokio::select! {
                request = requests.recv(), if pending.is_none() => {
                    let Some(request) = request else {
                        break Ok(());
                    };
                    if let Err(error) = write_message(&mut writer, &request.message).await {
                        let _ = request.response.send(Err(error.clone()));
                        break Err(error);
                    }
                    pending = Some(request);
                }
                message = read_message(&mut reader) => {
                    let message = match message {
                        Ok(value) => value,
                        Err(error) => break Err(error),
                    };
                    match message {
                        IpcMessage::CommandRequest(request) => {
                            let response = execute_command(request);
                            write_message(&mut writer, &IpcMessage::CommandResponse(response)).await?;
                        }
                        response @ (IpcMessage::RegistrationResponse(_)
                            | IpcMessage::UnregistrationResponse(_)
                            | IpcMessage::StatusResponse(_)) => {
                            let Some(request) = pending.take() else {
                                break Err("ipc_response_unexpected".to_owned());
                            };
                            if response_correlation(&response) != Some(request.correlation_id.as_str()) {
                                let _ = request.response.send(Err("ipc_response_mismatch".to_owned()));
                                break Err("ipc_response_mismatch".to_owned());
                            }
                            let _ = request.response.send(Ok(response));
                        }
                        _ => break Err("ipc_message_unsupported".to_owned()),
                    }
                }
            }
        };
        if let Some(request) = pending {
            let _ = request
                .response
                .send(Err("agent_service_disconnected".to_owned()));
        }
        result
    }

    fn execute_command(request: agent_ipc_protocol::CommandRequest) -> CommandResponse {
        let validation = request.validate();
        let receipt = validation
            .map(|()| PlatformDesktopControl.execute(desktop_command(request.command)))
            .unwrap_or_else(|error_code| windows_platform::ExecutionReceipt {
                dispatched: false,
                error_code: Some(error_code),
            });
        CommandResponse {
            protocol_version: IPC_PROTOCOL_VERSION,
            correlation_id: request.correlation_id,
            command_id: request.command_id,
            outcome: if receipt.dispatched {
                CommandOutcome::Succeeded
            } else {
                CommandOutcome::Failed
            },
            error_code: receipt.error_code.map(str::to_owned),
        }
    }

    fn desktop_command(command: IpcCommand) -> DesktopCommand {
        match command {
            IpcCommand::DisplayTurnOff => DesktopCommand::DisplayTurnOff,
            IpcCommand::MediaVolumeUp => DesktopCommand::MediaVolumeUp,
            IpcCommand::MediaVolumeDown => DesktopCommand::MediaVolumeDown,
            IpcCommand::MediaVolumeMuteToggle => DesktopCommand::MediaVolumeMuteToggle,
            IpcCommand::MediaPlayPause => DesktopCommand::MediaPlayPause,
            IpcCommand::MediaPreviousTrack => DesktopCommand::MediaPreviousTrack,
            IpcCommand::MediaNextTrack => DesktopCommand::MediaNextTrack,
            IpcCommand::MediaStop => DesktopCommand::MediaStop,
        }
    }

    fn response_correlation(message: &IpcMessage) -> Option<&str> {
        match message {
            IpcMessage::RegistrationResponse(value) => Some(&value.correlation_id),
            IpcMessage::UnregistrationResponse(value) => Some(&value.correlation_id),
            IpcMessage::StatusResponse(value) => Some(&value.correlation_id),
            _ => None,
        }
    }

    async fn read_message<R>(reader: &mut R) -> Result<IpcMessage, String>
    where
        R: AsyncRead + Unpin,
    {
        let mut header = [0_u8; 4];
        reader
            .read_exact(&mut header)
            .await
            .map_err(|_| "ipc_read_failed".to_owned())?;
        let length = u32::from_le_bytes(header) as usize;
        if length > MAX_IPC_MESSAGE_BYTES {
            return Err("ipc_message_too_large".to_owned());
        }
        let mut frame = vec![0_u8; length + 4];
        frame[..4].copy_from_slice(&header);
        reader
            .read_exact(&mut frame[4..])
            .await
            .map_err(|_| "ipc_read_failed".to_owned())?;
        decode_frame(&frame).map_err(str::to_owned)
    }

    async fn write_message<W>(writer: &mut W, message: &IpcMessage) -> Result<(), String>
    where
        W: AsyncWrite + Unpin,
    {
        let frame = encode_frame(message).map_err(str::to_owned)?;
        writer
            .write_all(&frame)
            .await
            .map_err(|_| "ipc_write_failed".to_owned())?;
        writer
            .flush()
            .await
            .map_err(|_| "ipc_write_failed".to_owned())
    }
}

#[cfg(not(windows))]
mod platform {
    use tokio::sync::mpsc;

    use super::ClientRequest;

    pub async fn run(mut requests: mpsc::Receiver<ClientRequest>) {
        while let Some(request) = requests.recv().await {
            let ClientRequest {
                correlation_id,
                message,
                response,
            } = request;
            drop((correlation_id, message));
            let _ = response.send(Err("unsupported_platform".to_owned()));
        }
    }
}
