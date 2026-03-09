use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{Mutex, Semaphore};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Pending,
    Downloading,
    Done,
    Error,
    Cancelled,
    Paused,
}

impl Status {
    pub fn as_str(&self) -> &'static str {
        match self {
            Status::Pending => "pending",
            Status::Downloading => "downloading",
            Status::Done => "done",
            Status::Error => "error",
            Status::Cancelled => "cancelled",
            Status::Paused => "paused",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DownloadItem {
    pub id: String,
    pub url: String,
    pub page_url: String,
    pub title: String,
    pub filename: String,
    pub status: Status,
    pub progress: f64,
    pub speed: String,
    pub eta: String,
    pub filesize: String,
    pub error: String,
    pub created_at: f64,
}

pub struct DownloadQueue {
    pub items: Arc<Mutex<HashMap<String, DownloadItem>>>,
    pub semaphore: Arc<Semaphore>,
}

impl DownloadQueue {
    pub fn new(max_concurrent: usize) -> Self {
        DownloadQueue {
            items: Arc::new(Mutex::new(HashMap::new())),
            semaphore: Arc::new(Semaphore::new(max_concurrent)),
        }
    }

    pub async fn add(&self, id: String, url: String, page_url: String, title: String) -> DownloadItem {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH).unwrap().as_secs_f64();
        let item = DownloadItem {
            id: id.clone(),
            url,
            page_url,
            title,
            filename: String::new(),
            status: Status::Pending,
            progress: 0.0,
            speed: String::new(),
            eta: String::new(),
            filesize: String::new(),
            error: String::new(),
            created_at: now,
        };
        self.items.lock().await.insert(id, item.clone());
        item
    }

    pub async fn get_all(&self) -> Vec<DownloadItem> {
        let items = self.items.lock().await;
        let mut list: Vec<_> = items.values().cloned().collect();
        list.sort_by(|a, b| a.created_at.partial_cmp(&b.created_at).unwrap());
        list
    }

    pub async fn remove(&self, id: &str) -> bool {
        let mut items = self.items.lock().await;
        if let Some(item) = items.get_mut(id) {
            item.status = Status::Cancelled;
        }
        items.remove(id).is_some()
    }

    pub async fn update_max_concurrent(&self, _n: usize) {
        // Semaphore doesn't support dynamic resize.
        // Would need app restart for this to take effect.
    }
}
