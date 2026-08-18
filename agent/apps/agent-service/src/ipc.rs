#[cfg(windows)]
mod implementation {
    use std::future::Future;
    use std::os::windows::io::AsRawHandle;
    use std::pin::Pin;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
    use std::time::Duration;

    use agent_ipc_protocol::{
        CommandOutcome, CommandRequest, CommandResponse, IPC_PROTOCOL_VERSION, IpcCommand,
        IpcMessage, MAX_IPC_MESSAGE_BYTES, RegistrationRequest, RegistrationResponse,
        SessionHelloAck, StatusResponse, UnregistrationResponse, decode_frame, encode_frame,
    };
    use agent_wire::{AgentCommand, CommandErrorCode, CommandStatus, CommandType};
    use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
    use tokio::net::windows::named_pipe::{NamedPipeServer, ServerOptions};
    use tokio::sync::{Mutex, mpsc, oneshot, watch};
    use tokio::time::{sleep, timeout};
    use windows_platform::{
        OwnedPipeSecurityAttributes, named_pipe_client_process_id, named_pipe_client_user_sid,
        session_user_sid, unique_interactive_session_id,
    };

    use crate::binding::LocalBindingStore;
    use crate::identity::{IdentityStore, MachineIdentity};
    use crate::network::{
        CommandExecutor, ExecutionResult, register, unregister as unregister_remote,
    };

    pub const PIPE_NAME: &str = r"\\.\pipe\RemoteControlHub.Agent.v2";
    const COMMAND_TIMEOUT: Duration = Duration::from_secs(15);

    struct PendingCommand {
        command: AgentCommand,
        response: oneshot::Sender<CommandResponse>,
    }

    struct ActiveSession {
        generation: u64,
        sender: mpsc::Sender<PendingCommand>,
        user_sid: String,
    }

