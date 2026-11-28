use std::sync::atomic::AtomicBool;

use crate::api::session::SearchTuning;
use crate::protocol::PresenceView;

pub(crate) struct Settings {
    pub(crate) notification_content: AtomicBool,
    pub(crate) notification_encrypted_content: AtomicBool,
    pub(crate) notification_sounds: AtomicBool,
    pub(crate) notify_once: AtomicBool,
    pub(crate) notifications_enabled: AtomicBool,
    pub(crate) in_app_banners: AtomicBool,
    pub(crate) private_receipts: AtomicBool,
    pub(crate) widget_feed: AtomicBool,
    pub(crate) search_crawler_enabled: AtomicBool,
    pub(crate) server_search_enabled: AtomicBool,
    pub(crate) search_sharing: AtomicBool,
    pub(crate) search_tuning: parking_lot::Mutex<SearchTuning>,
    pub(crate) desired_presence: parking_lot::Mutex<PresenceView>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            notification_content: AtomicBool::new(false),
            notification_encrypted_content: AtomicBool::new(false),
            notification_sounds: AtomicBool::new(true),
            notify_once: AtomicBool::new(true),
            notifications_enabled: AtomicBool::new(true),
            in_app_banners: AtomicBool::new(false),
            private_receipts: AtomicBool::new(true),
            widget_feed: AtomicBool::new(false),
            search_crawler_enabled: AtomicBool::new(true),
            server_search_enabled: AtomicBool::new(true),
            search_sharing: AtomicBool::new(false),
            search_tuning: parking_lot::Mutex::new(SearchTuning::default()),
            desired_presence: parking_lot::Mutex::new(PresenceView::Online),
        }
    }
}
