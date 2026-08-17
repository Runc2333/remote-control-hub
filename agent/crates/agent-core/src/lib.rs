use std::collections::{HashMap, VecDeque};
use std::fs::{self, File};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use agent_wire::AgentCommand;
use serde::{Deserialize, Serialize};

const DEFAULT_LEDGER_CAPACITY: usize = 4_096;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub enum PersistedCommandState {
    Accepted,
    Executing,
    Succeeded,
    Failed,
    Expired,
    OutcomeUnknown,
}

#[derive(Debug)]
pub struct CommandLedger {
    capacity: usize,
    commands: HashMap<String, PersistedCommandState>,
    order: VecDeque<String>,
    queue: VecDeque<AgentCommand>,
}

impl Default for CommandLedger {
    fn default() -> Self {
        Self::with_capacity(DEFAULT_LEDGER_CAPACITY)
    }
}

impl CommandLedger {
    pub fn with_capacity(capacity: usize) -> Self {
        assert!(capacity > 0, "ledger capacity must be positive");
        Self {
            capacity,
            commands: HashMap::new(),
            order: VecDeque::new(),
            queue: VecDeque::new(),
        }
    }

    pub fn accept(&mut self, command: AgentCommand) -> Result<PersistedCommandState, &'static str> {
        if let Some(state) = self.commands.get(&command.command_id) {
            return Ok(*state);
        }
        self.remove_oldest_terminal();
        if self.commands.len() >= self.capacity {
            return Err("command_log_capacity_exceeded");
        }
        self.commands
            .insert(command.command_id.clone(), PersistedCommandState::Accepted);
        self.order.push_back(command.command_id.clone());
        self.queue.push_back(command);
        Ok(PersistedCommandState::Accepted)
    }

    pub fn dequeue(&mut self) -> Option<AgentCommand> {
        let command = self.queue.pop_front()?;
        self.commands
            .insert(command.command_id.clone(), PersistedCommandState::Executing);
        Some(command)
    }

    pub fn finish(&mut self, command_id: &str, state: PersistedCommandState) -> bool {
        if !matches!(
            state,
            PersistedCommandState::Succeeded
                | PersistedCommandState::Failed
                | PersistedCommandState::Expired
                | PersistedCommandState::OutcomeUnknown
        ) {
            return false;
        }
        let Some(current) = self.commands.get_mut(command_id) else {
            return false;
        };
        *current = state;
        true
    }

    pub fn state(&self, command_id: &str) -> Option<PersistedCommandState> {
        self.commands.get(command_id).copied()
    }

    fn remove_oldest_terminal(&mut self) {
        if self.commands.len() < self.capacity {
            return;
        }
        let terminal_index = self.order.iter().position(|command_id| {
            matches!(
                self.commands.get(command_id),
                Some(
                    PersistedCommandState::Succeeded
                        | PersistedCommandState::Failed
                        | PersistedCommandState::Expired
                        | PersistedCommandState::OutcomeUnknown
                )
            )
        });
        if let Some(index) = terminal_index
            && let Some(command_id) = self.order.remove(index)
        {
            self.commands.remove(&command_id);
        }
    }
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct CommandLedgerSnapshot {
    commands: HashMap<String, PersistedCommandState>,
    order: VecDeque<String>,
    queue: VecDeque<AgentCommand>,
}

pub struct FileCommandLedger {
    ledger: CommandLedger,
    path: PathBuf,
}

