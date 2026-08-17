use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use std::{fs::OpenOptions, io::Write};

use agent_core::FileCommandLedger;
use binding::LocalBindingStore;
use identity::IdentityStore;

mod binding;
mod identity;
mod ipc;
mod network;

const COMMAND_LEDGER_CAPACITY: usize = 4_096;
const BUILD_COMMIT: &str = match option_env!("RCH_BUILD_COMMIT") {
    Some(value) => value,
    None => "unknown",
};
const BUILD_TIME: &str = match option_env!("RCH_BUILD_TIME") {
    Some(value) => value,
    None => "unknown",
};
const SERVICE_VERSION: &str = env!("CARGO_PKG_VERSION");

fn default_ledger_path() -> PathBuf {
    if let Some(path) = std::env::var_os("RCH_COMMAND_LEDGER") {
        return PathBuf::from(path);
    }
    #[cfg(windows)]
    {
        let program_data = std::env::var_os("ProgramData")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(r"C:\ProgramData"));
        program_data
            .join("RemoteControlHub")
            .join("command-ledger.json")
    }
    #[cfg(not(windows))]
    PathBuf::from("state/command-ledger.json")
}

fn default_identity_path() -> PathBuf {
    if let Some(path) = std::env::var_os("RCH_MACHINE_IDENTITY") {
        return PathBuf::from(path);
    }
    #[cfg(windows)]
    {
        let program_data = std::env::var_os("ProgramData")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(r"C:\ProgramData"));
        program_data
            .join("RemoteControlHub")
            .join("machine-identity.json")
    }
    #[cfg(not(windows))]
    PathBuf::from("state/machine-identity.json")
}

fn default_binding_path() -> PathBuf {
    if let Some(path) = std::env::var_os("RCH_LOCAL_BINDING") {
        return PathBuf::from(path);
    }
    #[cfg(windows)]
    {
        let program_data = std::env::var_os("ProgramData")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(r"C:\ProgramData"));
        program_data
            .join("RemoteControlHub")
            .join("local-binding.json")
    }
    #[cfg(not(windows))]
    PathBuf::from("state/local-binding.json")
}

fn default_local_audit_path() -> PathBuf {
    #[cfg(windows)]
    {
        let program_data = std::env::var_os("ProgramData")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(r"C:\ProgramData"));
        program_data
            .join("RemoteControlHub")
            .join("local-security-audit.jsonl")
    }
    #[cfg(not(windows))]
    PathBuf::from("state/local-security-audit.jsonl")
}

async fn run_agent(mut shutdown: tokio::sync::watch::Receiver<bool>) -> Result<(), String> {
    eprintln!(
        "{}",
        serde_json::json!({
            "buildTime": BUILD_TIME,
            "commit": BUILD_COMMIT,
            "event": "agent_service_started",
            "level": "info",
            "version": SERVICE_VERSION,
        })
    );
    let identity_path = default_identity_path();
    let binding_path = default_binding_path();
    let ledger_path = default_ledger_path();
    prepare_machine_storage([&identity_path, &binding_path, &ledger_path])?;
    let identity_store = Arc::new(IdentityStore::new(identity_path));
    let binding_store = Arc::new(LocalBindingStore::new(binding_path));
    let identity = identity_store
        .load()
        .map_err(|_| "identity_load_failed".to_owned())?;
    if identity.is_none() {
        eprintln!("{{\"level\":\"warn\",\"event\":\"agent_registration_required\"}}");
    }
    let ledger = FileCommandLedger::open(ledger_path, COMMAND_LEDGER_CAPACITY)
        .map_err(|_| "command_ledger_open_failed".to_owned())?;
    let ledger = Arc::new(Mutex::new(ledger));
    let router = Arc::new(ipc::SessionRouter::new());
    let connected = Arc::new(AtomicBool::new(false));
    let (identity_sender, mut identity_receiver) = tokio::sync::watch::channel(identity.clone());
    let ipc_task = tokio::spawn(ipc::run_server(
        Arc::clone(&identity_store),
        Arc::clone(&binding_store),
        Arc::clone(&router),
        identity_sender,
        Arc::clone(&connected),
        shutdown.clone(),
    ));
    let mut network_task = identity.map(|identity| {
        tokio::spawn(network::run_reconnecting(
            identity,
            Arc::clone(&ledger),
            Arc::clone(&router) as Arc<dyn network::CommandExecutor>,
            Arc::clone(&connected),
            shutdown.clone(),
        ))
    });
    loop {
        tokio::select! {
            changed = shutdown.changed() => {
                if changed.is_err() || *shutdown.borrow() {
                    break;
                }
            }
            changed = identity_receiver.changed(), if network_task.is_none() => {
                if changed.is_err() {
                    return Err("identity_channel_closed".to_owned());
                }
                if let Some(identity) = identity_receiver.borrow().clone() {
                    network_task = Some(tokio::spawn(network::run_reconnecting(
                        identity,
                        Arc::clone(&ledger),
                        Arc::clone(&router) as Arc<dyn network::CommandExecutor>,
                        Arc::clone(&connected),
                        shutdown.clone(),
                    )));
                }
            }
        }
    }
    if let Some(task) = network_task {
        let _ = task.await;
    }
    let ipc_result = ipc_task
        .await
        .map_err(|_| "ipc_runtime_failed".to_owned())?;
    ipc_result?;
    Ok(())
}

