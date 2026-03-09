mod db;
mod downloader;
mod queue;
mod server;

use server::{AppState, Settings, db_path, settings_path, start_server};
use std::sync::Arc;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;

pub fn run() {
    // Init DB
    let db = Arc::new(db::Db::new(&db_path()));
    db.recover_interrupted();

    // Load settings
    let settings = Settings::load(&settings_path());
    let max_concurrent = settings.max_concurrent;

    // Build shared state
    let state = Arc::new(AppState {
        queue: queue::DownloadQueue::new(max_concurrent),
        db: db.clone(),
        settings: tokio::sync::Mutex::new(settings),
    });

    // Load interrupted downloads from DB into queue
    {
        let paused = db.get_by_status(&["paused", "pending"]);
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            for row in paused {
                let id = row.id.clone();
                state.queue.add(
                    row.id,
                    row.video_url.unwrap_or_default(),
                    row.page_url,
                    row.title.unwrap_or_default(),
                ).await;
                let mut items = state.queue.items.lock().await;
                if let Some(item) = items.get_mut(&id) {
                    item.status = queue::Status::Paused;
                }
            }
        });
    }

    // Start HTTP server on background thread
    let server_state = state.clone();
    std::thread::spawn(move || {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(start_server(server_state));
    });

    tauri::Builder::default()
        .setup(|app| {
            // Tray: right-click → "Stop Snatch"
            let stop_i = MenuItem::with_id(app, "stop", "Stop Snatch", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&stop_i])?;

            let _tray = TrayIconBuilder::new()
                .menu(&menu)
                .tooltip("Snatch — running on :9111")
                .on_menu_event(|app, event| {
                    if event.id().as_ref() == "stop" {
                        app.exit(0);
                    }
                })
                .build(app)?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