    struct RegistrationContext<'a> {
        actual_user_sid: &'a str,
        binding_store: &'a LocalBindingStore,
        identity_sender: &'a watch::Sender<Option<MachineIdentity>>,
        identity_store: &'a IdentityStore,
    }

    pub struct SessionRouter {
        generation: AtomicU64,
        session: Mutex<Option<ActiveSession>>,
    }

    impl SessionRouter {
        pub fn new() -> Self {
            Self {
                generation: AtomicU64::new(0),
                session: Mutex::new(None),
            }
        }

        async fn attach(&self, user_sid: String) -> (u64, mpsc::Receiver<PendingCommand>) {
            let generation = self.generation.fetch_add(1, Ordering::AcqRel) + 1;
            let (sender, receiver) = mpsc::channel(8);
            *self.session.lock().await = Some(ActiveSession {
                generation,
                sender,
                user_sid,
            });
            (generation, receiver)
        }

        async fn detach(&self, generation: u64) {
            let mut session = self.session.lock().await;
            if session.as_ref().map(|value| value.generation) == Some(generation) {
                *session = None;
            }
        }
    }

    impl CommandExecutor for SessionRouter {
        fn execute<'a>(
            &'a self,
            command: &'a AgentCommand,
        ) -> Pin<Box<dyn Future<Output = ExecutionResult> + Send + 'a>> {
            Box::pin(async move {
                let sender = {
                    let session = self.session.lock().await;
                    session.as_ref().map(|value| {
                        let _ = &value.user_sid;
                        value.sender.clone()
                    })
                };
                let Some(sender) = sender else {
                    return unavailable_result();
                };
                let (response_sender, response_receiver) = oneshot::channel();
                if sender
                    .send(PendingCommand {
                        command: command.clone(),
                        response: response_sender,
                    })
                    .await
                    .is_err()
                {
                    return unavailable_result();
                }
                match timeout(COMMAND_TIMEOUT, response_receiver).await {
                    Ok(Ok(response)) => response_result(response),
                    Ok(Err(_)) => unavailable_result(),
                    Err(_) => ExecutionResult {
                        error_code: Some(CommandErrorCode::ExecutionFailed),
                        status: CommandStatus::OutcomeUnknown,
                    },
                }
            })
        }
    }

    pub async fn run_server(
        identity_store: Arc<IdentityStore>,
        binding_store: Arc<LocalBindingStore>,
        router: Arc<SessionRouter>,
        identity_sender: watch::Sender<Option<MachineIdentity>>,
        connected: Arc<AtomicBool>,
        mut shutdown: watch::Receiver<bool>,
    ) -> Result<(), String> {
        loop {
            if *shutdown.borrow() {
                return Ok(());
            }
            let user_sid = allowed_user_sid(binding_store.as_ref())?;
            let server = {
                let mut security =
                    OwnedPipeSecurityAttributes::for_user_sid(&user_sid).map_err(str::to_owned)?;
                unsafe {
                    ServerOptions::new()
                        .reject_remote_clients(true)
                        .create_with_security_attributes_raw(PIPE_NAME, security.as_mut_ptr())
                }
                .map_err(|_| "pipe_create_failed".to_owned())?
            };
            tokio::select! {
                result = server.connect() => {
                    result.map_err(|_| "pipe_connect_failed".to_owned())?;
                }
                changed = shutdown.changed() => {
                    if changed.is_err() || *shutdown.borrow() {
                        return Ok(());
                    }
                    continue;
                }
            }
            let identity_store = Arc::clone(&identity_store);
            let binding_store = Arc::clone(&binding_store);
            let router = Arc::clone(&router);
            let identity_sender = identity_sender.clone();
            let connected = Arc::clone(&connected);
            tokio::spawn(async move {
                let _ = handle_connection(
                    server,
                    identity_store,
                    binding_store,
                    router,
                    identity_sender,
                    connected,
                )
                .await;
            });
            sleep(Duration::from_millis(25)).await;
        }
    }

    async fn handle_connection(
        mut pipe: NamedPipeServer,
        identity_store: Arc<IdentityStore>,
        binding_store: Arc<LocalBindingStore>,
        router: Arc<SessionRouter>,
        identity_sender: watch::Sender<Option<MachineIdentity>>,
        connected: Arc<AtomicBool>,
    ) -> Result<(), String> {
        let hello = match read_message(&mut pipe).await? {
            IpcMessage::SessionHello(value) => value,
            _ => return Err("session_hello_required".to_owned()),
        };
        hello.validate().map_err(str::to_owned)?;
        let handle = pipe.as_raw_handle();
        let actual_user_sid = named_pipe_client_user_sid(handle).map_err(str::to_owned)?;
        let actual_process_id = named_pipe_client_process_id(handle).map_err(str::to_owned)?;
        if hello.process_id != actual_process_id || hello.claimed_user_sid != actual_user_sid {
            return Err("local_user_mismatch".to_owned());
        }
        let active_session = unique_interactive_session_id().map_err(str::to_owned)?;
        if hello.session_id != active_session {
            return Err("interactive_session_unavailable".to_owned());
        }
        let binding = binding_store
            .load()
            .map_err(|_| "binding_load_failed".to_owned())?;
        if let Some(bound_user_sid) = binding.bound_user_sid.as_deref()
            && bound_user_sid != actual_user_sid
        {
            return Err("local_user_mismatch".to_owned());
        }
        let (generation, mut commands) = router.attach(actual_user_sid.clone()).await;
        write_message(
            &mut pipe,
            &IpcMessage::SessionHelloAck(SessionHelloAck {
                protocol_version: IPC_PROTOCOL_VERSION,
                generation,
                bound_user_sid: binding
                    .bound_user_sid
                    .unwrap_or_else(|| actual_user_sid.clone()),
            }),
        )
        .await?;
        let mut pending_response: Option<(String, oneshot::Sender<CommandResponse>)> = None;
        let result = loop {
            tokio::select! {
                message = read_message(&mut pipe) => {
                    let message = match message {
                        Ok(value) => value,
                        Err(error) => break Err(error),
                    };
                    match message {
                        IpcMessage::RegistrationRequest(request) => {
                            request.validate().map_err(str::to_owned)?;
                            let response = handle_registration(request, RegistrationContext {
                                actual_user_sid: &actual_user_sid,
                                binding_store: binding_store.as_ref(),
                                identity_sender: &identity_sender,
                                identity_store: identity_store.as_ref(),
                            }).await;
                            write_message(&mut pipe, &IpcMessage::RegistrationResponse(response)).await?;
                        }
                        IpcMessage::UnregistrationRequest { protocol_version, correlation_id } => {
                            if protocol_version != IPC_PROTOCOL_VERSION
                                || correlation_id.is_empty()
                                || correlation_id.len() > 128
                            {
                                break Err("unregistration_request_invalid".to_owned());
                            }
                            let error_code = unregister(
                                identity_store.as_ref(),
                                binding_store.as_ref(),
                                &identity_sender,
                            ).await
                            .err();
                            write_message(&mut pipe, &IpcMessage::UnregistrationResponse(
                                UnregistrationResponse {
                                    protocol_version: IPC_PROTOCOL_VERSION,
                                    correlation_id,
                                    error_code,
                                },
                            )).await?;
                        }
                        IpcMessage::StatusRequest { protocol_version, correlation_id } => {
                            if protocol_version != IPC_PROTOCOL_VERSION
                                || correlation_id.is_empty()
                                || correlation_id.len() > 128
                            {
                                break Err("status_request_invalid".to_owned());
                            }
                            let identity = identity_store.load()
                                .map_err(|_| "identity_load_failed".to_owned())?;
                            write_message(&mut pipe, &IpcMessage::StatusResponse(StatusResponse {
                                protocol_version: IPC_PROTOCOL_VERSION,
                                correlation_id,
                                registered: identity.is_some(),
                                connected: connected.load(Ordering::Acquire),
                                device_id: identity.as_ref().map(|value| value.device_id.clone()),
                                service_origin: identity.map(|value| value.service_origin),
                            })).await?;
                        }
                        IpcMessage::CommandResponse(response) => {
                            if response.protocol_version != IPC_PROTOCOL_VERSION {
                                break Err("command_response_invalid".to_owned());
                            }
                            let Some((correlation_id, sender)) = pending_response.take() else {
                                break Err("command_response_unexpected".to_owned());
                            };
                            if response.correlation_id != correlation_id {
                                break Err("command_response_mismatch".to_owned());
                            }
                            let _ = sender.send(response);
                        }
                        _ => break Err("ipc_message_unsupported".to_owned()),
                    }
                }
                pending = commands.recv(), if pending_response.is_none() => {
                    let Some(pending) = pending else {
                        break Ok(());
                    };
                    let correlation_id = pending.command.command_id.clone();
                    write_message(&mut pipe, &IpcMessage::CommandRequest(CommandRequest {
                        protocol_version: IPC_PROTOCOL_VERSION,
                        correlation_id: correlation_id.clone(),
                        command_id: pending.command.command_id,
                        command: ipc_command(pending.command.command_type),
                    })).await?;
                    pending_response = Some((correlation_id, pending.response));
                }
            }
        };
        router.detach(generation).await;
        result
    }

    async fn handle_registration(
        request: RegistrationRequest,
        context: RegistrationContext<'_>,
    ) -> RegistrationResponse {
        let result = async {
            let identity = match context
                .identity_store
                .load()
                .map_err(|_| "identity_load_failed")?
            {
                Some(identity) => identity,
                None => register(
                    context.identity_store,
                    &request.service_origin,
                    &request.enrollment_token,
                )
                .await
                .map_err(|error| match error.as_str() {
                    "enrollment_token_invalid" => "enrollment_token_invalid",
                    _ => "device_registration_unavailable",
                })?,
            };
            context.binding_store.bind(context.actual_user_sid)?;
            context
                .identity_sender
                .send(Some(identity.clone()))
                .map_err(|_| "agent_runtime_unavailable")?;
            Ok::<MachineIdentity, &'static str>(identity)
        }
        .await;
        match result {
            Ok(identity) => RegistrationResponse {
                protocol_version: IPC_PROTOCOL_VERSION,
                correlation_id: request.correlation_id,
                device_id: Some(identity.device_id),
                error_code: None,
            },
            Err(error_code) => RegistrationResponse {
                protocol_version: IPC_PROTOCOL_VERSION,
                correlation_id: request.correlation_id,
                device_id: None,
                error_code: Some(error_code.to_owned()),
            },
        }
    }

    async fn unregister(
        identity_store: &IdentityStore,
        binding_store: &LocalBindingStore,
        identity_sender: &watch::Sender<Option<MachineIdentity>>,
    ) -> Result<(), String> {
        if let Some(identity) = identity_store
            .load()
            .map_err(|_| "identity_load_failed".to_owned())?
        {
            unregister_remote(&identity).await?;
        }
        identity_store
            .clear()
            .map_err(|_| "identity_clear_failed".to_owned())?;
        binding_store
            .clear()
            .map_err(|_| "binding_clear_failed".to_owned())?;
        identity_sender
            .send(None)
            .map_err(|_| "agent_runtime_unavailable".to_owned())
    }

    fn allowed_user_sid(binding_store: &LocalBindingStore) -> Result<String, String> {
        let binding = binding_store
            .load()
            .map_err(|_| "binding_load_failed".to_owned())?;
        if let Some(user_sid) = binding.bound_user_sid {
            return Ok(user_sid);
        }
        let session_id = unique_interactive_session_id().map_err(str::to_owned)?;
        session_user_sid(session_id).map_err(str::to_owned)
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

    fn ipc_command(command: CommandType) -> IpcCommand {
        match command {
            CommandType::DisplayTurnOff => IpcCommand::DisplayTurnOff,
            CommandType::MediaVolumeUp => IpcCommand::MediaVolumeUp,
            CommandType::MediaVolumeDown => IpcCommand::MediaVolumeDown,
            CommandType::MediaVolumeMuteToggle => IpcCommand::MediaVolumeMuteToggle,
            CommandType::MediaPlayPause => IpcCommand::MediaPlayPause,
            CommandType::MediaPreviousTrack => IpcCommand::MediaPreviousTrack,
            CommandType::MediaNextTrack => IpcCommand::MediaNextTrack,
            CommandType::MediaStop => IpcCommand::MediaStop,
        }
    }

    fn response_result(response: CommandResponse) -> ExecutionResult {
        match response.outcome {
            CommandOutcome::Succeeded => ExecutionResult {
                error_code: None,
                status: CommandStatus::Succeeded,
            },
            CommandOutcome::OutcomeUnknown => ExecutionResult {
                error_code: response.error_code.as_deref().and_then(command_error),
                status: CommandStatus::OutcomeUnknown,
            },
            CommandOutcome::Failed => ExecutionResult {
                error_code: Some(
                    response
                        .error_code
                        .as_deref()
                        .and_then(command_error)
                        .unwrap_or(CommandErrorCode::ExecutionFailed),
                ),
                status: CommandStatus::Failed,
            },
        }
    }

    fn command_error(value: &str) -> Option<CommandErrorCode> {
        match value {
            "unsupported" => Some(CommandErrorCode::Unsupported),
            "interactive_session_unavailable" => {
                Some(CommandErrorCode::InteractiveSessionUnavailable)
            }
            "multiple_sessions_unsupported" => Some(CommandErrorCode::MultipleSessionsUnsupported),
            "local_user_mismatch" => Some(CommandErrorCode::LocalUserMismatch),
            "execution_failed" => Some(CommandErrorCode::ExecutionFailed),
            _ => None,
        }
    }

    fn unavailable_result() -> ExecutionResult {
        ExecutionResult {
            error_code: Some(CommandErrorCode::InteractiveSessionUnavailable),
            status: CommandStatus::Failed,
        }
    }
}