fn run_local_command(arguments: &[String]) -> Result<(), String> {
    if !windows_platform::current_process_is_elevated().map_err(str::to_owned)? {
        return Err("administrator_elevation_required".to_owned());
    }
    let operation = match arguments.get(1).map(String::as_str) {
        Some("reset-binding")
            if arguments.len() == 4
                && arguments[2] == "--confirm"
                && arguments[3] == "RESET_LOCAL_BINDING" =>
        {
            "reset_binding"
        }
        _ => {
            return Err(
                "usage: agent-service reset-binding --confirm RESET_LOCAL_BINDING".to_owned(),
            );
        }
    };
    let identity_path = default_identity_path();
    let binding_path = default_binding_path();
    let audit_path = default_local_audit_path();
    prepare_machine_storage([&identity_path, &binding_path, &audit_path])?;
    append_local_audit(&audit_path, operation, "started", None)?;
    let result = IdentityStore::new(identity_path)
        .clear()
        .map_err(|_| "identity_clear_failed".to_owned())
        .and_then(|()| {
            LocalBindingStore::new(binding_path)
                .clear()
                .map_err(|_| "binding_clear_failed".to_owned())
        });
    let (result_name, error_code) = match &result {
        Ok(()) => ("succeeded", None),
        Err(error) => ("failed", Some(error.as_str())),
    };
    append_local_audit(&audit_path, operation, result_name, error_code)?;
    result
}

fn prepare_machine_storage<const N: usize>(paths: [&std::path::Path; N]) -> Result<(), String> {
    for path in paths {
        let parent = path
            .parent()
            .ok_or_else(|| "machine_directory_invalid".to_owned())?;
        windows_platform::secure_machine_directory(parent).map_err(str::to_owned)?;
    }
    Ok(())
}

fn append_local_audit(
    path: &std::path::Path,
    operation: &str,
    result: &str,
    error_code: Option<&str>,
) -> Result<(), String> {
    let occurred_at = time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .map_err(|_| "local_audit_time_failed".to_owned())?;
    let entry = serde_json::json!({
        "errorCode": error_code,
        "occurredAt": occurred_at,
        "operation": operation,
        "result": result,
    });
    let mut file = OpenOptions::new()
        .append(true)
        .create(true)
        .open(path)
        .map_err(|_| "local_audit_write_failed".to_owned())?;
    writeln!(file, "{entry}").map_err(|_| "local_audit_write_failed".to_owned())?;
    file.sync_data()
        .map_err(|_| "local_audit_write_failed".to_owned())
}

#[cfg(windows)]
mod windows_service_host {
    use std::ffi::OsString;
    use std::sync::mpsc;
    use std::time::Duration;

