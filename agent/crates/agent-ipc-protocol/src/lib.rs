use serde::{Deserialize, Serialize};

pub const IPC_PROTOCOL_VERSION: u16 = 1;
pub const MAX_IPC_MESSAGE_BYTES: usize = 64 * 1024;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SessionHello {
    pub protocol_version: u16,
    pub process_id: u32,
    pub session_id: u32,
    pub claimed_user_sid: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SessionHelloAck {
    pub protocol_version: u16,
    pub generation: u64,
    pub bound_user_sid: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct RegistrationRequest {
    pub protocol_version: u16,
    pub correlation_id: String,
    pub service_origin: String,
    pub enrollment_token: String,
    pub local_enrollment_secret: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct RegistrationResponse {
    pub protocol_version: u16,
    pub correlation_id: String,
    pub device_id: Option<String>,
    pub error_code: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct StatusResponse {
    pub protocol_version: u16,
    pub correlation_id: String,
    pub registered: bool,
    pub connected: bool,
    pub device_id: Option<String>,
    pub service_origin: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum IpcCommand {
    DisplayTurnOff,
    MediaVolumeUp,
    MediaVolumeDown,
    MediaVolumeMuteToggle,
    MediaPlayPause,
    MediaPreviousTrack,
    MediaNextTrack,
    MediaStop,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CommandRequest {
    pub protocol_version: u16,
    pub correlation_id: String,
    pub command_id: String,
    pub command: IpcCommand,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CommandOutcome {
    Succeeded,
    Failed,
    OutcomeUnknown,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CommandResponse {
    pub protocol_version: u16,
    pub correlation_id: String,
    pub command_id: String,
    pub outcome: CommandOutcome,
    pub error_code: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum IpcMessage {
    SessionHello(SessionHello),
    SessionHelloAck(SessionHelloAck),
    RegistrationRequest(RegistrationRequest),
    RegistrationResponse(RegistrationResponse),
    StatusRequest {
        protocol_version: u16,
        correlation_id: String,
    },
    StatusResponse(StatusResponse),
    CommandRequest(CommandRequest),
    CommandResponse(CommandResponse),
}

pub fn encode_frame(message: &IpcMessage) -> Result<Vec<u8>, &'static str> {
    let payload = serde_json::to_vec(message).map_err(|_| "ipc_serialize_failed")?;
    if payload.len() > MAX_IPC_MESSAGE_BYTES {
        return Err("ipc_message_too_large");
    }
    let length = u32::try_from(payload.len()).map_err(|_| "ipc_message_too_large")?;
    let mut frame = Vec::with_capacity(payload.len() + 4);
    frame.extend_from_slice(&length.to_le_bytes());
    frame.extend_from_slice(&payload);
    Ok(frame)
}

pub fn decode_frame(frame: &[u8]) -> Result<IpcMessage, &'static str> {
    if frame.len() < 4 {
        return Err("ipc_frame_incomplete");
    }
    let length =
        u32::from_le_bytes(frame[..4].try_into().map_err(|_| "ipc_frame_invalid")?) as usize;
    if length > MAX_IPC_MESSAGE_BYTES || frame.len() != length + 4 {
        return Err("ipc_frame_invalid");
    }
    serde_json::from_slice(&frame[4..]).map_err(|_| "ipc_message_invalid")
}

fn validate_correlation(protocol_version: u16, correlation_id: &str) -> Result<(), &'static str> {
    if protocol_version != IPC_PROTOCOL_VERSION {
        return Err("unsupported_protocol_version");
    }
    if correlation_id.is_empty() || correlation_id.len() > 128 {
        return Err("invalid_correlation_id");
    }
    Ok(())
}

impl SessionHello {
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.protocol_version != IPC_PROTOCOL_VERSION {
            return Err("unsupported_protocol_version");
        }
        if self.process_id == 0
            || self.claimed_user_sid.is_empty()
            || self.claimed_user_sid.len() > 184
        {
            return Err("session_hello_invalid");
        }
        Ok(())
    }
}

impl RegistrationRequest {
    pub fn validate(&self) -> Result<(), &'static str> {
        validate_correlation(self.protocol_version, &self.correlation_id)?;
        if self.service_origin.is_empty()
            || self.service_origin.len() > 2048
            || self.enrollment_token.is_empty()
            || self.enrollment_token.len() > 128
            || self.local_enrollment_secret.is_empty()
            || self.local_enrollment_secret.len() > 256
        {
            return Err("registration_request_invalid");
        }
        Ok(())
    }
}

impl CommandRequest {
    pub fn validate(&self) -> Result<(), &'static str> {
        validate_correlation(self.protocol_version, &self.correlation_id)?;
        if self.command_id.is_empty() || self.command_id.len() > 128 {
            return Err("invalid_command_id");
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_an_unknown_protocol_version() {
        let request = CommandRequest {
            protocol_version: 2,
            correlation_id: "correlation".to_owned(),
            command_id: "command".to_owned(),
            command: IpcCommand::DisplayTurnOff,
        };

        assert_eq!(request.validate(), Err("unsupported_protocol_version"));
    }

    #[test]
    fn frames_messages_with_a_bounded_length_prefix() {
        let message = IpcMessage::StatusRequest {
            protocol_version: IPC_PROTOCOL_VERSION,
            correlation_id: "correlation".to_owned(),
        };
        let frame = encode_frame(&message).unwrap();

        assert_eq!(decode_frame(&frame), Ok(message));
        assert_eq!(
            decode_frame(&[0xff, 0xff, 0xff, 0xff]),
            Err("ipc_frame_invalid")
        );
    }
}