#[cfg(windows)]
pub use implementation::{SessionRouter, run_server};

#[cfg(not(windows))]
pub use fallback::{SessionRouter, run_server};

#[cfg(not(windows))]
mod fallback {
    use std::future::Future;
    use std::pin::Pin;
    use std::sync::Arc;
    use std::sync::atomic::AtomicBool;

    use agent_wire::{AgentCommand, CommandErrorCode, CommandStatus};
    use tokio::sync::watch;

    use crate::binding::LocalBindingStore;
    use crate::identity::{IdentityStore, MachineIdentity};
    use crate::network::{CommandExecutor, ExecutionResult};

    pub struct SessionRouter;

    impl SessionRouter {
        pub fn new() -> Self {
            Self
        }
    }

    impl CommandExecutor for SessionRouter {
        fn execute<'a>(
            &'a self,
            _command: &'a AgentCommand,
        ) -> Pin<Box<dyn Future<Output = ExecutionResult> + Send + 'a>> {
            Box::pin(async {
                ExecutionResult {
                    error_code: Some(CommandErrorCode::InteractiveSessionUnavailable),
                    status: CommandStatus::Failed,
                }
            })
        }
    }

    pub async fn run_server(
        _identity_store: Arc<IdentityStore>,
        _binding_store: Arc<LocalBindingStore>,
        _router: Arc<SessionRouter>,
        _identity_sender: watch::Sender<Option<MachineIdentity>>,
        _connected: Arc<AtomicBool>,
        mut shutdown: watch::Receiver<bool>,
    ) -> Result<(), String> {
        while !*shutdown.borrow() {
            if shutdown.changed().await.is_err() {
                break;
            }
        }
        Ok(())
    }
}
