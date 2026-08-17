use serde::{Deserialize, Serialize};

pub const AGENT_PROTOCOL_VERSION: u16 = 1;
pub const MAX_FRAME_BYTES: usize = 64 * 1024;
pub const AGENT_AUTHENTICATION_DOMAIN: &str = "REMOTE_CONTROL_HUB_AGENT_AUTH_V1";

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub enum CommandType {
    #[serde(rename = "display.turn_off")]
    DisplayTurnOff,
    #[serde(rename = "media.volume_up")]
    MediaVolumeUp,
    #[serde(rename = "media.volume_down")]
    MediaVolumeDown,
    #[serde(rename = "media.volume_mute_toggle")]
    MediaVolumeMuteToggle,
    #[serde(rename = "media.play_pause")]
    MediaPlayPause,
    #[serde(rename = "media.previous_track")]
    MediaPreviousTrack,
    #[serde(rename = "media.next_track")]
    MediaNextTrack,
    #[serde(rename = "media.stop")]
    MediaStop,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CommandStatus {
    Created,
    Sent,
    Accepted,
    Executing,
    Succeeded,
    Failed,
    Expired,
    OutcomeUnknown,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CommandErrorCode {
    DeviceOffline,
    Unsupported,
    InteractiveSessionUnavailable,
    MultipleSessionsUnsupported,
    LocalUserMismatch,
    DeviceDisabled,
    DeviceCredentialsRevoked,
    DeviceDeleted,
    OwnerDeleted,
    ExecutionFailed,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct AgentHello {
    pub protocol_version: u16,
    pub message_sequence: u64,
    pub capabilities: Vec<CommandType>,
    pub device_id: String,
    pub service_version: String,
    pub session_version: String,
    #[serde(rename = "type")]
    pub message_type: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct AgentChallenge {
    pub protocol_version: u16,
    pub message_sequence: u64,
    pub device_id: String,
    pub expires_at: String,
    pub nonce: String,
    pub session_id: String,
    #[serde(rename = "type")]
    pub message_type: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct AgentAuthenticate {
    pub protocol_version: u16,
    pub message_sequence: u64,
    pub device_id: String,
    pub expires_at: String,
    pub nonce: String,
    pub session_id: String,
    pub signature: String,
    #[serde(rename = "type")]
    pub message_type: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct AgentAuthenticated {
    pub protocol_version: u16,
    pub message_sequence: u64,
    pub device_id: String,
    pub generation: u64,
    pub session_id: String,
    #[serde(rename = "type")]
    pub message_type: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct AgentHeartbeat {
    pub protocol_version: u16,
    pub message_sequence: u64,
    pub device_id: String,
    pub sent_at: String,
    #[serde(rename = "type")]
    pub message_type: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct AgentHeartbeatAck {
    pub protocol_version: u16,
    pub message_sequence: u64,
    pub device_id: String,
    pub received_at: String,
    #[serde(rename = "type")]
    pub message_type: String,
}

pub fn build_authentication_payload(
    session_id: &str,
    device_id: &str,
    nonce: &str,
    expires_at: &str,
) -> String {
    [
        AGENT_AUTHENTICATION_DOMAIN,
        session_id,
        device_id,
        nonce,
        expires_at,
    ]
    .join("\n")
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct AgentCommand {
    pub protocol_version: u16,
    pub message_sequence: u64,
    pub command_id: String,
    pub device_id: String,
    pub command_type: CommandType,
    pub created_at: String,
    pub expires_at: String,
    pub initiated_by_user_id: String,
    #[serde(rename = "type")]
    pub message_type: String,
}

impl AgentCommand {
    pub fn validate(
        &self,
        expected_device_id: &str,
        last_sequence: u64,
    ) -> Result<(), &'static str> {
        if self.protocol_version != AGENT_PROTOCOL_VERSION {
            return Err("unsupported_protocol_version");
        }
        if self.device_id != expected_device_id {
            return Err("device_mismatch");
        }
        if self.message_sequence <= last_sequence {
            return Err("message_replay");
        }
        if self.command_id.is_empty() || self.command_id.len() > 128 {
            return Err("invalid_command_id");
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct AgentCommandResult {
    pub protocol_version: u16,
    pub message_sequence: u64,
    pub command_id: String,
    pub status: CommandStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_code: Option<CommandErrorCode>,
    #[serde(rename = "type")]
    pub message_type: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn command() -> AgentCommand {
        AgentCommand {
            protocol_version: AGENT_PROTOCOL_VERSION,
            message_sequence: 2,
            command_id: "command-id".to_owned(),
            device_id: "device-id".to_owned(),
            command_type: CommandType::DisplayTurnOff,
            created_at: "2026-08-17T00:00:00+08:00".to_owned(),
            expires_at: "2026-08-17T00:00:30+08:00".to_owned(),
            initiated_by_user_id: "user-id".to_owned(),
            message_type: "command.execute".to_owned(),
        }
    }

    #[test]
    fn rejects_replayed_sequences() {
        assert_eq!(command().validate("device-id", 2), Err("message_replay"));
    }

    #[test]
    fn rejects_another_device() {
        assert_eq!(
            command().validate("other-device", 0),
            Err("device_mismatch")
        );
    }

    #[test]
    fn builds_the_cross_language_authentication_fixture() {
        assert_eq!(
            build_authentication_payload(
                "22222222-2222-4222-8222-222222222222",
                "11111111-1111-4111-8111-111111111111",
                "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
                "2026-08-17T00:00:30.000+08:00",
            ),
            [
                "REMOTE_CONTROL_HUB_AGENT_AUTH_V1",
                "22222222-2222-4222-8222-222222222222",
                "11111111-1111-4111-8111-111111111111",
                "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
                "2026-08-17T00:00:30.000+08:00",
            ]
            .join("\n")
        );
    }

    #[test]
    fn command_type_uses_the_schema_wire_value() {
        assert_eq!(
            serde_json::to_string(&CommandType::DisplayTurnOff).unwrap(),
            "\"display.turn_off\""
        );
    }
}
