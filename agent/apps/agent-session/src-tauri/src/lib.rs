use tauri::{
    AppHandle, Manager, WebviewUrl, WebviewWindowBuilder,
    menu::{MenuBuilder, MenuItemBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
};
use windows_platform::{DesktopCommand, DesktopControl, PlatformDesktopControl};

use ipc_client::{AgentStatus, ServiceClient};
use updater::{DiagnosticLog, UpdateCheck, UpdateSettings, UpdaterRuntime};

mod ipc_client;
mod updater;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct AppInfo {
    build_time: &'static str,
    commit: &'static str,
    repository_configured: bool,
    version: &'static str,
}

fn show_main_window(app: &AppHandle) -> tauri::Result<()> {
    if let Some(window) = app.get_webview_window("main") {
        window.unminimize()?;
        window.show()?;
        window.set_focus()?;
        return Ok(());
    }

    WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
        .title("Remote Control Hub Agent")
        .inner_size(820.0, 720.0)
        .min_inner_size(420.0, 560.0)
        .build()?;
    Ok(())
}

fn execute_local(command: DesktopCommand) -> bool {
    PlatformDesktopControl.execute(command).dispatched
}

#[tauri::command]
fn execute_local_command(command: &str) -> Result<bool, &'static str> {
    let command = match command {
        "display.turn_off" => DesktopCommand::DisplayTurnOff,
        "media.volume_up" => DesktopCommand::MediaVolumeUp,
        "media.volume_down" => DesktopCommand::MediaVolumeDown,
        "media.volume_mute_toggle" => DesktopCommand::MediaVolumeMuteToggle,
        "media.play_pause" => DesktopCommand::MediaPlayPause,
        "media.previous_track" => DesktopCommand::MediaPreviousTrack,
        "media.next_track" => DesktopCommand::MediaNextTrack,
        "media.stop" => DesktopCommand::MediaStop,
        _ => return Err("unsupported_command"),
    };
    Ok(execute_local(command))
}

#[tauri::command]
async fn register_agent(
    service_client: tauri::State<'_, ServiceClient>,
    service_origin: String,
    enrollment_token: String,
) -> Result<String, String> {
    service_client
        .register(service_origin, enrollment_token)
        .await
}

#[tauri::command]
async fn get_agent_status(
    service_client: tauri::State<'_, ServiceClient>,
) -> Result<AgentStatus, String> {
    service_client.status().await
}

#[tauri::command]
async fn unregister_agent(service_client: tauri::State<'_, ServiceClient>) -> Result<(), String> {
    service_client.unregister().await
}

#[tauri::command]
fn get_app_info(updater: tauri::State<'_, UpdaterRuntime>) -> AppInfo {
    AppInfo {
        build_time: option_env!("RCH_BUILD_TIME").unwrap_or("unknown"),
        commit: option_env!("RCH_BUILD_COMMIT").unwrap_or("unknown"),
        repository_configured: updater.repository_configured(),
        version: env!("CARGO_PKG_VERSION"),
    }
}

#[tauri::command]
fn get_update_settings(updater: tauri::State<'_, UpdaterRuntime>) -> UpdateSettings {
    updater.settings()
}

#[tauri::command]
fn set_automatic_update_checks(
    updater: tauri::State<'_, UpdaterRuntime>,
    enabled: bool,
) -> Result<UpdateSettings, String> {
    updater.set_automatic_checks(enabled)
}

#[tauri::command]
async fn check_for_updates(
    updater: tauri::State<'_, UpdaterRuntime>,
    force: bool,
) -> Result<UpdateCheck, String> {
    updater.check(force).await
}

#[tauri::command]
fn skip_update(
    updater: tauri::State<'_, UpdaterRuntime>,
    tag: String,
) -> Result<UpdateSettings, String> {
    updater.skip(tag)
}

#[tauri::command]
fn open_release_page(updater: tauri::State<'_, UpdaterRuntime>, tag: String) -> Result<(), String> {
    let url = updater.release_url(&tag)?;
    windows_platform::open_https_url(&url).map_err(str::to_owned)
}

#[tauri::command]
fn get_diagnostic_logs(updater: tauri::State<'_, UpdaterRuntime>) -> Vec<DiagnosticLog> {
    updater.logs()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(ServiceClient::start())
        .manage(UpdaterRuntime::new())
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            let _ = show_main_window(app);
        }))
        .setup(|app| {
            let update_app = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let _ = update_app.state::<UpdaterRuntime>().check(false).await;
            });
            let open = MenuItemBuilder::with_id("open", "打开控制中心").build(app)?;
            let turn_off = MenuItemBuilder::with_id("turn_off", "关闭显示器").build(app)?;
            let quit = MenuItemBuilder::with_id("quit", "退出").build(app)?;
            let menu = MenuBuilder::new(app)
                .items(&[&open, &turn_off, &quit])
                .build()?;

            TrayIconBuilder::new()
                .icon(
                    app.default_window_icon()
                        .cloned()
                        .ok_or("missing app icon")?,
                )
                .menu(&menu)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "open" => {
                        let _ = show_main_window(app);
                    }
                    "turn_off" => {
                        execute_local(DesktopCommand::DisplayTurnOff);
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let _ = show_main_window(tray.app_handle());
                    }
                })
                .build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            execute_local_command,
            check_for_updates,
            get_app_info,
            get_agent_status,
            get_diagnostic_logs,
            get_update_settings,
            open_release_page,
            register_agent,
            set_automatic_update_checks,
            skip_update,
            unregister_agent
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Remote Control Hub Agent");
}