    use windows_service::define_windows_service;
    use windows_service::service::{
        ServiceControl, ServiceControlAccept, ServiceExitCode, ServiceState, ServiceStatus,
        ServiceType,
    };
    use windows_service::service_control_handler::{self, ServiceControlHandlerResult};
    use windows_service::service_dispatcher;

    use super::run_agent;

    const SERVICE_NAME: &str = "RemoteControlHubAgent";

    define_windows_service!(ffi_service_main, service_main);

    pub fn run() -> windows_service::Result<()> {
        service_dispatcher::start(SERVICE_NAME, ffi_service_main)
    }

    fn service_main(_arguments: Vec<OsString>) {
        let _ = run_service();
    }

    fn status(state: ServiceState, controls: ServiceControlAccept) -> ServiceStatus {
        ServiceStatus {
            service_type: ServiceType::OWN_PROCESS,
            current_state: state,
            controls_accepted: controls,
            exit_code: ServiceExitCode::Win32(0),
            checkpoint: 0,
            wait_hint: Duration::default(),
            process_id: None,
        }
    }

    fn run_service() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let (shutdown_sender, shutdown_receiver) = mpsc::channel();
        let event_handler = move |event| match event {
            ServiceControl::Interrogate => ServiceControlHandlerResult::NoError,
            ServiceControl::Stop => {
                let _ = shutdown_sender.send(());
                ServiceControlHandlerResult::NoError
            }
            _ => ServiceControlHandlerResult::NotImplemented,
        };
        let status_handle = service_control_handler::register(SERVICE_NAME, event_handler)?;
        status_handle
            .set_service_status(status(ServiceState::Running, ServiceControlAccept::STOP))?;
        let runtime = tokio::runtime::Runtime::new()?;
        let (shutdown_sender, shutdown) = tokio::sync::watch::channel(false);
        let shutdown_thread = std::thread::spawn(move || {
            let _ = shutdown_receiver.recv();
            let _ = shutdown_sender.send(true);
        });
        runtime
            .block_on(run_agent(shutdown))
            .map_err(std::io::Error::other)?;
        let _ = shutdown_thread.join();
        status_handle.set_service_status(status(
            ServiceState::StopPending,
            ServiceControlAccept::empty(),
        ))?;
        status_handle
            .set_service_status(status(ServiceState::Stopped, ServiceControlAccept::empty()))?;
        Ok(())
    }
}

#[cfg(windows)]
fn main() -> windows_service::Result<()> {
    let arguments = std::env::args().collect::<Vec<_>>();
    if arguments.len() > 1 {
        if let Err(error) = run_local_command(&arguments) {
            eprintln!("agent local operation failed: {error}");
            std::process::exit(1);
        }
        return Ok(());
    }
    windows_service_host::run()
}

#[cfg(not(windows))]
#[tokio::main]
async fn main() {
    let arguments = std::env::args().collect::<Vec<_>>();
    let result = if arguments.len() > 1 {
        run_local_command(&arguments)
    } else {
        let (_shutdown_sender, shutdown) = tokio::sync::watch::channel(false);
        run_agent(shutdown).await
    };
    if let Err(error) = result {
        eprintln!(
            "{{\"level\":\"error\",\"event\":\"agent_service_failed\",\"reason\":\"{}\"}}",
            error
        );
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::append_local_audit;

    #[test]
    fn writes_sanitized_local_security_audit_events() {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!("rch-local-audit-{unique}.jsonl"));

        append_local_audit(&path, "reset_binding", "succeeded", None).unwrap();

        let entry: serde_json::Value =
            serde_json::from_str(std::fs::read_to_string(&path).unwrap().trim()).unwrap();
        assert_eq!(entry["operation"], "reset_binding");
        assert_eq!(entry["result"], "succeeded");
        assert!(entry["occurredAt"].as_str().unwrap().ends_with('Z'));
        assert_eq!(entry["errorCode"], serde_json::Value::Null);
        std::fs::remove_file(path).unwrap();
    }
}