impl FileCommandLedger {
    pub fn open(path: impl Into<PathBuf>, capacity: usize) -> io::Result<Self> {
        let path = path.into();
        let recovery_path = path.with_extension("previous");
        let source_path = if path.exists() {
            Some(path.as_path())
        } else if recovery_path.exists() {
            Some(recovery_path.as_path())
        } else {
            None
        };
        let mut ledger = CommandLedger::with_capacity(capacity);
        if let Some(source_path) = source_path {
            let bytes = fs::read(source_path)?;
            let snapshot: CommandLedgerSnapshot = serde_json::from_slice(&bytes)
                .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
            if snapshot.commands.len() > capacity {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "command_log_capacity_exceeded",
                ));
            }
            ledger.commands = snapshot.commands;
            ledger.order = snapshot.order;
            ledger.queue = snapshot.queue;
            for state in ledger.commands.values_mut() {
                if *state == PersistedCommandState::Executing {
                    *state = PersistedCommandState::OutcomeUnknown;
                }
            }
            ledger.queue.retain(|command| {
                ledger.commands.get(&command.command_id) == Some(&PersistedCommandState::Accepted)
            });
        }
        let instance = Self { ledger, path };
        instance.persist()?;
        Ok(instance)
    }

    pub fn accept(&mut self, command: AgentCommand) -> io::Result<PersistedCommandState> {
        let state = self.ledger.accept(command).map_err(io::Error::other)?;
        self.persist()?;
        Ok(state)
    }

    pub fn dequeue(&mut self) -> io::Result<Option<AgentCommand>> {
        let command = self.ledger.dequeue();
        self.persist()?;
        Ok(command)
    }

    pub fn finish(&mut self, command_id: &str, state: PersistedCommandState) -> io::Result<bool> {
        let changed = self.ledger.finish(command_id, state);
        if changed {
            self.persist()?;
        }
        Ok(changed)
    }

    pub fn state(&self, command_id: &str) -> Option<PersistedCommandState> {
        self.ledger.state(command_id)
    }

    fn persist(&self) -> io::Result<()> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)?;
        }
        let temporary_path = self.path.with_extension("temporary");
        let recovery_path = self.path.with_extension("previous");
        let snapshot = CommandLedgerSnapshot {
            commands: self.ledger.commands.clone(),
            order: self.ledger.order.clone(),
            queue: self.ledger.queue.clone(),
        };
        let bytes = serde_json::to_vec(&snapshot).map_err(io::Error::other)?;
        let mut file = File::create(&temporary_path)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        if self.path.exists() {
            if recovery_path.exists() {
                fs::remove_file(&recovery_path)?;
            }
            fs::rename(&self.path, &recovery_path)?;
        }
        fs::rename(&temporary_path, &self.path)?;
        if recovery_path.exists() {
            fs::remove_file(recovery_path)?;
        }
        sync_parent(&self.path)
    }
}

#[cfg(unix)]
fn sync_parent(path: &Path) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        File::open(parent)?.sync_all()?;
    }
    Ok(())
}

#[cfg(not(unix))]
fn sync_parent(_path: &Path) -> io::Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use agent_wire::{AGENT_PROTOCOL_VERSION, CommandType};

    fn command(id: &str, sequence: u64) -> AgentCommand {
        AgentCommand {
            protocol_version: AGENT_PROTOCOL_VERSION,
            message_sequence: sequence,
            command_id: id.to_owned(),
            device_id: "device".to_owned(),
            command_type: CommandType::DisplayTurnOff,
            created_at: "2026-08-17T00:00:00+08:00".to_owned(),
            expires_at: "2026-08-17T00:00:30+08:00".to_owned(),
            initiated_by_user_id: "user".to_owned(),
            message_type: "command.execute".to_owned(),
        }
    }

    #[test]
    fn preserves_fifo_and_deduplicates_command_ids() {
        let mut ledger = CommandLedger::default();
        ledger.accept(command("first", 1)).unwrap();
        ledger.accept(command("second", 2)).unwrap();
        ledger.accept(command("first", 3)).unwrap();

        assert_eq!(
            ledger.dequeue().map(|value| value.command_id),
            Some("first".to_owned())
        );
        assert_eq!(
            ledger.dequeue().map(|value| value.command_id),
            Some("second".to_owned())
        );
        assert!(ledger.dequeue().is_none());
    }

    #[test]
    fn refuses_to_evict_non_terminal_commands() {
        let mut ledger = CommandLedger::with_capacity(1);
        ledger.accept(command("first", 1)).unwrap();

        assert_eq!(
            ledger.accept(command("second", 2)),
            Err("command_log_capacity_exceeded")
        );
    }

    #[test]
    fn recovers_executing_commands_as_outcome_unknown() {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!("remote-control-hub-ledger-{unique}.json"));
        let mut ledger = FileCommandLedger::open(&path, 8).unwrap();
        ledger.accept(command("first", 1)).unwrap();
        assert!(ledger.dequeue().unwrap().is_some());
        drop(ledger);

        let recovered = FileCommandLedger::open(&path, 8).unwrap();
        assert_eq!(
            recovered.state("first"),
            Some(PersistedCommandState::OutcomeUnknown)
        );
        fs::remove_file(path).unwrap();
    }
}
